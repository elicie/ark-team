import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  APPROVED_VERIFICATION_SPEC_SHA256,
  appendVerificationLinkedRecord,
  assertVerificationPackageBytes,
  assertVerificationPackageFingerprint,
  assertVerificationSourceIdentity,
  buildVerificationRunSnapshot,
  canonicalJson,
  captureVerificationSource,
  legacyVerificationCoordinatorConfigSchema,
  sha256CanonicalJson,
  verificationCoordinatorConfigSchema,
  verificationLinkedRecordSchema,
  verificationRunSnapshotSchema,
  verificationRunSnapshotSha256,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const execFileAsync = promisify(execFile);
const RUN_ID = "ark-20260727t180000z-abc123";
const CREATED_AT = "2026-07-27T18:00:00.000Z";
const SHA = "c".repeat(64);

test("TEST-1701 captures and verifies an exact clean Git source identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-source-"));
  const repository = path.join(root, "repository");
  const otherRepository = path.join(root, "other-repository");
  await mkdir(repository);
  await mkdir(otherRepository);
  try {
    for (const candidate of [repository, otherRepository]) {
      await execFileAsync("git", ["init", "-b", "main", candidate]);
      await execFileAsync("git", [
        "-C",
        candidate,
        "config",
        "user.name",
        "Ark Team Test",
      ]);
      await execFileAsync("git", [
        "-C",
        candidate,
        "config",
        "user.email",
        "ark-team@example.invalid",
      ]);
    }
    await writeFile(path.join(repository, "tracked.txt"), "clean\n", "utf8");
    await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "clean source"]);
    await writeFile(path.join(otherRepository, "tracked.txt"), "other\n", "utf8");
    await execFileAsync("git", ["-C", otherRepository, "add", "tracked.txt"]);
    await execFileAsync("git", [
      "-C",
      otherRepository,
      "commit",
      "-m",
      "other source",
    ]);

    const captured = await captureVerificationSource(
      repository,
      () => new Date(CREATED_AT),
    );
    const other = await captureVerificationSource(otherRepository);
    assert.equal(captured.worktree_root, repository);
    assert.equal(captured.source_ref, "refs/heads/main");
    assert.equal(captured.worktree_state, "GIT_CLEAN");
    assert.deepEqual(captured.porcelain_status, []);
    assert.equal(captured.capture_method, "git-literal-argv-v1");
    assert.doesNotThrow(() => assertVerificationSourceIdentity(captured, captured));
    assert.notEqual(other.worktree_root, captured.worktree_root);
    assert.notEqual(other.source_commit, captured.source_commit);

    await writeFile(path.join(repository, "tracked.txt"), "dirty\n", "utf8");
    const dirty = await captureVerificationSource(repository);
    assert.throws(
      () => assertVerificationSourceIdentity(dirty, captured),
      isArkError("SOURCE_DRIFT"),
    );
    await execFileAsync("git", ["-C", repository, "checkout", "--", "tracked.txt"]);
    await execFileAsync("git", ["-C", repository, "checkout", "--detach"]);
    const detached = await captureVerificationSource(repository);
    assert.equal(detached.source_ref, null);
    assert.equal(detached.source_label, `detached@${captured.source_commit}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-1702 rejects source, package, scenario, and baseline drift", async () => {
  const source = validVerificationSourceIdentity();
  assert.throws(
    () =>
      assertVerificationSourceIdentity(
        { ...source, source_commit: "f".repeat(40) },
        source,
      ),
    isArkError("SOURCE_DRIFT"),
  );
  assert.throws(
    () => assertVerificationPackageFingerprint("f".repeat(64)),
    isArkError("PACKAGE_FINGERPRINT_MISMATCH"),
  );

  const baselineDrift = validVerificationCoordinatorConfig();
  assert.equal(baselineDrift.ui.enabled, true);
  if (baselineDrift.ui.enabled) {
    baselineDrift.ui.baseline_identity.source_tree = "f".repeat(40);
  }
  assert.throws(
    () => buildSnapshot(baselineDrift),
    isArkError("SOURCE_DRIFT"),
  );

  const approvedPackageBytes = await readFile(
    path.resolve("docs", "slices", "SLICE-017.md"),
  );
  assert.doesNotThrow(() => assertVerificationPackageBytes(approvedPackageBytes));
  assert.throws(
    () =>
      assertVerificationPackageBytes(
        Buffer.concat([approvedPackageBytes, Buffer.from("\n")]),
      ),
    isArkError("PACKAGE_FINGERPRINT_MISMATCH"),
  );
});

test("TEST-1704 validates schema-2 records, legacy readability, and chain isolation", () => {
  assert.equal(APPROVED_VERIFICATION_PACKAGE.package_id, "verification-spec-v3");
  assert.notEqual(
    APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    APPROVED_VERIFICATION_SPEC_SHA256,
  );
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] }),
    '{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
  );

  const artifactReference = {
    artifact_id: "artifact-1704",
    relative_path: "screenshots/home/375x812.actual.png",
    sha256: SHA,
  };
  const cases = [
    recordCase("source", { kind: "source", source_sha256: SHA }),
    recordCase("config", { kind: "config", config_sha256: SHA }),
    recordCase("snapshot", { kind: "snapshot", snapshot_sha256: SHA }),
    recordCase(
      "capability",
      {
        kind: "capability",
        capability: "browser",
        available: true,
        version: "1.62.0",
      },
      "ui",
      { name: "playwright-cli", version: "1.62.0" },
    ),
    recordCase(
      "request",
      {
        kind: "request",
        method: "GET",
        path: "/",
        expected_status: 200,
        actual_status: 200,
        request_sha256: SHA,
        response_sha256: SHA,
      },
      "backend",
      { name: "curl", version: "8.14.1" },
    ),
    recordCase(
      "browser",
      {
        kind: "browser",
        case_sha256: SHA,
        action_count: 0,
        assertion_count: 1,
      },
      "ui",
      { name: "playwright-cli", version: "1.62.0" },
    ),
    recordCase(
      "agentic_browser",
      {
        kind: "agentic_browser",
        execution_status: "completed",
        finding_status: "no_finding",
        self_verdict: "unknown",
        judge_verdict: "unknown",
        findings: [],
        input_sha256: SHA,
        ledger_sha256: SHA,
        step_count: 4,
      },
      "ui",
      { name: "browser-use", version: "0.13.6" },
      { identity: "gpt-5.6-mini" },
      [artifactReference],
      false,
    ),
    recordCase(
      "screenshot",
      {
        kind: "screenshot",
        viewport: "375x812",
        width: 375,
        height: 812,
        image_sha256: SHA,
      },
      "ui",
      { name: "playwright-cli", version: "1.62.0" },
      null,
      [artifactReference],
    ),
    recordCase(
      "review",
      { kind: "review", outcome: "passed", image_sha256: SHA },
      "ui",
      { name: "local-image", version: "active-turn" },
      null,
      [artifactReference],
    ),
    recordCase(
      "comparison",
      {
        kind: "comparison",
        outcome: "passed",
        baseline_sha256: SHA,
        actual_sha256: SHA,
        diff_sha256: SHA,
      },
      "ui",
      { name: "pixel-compare", version: "1" },
      null,
      [artifactReference],
    ),
    recordCase(
      "artifact",
      {
        kind: "artifact",
        artifact_id: artifactReference.artifact_id,
        relative_path: artifactReference.relative_path,
        media_type: "image/png",
        byte_length: 1,
        sha256: SHA,
      },
      "ui",
      null,
      null,
      [artifactReference],
    ),
    recordCase(
      "cleanup",
      {
        kind: "cleanup",
        disposition: "retention_active",
        code: null,
        message: null,
      },
      null,
      null,
      null,
      [artifactReference],
      false,
    ),
    recordCase(
      "lane_summary",
      {
        kind: "lane_summary",
        lane: "backend",
        outcome: "passed",
        evidence_record_ids: ["record-request"],
      },
      "backend",
    ),
    recordCase("error", {
      kind: "error",
      code: "CONTRACT_VERSION_MISMATCH",
      message: "legacy evidence is read-only",
    }),
    recordCase("report", {
      kind: "report",
      outcome: "passed",
      evidence_record_ids: ["record-lane-summary"],
    }),
    recordCase("rollback", {
      kind: "rollback",
      contract_id: "verification_contract_v2",
      new_starts_enabled: false,
      preserves_existing_records: true,
      reason: "operator rollback",
    }),
    recordCase("spec_delta", {
      kind: "spec_delta",
      status: "SPEC_DELTA_REQUIRED",
      runtime_status: "not_started",
      affected_ids: ["REQ-1704"],
      classification: "omission",
      source_snapshot: {
        worktree_root: "/tmp/project",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        package_fingerprint: SHA,
      },
      evidence: [{ kind: "observation", value: "required field missing" }],
      impact: "verification cannot start",
      proposed_resolution: "approve the missing field",
      blocking_stage: "IS-1701",
      created_at_utc: CREATED_AT,
    }),
  ];
  for (const [index, candidate] of cases.entries()) {
    assert.equal(
      verificationLinkedRecordSchema.safeParse({
        ...candidate,
        record_id: `record-${index}`,
      }).success,
      true,
      candidate.record_type,
    );
  }

  const agentic = cases.find(
    (candidate) => candidate.record_type === "agentic_browser",
  );
  assert.notEqual(agentic, undefined);
  assert.equal(
    verificationLinkedRecordSchema.safeParse({
      ...agentic,
      model: null,
    }).success,
    false,
  );
  const invalidAgenticPayload = {
    ...agentic?.payload,
    execution_status: "maybe",
  };
  assert.equal(
    verificationLinkedRecordSchema.safeParse({
      ...agentic,
      payload: invalidAgenticPayload,
      payload_sha256: sha256CanonicalJson(invalidAgenticPayload),
    }).success,
    false,
  );
  assert.equal(
    verificationLinkedRecordSchema.safeParse({
      ...agentic,
      lane: null,
      lane_required: null,
    }).success,
    false,
  );
  const optionalVerdictPayload = structuredClone(agentic?.payload) as Record<
    string,
    unknown
  >;
  delete optionalVerdictPayload.self_verdict;
  delete optionalVerdictPayload.judge_verdict;
  assert.equal(
    verificationLinkedRecordSchema.safeParse({
      ...agentic,
      payload: optionalVerdictPayload,
      payload_sha256: sha256CanonicalJson(optionalVerdictPayload),
    }).success,
    true,
  );

  const request = cases.find(
    (candidate) => candidate.record_type === "request",
  );
  assert.notEqual(request, undefined);
  assert.equal(
    verificationLinkedRecordSchema.safeParse({
      ...request,
      check_id: "",
    }).success,
    false,
  );
  const missingCheckId = { ...request } as Record<string, unknown>;
  delete missingCheckId.check_id;
  assert.equal(
    verificationLinkedRecordSchema.safeParse(missingCheckId).success,
    false,
  );

  const legacyPayload = { kind: "snapshot" as const, snapshot_sha256: SHA };
  const legacyRecord = {
    schema_version: 1 as const,
    record_id: "legacy-record",
    record_type: "snapshot" as const,
    run_id: RUN_ID,
    case_id: "BOOTSTRAP-1701",
    snapshot_id: "legacy-snapshot",
    stage: "snapshotted" as const,
    timestamp_utc: CREATED_AT,
    source_fingerprint: SHA,
    package_fingerprint: SHA,
    required: true,
    previous_record_sha256: null,
    payload_sha256: sha256CanonicalJson(legacyPayload),
    payload: legacyPayload,
    adapter: null,
    artifact_references: [],
  };
  assert.equal(verificationLinkedRecordSchema.safeParse(legacyRecord).success, true);
  assert.throws(
    () =>
      appendVerificationLinkedRecord([legacyRecord], {
        ...cases[0]!,
        previous_record_sha256: sha256CanonicalJson(legacyRecord),
      } as Parameters<typeof appendVerificationLinkedRecord>[1]),
    isArkError("INVALID_RECORD"),
  );
});

test("TEST-1705 enforces the lane matrix and immutable schema-2 snapshot", () => {
  const bothEnabled = validVerificationCoordinatorConfig();
  assert.equal(
    verificationCoordinatorConfigSchema.safeParse(bothEnabled).success,
    true,
  );

  const backendOnly = validVerificationCoordinatorConfig();
  backendOnly.ui = { enabled: false };
  assert.equal(
    verificationCoordinatorConfigSchema.safeParse(backendOnly).success,
    true,
  );
  const backendSnapshot = buildSnapshot(backendOnly);
  assert.equal(backendSnapshot.baseline_root, null);
  assert.equal(backendSnapshot.baseline_identity, null);
  assert.equal(backendSnapshot.ui_contract.enabled, false);

  const uiOnly = validVerificationCoordinatorConfig();
  uiOnly.backend = { enabled: false };
  assert.equal(verificationCoordinatorConfigSchema.safeParse(uiOnly).success, true);
  const snapshot = buildSnapshot(uiOnly);
  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.contract_id, "verification_contract_v2");
  assert.equal(snapshot.package.package_id, "verification-spec-v3");
  assert.equal(snapshot.backend_contract.enabled, false);
  assert.match(verificationRunSnapshotSha256(snapshot), /^[a-f0-9]{64}$/);

  assert.equal(
    verificationCoordinatorConfigSchema.safeParse({
      schema_version: 2,
      contract_id: "verification_contract_v2",
      enabled: false,
    }).success,
    true,
  );
  assert.equal(
    verificationCoordinatorConfigSchema.safeParse({
      schema_version: 2,
      contract_id: "verification_contract_v2",
      enabled: false,
      backend: { enabled: false },
    }).success,
    false,
  );

  const invalidConfigurations: unknown[] = [];
  const noRequiredLane = validVerificationCoordinatorConfig();
  assert.equal(noRequiredLane.backend.enabled, true);
  assert.equal(noRequiredLane.ui.enabled, true);
  if (noRequiredLane.backend.enabled && noRequiredLane.ui.enabled) {
    noRequiredLane.backend.required = false;
    noRequiredLane.ui.required = false;
  }
  invalidConfigurations.push(noRequiredLane);

  const noRequiredCheck = validVerificationCoordinatorConfig();
  assert.equal(noRequiredCheck.backend.enabled, true);
  if (noRequiredCheck.backend.enabled) {
    noRequiredCheck.backend.api_probes[0]!.required = false;
  }
  invalidConfigurations.push(noRequiredCheck);

  const capabilityMismatch = validVerificationCoordinatorConfig();
  assert.equal(capabilityMismatch.ui.enabled, true);
  if (capabilityMismatch.ui.enabled) {
    capabilityMismatch.ui.required_capabilities = ["browser", "server"];
  }
  invalidConfigurations.push(capabilityMismatch);

  const latestVersion = validVerificationCoordinatorConfig();
  assert.equal(latestVersion.ui.enabled, true);
  if (latestVersion.ui.enabled) {
    latestVersion.ui.deterministic_adapter_version = "latest";
  }
  invalidConfigurations.push(latestVersion);

  const promptDrift = validVerificationCoordinatorConfig();
  assert.equal(promptDrift.ui.enabled, true);
  if (promptDrift.ui.enabled) {
    promptDrift.ui.agentic_tasks[0]!.prompt_sha256 = "f".repeat(64);
  }
  invalidConfigurations.push(promptDrift);

  const blankGoal = validVerificationCoordinatorConfig();
  assert.equal(blankGoal.ui.enabled, true);
  if (blankGoal.ui.enabled) {
    blankGoal.ui.agentic_tasks[0]!.goal = "   ";
  }
  invalidConfigurations.push(blankGoal);

  const secretGoal = validVerificationCoordinatorConfig();
  assert.equal(secretGoal.ui.enabled, true);
  if (secretGoal.ui.enabled) {
    secretGoal.ui.agentic_tasks[0]!.goal = "token: exposed";
  }
  invalidConfigurations.push(secretGoal);

  const fallbackModel = validVerificationCoordinatorConfig();
  assert.equal(fallbackModel.ui.enabled, true);
  if (fallbackModel.ui.enabled) {
    fallbackModel.ui.agentic_tasks[0]!.model_identity = "fallback";
  }
  invalidConfigurations.push(fallbackModel);

  const traversal = validVerificationCoordinatorConfig();
  assert.equal(traversal.backend.enabled, true);
  if (traversal.backend.enabled) {
    traversal.backend.api_probes[0]!.path = "/%2e%2e/admin";
  }
  invalidConfigurations.push(traversal);

  const disabledResidual = validVerificationCoordinatorConfig();
  disabledResidual.ui = {
    enabled: false,
    required: true,
  } as never;
  invalidConfigurations.push(disabledResidual);

  for (const invalid of invalidConfigurations) {
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(invalid).success,
      false,
    );
  }

  const snapshotDrift = structuredClone(snapshot);
  snapshotDrift.resolved_config.server_readiness_path = "/changed";
  assert.equal(
    verificationRunSnapshotSchema.safeParse(snapshotDrift).success,
    false,
  );

  const legacyConfig = validLegacyConfig();
  assert.throws(
    () => buildSnapshot(legacyConfig),
    isArkError("CONTRACT_VERSION_MISMATCH"),
  );
  assert.equal(
    verificationRunSnapshotSchema.safeParse(validLegacySnapshot(legacyConfig))
      .success,
    true,
  );
});

function buildSnapshot(config: unknown) {
  return buildVerificationRunSnapshot({
    run_id: RUN_ID,
    project_path: "/tmp/ark-team-project",
    artifact_root: `/tmp/ark-team-state/${RUN_ID}/verification`,
    server_port: 10_001,
    created_at_utc: CREATED_AT,
    package_fingerprint: APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    source: validVerificationSourceIdentity(),
    config: config as Parameters<typeof buildVerificationRunSnapshot>[0]["config"],
  });
}

function recordCase(
  recordType: string,
  payload: Record<string, unknown>,
  lane: "backend" | "ui" | null = null,
  adapter: { name: string; version: string } | null = null,
  model: { identity: string } | null = null,
  artifactReferences: Array<{
    artifact_id: string;
    relative_path: string;
    sha256: string;
  }> = [],
  checkRequired = true,
) {
  const checkId =
    recordType === "request"
      ? "home-api"
      : recordType === "agentic_browser"
        ? "home-agentic"
        : ["browser", "screenshot", "review", "comparison"].includes(recordType)
          ? "home-browser"
          : null;
  return {
    schema_version: 2 as const,
    contract_id: "verification_contract_v2" as const,
    record_id: `record-${recordType}`,
    record_type: recordType,
    run_id: RUN_ID,
    case_id: "BOOTSTRAP-1701",
    snapshot_id: `${RUN_ID}-verification-v2`,
    lane,
    stage: "snapshotted" as const,
    timestamp_utc: CREATED_AT,
    source_fingerprint: SHA,
    package_fingerprint: APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    lane_required: lane === null ? null : true,
    check_id: checkId,
    check_required: checkRequired,
    previous_record_sha256: null,
    payload_sha256: sha256CanonicalJson(payload),
    payload,
    adapter,
    model,
    artifact_references: artifactReferences,
  };
}

function validLegacyConfig() {
  return legacyVerificationCoordinatorConfigSchema.parse({
    schema_version: 1,
    enabled: true,
    required_capabilities: [
      "server",
      "api",
      "browser",
      "screenshot",
      "semantic_review",
      "comparison",
    ],
    server_argv: ["npm", "run", "dev"],
    server_bind: "0.0.0.0",
    server_host: "dev",
    server_port_floor: 10_001,
    server_readiness_path: "/",
    server_readiness_status: 200,
    server_readiness_timeout_ms: 30_000,
    api_probes: [
      {
        id: "home-api",
        method: "GET",
        path: "/",
        query: {},
        headers: { accept: "text/html" },
        body_digest: "none",
        expected_status: 200,
        expected_content_type: "text/html",
        required: true,
      },
    ],
    api_adapter: "curl",
    browser_adapter: "playwright-cli",
    browser_cases: [
      {
        id: "home-browser",
        path: "/",
        readiness: "body",
        actions: [],
        required: true,
      },
    ],
    viewports: ["375x812", "768x1024", "1440x900"],
    baseline_root: ".ark-team/baselines",
    baseline_identity: {
      id: "baseline-home-v1",
      sha256: "a".repeat(64),
      source_commit: "a".repeat(40),
      source_tree: "b".repeat(40),
      environment: {
        viewports: ["375x812", "768x1024", "1440x900"],
        device_scale_factor: 1,
        locale: "en-US",
        timezone: "UTC",
        color_scheme: "light",
        reduced_motion: "no-preference",
      },
    },
    pixel_diff_fraction_max: 0.005,
    max_channel_delta: 8,
    critical_regions: [],
    evidence_limits: {
      console_events: 100,
      network_events: 100,
      metadata_bytes: 65_536,
      api_preview_bytes: 65_536,
      file_bytes: 52_428_800,
      total_bytes: 524_288_000,
      file_count: 500,
    },
    console_bytes: 32_768,
    network_bytes: 32_768,
    semantic_review_required: true,
    retention_days: 30,
    server_timeout_ms: 30_000,
    api_timeout_ms: 30_000,
    browser_timeout_ms: 60_000,
    case_timeout_ms: 120_000,
    attempts: {
      readiness: 2,
      api: 2,
      browser: 2,
      screenshot: 1,
      comparison: 1,
      semantic_review: 1,
      artifact_write: 1,
      cleanup: 1,
    },
    approval_policy: "explicit-one-time-user-decision",
  });
}

function validLegacySnapshot(config: ReturnType<typeof validLegacyConfig>) {
  const source = validVerificationSourceIdentity();
  const evidencePolicy = {
    console_event_limit: config.evidence_limits.console_events,
    console_byte_limit: config.console_bytes,
    network_event_limit: config.evidence_limits.network_events,
    network_byte_limit: config.network_bytes,
    api_preview_byte_limit: config.evidence_limits.api_preview_bytes,
    retention_days: config.retention_days,
    semantic_review_required: config.semantic_review_required,
    max_files: config.evidence_limits.file_count,
    max_file_bytes: config.evidence_limits.file_bytes,
    max_total_bytes: config.evidence_limits.total_bytes,
    max_metadata_bytes_per_check: config.evidence_limits.metadata_bytes,
  };
  return {
    schema_version: 1,
    snapshot_id: `${RUN_ID}-verification-v1`,
    package: {
      package_id: "verification-spec-v2",
      package_status: "SPEC_APPROVED",
      package_fingerprint:
        "095ae3afac8429264c82145d83a912ac39c0a26f3c30e9ab38398348356256af",
      authority_date: "2026-07-26",
      reference_boundary: "NONE",
      spec_sha256:
        "277fb413390f83f49fdf34fab4a42e3eca83d3f499fe5442e884f165a0128399",
    },
    source,
    source_fingerprint: sha256CanonicalJson(source),
    run_id: RUN_ID,
    case_id: "BOOTSTRAP-1701",
    scenario_version: 1,
    stage: "snapshotted",
    required: true,
    created_at_utc: CREATED_AT,
    artifact_root: `/tmp/ark-team-state/${RUN_ID}/verification`,
    artifact_references: [],
    baseline_root: "/tmp/ark-team-project/.ark-team/baselines",
    baseline_identity: config.baseline_identity,
    server: {
      host: "dev",
      bind: "0.0.0.0",
      port: 10_001,
      api_origin: "http://dev:10001",
    },
    browser_environment: config.baseline_identity.environment,
    required_capabilities: config.required_capabilities,
    api_contract: { adapter: config.api_adapter, probes: config.api_probes },
    browser_contract: {
      adapter: config.browser_adapter,
      cases: config.browser_cases,
    },
    timeouts_ms: {
      server_ms: config.server_timeout_ms,
      api_ms: config.api_timeout_ms,
      browser_ms: config.browser_timeout_ms,
      case_ms: config.case_timeout_ms,
    },
    attempt_policy: config.attempts,
    comparison_policy: {
      pixel_diff_fraction_max: config.pixel_diff_fraction_max,
      max_channel_delta: config.max_channel_delta,
      critical_regions: config.critical_regions,
    },
    evidence_policy: evidencePolicy,
    approval_policy: config.approval_policy,
    resolved_config: config,
    resolved_config_canonical: canonicalJson(config),
    resolved_config_sha256: sha256CanonicalJson(config),
  };
}

function isArkError(code: ArkTeamError["code"]) {
  return (error: unknown) =>
    error instanceof ArkTeamError && error.code === code;
}
