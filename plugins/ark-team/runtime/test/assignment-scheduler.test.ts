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
import { RunStore } from "../src/state-store.js";

const execFileAsync = promisify(execFile);
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const usage = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_write_input_tokens: 0,
  output_tokens: 10,
  reasoning_output_tokens: 5,
};

test("TEST-503 persists start, approval wait, decision, and completion", async () => {
  await withSchedulerFixture(async ({ stateRoot, worktree }) => {
    const store = deterministicStore(stateRoot);
    const run = await store.createRun({
      objective: "Persist an approval-gated assignment",
      project_path: worktree,
    });
    const session = new ScriptedSession([
      waitingUpdate("pl", APPROVAL_ID),
      completedUpdate("pl", "PL_FINAL_REPORT"),
    ]);
    const scheduler = new ManagedAssignmentScheduler(store, {
      session_factory: () => session,
    });

    const waiting = await scheduler.start({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Lead team A",
      working_directory: worktree,
    });
    assert.equal(waiting.state, "waiting_user");
    assert.equal(waiting.pending_approval?.approval_id, APPROVAL_ID);
    assert.equal((await store.getRun(run.run_id)).state, "waiting_user");
    assert.equal(scheduler.hasLiveSession(waiting.assignment_id), true);

    const completed = await scheduler.decide(
      run.run_id,
      waiting.assignment_id,
      APPROVAL_ID,
      "decline",
    );
    assert.equal(completed.state, "completed");
    assert.equal(completed.pending_approval, null);
    assert.equal(completed.final_report, "PL_FINAL_REPORT");
    assert.deepEqual(completed.usage, usage);
    assert.deepEqual(completed.report_target, { type: "pm" });
    assert.equal(typeof completed.report_routed_at, "string");
    assert.equal(scheduler.hasLiveSession(waiting.assignment_id), false);
    assert.deepEqual(session.decisions, [
      { approval_id: APPROVAL_ID, decision: "decline" },
    ]);

    const reopened = new RunStore({ root_path: stateRoot });
    assert.deepEqual(
      await reopened.getAssignment(run.run_id, waiting.assignment_id),
      completed,
    );
    const logs = await reopened.getLogs(run.run_id, { limit: 200 });
    assert.deepEqual(
      logs.events.map((event) => event.event_type),
      [
        "run.created",
        "assignment.started",
        "assignment.waiting_user",
        "assignment.approval_resolved",
        "assignment.completed",
        "assignment.report_routed",
      ],
    );
    const completedEvent = logs.events.find(
      (event) => event.event_type === "assignment.completed",
    );
    assert.deepEqual(completedEvent?.usage, usage);
    assert.equal("final_report" in (completedEvent ?? {}), false);
    assert.equal("private_reasoning" in (completedEvent ?? {}), false);
  });
});

