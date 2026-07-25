import type { IntegrationRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import {
  GitHubRemoteActionExecutor,
  type RemoteActionExecutor,
} from "./remote-action.js";
import { RunStore } from "./state-store.js";

export type RemoteActionDecision = "approve_once" | "cancel_run";

export interface RemoteActionCoordinatorOptions {
  executor?: RemoteActionExecutor;
  git_path?: string;
  gh_path?: string;
  remote_name?: string;
}

export class RemoteActionCoordinator {
  private readonly executor: RemoteActionExecutor;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    options: RemoteActionCoordinatorOptions = {},
  ) {
    this.executor =
      options.executor ??
      new GitHubRemoteActionExecutor({
        ...(options.git_path === undefined
          ? {}
          : { git_path: options.git_path }),
        ...(options.gh_path === undefined ? {} : { gh_path: options.gh_path }),
        ...(options.remote_name === undefined
          ? {}
          : { remote_name: options.remote_name }),
      });
  }

  async prepare(runId: string): Promise<IntegrationRecord> {
    return this.withOperation(async () => {
      const context = await this.store.getRunContext(runId);
      const integration = context.integration;
      if (integration === null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "integration is unavailable for remote inspection",
        );
      }
      if (
        integration.state === "awaiting_remote" &&
        integration.remote_action?.status === "pending"
      ) {
        return integration;
      }
      const inspectable =
        integration.state === "awaiting_remote" &&
        integration.remote_action?.status === "cancelled"
          ? {
              ...integration,
              state: "verified" as const,
              remote_action: null,
            }
          : integration;
      const target = await this.executor.inspect(
        context.run.project_path,
        inspectable,
      );
      return this.store.requestRemoteAction({
        run_id: runId,
        remote_name: target.remote_name,
        repository: target.repository,
      });
    });
  }

  async decide(
    runId: string,
    requestId: string,
    decision: RemoteActionDecision,
  ): Promise<IntegrationRecord> {
    if (decision !== "approve_once" && decision !== "cancel_run") {
      throw new ArkTeamError("INVALID_INPUT", "invalid remote-action decision");
    }
    return decision === "approve_once"
      ? this.store.approveRemoteAction(runId, requestId)
      : this.store.cancelRemoteAction(runId, requestId);
  }

  async advance(runId: string): Promise<IntegrationRecord> {
    return this.withOperation(async () => {
      for (let pass = 0; pass < 3; pass += 1) {
        const context = await this.store.getRunContext(runId);
        const integration = context.integration;
        const remote = integration?.remote_action;
        if (
          integration === null ||
          integration.state !== "remote_executing" ||
          (remote?.status !== "approved" && remote?.status !== "executing")
        ) {
          if (integration === null) {
            throw new ArkTeamError(
              "INVALID_TRANSITION",
              "integration is unavailable for remote execution",
            );
          }
          return integration;
        }
        const executing = await this.store.beginRemoteAttempt(
          runId,
          remote.request_id,
        );
        const action = executing.remote_action;
        if (action === null) {
          throw new ArkTeamError(
            "CORRUPT_STATE",
            "executing remote integration lost its action record",
          );
        }
        try {
          const result = await this.executor.execute(
            context.run.project_path,
            executing,
            action,
          );
          return this.store.completeRemoteAction({
            run_id: runId,
            request_id: action.request_id,
            pull_request_url: result.pull_request_url,
          });
        } catch (error) {
          if (
            !(error instanceof ArkTeamError) ||
            (error.code !== "REMOTE_ACTION_FAILED" &&
              error.code !== "REMOTE_ACTION_UNAVAILABLE")
          ) {
            throw error;
          }
          const failed = await this.store.failRemoteAttempt(
            runId,
            action.request_id,
            error.message,
          );
          if (failed.state === "awaiting_remote") {
            return failed;
          }
        }
      }
      const integration = await this.store.getIntegration(runId);
      if (integration === null) {
        throw new ArkTeamError(
          "CORRUPT_STATE",
          "remote execution lost its integration record",
        );
      }
      return integration;
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
