import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  ManagedAssignmentScheduler,
  type ApprovalSessionHandle,
} from "../src/assignment-scheduler.js";
import type {
  ApprovalCompletedUpdate,
  ApprovalDecision,
  ApprovalSessionRequest,
  ApprovalSessionUpdate,
} from "../src/approval-session.js";
import { ArkTeamError } from "../src/errors.js";
import {
  ArkTeamRunCoordinator,
  IntegrationCoordinator,
  type PmReviewLauncher,
} from "../src/integration-coordinator.js";
import { IntegrationMaterializer } from "../src/integration-materializer.js";
import type {
  ManagedSessionRequest,
  ManagedSessionResult,
} from "../src/managed-session.js";
import type {
  IntegrationReport,
  PlReport,
  PlWorkerPlan,
  PmPlan,
  PmReport,
  WorkerReport,
} from "../src/role-contracts.js";
import { RunStore } from "../src/state-store.js";
import { TeamCoordinator } from "../src/team-coordinator.js";
import {
  IntegrationWorktreeManager,
  WorktreeManager,
} from "../src/worktree-manager.js";

const execFileAsync = promisify(execFile);
const approvalId = "44444444-4444-4444-8444-444444444444";
const usage = {
  input_tokens: 60,
  cached_input_tokens: 12,
  cache_write_input_tokens: 0,
  output_tokens: 18,
  reasoning_output_tokens: 5,
};

test("TEST-1101–TEST-1103, TEST-1105, TEST-1107, and TEST-1108 complete guarded local integration", async () => {
  await withIntegratedTeams(async (fixture) => {
    const harness = new IntegrationHarness(fixture.teams);
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      session_factory: () => new IntegrationSession(harness),
    });
    const pm = new FinalPmLauncher(fixture.teams.map((team) => team.team_id));
    const integrationCoordinator = new IntegrationCoordinator(fixture.store, scheduler, {
      materializer: new IntegrationMaterializer(fixture.store, {
        worktree_root: fixture.worktreeRoot,
      }),
      pm_launcher: pm,
    });
    const coordinator = new ArkTeamRunCoordinator(
      fixture.store,
      new TeamCoordinator(fixture.store, scheduler),
      integrationCoordinator,
    );

    const waiting = await coordinator.advance(fixture.runId);
    assert.equal(waiting.run.state, "waiting_user");
    assert.equal(waiting.waiting_approvals, 1);
    const integrationAssignment = waiting.assignments.find(
      (assignment) => assignment.role === "integration_pl",
    );
    assert.equal(integrationAssignment?.team_id, "integration");
    assert.equal(integrationAssignment?.output_contract, "integration_report");
    assert.equal(integrationAssignment?.pending_approval?.approval_id, approvalId);

    await scheduler.decide(
      fixture.runId,
      integrationAssignment?.assignment_id ?? "",
      approvalId,
      "decline",
    );
    const completed = await coordinator.advance(fixture.runId);
    assert.equal(completed.run.state, "completed");
    assert.equal(completed.integration?.state, "local_merged");
    assert.equal(completed.pm_report?.status, "completed");
    assert.equal(completed.remote_action_required, false);
    const finalIntegrationAssignment = completed.assignments.find(
      (assignment) => assignment.role === "integration_pl",
    );
    assert.equal(finalIntegrationAssignment?.correction_count, 1);
    assert.equal(finalIntegrationAssignment?.session_id, "integration-session");
    assert.equal(finalIntegrationAssignment?.report_target.type, "pm");

    const originalHead = await git(fixture.repository, ["rev-parse", "HEAD"]);
    assert.equal(
      originalHead,
      completed.integration?.integration_commit_sha,
    );
    for (const team of fixture.teams) {
      await execFileAsync("git", [
        "-C",
        fixture.repository,
        "merge-base",
        "--is-ancestor",
        team.branch,
        originalHead,
      ]);
    }
    assert.equal(pm.requests.length, 1);
    assert.equal(pm.requests[0]?.resume_session_id, "pm-planning-session");
    assert.equal(pm.requests[0]?.role, "pm");
    assert.equal(pm.requests[0]?.output_contract, "pm_report");
    assert.equal(
      (await fixture.store.getRunContext(fixture.runId)).pm_session?.turn_count,
      2,
    );
  });
});

