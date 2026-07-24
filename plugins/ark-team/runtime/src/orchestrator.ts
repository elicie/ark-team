import type { PmSessionRecord, RunRecord, TeamRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import {
  ManagedCodexSessionLauncher,
  type ManagedSessionRequest,
  type ManagedSessionResult,
} from "./managed-session.js";
import { PlanMaterializer } from "./plan-materializer.js";
import type { PmPlan } from "./role-contracts.js";
import {
  type RecordPmPlanResult,
  RunStore,
} from "./state-store.js";
import {
  TeamCoordinator,
  type TeamCoordinatorResult,
} from "./team-coordinator.js";
import { ManagedAssignmentScheduler } from "./assignment-scheduler.js";

export interface ManagedPmLauncher {
  run(request: ManagedSessionRequest): Promise<ManagedSessionResult>;
}

export interface ArkTeamOrchestratorOptions {
  pm_launcher?: ManagedPmLauncher;
  materializer?: PlanMaterializer;
  coordinator?: TeamExecutionCoordinator;
  codex_path?: string;
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
  progressed: boolean;
  waiting_approvals: number;
}

export interface TeamExecutionCoordinator {
  advance(runId: string): Promise<TeamCoordinatorResult>;
}

export class ArkTeamOrchestrator {
  private readonly pmLauncher: ManagedPmLauncher;
  private readonly materializer: PlanMaterializer;
  private readonly coordinator: TeamExecutionCoordinator;

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
    this.coordinator =
      options.coordinator ??
      new TeamCoordinator(store, new ManagedAssignmentScheduler(store));
  }

  async execute(input: ExecuteArkTeamInput): Promise<ExecuteArkTeamResult> {
    const run = await this.store.createRun(input);
    let pmResult: ManagedSessionResult;
    let recorded: RecordPmPlanResult;
    try {
      pmResult = await this.pmLauncher.run({
        role: "pm",
        assignment: buildPmPlanningAssignment(run),
        working_directory: run.project_path,
        output_contract: "pm_plan",
      });
      assertPmResult(pmResult);
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
    return {
      run: advanced.run,
      pm_session: recorded.pm_session,
      teams: advanced.teams,
      assignments: advanced.assignments,
      progressed: advanced.progressed,
      waiting_approvals: advanced.waiting_approvals,
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

export function buildPmPlanningAssignment(run: RunRecord): string {
  return [
    `Run ID: ${run.run_id}`,
    `User objective: ${run.objective}`,
    "Inspect the project read-only and produce one strict pm_plan.",
    "Choose one to four teams dynamically. Give each team one to five workers based on scope.",
    "Define bounded missions, owned paths, dependencies, acceptance criteria, and verification.",
    "Choose local_merge when local Git integration is appropriate, pull_request only when a supported remote workflow is warranted, or no_git for a non-Git source.",
    "Do not edit files, create commits, merge, spawn agents, or perform external actions.",
  ].join("\n");
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
