import type {
  AssignmentRecord,
  IntegrationRecord,
  RunRecord,
  TeamRecord,
} from "./domain.js";
import { ManagedAssignmentScheduler } from "./assignment-scheduler.js";
import { ArkTeamError } from "./errors.js";
import { IntegrationMaterializer } from "./integration-materializer.js";
import {
  ManagedCodexSessionLauncher,
  type ManagedSessionRequest,
  type ManagedSessionResult,
} from "./managed-session.js";
import type {
  IntegrationReport,
  PmReport,
} from "./role-contracts.js";
import {
  RemoteActionCoordinator,
  type RemoteActionDecision,
} from "./remote-action-coordinator.js";
import { RunStore } from "./state-store.js";
import {
  TeamCoordinator,
  type TeamCoordinatorResult,
} from "./team-coordinator.js";
import { WorktreeCleanupCoordinator } from "./worktree-cleanup.js";

export interface PmReviewLauncher {
  run(request: ManagedSessionRequest): Promise<ManagedSessionResult>;
}

export interface VerificationPmGate {
  prepareOriginalPmReview(runId: string): Promise<RunRecord>;
}

export interface IntegrationCoordinatorOptions {
  materializer?: IntegrationMaterializer;
  pm_launcher?: PmReviewLauncher;
  internal_agent_retries?: number;
  correction_rounds?: number;
  codex_path?: string;
  worktree_root?: string;
  remote_actions?: RemoteActionCoordinator;
  cleanup?: WorktreeCleanupCoordinator;
  verification_gate?: VerificationPmGate;
}

export interface RunCoordinatorResult extends TeamCoordinatorResult {
  integration: IntegrationRecord | null;
  pm_report: PmReport | null;
  remote_action_required: boolean;
}