test("TEST-1104 rejects dirty or incomplete integration evidence", async () => {
  await withIntegratedTeams(async (fixture) => {
    const manager = new IntegrationWorktreeManager({
      root_path: fixture.worktreeRoot,
    });
    const run = await fixture.store.getRun(fixture.runId);
    const prepared = await manager.prepare(run, fixture.teams, "local_merge");
    const integration = await fixture.store.materializeIntegration({
      run_id: fixture.runId,
      strategy: prepared.strategy,
      team_ids: prepared.team_ids,
      working_directory: prepared.working_directory,
      branch: prepared.branch,
      target_branch: prepared.target_branch,
      base_commit: prepared.base_commit,
    });
    await writeFile(
      path.join(prepared.working_directory, "untracked.txt"),
      "dirty\n",
      "utf8",
    );
    const head = await git(prepared.working_directory, ["rev-parse", "HEAD"]);
    await assert.rejects(
      manager.verify(
        fixture.repository,
        integration,
        fixture.teams,
        head,
      ),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "UNSAFE_AGENT_WORKSPACE",
    );
    assert.equal((await fixture.store.getRun(fixture.runId)).state, "integrating");
  });
});

test("TEST-1106 refuses local merge after original checkout drift", async () => {
  await withIntegratedTeams(async (fixture) => {
    const manager = new IntegrationWorktreeManager({
      root_path: fixture.worktreeRoot,
    });
    const run = await fixture.store.getRun(fixture.runId);
    const prepared = await manager.prepare(run, fixture.teams, "local_merge");
    for (const team of fixture.teams) {
      await execFileAsync("git", [
        "-C",
        prepared.working_directory,
        "merge",
        "--no-edit",
        team.branch,
      ]);
    }
    const head = await git(prepared.working_directory, ["rev-parse", "HEAD"]);
    const verified = await manager.verify(
      fixture.repository,
      {
        schema_version: 1,
        run_id: fixture.runId,
        strategy: "local_merge",
        team_ids: prepared.team_ids,
        working_directory: prepared.working_directory,
        branch: prepared.branch,
        target_branch: prepared.target_branch,
        base_commit: prepared.base_commit,
        state: "active",
        assignment_id: null,
        integration_commit_sha: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        verified_at: null,
        merged_at: null,
        revision: 1,
      },
      fixture.teams,
      head,
    );
    await writeFile(path.join(fixture.repository, "user-drift.txt"), "drift\n");
    const before = await git(fixture.repository, ["rev-parse", "HEAD"]);
    await assert.rejects(
      manager.mergeLocal(fixture.repository, {
        schema_version: 1,
        run_id: fixture.runId,
        strategy: "local_merge",
        team_ids: prepared.team_ids,
        working_directory: prepared.working_directory,
        branch: prepared.branch,
        target_branch: prepared.target_branch,
        base_commit: prepared.base_commit,
        state: "verified",
        assignment_id: null,
        integration_commit_sha: verified,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
        merged_at: null,
        revision: 2,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "UNSAFE_AGENT_WORKSPACE",
    );
    assert.equal(await git(fixture.repository, ["rev-parse", "HEAD"]), before);
  });
});

test("TEST-1106 rejects a different original branch even when HEAD is unchanged", async () => {
  await withIntegratedTeams(async (fixture) => {
    const manager = new IntegrationWorktreeManager({
      root_path: fixture.worktreeRoot,
    });
    const run = await fixture.store.getRun(fixture.runId);
    const before = await git(fixture.repository, ["rev-parse", "HEAD"]);
    await execFileAsync("git", [
      "-C",
      fixture.repository,
      "switch",
      "-c",
      "user-moved-branch",
    ]);

    await assert.rejects(
      manager.prepare(run, fixture.teams, "local_merge"),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "UNSAFE_AGENT_WORKSPACE",
    );
    assert.equal(await git(fixture.repository, ["rev-parse", "HEAD"]), before);
    assert.equal(await fixture.store.getIntegration(fixture.runId), null);
  });
});

test("TEST-1108 leaves pull-request integration local and waits for approval", async () => {
  await withIntegratedTeams(
    async (fixture) => {
      const baseHead = await git(fixture.repository, ["rev-parse", "HEAD"]);
      const harness = new IntegrationHarness(fixture.teams);
      const scheduler = new ManagedAssignmentScheduler(fixture.store, {
        session_factory: () => new IntegrationSession(harness),
      });
      const pm = new FinalPmLauncher(
        fixture.teams.map((team) => team.team_id),
      );
      const coordinator = new IntegrationCoordinator(fixture.store, scheduler, {
        materializer: new IntegrationMaterializer(fixture.store, {
          worktree_root: fixture.worktreeRoot,
        }),
        pm_launcher: pm,
      });
      const waitingApproval = await coordinator.advance(fixture.runId);
      const assignment = waitingApproval.assignments.find(
        (candidate) => candidate.role === "integration_pl",
      );
      await scheduler.decide(
        fixture.runId,
        assignment?.assignment_id ?? "",
        approvalId,
        "decline",
      );
      const remote = await coordinator.advance(fixture.runId);
      assert.equal(remote.run.state, "waiting_user");
      assert.equal(remote.integration?.state, "awaiting_remote");
      assert.equal(remote.remote_action_required, true);
      assert.equal(await git(fixture.repository, ["rev-parse", "HEAD"]), baseHead);
      assert.equal(pm.requests.length, 0);
    },
    "pull_request",
  );
});

test("TEST-1105 retries one failed integration PL in a fresh Terra session", async () => {
  await withIntegratedTeams(async (fixture) => {
    let attempts = 0;
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      session_factory: () =>
        new FunctionSession(async (request) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("transient integration failure");
          }
          for (const team of fixture.teams) {
            await execFileAsync("git", [
              "-C",
              request.working_directory,
              "merge",
              "--no-edit",
              team.branch,
            ]);
          }
          return completedIntegration(
            fixture.teams.map((team) => team.team_id),
            await git(request.working_directory, ["rev-parse", "HEAD"]),
          );
        }),
    });
    const coordinator = new IntegrationCoordinator(fixture.store, scheduler, {
      materializer: new IntegrationMaterializer(fixture.store, {
        worktree_root: fixture.worktreeRoot,
      }),
      pm_launcher: new FinalPmLauncher(
        fixture.teams.map((team) => team.team_id),
      ),
    });
    const completed = await coordinator.advance(fixture.runId);
    assert.equal(completed.run.state, "completed");
    assert.equal(attempts, 2);
    assert.equal(
      completed.assignments.find(
        (assignment) => assignment.role === "integration_pl",
      )?.session_attempt_count,
      2,
    );
  });
});