test("TEST-504 rejects invalid, replayed, and orphaned approval decisions", async () => {
  await withSchedulerFixture(async ({ stateRoot, worktree }) => {
    const store = deterministicStore(stateRoot);
    const run = await store.createRun({
      objective: "Reject stale approvals",
      project_path: worktree,
    });
    const session = new ScriptedSession([
      waitingUpdate("pl", APPROVAL_ID),
      completedUpdate("pl", "DONE"),
    ]);
    const scheduler = new ManagedAssignmentScheduler(store, {
      session_factory: () => session,
    });
    const waiting = await scheduler.start({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Wait for one decision",
      working_directory: worktree,
    });
    const before = await store.getAssignment(run.run_id, waiting.assignment_id);

    await assert.rejects(
      scheduler.decide(
        run.run_id,
        waiting.assignment_id,
        "22222222-2222-4222-8222-222222222222",
        "decline",
      ),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(
      await store.getAssignment(run.run_id, waiting.assignment_id),
      before,
    );

    const restartedController = new ManagedAssignmentScheduler(
      new RunStore({ root_path: stateRoot }),
    );
    await assert.rejects(
      restartedController.decide(
        run.run_id,
        waiting.assignment_id,
        APPROVAL_ID,
        "decline",
      ),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "AGENT_SESSION_UNAVAILABLE",
    );
    assert.deepEqual(
      await store.getAssignment(run.run_id, waiting.assignment_id),
      before,
    );

    const completed = await scheduler.decide(
      run.run_id,
      waiting.assignment_id,
      APPROVAL_ID,
      "decline",
    );
    await assert.rejects(
      scheduler.decide(
        run.run_id,
        completed.assignment_id,
        APPROVAL_ID,
        "decline",
      ),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(
      await store.getAssignment(run.run_id, completed.assignment_id),
      completed,
    );
  });
});

test("TEST-505 routes worker reports to the owning PL and stores usage only", async () => {
  await withSchedulerFixture(async ({ stateRoot, worktree }) => {
    const store = deterministicStore(stateRoot);
    const run = await store.createRun({
      objective: "Route worker evidence",
      project_path: worktree,
    });
    const sessions = [
      new ScriptedSession([completedUpdate("pl", "PL_READY")]),
      new ScriptedSession([completedUpdate("worker", "WORKER_REPORT")]),
    ];
    const scheduler = new ManagedAssignmentScheduler(store, {
      session_factory: () => {
        const session = sessions.shift();
        if (!session) {
          throw new Error("No scripted session remains");
        }
        return session;
      },
    });
    const pl = await scheduler.start({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Request worker execution",
      working_directory: worktree,
    });
    const worker = await scheduler.start({
      run_id: run.run_id,
      team_id: "team-a",
      role: "worker",
      parent_assignment_id: pl.assignment_id,
      assignment: "Implement the bounded worker task",
      working_directory: worktree,
    });

    assert.equal(worker.final_report, "WORKER_REPORT");
    assert.deepEqual(worker.report_target, {
      type: "assignment",
      assignment_id: pl.assignment_id,
    });
    const workerReports = await store.listAssignments(run.run_id, {
      parent_assignment_id: pl.assignment_id,
      states: ["completed"],
    });
    assert.deepEqual(workerReports.assignments, [worker]);
    const route = (await store.getLogs(run.run_id, { limit: 200 })).events.find(
      (event) =>
        event.event_type === "assignment.report_routed" &&
        event.assignment_id === worker.assignment_id,
    );
    assert.deepEqual(route?.report_target, worker.report_target);
    assert.equal("final_report" in (route ?? {}), false);
  });
});

test("TEST-506 cancels assignments and stops active sessions on run pause", async () => {
  await withSchedulerFixture(async ({ stateRoot, worktree }) => {
    const store = deterministicStore(stateRoot);
    const run = await store.createRun({
      objective: "Stop active managed sessions",
      project_path: worktree,
    });
    const cancelledSession = new BlockingSession();
    const scheduler = new ManagedAssignmentScheduler(store, {
      session_factory: () => cancelledSession,
    });
    const start = scheduler.start({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Block until cancelled",
      working_directory: worktree,
    });
    const startRejected = assert.rejects(start);
    const running = await waitForAssignment(store, run.run_id);
    const cancelled = await scheduler.cancel(
      run.run_id,
      running.assignment_id,
      "User cancelled assignment",
    );
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.pending_approval, null);
    assert.equal(cancelledSession.close_count, 1);
    await startRejected;
    await assert.rejects(
      scheduler.decide(
        run.run_id,
        cancelled.assignment_id,
        APPROVAL_ID,
        "decline",
      ),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );

    const pauseSession = new BlockingSession();
    const pauseScheduler = new ManagedAssignmentScheduler(store, {
      session_factory: () => pauseSession,
    });
    const secondStart = pauseScheduler.start({
      run_id: run.run_id,
      team_id: "team-b",
      role: "pl",
      assignment: "Block until run pause",
      working_directory: worktree,
    });
    const secondStartRejected = assert.rejects(secondStart);
    const allAssignments = await waitForAssignmentCount(store, run.run_id, 2);
    const second = allAssignments.find(
      (assignment) => assignment.team_id === "team-b",
    );
    assert.ok(second);
    await pauseScheduler.stopRun(run.run_id, "paused", "User paused run");
    const pausedRun = await store.pauseRun(run.run_id, "User paused run");
    assert.equal(pausedRun.run.state, "paused");
    assert.equal(
      (await store.getAssignment(run.run_id, second.assignment_id)).state,
      "paused",
    );
    assert.equal(pauseSession.close_count, 1);
    await secondStartRejected;
  });
});

test("TEST-502 scheduler rejects a primary checkout before persistence", async () => {
  await withSchedulerFixture(async ({ stateRoot, repository }) => {
    const store = deterministicStore(stateRoot);
    const run = await store.createRun({
      objective: "Reject unsafe writer workspace",
      project_path: repository,
    });
    const scheduler = new ManagedAssignmentScheduler(store, {
      session_factory: () =>
        new ScriptedSession([completedUpdate("pl", "MUST_NOT_RUN")]),
    });
    await assert.rejects(
      scheduler.start({
        run_id: run.run_id,
        team_id: "team-a",
        role: "pl",
        assignment: "Do not run",
        working_directory: repository,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "UNSAFE_AGENT_WORKSPACE",
    );
    assert.equal((await store.listAssignments(run.run_id)).total, 0);
  });
});

class ScriptedSession implements ApprovalSessionHandle {
  readonly decisions: Array<{
    approval_id: string;
    decision: ApprovalDecision;
  }> = [];
  close_count = 0;

  constructor(private readonly updates: ApprovalSessionUpdate[]) {}

  async start(_request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    return this.takeUpdate();
  }

  async decide(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    this.decisions.push({ approval_id: approvalId, decision });
    return this.takeUpdate();
  }

  async close(): Promise<void> {
    this.close_count += 1;
  }

  private takeUpdate(): ApprovalSessionUpdate {
    const update = this.updates.shift();
    if (!update) {
      throw new Error("No scripted update remains");
    }
    return update;
  }
}

class BlockingSession implements ApprovalSessionHandle {
  close_count = 0;
  private rejectStart: ((error: Error) => void) | null = null;

  async start(_request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    return await new Promise<ApprovalSessionUpdate>((_resolve, reject) => {
      this.rejectStart = reject;
    });
  }

  async decide(
    _approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    throw new Error("Blocking session has no approval");
  }

  async close(): Promise<void> {
    this.close_count += 1;
    this.rejectStart?.(new Error("session closed"));
  }
}

function waitingUpdate(
  role: "pl" | "worker",
  approvalId: string,
): ApprovalSessionUpdate {
  return {
    status: "waiting_user",
    session_id: `${role}-session`,
    turn_id: `${role}-turn`,
    role,
    approval: {
      approval_id: approvalId,
      kind: "command",
      reason: "dangerous command",
      command: "touch outside",
    },
  };
}

function completedUpdate(
  role: "pl" | "worker",
  report: string,
): ApprovalSessionUpdate {
  const profile =
    role === "pl"
      ? {
          agent_name: "ark_pl" as const,
          model: "gpt-5.6-terra" as const,
        }
      : {
          agent_name: "ark_worker" as const,
          model: "gpt-5.6-luna" as const,
        };
  return {
    status: "completed",
    session_id: `${role}-session`,
    turn_id: `${role}-turn`,
    role,
    ...profile,
    model_reasoning_effort: "xhigh",
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    final_report: report,
    usage,
  };
}

function deterministicStore(stateRoot: string): RunStore {
  let sequence = 0;
  return new RunStore({
    root_path: stateRoot,
    assignment_suffix: () => (++sequence).toString(16).padStart(12, "0"),
  });
}

async function waitForAssignment(
  store: RunStore,
  runId: string,
) {
  const assignments = await waitForAssignmentCount(store, runId, 1);
  const assignment = assignments[0];
  assert.ok(assignment);
  return assignment;
}

async function waitForAssignmentCount(
  store: RunStore,
  runId: string,
  count: number,
) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const assignments = (await store.listAssignments(runId)).assignments;
    if (assignments.length >= count) {
      return assignments;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${count} persisted assignments`);
}

async function withSchedulerFixture(
  callback: (fixture: {
    stateRoot: string;
    repository: string;
    worktree: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-scheduler-test-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  try {
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
      "test baseline",
    ]);
    await execFileAsync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      "test/scheduler",
      worktree,
    ]);
    await callback({
      stateRoot: path.join(root, "state"),
      repository,
      worktree,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
