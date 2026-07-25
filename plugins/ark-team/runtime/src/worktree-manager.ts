import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  IntegrationRecord,
  RunRecord,
  TeamRecord,
} from "./domain.js";
import { ArkTeamError } from "./errors.js";
import type { PmPlan } from "./role-contracts.js";

export interface PreparedTeamWorkspace {
  run_id: string;
  team_id: string;
  isolation_mode: TeamRecord["isolation_mode"];
  working_directory: string;
  branch: string;
  target_branch: string;
  base_commit: string;
}

export interface WorktreeManagerOptions {
  root_path: string;
}

export interface PreparedIntegrationWorkspace {
  run_id: string;
  strategy: "local_merge" | "pull_request";
  team_ids: string[];
  working_directory: string;
  branch: string;
  target_branch: string;
  base_commit: string;
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
    const targetBranch = await currentBranch(projectPath);
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
          target_branch: targetBranch,
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
    if (await pathExists(workspace.working_directory)) {
      const status = await git(workspace.working_directory, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (
        status.stdout.trim() ||
        (await currentBranch(workspace.working_directory)) !== workspace.branch
      ) {
        throw new ArkTeamError(
          "UNSAFE_AGENT_WORKSPACE",
          `refusing to remove dirty or moved worktree ${workspace.team_id}`,
        );
      }
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
    } else if (
      await worktreeRegistered(repositoryRoot, workspace.working_directory)
    ) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        `missing worktree remains registered: ${workspace.working_directory}`,
      );
    }
    const registeredPath = await worktreeForBranch(
      repositoryRoot,
      workspace.branch,
    );
    if (registeredPath !== null) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        `worktree branch remains registered at ${registeredPath}`,
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