export class IntegrationCoordinator {
  private readonly materializer: IntegrationMaterializer;
  private readonly pmLauncher: PmReviewLauncher;
  private readonly internalAgentRetries: number | null;
  private readonly correctionRounds: number | null;
  private readonly remoteActions: RemoteActionCoordinator;
  private readonly cleanup: WorktreeCleanupCoordinator;
  private readonly verificationGate: VerificationPmGate | null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStore,
    private readonly scheduler: ManagedAssignmentScheduler,
    options: IntegrationCoordinatorOptions = {},
  ) {
    this.materializer =
      options.materializer ??
      new IntegrationMaterializer(store, {
        ...(options.worktree_root === undefined
          ? {}
          : { worktree_root: options.worktree_root }),
      });
    this.pmLauncher =
      options.pm_launcher ??
      new ManagedCodexSessionLauncher({
        codex_path:
          options.codex_path ??
          (process.env.ARK_TEAM_CODEX_PATH?.trim() || undefined) ??
          "codex",
      });
    this.internalAgentRetries =
      options.internal_agent_retries === undefined
        ? null
        : policyValue(
            options.internal_agent_retries,
            2,
            "internal_agent_retries",
          );
    this.correctionRounds =
      options.correction_rounds === undefined
        ? null
        : policyValue(
            options.correction_rounds,
            2,
            "correction_rounds",
          );
    this.remoteActions =
      options.remote_actions ?? new RemoteActionCoordinator(store);
    this.cleanup =
      options.cleanup ??
      new WorktreeCleanupCoordinator(store, {
        ...(options.worktree_root === undefined
          ? {}
          : { worktree_root: options.worktree_root }),
      });
    this.verificationGate = options.verification_gate ?? null;
  }

  async advance(runId: string): Promise<RunCoordinatorResult> {
    return this.withOperation(async () => {
      let progressed = false;
      for (let pass = 0; pass < 50; pass += 1) {
        const context = await this.store.getRunContext(runId);
        const internalAgentRetries =
          this.internalAgentRetries ??
          context.run.project_config.execution.internal_agent_retries;
        if (context.run.state === "completed") {
          break;
        }
        if (
          context.run.state === "waiting_user" &&
          context.integration?.state === "awaiting_remote"
        ) {
          break;
        }
        if (
          context.run.state !== "integrating" &&
          context.run.state !== "verifying" &&
          context.run.state !== "cleaning" &&
          context.run.state !== "waiting_user"
        ) {
          throw new ArkTeamError(
            "INVALID_TRANSITION",
            `Cannot advance integration while the run is ${context.run.state}`,
          );
        }

        if (context.run.state === "cleaning") {
          await this.cleanup.advance(runId);
          progressed = true;
          continue;
        }
        if (context.integration === null) {
          await this.materializer.prepare(runId);
          progressed = true;
          continue;
        }
        const integration = context.integration;

        if (
          integration.state === "awaiting_remote" &&
          integration.remote_action?.status === "cancelled"
        ) {
          await this.remoteActions.prepare(runId);
          progressed = true;
          break;
        }
        if (integration.state === "remote_executing") {
          const remote = await this.remoteActions.advance(runId);
          progressed = true;
          if (remote.state === "awaiting_remote") {
            break;
          }
          continue;
        }

        const assignments = (
          await this.store.listAssignments(runId)
        ).assignments;
        const integrationAssignment = assignments.find(
          (assignment) => assignment.role === "integration_pl",
        );
        if (integrationAssignment === undefined) {
          await runRetryable(async () =>
            this.scheduler.start({
              run_id: runId,
              team_id: "integration",
              role: "integration_pl",
              assignment: buildIntegrationAssignment(
                context.run,
                integration,
                (await this.store.listTeams(runId)).teams,
                context.plan?.integration.verification ?? [],
              ),
              working_directory: integration.working_directory,
              output_contract: "integration_report",
            }),
          );
          progressed = true;
          continue;
        }

        if (integrationAssignment.state === "failed") {
          if (
            integrationAssignment.session_attempt_count <=
            internalAgentRetries
          ) {
            await runRetryable(async () =>
              this.scheduler.retry({
                run_id: runId,
                assignment_id: integrationAssignment.assignment_id,
              }),
            );
          } else {
            await this.scheduler.requestRetry({
              run_id: runId,
              assignment_id: integrationAssignment.assignment_id,
              kind: "internal_failure_exhausted",
              mode: "fresh_session",
              reason: `Integration PL exhausted ${internalAgentRetries} automatic retries: ${integrationAssignment.failure_message ?? "managed session failed"}`,
            });
          }
          progressed = true;
          continue;
        }
        if (
          integrationAssignment.state === "running" ||
          integrationAssignment.state === "waiting_user"
        ) {
          break;
        }
        if (integrationAssignment.state !== "completed") {
          break;
        }

        if (context.integration.state === "active") {
          const report =
            integrationAssignment.structured_report?.kind ===
            "integration_report"
              ? integrationAssignment.structured_report
              : null;
          let problem = integrationReportProblem(
            context.integration,
            report,
          );
          if (problem === null && report?.integration_commit_sha) {
            try {
              await this.materializer.verify(
                runId,
                report.integration_commit_sha,
              );
              progressed = true;
              continue;
            } catch (error) {
              if (
                error instanceof ArkTeamError &&
                (error.code === "UNSAFE_AGENT_WORKSPACE" ||
                  error.code === "WORKSPACE_PREPARATION_FAILED")
              ) {
                problem = error.message;
              } else {
                throw error;
              }
            }
          }
          if (problem !== null) {
            await this.correctOrWait(
              runId,
              context.integration,
              integrationAssignment,
              problem,
            );
            progressed = true;
            continue;
          }
        }

        const refreshed = await this.store.getRunContext(runId);
        if (refreshed.integration?.state === "verified") {
          if (refreshed.integration.strategy === "pull_request") {
            await this.remoteActions.prepare(runId);
            progressed = true;
            break;
          }
          await this.materializer.mergeLocal(runId);
          progressed = true;
          continue;
        }
        if (
          refreshed.integration?.state === "local_merged" ||
          refreshed.integration?.state === "remote_completed"
        ) {
          await this.prepareVerificationPmReview(refreshed.run);
          const gated = await this.store.getRunContext(runId);
          await this.completePmReview(
            gated.run,
            gated.integration ?? refreshed.integration,
            (await this.store.listTeams(runId)).teams,
            assignments,
            gated.pm_session?.session_id ?? null,
          );
          progressed = true;
          continue;
        }
        break;
      }
      return this.snapshot(runId, progressed);
    });
  }

  async decideRemote(
    runId: string,
    requestId: string,
    decision: RemoteActionDecision,
  ): Promise<RunCoordinatorResult> {
    await this.remoteActions.decide(runId, requestId, decision);
    return decision === "approve_once"
      ? this.advance(runId)
      : this.snapshot(runId, true);
  }

  private async prepareVerificationPmReview(run: RunRecord): Promise<void> {
    const config = run.project_config.verification.coordinator;
    if (
      config === null ||
      config.schema_version !== 2 ||
      !config.enabled ||
      (run.verification_state?.current_state === "original_pm_review" &&
        run.verification_state.terminal_outcome === "passed")
    ) {
      return;
    }
    if (this.verificationGate === null) {
      throw new ArkTeamError(
        "ENVIRONMENT_UNAVAILABLE",
        "enabled local verification requires a registered PM gate",
      );
    }
    const gated = await this.verificationGate.prepareOriginalPmReview(
      run.run_id,
    );
    if (
      gated.verification_state?.current_state !== "original_pm_review" ||
      gated.verification_state.terminal_outcome !== "passed"
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "original PM review is blocked by local verification",
      );
    }
  }

  private async correctOrWait(
    runId: string,
    integration: IntegrationRecord,
    assignment: AssignmentRecord,
    problem: string,
  ): Promise<void> {
    const run = await this.store.getRun(runId);
    const correctionRounds =
      this.correctionRounds ??
      run.project_config.execution.pl_correction_rounds;
    const correction = [
      "Integration correction required.",
      `Run: ${runId}`,
      `Problem: ${problem}`,
      `Expected teams: ${JSON.stringify(integration.team_ids)}`,
      `Previous report: ${JSON.stringify(assignment.structured_report)}`,
      "Inspect and repair only the integration worktree. Do not push, create a PR, or modify the original checkout.",
      "Return one corrected strict integration_report.",
    ].join("\n");
    if (assignment.correction_count < correctionRounds) {
      await runRetryable(async () =>
        this.scheduler.correct({
          run_id: runId,
          assignment_id: assignment.assignment_id,
          assignment: correction,
        }),
      );
      return;
    }
    await this.scheduler.requestRetry({
      run_id: runId,
      assignment_id: assignment.assignment_id,
      kind: "correction_exhausted",
      mode: "resume_session",
      reason: `Integration correction budget exhausted: ${problem}`,
      assignment: correction,
    });
  }

  private async completePmReview(
    run: RunRecord,
    integration: IntegrationRecord,
    teams: TeamRecord[],
    assignments: AssignmentRecord[],
    pmSessionId: string | null,
  ): Promise<void> {
    if (pmSessionId === null) {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "Managed PM planning session is unavailable for final review",
      );
    }
    const integrationAssignment = assignments.find(
      (assignment) => assignment.role === "integration_pl",
    );
    const teamReports = assignments
      .filter(
        (assignment) =>
          assignment.role === "pl" &&
          assignment.output_contract === "pl_report" &&
          assignment.structured_report?.kind === "pl_report",
      )
      .map((assignment) => assignment.structured_report);
    const providerSensitiveEnvironmentNames =
      await this.store.providerSensitiveEnvironmentNames(
        run.model_bindings.worker,
      );
    const verificationHandoff =
      serializeVerificationPmHandoff(run);
    const result = await this.pmLauncher.run({
      role: "pm",
      assignment: [
        `Run ID: ${run.run_id}`,
        `Objective: ${run.objective}`,
        `Expected teams: ${JSON.stringify(teams.map((team) => team.team_id))}`,
        `Team reports: ${JSON.stringify(teamReports)}`,
        `Integration record: ${JSON.stringify(integration)}`,
        `Integration report: ${JSON.stringify(integrationAssignment?.structured_report)}`,
        ...(verificationHandoff === null
          ? []
          : [`Local verification handoff: ${verificationHandoff}`]),
        "Review the observable evidence read-only and return one strict pm_report.",
        "Return completed only when every team, integration, and enabled local verification passed. Do not edit, merge, push, or create a PR.",
      ].join("\n"),
      working_directory: run.project_path,
      resume_session_id: pmSessionId,
      output_contract: "pm_report",
      timeout_ms: run.project_config.execution.agent_timeout_minutes * 60_000,
      ...(providerSensitiveEnvironmentNames.length === 0
        ? {}
        : {
            provider_sensitive_env_names:
              providerSensitiveEnvironmentNames,
          }),
    });
    if (
      result.session_id !== pmSessionId ||
      result.role !== "pm" ||
      result.agent_name !== "ark_pm" ||
      result.model !== "gpt-5.6-sol" ||
      result.model_reasoning_effort !== "xhigh" ||
      result.sandbox_mode !== "read-only" ||
      result.requested_approval_policy !== "never" ||
      result.structured_report?.kind !== "pm_report"
    ) {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "PM final review does not match the original Sol/xhigh read-only session",
      );
    }
    await this.store.completePmReview({
      run_id: run.run_id,
      session_id: result.session_id,
      report: result.structured_report,
      usage: result.usage,
    });
  }

  private async snapshot(
    runId: string,
    progressed: boolean,
  ): Promise<RunCoordinatorResult> {
    const context = await this.store.getRunContext(runId);
    const assignments = (
      await this.store.listAssignments(runId)
    ).assignments;
    return {
      run: context.run,
      teams: (await this.store.listTeams(runId)).teams,
      assignments,
      integration: context.integration,
      pm_report: context.pm_session?.final_report ?? null,
      progressed,
      waiting_approvals: assignments.filter(
        (assignment) => assignment.pending_approval !== null,
      ).length,
      waiting_retries: assignments.filter(
        (assignment) => assignment.pending_retry !== null,
      ).length,
      remote_action_required:
        context.integration?.state === "awaiting_remote" &&
        context.integration.remote_action?.status === "pending",
    };
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

function serializeVerificationPmHandoff(run: RunRecord): string | null {
  const config = run.project_config.verification.coordinator;
  if (
    config === null ||
    config.schema_version !== 2 ||
    !config.enabled
  ) {
    return null;
  }
  const snapshot = run.verification_snapshot;
  const state = run.verification_state;
  if (
    snapshot === null ||
    snapshot.schema_version !== 2 ||
    state?.current_state !== "original_pm_review" ||
    state.terminal_outcome !== "passed" ||
    run.verification_snapshot_sha256 === null
  ) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "local verification handoff is not ready for original PM review",
    );
  }
  const reportRecords = run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "report" &&
      record.payload.outcome === "passed",
  );
  const report = reportRecords[0];
  if (
    reportRecords.length !== 1 ||
    report?.schema_version !== 2 ||
    report.payload.kind !== "report"
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "local verification handoff requires one passed terminal report",
    );
  }
  const summaryIds = new Set(report.payload.evidence_record_ids);
  const summaries = run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "lane_summary" &&
      summaryIds.has(record.record_id),
  );
  const evidenceIds = new Set(
    summaries.flatMap((summary) =>
      summary.schema_version === 2 &&
      summary.payload.kind === "lane_summary"
        ? (summary.payload.checks ?? []).flatMap(
            (check) => check.evidence_record_ids,
          )
        : [],
    ),
  );
  const evidence = run.verification_records.flatMap((record) =>
    record.schema_version === 2 && evidenceIds.has(record.record_id)
      ? [record]
      : [],
  );
  const referencedArtifacts = new Set(
    evidence.flatMap((record) =>
      record.schema_version === 2
        ? record.artifact_references.map(
            (reference) =>
              `${reference.artifact_id}\0${reference.relative_path}\0${reference.sha256}`,
          )
        : [],
    ),
  );
  const artifacts = run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "artifact" &&
      referencedArtifacts.has(
        `${record.payload.artifact_id}\0${record.payload.relative_path}\0${record.payload.sha256}`,
      ),
  );
  const errors = run.verification_records.filter(
    (record) =>
      record.schema_version === 2 && record.payload.kind === "error",
  );
  const handoff = {
    contract_id: "verification_contract_v2" as const,
    source: {
      fingerprint: snapshot.source_fingerprint,
      commit: snapshot.source.source_commit,
      tree: snapshot.source.source_tree,
    },
    package: snapshot.package,
    snapshot: {
      id: snapshot.snapshot_id,
      sha256: run.verification_snapshot_sha256,
      resolved_config_sha256: snapshot.resolved_config_sha256,
    },
    lane_matrix: {
      backend: {
        enabled: snapshot.backend_contract.enabled,
        required: snapshot.backend_contract.enabled
          ? snapshot.backend_contract.required
          : false,
      },
      ui: {
        enabled: snapshot.ui_contract.enabled,
        required: snapshot.ui_contract.enabled
          ? snapshot.ui_contract.required
          : false,
      },
    },
    baseline_identity: snapshot.ui_contract.enabled
      ? snapshot.ui_contract.baseline_identity
      : null,
    report: {
      record_id: report.record_id,
      payload: report.payload,
    },
    lane_summaries: summaries.map((summary) => ({
      record_id: summary.record_id,
      payload: summary.payload,
    })),
    attempts: state.attempts.map((attempt) => ({
      action_id: attempt.action_id,
      kind: attempt.kind,
      lane: attempt.lane,
      check_id: attempt.check_id,
      attempt_count: attempt.attempt_count,
      max_attempts: attempt.max_attempts,
      status: attempt.status,
      last_error_code: attempt.last_error_code,
      decisive_evidence_record_ids:
        attempt.decisive_evidence_record_ids,
    })),
    evidence: evidence.map((record) => ({
      record_id: record.record_id,
      record_type: record.record_type,
      lane: record.lane,
      check_id: record.check_id,
      payload: record.payload,
      adapter: record.adapter,
      model: record.model,
      artifact_references: record.artifact_references,
    })),
    artifacts: artifacts.map((record) => ({
      record_id: record.record_id,
      payload: record.payload,
    })),
    redacted_errors: errors.map((record) => ({
      record_id: record.record_id,
      payload: record.payload,
    })),
  };
  const serialized = JSON.stringify(handoff);
  if (Buffer.byteLength(serialized, "utf8") > 100_000) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "local verification PM handoff exceeds its bounded size",
    );
  }
  return serialized;
}

