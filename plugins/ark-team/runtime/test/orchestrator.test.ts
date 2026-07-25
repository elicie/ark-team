import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Usage } from "@openai/codex-sdk";

import { ArkTeamError } from "../src/errors.js";
import type {
  ManagedSessionRequest,
  ManagedSessionResult,
} from "../src/managed-session.js";
import {
  ArkTeamOrchestrator,
  buildPmPlanningAssignment,
  type ManagedPmLauncher,
  type TeamExecutionCoordinator,
} from "../src/orchestrator.js";
import {
  PlanMaterializer,
  type TeamWorkspaceManager,
} from "../src/plan-materializer.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import type { PmPlan } from "../src/role-contracts.js";
import { RunStore } from "../src/state-store.js";
import type { PreparedTeamWorkspace } from "../src/worktree-manager.js";

const usage: Usage = {
  input_tokens: 300,
  cached_input_tokens: 40,
  cache_write_input_tokens: 0,
  output_tokens: 80,
  reasoning_output_tokens: 30,
};

test("TEST-801 and TEST-802 execute the exact PM plan and persist usage only", async () => {
  const fixture = await createFixture("success");
  try {
    const plan = validPlan();
    const launcher = new ScriptedPmLauncher(pmResult(plan));
    const manager = new FakeWorkspaceManager(fixture.worktrees);
    const orchestrator = new ArkTeamOrchestrator(fixture.store, {
      pm_launcher: launcher,
      materializer: new PlanMaterializer(fixture.store, {
        worktree_manager: manager,
      }),
      coordinator: new SnapshotCoordinator(fixture.store),
    });

    const result = await orchestrator.execute({
      objective: "Deliver the requested bounded feature",
      project_path: fixture.project,
    });

    assert.equal(result.run.state, "staffing");
    assert.equal(result.run.team_count, 1);
    assert.equal(result.pm_session.session_id, "pm-session-1");
    assert.deepEqual(result.pm_session.usage, usage);
    assert.equal(result.integration, null);
    assert.equal(result.pm_report, null);
    assert.equal(result.remote_action_required, false);
    assert.equal(result.teams[0]?.team_id, "team-a");
    assert.equal(launcher.requests.length, 1);
    assert.deepEqual(
      {
        role: launcher.requests[0]?.role,
        cwd: launcher.requests[0]?.working_directory,
        output_contract: launcher.requests[0]?.output_contract,
      },
      {
        role: "pm",
        cwd: fixture.project,
        output_contract: "pm_plan",
      },
    );
    assert.match(
      launcher.requests[0]?.assignment ?? "",
      /User objective: Deliver the requested bounded feature/,
    );
    assert.match(launcher.requests[0]?.assignment ?? "", /one to four teams/);
    assert.match(launcher.requests[0]?.assignment ?? "", /one to five workers/);
    assert.match(launcher.requests[0]?.assignment ?? "", /Do not edit files/);

    const events = (await fixture.store.getLogs(result.run.run_id)).events;
    const planned = events.find((event) => event.event_type === "pm.planned");
    assert.equal(planned?.agent_role, "pm");
    assert.deepEqual(planned?.usage, usage);
    const raw = await readFile(
      path.join(fixture.state, result.run.run_id, "run.json"),
      "utf8",
    );
    assert.equal(raw.includes("PRIVATE_PM_FINAL_JSON"), false);
    assert.equal(raw.includes('"private_reasoning":'), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TEST-803 marks PM execution and protocol failures as durable run failures", async () => {
  const fixture = await createFixture("pm-failure");
  try {
    const failed = new ArkTeamOrchestrator(fixture.store, {
      pm_launcher: new ScriptedPmLauncher(
        new ArkTeamError("AGENT_SESSION_FAILED", "simulated PM failure"),
      ),
      materializer: new PlanMaterializer(fixture.store, {
        worktree_manager: new FakeWorkspaceManager(fixture.worktrees),
      }),
    });
    await assert.rejects(
      failed.execute({
        objective: "Fail PM execution",
        project_path: fixture.project,
      }),
      sessionFailure,
    );

    const invalid = new ArkTeamOrchestrator(fixture.store, {
      pm_launcher: new ScriptedPmLauncher({
        ...pmResult(validPlan()),
        structured_report: {
          kind: "worker_report",
          team_id: "team-a",
          worker_key: "worker-a",
          status: "completed",
          summary: "wrong role",
          changed_files: [],
          commit_sha: null,
          verification: [
            { name: "none", status: "not_run", evidence: "wrong contract" },
          ],
          blockers: [],
        },
      }),
      materializer: new PlanMaterializer(fixture.store, {
        worktree_manager: new FakeWorkspaceManager(fixture.worktrees),
      }),
    });
    await assert.rejects(
      invalid.execute({
        objective: "Fail PM protocol",
        project_path: fixture.project,
      }),
      protocolFailure,
    );

    const runs = await fixture.store.listRuns();
    assert.equal(runs.total, 2);
    assert.deepEqual(
      runs.runs.map((run) => run.state),
      ["failed", "failed"],
    );
    for (const run of runs.runs) {
      assert.equal((await fixture.store.listTeams(run.run_id)).total, 0);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TEST-804 preserves a PM plan when worktree materialization must be retried", async () => {
  const fixture = await createFixture("retry");
  try {
    const plan = validPlan();
    const orchestrator = new ArkTeamOrchestrator(fixture.store, {
      pm_launcher: new ScriptedPmLauncher(pmResult(plan)),
      materializer: new PlanMaterializer(fixture.store, {
        worktree_manager: new FakeWorkspaceManager(
          fixture.worktrees,
          new ArkTeamError(
            "WORKSPACE_PREPARATION_FAILED",
            "simulated workspace failure",
          ),
        ),
      }),
    });
    await assert.rejects(
      orchestrator.execute({
        objective: "Retry plan materialization",
        project_path: fixture.project,
      }),
      workspaceFailure,
    );

    const run = (await fixture.store.listRuns()).runs[0];
    assert.equal(run?.state, "planning");
    assert.equal(run?.team_count, 0);
    assert.equal((await fixture.store.listTeams(run?.run_id ?? "")).total, 0);
    const raw = JSON.parse(
      await readFile(
        path.join(fixture.state, run?.run_id ?? "", "run.json"),
        "utf8",
      ),
    ) as {
      plan?: { kind?: string };
      pm_session?: { session_id?: string; usage?: Usage };
      teams?: unknown[];
    };
    assert.equal(raw.plan?.kind, "pm_plan");
    assert.equal(raw.pm_session?.session_id, "pm-session-1");
    assert.deepEqual(raw.pm_session?.usage, usage);
    assert.deepEqual(raw.teams, []);

    const retry = new PlanMaterializer(fixture.store, {
      worktree_manager: new FakeWorkspaceManager(fixture.worktrees),
    });
    const recovered = await retry.apply(run?.run_id ?? "", plan);
    assert.equal(recovered.run.state, "staffing");
    assert.equal(recovered.teams.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TEST-1403 enforces the snapshotted project plan contract", async () => {
  const fixture = await createFixture("configured");
  try {
    const config = structuredClone(DEFAULT_PROJECT_CONFIG);
    config.organization.max_teams = 1;
    config.organization.min_workers_per_team = 2;
    config.organization.max_workers_per_team = 2;
    config.execution.agent_timeout_minutes = 45;
    config.verification.commands = [
      {
        argv: ["npm", "test"],
        cwd: ".",
      },
    ];
    const configSource = path.join(
      fixture.project,
      ".codex",
      "team-orchestrator.toml",
    );
    const launcher = new ScriptedPmLauncher(pmResult(validPlan()));
    const orchestrator = new ArkTeamOrchestrator(fixture.store, {
      pm_launcher: launcher,
      materializer: new PlanMaterializer(fixture.store, {
        worktree_manager: new FakeWorkspaceManager(fixture.worktrees),
      }),
      coordinator: new SnapshotCoordinator(fixture.store),
      config_loader: async () => ({
        config,
        source_path: configSource,
      }),
    });
    const result = await orchestrator.execute({
      objective: "Use project-specific bounds",
      project_path: fixture.project,
    });

    assert.deepEqual(result.run.project_config, config);
    assert.equal(result.run.project_config_source, configSource);
    assert.equal(launcher.requests[0]?.timeout_ms, 45 * 60_000);
    assert.match(launcher.requests[0]?.assignment ?? "", /one to one teams/);
    assert.match(
      launcher.requests[0]?.assignment ?? "",
      /two to two workers/,
    );
    assert.match(
      launcher.requests[0]?.assignment ?? "",
      /"argv":\["npm","test"\]/,
    );

    const invalidPlan = validPlan();
    invalidPlan.teams[0] = {
      ...invalidPlan.teams[0]!,
      worker_count: 3,
    };
    const rejected = new ArkTeamOrchestrator(fixture.store, {
      pm_launcher: new ScriptedPmLauncher(pmResult(invalidPlan)),
      materializer: new PlanMaterializer(fixture.store, {
        worktree_manager: new FakeWorkspaceManager(fixture.worktrees),
      }),
      config_loader: async () => ({
        config,
        source_path: configSource,
      }),
    });
    await assert.rejects(
      rejected.execute({
        objective: "Reject an oversized PM plan",
        project_path: fixture.project,
      }),
      protocolFailure,
    );
    assert.equal((await fixture.store.listRuns()).runs[0]?.state, "failed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TEST-802 PM assignment builder remains management-only", () => {
  const assignment = buildPmPlanningAssignment({
    schema_version: 1,
    run_id: "ark-20260724t000000z-abc123",
    objective: "Plan safely",
    project_path: "/tmp/project",
    state: "planning",
    resume_state: null,
    created_at: "2026-07-24T00:00:00.000Z",
    updated_at: "2026-07-24T00:00:00.000Z",
    revision: 1,
    event_count: 1,
    assignment_count: 0,
    team_count: 0,
  });
  assert.match(assignment, /strict pm_plan/);
  assert.match(assignment, /read-only/);
  assert.match(assignment, /Do not edit files/);
  assert.match(assignment, /Do not .*spawn agents/);
});

class ScriptedPmLauncher implements ManagedPmLauncher {
  readonly requests: ManagedSessionRequest[] = [];

  constructor(
    private readonly outcome: ManagedSessionResult | ArkTeamError,
  ) {}

  async run(request: ManagedSessionRequest): Promise<ManagedSessionResult> {
    this.requests.push(request);
    if (this.outcome instanceof ArkTeamError) {
      throw this.outcome;
    }
    return this.outcome;
  }
}

class SnapshotCoordinator implements TeamExecutionCoordinator {
  constructor(private readonly store: RunStore) {}

  async advance(runId: string) {
    return {
      run: await this.store.getRun(runId),
      teams: (await this.store.listTeams(runId)).teams,
      assignments: (await this.store.listAssignments(runId)).assignments,
      progressed: false,
      waiting_approvals: 0,
      waiting_retries: 0,
    };
  }
}

class FakeWorkspaceManager implements TeamWorkspaceManager {
  constructor(
    private readonly root: string,
    private readonly failure?: ArkTeamError,
  ) {}

  async prepare(
    run: { run_id: string },
    plan: PmPlan,
  ): Promise<PreparedTeamWorkspace[]> {
    if (this.failure) {
      throw this.failure;
    }
    return plan.teams.map((team) => ({
      run_id: run.run_id,
      team_id: team.team_id,
      isolation_mode: "git_worktree",
      working_directory: path.join(this.root, run.run_id, team.team_id),
      branch: `ark-team/${run.run_id}/${team.team_id}`,
      target_branch: "main",
      base_commit: "a".repeat(40),
    }));
  }

  async cleanup(): Promise<void> {}
}

function pmResult(plan: PmPlan): ManagedSessionResult {
  return {
    session_id: "pm-session-1",
    role: "pm",
    agent_name: "ark_pm",
    model: "gpt-5.6-sol",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "read-only",
    requested_approval_policy: "never",
    final_report: "PRIVATE_PM_FINAL_JSON",
    structured_report: plan,
    usage,
  };
}

function validPlan(): PmPlan {
  return {
    kind: "pm_plan",
    objective: "Deliver the bounded feature.",
    teams: [
      {
        team_id: "team-a",
        mission: "Implement the bounded feature.",
        owned_paths: ["src/feature.ts"],
        dependencies: [],
        acceptance_criteria: ["The behavior is implemented."],
        verification: ["Run focused tests."],
        worker_count: 2,
      },
    ],
    integration: {
      strategy: "local_merge",
      acceptance_criteria: ["The result integrates cleanly."],
      verification: ["Run all tests."],
    },
  };
}

async function createFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `ark-team-orchestrator-${name}-`));
  const project = path.join(root, "project");
  const state = path.join(root, "state");
  await mkdir(project);
  return {
    root,
    project,
    state,
    worktrees: path.join(root, "worktrees"),
    store: new RunStore({ root_path: state }),
  };
}

function sessionFailure(error: unknown): boolean {
  return (
    error instanceof ArkTeamError && error.code === "AGENT_SESSION_FAILED"
  );
}

function protocolFailure(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    error.code === "AGENT_SESSION_PROTOCOL_ERROR"
  );
}

function workspaceFailure(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    error.code === "WORKSPACE_PREPARATION_FAILED"
  );
}
