import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import { RunStore } from "../src/state-store.js";

let testRoot: string;
let stateRoot: string;
let projectRoot: string;

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
