import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
import type {
  IntegrationRecord,
  RemoteActionRecord,
  TeamRecord,
} from "../src/domain.js";
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
import { RemoteActionCoordinator } from "../src/remote-action-coordinator.js";
import type {
  RemoteActionExecutor,
  RemoteExecutionResult,
  RemoteTarget,
} from "../src/remote-action.js";
import { GitHubRemoteActionExecutor } from "../src/remote-action.js";
import { RunStore } from "../src/state-store.js";
import { TeamCoordinator } from "../src/team-coordinator.js";
import {
  IntegrationWorktreeManager,
  WorktreeManager,
} from "../src/worktree-manager.js";
import {
  type FinalWorktreeManager,
  GitFinalWorktreeManager,
  WorktreeCleanupCoordinator,
} from "../src/worktree-cleanup.js";

const execFileAsync = promisify(execFile);
const approvalId = "44444444-4444-4444-8444-444444444444";
const usage = {
  input_tokens: 60,
  cached_input_tokens: 12,
  cache_write_input_tokens: 0,
  output_tokens: 18,
  reasoning_output_tokens: 5,
};

interface IntegrationFixture {
  runId: string;
  repository: string;
  worktreeRoot: string;
  store: RunStore;
  teams: TeamRecord[];
}

test("TEST-1101–TEST-1103, TEST-1105, TEST-1107, and TEST-1108 complete guarded local integration", async () => {
  await withIntegratedTeams(async (fixture) => {
    const harness = new IntegrationHarness(fixture.teams);
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      session_factory: () => new IntegrationSession(harness),
    });
    const pm = new FinalPmLauncher(fixture.teams.map((team) => team.team_id));
    const integrationCoordinator = new IntegrationCoordinator(fixture.store, scheduler, {
      worktree_root: fixture.worktreeRoot,
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
    assert.equal(completed.integration?.state, "cleaned");
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
      await assert.rejects(stat(team.working_directory), isMissing);
    }
    await assert.rejects(
      stat(completed.integration?.working_directory ?? ""),
      isMissing,
    );
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
        remote_action: null,
        cleanup_error: null,
        cleaned_at: null,
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
        remote_action: null,
        cleanup_error: null,
        cleaned_at: null,
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
      const remoteExecutor = new ScriptedRemoteExecutor();
      const coordinator = new IntegrationCoordinator(fixture.store, scheduler, {
        worktree_root: fixture.worktreeRoot,
        materializer: new IntegrationMaterializer(fixture.store, {
          worktree_root: fixture.worktreeRoot,
        }),
        pm_launcher: pm,
        remote_actions: new RemoteActionCoordinator(fixture.store, {
          executor: remoteExecutor,
        }),
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
      assert.equal(remote.integration?.remote_action?.status, "pending");
      assert.equal(remote.integration?.remote_action?.repository, "owner/repo");
      assert.equal(await git(fixture.repository, ["rev-parse", "HEAD"]), baseHead);
      assert.equal(pm.requests.length, 0);
      assert.equal(remoteExecutor.inspectCount, 1);
      assert.equal(remoteExecutor.executeCount, 0);
    },
    "pull_request",
  );
});

test("TEST-1201 and TEST-1203 require one exact remote approval and preserve artifacts on cancellation", async () => {
  await withIntegratedTeams(
    async (fixture) => {
      const executor = new ScriptedRemoteExecutor();
      const { scheduler, coordinator } = pullRequestCoordinator(
        fixture,
        executor,
      );
      const pending = await advanceToRemoteRequest(
        fixture.runId,
        scheduler,
        coordinator,
      );
      const requestId =
        pending.integration?.remote_action?.request_id ?? "";
      const cancelled = await coordinator.decideRemote(
        fixture.runId,
        requestId,
        "cancel_run",
      );
      assert.equal(cancelled.run.state, "cancelled");
      assert.equal(
        cancelled.integration?.remote_action?.status,
        "cancelled",
      );
      assert.equal(executor.executeCount, 0);
      for (const team of fixture.teams) {
        assert.equal((await stat(team.working_directory)).isDirectory(), true);
      }
      await assert.rejects(
        coordinator.decideRemote(
          fixture.runId,
          requestId,
          "approve_once",
        ),
        (error: unknown) =>
          error instanceof ArkTeamError &&
          error.code === "INVALID_INPUT",
      );
      await fixture.store.resumeRun(
        fixture.runId,
        "Resume cancelled remote handoff",
      );
      const renewed = await coordinator.advance(fixture.runId);
      assert.equal(renewed.run.state, "waiting_user");
      assert.equal(renewed.integration?.remote_action?.status, "pending");
      assert.notEqual(
        renewed.integration?.remote_action?.request_id,
        requestId,
      );
      assert.equal(executor.executeCount, 0);
    },
    "pull_request",
  );
});

test("TEST-1203 and TEST-1205 execute approved PR work, review it, and clean worktrees", async () => {
  await withIntegratedTeams(
    async (fixture) => {
      const baseHead = await git(fixture.repository, ["rev-parse", "HEAD"]);
      const executor = new ScriptedRemoteExecutor();
      const { scheduler, coordinator, pm } = pullRequestCoordinator(
        fixture,
        executor,
      );
      const pending = await advanceToRemoteRequest(
        fixture.runId,
        scheduler,
        coordinator,
      );
      const completed = await coordinator.decideRemote(
        fixture.runId,
        pending.integration?.remote_action?.request_id ?? "",
        "approve_once",
      );
      assert.equal(completed.run.state, "completed");
      assert.equal(completed.integration?.state, "cleaned");
      assert.equal(
        completed.integration?.remote_action?.pull_request_url,
        "https://github.com/owner/repo/pull/42",
      );
      assert.equal(executor.executeCount, 1);
      assert.equal(pm.requests.length, 1);
      assert.equal(await git(fixture.repository, ["rev-parse", "HEAD"]), baseHead);
      for (const team of fixture.teams) {
        await assert.rejects(stat(team.working_directory), isMissing);
        assert.match(
          await git(fixture.repository, [
            "rev-parse",
            `refs/heads/${team.branch}`,
          ]),
          /^[0-9a-f]{40,64}$/,
        );
      }
      await assert.rejects(
        stat(completed.integration?.working_directory ?? ""),
        isMissing,
      );
    },
    "pull_request",
  );
});

test("TEST-1204 bounds approved remote retries and issues a fresh request", async () => {
  await withIntegratedTeams(
    async (fixture) => {
      const executor = new ScriptedRemoteExecutor([
        new ArkTeamError("REMOTE_ACTION_FAILED", "failure one"),
        new ArkTeamError("REMOTE_ACTION_FAILED", "failure two"),
        new ArkTeamError("REMOTE_ACTION_FAILED", "failure three"),
        { pull_request_url: "https://github.com/owner/repo/pull/42" },
      ]);
      const { scheduler, coordinator } = pullRequestCoordinator(
        fixture,
        executor,
      );
      const pending = await advanceToRemoteRequest(
        fixture.runId,
        scheduler,
        coordinator,
      );
      const firstRequest =
        pending.integration?.remote_action?.request_id ?? "";
      const exhausted = await coordinator.decideRemote(
        fixture.runId,
        firstRequest,
        "approve_once",
      );
      assert.equal(exhausted.run.state, "waiting_user");
      assert.equal(exhausted.integration?.state, "awaiting_remote");
      assert.equal(executor.executeCount, 3);
      const freshRequest =
        exhausted.integration?.remote_action?.request_id ?? "";
      assert.notEqual(freshRequest, firstRequest);
      assert.equal(
        exhausted.integration?.remote_action?.last_error,
        "failure three",
      );

      const completed = await coordinator.decideRemote(
        fixture.runId,
        freshRequest,
        "approve_once",
      );
      assert.equal(completed.run.state, "completed");
      assert.equal(executor.executeCount, 4);
    },
    "pull_request",
  );
});

test("TEST-1204 resumes an approved exact remote tuple after controller restart", async () => {
  await withIntegratedTeams(
    async (fixture) => {
      const executor = new CrashThenAdoptRemoteExecutor();
      const { scheduler, coordinator } = pullRequestCoordinator(
        fixture,
        executor,
      );
      const pending = await advanceToRemoteRequest(
        fixture.runId,
        scheduler,
        coordinator,
      );
      const requestId =
        pending.integration?.remote_action?.request_id ?? "";
      await assert.rejects(
        coordinator.decideRemote(
          fixture.runId,
          requestId,
          "approve_once",
        ),
        /simulated controller crash after remote side effect/,
      );
      const interrupted = await fixture.store.getIntegration(fixture.runId);
      assert.equal(interrupted?.state, "remote_executing");
      assert.equal(interrupted?.remote_action?.status, "executing");
      assert.equal(interrupted?.remote_action?.attempt_count, 1);

      const recovered = new IntegrationCoordinator(
        fixture.store,
        new ManagedAssignmentScheduler(fixture.store),
        {
          worktree_root: fixture.worktreeRoot,
          remote_actions: new RemoteActionCoordinator(fixture.store, {
            executor,
          }),
          pm_launcher: new FinalPmLauncher(
            fixture.teams.map((team) => team.team_id),
          ),
        },
      );
      const completed = await recovered.advance(fixture.runId);
      assert.equal(completed.run.state, "completed");
      assert.equal(executor.executeCount, 2);
      assert.equal(
        completed.integration?.remote_action?.request_id,
        requestId,
      );
    },
    "pull_request",
  );
});

test("TEST-1202 refuses an unavailable remote before creating an approval request", async () => {
  await withIntegratedTeams(
    async (fixture) => {
      const executor = new ScriptedRemoteExecutor([], true);
      const { scheduler, coordinator } = pullRequestCoordinator(
        fixture,
        executor,
      );
      const waiting = await coordinator.advance(fixture.runId);
      const assignment = waiting.assignments.find(
        (candidate) => candidate.role === "integration_pl",
      );
      await scheduler.decide(
        fixture.runId,
        assignment?.assignment_id ?? "",
        approvalId,
        "decline",
      );
      await assert.rejects(
        coordinator.advance(fixture.runId),
        (error: unknown) =>
          error instanceof ArkTeamError &&
          error.code === "REMOTE_ACTION_UNAVAILABLE",
      );
      const integration = await fixture.store.getIntegration(fixture.runId);
      assert.equal(integration?.state, "verified");
      assert.equal(integration?.remote_action, null);
      assert.equal(executor.executeCount, 0);
    },
    "pull_request",
  );
});

test("TEST-1202 detects a repository without a remote before invoking GitHub", async () => {
  await withIntegratedTeams(
    async (fixture) => {
      const manager = new IntegrationWorktreeManager({
        root_path: fixture.worktreeRoot,
      });
      const prepared = await manager.prepare(
        await fixture.store.getRun(fixture.runId),
        fixture.teams,
        "pull_request",
      );
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
      const integration: IntegrationRecord = {
        schema_version: 1,
        run_id: fixture.runId,
        strategy: "pull_request",
        team_ids: fixture.teams.map((team) => team.team_id),
        working_directory: prepared.working_directory,
        branch: prepared.branch,
        target_branch: prepared.target_branch,
        base_commit: prepared.base_commit,
        state: "verified",
        assignment_id: null,
        integration_commit_sha: head,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
        merged_at: null,
        remote_action: null,
        cleanup_error: null,
        cleaned_at: null,
        revision: 1,
      };
      await assert.rejects(
        new GitHubRemoteActionExecutor().inspect(
          fixture.repository,
          integration,
        ),
        (error: unknown) =>
          error instanceof ArkTeamError &&
          error.code === "REMOTE_ACTION_UNAVAILABLE",
      );
    },
    "pull_request",
  );
});

test("TEST-1206 resumes cleanup after physical removal precedes persistence", async () => {
  await withIntegratedTeams(async (fixture) => {
    const harness = new IntegrationHarness(fixture.teams);
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      session_factory: () => new IntegrationSession(harness),
    });
    const partial = new CrashAfterFirstRemovalManager(
      new GitFinalWorktreeManager(fixture.worktreeRoot),
    );
    const coordinator = new IntegrationCoordinator(fixture.store, scheduler, {
      worktree_root: fixture.worktreeRoot,
      materializer: new IntegrationMaterializer(fixture.store, {
        worktree_root: fixture.worktreeRoot,
      }),
      pm_launcher: new FinalPmLauncher(
        fixture.teams.map((team) => team.team_id),
      ),
      cleanup: new WorktreeCleanupCoordinator(fixture.store, {
        manager: partial,
      }),
    });
    const waiting = await coordinator.advance(fixture.runId);
    const assignment = waiting.assignments.find(
      (candidate) => candidate.role === "integration_pl",
    );
    await scheduler.decide(
      fixture.runId,
      assignment?.assignment_id ?? "",
      approvalId,
      "decline",
    );
    await assert.rejects(
      coordinator.advance(fixture.runId),
      /simulated cleanup persistence crash/,
    );
    assert.equal((await fixture.store.getRun(fixture.runId)).state, "cleaning");
    await assert.rejects(
      stat(fixture.teams[0]?.working_directory ?? ""),
      isMissing,
    );
    assert.equal(
      (await fixture.store.listTeams(fixture.runId)).teams[0]?.state,
      "integrated",
    );

    const recovered = new IntegrationCoordinator(
      fixture.store,
      new ManagedAssignmentScheduler(fixture.store),
      {
        cleanup: new WorktreeCleanupCoordinator(fixture.store, {
          worktree_root: fixture.worktreeRoot,
        }),
      },
    );
    const completed = await recovered.advance(fixture.runId);
    assert.equal(completed.run.state, "completed");
    assert.deepEqual(
      completed.teams.map((team) => team.state),
      ["cleaned", "cleaned"],
    );
  });
});

