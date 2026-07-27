import path from "node:path";

import type {
  AssignmentListResult,
  AssignmentRecord,
  AssignmentRole,
} from "./domain.js";
import {
  AppServerApprovalSession,
  type ApprovalDecision,
  type ApprovalSessionRequest,
  type ApprovalSessionUpdate,
} from "./approval-session.js";
import { ArkTeamError } from "./errors.js";
import { assertManagedWorkspace } from "./managed-session.js";
import { assertExternalBindingCurrent } from "./provider-config.js";
import {
  ProviderBridge,
  type ProviderBridgeOptions,
} from "./provider-bridge.js";
import {
  type CreateAssignmentInput,
  type CorrectAssignmentInput,
  type ListAssignmentsInput,
  type RequestAssignmentRetryInput,
  type ResumeAssignmentInput,
  type RetryAssignmentInput,
  RunStore,
} from "./state-store.js";
import { isRoutineCommandApproval } from "./routine-approval.js";

export interface ApprovalSessionHandle {
  start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate>;
  decide(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate>;
  armWaitingMonitor?(): void;
  close(): Promise<void>;
}

export interface ManagedAssignmentSchedulerOptions {
  session_factory?: (assignment: AssignmentRecord) => ApprovalSessionHandle;
  codex_path?: string;
  provider_environment?: NodeJS.ProcessEnv;
  provider_fetch?: typeof fetch;
}

export type RetryDecision = "retry_once" | "cancel_run";
export type ApprovalRecoveryDecision = "resume_safely" | "cancel_run";

interface LiveAssignment {
  run_id: string;
  session: ApprovalSessionHandle;
}

export class ManagedAssignmentScheduler {
  private readonly liveAssignments = new Map<string, LiveAssignment>();
  private readonly sessionFactory:
    | ((assignment: AssignmentRecord) => ApprovalSessionHandle)
    | null;
  private readonly codexPath: string;
  private readonly providerEnvironment: NodeJS.ProcessEnv;
  private readonly providerFetch: typeof fetch | undefined;

  constructor(
    private readonly store: RunStore,
    options: ManagedAssignmentSchedulerOptions = {},
  ) {
    this.sessionFactory = options.session_factory ?? null;
    this.codexPath =
      options.codex_path ??
      (process.env.ARK_TEAM_CODEX_PATH?.trim() || undefined) ??
      "codex";
    this.providerEnvironment =
      options.provider_environment ?? process.env;
    this.providerFetch = options.provider_fetch;
  }

  async start(input: CreateAssignmentInput): Promise<AssignmentRecord> {
    const workingDirectory = await assertManagedWorkspace(
      sessionRole(input.role),
      input.working_directory,
    );
    if (input.role === "worker") {
      const run = await this.store.getRun(input.run_id);
      await this.assertBindingCurrentOrPause(
        input.run_id,
        run.model_bindings.worker,
      );
    }
    const assignment = await this.store.createAssignment({
      ...input,
      working_directory: workingDirectory,
    });

    return this.launch(assignment);
  }

  async resume(input: ResumeAssignmentInput): Promise<AssignmentRecord> {
    const current = await this.store.getAssignment(
      input.run_id,
      input.assignment_id,
    );
    await this.assertBindingCurrentOrPause(
      input.run_id,
      current.model_binding,
    );
    const workingDirectory = await assertManagedWorkspace(
      sessionRole(current.role),
      current.working_directory,
    );
    const assignment = await this.store.resumeAssignment(input);
    return this.launch(
      {
        ...assignment,
        working_directory: workingDirectory,
      },
      current.session_id ?? undefined,
    );
  }

  async retry(input: RetryAssignmentInput): Promise<AssignmentRecord> {
    const current = await this.store.getAssignment(
      input.run_id,
      input.assignment_id,
    );
    await this.assertBindingCurrentOrPause(
      input.run_id,
      current.model_binding,
    );
    const workingDirectory = await assertManagedWorkspace(
      sessionRole(current.role),
      current.working_directory,
    );
    const assignment = await this.store.retryAssignment(input);
    return this.launch({
      ...assignment,
      working_directory: workingDirectory,
    });
  }