export class IntegrationWorktreeManager {
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
    teams: TeamRecord[],
    strategy: "local_merge" | "pull_request",
  ): Promise<PreparedIntegrationWorkspace> {
    const projectPath = await assertCleanRepositoryRoot(run.project_path);
    assertOutsideProject(projectPath, this.root_path);
    if (
      teams.length === 0 ||
      teams.some(
        (team) =>
          team.run_id !== run.run_id ||
          team.state !== "completed" ||
          team.base_commit !== teams[0]?.base_commit ||
          team.target_branch === null ||
          team.target_branch !== teams[0]?.target_branch,
      )
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "Integration requires completed teams with one common base",
      );
    }
    const baseCommit = teams[0]?.base_commit ?? "";
    for (const team of teams) {
      const status = await git(team.working_directory, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (
        status.stdout.trim() ||
        (await currentBranch(team.working_directory)) !== team.branch
      ) {
        throw new ArkTeamError(
          "UNSAFE_AGENT_WORKSPACE",
          `completed team ${team.team_id} does not have a clean recorded branch`,
        );
      }
      try {
        await git(projectPath, [
          "merge-base",
          "--is-ancestor",
          baseCommit,
          team.branch,
        ]);
      } catch (error) {
        throw new ArkTeamError(
          "UNSAFE_AGENT_WORKSPACE",
          `team branch ${team.team_id} does not descend from the common base`,
          { cause: error },
        );
      }
    }
    const currentHead = (
      await git(projectPath, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (currentHead !== baseCommit) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "Original checkout HEAD changed after team work started",
      );
    }
    const targetBranch = teams[0]?.target_branch ?? "";
    if ((await currentBranch(projectPath)) !== targetBranch) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "Original checkout branch changed after team work started",
      );
    }

    await mkdir(this.root_path, { recursive: true, mode: 0o700 });
    const actualWorktreeRoot = await realpath(this.root_path);
    assertOutsideProject(projectPath, actualWorktreeRoot);
    const workingDirectory = path.join(
      actualWorktreeRoot,
      run.run_id,
      "integration",
    );
    const branch = `${run.project_config.git.integration_branch_prefix}${run.run_id}`;
    if (await pathExists(workingDirectory)) {
      throw new ArkTeamError(
        "WORKSPACE_PREPARATION_FAILED",
        `integration worktree path already exists: ${workingDirectory}`,
      );
    }
    if (await branchExists(projectPath, branch)) {
      throw new ArkTeamError(
        "WORKSPACE_PREPARATION_FAILED",
        `integration branch already exists: ${branch}`,
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
        "Unable to create the integration linked worktree",
        error,
      );
    }
    return {
      run_id: run.run_id,
      strategy,
      team_ids: teams.map((team) => team.team_id),
      working_directory: workingDirectory,
      branch,
      target_branch: targetBranch,
      base_commit: baseCommit,
    };
  }

  async verify(
    projectPath: string,
    integration: IntegrationRecord,
    teams: TeamRecord[],
    reportedCommit: string,
  ): Promise<string> {
    const repositoryRoot = await assertRepositoryRoot(projectPath);
    const expectedPath = path.join(
      await realpath(this.root_path),
      integration.run_id,
      "integration",
    );
    if (
      path.normalize(integration.working_directory) !== expectedPath ||
      integration.team_ids.length !== teams.length
    ) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "integration workspace is not the registered managed worktree",
      );
    }
    const status = await git(integration.working_directory, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.stdout.trim()) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "integration worktree must be clean before verification",
      );
    }
    const branch = await currentBranch(integration.working_directory);
    const head = (
      await git(integration.working_directory, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (
      branch !== integration.branch ||
      head !== reportedCommit ||
      !/^[0-9a-f]{40,64}$/.test(head)
    ) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "integration branch or reported commit does not match Git",
      );
    }
    for (const team of teams) {
      if (!integration.team_ids.includes(team.team_id)) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          `integration record omits team ${team.team_id}`,
        );
      }
      const teamTip = (
        await git(repositoryRoot, ["rev-parse", `refs/heads/${team.branch}`])
      ).stdout.trim();
      try {
        await git(repositoryRoot, [
          "merge-base",
          "--is-ancestor",
          teamTip,
          head,
        ]);
      } catch (error) {
        throw new ArkTeamError(
          "UNSAFE_AGENT_WORKSPACE",
          `integration commit does not contain team ${team.team_id}`,
          { cause: error },
        );
      }
    }
    return head;
  }

  async mergeLocal(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<string> {
    const repositoryRoot = await assertCleanRepositoryRoot(projectPath);
    const checkedOutBranch = await currentBranch(repositoryRoot);
    const currentHead = (
      await git(repositoryRoot, ["rev-parse", "HEAD"])
    ).stdout.trim();
    const integrationHead = (
      await git(repositoryRoot, [
        "rev-parse",
        `refs/heads/${integration.branch}`,
      ])
    ).stdout.trim();
    if (
      integration.state !== "verified" ||
      checkedOutBranch !== integration.target_branch ||
      currentHead !== integration.base_commit ||
      integrationHead !== integration.integration_commit_sha
    ) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "Original branch or integration ref changed before local merge",
      );
    }
    try {
      await git(repositoryRoot, ["merge", "--ff-only", integration.branch]);
    } catch (error) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "Local integration is not a clean fast-forward",
        { cause: error },
      );
    }
    const mergedHead = (
      await git(repositoryRoot, ["rev-parse", "HEAD"])
    ).stdout.trim();
    if (mergedHead !== integrationHead) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "Local merge did not reach the verified integration commit",
      );
    }
    return mergedHead;
  }

  async cleanupPrepared(
    projectPath: string,
    workspace: PreparedIntegrationWorkspace,
  ): Promise<void> {
    const repositoryRoot = await assertRepositoryRoot(projectPath);
    await git(repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      workspace.working_directory,
    ]);
  }

  async cleanupCompleted(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<void> {
    const repositoryRoot = await assertRepositoryRoot(projectPath);
    const expectedPath = path.join(
      await realpath(this.root_path),
      integration.run_id,
      "integration",
    );
    if (
      integration.state !== "cleaning" ||
      integration.integration_commit_sha === null ||
      path.normalize(integration.working_directory) !== expectedPath
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "integration cleanup requires one registered PM-accepted worktree",
      );
    }
    if (await pathExists(integration.working_directory)) {
      const status = await git(integration.working_directory, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      const head = (
        await git(integration.working_directory, ["rev-parse", "HEAD"])
      ).stdout.trim();
      if (
        status.stdout.trim() ||
        (await currentBranch(integration.working_directory)) !==
          integration.branch ||
        head !== integration.integration_commit_sha
      ) {
        throw new ArkTeamError(
          "UNSAFE_AGENT_WORKSPACE",
          "refusing to remove dirty or changed integration worktree",
        );
      }
      try {
        await git(repositoryRoot, [
          "worktree",
          "remove",
          integration.working_directory,
        ]);
      } catch (error) {
        throw workspaceFailure(
          `Unable to remove integration worktree ${integration.working_directory}`,
          error,
        );
      }
    } else if (
      await worktreeRegistered(repositoryRoot, integration.working_directory)
    ) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        `missing integration worktree remains registered: ${integration.working_directory}`,
      );
    }
    const registeredPath = await worktreeForBranch(
      repositoryRoot,
      integration.branch,
    );
    if (registeredPath !== null) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        `integration branch remains registered at ${registeredPath}`,
      );
    }
    const preservedHead = (
      await git(repositoryRoot, [
        "rev-parse",
        `refs/heads/${integration.branch}`,
      ])
    ).stdout.trim();
    if (preservedHead !== integration.integration_commit_sha) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "integration branch was not preserved at the verified commit",
      );
    }
  }

  async verifyTeamBranchContained(
    projectPath: string,
    integration: IntegrationRecord,
    team: TeamRecord,
  ): Promise<void> {
    const repositoryRoot = await assertRepositoryRoot(projectPath);
    if (
      integration.state !== "cleaning" ||
      integration.integration_commit_sha === null ||
      !integration.team_ids.includes(team.team_id) ||
      (team.state !== "integrated" && team.state !== "cleaned")
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "team cleanup requires one accepted integration",
      );
    }
    const teamTip = (
      await git(repositoryRoot, ["rev-parse", `refs/heads/${team.branch}`])
    ).stdout.trim();
    try {
      await git(repositoryRoot, [
        "merge-base",
        "--is-ancestor",
        teamTip,
        integration.integration_commit_sha,
      ]);
    } catch (error) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        `team branch ${team.team_id} is not contained by the accepted integration`,
        { cause: error },
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