test("TEST-1206 refuses dirty worktree cleanup without completing the run", async () => {
  await withIntegratedTeams(async (fixture) => {
    const harness = new IntegrationHarness(fixture.teams);
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      session_factory: () => new IntegrationSession(harness),
    });
    const coordinator = new IntegrationCoordinator(fixture.store, scheduler, {
      worktree_root: fixture.worktreeRoot,
      materializer: new IntegrationMaterializer(fixture.store, {
        worktree_root: fixture.worktreeRoot,
      }),
      pm_launcher: new FinalPmLauncher(
        fixture.teams.map((team) => team.team_id),
      ),
      cleanup: new WorktreeCleanupCoordinator(fixture.store, {
        manager: new DirtyFirstTeamManager(
          new GitFinalWorktreeManager(fixture.worktreeRoot),
        ),
      }),
    });
    const waiting = await coordinator.advance(fixture.runId);
    const assignment = waiting.assignments.find(
      (candidate) => candidate.role === "integration_pl",
    );
    await scheduler.decide(
      fixture.runId,
      assignment?.assignment_id ?? "",
      approvalId,
      "decline",
    );
    await assert.rejects(
      coordinator.advance(fixture.runId),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "UNSAFE_AGENT_WORKSPACE",
    );
    assert.equal((await fixture.store.getRun(fixture.runId)).state, "cleaning");
    assert.equal(
      (await fixture.store.listTeams(fixture.runId)).teams[0]?.state,
      "integrated",
    );
    assert.equal(
      (await stat(fixture.teams[0]?.working_directory ?? "")).isDirectory(),
      true,
    );
    assert.equal(
      (await fixture.store.getLogs(fixture.runId)).events.some(
        (event) => event.event_type === "run.completed",
      ),
      false,
    );
    assert.match(
      (await fixture.store.getIntegration(fixture.runId))?.cleanup_error ?? "",
      /dirty or moved worktree/,
    );
    assert.equal(
      (await fixture.store.getLogs(fixture.runId)).events.some(
        (event) => event.event_type === "integration.cleanup_failed",
      ),
      true,
    );
  });
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
      worktree_root: fixture.worktreeRoot,
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