  async correct(input: CorrectAssignmentInput): Promise<AssignmentRecord> {
    const current = await this.store.getAssignment(
      input.run_id,
      input.assignment_id,
    );
    await this.assertBindingCurrentOrPause(
      input.run_id,
      current.model_binding,
    );
    const workingDirectory = await assertManagedWorkspace(
      sessionRole(current.role),
      current.working_directory,
    );
    const resumeSessionId = current.session_id;
    if (resumeSessionId === null) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "Correction requires a resumable managed session",
      );
    }
    const assignment = await this.store.correctAssignment(input);
    return this.launch(
      {
        ...assignment,
        working_directory: workingDirectory,
      },
      resumeSessionId,
    );
  }

  async requestRetry(
    input: RequestAssignmentRetryInput,
  ): Promise<AssignmentRecord> {
    return this.store.requestAssignmentRetry(input);
  }

  async decideRetry(
    runId: string,
    assignmentId: string,
    retryRequestId: string,
    decision: RetryDecision,
  ): Promise<AssignmentRecord> {
    if (decision !== "retry_once" && decision !== "cancel_run") {
      throw new ArkTeamError("INVALID_INPUT", "invalid retry decision");
    }
    const current = await this.store.getAssignment(runId, assignmentId);
    if (
      current.state !== "waiting_user" ||
      current.pending_retry?.retry_request_id !== retryRequestId
    ) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "retry_request_id is unknown or already resolved",
      );
    }
    if (decision === "retry_once") {
      return current.pending_retry.mode === "fresh_session"
        ? this.retry({
            run_id: runId,
            assignment_id: assignmentId,
            retry_request_id: retryRequestId,
          })
        : this.correct({
            run_id: runId,
            assignment_id: assignmentId,
            assignment: current.assignment,
            retry_request_id: retryRequestId,
          });
    }

    await this.stopRun(
      runId,
      "cancelled",
      "User cancelled the run after retry exhaustion",
    );
    await this.store.cancelRun(
      runId,
      "User cancelled the run after retry exhaustion",
    );
    return this.store.getAssignment(runId, assignmentId);
  }

  async decide(
    runId: string,
    assignmentId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<AssignmentRecord> {
    if (!isApprovalDecision(decision)) {
      throw new ArkTeamError("INVALID_INPUT", "invalid approval decision");
    }
    const assignment = await this.store.getAssignment(runId, assignmentId);
    if (
      assignment.state !== "waiting_user" ||
      assignment.pending_approval?.approval_id !== approvalId
    ) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "approval_id is unknown or already resolved",
      );
    }
    await this.assertBindingCurrentOrPause(
      runId,
      assignment.model_binding,
    );
    const live = this.liveAssignments.get(assignmentId);
    if (!live || live.run_id !== runId) {
      throw new ArkTeamError(
        "AGENT_SESSION_UNAVAILABLE",
        "The approval is persisted but its live app-server session is unavailable",
      );
    }

    try {
      await this.store.recordAssignmentApprovalResolution(
        runId,
        assignmentId,
        {
          approval_id: approvalId,
          decision,
          source: "user",
        },
      );
      const update = await live.session.decide(approvalId, decision);
      const persisted = await this.persistAndResolveRoutineApprovals(
        assignment,
        live.session,
        update,
      );
      if (persisted.state !== "waiting_user") {
        this.deleteLiveAssignment(assignmentId, live.session);
      } else {
        live.session.armWaitingMonitor?.();
      }
      return persisted;
    } catch (error) {
      if (this.deleteLiveAssignment(assignmentId, live.session)) {
        await closeSession(live.session);
      }
      const normalized =
        error instanceof ArkTeamError && error.code === "INVALID_INPUT"
          ? sessionFailure(
              "Live approval session rejected its persisted pending request",
              error,
            )
          : normalizeSessionFailure(error);
      await this.recordSessionFailure(assignment, normalized);
      throw normalized;
    }
  }

  async recoverApproval(
    runId: string,
    assignmentId: string,
    approvalId: string,
    decision: ApprovalRecoveryDecision,
  ): Promise<AssignmentRecord> {
    if (decision !== "resume_safely" && decision !== "cancel_run") {
      throw new ArkTeamError("INVALID_INPUT", "invalid recovery decision");
    }
    const current = await this.store.getAssignment(runId, assignmentId);
    if (
      current.state !== "waiting_user" ||
      current.pending_approval?.approval_id !== approvalId
    ) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "approval_id is unknown or already resolved",
      );
    }
    if (this.liveAssignments.has(assignmentId)) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "live approvals must use the ordinary assignment decision operation",
      );
    }
    if (decision === "cancel_run") {
      await this.store.cancelOrphanedApproval(
        runId,
        assignmentId,
        approvalId,
      );
      await this.stopRun(
        runId,
        "cancelled",
        "User cancelled the run during approval recovery",
      );
      await this.store.cancelRun(
        runId,
        "User cancelled the run during approval recovery",
      );
      return this.store.getAssignment(runId, assignmentId);
    }
    await this.assertBindingCurrentOrPause(
      runId,
      current.model_binding,
    );

    if (current.session_id === null) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "orphaned approval has no resumable managed thread",
      );
    }
    const workingDirectory = await assertManagedWorkspace(
      sessionRole(current.role),
      current.working_directory,
    );
    const recovered = await this.store.recoverOrphanedApproval({
      run_id: runId,
      assignment_id: assignmentId,
      approval_id: approvalId,
      assignment: buildApprovalRecoveryAssignment(current),
    });
    return this.launch(
      {
        ...recovered,
        working_directory: workingDirectory,
      },
      current.session_id,
    );
  }

  async get(runId: string, assignmentId: string): Promise<AssignmentRecord> {
    return this.store.getAssignment(runId, assignmentId);
  }

  async list(
    runId: string,
    input: ListAssignmentsInput = {},
  ): Promise<AssignmentListResult> {
    return this.store.listAssignments(runId, input);
  }

  async cancel(
    runId: string,
    assignmentId: string,
    reason?: string,
  ): Promise<AssignmentRecord> {
    const current = await this.store.getAssignment(runId, assignmentId);
    if (current.pending_retry !== null) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "Use the current retry_request_id to choose retry_once or cancel_run",
      );
    }
    const candidate = this.liveAssignments.get(assignmentId);
    const live = candidate?.run_id === runId ? candidate : undefined;
    if (live) {
      this.deleteLiveAssignment(assignmentId, live.session);
    }
    try {
      return await this.store.stopAssignment(
        runId,
        assignmentId,
        "cancelled",
        reason,
      );
    } finally {
      await closeSession(live?.session);
    }
  }

  async stopRun(
    runId: string,
    state: "paused" | "cancelled",
    reason?: string,
  ): Promise<AssignmentRecord[]> {
    const live = [...this.liveAssignments.entries()].filter(
      ([, assignment]) => assignment.run_id === runId,
    );
    for (const [assignmentId, assignment] of live) {
      this.deleteLiveAssignment(assignmentId, assignment.session);
    }
    try {
      return await this.store.stopActiveAssignments(runId, state, reason);
    } finally {
      await Promise.all(
        live.map(async ([, assignment]) => closeSession(assignment.session)),
      );
    }
  }

  hasLiveSession(assignmentId: string): boolean {
    return this.liveAssignments.has(assignmentId);
  }

  private async launch(
    assignment: AssignmentRecord,
    resumeSessionId?: string,
  ): Promise<AssignmentRecord> {
    await this.assertBindingCurrentOrPause(
      assignment.run_id,
      assignment.model_binding,
    );
    let session: ApprovalSessionHandle;
    let bridge: ProviderBridge | undefined;
    try {
      if (this.sessionFactory !== null) {
        session = this.sessionFactory(assignment);
      } else {
        const run = await this.store.getRun(assignment.run_id);
        const providerSensitiveEnvironmentNames =
          await this.store.providerSensitiveEnvironmentNames(
            run.model_bindings.worker,
          );
        if (assignment.model_binding.kind === "external") {
          const bridgeOptions: ProviderBridgeOptions = {
            binding: assignment.model_binding,
            environment: this.providerEnvironment,
            request_timeout_ms:
              run.project_config.execution.agent_timeout_minutes *
              60_000,
            codex_home: path.join(
              this.store.root_path,
              assignment.run_id,
              "external-codex-home",
            ),
            ...(this.providerFetch === undefined
              ? {}
              : { fetch_impl: this.providerFetch }),
          };
          bridge = await ProviderBridge.start(bridgeOptions);
          await this.store.recordProviderBridgeStarted(
            assignment.run_id,
            assignment.assignment_id,
            bridge.diagnostics.port,
          );
        }
        const appServerSession = new AppServerApprovalSession({
          codex_path: this.codexPath,
          timeout_ms:
            run.project_config.execution.agent_timeout_minutes * 60_000,
          ...(providerSensitiveEnvironmentNames.length === 0
            ? {}
            : {
                provider_sensitive_env_names:
                  providerSensitiveEnvironmentNames,
              }),
          ...(bridge === undefined
            ? {}
            : { external_runtime: bridge.external_runtime }),
        });
        session =
          bridge === undefined
            ? appServerSession
            : new ProviderBridgeSession(
                appServerSession,
                bridge,
                async (failedSession, error) =>
                  this.handleWaitingSessionFailure(
                    assignment,
                    failedSession,
                    error,
                  ),
              );
      }
    } catch (error) {
      await bridge?.close();
      if (isProviderDrift(error)) {
        await this.pauseForProviderDrift(assignment.run_id);
        throw error;
      }
      await this.recordSessionFailure(assignment, error);
      if (isExternalProviderError(error)) {
        throw error;
      }
      throw sessionFailure("Unable to create a managed assignment session", error);
    }
    this.liveAssignments.set(assignment.assignment_id, {
      run_id: assignment.run_id,
      session,
    });

    try {
      const update = await session.start({
        role: sessionRole(assignment.role),
        assignment: assignment.assignment,
        working_directory: assignment.working_directory,
        ...(resumeSessionId === undefined
          ? {}
          : { resume_session_id: resumeSessionId }),
        ...(assignment.output_contract === null
          ? {}
          : { output_contract: assignment.output_contract }),
        model_binding: assignment.model_binding,
      });
      const persisted = await this.persistAndResolveRoutineApprovals(
        assignment,
        session,
        update,
      );
      if (persisted.state !== "waiting_user") {
        this.deleteLiveAssignment(assignment.assignment_id, session);
      } else {
        session.armWaitingMonitor?.();
      }
      return persisted;
    } catch (error) {
      if (this.deleteLiveAssignment(assignment.assignment_id, session)) {
        await closeSession(session);
      }
      if (isProviderDrift(error)) {
        await this.pauseForProviderDrift(assignment.run_id);
        throw error;
      }
      await this.recordSessionFailure(assignment, error);
      throw normalizeSessionFailure(error);
    }
  }

  private async persistAndResolveRoutineApprovals(
    assignment: AssignmentRecord,
    session: ApprovalSessionHandle,
    firstUpdate: ApprovalSessionUpdate,
  ): Promise<AssignmentRecord> {
    let update = firstUpdate;
    let persisted = await this.store.recordAssignmentUpdate(
      assignment.run_id,
      assignment.assignment_id,
      update,
    );
    while (
      update.status === "waiting_user" &&
      persisted.state === "waiting_user" &&
      persisted.pending_approval !== null
    ) {
      const teams = (await this.store.listTeams(assignment.run_id)).teams;
      if (
        !isRoutineCommandApproval({
          assignment: persisted,
          approval: persisted.pending_approval,
          teams,
        })
      ) {
        break;
      }
      const approvalId = persisted.pending_approval.approval_id;
      await this.store.recordAssignmentApprovalResolution(
        assignment.run_id,
        assignment.assignment_id,
        {
          approval_id: approvalId,
          decision: "approve_once",
          source: "routine_policy",
        },
      );
      update = await session.decide(approvalId, "approve_once");
      persisted = await this.store.recordAssignmentUpdate(
        assignment.run_id,
        assignment.assignment_id,
        update,
      );
    }
    return persisted;
  }

  private deleteLiveAssignment(
    assignmentId: string,
    session: ApprovalSessionHandle,
  ): boolean {
    if (this.liveAssignments.get(assignmentId)?.session === session) {
      this.liveAssignments.delete(assignmentId);
      return true;
    }
    return false;
  }

  private async handleWaitingSessionFailure(
    assignment: AssignmentRecord,
    session: ApprovalSessionHandle,
    error: ArkTeamError,
  ): Promise<void> {
    const live = this.liveAssignments.get(assignment.assignment_id);
    if (
      live?.run_id !== assignment.run_id ||
      live.session !== session
    ) {
      return;
    }
    this.liveAssignments.delete(assignment.assignment_id);
    await closeSession(session);
    await this.recordSessionFailure(
      assignment,
      normalizeSessionFailure(error),
    );
  }

  private async recordSessionFailure(
    assignment: AssignmentRecord,
    error: unknown,
  ): Promise<void> {
    let current: AssignmentRecord;
    try {
      current = await this.store.getAssignment(
        assignment.run_id,
        assignment.assignment_id,
      );
    } catch {
      return;
    }
    if (current.state !== "running" && current.state !== "waiting_user") {
      return;
    }
    const message =
      error instanceof Error ? error.message : "Managed assignment session failed";
    await this.store.failAssignment(
      assignment.run_id,
      assignment.assignment_id,
      message,
      error instanceof ArkTeamError ? error.code : undefined,
    );
  }

  private async assertBindingCurrentOrPause(
    runId: string,
    binding: AssignmentRecord["model_binding"],
  ): Promise<void> {
    if (binding.kind === "native") {
      return;
    }
    try {
      await assertExternalBindingCurrent(binding, {
        environment: this.providerEnvironment,
      });
    } catch (error) {
      if (
        isProviderDrift(error)
      ) {
        await this.pauseForProviderDrift(runId);
      }
      throw error;
    }
  }

  private async pauseForProviderDrift(runId: string): Promise<void> {
    const reason =
      "External provider configuration changed; the run was paused before continuing";
    await this.stopRun(runId, "paused", reason);
    const run = await this.store.getRun(runId);
    if (run.state !== "paused") {
      await this.store.pauseRun(runId, reason);
    }
  }
}

