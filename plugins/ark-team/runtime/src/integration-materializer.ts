import type { IntegrationRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import { RunStore } from "./state-store.js";
import {
  IntegrationWorktreeManager,
  type PreparedIntegrationWorkspace,
  resolveWorktreeRoot,
} from "./worktree-manager.js";

export interface IntegrationWorkspaceManager {
  prepare(
    run: Awaited<ReturnType<RunStore["getRun"]>>,
    teams: Awaited<ReturnType<RunStore["listTeams"]>>["teams"],
    strategy: "local_merge" | "pull_request",
  ): Promise<PreparedIntegrationWorkspace>;
  verify(
    projectPath: string,
    integration: IntegrationRecord,
    teams: Awaited<ReturnType<RunStore["listTeams"]>>["teams"],
    reportedCommit: string,
  ): Promise<string>;
  mergeLocal(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<string>;
  cleanupPrepared(
    projectPath: string,
    workspace: PreparedIntegrationWorkspace,
  ): Promise<void>;
}

export interface IntegrationMaterializerOptions {
  worktree_manager?: IntegrationWorkspaceManager;
  worktree_root?: string;
}

export class IntegrationMaterializer {
  private readonly worktreeManager: IntegrationWorkspaceManager;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    options: IntegrationMaterializerOptions = {},
  ) {
    this.worktreeManager =
      options.worktree_manager ??
      new IntegrationWorktreeManager({
        root_path:
          options.worktree_root ??
          resolveWorktreeRoot(this.store.root_path),
      });
  }

  async prepare(runId: string): Promise<IntegrationRecord> {
    return this.withOperation(async () => {
      const existing = await this.store.getIntegration(runId);
      if (existing !== null) {
        return existing;
      }
      const context = await this.store.getRunContext(runId);
      const teams = (await this.store.listTeams(runId)).teams;
      if (
        context.run.state !== "integrating" ||
        context.plan === null ||
        context.plan.integration.strategy === "no_git"
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Git integration requires an integrating run with a Git strategy",
        );
      }
      const prepared = await this.worktreeManager.prepare(
        context.run,
        teams,
        context.plan.integration.strategy,
      );
      try {
        return await this.store.materializeIntegration({
          run_id: runId,
          strategy: prepared.strategy,
          team_ids: prepared.team_ids,
          working_directory: prepared.working_directory,
          branch: prepared.branch,
          target_branch: prepared.target_branch,
          base_commit: prepared.base_commit,
        });
      } catch (error) {
        try {
          await this.worktreeManager.cleanupPrepared(
            context.run.project_path,
            prepared,
          );
        } catch (cleanupError) {
          throw new ArkTeamError(
            "WORKSPACE_PREPARATION_FAILED",
            "Integration persistence failed and worktree rollback was incomplete",
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
        throw error;
      }
    });
  }

  async verify(
    runId: string,
    reportedCommit: string,
  ): Promise<IntegrationRecord> {
    return this.withOperation(async () => {
      const context = await this.store.getRunContext(runId);
      const integration = context.integration;
      if (integration === null || integration.assignment_id === null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Integration has not been assigned",
        );
      }
      const teams = (await this.store.listTeams(runId)).teams;
      const verifiedCommit = await this.worktreeManager.verify(
        context.run.project_path,
        integration,
        teams,
        reportedCommit,
      );
      return this.store.verifyIntegration(
        runId,
        integration.assignment_id,
        verifiedCommit,
      );
    });
  }

  async mergeLocal(runId: string): Promise<IntegrationRecord> {
    return this.withOperation(async () => {
      const context = await this.store.getRunContext(runId);
      const integration = context.integration;
      if (integration === null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Integration has not been prepared",
        );
      }
      const mergedCommit = await this.worktreeManager.mergeLocal(
        context.run.project_path,
        integration,
      );
      return this.store.recordLocalMerge(runId, mergedCommit);
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