function pullRequestCoordinator(
  fixture: IntegrationFixture,
  executor: RemoteActionExecutor,
) {
  const harness = new IntegrationHarness(fixture.teams);
  const scheduler = new ManagedAssignmentScheduler(fixture.store, {
    session_factory: () => new IntegrationSession(harness),
  });
  const pm = new FinalPmLauncher(
    fixture.teams.map((team) => team.team_id),
  );
  const coordinator = new IntegrationCoordinator(fixture.store, scheduler, {
    worktree_root: fixture.worktreeRoot,
    materializer: new IntegrationMaterializer(fixture.store, {
      worktree_root: fixture.worktreeRoot,
    }),
    pm_launcher: pm,
    remote_actions: new RemoteActionCoordinator(fixture.store, {
      executor,
    }),
  });
  return { scheduler, coordinator, pm };
}

async function advanceToRemoteRequest(
  runId: string,
  scheduler: ManagedAssignmentScheduler,
  coordinator: IntegrationCoordinator,
) {
  const waiting = await coordinator.advance(runId);
  const assignment = waiting.assignments.find(
    (candidate) => candidate.role === "integration_pl",
  );
  await scheduler.decide(
    runId,
    assignment?.assignment_id ?? "",
    approvalId,
    "decline",
  );
  const pending = await coordinator.advance(runId);
  assert.equal(pending.run.state, "waiting_user");
  assert.equal(pending.integration?.remote_action?.status, "pending");
  return pending;
}