export class ArkTeamRunCoordinator {
  constructor(
    private readonly store: RunStore,
    private readonly teamCoordinator: TeamCoordinator,
    private readonly integrationCoordinator: IntegrationCoordinator,
  ) {}

  async advance(runId: string): Promise<RunCoordinatorResult> {
    const before = await this.store.getRunContext(runId);
    if (
      before.run.state === "completed" ||
      before.integration !== null ||
      before.run.state === "integrating" ||
      before.run.state === "verifying" ||
      before.run.state === "cleaning"
    ) {
      return this.integrationCoordinator.advance(runId);
    }
    const teams = await this.teamCoordinator.advance(runId);
    if (teams.run.state === "integrating") {
      const integrated = await this.integrationCoordinator.advance(runId);
      return {
        ...integrated,
        progressed: teams.progressed || integrated.progressed,
      };
    }
    return {
      ...teams,
      integration: before.integration,
      pm_report: before.pm_session?.final_report ?? null,
      remote_action_required: false,
    };
  }

  decideRemote(
    runId: string,
    requestId: string,
    decision: RemoteActionDecision,
  ): Promise<RunCoordinatorResult> {
    return this.integrationCoordinator.decideRemote(
      runId,
      requestId,
      decision,
    );
  }
}

function buildIntegrationAssignment(
  run: RunRecord,
  integration: IntegrationRecord,
  teams: TeamRecord[],
  verification: string[],
): string {
  return [
    `Run: ${run.run_id}`,
    `Objective: ${run.objective}`,
    `Integration branch: ${integration.branch}`,
    `Target branch: ${integration.target_branch}`,
    `Base commit: ${integration.base_commit}`,
    `Team branches: ${JSON.stringify(teams.map((team) => ({ team_id: team.team_id, branch: team.branch, dependencies: team.dependencies })))}`,
    `Required cross-team verification: ${JSON.stringify(verification)}`,
    "Merge every team branch into the current integration branch in dependency-safe order.",
    "Resolve only implementation conflicts within approved scope and run the required cross-team verification.",
    "Do not modify the original checkout, push, create a pull request, deploy, or perform another remote action.",
    "Leave the integration worktree clean and return one strict integration_report with the full HEAD commit SHA.",
  ].join("\n");
}

function integrationReportProblem(
  integration: IntegrationRecord,
  report: IntegrationReport | null,
): string | null {
  if (report === null) {
    return "Integration PL did not return integration_report";
  }
  if (
    report.status !== "completed" ||
    report.integration_commit_sha === null ||
    report.verification.some(
      (verification) => verification.status !== "passed",
    ) ||
    report.blockers.length > 0
  ) {
    return "Integration report lacks passing completion evidence";
  }
  if (
    JSON.stringify(report.team_ids) !== JSON.stringify(integration.team_ids)
  ) {
    return "Integration report does not cover the planned teams in order";
  }
  return null;
}

async function runRetryable<T>(operation: () => Promise<T>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      error instanceof ArkTeamError &&
      (error.code === "AGENT_SESSION_FAILED" ||
        error.code === "AGENT_SESSION_PROTOCOL_ERROR" ||
        error.code === "AGENT_SESSION_UNAVAILABLE")
    ) {
      return;
    }
    throw error;
  }
}

function policyValue(
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
