import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import {
  PlanMaterializer,
  type TeamWorkspaceManager,
} from "../src/plan-materializer.js";
import type { PmPlan } from "../src/role-contracts.js";
import {
  type MaterializePlanInput,
  type MaterializePlanResult,
  RunStore,
} from "../src/state-store.js";
import type { PreparedTeamWorkspace } from "../src/worktree-manager.js";

test("TEST-703 rolls back every prepared worktree when persistence fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-materializer-test-"));
  try {
    const project = path.join(root, "project");
    await mkdir(project);
    const store = new FailingMaterializationStore({
      root_path: path.join(root, "state"),
    });
    const run = await store.createRun({
      objective: "Exercise persistence rollback",
      project_path: project,
    });
    const workspaces = ["team-a", "team-b"].map((teamId) => ({
      run_id: run.run_id,
      team_id: teamId,
      isolation_mode: "git_worktree" as const,
      working_directory: path.join(root, "worktrees", run.run_id, teamId),
      branch: `ark-team/${run.run_id}/${teamId}`,
      target_branch: "main",
      base_commit: "a".repeat(40),
    }));
    const manager = new ScriptedWorkspaceManager(workspaces);
    const materializer = new PlanMaterializer(store, {
      worktree_manager: manager,
    });

    await assert.rejects(
      materializer.apply(run.run_id, planFor("team-a", "team-b")),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "STATE_ROOT_UNAVAILABLE",
    );
    assert.deepEqual(
      manager.cleaned.map((workspace) => workspace.team_id),
      ["team-b", "team-a"],
    );
    assert.equal((await store.getRun(run.run_id)).state, "planning");
    assert.equal((await store.listTeams(run.run_id)).total, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FailingMaterializationStore extends RunStore {
  override async materializePlan(
    _input: MaterializePlanInput,
  ): Promise<MaterializePlanResult> {
    throw new ArkTeamError(
      "STATE_ROOT_UNAVAILABLE",
      "simulated persistence failure",
    );
  }
}

class ScriptedWorkspaceManager implements TeamWorkspaceManager {
  readonly cleaned: PreparedTeamWorkspace[] = [];

  constructor(private readonly workspaces: PreparedTeamWorkspace[]) {}

  async prepare(): Promise<PreparedTeamWorkspace[]> {
    return this.workspaces;
  }

  async cleanup(
    _projectPath: string,
    workspace: PreparedTeamWorkspace,
  ): Promise<void> {
    this.cleaned.push(workspace);
  }
}

function planFor(...teamIds: string[]): PmPlan {
  return {
    kind: "pm_plan",
    objective: "Exercise plan rollback.",
    teams: teamIds.map((teamId) => ({
      team_id: teamId,
      mission: `Deliver ${teamId}.`,
      owned_paths: [`src/${teamId}.ts`],
      dependencies: [],
      acceptance_criteria: [`${teamId} is complete.`],
      verification: [`Verify ${teamId}.`],
      worker_count: 1,
    })),
    integration: {
      strategy: "local_merge",
      acceptance_criteria: ["All teams integrate."],
      verification: ["Run all tests."],
    },
  };
}