class ProviderBridgeSession implements ApprovalSessionHandle {
  private closed = false;
  private waitingMonitorArmed = false;
  private pendingTerminalFailure: ArkTeamError | null = null;
  private removeTerminalFailureListener: (() => void) | null;

  constructor(
    private readonly session: AppServerApprovalSession,
    private readonly bridge: ProviderBridge,
    private readonly onWaitingFailure: (
      session: ProviderBridgeSession,
      error: ArkTeamError,
    ) => Promise<void>,
  ) {
    this.removeTerminalFailureListener = this.session.onTerminalFailure(
      (error) => {
        this.pendingTerminalFailure =
          this.bridge.currentTerminalError() ?? error;
        this.dispatchWaitingFailure();
      },
    );
  }

  async start(
    request: ApprovalSessionRequest,
  ): Promise<ApprovalSessionUpdate> {
    return this.run(() => this.session.start(request));
  }

  async decide(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    return this.run(() => this.session.decide(approvalId, decision));
  }

  armWaitingMonitor(): void {
    if (this.closed) {
      return;
    }
    this.waitingMonitorArmed = true;
    this.dispatchWaitingFailure();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.waitingMonitorArmed = false;
    this.pendingTerminalFailure = null;
    this.removeTerminalFailureListener?.();
    this.removeTerminalFailureListener = null;
    try {
      await this.session.close();
    } finally {
      await this.bridge.close();
    }
  }

