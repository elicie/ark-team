import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RunRecord, TeamRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import type { PmPlan } from "./role-contracts.js";

export interface PreparedTeamWorkspace {
  run_id: string;
  team_id: string;
  isolation_mode: TeamRecord["isolation_mode"];
  working_directory: string;
  branch: string;
  base_commit: string;
}

export interface WorktreeManagerOptions {
  root_path: string;
}

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  readonly root_path: string;

  constructor(options: WorktreeManagerOptions) {
    if (!path.isAbsolute(options.root_path)) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "managed worktree root must be absolute",
      );
    }
    this.root_path = path.normalize(options.root_path);
  }

  async prepare(
    run: RunRecord,
    plan: PmPlan,
  ): Promise<PreparedTeamWorkspace[]> {
    const projectPath = await assertCleanRepositoryRoot(run.project_path);
    assertOutsideProject(projectPath, this.root_path);
    await mkdir(this.root_path, { recursive: true, mode: 0o700 });
    const actualWorktreeRoot = await realpath(this.root_path);
    assertOutsideProject(projectPath, actualWorktreeRoot);
    const baseCommit = (
      await git(projectPath, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
      throw new ArkTeamError(
        "WORKSPACE_PREPARATION_FAILED",
        "Git returned an invalid base commit",
      );
    }

    const runRoot = path.join(actualWorktreeRoot, run.run_id);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const prepared: PreparedTeamWorkspace[] = [];
    try {
      for (const team of plan.teams) {
        const workingDirectory = path.join(runRoot, team.team_id);
        const branch = `ark-team/${run.run_id}/${team.team_id}`;
        if (await pathExists(workingDirectory)) {
          throw new ArkTeamError(
            "WORKSPACE_PREPARATION_FAILED",
            `managed worktree path already exists: ${workingDirectory}`,
          );
        }
        if (await branchExists(projectPath, branch)) {
          throw new ArkTeamError(
            "WORKSPACE_PREPARATION_FAILED",
            `managed team branch already exists: ${branch}`,
          );
        }

        try {
          await git(projectPath, [
            "worktree",
            "add",
            "-b",
            branch,
            workingDirectory,
            baseCommit,
          ]);
        } catch (error) {
          throw workspaceFailure(
            `Unable to create linked worktree for ${team.team_id}`,
            error,
          );
        }
        prepared.push({
          run_id: run.run_id,
          team_id: team.team_id,
          isolation_mode: "git_worktree",
          working_directory: workingDirectory,
          branch,
          base_commit: baseCommit,
        });
      }
      return prepared;
    } catch (error) {
      const rollbackErrors = await rollbackPrepared(projectPath, prepared);
      if (rollbackErrors.length > 0) {
        throw workspaceFailure(
          "Worktree preparation failed and rollback was incomplete",
          new AggregateError([error, ...rollbackErrors]),
        );
      }
      throw error;
    }
  }

  async cleanup(projectPath: string, workspace: PreparedTeamWorkspace): Promise<void> {
    const actualWorktreeRoot = await realpath(this.root_path);
    const expectedPath = path.join(
      actualWorktreeRoot,
      workspace.run_id,
      workspace.team_id,
    );
    if (path.normalize(workspace.working_directory) !== expectedPath) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "refusing to clean an unregistered worktree path",
      );
    }
    const repositoryRoot = await assertRepositoryRoot(projectPath);
    try {
      await git(repositoryRoot, [
        "worktree",
        "remove",
        workspace.working_directory,
      ]);
    } catch (error) {
      throw workspaceFailure(
        `Unable to remove linked worktree ${workspace.working_directory}`,
        error,
      );
    }
    if (!(await branchExists(repositoryRoot, workspace.branch))) {
      throw new ArkTeamError(
        "WORKSPACE_PREPARATION_FAILED",
        `worktree branch was not preserved: ${workspace.branch}`,
      );
    }
  }
}

export function resolveWorktreeRoot(
  stateRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.ARK_TEAM_WORKTREE_ROOT?.trim();
  if (!configured) {
    return path.join(path.resolve(stateRoot), ".worktrees");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/") || configured.startsWith(`~${path.sep}`)) {
    return path.join(homedir(), configured.slice(2));
  }
  if (!path.isAbsolute(configured)) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "ARK_TEAM_WORKTREE_ROOT must be absolute or start with ~/",
    );
  }
  return path.normalize(configured);
}

async function assertCleanRepositoryRoot(projectPath: string): Promise<string> {
  const repositoryRoot = await assertRepositoryRoot(projectPath);
  const status = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.stdout.trim()) {
    throw new ArkTeamError(
      "UNSAFE_AGENT_WORKSPACE",
      "PM plan materialization requires a clean Git working tree",
    );
  }
  return repositoryRoot;
}

async function assertRepositoryRoot(projectPath: string): Promise<string> {
  let actualProject: string;
  try {
    actualProject = await realpath(projectPath);
  } catch (error) {
    throw workspaceFailure(`Unable to resolve project path: ${projectPath}`, error);
  }

  let topLevel: string;
  try {
    topLevel = (
      await git(actualProject, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
  } catch (error) {
    throw new ArkTeamError(
      "UNSAFE_AGENT_WORKSPACE",
      `Project is not a Git repository root: ${projectPath}`,
      { cause: error },
    );
  }
  let actualTopLevel: string;
  try {
    actualTopLevel = await realpath(topLevel);
  } catch (error) {
    throw workspaceFailure("Unable to resolve Git repository root", error);
  }
  if (actualProject !== actualTopLevel) {
    throw new ArkTeamError(
      "UNSAFE_AGENT_WORKSPACE",
      `project_path must be the Git repository root: ${actualTopLevel}`,
    );
  }
  return actualTopLevel;
}

function assertOutsideProject(projectPath: string, worktreeRoot: string): void {
  const relative = path.relative(projectPath, worktreeRoot);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    throw new ArkTeamError(
      "UNSAFE_AGENT_WORKSPACE",
      "managed worktree root must be outside the project checkout",
    );
  }
}

async function rollbackPrepared(
  projectPath: string,
  workspaces: readonly PreparedTeamWorkspace[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const workspace of [...workspaces].reverse()) {
    try {
      await git(projectPath, [
        "worktree",
        "remove",
        "--force",
        workspace.working_directory,
      ]);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await git(projectPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch (error) {
    if (isExitCode(error, 1)) {
      return false;
    }
    throw workspaceFailure(`Unable to inspect branch ${branch}`, error);
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw workspaceFailure(`Unable to inspect path ${candidate}`, error);
  }
}

async function git(
  workingDirectory: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", ["-C", workingDirectory, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw error;
  }
}

function workspaceFailure(message: string, cause?: unknown): ArkTeamError {
  return new ArkTeamError(
    "WORKSPACE_PREPARATION_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isExitCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