class IntegrationHarness {
  private initial = true;

  constructor(
    readonly teams: Awaited<ReturnType<RunStore["listTeams"]>>["teams"],
  ) {}

  async start(
    request: ApprovalSessionRequest,
  ): Promise<ApprovalSessionUpdate> {
    assert.equal(request.role, "pl");
    assert.equal(request.output_contract, "integration_report");
    if (this.initial) {
      this.initial = false;
      return {
        status: "waiting_user",
        session_id: "integration-session",
        turn_id: "integration-initial",
        role: "pl",
        approval: {
          approval_id: approvalId,
          kind: "command",
          reason: "Merge local team branches",
          command: "git merge team branches",
        },
      };
    }
    assert.equal(request.resume_session_id, "integration-session");
    for (const team of this.teams) {
      await execFileAsync("git", [
        "-C",
        request.working_directory,
        "merge",
        "--no-edit",
        team.branch,
      ]);
    }
    const head = await git(request.working_directory, ["rev-parse", "HEAD"]);
    return completedIntegration(
      this.teams.map((team) => team.team_id),
      head,
    );
  }

  blocked(): ApprovalSessionUpdate {
    const report: IntegrationReport = {
      kind: "integration_report",
      status: "blocked",
      summary: "Integration needs correction",
      team_ids: this.teams.map((team) => team.team_id),
      integration_commit_sha: null,
      verification: [
        {
          name: "cross-team",
          status: "not_run",
          evidence: "waiting for correction",
        },
      ],
      blockers: ["Team branches have not been merged"],
    };
    return {
      ...completedIntegration(report.team_ids, "a".repeat(40)),
      turn_id: "integration-initial",
      final_report: JSON.stringify(report),
      structured_report: report,
    };
  }
}

