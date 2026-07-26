import path from "node:path";

import type {
  IntegrationRecord,
  PmSessionRecord,
  RunRecord,
  TeamRecord,
} from "./domain.js";
import { ArkTeamError } from "./errors.js";
import {
  ManagedCodexSessionLauncher,
  type ManagedSessionRequest,
  type ManagedSessionResult,
} from "./managed-session.js";
import { PlanMaterializer } from "./plan-materializer.js";
import {
  DEFAULT_PROJECT_CONFIG,
  loadProjectConfig,
  resolveVerificationCommands,
  type ProjectConfig,
  type ResolvedProjectConfig,
} from "./project-config.js";
import type { PmPlan, PmReport } from "./role-contracts.js";
import {
  type RecordPmPlanResult,
  RunStore,
} from "./state-store.js";
import {
  TeamCoordinator,
  type TeamCoordinatorResult,
} from "./team-coordinator.js";
import { ManagedAssignmentScheduler } from "./assignment-scheduler.js";
import {
  ArkTeamRunCoordinator,
  IntegrationCoordinator,
} from "./integration-coordinator.js";

export interface ManagedPmLauncher {
  run(request: ManagedSessionRequest): Promise<ManagedSessionResult>;
}

export interface ArkTeamOrchestratorOptions {
  pm_launcher?: ManagedPmLauncher;
  materializer?: PlanMaterializer;
  coordinator?: TeamExecutionCoordinator;
  codex_path?: string;
  config_loader?: (projectPath: string) => Promise<ResolvedProjectConfig>;
}

export interface ExecuteArkTeamInput {
  objective: string;
  project_path: string;
}

export interface ExecuteArkTeamResult {
  run: RunRecord;
  pm_session: PmSessionRecord;
  teams: TeamRecord[];
  assignments: TeamCoordinatorResult["assignments"];
  integration: IntegrationRecord | null;
  pm_report: PmReport | null;
  remote_action_required: boolean;
  progressed: boolean;
  waiting_approvals: number;
  waiting_retries: number;
}

export interface TeamExecutionCoordinator {
  advance(runId: string): Promise<TeamCoordinatorResult>;
}

export class ArkTeamOrchestrator {
  private readonly pmLauncher: ManagedPmLauncher;
  private readonly materializer: PlanMaterializer;
  private readonly coordinator: TeamExecutionCoordinator;
  private readonly configLoader: (
    projectPath: string,
  ) => Promise<ResolvedProjectConfig>;

  constructor(
    private readonly store: RunStore,
    options: ArkTeamOrchestratorOptions = {},
  ) {
    this.pmLauncher =
      options.pm_launcher ??
      new ManagedCodexSessionLauncher({
        codex_path:
          options.codex_path ??
          (process.env.ARK_TEAM_CODEX_PATH?.trim() || undefined) ??
          "codex",
      });
    this.materializer = options.materializer ?? new PlanMaterializer(store);
    this.configLoader = options.config_loader ?? loadProjectConfig;
    if (options.coordinator) {
      this.coordinator = options.coordinator;
    } else {
      const scheduler = new ManagedAssignmentScheduler(store, {
        ...(options.codex_path === undefined
          ? {}
          : { codex_path: options.codex_path }),
      });
      this.coordinator = new ArkTeamRunCoordinator(
        store,
        new TeamCoordinator(store, scheduler),
        new IntegrationCoordinator(store, scheduler, {
          pm_launcher: this.pmLauncher,
          ...(options.codex_path === undefined
            ? {}
            : { codex_path: options.codex_path }),
        }),
      );
    }
  }

