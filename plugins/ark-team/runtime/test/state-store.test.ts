import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { resolveStateRoot, RunStore } from "../src/state-store.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  sha256CanonicalJson,
  type VerificationCapability,
  type VerificationLinkedRecord,
  type VerificationRunSnapshot,
  verificationRunSnapshotSha256,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

let testRoot: string;
let stateRoot: string;
let projectRoot: string;

const loadApprovedVerificationPackage = () =>
  readFile(path.resolve("docs", "slices", "SLICE-017.md"));

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "ark-team-state-test-"));
  stateRoot = path.join(testRoot, "state");
  projectRoot = path.join(testRoot, "project");
  await mkdir(projectRoot);
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function completeCapabilityMatrix(
  store: RunStore,
  runId: string,
): Promise<Awaited<ReturnType<RunStore["getRun"]>>> {
  let run = await store.getRun(runId);
  const snapshot = run.verification_snapshot;
  if (snapshot === null || snapshot.schema_version !== 2) {
    throw new Error("contract-v2 verification snapshot is required");
  }
  const demands: Array<{
    lane: "backend" | "ui";
    lane_required: boolean;
    capability: VerificationCapability;
    capability_required: boolean;
  }> = [];
  if (snapshot.backend_contract.enabled) {
    const backend = snapshot.backend_contract;
    demands.push(
      ...backend.required_capabilities.map(
        (capability) => ({
          lane: "backend" as const,
          lane_required: backend.required,
          capability,
          capability_required: true,
        }),
      ),
    );
  }
  if (snapshot.ui_contract.enabled) {
    const ui = snapshot.ui_contract;
    demands.push(
      ...ui.required_capabilities.map((capability) => ({
        lane: "ui" as const,
        lane_required: ui.required,
        capability,
        capability_required: true,
      })),
      ...ui.optional_capabilities.map((capability) => ({
        lane: "ui" as const,
        lane_required: ui.required,
        capability,
        capability_required: false,
      })),
    );
  }
  const reserved = await store.recordVerificationAttempt(runId, {
    action_id: "state-store-readiness",
    kind: "readiness",
    lane: null,
    check_id: null,
    input_sha256: "e".repeat(64),
    evidence_record_ids: [],
  });
  assert.equal(reserved.reserved, true);
  run = reserved.run;
  const evidenceIds: string[] = [];
  for (const demand of demands) {
    const existing = run.verification_records.find(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "capability" &&
        record.lane === demand.lane &&
        record.payload.capability === demand.capability &&
        record.payload.diagnostic !== undefined,
    );
    if (existing !== undefined) {
      evidenceIds.push(existing.record_id);
      continue;
    }
    const payload = {
      kind: "capability" as const,
      capability: demand.capability,
      available: true,
      version: "1.0.0",
      diagnostic: "available",
    };
    const record: VerificationLinkedRecord = {
      schema_version: 2,
      contract_id: "verification_contract_v2",
      record_id: `state-store-${demand.lane}-${demand.capability}`,
      record_type: "capability",
      run_id: run.run_id,
      case_id: snapshot.case_id,
      check_id: null,
      snapshot_id: snapshot.snapshot_id,
      lane: demand.lane,
      stage: "capabilities",
      timestamp_utc: "2026-07-27T20:00:00.000Z",
      source_fingerprint: snapshot.source_fingerprint,
      package_fingerprint: snapshot.package.package_fingerprint,
      lane_required: demand.lane_required,
      check_required: demand.capability_required,
      previous_record_sha256: sha256CanonicalJson(
        run.verification_records.at(-1),
      ),
      payload_sha256: sha256CanonicalJson(payload),
      payload,
      adapter: {
        name: `${demand.capability}-probe`,
        version: "1.0.0",
      },
      model: null,
      artifact_references: [],
    };
    run = await store.appendVerificationRecord(runId, record);
    evidenceIds.push(record.record_id);
  }
  return (
    await store.completeVerificationAttempt(runId, {
      action_id: "state-store-readiness",
      evidence_record_ids: evidenceIds,
      error_code: null,
      message: null,
    })
  ).run;
}

async function createExecutingBackendRun(
  store: RunStore,
  objective: string,
): Promise<string> {
  const coordinator = validVerificationCoordinatorConfig();
  coordinator.ui = { enabled: false };
  if (!coordinator.backend.enabled) {
    throw new Error("backend verification fixture must be enabled");
  }
  const homeProbe = coordinator.backend.api_probes[0];
  if (homeProbe === undefined) {
    throw new Error("backend verification probe is missing");
  }
  coordinator.backend.api_probes.push({
    ...homeProbe,
    id: "health-api",
    path: "/health",
  });
  const config = structuredClone(DEFAULT_PROJECT_CONFIG);
  config.verification.coordinator = coordinator;
  const created = await store.createRun({
    objective,
    project_path: projectRoot,
    project_config: config,
  });
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "configured"))
      .accepted,
    true,
  );
  await store.recordVerificationSnapshot(created.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: 10_001,
  });
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "capabilities"))
      .accepted,
    true,
  );
  await completeCapabilityMatrix(store, created.run_id);
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "ready")).accepted,
    true,
  );
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "executing"))
      .accepted,
    true,
  );
  return created.run_id;
}

