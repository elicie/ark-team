import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  ManagedAssignmentScheduler,
  type ApprovalSessionHandle,
} from "../src/assignment-scheduler.js";
import type {
  ApprovalDecision,
  ApprovalSessionRequest,
  ApprovalSessionUpdate,
} from "../src/approval-session.js";
import { ArkTeamError } from "../src/errors.js";
import type {
  PlReport,
  PlWorkerPlan,
  PmPlan,
  WorkerReport,
} from "../src/role-contracts.js";
import { RunStore } from "../src/state-store.js";
import { TeamCoordinator } from "../src/team-coordinator.js";
import { WorktreeManager } from "../src/worktree-manager.js";

const execFileAsync = promisify(execFile);
const usage = {
  input_tokens: 40,
  cached_input_tokens: 8,
  cache_write_input_tokens: 0,
  output_tokens: 12,
  reasoning_output_tokens: 3,
};

test("TEST-1002 and TEST-1006 retry internal failures without discarding independent work", async () => {
  await withCoordinatorFixture(
    plan([
      team("team-a", 1),
      team("team-b", 1),
    ]),
    async ({ runId, store, manager, prepared, repository }) => {
      let teamAFailures = 0;
      const requests: ApprovalSessionRequest[] = [];
      const scheduler = schedulerWith(store, async (request) => {
        requests.push(request);
        const teamId = extract(request.assignment, "Team");
        if (
          request.output_contract === "pl_worker_plan" &&
          teamId === "team-a" &&
          teamAFailures < 2
        ) {
          teamAFailures += 1;
          throw new Error(`transient PL failure ${teamAFailures}`);
        }
        return successfulUpdate(request);
      });
      const coordinator = new TeamCoordinator(store, scheduler);

      const result = await coordinator.advance(runId);
      assert.equal(result.run.state, "integrating");
      assert.equal(result.waiting_retries, 0);
      const teamAPl = result.assignments.find(
        (assignment) =>
          assignment.role === "pl" && assignment.team_id === "team-a",
      );
      const teamBPl = result.assignments.find(
        (assignment) =>
          assignment.role === "pl" && assignment.team_id === "team-b",
      );
      assert.equal(teamAPl?.session_attempt_count, 3);
      assert.equal(teamBPl?.session_attempt_count, 1);
      assert.equal(teamAFailures, 2);
      assert.equal(
        requests.filter(
          (request) =>
            request.output_contract === "pl_worker_plan" &&
            extract(request.assignment, "Team") === "team-b",
        ).length,
        1,
      );
      const events = (await store.getLogs(runId, { limit: 200 })).events;
      assert.equal(
        events.filter((event) => event.event_type === "assignment.retrying")
          .length,
        2,
      );

      await cleanupPrepared(manager, repository, prepared);
    },
  );
});

test("TEST-1003 and TEST-1004 apply two same-session corrections per report stage", async () => {
  await withCoordinatorFixture(
    plan([team("team-a", 2)]),
    async ({ runId, store, manager, prepared, repository }) => {
      let planTurns = 0;
      let workerOneTurns = 0;
      let finalTurns = 0;
      const resumed: string[] = [];
      const scheduler = schedulerWith(store, async (request) => {
        const teamId = extract(request.assignment, "Team");
        if (request.resume_session_id !== undefined) {
          resumed.push(request.resume_session_id);
        }
        if (request.output_contract === "pl_worker_plan") {
          planTurns += 1;
          return completedPlPlan(
            teamId,
            planTurns < 3
              ? workerPlan(teamId, ["worker-1"])
              : workerPlan(teamId, ["worker-1", "worker-2"]),
          );
        }
        if (request.output_contract === "worker_report") {
          const workerKey = extract(request.assignment, "Worker key");
          if (workerKey === "worker-1") {
            workerOneTurns += 1;
          }
          const completed = workerKey !== "worker-1" || workerOneTurns >= 3;
          return completedWorker(teamId, workerKey, completed);
        }
        if (request.output_contract === "pl_report") {
          finalTurns += 1;
          return completedPlReport(
            teamId,
            request.resume_session_id ?? `pl-${teamId}`,
            finalTurns >= 3,
            ["worker-1", "worker-2"],
          );
        }
        throw new Error("Unexpected output contract");
      });
      const coordinator = new TeamCoordinator(store, scheduler);

      const result = await coordinator.advance(runId);
      assert.equal(result.run.state, "integrating");
      assert.equal(planTurns, 3);
      assert.equal(workerOneTurns, 3);
      assert.equal(finalTurns, 3);
      const pl = result.assignments.find(
        (assignment) => assignment.role === "pl",
      );
      const workerOne = result.assignments.find(
        (assignment) => assignment.task_key === "worker-1",
      );
      assert.equal(pl?.correction_count, 2);
      assert.equal(workerOne?.correction_count, 2);
      assert.ok(resumed.filter((session) => session === "pl-team-a").length >= 4);
      assert.deepEqual(
        resumed.filter((session) => session === "worker-team-a-worker-1"),
        ["worker-team-a-worker-1", "worker-team-a-worker-1"],
      );
      const events = (await store.getLogs(runId, { limit: 200 })).events;
      assert.equal(
        events.filter((event) => event.event_type === "assignment.correction")
          .length,
        6,
      );

      await cleanupPrepared(manager, repository, prepared);
    },
  );
});

