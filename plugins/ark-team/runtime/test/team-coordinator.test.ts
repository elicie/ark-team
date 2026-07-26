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
import type { PmPlan, PlWorkerPlan, WorkerReport } from "../src/role-contracts.js";
import { RunStore } from "../src/state-store.js";
import { TeamCoordinator } from "../src/team-coordinator.js";
import { WorktreeManager } from "../src/worktree-manager.js";

const execFileAsync = promisify(execFile);
const usage = {
  input_tokens: 50,
  cached_input_tokens: 10,
  cache_write_input_tokens: 0,
  output_tokens: 12,
  reasoning_output_tokens: 4,
};

test("TEST-902–TEST-906 run PL/worker waves, approvals, reports, and dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-coordinator-"));
  const repository = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  const worktreeRoot = path.join(root, "worktrees");
  const store = new RunStore({
    root_path: stateRoot,
    assignment_suffix: assignmentSequence(),
  });
  const manager = new WorktreeManager({ root_path: worktreeRoot });

  try {
    await initializeRepository(repository);
    const run = await store.createRun({
      objective: "Exercise hierarchical execution",
      project_path: repository,
    });
    const plan = pmPlan();
    const prepared = await manager.prepare(run, plan);
    await store.materializePlan({
      run_id: run.run_id,
      plan,
      workspaces: prepared,
    });

    const harness = new CoordinatorHarness();
    const scheduler = new ManagedAssignmentScheduler(store, {
      session_factory: () => new HarnessSession(harness),
    });
    const coordinator = new TeamCoordinator(store, scheduler);

    const first = await coordinator.advance(run.run_id);
    assert.equal(first.waiting_approvals, 2);
    assert.equal(first.run.state, "waiting_user");
    assert.deepEqual(harness.initialPlanningTeams.sort(), ["team-a", "team-b"]);
    assert.equal(harness.initialPlanningAssignments.length, 2);
    for (const assignment of harness.initialPlanningAssignments) {
      assert.match(
        assignment,
        /same dependency wave must have non-overlapping owned_paths/,
      );
      assert.match(
        assignment,
        /Set commit_required to false for every worker/,
      );
    }
    assert.equal(
      first.assignments.some((assignment) => assignment.team_id === "team-c"),
      false,
    );

    for (const assignment of first.assignments.filter(
      (candidate) => candidate.state === "waiting_user",
    )) {
      const approvalId = assignment.pending_approval?.approval_id;
      assert.equal(typeof approvalId, "string");
      await scheduler.decide(
        run.run_id,
        assignment.assignment_id,
        approvalId ?? "",
        "decline",
      );
    }

    const completed = await coordinator.advance(run.run_id);
    assert.equal(completed.waiting_approvals, 0);
    assert.equal(completed.run.state, "integrating");
    assert.deepEqual(
      completed.teams.map((team) => [team.team_id, team.state]),
      [
        ["team-a", "completed"],
        ["team-b", "completed"],
        ["team-c", "completed"],
      ],
    );

    const pls = completed.assignments.filter(
      (assignment) => assignment.role === "pl",
    );
    assert.equal(pls.length, 3);
    for (const pl of pls) {
      assert.equal(pl.output_contract, "pl_report");
      assert.equal(pl.structured_report?.kind, "pl_report");
      assert.equal(pl.turn_count, 2);
      assert.equal(pl.report_target.type, "pm");
    }
    assert.deepEqual(
      harness.resumedSessions.sort(),
      ["pl-team-a", "pl-team-b", "pl-team-c"],
    );

    const workers = completed.assignments.filter(
      (assignment) => assignment.role === "worker",
    );
    assert.equal(workers.length, 4);
    assert.deepEqual(
      workers.map((worker) => worker.task_key).sort(),
      ["a-1", "a-2", "b-1", "c-1"],
    );
    for (const worker of workers) {
      assert.equal(worker.output_contract, "worker_report");
      assert.equal(worker.structured_report?.kind, "worker_report");
      assert.equal(worker.report_target.type, "assignment");
    }
    assert.ok(
      harness.workerStartOrder.indexOf("a-1") <
        harness.workerStartOrder.indexOf("a-2"),
    );
    assert.ok(
      harness.planningOrder.indexOf("team-c") >
        harness.planningOrder.indexOf("team-a"),
    );

    const eventTypes = (await store.getLogs(run.run_id, { limit: 200 })).events.map(
      (event) => event.event_type,
    );
    assert.equal(
      eventTypes.filter((event) => event === "assignment.resumed").length,
      3,
    );
    assert.equal(
      eventTypes.filter((event) => event === "team.completed").length,
      3,
    );

    for (const workspace of [...prepared].reverse()) {
      await manager.cleanup(repository, workspace);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class CoordinatorHarness {
  readonly initialPlanningTeams: string[] = [];
  readonly initialPlanningAssignments: string[] = [];
  readonly planningOrder: string[] = [];
  readonly workerStartOrder: string[] = [];
  readonly resumedSessions: string[] = [];
  private initialPlanningCount = 0;
  private releaseInitialPlanning: (() => void) | null = null;
  private readonly initialPlanningReady = new Promise<void>((resolve) => {
    this.releaseInitialPlanning = resolve;
  });

  async waitForInitialPlanning(teamId: string): Promise<void> {
    this.initialPlanningTeams.push(teamId);
    this.initialPlanningCount += 1;
    if (this.initialPlanningCount === 2) {
      this.releaseInitialPlanning?.();
    }
    await this.initialPlanningReady;
  }
}

class HarnessSession implements ApprovalSessionHandle {
  private request: ApprovalSessionRequest | null = null;

  constructor(private readonly harness: CoordinatorHarness) {}

  async start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    this.request = request;
    const teamId = extract(request.assignment, "Team");
    if (request.output_contract === "pl_worker_plan") {
      this.harness.initialPlanningAssignments.push(request.assignment);
      this.harness.planningOrder.push(teamId);
      if (teamId === "team-a" || teamId === "team-b") {
        await this.harness.waitForInitialPlanning(teamId);
        return {
          status: "waiting_user",
          session_id: `pl-${teamId}`,
          turn_id: `plan-${teamId}`,
          role: "pl",
          approval: {
            approval_id:
              teamId === "team-a"
                ? "11111111-1111-4111-8111-111111111111"
                : "22222222-2222-4222-8222-222222222222",
            kind: "command",
            reason: "Test approval gate",
            command: "test-command",
          },
        };
      }
      return completedPlPlan(teamId);
    }
    if (request.output_contract === "worker_report") {
      const workerKey = extract(request.assignment, "Worker key");
      this.harness.workerStartOrder.push(workerKey);
      return completedWorker(teamId, workerKey);
    }
    if (request.output_contract === "pl_report") {
      assert.equal(request.resume_session_id, `pl-${teamId}`);
      this.harness.resumedSessions.push(request.resume_session_id);
      return completedPlReport(teamId, request.resume_session_id);
    }
    throw new Error(`Unexpected output contract: ${request.output_contract}`);
  }

  async decide(
    _approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    if (!this.request) {
      throw new Error("Session has not started");
    }
    return completedPlPlan(extract(this.request.assignment, "Team"));
  }

  async close(): Promise<void> {}
}

function completedPlPlan(teamId: string): ApprovalSessionUpdate {
  const report = plWorkerPlan(teamId);
  return {
    status: "completed",
    session_id: `pl-${teamId}`,
    turn_id: `plan-${teamId}`,
    role: "pl",
    agent_name: "ark_pl",
    model: "gpt-5.6-terra",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    final_report: JSON.stringify(report),
    structured_report: report,
    usage,
  };
}

function completedWorker(
  teamId: string,
  workerKey: string,
): ApprovalSessionUpdate {
  const report: WorkerReport = {
    kind: "worker_report",
    team_id: teamId,
    worker_key: workerKey,
    status: "completed",
    summary: `${workerKey} completed`,
    changed_files: [`src/${workerKey}.ts`],
    commit_sha: null,
    verification: [
      {
        name: "focused test",
        status: "passed",
        evidence: `${workerKey} test passed`,
      },
    ],
    blockers: [],
  };
  return {
    status: "completed",
    session_id: `worker-${teamId}-${workerKey}`,
    turn_id: `worker-turn-${teamId}-${workerKey}`,
    role: "worker",
    agent_name: "ark_worker",
    model: "gpt-5.6-luna",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    final_report: JSON.stringify(report),
    structured_report: report,
    usage,
  };
}

function completedPlReport(
  teamId: string,
  sessionId: string,
): ApprovalSessionUpdate {
  const workers = plWorkerPlan(teamId).workers.map((worker) => ({
    kind: "worker_report" as const,
    team_id: teamId,
    worker_key: worker.worker_key,
    status: "completed" as const,
    summary: `${worker.worker_key} completed`,
    changed_files: [`src/${worker.worker_key}.ts`],
    commit_sha: null,
    verification: [
      {
        name: "focused test",
        status: "passed" as const,
        evidence: `${worker.worker_key} test passed`,
      },
    ],
    blockers: [],
  }));
  const report = {
    kind: "pl_report" as const,
    team_id: teamId,
    status: "completed" as const,
    summary: `${teamId} completed`,
    worker_reports: workers,
    integration_commit_sha: "a".repeat(40),
    verification: [
      {
        name: "team verification",
        status: "passed" as const,
        evidence: `${teamId} checks passed`,
      },
    ],
    blockers: [],
  };
  return {
    status: "completed",
    session_id: sessionId,
    turn_id: `final-${teamId}`,
    role: "pl",
    agent_name: "ark_pl",
    model: "gpt-5.6-terra",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    final_report: JSON.stringify(report),
    structured_report: report,
    usage,
  };
}

function pmPlan(): PmPlan {
  return {
    kind: "pm_plan",
    objective: "Exercise hierarchy.",
    teams: [
      team("team-a", 2, []),
      team("team-b", 1, []),
      team("team-c", 1, ["team-a"]),
    ],
    integration: {
      strategy: "local_merge",
      acceptance_criteria: ["All teams integrate."],
      verification: ["Run all tests."],
    },
  };
}

function team(teamId: string, workerCount: number, dependencies: string[]) {
  return {
    team_id: teamId,
    mission: `Deliver ${teamId}.`,
    owned_paths: [`src/${teamId}/`],
    dependencies,
    acceptance_criteria: [`${teamId} is complete.`],
    verification: [`Verify ${teamId}.`],
    worker_count: workerCount,
  };
}

function plWorkerPlan(teamId: string): PlWorkerPlan {
  const workers =
    teamId === "team-a"
      ? [
          worker("a-1", []),
          worker("a-2", ["a-1"]),
        ]
      : [worker(teamId === "team-b" ? "b-1" : "c-1", [])];
  return {
    kind: "pl_worker_plan",
    team_id: teamId,
    workers,
  };
}

function worker(workerKey: string, dependencies: string[]) {
  return {
    worker_key: workerKey,
    mission: `Deliver ${workerKey}.`,
    owned_paths: [`src/${workerKey}.ts`],
    dependencies,
    acceptance_criteria: [`${workerKey} is complete.`],
    verification: [`Verify ${workerKey}.`],
    commit_required: false as const,
  };
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