test("state root defaults to the Ark-owned home directory", () => {
  assert.equal(
    resolveStateRoot({}),
    path.join(homedir(), ".ark-team", "runs"),
  );
});

test("TEST-001 creates a run and reopens persisted state", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Implement persistent lifecycle control",
    project_path: projectRoot,
  });

  assert.match(created.run_id, /^ark-\d{8}t\d{6}z-[a-z0-9]{6}$/);
  assert.equal(created.state, "planning");
  assert.equal(created.event_count, 1);

  const reopened = new RunStore({ root_path: stateRoot });
  assert.deepEqual(await reopened.getRun(created.run_id), created);

  const listed = await reopened.listRuns();
  assert.equal(listed.total, 1);
  assert.equal(listed.runs[0]?.run_id, created.run_id);
});

test("TEST-1705 persists one immutable verification snapshot and reopens it byte-equivalently", async () => {
  const config = structuredClone(DEFAULT_PROJECT_CONFIG);
  config.verification.coordinator = validVerificationCoordinatorConfig();
  let sourceReads = 0;
  const store = new RunStore({
    root_path: stateRoot,
    suffix: () => "170500",
    verification_source_loader: async () => {
      sourceReads += 1;
      return validVerificationSourceIdentity(projectRoot);
    },
    verification_package_loader: loadApprovedVerificationPackage,
  });
  const created = await store.createRun({
    objective: "Persist an immutable verification snapshot",
    project_path: projectRoot,
    project_config: config,
    project_config_source: path.join(
      projectRoot,
      ".codex",
      "team-orchestrator.toml",
    ),
  });
  assert.match(created.project_config_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(created.verification_snapshot, null);
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "configured"))
      .accepted,
    true,
  );

  const recorded = await store.recordVerificationSnapshot(created.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: 10_001,
  });
  assert.equal(sourceReads, 1);
  assert.equal(recorded.verification_snapshot?.server.port, 10_001);
  assert.equal(
    recorded.verification_snapshot?.artifact_root,
    path.join(stateRoot, created.run_id, "verification"),
  );
  assert.match(recorded.verification_snapshot_sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(
    recorded.verification_records.map((record) => record.record_type),
    ["source", "config", "snapshot"],
  );
  const snapshot = recorded.verification_snapshot;
  assert.notEqual(snapshot, null);
  if (snapshot === null) {
    throw new Error("verification snapshot was not persisted");
  }
  assert.equal(snapshot.schema_version, 2);
  const errorPayload = {
    kind: "capability" as const,
    capability: "server" as const,
    available: true,
    version: "1.0.0",
    diagnostic: "available",
  };
  const errorRecord = {
    schema_version: 2 as const,
    contract_id: "verification_contract_v2" as const,
    record_id: `${created.run_id}-capability`,
    record_type: "capability" as const,
    run_id: created.run_id,
    case_id: snapshot.case_id,
    snapshot_id: snapshot.snapshot_id,
    lane: "backend" as const,
    stage: "capabilities" as const,
    timestamp_utc: "2026-07-26T18:00:01.000Z",
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    lane_required: true,
    check_id: null,
    check_required: true,
    previous_record_sha256: sha256CanonicalJson(
      recorded.verification_records.at(-1),
    ),
    payload_sha256: sha256CanonicalJson(errorPayload),
    payload: errorPayload,
    adapter: { name: "server-probe", version: "1.0.0" },
    model: null,
    artifact_references: [],
  };
  const capabilityStage = await store.advanceVerificationState(
    created.run_id,
    "capabilities",
  );
  assert.equal(capabilityStage.accepted, true);
  const withEvidence = await store.appendVerificationRecord(
    created.run_id,
    errorRecord,
  );
  assert.equal(withEvidence.verification_records.length, 4);
  await assert.rejects(
    () =>
      store.appendVerificationRecord(created.run_id, {
        ...errorRecord,
        record_id: `${created.run_id}-broken`,
        snapshot_id: "snapshot-other",
        previous_record_sha256: sha256CanonicalJson(
          withEvidence.verification_records.at(-1),
        ),
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
  );
  await assert.rejects(
    () =>
      store.appendVerificationRecord(created.run_id, {
        ...errorRecord,
        record_id: `${created.run_id}-lane-downgrade`,
        lane_required: false,
        previous_record_sha256: sha256CanonicalJson(
          withEvidence.verification_records.at(-1),
        ),
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
  );
  const incompleteReady = await store.advanceVerificationState(
    created.run_id,
    "ready",
  );
  assert.equal(incompleteReady.accepted, false);
  assert.equal(
    incompleteReady.run.verification_state?.current_state,
    "capabilities",
  );
  const withCapabilities = await completeCapabilityMatrix(
    store,
    created.run_id,
  );
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "ready")).accepted,
    true,
  );
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "executing"))
      .accepted,
    true,
  );
  const requestPayload = {
    kind: "request" as const,
    method: "GET" as const,
    path: "/",
    expected_status: 200,
    actual_status: 200,
    request_sha256: "c".repeat(64),
    response_sha256: "d".repeat(64),
  };
  const requestRecord = {
    ...errorRecord,
    record_id: `${created.run_id}-request`,
    record_type: "request" as const,
    stage: "executing" as const,
    lane: "backend" as const,
    lane_required: true,
    check_id: "home-api",
    check_required: true,
    previous_record_sha256: sha256CanonicalJson(
      withCapabilities.verification_records.at(-1),
    ),
    payload_sha256: sha256CanonicalJson(requestPayload),
    payload: requestPayload,
    adapter: { name: "curl", version: "8.14.1" },
  };
  await assert.rejects(
    () =>
      store.appendVerificationRecord(created.run_id, {
        ...requestRecord,
        record_id: `${created.run_id}-required-downgrade`,
        check_required: false,
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
  );
  await assert.rejects(
    () =>
      store.appendVerificationRecord(created.run_id, {
        ...requestRecord,
        record_id: `${created.run_id}-unknown-check`,
        check_id: "unknown-api",
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
  );
  await assert.rejects(
    () =>
      store.appendVerificationRecord(created.run_id, {
        ...requestRecord,
        record_id: `${created.run_id}-adapter-drift`,
        adapter: { name: "curl", version: "8.14.2" },
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
  );
  const withRequestEvidence = await store.appendVerificationRecord(
    created.run_id,
    requestRecord,
  );
  assert.equal(
    withRequestEvidence.verification_records.at(-1)?.record_id,
    requestRecord.record_id,
  );
  assert.equal(snapshot.ui_contract.enabled, true);
  if (!snapshot.ui_contract.enabled) {
    throw new Error("UI verification contract was not enabled");
  }
  const browserCase = snapshot.ui_contract.browser_cases[0];
  if (browserCase === undefined) {
    throw new Error("browser verification case was not snapshotted");
  }
  const browserPayload = {
    kind: "browser" as const,
    case_sha256: sha256CanonicalJson(browserCase),
    action_count: 0,
    assertion_count: 1,
  };
  const browserRecord = {
    ...errorRecord,
    record_id: `${created.run_id}-browser`,
    record_type: "browser" as const,
    stage: "executing" as const,
    lane: "ui" as const,
    lane_required: true,
    check_id: browserCase.id,
    check_required: browserCase.required,
    previous_record_sha256: sha256CanonicalJson(
      withRequestEvidence.verification_records.at(-1),
    ),
    payload_sha256: sha256CanonicalJson(browserPayload),
    payload: browserPayload,
    adapter: { name: "playwright-cli", version: "1.62.0" },
  };
  const wrongBrowserPayload = {
    ...browserPayload,
    case_sha256: "f".repeat(64),
  };
  await assert.rejects(
    () =>
      store.appendVerificationRecord(created.run_id, {
        ...browserRecord,
        record_id: `${created.run_id}-browser-case-drift`,
        payload: wrongBrowserPayload,
        payload_sha256: sha256CanonicalJson(wrongBrowserPayload),
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
  );
  const withBrowserEvidence = await store.appendVerificationRecord(
    created.run_id,
    browserRecord,
  );
  assert.equal(
    withBrowserEvidence.verification_records.at(-1)?.record_id,
    browserRecord.record_id,
  );
  const packageDrift = new RunStore({
    root_path: stateRoot,
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: async () => "changed package bytes",
  });
  await assert.rejects(
    () =>
      packageDrift.recordVerificationSnapshot(created.run_id, {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server_port: 10_001,
      }),
    (error: unknown) =>
      error instanceof ArkTeamError &&
      error.code === "PACKAGE_FINGERPRINT_MISMATCH",
  );
  const sourceDrift = new RunStore({
    root_path: stateRoot,
    verification_source_loader: async () => ({
      ...validVerificationSourceIdentity(projectRoot),
      source_commit: "f".repeat(40),
    }),
    verification_package_loader: loadApprovedVerificationPackage,
  });
  await assert.rejects(
    () =>
      sourceDrift.recordVerificationSnapshot(created.run_id, {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server_port: 10_001,
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
  );

  assert.equal(config.verification.coordinator.ui.enabled, true);
  if (config.verification.coordinator.ui.enabled) {
    config.verification.coordinator.ui.baseline_identity.id = "mutated-input";
  }
  let replaySourceReads = 0;
  const reopened = new RunStore({
    root_path: stateRoot,
    verification_source_loader: async () => {
      replaySourceReads += 1;
      return validVerificationSourceIdentity(projectRoot);
    },
    verification_package_loader: loadApprovedVerificationPackage,
  });
  const beforeReplay = await reopened.getRun(created.run_id);
  assert.equal(
    beforeReplay.verification_snapshot?.baseline_identity?.id,
    "baseline-home-v2",
  );
  const replayed = await reopened.recordVerificationSnapshot(created.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: 10_001,
  });
  assert.equal(replaySourceReads, 1);
  assert.deepEqual(replayed.verification_snapshot, recorded.verification_snapshot);
  assert.equal(
    replayed.verification_snapshot_sha256,
    recorded.verification_snapshot_sha256,
  );

  await assert.rejects(
    () =>
      reopened.recordVerificationSnapshot(created.run_id, {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server_port: 10_002,
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
  );

  const recordPath = path.join(stateRoot, created.run_id, "run.json");
  const validRecord = await readFile(recordPath, "utf8");
  const requirednessDrift = JSON.parse(validRecord) as {
    run: {
      verification_records: Array<{
        record_type: string;
        check_required: boolean;
        previous_record_sha256: string | null;
      }>;
    };
  };
  const persistedRequest = requirednessDrift.run.verification_records.find(
    (record) => record.record_type === "request",
  );
  if (persistedRequest === undefined) {
    throw new Error("request verification record was not persisted");
  }
  persistedRequest.check_required = false;
  requirednessDrift.run.verification_records.forEach(
    (record, index, records) => {
      record.previous_record_sha256 =
        index === 0 ? null : sha256CanonicalJson(records[index - 1]);
    },
  );
  await writeFile(
    recordPath,
    `${JSON.stringify(requirednessDrift, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => reopened.getRun(created.run_id),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "CORRUPT_STATE",
  );
  await writeFile(recordPath, validRecord, "utf8");

  const linkDrift = JSON.parse(validRecord) as {
    run: {
      verification_records: Array<{
        payload: { kind: string; source_sha256?: string };
        payload_sha256: string;
        previous_record_sha256: string | null;
      }>;
    };
  };
  const sourceLink = linkDrift.run.verification_records[0];
  if (sourceLink === undefined) {
    throw new Error("source verification record was not persisted");
  }
  sourceLink.payload.source_sha256 = "f".repeat(64);
  sourceLink.payload_sha256 = sha256CanonicalJson(sourceLink.payload);
  linkDrift.run.verification_records.forEach((record, index, records) => {
    record.previous_record_sha256 =
      index === 0 ? null : sha256CanonicalJson(records[index - 1]);
  });
  await writeFile(
    recordPath,
    `${JSON.stringify(linkDrift, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => reopened.getRun(created.run_id),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "CORRUPT_STATE",
  );

  await writeFile(recordPath, validRecord, "utf8");
  const rootDrift = JSON.parse(validRecord) as {
    run: {
      verification_snapshot: VerificationRunSnapshot;
      verification_snapshot_sha256: string;
    };
  };
  rootDrift.run.verification_snapshot.baseline_root =
    path.join(testRoot, "different-baseline-root");
  rootDrift.run.verification_snapshot_sha256 = verificationRunSnapshotSha256(
    rootDrift.run.verification_snapshot,
  );
  await writeFile(
    recordPath,
    `${JSON.stringify(rootDrift, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    () => reopened.getRun(created.run_id),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "CORRUPT_STATE",
  );

  await writeFile(recordPath, validRecord, "utf8");
  const corrupted = JSON.parse(validRecord) as {
    run: { verification_snapshot: { case_id: string } };
  };
  corrupted.run.verification_snapshot.case_id = "";
  await writeFile(recordPath, `${JSON.stringify(corrupted, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => reopened.getRun(created.run_id),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "CORRUPT_STATE",
  );
});

test("TEST-1716 settles concurrent attempts atomically at an approval boundary", async () => {
  let sourceDrift = false;
  const store = new RunStore({
    root_path: stateRoot,
    verification_source_loader: async () => ({
      ...validVerificationSourceIdentity(projectRoot),
      ...(sourceDrift ? { source_tree: "f".repeat(40) } : {}),
    }),
    verification_package_loader: loadApprovedVerificationPackage,
  });
  const directRunId = await createExecutingBackendRun(
    store,
    "Terminate concurrent local checks before an approval boundary",
  );
  for (const [actionId, checkId] of [
    ["direct-home", "home-api"],
    ["direct-health", "health-api"],
  ] as const) {
    assert.equal(
      (
        await store.recordVerificationAttempt(directRunId, {
          action_id: actionId,
          kind: "api",
          lane: "backend",
          check_id: checkId,
          input_sha256: sha256CanonicalJson({ actionId, checkId }),
          evidence_record_ids: [],
        })
      ).reserved,
      true,
    );
  }
  assert.equal(
    (await store.assertCurrentVerification(directRunId)).run_id,
    directRunId,
  );
  const beforeDrift = await store.getRun(directRunId);
  sourceDrift = true;
  await assert.rejects(
    () => store.assertCurrentVerification(directRunId),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
  );
  await assert.rejects(
    () =>
      store.terminateVerificationForApproval(directRunId, {
        request_sha256: "a".repeat(64),
        message: "dangerous local effect requires explicit approval",
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
  );
  assert.deepEqual(await store.getRun(directRunId), beforeDrift);

  sourceDrift = false;
  const terminated = await store.terminateVerificationForApproval(
    directRunId,
    {
      request_sha256: "a".repeat(64),
      message: "dangerous local effect requires explicit approval",
    },
  );
  assert.equal(terminated.run.verification_state?.terminal_outcome, "error");
  assert.equal(
    terminated.run.verification_state?.attempts.some(
      (attempt) => attempt.status === "in_progress",
    ),
    false,
  );
  assert.deepEqual(
    terminated.run.verification_state?.attempts
      .filter((attempt) => attempt.kind === "api")
      .map((attempt) => attempt.status),
    ["aborted", "aborted"],
  );
  for (const actionId of ["direct-home", "direct-health"]) {
    assert.equal(
      terminated.run.verification_records.filter(
        (record) =>
          record.schema_version === 2 &&
          record.payload.kind === "error" &&
          record.payload.action_id === actionId &&
          record.payload.code === "APPROVAL_REQUIRED",
      ).length,
      1,
    );
  }
  const directRevision = terminated.run.revision;
  const lateDirectCompletion = await store.completeVerificationAttempt(
    directRunId,
    {
      action_id: "direct-health",
      evidence_record_ids: [],
      error_code: null,
      message: null,
    },
  );
  assert.equal(lateDirectCompletion.error_code, "APPROVAL_REQUIRED");
  assert.equal(lateDirectCompletion.run.revision, directRevision);

  const completionRunId = await createExecutingBackendRun(
    store,
    "Close concurrent checks when one completion reaches approval",
  );
  for (const [actionId, checkId] of [
    ["completion-home", "home-api"],
    ["completion-health", "health-api"],
  ] as const) {
    assert.equal(
      (
        await store.recordVerificationAttempt(completionRunId, {
          action_id: actionId,
          kind: "api",
          lane: "backend",
          check_id: checkId,
          input_sha256: sha256CanonicalJson({ actionId, checkId }),
          evidence_record_ids: [],
        })
      ).reserved,
      true,
    );
  }
  const completed = await store.completeVerificationAttempt(
    completionRunId,
    {
      action_id: "completion-home",
      evidence_record_ids: [],
      error_code: "APPROVAL_REQUIRED",
      message: "approval boundary reached during local execution",
    },
  );
  assert.equal(completed.error_code, "APPROVAL_REQUIRED");
  assert.equal(completed.run.verification_state?.terminal_outcome, "error");
  assert.equal(
    completed.run.verification_state?.attempts.some(
      (attempt) => attempt.status === "in_progress",
    ),
    false,
  );
  const completionRevision = completed.run.revision;
  const lateConcurrentCompletion = await store.completeVerificationAttempt(
    completionRunId,
    {
      action_id: "completion-health",
      evidence_record_ids: [],
      error_code: null,
      message: null,
    },
  );
  assert.equal(lateConcurrentCompletion.error_code, "APPROVAL_REQUIRED");
  assert.equal(lateConcurrentCompletion.run.revision, completionRevision);
});

test("TEST-1705 reopens pre-IS-1703 v4 runs without silently migrating coordinator state", async () => {
  const config = structuredClone(DEFAULT_PROJECT_CONFIG);
  config.verification.coordinator = validVerificationCoordinatorConfig();
  const store = new RunStore({
    root_path: stateRoot,
    suffix: () => "170501",
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: loadApprovedVerificationPackage,
  });
  const created = await store.createRun({
    objective: "Reopen an existing verification-spec-v4 run",
    project_path: projectRoot,
    project_config: config,
  });
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "configured"))
      .accepted,
    true,
  );
  await store.recordVerificationSnapshot(created.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: 10_001,
  });
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "configured"))
      .accepted,
    false,
  );

  const recordPath = path.join(stateRoot, created.run_id, "run.json");
  const persisted = JSON.parse(await readFile(recordPath, "utf8")) as {
    run: {
      verification_state: unknown;
      verification_records: Array<{
        record_type: string;
        lane: "backend" | "ui" | null;
        lane_required: boolean | null;
        check_id: string | null;
        check_required: boolean;
        payload_sha256: string;
        payload: Record<string, unknown> & {
          kind: string;
        };
      }>;
    };
  };
  const legacyGlobalError = persisted.run.verification_records.find(
    (record) => record.record_type === "error",
  );
  if (
    legacyGlobalError === undefined ||
    legacyGlobalError.payload.kind !== "error"
  ) {
    throw new Error("legacy global error fixture is missing");
  }
  Object.assign(legacyGlobalError.payload, {
    code: "APPROVAL_REQUIRED",
    message: "legacy approval boundary",
    attempt_count: 1,
    evidence_record_ids: [],
    outcome: "skipped",
    integrity_failure: false,
  });
  delete legacyGlobalError.payload.action_id;
  delete legacyGlobalError.payload.approval_id;
  delete legacyGlobalError.payload.request_sha256;
  delete legacyGlobalError.payload.capability;
  legacyGlobalError.lane = null;
  legacyGlobalError.lane_required = null;
  legacyGlobalError.check_id = null;
  legacyGlobalError.check_required = false;
  legacyGlobalError.payload_sha256 = sha256CanonicalJson(
    legacyGlobalError.payload,
  );
  await writeFile(
    recordPath,
    `${JSON.stringify(persisted, null, 2)}\n`,
    "utf8",
  );
  const legacyApprovalReader = new RunStore({ root_path: stateRoot });
  assert.equal(
    (
      await legacyApprovalReader.getRun(created.run_id)
    ).verification_records.some(
      (record) =>
        record.payload.kind === "error" &&
        record.payload.code === "APPROVAL_REQUIRED" &&
        !("approval_id" in record.payload),
    ),
    true,
  );

  Object.assign(legacyGlobalError.payload, {
    code: "CAPABILITY_UNAVAILABLE",
    message: "legacy optional browser capability unavailable",
    outcome: "unavailable",
  });
  legacyGlobalError.lane = "ui";
  legacyGlobalError.lane_required = true;
  legacyGlobalError.check_required = false;
  legacyGlobalError.payload_sha256 = sha256CanonicalJson(
    legacyGlobalError.payload,
  );
  await writeFile(
    recordPath,
    `${JSON.stringify(persisted, null, 2)}\n`,
    "utf8",
  );
  const legacyCapabilityReader = new RunStore({ root_path: stateRoot });
  assert.equal(
    (
      await legacyCapabilityReader.getRun(created.run_id)
    ).verification_records.some(
      (record) =>
        record.payload.kind === "error" &&
        record.payload.code === "CAPABILITY_UNAVAILABLE" &&
        "outcome" in record.payload &&
        record.payload.outcome === "unavailable" &&
        !("capability" in record.payload),
    ),
    true,
  );

  legacyGlobalError.check_required = true;
  delete legacyGlobalError.payload.attempt_count;
  delete legacyGlobalError.payload.evidence_record_ids;
  delete legacyGlobalError.payload.outcome;
  delete legacyGlobalError.payload.integrity_failure;
  legacyGlobalError.payload_sha256 = sha256CanonicalJson(
    legacyGlobalError.payload,
  );
  persisted.run.verification_state = null;
  await writeFile(
    recordPath,
    `${JSON.stringify(persisted, null, 2)}\n`,
    "utf8",
  );

  const reopened = new RunStore({
    root_path: stateRoot,
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: loadApprovedVerificationPackage,
  });
  const legacyV4 = await reopened.getRun(created.run_id);
  assert.equal(legacyV4.verification_state, null);
  const reopenedLegacyError = legacyV4.verification_records.find(
    (record) => record.record_type === "error",
  );
  assert.equal(
    reopenedLegacyError?.schema_version === 2
      ? reopenedLegacyError.check_required
      : undefined,
    true,
  );
  assert.equal(
    legacyV4.verification_snapshot?.package.package_id,
    "verification-spec-v4",
  );
  await assert.rejects(
    () => reopened.advanceVerificationState(created.run_id, "capabilities"),
    (error: unknown) =>
      error instanceof ArkTeamError &&
      error.code === "CONTRACT_VERSION_MISMATCH",
  );
});

test("TEST-1705 rollback disables new snapshots and preserves existing evidence", async () => {
  const config = structuredClone(DEFAULT_PROJECT_CONFIG);
  config.verification.coordinator = validVerificationCoordinatorConfig();
  const store = new RunStore({
    root_path: stateRoot,
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: loadApprovedVerificationPackage,
  });
  const existing = await store.createRun({
    objective: "Preserve verification evidence through rollback",
    project_path: projectRoot,
    project_config: config,
  });
  assert.equal(
    (await store.advanceVerificationState(existing.run_id, "configured"))
      .accepted,
    true,
  );
  const snapshotted = await store.recordVerificationSnapshot(existing.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: 10_001,
  });
  const rollback = await store.recordVerificationRollback({
    reason: "operator disabled new verification starts",
  });
  assert.equal(rollback.schema_version, 2);
  assert.equal(rollback.contract_id, "verification_contract_v2");
  assert.equal(rollback.new_starts_enabled, false);
  assert.equal(rollback.preserves_existing_records, true);

  const blocked = await store.createRun({
    objective: "Reject a new verification snapshot after rollback",
    project_path: projectRoot,
    project_config: config,
  });
  assert.equal(
    (await store.advanceVerificationState(blocked.run_id, "configured"))
      .accepted,
    true,
  );
  await assert.rejects(
    () =>
      store.recordVerificationSnapshot(blocked.run_id, {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server_port: 10_001,
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_TRANSITION",
  );

  const reopened = new RunStore({ root_path: stateRoot });
  assert.deepEqual(
    (await reopened.getRun(existing.run_id)).verification_records,
    snapshotted.verification_records,
  );
  assert.deepEqual(await reopened.getVerificationRollback(), rollback);
});

test("TEST-1705 rejects a missing coordinator as CONFIG_INVALID", async () => {
  const store = new RunStore({
    root_path: stateRoot,
    verification_package_loader: loadApprovedVerificationPackage,
  });
  const run = await store.createRun({
    objective: "Reject an incomplete verification configuration",
    project_path: projectRoot,
  });
  await assert.rejects(
    () =>
      store.recordVerificationSnapshot(run.run_id, {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server_port: 10_001,
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "CONFIG_INVALID",
  );
});

test("TEST-002 pauses, resumes, cancels, and resumes from cancellation", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Exercise lifecycle transitions",
    project_path: projectRoot,
  });

  const paused = await store.pauseRun(created.run_id, "User requested pause");
  assert.equal(paused.changed, true);
  assert.equal(paused.run.state, "paused");
  assert.equal(paused.run.resume_state, "planning");

  const resumed = await store.resumeRun(created.run_id);
  assert.equal(resumed.run.state, "planning");
  assert.equal(resumed.run.resume_state, null);

  const cancelled = await store.cancelRun(created.run_id, "User cancelled");
  assert.equal(cancelled.run.state, "cancelled");
  assert.equal(cancelled.run.resume_state, "planning");

  const resumedAfterCancel = await store.resumeRun(created.run_id);
  assert.equal(resumedAfterCancel.run.state, "planning");
  assert.equal(resumedAfterCancel.run.resume_state, null);
});

test("TEST-003 rejects an invalid transition without modifying state", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Reject invalid transition",
    project_path: projectRoot,
  });
  const recordPath = path.join(stateRoot, created.run_id, "run.json");
  const before = await readFile(recordPath, "utf8");

  await assert.rejects(
    () => store.resumeRun(created.run_id),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_TRANSITION",
  );

  assert.equal(await readFile(recordPath, "utf8"), before);
  assert.deepEqual(await store.getRun(created.run_id), created);
});

test("TEST-004 returns ordered event pages with a stable cursor", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Paginate lifecycle events",
    project_path: projectRoot,
  });
  await store.pauseRun(created.run_id);
  await store.resumeRun(created.run_id);
  await store.cancelRun(created.run_id);

  const firstPage = await store.getLogs(created.run_id, { limit: 2 });
  assert.deepEqual(
    firstPage.events.map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(firstPage.next_after_sequence, 2);
  assert.equal(firstPage.has_more, true);

  const secondPage = await store.getLogs(created.run_id, {
    after_sequence: firstPage.next_after_sequence,
    limit: 2,
  });
  assert.deepEqual(
    secondPage.events.map((event) => event.sequence),
    [3, 4],
  );
  assert.equal(secondPage.has_more, false);
  assert.equal(
    secondPage.events.some((event) => "private_reasoning" in event),
    false,
  );
});

test("TEST-005 rejects relative project paths and unsafe run identifiers", async () => {
  const store = new RunStore({ root_path: stateRoot });

  await assert.rejects(
    () =>
      store.createRun({
        objective: "Invalid path",
        project_path: "relative/project",
      }),
    (error: unknown) => error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );

  await assert.rejects(
    () => store.getRun("../escape"),
    (error: unknown) => error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );
});

test("TEST-501 reopens a schema-version-1 run without assignment fields", async () => {
  const runId = "ark-20260724t000000z-abc123";
  const runDirectory = path.join(stateRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    path.join(runDirectory, "run.json"),
    `${JSON.stringify(
      {
        run: {
          schema_version: 1,
          run_id: runId,
          objective: "Legacy persisted run",
          project_path: projectRoot,
          state: "planning",
          resume_state: null,
          created_at: "2026-07-24T00:00:00.000Z",
          updated_at: "2026-07-24T00:00:00.000Z",
          revision: 1,
          event_count: 1,
        },
        events: [
          {
            schema_version: 1,
            sequence: 1,
            event_id: "legacy-event",
            event_type: "run.created",
            timestamp: "2026-07-24T00:00:00.000Z",
            state: "planning",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const store = new RunStore({ root_path: stateRoot });
  assert.equal((await store.getRun(runId)).assignment_count, 0);
  assert.equal((await store.getRun(runId)).team_count, 0);
  assert.deepEqual(await store.listAssignments(runId), {
    run_id: runId,
    assignments: [],
    total: 0,
  });
  assert.deepEqual(await store.listTeams(runId), {
    run_id: runId,
    teams: [],
    total: 0,
  });
});

test("TEST-704 persists one PM plan and its prepared teams atomically", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const run = await store.createRun({
    objective: "Persist a materialized plan",
    project_path: projectRoot,
  });
  const plan = {
    kind: "pm_plan" as const,
    objective: "Deliver two bounded teams.",
    teams: [
      {
        team_id: "team-a",
        mission: "Deliver A.",
        owned_paths: ["src/a.ts"],
        dependencies: [] as string[],
        acceptance_criteria: ["A is complete."],
        verification: ["Verify A."],
        worker_count: 2,
      },
      {
        team_id: "team-b",
        mission: "Deliver B.",
        owned_paths: ["src/b.ts"],
        dependencies: ["team-a"],
        acceptance_criteria: ["B is complete."],
        verification: ["Verify B."],
        worker_count: 1,
      },
    ],
    integration: {
      strategy: "local_merge" as const,
      acceptance_criteria: ["A and B integrate."],
      verification: ["Run all tests."],
    },
  };
  const baseCommit = "a".repeat(40);
  const workspaces = plan.teams.map((team) => ({
    run_id: run.run_id,
    team_id: team.team_id,
    isolation_mode: "git_worktree" as const,
    working_directory: path.join(testRoot, "worktrees", team.team_id),
    branch: `ark-team/${run.run_id}/${team.team_id}`,
    target_branch: "main",
    base_commit: baseCommit,
  }));

  const result = await store.materializePlan({
    run_id: run.run_id,
    plan,
    workspaces,
  });
  assert.equal(result.run.state, "staffing");
  assert.equal(result.run.team_count, 2);
  assert.equal(result.run.event_count, 4);
  assert.deepEqual(
    result.teams.map((team) => ({
      team_id: team.team_id,
      state: team.state,
      branch: team.branch,
      base_commit: team.base_commit,
    })),
    workspaces.map((workspace) => ({
      team_id: workspace.team_id,
      state: "ready",
      branch: workspace.branch,
      base_commit: baseCommit,
    })),
  );
  assert.deepEqual(await store.listTeams(run.run_id), {
    run_id: run.run_id,
    teams: result.teams,
    total: 2,
  });
  assert.deepEqual(
    (await store.getLogs(run.run_id)).events.map((event) => event.event_type),
    ["run.created", "plan.materialized", "team.prepared", "team.prepared"],
  );

  const before = await readFile(
    path.join(stateRoot, run.run_id, "run.json"),
    "utf8",
  );
  await assert.rejects(
    store.materializePlan({
      run_id: run.run_id,
      plan,
      workspaces,
    }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_TRANSITION",
  );
  assert.equal(
    await readFile(path.join(stateRoot, run.run_id, "run.json"), "utf8"),
    before,
  );

  await assert.rejects(
    store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Use an unplanned worktree",
      working_directory: path.join(testRoot, "wrong-worktree"),
    }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );
  await store.createAssignment({
    run_id: run.run_id,
    team_id: "team-a",
    role: "pl",
    assignment: "Lead the materialized team",
    working_directory: workspaces[0]?.working_directory ?? "",
  });
  assert.equal((await store.listTeams(run.run_id)).teams[0]?.state, "active");
});

test("TEST-901 and TEST-1001 reopen legacy assignments with hierarchy and retry defaults", async () => {
  const runId = "ark-20260724t010000z-abc124";
  const assignmentId = "asg-000000000001";
  const runDirectory = path.join(stateRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    path.join(runDirectory, "run.json"),
    `${JSON.stringify(
      {
        run: {
          schema_version: 1,
          run_id: runId,
          objective: "Legacy assignment defaults",
          project_path: projectRoot,
          state: "executing",
          resume_state: null,
          created_at: "2026-07-24T01:00:00.000Z",
          updated_at: "2026-07-24T01:00:00.000Z",
          revision: 1,
          event_count: 1,
          assignment_count: 1,
        },
        events: [
          {
            schema_version: 1,
            sequence: 1,
            event_id: "legacy-assignment-event",
            event_type: "assignment.started",
            timestamp: "2026-07-24T01:00:00.000Z",
            state: "executing",
            assignment_id: assignmentId,
            team_id: "team-a",
            agent_role: "pl",
          },
        ],
        assignments: [
          {
            schema_version: 1,
            assignment_id: assignmentId,
            run_id: runId,
            team_id: "team-a",
            role: "pl",
            parent_assignment_id: null,
            report_target: { type: "pm" },
            assignment: "Legacy PL assignment",
            working_directory: projectRoot,
            state: "running",
            session_id: null,
            turn_id: null,
            pending_approval: null,
            final_report: null,
            usage: null,
            failure_message: null,
            report_routed_at: null,
            created_at: "2026-07-24T01:00:00.000Z",
            updated_at: "2026-07-24T01:00:00.000Z",
            revision: 1,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const assignment = await new RunStore({
    root_path: stateRoot,
  }).getAssignment(runId, assignmentId);
  assert.equal(assignment.task_key, null);
  assert.equal(assignment.output_contract, null);
  assert.equal(assignment.structured_report, null);
  assert.equal(assignment.turn_count, 1);
  assert.equal(assignment.pending_retry, null);
  assert.equal(assignment.session_attempt_count, 1);
  assert.equal(assignment.correction_count, 0);
});

test("TEST-502 enforces team, PL, worker ownership, and count bounds", async () => {
  let sequence = 0;
  const store = new RunStore({
    root_path: stateRoot,
    assignment_suffix: () => (++sequence).toString(16).padStart(12, "0"),
  });
  const run = await store.createRun({
    objective: "Exercise assignment hierarchy",
    project_path: projectRoot,
  });

  const firstPl = await store.createAssignment({
    run_id: run.run_id,
    team_id: "team-a",
    role: "pl",
    assignment: "Lead team A",
    working_directory: projectRoot,
  });
  await assert.rejects(
    store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Duplicate PL",
      working_directory: projectRoot,
    }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    store.createAssignment({
      run_id: run.run_id,
      team_id: "team-b",
      role: "worker",
      parent_assignment_id: firstPl.assignment_id,
      assignment: "Wrong team",
      working_directory: projectRoot,
    }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );

  for (let worker = 1; worker <= 5; worker += 1) {
    await store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "worker",
      parent_assignment_id: firstPl.assignment_id,
      assignment: `Worker ${worker}`,
      working_directory: projectRoot,
    });
  }
  await assert.rejects(
    store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "worker",
      parent_assignment_id: firstPl.assignment_id,
      assignment: "Sixth worker",
      working_directory: projectRoot,
    }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );

  for (const teamId of ["team-b", "team-c", "team-d"]) {
    await store.createAssignment({
      run_id: run.run_id,
      team_id: teamId,
      role: "pl",
      assignment: `Lead ${teamId}`,
      working_directory: projectRoot,
    });
  }
  await assert.rejects(
    store.createAssignment({
      run_id: run.run_id,
      team_id: "team-e",
      role: "pl",
      assignment: "Fifth team",
      working_directory: projectRoot,
    }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );

  const assignments = await store.listAssignments(run.run_id);
  assert.equal(assignments.total, 9);
  assert.equal((await store.getRun(run.run_id)).assignment_count, 9);
  const logs = await store.getLogs(run.run_id, { limit: 200 });
  assert.equal(logs.events.length, 10);
  assert.deepEqual(
    logs.events.map((event) => event.sequence),
    Array.from({ length: 10 }, (_value, index) => index + 1),
  );

  await store.pauseRun(run.run_id);
  await assert.rejects(
    store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "worker",
      parent_assignment_id: firstPl.assignment_id,
      assignment: "Paused run worker",
      working_directory: projectRoot,
    }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_TRANSITION",
  );
});