test("TEST-1005 waits after correction exhaustion and enforces one opaque user retry", async () => {
  await withCoordinatorFixture(
    plan([team("team-a", 1)]),
    async ({ runId, store, manager, prepared, repository }) => {
      let workerTurns = 0;
      const scheduler = schedulerWith(store, async (request) => {
        const teamId = extract(request.assignment, "Team");
        if (request.output_contract === "pl_worker_plan") {
          return completedPlPlan(
            teamId,
            workerPlan(teamId, ["worker-1"]),
          );
        }
        if (request.output_contract === "worker_report") {
          workerTurns += 1;
          const workerKey = extract(request.assignment, "Worker key");
          return completedWorker(
            teamId,
            workerKey,
            workerTurns >= 4,
          );
        }
        if (request.output_contract === "pl_report") {
          return completedPlReport(
            teamId,
            request.resume_session_id ?? `pl-${teamId}`,
            true,
            ["worker-1"],
          );
        }
        throw new Error("Unexpected output contract");
      });
      const coordinator = new TeamCoordinator(store, scheduler);

      const exhausted = await coordinator.advance(runId);
      assert.equal(exhausted.run.state, "waiting_user");
      assert.equal(exhausted.waiting_approvals, 0);
      assert.equal(exhausted.waiting_retries, 1);
      const worker = exhausted.assignments.find(
        (assignment) => assignment.role === "worker",
      );
      assert.equal(worker?.correction_count, 2);
      assert.equal(worker?.pending_retry?.mode, "resume_session");
      const requestId = worker?.pending_retry?.retry_request_id ?? "";

      await assert.rejects(
        scheduler.decideRetry(
          runId,
          worker?.assignment_id ?? "",
          "11111111-1111-4111-8111-111111111111",
          "retry_once",
        ),
        (error: unknown) =>
          error instanceof ArkTeamError && error.code === "INVALID_INPUT",
      );
      const retried = await scheduler.decideRetry(
        runId,
        worker?.assignment_id ?? "",
        requestId,
        "retry_once",
      );
      assert.equal(retried.state, "completed");
      assert.equal(retried.correction_count, 3);
      await assert.rejects(
        scheduler.decideRetry(
          runId,
          worker?.assignment_id ?? "",
          requestId,
          "retry_once",
        ),
        (error: unknown) =>
          error instanceof ArkTeamError && error.code === "INVALID_INPUT",
      );

      const completed = await coordinator.advance(runId);
      assert.equal(completed.run.state, "integrating");
      const events = (await store.getLogs(runId, { limit: 200 })).events;
      assert.equal(
        events.filter(
          (event) => event.event_type === "assignment.retry_exhausted",
        ).length,
        1,
      );
      assert.equal(
        events.filter(
          (event) => event.event_type === "assignment.retry_resolved",
        ).length,
        1,
      );

      await cleanupPrepared(manager, repository, prepared);
    },
  );
});