  private async run(
    operation: () => Promise<ApprovalSessionUpdate>,
  ): Promise<ApprovalSessionUpdate> {
    this.waitingMonitorArmed = false;
    this.pendingTerminalFailure = null;
    try {
      const update = await operation();
      if (update.status === "completed") {
        await this.close();
      }
      return update;
    } catch (error) {
      const terminal = this.bridge.currentTerminalError();
      await this.close();
      throw terminal ?? error;
    }
  }

  private dispatchWaitingFailure(): void {
    if (
      this.closed ||
      !this.waitingMonitorArmed ||
      this.pendingTerminalFailure === null
    ) {
      return;
    }
    const error = this.pendingTerminalFailure;
    this.pendingTerminalFailure = null;
    this.waitingMonitorArmed = false;
    try {
      void this.onWaitingFailure(this, error).catch(() => {});
    } catch {
      // Detached lifecycle handling must never surface an unhandled error.
    }
  }
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return (
    value === "approve_once" ||
    value === "approve_session" ||
    value === "decline" ||
    value === "cancel"
  );
}

function buildApprovalRecoveryAssignment(
  assignment: AssignmentRecord,
): string {
  return [
    "Controller-restart recovery turn.",
    `Run: ${assignment.run_id}`,
    `Assignment: ${assignment.assignment_id}`,
    `Role: ${assignment.role}`,
    `Previous request kind: ${assignment.pending_approval?.kind ?? "unknown"}`,
    "The previous app-server approval channel was lost. Its approval was NOT applied, declined, or transferred to this turn.",
    "Re-inspect the current worktree and continue the bounded assignment safely.",
    "If the dangerous action is still necessary, surface a fresh approval request and wait for a new user decision.",
    "Do not infer approval from this recovery turn or reuse the previous request.",
    `Original bounded assignment:\n${assignment.assignment}`,
  ].join("\n");
}

function sessionRole(role: AssignmentRole): "pl" | "worker" {
  return role === "integration_pl" ? "pl" : role;
}

function normalizeSessionFailure(error: unknown): ArkTeamError {
  if (error instanceof ArkTeamError) {
    return error;
  }
  return sessionFailure("Managed assignment session failed", error);
}

function isProviderDrift(error: unknown): error is ArkTeamError {
  return (
    error instanceof ArkTeamError &&
    error.code === "PROVIDER_CONFIG_DRIFT"
  );
}

function isExternalProviderError(
  error: unknown,
): error is ArkTeamError {
  return (
    error instanceof ArkTeamError &&
    (error.code.startsWith("PROVIDER_") ||
      error.code.startsWith("ADAPTER_"))
  );
}

function sessionFailure(message: string, cause: unknown): ArkTeamError {
  return new ArkTeamError("AGENT_SESSION_FAILED", message, { cause });
}

async function closeSession(
  session: ApprovalSessionHandle | undefined,
): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await session.close();
  } catch {
    // The persisted stop state remains authoritative even if process cleanup fails.
  }
}