async function worktreeRegistered(
  repositoryRoot: string,
  workingDirectory: string,
): Promise<boolean> {
  const output = (
    await git(repositoryRoot, ["worktree", "list", "--porcelain"])
  ).stdout;
  const normalized = path.normalize(workingDirectory);
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .some(
      (line) => path.normalize(line.slice("worktree ".length)) === normalized,
    );
}

async function worktreeForBranch(
  repositoryRoot: string,
  branch: string,
): Promise<string | null> {
  const output = (
    await git(repositoryRoot, ["worktree", "list", "--porcelain"])
  ).stdout;
  let workingDirectory: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      workingDirectory = path.normalize(line.slice("worktree ".length));
    } else if (
      line === `branch refs/heads/${branch}` &&
      workingDirectory !== null
    ) {
      return workingDirectory;
    } else if (!line && workingDirectory !== null) {
      workingDirectory = null;
    }
  }
  return null;
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

async function currentBranch(workingDirectory: string): Promise<string> {
  try {
    const branch = (
      await git(workingDirectory, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ])
    ).stdout.trim();
    if (!branch) {
      throw new Error("empty branch");
    }
    return branch;
  } catch (error) {
    throw new ArkTeamError(
      "UNSAFE_AGENT_WORKSPACE",
      "Managed Git checkout must remain on its recorded branch",
      { cause: error },
    );
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