test("TEST-1005 cancel_run stops the hierarchy after retry exhaustion", async () => {
  await withCoordinatorFixture(
    plan([team("team-a", 1)]),
    async ({ runId, store, manager, prepared, repository }) => {
      const scheduler = schedulerWith(store, async () => {
        throw new Error("permanent managed-session failure");
      });
      const coordinator = new TeamCoordinator(store, scheduler, {
        internal_agent_retries: 0,
      });
      const exhausted = await coordinator.advance(runId);
      const pl = exhausted.assignments[0];
      assert.equal(exhausted.waiting_retries, 1);
      assert.equal(pl?.pending_retry?.mode, "fresh_session");

      const cancelled = await scheduler.decideRetry(
        runId,
        pl?.assignment_id ?? "",
        pl?.pending_retry?.retry_request_id ?? "",
        "cancel_run",
      );
      assert.equal(cancelled.state, "cancelled");
      assert.equal((await store.getRun(runId)).state, "cancelled");
      const events = (await store.getLogs(runId, { limit: 200 })).events;
      assert.equal(
        events.some(
          (event) =>
            event.event_type === "assignment.retry_resolved" &&
            event.retry_decision === "cancel_run",
        ),
        true,
      );

      await cleanupPrepared(manager, repository, prepared);
    },
  );
});

test("TEST-1006 propagates invalid workspace failures without creating retry state", async () => {
  await withCoordinatorFixture(
    plan([team("team-a", 1)]),
    async ({ runId, store, prepared }) => {
      const workspace = prepared[0]?.working_directory ?? "";
      await rm(workspace, { recursive: true, force: true });
      const scheduler = schedulerWith(store, async (request) =>
        successfulUpdate(request),
      );
      const coordinator = new TeamCoordinator(store, scheduler);

      await assert.rejects(
        coordinator.advance(runId),
        (error: unknown) =>
          error instanceof ArkTeamError &&
          error.code === "INVALID_INPUT",
      );
      assert.equal((await store.listAssignments(runId)).total, 0);
    },
  );
});

class FunctionSession implements ApprovalSessionHandle {
  constructor(
    private readonly responder: (
      request: ApprovalSessionRequest,
    ) => Promise<ApprovalSessionUpdate>,
  ) {}

  start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    return this.responder(request);
  }

  async decide(
    _approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    throw new Error("No approval was expected");
  }

  async close(): Promise<void> {}
}

function schedulerWith(
  store: RunStore,
  responder: (
    request: ApprovalSessionRequest,
  ) => Promise<ApprovalSessionUpdate>,
): ManagedAssignmentScheduler {
  return new ManagedAssignmentScheduler(store, {
    session_factory: () => new FunctionSession(responder),
  });
}

function successfulUpdate(
  request: ApprovalSessionRequest,
): ApprovalSessionUpdate {
  const teamId = extract(request.assignment, "Team");
  if (request.output_contract === "pl_worker_plan") {
    return completedPlPlan(
      teamId,
      workerPlan(teamId, [`${teamId}-worker`]),
    );
  }
  if (request.output_contract === "worker_report") {
    return completedWorker(
      teamId,
      extract(request.assignment, "Worker key"),
      true,
    );
  }
  if (request.output_contract === "pl_report") {
    return completedPlReport(
      teamId,
      request.resume_session_id ?? `pl-${teamId}`,
      true,
      [`${teamId}-worker`],
    );
  }
  throw new Error("Unexpected output contract");
}

function completedPlPlan(
  teamId: string,
  report: PlWorkerPlan,
): ApprovalSessionUpdate {
  return completedUpdate("pl", `pl-${teamId}`, "pl-plan", report);
}

function completedWorker(
  teamId: string,
  workerKey: string,
  completed: boolean,
): ApprovalSessionUpdate {
  const report = workerReport(teamId, workerKey, completed);
  return completedUpdate(
    "worker",
    `worker-${teamId}-${workerKey}`,
    `worker-${workerKey}`,
    report,
  );
}

function completedPlReport(
  teamId: string,
  sessionId: string,
  completed: boolean,
  workerKeys: string[],
): ApprovalSessionUpdate {
  const report: PlReport = {
    kind: "pl_report",
    team_id: teamId,
    status: completed ? "completed" : "blocked",
    summary: completed ? `${teamId} completed` : `${teamId} needs correction`,
    worker_reports: workerKeys.map((workerKey) =>
      workerReport(teamId, workerKey, true),
    ),
    integration_commit_sha: null,
    verification: [
      {
        name: "team verification",
        status: completed ? "passed" : "failed",
        evidence: completed ? "team checks passed" : "team checks failed",
      },
    ],
    blockers: completed ? [] : ["Team evidence is incomplete"],
  };
  return completedUpdate("pl", sessionId, "pl-final", report);
}

