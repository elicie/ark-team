import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { ArkTeamError } from "../src/errors.js";
import type { PmPlan } from "../src/role-contracts.js";
import { RunStore } from "../src/state-store.js";
import {
  resolveWorktreeRoot,
  WorktreeManager,
} from "../src/worktree-manager.js";

const execFileAsync = promisify(execFile);

test("TEST-701 prepares isolated worktrees with distinct preserved branches", async () => {
  const fixture = await createFixture("prepare");
  try {
    const run = await fixture.store.createRun({
      objective: "Prepare two teams",
      project_path: fixture.project,
    });
    const manager = new WorktreeManager({ root_path: fixture.worktrees });
    const prepared = await manager.prepare(run, planFor("team-a", "team-b"));
    const baseCommit = await gitStdout(fixture.project, ["rev-parse", "HEAD"]);

    assert.equal(prepared.length, 2);
    assert.deepEqual(
      prepared.map((workspace) => workspace.base_commit),
      [baseCommit, baseCommit],
    );
    assert.deepEqual(
      prepared.map((workspace) => workspace.target_branch),
      ["main", "main"],
    );
    assert.notEqual(prepared[0]?.branch, prepared[1]?.branch);
    for (const workspace of prepared) {
      assert.equal((await stat(path.join(workspace.working_directory, ".git"))).isFile(), true);
      assert.equal(
        await gitStdout(workspace.working_directory, [
          "rev-parse",
          "--show-toplevel",
        ]),
        workspace.working_directory,
      );
      assert.equal(await branchExists(fixture.project, workspace.branch), true);
    }

    for (const workspace of [...prepared].reverse()) {
      await manager.cleanup(fixture.project, workspace);
      await assert.rejects(stat(workspace.working_directory), isMissing);
      assert.equal(await branchExists(fixture.project, workspace.branch), true);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TEST-702 rejects unsafe repositories, roots, paths, and branches", async () => {
  const nonGitRoot = await mkdtemp(path.join(tmpdir(), "ark-team-worktree-nongit-"));
  try {
    const nonGitProject = path.join(nonGitRoot, "project");
    await mkdir(nonGitProject);
    const store = new RunStore({ root_path: path.join(nonGitRoot, "state") });
    const run = await store.createRun({
      objective: "Reject non Git",
      project_path: nonGitProject,
    });
    await assert.rejects(
      new WorktreeManager({
        root_path: path.join(nonGitRoot, "worktrees"),
      }).prepare(run, planFor("team-a")),
      unsafeWorkspace,
    );
  } finally {
    await rm(nonGitRoot, { recursive: true, force: true });
  }

  const fixture = await createFixture("unsafe");
  try {
    const dirtyRun = await fixture.store.createRun({
      objective: "Reject dirty Git",
      project_path: fixture.project,
    });
    await writeFile(path.join(fixture.project, "dirty.txt"), "dirty\n", "utf8");
    await assert.rejects(
      new WorktreeManager({ root_path: fixture.worktrees }).prepare(
        dirtyRun,
        planFor("team-a"),
      ),
      unsafeWorkspace,
    );
    await rm(path.join(fixture.project, "dirty.txt"));

    const nested = path.join(fixture.project, "nested");
    await mkdir(nested);
    await git(fixture.project, ["add", "nested"]);
    await git(fixture.project, ["commit", "--allow-empty", "-m", "nested"]);
    const nestedRun = await fixture.store.createRun({
      objective: "Reject nested project path",
      project_path: nested,
    });
    await assert.rejects(
      new WorktreeManager({ root_path: fixture.worktrees }).prepare(
        nestedRun,
        planFor("team-b"),
      ),
      unsafeWorkspace,
    );

    const rootRun = await fixture.store.createRun({
      objective: "Reject worktrees inside project",
      project_path: fixture.project,
    });
    await assert.rejects(
      new WorktreeManager({
        root_path: path.join(fixture.project, ".managed-worktrees"),
      }).prepare(rootRun, planFor("team-c")),
      unsafeWorkspace,
    );

    const target = path.join(fixture.worktrees, rootRun.run_id, "team-d");
    await mkdir(target, { recursive: true });
    await assert.rejects(
      new WorktreeManager({ root_path: fixture.worktrees }).prepare(
        rootRun,
        planFor("team-d"),
      ),
      workspaceFailure,
    );

    const collisionRun = await fixture.store.createRun({
      objective: "Reject branch collision",
      project_path: fixture.project,
    });
    const collisionBranch = `ark-team/${collisionRun.run_id}/team-e`;
    await git(fixture.project, ["branch", collisionBranch]);
    await assert.rejects(
      new WorktreeManager({ root_path: fixture.worktrees }).prepare(
        collisionRun,
        planFor("team-e"),
      ),
      workspaceFailure,
    );

    const movedRun = await fixture.store.createRun({
      objective: "Reject moved registered worktree cleanup",
      project_path: fixture.project,
    });
    const manager = new WorktreeManager({ root_path: fixture.worktrees });
    const [movedWorkspace] = await manager.prepare(
      movedRun,
      planFor("team-f"),
    );
    assert.notEqual(movedWorkspace, undefined);
    const movedPath = path.join(
      fixture.worktrees,
      movedRun.run_id,
      "team-f-moved",
    );
    await git(fixture.project, [
      "worktree",
      "move",
      movedWorkspace?.working_directory ?? "",
      movedPath,
    ]);
    await assert.rejects(
      manager.cleanup(fixture.project, movedWorkspace!),
      unsafeWorkspace,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TEST-703 rolls back partial worktrees but preserves created branches", async () => {
  const fixture = await createFixture("rollback");
  try {
    const run = await fixture.store.createRun({
      objective: "Rollback partial preparation",
      project_path: fixture.project,
    });
    const collisionBranch = `ark-team/${run.run_id}/team-b`;
    await git(fixture.project, ["branch", collisionBranch]);
    const manager = new WorktreeManager({ root_path: fixture.worktrees });

    await assert.rejects(
      manager.prepare(run, planFor("team-a", "team-b")),
      workspaceFailure,
    );

    const firstPath = path.join(fixture.worktrees, run.run_id, "team-a");
    await assert.rejects(stat(firstPath), isMissing);
    assert.equal(
      await branchExists(
        fixture.project,
        `ark-team/${run.run_id}/team-a`,
      ),
      true,
    );
    assert.equal(await branchExists(fixture.project, collisionBranch), true);
    const worktreeList = await gitStdout(fixture.project, ["worktree", "list", "--porcelain"]);
    assert.equal(worktreeList.includes(firstPath), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TEST-705 resolves a bounded configurable worktree root", () => {
  assert.equal(
    resolveWorktreeRoot("/tmp/ark-state", {}),
    "/tmp/ark-state/.worktrees",
  );
  assert.equal(
    resolveWorktreeRoot("/tmp/ark-state", {
      ARK_TEAM_WORKTREE_ROOT: "/tmp/custom-worktrees",
    }),
    "/tmp/custom-worktrees",
  );
  assert.throws(
    () =>
      resolveWorktreeRoot("/tmp/ark-state", {
        ARK_TEAM_WORKTREE_ROOT: "relative",
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );
});

async function createFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `ark-team-worktree-${name}-`));
  const project = path.join(root, "project");
  await git(root, ["init", "-b", "main", project]);
  await git(project, ["config", "user.name", "Ark Team Test"]);
  await git(project, [
    "config",
    "user.email",
    "ark-team-test@example.invalid",
  ]);
  await writeFile(path.join(project, "README.md"), "# fixture\n", "utf8");
  await git(project, ["add", "README.md"]);
  await git(project, ["commit", "-m", "baseline"]);
  return {
    root,
    project,
    worktrees: path.join(root, "worktrees"),
    store: new RunStore({ root_path: path.join(root, "state") }),
  };
}

function planFor(...teamIds: string[]): PmPlan {
  return {
    kind: "pm_plan",
    objective: "Exercise managed worktrees.",
    teams: teamIds.map((teamId, index) => ({
      team_id: teamId,
      mission: `Deliver ${teamId}.`,
      owned_paths: [`src/${teamId}.ts`],
      dependencies: index === 0 ? [] : [teamIds[index - 1] ?? ""],
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

async function git(workingDirectory: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", workingDirectory, ...args], {
    encoding: "utf8",
  });
}

async function gitStdout(
  workingDirectory: string,
  args: string[],
): Promise<string> {
  return (
    await execFileAsync("git", ["-C", workingDirectory, ...args], {
      encoding: "utf8",
    })
  ).stdout.trim();
}

async function branchExists(
  workingDirectory: string,
  branch: string,
): Promise<boolean> {
  try {
    await git(workingDirectory, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function unsafeWorkspace(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    error.code === "UNSAFE_AGENT_WORKSPACE"
  );
}

function workspaceFailure(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    error.code === "WORKSPACE_PREPARATION_FAILED"
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