class ScriptedRemoteExecutor implements RemoteActionExecutor {
  inspectCount = 0;
  executeCount = 0;

  constructor(
    private readonly outcomes: Array<
      RemoteExecutionResult | ArkTeamError
    > = [],
    private readonly unavailable = false,
  ) {}

  async inspect(
    _projectPath: string,
    integration: IntegrationRecord,
  ): Promise<RemoteTarget> {
    this.inspectCount += 1;
    assert.equal(integration.state, "verified");
    if (this.unavailable) {
      throw new ArkTeamError(
        "REMOTE_ACTION_UNAVAILABLE",
        "simulated unsupported remote",
      );
    }
    return {
      remote_name: "origin",
      repository: "owner/repo",
    };
  }

  async execute(
    _projectPath: string,
    integration: IntegrationRecord,
    action: RemoteActionRecord,
  ): Promise<RemoteExecutionResult> {
    this.executeCount += 1;
    assert.equal(integration.state, "remote_executing");
    assert.equal(action.status, "executing");
    assert.equal(action.commit_sha, integration.integration_commit_sha);
    const outcome = this.outcomes.shift();
    if (outcome instanceof ArkTeamError) {
      throw outcome;
    }
    return (
      outcome ?? {
        pull_request_url: "https://github.com/owner/repo/pull/42",
      }
    );
  }
}