  async execute(input: ExecuteArkTeamInput): Promise<ExecuteArkTeamResult> {
    const resolvedConfig = await this.configLoader(input.project_path);
    const run = await this.store.createRun({
      ...input,
      project_config: resolvedConfig.config,
      project_config_source: resolvedConfig.source_path,
    });
    let pmResult: ManagedSessionResult;
    let recorded: RecordPmPlanResult;
    try {
      pmResult = await this.pmLauncher.run({
        role: "pm",
        assignment: buildPmPlanningAssignment(run, resolvedConfig.config),
        working_directory: run.project_path,
        output_contract: "pm_plan",
        timeout_ms:
          resolvedConfig.config.execution.agent_timeout_minutes * 60_000,
      });
      assertPmResult(pmResult);
      assertPlanWithinProjectConfig(
        pmResult.structured_report,
        resolvedConfig.config,
      );
      recorded = await this.store.recordPmPlan(
        run.run_id,
        pmResult.structured_report,
        {
          session_id: pmResult.session_id,
          agent_name: "ark_pm",
          model: "gpt-5.6-sol",
          model_reasoning_effort: "xhigh",
          sandbox_mode: "read-only",
          approval_policy: "never",
          usage: pmResult.usage,
        },
      );
    } catch (error) {
      await this.failPlanningRun(run.run_id, error);
      throw normalizePmFailure(error);
    }

    const plan = pmResult.structured_report;
    await this.materializer.apply(run.run_id, plan);
    const advanced = await this.coordinator.advance(run.run_id);
    const current = await this.store.getRunContext(run.run_id);
    return {
      run: advanced.run,
      pm_session: current.pm_session ?? recorded.pm_session,
      teams: advanced.teams,
      assignments: advanced.assignments,
      integration: current.integration,
      pm_report: current.pm_session?.final_report ?? null,
      remote_action_required:
        current.integration?.state === "awaiting_remote",
      progressed: advanced.progressed,
      waiting_approvals: advanced.waiting_approvals,
      waiting_retries: advanced.waiting_retries,
    };
  }

  private async failPlanningRun(runId: string, error: unknown): Promise<void> {
    const message =
      error instanceof Error ? error.message : "Managed PM planning failed";
    try {
      await this.store.failRun(runId, message);
    } catch {
      // Preserve the original PM failure for the caller.
    }
  }
}

export function buildPmPlanningAssignment(
  run: Pick<RunRecord, "run_id" | "objective" | "project_path"> &
    Record<string, unknown>,
  config: ProjectConfig = DEFAULT_PROJECT_CONFIG,
): string {
  const verificationCommands = resolveVerificationCommands(
    config,
    run.project_path,
  ).map((command) => ({
    argv: command.argv,
    cwd: path.relative(run.project_path, command.cwd) || ".",
  }));
  return [
    `Run ID: ${run.run_id}`,
    `User objective: ${run.objective}`,
    "Inspect the project read-only and produce one strict pm_plan.",
    `Choose one to ${countWord(config.organization.max_teams)} teams dynamically.`,
    `Give each team ${countWord(config.organization.min_workers_per_team)} to ${countWord(config.organization.max_workers_per_team)} workers based on scope.`,
    "Define bounded missions, owned paths, dependencies, acceptance criteria, and verification.",
    `Project verification commands (literal argv, no shell; cwd is relative to each assigned managed worktree): ${JSON.stringify(verificationCommands)}`,
    "Keep verification cwd values relative in the plan. Every PL, worker, and integration PL must run them inside its assigned linked worktree, never in the original checkout.",
    "Choose local_merge when local Git integration is appropriate, pull_request only when a supported remote workflow is warranted, or no_git for a non-Git source.",
    "Do not edit files, create commits, merge, spawn agents, or perform external actions.",
  ].join("\n");
}

function countWord(value: number): string {
  return ["zero", "one", "two", "three", "four", "five"][value] ??
    String(value);
}

function assertPlanWithinProjectConfig(
  plan: PmPlan,
  config: ProjectConfig,
): void {
  if (
    plan.teams.length > config.organization.max_teams ||
    plan.teams.some(
      (team) =>
        team.worker_count < config.organization.min_workers_per_team ||
        team.worker_count > config.organization.max_workers_per_team,
    )
  ) {
    throw new ArkTeamError(
      "AGENT_SESSION_PROTOCOL_ERROR",
      "Managed PM plan exceeds the persisted project organization bounds",
    );
  }
}

function assertPmResult(
  result: ManagedSessionResult,
): asserts result is ManagedSessionResult & { structured_report: PmPlan } {
  if (
    result.role !== "pm" ||
    result.agent_name !== "ark_pm" ||
    result.model !== "gpt-5.6-sol" ||
    result.model_reasoning_effort !== "xhigh" ||
    result.sandbox_mode !== "read-only" ||
    result.requested_approval_policy !== "never" ||
    result.structured_report?.kind !== "pm_plan"
  ) {
    throw new ArkTeamError(
      "AGENT_SESSION_PROTOCOL_ERROR",
      "Managed PM result does not match the Sol/xhigh read-only planning contract",
    );
  }
}

function normalizePmFailure(error: unknown): ArkTeamError {
  if (error instanceof ArkTeamError) {
    return error;
  }
  return new ArkTeamError("AGENT_SESSION_FAILED", "Managed PM planning failed", {
    cause: error,
  });
}
