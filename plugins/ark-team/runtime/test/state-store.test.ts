import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  sha256CanonicalJson,
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
    kind: "error" as const,
    code: "SOURCE_DRIFT" as const,
    message: "bounded test diagnostic",
  };
  const errorRecord = {
    schema_version: 2 as const,
    contract_id: "verification_contract_v2" as const,
    record_id: `${created.run_id}-error`,
    record_type: "error" as const,
    run_id: created.run_id,
    case_id: snapshot.case_id,
    snapshot_id: snapshot.snapshot_id,
    lane: null,
    stage: "snapshotted" as const,
    timestamp_utc: "2026-07-26T18:00:01.000Z",
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    lane_required: null,
    check_required: true,
    previous_record_sha256: sha256CanonicalJson(
      recorded.verification_records.at(-1),
    ),
    payload_sha256: sha256CanonicalJson(errorPayload),
    payload: errorPayload,
    adapter: null,
    model: null,
    artifact_references: [],
  };
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
        lane: "backend",
        lane_required: false,
        previous_record_sha256: sha256CanonicalJson(
          withEvidence.verification_records.at(-1),
        ),
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
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
