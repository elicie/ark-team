import type {
  AssignmentRecord,
  RunRecord,
  TeamRecord,
} from "./domain.js";
import { ManagedAssignmentScheduler } from "./assignment-scheduler.js";
import { ArkTeamError } from "./errors.js";
import type {
  PlReport,
  PlWorkerPlan,
  WorkerReport,
} from "./role-contracts.js";
import { RunStore } from "./state-store.js";

const MAX_COORDINATOR_PASSES = 500;

export interface TeamCoordinatorResult {
  run: RunRecord;
  teams: TeamRecord[];
  assignments: AssignmentRecord[];
  progressed: boolean;
  waiting_approvals: number;
  waiting_retries: number;
}

export interface TeamCoordinatorOptions {
  internal_agent_retries?: number;
  worker_correction_rounds?: number;
  pl_correction_rounds?: number;
}

export class TeamCoordinator {
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly internalAgentRetries: number | null;
  private readonly workerCorrectionRounds: number | null;
  private readonly plCorrectionRounds: number | null;

  constructor(
    private readonly store: RunStore,
    private readonly scheduler: ManagedAssignmentScheduler,
    options: TeamCoordinatorOptions = {},
  ) {
    this.internalAgentRetries =
      options.internal_agent_retries === undefined
        ? null
        : boundedPolicyValue(
            options.internal_agent_retries,
            2,
            "internal_agent_retries",
          );
    this.workerCorrectionRounds =
      options.worker_correction_rounds === undefined
        ? null
        : boundedPolicyValue(
            options.worker_correction_rounds,
            2,
            "worker_correction_rounds",
          );
    this.plCorrectionRounds =
      options.pl_correction_rounds === undefined
        ? null
        : boundedPolicyValue(
            options.pl_correction_rounds,
            2,
            "pl_correction_rounds",
          );
  }

