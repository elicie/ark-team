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

export interface TeamCoordinatorResult {
  run: RunRecord;
  teams: TeamRecord[];
  assignments: AssignmentRecord[];
  progressed: boolean;
  waiting_approvals: number;
}

export class TeamCoordinator {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    private readonly scheduler: ManagedAssignmentScheduler,
  ) {}

  async advance(runId: string): Promise<TeamCoordinatorResult> {
    return this.withOperation(async () => {
      let anyProgress = false;
      for (let pass = 0; pass < 50; pass += 1) {
        const run = await this.store.getRun(runId);
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
        let passProgress = false;

        for (const team of teams) {
          if (team.state !== "active") {
            continue;
          }
          const pl = assignments.find(
            (assignment) =>
              assignment.role === "pl" && assignment.team_id === team.team_id,
          );
          if (
            pl?.state === "completed" &&
            pl.output_contract === "pl_report" &&
            pl.structured_report?.kind === "pl_report"
          ) {
            assertFinalPlReport(
              team,
              pl.structured_report,
              assignments.filter(
                (assignment) =>
                  assignment.role === "worker" &&
                  assignment.parent_assignment_id === pl.assignment_id,
              ),
            );
            await this.store.completeTeam(
              runId,
              team.team_id,
              pl.assignment_id,
            );
            passProgress = true;
          }
        }
        if (passProgress) {
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
          await runParallel(
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
          assertPlWorkerPlan(team, workerPlan);
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
                  worker.structured_report?.kind === "worker_report",
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
          await runParallel(workerStarts);
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
          await runParallel(plResumes);
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
          (assignment) => assignment.state === "waiting_user",
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

function assertPlWorkerPlan(team: TeamRecord, plan: PlWorkerPlan): void {
  if (plan.team_id !== team.team_id) {
    throw protocolError(
      `PL worker plan belongs to ${plan.team_id}, expected ${team.team_id}`,
    );
  }
  if (plan.workers.length !== team.worker_count) {
    throw protocolError(
      `PL planned ${plan.workers.length} workers, expected ${team.worker_count}`,
    );
  }
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

function assertFinalPlReport(
  team: TeamRecord,
  report: PlReport,
  workers: AssignmentRecord[],
): void {
  if (report.team_id !== team.team_id) {
    throw protocolError(
      `Final PL report belongs to ${report.team_id}, expected ${team.team_id}`,
    );
  }
  if (
    report.status !== "completed" ||
    report.worker_reports.some((worker) => worker.status !== "completed") ||
    report.verification.some((verification) => verification.status !== "passed")
  ) {
    throw protocolError(
      `Final PL report for ${team.team_id} lacks passing completion evidence`,
    );
  }
  const expectedWorkerKeys = workers
    .map((worker) => worker.task_key)
    .filter((key): key is string => key !== null)
    .sort();
  const reportedWorkerKeys = report.worker_reports
    .map((worker) => worker.worker_key)
    .sort();
  if (JSON.stringify(expectedWorkerKeys) !== JSON.stringify(reportedWorkerKeys)) {
    throw protocolError(
      `Final PL report for ${team.team_id} does not cover the assigned workers`,
    );
  }
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

function protocolError(message: string): ArkTeamError {
  return new ArkTeamError("AGENT_SESSION_PROTOCOL_ERROR", message);
}