class IntegrationSession implements ApprovalSessionHandle {
  constructor(private readonly harness: IntegrationHarness) {}

  start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    return this.harness.start(request);
  }

  async decide(
    resolvedApprovalId: string,
    _decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    assert.equal(resolvedApprovalId, approvalId);
    return this.harness.blocked();
  }

  async close(): Promise<void> {}
}

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

class FinalPmLauncher implements PmReviewLauncher {
  readonly requests: ManagedSessionRequest[] = [];

  constructor(private readonly teamIds: string[]) {}

  async run(request: ManagedSessionRequest): Promise<ManagedSessionResult> {
    this.requests.push(request);
    const report: PmReport = {
      kind: "pm_report",
      status: "completed",
      summary: "All teams integrated and verified",
      teams: this.teamIds.map((teamId) => ({
        team_id: teamId,
        status: "completed",
        summary: `${teamId} accepted`,
      })),
      integration_verification: [
        {
          name: "cross-team",
          status: "passed",
          evidence: "integration evidence passed",
        },
      ],
      user_decisions: [],
    };
    return {
      session_id: request.resume_session_id ?? "wrong-session",
      role: "pm",
      agent_name: "ark_pm",
      model: "gpt-5.6-sol",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "read-only",
      requested_approval_policy: "never",
      final_report: JSON.stringify(report),
      structured_report: report,
      usage,
    };
  }
}

