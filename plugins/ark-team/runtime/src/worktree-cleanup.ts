import type {
  IntegrationRecord,
  RunRecord,
  TeamRecord,
} from "./domain.js";
import { ArkTeamError } from "./errors.js";
import { RunStore } from "./state-store.js";
import {
  IntegrationWorktreeManager,
  resolveWorktreeRoot,
  WorktreeManager,
} from "./worktree-manager.js";

export interface FinalWorktreeManager {
  cleanupTeam(
    projectPath: string,
    integration: IntegrationRecord,
    team: TeamRecord,
  ): Promise<void>;
  cleanupIntegration(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<void>;
}

export interface WorktreeCleanupCoordinatorOptions {
  manager?: FinalWorktreeManager;
  worktree_root?: string;
}

export class GitFinalWorktreeManager implements FinalWorktreeManager {
  private readonly teams: WorktreeManager;
  private readonly integration: IntegrationWorktreeManager;

  constructor(rootPath: string) {
    this.teams = new WorktreeManager({ root_path: rootPath });
    this.integration = new IntegrationWorktreeManager({
      root_path: rootPath,
    });
  }

  async cleanupTeam(
    projectPath: string,
    integration: IntegrationRecord,
    team: TeamRecord,
  ): Promise<void> {
    if (team.target_branch === null) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        `team ${team.team_id} has no recorded starting branch`,
      );
    }
    await this.integration.verifyTeamBranchContained(
      projectPath,
      integration,
      team,
    );
    await this.teams.cleanup(projectPath, {
      run_id: team.run_id,
      team_id: team.team_id,
      isolation_mode: team.isolation_mode,
      working_directory: team.working_directory,
      branch: team.branch,
      target_branch: team.target_branch,
      base_commit: team.base_commit,
    });
  }

  cleanupIntegration(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<void> {
    return this.integration.cleanupCompleted(projectPath, integration);
  }
}

export class WorktreeCleanupCoordinator {
  private readonly manager: FinalWorktreeManager;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    options: WorktreeCleanupCoordinatorOptions = {},
  ) {
    this.manager =
      options.manager ??
      new GitFinalWorktreeManager(
        options.worktree_root ?? resolveWorktreeRoot(store.root_path),
      );
  }

  async advance(runId: string): Promise<RunRecord> {
    return this.withOperation(async () => {
      let context = await this.store.getRunContext(runId);
      if (
        context.run.state !== "cleaning" ||
        context.integration?.state !== "cleaning" ||
        context.pm_session?.final_report === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "worktree cleanup requires PM-accepted integration evidence",
        );
      }
      try {
        for (const team of (await this.store.listTeams(runId)).teams) {
          if (team.state === "cleaned") {
            continue;
          }
          await this.manager.cleanupTeam(
            context.run.project_path,
            context.integration,
            team,
          );
          await this.store.recordTeamCleaned(runId, team.team_id);
          context = await this.store.getRunContext(runId);
          if (context.integration?.state !== "cleaning") {
            throw new ArkTeamError(
              "CORRUPT_STATE",
              "integration changed during worktree cleanup",
            );
          }
        }
        for (const team of (await this.store.listTeams(runId)).teams) {
          await this.manager.cleanupTeam(
            context.run.project_path,
            context.integration,
            team,
          );
        }
        await this.manager.cleanupIntegration(
          context.run.project_path,
          context.integration,
        );
        return await this.store.completeCleanup(runId);
      } catch (error) {
        await this.store.recordCleanupFailure(
          runId,
          error instanceof Error ? error.message : "Worktree cleanup failed",
        );
        throw error;
      }
    });
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => {};
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