function completedUpdate(
  role: "pl" | "worker",
  sessionId: string,
  turnPrefix: string,
  report: PlWorkerPlan | WorkerReport | PlReport,
): ApprovalSessionUpdate {
  return {
    status: "completed",
    session_id: sessionId,
    turn_id: `${turnPrefix}-${Math.random().toString(16).slice(2)}`,
    role,
    agent_name: role === "pl" ? "ark_pl" : "ark_worker",
    model: role === "pl" ? "gpt-5.6-terra" : "gpt-5.6-luna",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    final_report: JSON.stringify(report),
    structured_report: report,
    usage,
  };
}

function workerReport(
  teamId: string,
  workerKey: string,
  completed: boolean,
): WorkerReport {
  return {
    kind: "worker_report",
    team_id: teamId,
    worker_key: workerKey,
    status: completed ? "completed" : "blocked",
    summary: completed ? `${workerKey} completed` : `${workerKey} blocked`,
    changed_files: [`src/${workerKey}.ts`],
    commit_sha: null,
    verification: [
      {
        name: "focused test",
        status: completed ? "passed" : "failed",
        evidence: completed ? "focused test passed" : "focused test failed",
      },
    ],
    blockers: completed ? [] : ["Focused verification failed"],
  };
}

function workerPlan(teamId: string, workerKeys: string[]): PlWorkerPlan {
  return {
    kind: "pl_worker_plan",
    team_id: teamId,
    workers: workerKeys.map((workerKey) => ({
      worker_key: workerKey,
      mission: `Deliver ${workerKey}.`,
      owned_paths: [`src/${workerKey}.ts`],
      dependencies: [],
      acceptance_criteria: [`${workerKey} is complete.`],
      verification: [`Verify ${workerKey}.`],
      commit_required: false,
    })),
  };
}

function plan(teams: PmPlan["teams"]): PmPlan {
  return {
    kind: "pm_plan",
    objective: "Exercise retry policy.",
    teams,
    integration: {
      strategy: "local_merge",
      acceptance_criteria: ["All teams complete."],
      verification: ["Run all checks."],
    },
  };
}

function team(teamId: string, workerCount: number): PmPlan["teams"][number] {
  return {
    team_id: teamId,
    mission: `Deliver ${teamId}.`,
    owned_paths: [`src/${teamId}/`],
    dependencies: [],
    acceptance_criteria: [`${teamId} is complete.`],
    verification: [`Verify ${teamId}.`],
    worker_count: workerCount,
  };
}

async function withCoordinatorFixture(
  pmPlan: PmPlan,
  operation: (fixture: {
    runId: string;
    store: RunStore;
    manager: WorktreeManager;
    repository: string;
    prepared: Awaited<ReturnType<WorktreeManager["prepare"]>>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-retry-"));
  const repository = path.join(root, "repository");
  const store = new RunStore({
    root_path: path.join(root, "state"),
    assignment_suffix: assignmentSequence(),
  });
  const manager = new WorktreeManager({
    root_path: path.join(root, "worktrees"),
  });
  try {
    await initializeRepository(repository);
    const run = await store.createRun({
      objective: pmPlan.objective,
      project_path: repository,
    });
    const prepared = await manager.prepare(run, pmPlan);
    await store.materializePlan({
      run_id: run.run_id,
      plan: pmPlan,
      workspaces: prepared,
    });
    await operation({
      runId: run.run_id,
      store,
      manager,
      repository,
      prepared,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cleanupPrepared(
  manager: WorktreeManager,
  repository: string,
  prepared: Awaited<ReturnType<WorktreeManager["prepare"]>>,
): Promise<void> {
  for (const workspace of [...prepared].reverse()) {
    await manager.cleanup(repository, workspace);
  }
}

function extract(assignment: string, field: string): string {
  const line = assignment
    .split("\n")
    .find((candidate) => candidate.startsWith(`${field}: `));
  if (!line) {
    throw new Error(`Missing ${field} in assignment`);
  }
  return line.slice(field.length + 2);
}

function assignmentSequence(): () => string {
  let value = 0;
  return () => (++value).toString(16).padStart(12, "0");
}

async function initializeRepository(repository: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.name",
    "Ark Team Test",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "ark-team-test@example.invalid",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "commit",
    "--allow-empty",
    "-m",
    "baseline",
  ]);
}
