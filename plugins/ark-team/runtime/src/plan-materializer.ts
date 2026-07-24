import type { TeamListResult } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import {
  pmPlanSchema,
  type PmPlan,
} from "./role-contracts.js";
import {
  type MaterializePlanResult,
  RunStore,
} from "./state-store.js";
import {
  type PreparedTeamWorkspace,
  resolveWorktreeRoot,
  WorktreeManager,
} from "./worktree-manager.js";

export interface TeamWorkspaceManager {
  prepare(
    run: Awaited<ReturnType<RunStore["getRun"]>>,
    plan: PmPlan,
  ): Promise<PreparedTeamWorkspace[]>;
  cleanup(
    projectPath: string,
    workspace: PreparedTeamWorkspace,
  ): Promise<void>;
}

export interface PlanMaterializerOptions {
  worktree_manager?: TeamWorkspaceManager;
  worktree_root?: string;
}

export class PlanMaterializer {
  private readonly worktreeManager: TeamWorkspaceManager;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    options: PlanMaterializerOptions = {},
  ) {
    this.worktreeManager =
      options.worktree_manager ??
      new WorktreeManager({
        root_path:
          options.worktree_root ??
          resolveWorktreeRoot(this.store.root_path),
      });
  }

  async apply(runId: string, planInput: unknown): Promise<MaterializePlanResult> {
    return this.withOperation(async () => {
      const parsed = pmPlanSchema.safeParse(planInput);
      if (!parsed.success) {
        throw new ArkTeamError("INVALID_INPUT", "plan does not match pm_plan", {
          cause: parsed.error,
        });
      }
      const run = await this.store.getRun(runId);
      if (run.state !== "planning") {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          `Cannot materialize a PM plan while the run is ${run.state}`,
        );
      }
      if ((await this.store.listTeams(runId)).total > 0) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "A PM plan has already been materialized for this run",
        );
      }
      const prepared = await this.worktreeManager.prepare(run, parsed.data);
      try {
        return await this.store.materializePlan({
          run_id: runId,
          plan: parsed.data,
          workspaces: prepared,
        });
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        for (const workspace of [...prepared].reverse()) {
          try {
            await this.worktreeManager.cleanup(run.project_path, workspace);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new ArkTeamError(
            "WORKSPACE_PREPARATION_FAILED",
            "Plan persistence failed and worktree rollback was incomplete",
            { cause: new AggregateError([error, ...cleanupErrors]) },
          );
        }
        throw error;
      }
    });
  }

  async list(runId: string): Promise<TeamListResult> {
    return this.store.listTeams(runId);
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