class CrashThenAdoptRemoteExecutor implements RemoteActionExecutor {
  executeCount = 0;

  async inspect(): Promise<RemoteTarget> {
    return {
      remote_name: "origin",
      repository: "owner/repo",
    };
  }

  async execute(): Promise<RemoteExecutionResult> {
    this.executeCount += 1;
    if (this.executeCount === 1) {
      throw new Error("simulated controller crash after remote side effect");
    }
    return {
      pull_request_url: "https://github.com/owner/repo/pull/42",
    };
  }
}

class CrashAfterFirstRemovalManager implements FinalWorktreeManager {
  private crashed = false;

  constructor(private readonly delegate: FinalWorktreeManager) {}

  async cleanupTeam(
    projectPath: string,
    integration: IntegrationRecord,
    team: TeamRecord,
  ): Promise<void> {
    await this.delegate.cleanupTeam(projectPath, integration, team);
    if (!this.crashed) {
      this.crashed = true;
      throw new Error("simulated cleanup persistence crash");
    }
  }

  cleanupIntegration(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<void> {
    return this.delegate.cleanupIntegration(projectPath, integration);
  }
}

class DirtyFirstTeamManager implements FinalWorktreeManager {
  private dirtied = false;

  constructor(private readonly delegate: FinalWorktreeManager) {}

  async cleanupTeam(
    projectPath: string,
    integration: IntegrationRecord,
    team: TeamRecord,
  ): Promise<void> {
    if (!this.dirtied) {
      this.dirtied = true;
      await writeFile(
        path.join(team.working_directory, "cleanup-drift.txt"),
        "user drift\n",
        "utf8",
      );
    }
    await this.delegate.cleanupTeam(projectPath, integration, team);
  }

  cleanupIntegration(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<void> {
    return this.delegate.cleanupIntegration(projectPath, integration);
  }
}

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
  operation: (fixture: IntegrationFixture) => Promise<void>,
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

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