function completedIntegration(
  teamIds: string[],
  commitSha: string,
): ApprovalCompletedUpdate {
  const report: IntegrationReport = {
    kind: "integration_report",
    status: "completed",
    summary: "Team branches integrated",
    team_ids: teamIds,
    integration_commit_sha: commitSha,
    verification: [
      {
        name: "cross-team",
        status: "passed",
        evidence: "cross-team checks passed",
      },
    ],
    blockers: [],
  };
  return {
    status: "completed",
    session_id: "integration-session",
    turn_id: `integration-${commitSha.slice(0, 8)}`,
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

async function withIntegratedTeams(
  operation: (fixture: {
    runId: string;
    repository: string;
    worktreeRoot: string;
    store: RunStore;
    teams: Awaited<ReturnType<RunStore["listTeams"]>>["teams"];
  }) => Promise<void>,
  strategy: "local_merge" | "pull_request" = "local_merge",
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-integration-"));
  const repository = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktrees");
  const store = new RunStore({
    root_path: path.join(root, "state"),
    assignment_suffix: assignmentSequence(),
  });
  try {
    await initializeRepository(repository);
    const run = await store.createRun({
      objective: "Integrate two completed teams",
      project_path: repository,
    });
    const pmPlan = plan(strategy);
    await store.recordPmPlan(run.run_id, pmPlan, {
      session_id: "pm-planning-session",
      agent_name: "ark_pm",
      model: "gpt-5.6-sol",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "read-only",
      approval_policy: "never",
      usage,
    });
    const manager = new WorktreeManager({ root_path: worktreeRoot });
    const prepared = await manager.prepare(run, pmPlan);
    await store.materializePlan({
      run_id: run.run_id,
      plan: pmPlan,
      workspaces: prepared,
    });
    for (const [index, workspace] of prepared.entries()) {
      const teamId = workspace.team_id;
      const workerKey = `${teamId}-worker`;
      const plPlan = workerPlan(teamId, workerKey);
      const pl = await store.createAssignment({
        run_id: run.run_id,
        team_id: teamId,
        role: "pl",
        assignment: `Plan ${teamId}`,
        working_directory: workspace.working_directory,
        output_contract: "pl_worker_plan",
      });
      await store.recordAssignmentUpdate(
        run.run_id,
        pl.assignment_id,
        completedRoleUpdate(
          "pl",
          `pl-${teamId}`,
          `plan-${teamId}`,
          plPlan,
        ),
      );
      const worker = await store.createAssignment({
        run_id: run.run_id,
        team_id: teamId,
        role: "worker",
        parent_assignment_id: pl.assignment_id,
        task_key: workerKey,
        assignment: `Implement ${workerKey}`,
        working_directory: workspace.working_directory,
        output_contract: "worker_report",
      });
      const relativeFile = `team-${index + 1}.txt`;
      await writeFile(
        path.join(workspace.working_directory, relativeFile),
        `${teamId}\n`,
        "utf8",
      );
      await execFileAsync("git", [
        "-C",
        workspace.working_directory,
        "add",
        relativeFile,
      ]);
      await execFileAsync("git", [
        "-C",
        workspace.working_directory,
        "commit",
        "-m",
        `${teamId} 결과`,
      ]);
      const commitSha = await git(workspace.working_directory, [
        "rev-parse",
        "HEAD",
      ]);
      const workerResult = workerReport(teamId, workerKey, relativeFile, commitSha);
      await store.recordAssignmentUpdate(
        run.run_id,
        worker.assignment_id,
        completedRoleUpdate(
          "worker",
          `worker-${teamId}`,
          `worker-turn-${teamId}`,
          workerResult,
        ),
      );
      await store.resumeAssignment({
        run_id: run.run_id,
        assignment_id: pl.assignment_id,
        assignment: `Finalize ${teamId}`,
        output_contract: "pl_report",
      });
      const plResult: PlReport = {
        kind: "pl_report",
        team_id: teamId,
        status: "completed",
        summary: `${teamId} complete`,
        worker_reports: [workerResult],
        integration_commit_sha: commitSha,
        verification: [
          {
            name: "team check",
            status: "passed",
            evidence: `${teamId} passed`,
          },
        ],
        blockers: [],
      };
      await store.recordAssignmentUpdate(
        run.run_id,
        pl.assignment_id,
        completedRoleUpdate(
          "pl",
          `pl-${teamId}`,
          `final-${teamId}`,
          plResult,
        ),
      );
      await store.completeTeam(run.run_id, teamId, pl.assignment_id);
    }
    assert.equal((await store.getRun(run.run_id)).state, "integrating");
    await operation({
      runId: run.run_id,
      repository,
      worktreeRoot,
      store,
      teams: (await store.listTeams(run.run_id)).teams,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function completedRoleUpdate(
  role: "pl" | "worker",
  sessionId: string,
  turnId: string,
  report: PlWorkerPlan | WorkerReport | PlReport,
): ApprovalSessionUpdate {
  return {
    status: "completed",
    session_id: sessionId,
    turn_id: turnId,
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
  changedFile: string,
  commitSha: string,
): WorkerReport {
  return {
    kind: "worker_report",
    team_id: teamId,
    worker_key: workerKey,
    status: "completed",
    summary: `${workerKey} complete`,
    changed_files: [changedFile],
    commit_sha: commitSha,
    verification: [
      {
        name: "focused check",
        status: "passed",
        evidence: `${workerKey} passed`,
      },
    ],
    blockers: [],
  };
}

function workerPlan(teamId: string, workerKey: string): PlWorkerPlan {
  return {
    kind: "pl_worker_plan",
    team_id: teamId,
    workers: [
      {
        worker_key: workerKey,
        mission: `Implement ${workerKey}`,
        owned_paths: [`${teamId}.txt`],
        dependencies: [],
        acceptance_criteria: [`${workerKey} complete`],
        verification: [`Verify ${workerKey}`],
        commit_required: true,
      },
    ],
  };
}

function plan(
  strategy: "local_merge" | "pull_request" = "local_merge",
): PmPlan {
  return {
    kind: "pm_plan",
    objective: "Integrate two completed teams",
    teams: ["team-a", "team-b"].map((teamId) => ({
      team_id: teamId,
      mission: `Deliver ${teamId}`,
      owned_paths: [`${teamId}/`],
      dependencies: [],
      acceptance_criteria: [`${teamId} complete`],
      verification: [`Verify ${teamId}`],
      worker_count: 1,
    })),
    integration: {
      strategy,
      acceptance_criteria: ["Both team commits are present"],
      verification: ["Run cross-team checks"],
    },
  };
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

async function git(workingDirectory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", [
    "-C",
    workingDirectory,
    ...args,
  ]);
  return result.stdout.trim();
}