  async advance(runId: string): Promise<TeamCoordinatorResult> {
    return this.withOperation(async () => {
      let anyProgress = false;
      for (let pass = 0; pass < MAX_COORDINATOR_PASSES; pass += 1) {
        const run = await this.store.getRun(runId);
        const internalAgentRetries =
          this.internalAgentRetries ??
          run.project_config.execution.internal_agent_retries;
        const workerCorrectionRounds =
          this.workerCorrectionRounds ??
          run.project_config.execution.worker_correction_rounds;
        const plCorrectionRounds =
          this.plCorrectionRounds ??
          run.project_config.execution.pl_correction_rounds;
        if (run.state === "integrating") {
          break;
        }
        if (
          run.state !== "staffing" &&
          run.state !== "executing" &&
          run.state !== "waiting_user"
        ) {
          throw new ArkTeamError(
            "INVALID_TRANSITION",
            `Cannot advance team execution while the run is ${run.state}`,
          );
        }

        const teams = (await this.store.listTeams(runId)).teams;
        const assignments = (await this.store.listAssignments(runId)).assignments;

        const failedAssignments = assignments.filter(
          (assignment) => assignment.state === "failed",
        );
        if (failedAssignments.length > 0) {
          const retryOperations: Array<() => Promise<AssignmentRecord>> = [];
          const exhaustedOperations: Array<() => Promise<AssignmentRecord>> = [];
          for (const assignment of failedAssignments) {
            if (
              assignment.session_attempt_count <= internalAgentRetries
            ) {
              retryOperations.push(
                async () =>
                  this.scheduler.retry({
                    run_id: runId,
                    assignment_id: assignment.assignment_id,
                  }),
              );
            } else {
              exhaustedOperations.push(
                async () =>
                  this.scheduler.requestRetry({
                    run_id: runId,
                    assignment_id: assignment.assignment_id,
                    kind: "internal_failure_exhausted",
                    mode: "fresh_session",
                    reason: `${assignment.role} assignment exhausted ${internalAgentRetries} automatic internal retries: ${assignment.failure_message ?? "managed session failed"}`,
                  }),
              );
            }
          }
          await runRetryableParallel(retryOperations);
          await runParallel(exhaustedOperations);
          anyProgress = true;
          continue;
        }

        let passProgress = false;
        const finalCorrections: Array<() => Promise<AssignmentRecord>> = [];
        const finalExhaustions: Array<() => Promise<AssignmentRecord>> = [];
        for (const team of teams) {
          if (team.state !== "active") {
            continue;
          }
          const pl = assignments.find(
            (assignment) =>
              assignment.role === "pl" && assignment.team_id === team.team_id,
          );
          if (
            pl?.state !== "completed" ||
            pl.output_contract !== "pl_report" ||
            pl.structured_report?.kind !== "pl_report"
          ) {
            continue;
          }
          const workers = assignments.filter(
            (assignment) =>
              assignment.role === "worker" &&
              assignment.parent_assignment_id === pl.assignment_id,
          );
          const problem = finalPlReportProblem(
            team,
            pl.structured_report,
            workers,
          );
          if (problem === null) {
            await this.store.completeTeam(
              runId,
              team.team_id,
              pl.assignment_id,
            );
            passProgress = true;
            continue;
          }
          const correctionAssignment = buildCorrectionAssignment(
            team,
            pl,
            problem,
          );
          if (pl.correction_count < plCorrectionRounds) {
            finalCorrections.push(
              async () =>
                this.scheduler.correct({
                  run_id: runId,
                  assignment_id: pl.assignment_id,
                  assignment: correctionAssignment,
                }),
            );
          } else {
            finalExhaustions.push(
              async () =>
                this.scheduler.requestRetry({
                  run_id: runId,
                  assignment_id: pl.assignment_id,
                  kind: "correction_exhausted",
                  mode: "resume_session",
                  reason: `PL report correction budget exhausted: ${problem}`,
                  assignment: correctionAssignment,
                }),
            );
          }
        }
        if (
          passProgress ||
          finalCorrections.length > 0 ||
          finalExhaustions.length > 0
        ) {
          await runRetryableParallel(finalCorrections);
          await runParallel(finalExhaustions);
          anyProgress = true;
          continue;
        }

        const refreshedTeams = (await this.store.listTeams(runId)).teams;
        const completedTeams = new Set(
          refreshedTeams
            .filter((team) => team.state === "completed")
            .map((team) => team.team_id),
        );
        const readyTeams = refreshedTeams.filter(
          (team) =>
            team.state === "ready" &&
            team.dependencies.every((dependency) =>
              completedTeams.has(dependency),
            ),
        );
        if (readyTeams.length > 0) {
          await runRetryableParallel(
            readyTeams.map(
              (team) => async () =>
                this.scheduler.start({
                  run_id: runId,
                  team_id: team.team_id,
                  role: "pl",
                  assignment: buildPlPlanningAssignment(team),
                  working_directory: team.working_directory,
                  output_contract: "pl_worker_plan",
                }),
            ),
          );
          anyProgress = true;
          continue;
        }

        const currentAssignments = (
          await this.store.listAssignments(runId)
        ).assignments;
        const planCorrections: Array<() => Promise<AssignmentRecord>> = [];
        const planExhaustions: Array<() => Promise<AssignmentRecord>> = [];
        for (const team of refreshedTeams) {
          if (team.state !== "active") {
            continue;
          }
          const pl = currentAssignments.find(
            (assignment) =>
              assignment.role === "pl" && assignment.team_id === team.team_id,
          );
          if (
            pl?.state !== "completed" ||
            pl.output_contract !== "pl_worker_plan" ||
            pl.structured_report?.kind !== "pl_worker_plan"
          ) {
            continue;
          }
          const problem = plWorkerPlanProblem(team, pl.structured_report);
          if (problem === null) {
            continue;
          }
          const correctionAssignment = buildCorrectionAssignment(
            team,
            pl,
            problem,
          );
          if (pl.correction_count < plCorrectionRounds) {
            planCorrections.push(
              async () =>
                this.scheduler.correct({
                  run_id: runId,
                  assignment_id: pl.assignment_id,
                  assignment: correctionAssignment,
                }),
            );
          } else {
            planExhaustions.push(
              async () =>
                this.scheduler.requestRetry({
                  run_id: runId,
                  assignment_id: pl.assignment_id,
                  kind: "correction_exhausted",
                  mode: "resume_session",
                  reason: `PL worker-plan correction budget exhausted: ${problem}`,
                  assignment: correctionAssignment,
                }),
            );
          }
        }
        if (planCorrections.length > 0 || planExhaustions.length > 0) {
          await runRetryableParallel(planCorrections);
          await runParallel(planExhaustions);
          anyProgress = true;
          continue;
        }

        const workerCorrections: Array<() => Promise<AssignmentRecord>> = [];
        const workerExhaustions: Array<() => Promise<AssignmentRecord>> = [];
        for (const team of refreshedTeams) {
          const pl = currentAssignments.find(
            (assignment) =>
              assignment.role === "pl" &&
              assignment.team_id === team.team_id &&
              assignment.output_contract === "pl_worker_plan" &&
              assignment.structured_report?.kind === "pl_worker_plan",
          );
          if (!pl) {
            continue;
          }
          const workerPlan =
            pl.structured_report?.kind === "pl_worker_plan"
              ? pl.structured_report
              : null;
          if (workerPlan === null) {
            continue;
          }
          const existingWorkers = currentAssignments.filter(
            (assignment) =>
              assignment.role === "worker" &&
              assignment.parent_assignment_id === pl.assignment_id &&
              assignment.state === "completed",
          );
          for (const worker of existingWorkers) {
            const plannedWorker = workerPlan.workers.find(
              (candidate) => candidate.worker_key === worker.task_key,
            );
            const problem =
              plannedWorker === undefined
                ? `Worker task ${worker.task_key ?? "(missing)"} is not in the PL plan`
                : workerReportProblem(team, plannedWorker, worker);
            if (problem === null) {
              continue;
            }
            const correctionAssignment = buildCorrectionAssignment(
              team,
              worker,
              problem,
            );
            if (worker.correction_count < workerCorrectionRounds) {
              workerCorrections.push(
                async () =>
                  this.scheduler.correct({
                    run_id: runId,
                    assignment_id: worker.assignment_id,
                    assignment: correctionAssignment,
                  }),
              );
            } else {
              workerExhaustions.push(
                async () =>
                  this.scheduler.requestRetry({
                    run_id: runId,
                    assignment_id: worker.assignment_id,
                    kind: "correction_exhausted",
                    mode: "resume_session",
                    reason: `Worker report correction budget exhausted: ${problem}`,
                    assignment: correctionAssignment,
                  }),
              );
            }
          }
        }
        if (workerCorrections.length > 0 || workerExhaustions.length > 0) {
          await runRetryableParallel(workerCorrections);
          await runParallel(workerExhaustions);
          anyProgress = true;
          continue;
        }

        const workerStarts: Array<() => Promise<AssignmentRecord>> = [];
        for (const team of refreshedTeams) {
          if (team.state !== "active") {
            continue;
          }
          const pl = currentAssignments.find(
            (assignment) =>
              assignment.role === "pl" && assignment.team_id === team.team_id,
          );
          if (
            !pl ||
            pl.state !== "completed" ||
            pl.output_contract !== "pl_worker_plan" ||
            pl.structured_report?.kind !== "pl_worker_plan"
          ) {
            continue;
          }
          const workerPlan = pl.structured_report;
          const existingWorkers = currentAssignments.filter(
            (assignment) =>
              assignment.role === "worker" &&
              assignment.parent_assignment_id === pl.assignment_id,
          );
          const existingByKey = new Map(
            existingWorkers.map((worker) => [worker.task_key, worker]),
          );
          const completedWorkerKeys = new Set(
            existingWorkers
              .filter(
                (worker) =>
                  worker.state === "completed" &&
                  worker.output_contract === "worker_report" &&
                  worker.structured_report?.kind === "worker_report" &&
                  workerReportProblem(
                    team,
                    workerPlan.workers.find(
                      (candidate) =>
                        candidate.worker_key === worker.task_key,
                    ),
                    worker,
                  ) === null,
              )
              .map((worker) => worker.task_key)
              .filter((key): key is string => key !== null),
          );

          for (const worker of workerPlan.workers) {
            if (
              !existingByKey.has(worker.worker_key) &&
              worker.dependencies.every((dependency) =>
                completedWorkerKeys.has(dependency),
              )
            ) {
              workerStarts.push(
                async () =>
                  this.scheduler.start({
                    run_id: runId,
                    team_id: team.team_id,
                    role: "worker",
                    parent_assignment_id: pl.assignment_id,
                    task_key: worker.worker_key,
                    assignment: buildWorkerAssignment(team, worker),
                    working_directory: team.working_directory,
                    output_contract: "worker_report",
                  }),
              );
            }
          }
        }
        if (workerStarts.length > 0) {
          await runRetryableParallel(workerStarts);
          anyProgress = true;
          continue;
        }

        const afterWorkers = (await this.store.listAssignments(runId)).assignments;
        const plResumes: Array<() => Promise<AssignmentRecord>> = [];
        for (const team of refreshedTeams) {
          if (team.state !== "active") {
            continue;
          }
          const pl = afterWorkers.find(
            (assignment) =>
              assignment.role === "pl" && assignment.team_id === team.team_id,
          );
          if (
            !pl ||
            pl.state !== "completed" ||
            pl.output_contract !== "pl_worker_plan" ||
            pl.structured_report?.kind !== "pl_worker_plan"
          ) {
            continue;
          }
          const workers = afterWorkers.filter(
            (assignment) =>
              assignment.role === "worker" &&
              assignment.parent_assignment_id === pl.assignment_id,
          );
          if (workers.length !== pl.structured_report.workers.length) {
            continue;
          }
          const reports = collectWorkerReports(team, pl.structured_report, workers);
          if (reports === null) {
            continue;
          }
          plResumes.push(
            async () =>
              this.scheduler.resume({
                run_id: runId,
                assignment_id: pl.assignment_id,
                assignment: buildPlFinalAssignment(team, reports),
                output_contract: "pl_report",
              }),
          );
        }
        if (plResumes.length > 0) {
          await runRetryableParallel(plResumes);
          anyProgress = true;
          continue;
        }

        break;
      }

      const run = await this.store.getRun(runId);
      const teams = (await this.store.listTeams(runId)).teams;
      const assignments = (await this.store.listAssignments(runId)).assignments;
      return {
        run,
        teams,
        assignments,
        progressed: anyProgress,
        waiting_approvals: assignments.filter(
          (assignment) => assignment.pending_approval !== null,
        ).length,
        waiting_retries: assignments.filter(
          (assignment) => assignment.pending_retry !== null,
        ).length,
      };
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

export function buildPlPlanningAssignment(team: TeamRecord): string {
  return [
    `Team: ${team.team_id}`,
    `Mission: ${team.mission}`,
    `Worker count selected by PM: ${team.worker_count}`,
    `Owned paths: ${JSON.stringify(team.owned_paths)}`,
    `Dependencies: ${JSON.stringify(team.dependencies)}`,
    `Acceptance criteria: ${JSON.stringify(team.acceptance_criteria)}`,
    `Verification: ${JSON.stringify(team.verification)}`,
    "Inspect the linked team worktree and return one strict pl_worker_plan.",
    `Return exactly ${team.worker_count} bounded worker records with unique ownership and explicit dependency keys.`,
    "Do not implement the mission in this planning turn.",
  ].join("\n");
}

function buildWorkerAssignment(
  team: TeamRecord,
  worker: PlWorkerPlan["workers"][number],
): string {
  return [
    `Team: ${team.team_id}`,
    `Worker key: ${worker.worker_key}`,
    `Mission: ${worker.mission}`,
    `Owned paths: ${JSON.stringify(worker.owned_paths)}`,
    `Dependencies: ${JSON.stringify(worker.dependencies)}`,
    `Acceptance criteria: ${JSON.stringify(worker.acceptance_criteria)}`,
    `Verification: ${JSON.stringify(worker.verification)}`,
    `Local commit required: ${worker.commit_required}`,
    "Execute only this bounded assignment and return one strict worker_report.",
  ].join("\n");
}

function buildPlFinalAssignment(
  team: TeamRecord,
  reports: WorkerReport[],
): string {
  return [
    `Team: ${team.team_id}`,
    `Mission: ${team.mission}`,
    `Acceptance criteria: ${JSON.stringify(team.acceptance_criteria)}`,
    `Required verification: ${JSON.stringify(team.verification)}`,
    "The managed workers returned these validated reports:",
    JSON.stringify(reports),
    "Inspect their observable changes and evidence in the team worktree.",
    "Consolidate them into one strict pl_report. Do not claim completion when required evidence failed or is missing.",
  ].join("\n");
}

function buildCorrectionAssignment(
  team: TeamRecord,
  assignment: AssignmentRecord,
  problem: string,
): string {
  return [
    `Team: ${team.team_id}`,
    `Role: ${assignment.role}`,
    ...(assignment.task_key === null
      ? []
      : [`Worker key: ${assignment.task_key}`]),
    `Correction required: ${problem}`,
    "Previous structured report:",
    JSON.stringify(assignment.structured_report),
    `Return a corrected strict ${assignment.output_contract} for the same bounded assignment.`,
    "Inspect the existing worktree evidence. Do not claim completion until every stated deficiency is resolved.",
  ].join("\n");
}

function plWorkerPlanProblem(
  team: TeamRecord,
  plan: PlWorkerPlan,
): string | null {
  if (plan.team_id !== team.team_id) {
    return `PL worker plan belongs to ${plan.team_id}, expected ${team.team_id}`;
  }
  if (plan.workers.length !== team.worker_count) {
    return `PL planned ${plan.workers.length} workers, expected ${team.worker_count}`;
  }
  return null;
}

function workerReportProblem(
  team: TeamRecord,
  plannedWorker: PlWorkerPlan["workers"][number] | undefined,
  assignment: AssignmentRecord,
): string | null {
  if (plannedWorker === undefined) {
    return `Worker task ${assignment.task_key ?? "(missing)"} is not in the PL plan`;
  }
  if (
    assignment.output_contract !== "worker_report" ||
    assignment.structured_report?.kind !== "worker_report"
  ) {
    return `Worker ${plannedWorker.worker_key} did not return worker_report`;
  }
  const report = assignment.structured_report;
  if (
    report.team_id !== team.team_id ||
    report.worker_key !== plannedWorker.worker_key
  ) {
    return `Worker report identity is ${report.team_id}/${report.worker_key}, expected ${team.team_id}/${plannedWorker.worker_key}`;
  }
  if (report.status !== "completed") {
    return `Worker ${plannedWorker.worker_key} reported ${report.status}`;
  }
  if (report.blockers.length > 0) {
    return `Worker ${plannedWorker.worker_key} reported unresolved blockers`;
  }
  if (report.verification.some((verification) => verification.status !== "passed")) {
    return `Worker ${plannedWorker.worker_key} lacks passing verification`;
  }
  if (plannedWorker.commit_required && report.commit_sha === null) {
    return `Worker ${plannedWorker.worker_key} omitted its required local commit`;
  }
  return null;
}

function collectWorkerReports(
  team: TeamRecord,
  plan: PlWorkerPlan,
  assignments: AssignmentRecord[],
): WorkerReport[] | null {
  const reports: WorkerReport[] = [];
  for (const plannedWorker of plan.workers) {
    const assignment = assignments.find(
      (candidate) => candidate.task_key === plannedWorker.worker_key,
    );
    if (!assignment || assignment.state !== "completed") {
      return null;
    }
    if (
      assignment.output_contract !== "worker_report" ||
      assignment.structured_report?.kind !== "worker_report" ||
      assignment.structured_report.team_id !== team.team_id ||
      assignment.structured_report.worker_key !== plannedWorker.worker_key
    ) {
      throw protocolError(
        `Worker report does not match ${team.team_id}/${plannedWorker.worker_key}`,
      );
    }
    reports.push(assignment.structured_report);
  }
  return reports;
}

function finalPlReportProblem(
  team: TeamRecord,
  report: PlReport,
  workers: AssignmentRecord[],
): string | null {
  if (report.team_id !== team.team_id) {
    return `Final PL report belongs to ${report.team_id}, expected ${team.team_id}`;
  }
  if (
    report.status !== "completed" ||
    report.worker_reports.some((worker) => worker.status !== "completed") ||
    report.verification.some((verification) => verification.status !== "passed") ||
    report.blockers.length > 0
  ) {
    return `Final PL report for ${team.team_id} lacks passing completion evidence`;
  }
  const expectedWorkerKeys = workers
    .map((worker) => worker.task_key)
    .filter((key): key is string => key !== null)
    .sort();
  const reportedWorkerKeys = report.worker_reports
    .map((worker) => worker.worker_key)
    .sort();
  if (JSON.stringify(expectedWorkerKeys) !== JSON.stringify(reportedWorkerKeys)) {
    return `Final PL report for ${team.team_id} does not cover the assigned workers`;
  }
  const actualReports = workers
    .map((worker) =>
      worker.structured_report?.kind === "worker_report"
        ? worker.structured_report
        : null,
    )
    .filter((worker): worker is WorkerReport => worker !== null)
    .sort((left, right) => left.worker_key.localeCompare(right.worker_key));
  const reported = [...report.worker_reports].sort((left, right) =>
    left.worker_key.localeCompare(right.worker_key),
  );
  if (JSON.stringify(actualReports) !== JSON.stringify(reported)) {
    return `Final PL report for ${team.team_id} changed or omitted worker evidence`;
  }
  return null;
}

async function runParallel<T>(
  operations: Array<() => Promise<T>>,
): Promise<T[]> {
  const settled = await Promise.allSettled(
    operations.map(async (operation) => operation()),
  );
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

async function runRetryableParallel<T>(
  operations: Array<() => Promise<T>>,
): Promise<void> {
  const settled = await Promise.allSettled(
    operations.map(async (operation) => operation()),
  );
  const fatal = settled.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !isRetryableSessionFailure(result.reason),
  );
  if (fatal) {
    throw fatal.reason;
  }
}

function isRetryableSessionFailure(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    (error.code === "AGENT_SESSION_FAILED" ||
      error.code === "AGENT_SESSION_PROTOCOL_ERROR" ||
      error.code === "AGENT_SESSION_UNAVAILABLE")
  );
}

function boundedPolicyValue(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 10) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      `${field} must be an integer from 0 to 10`,
    );
  }
  return selected;
}

function protocolError(message: string): ArkTeamError {
  return new ArkTeamError("AGENT_SESSION_PROTOCOL_ERROR", message);
}
