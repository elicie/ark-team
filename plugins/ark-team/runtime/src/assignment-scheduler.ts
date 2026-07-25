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
import {
  type CreateAssignmentInput,
  type CorrectAssignmentInput,
  type ListAssignmentsInput,
  type RequestAssignmentRetryInput,
  type ResumeAssignmentInput,
  type RetryAssignmentInput,
  RunStore,
} from "./state-store.js";

export interface ApprovalSessionHandle {
  start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate>;
  decide(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate>;
  close(): Promise<void>;
}

export interface ManagedAssignmentSchedulerOptions {
  session_factory?: (assignment: AssignmentRecord) => ApprovalSessionHandle;
  codex_path?: string;
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

  constructor(
    private readonly store: RunStore,
    options: ManagedAssignmentSchedulerOptions = {},
  ) {
    this.sessionFactory = options.session_factory ?? null;
    this.codexPath =
      options.codex_path ??
      (process.env.ARK_TEAM_CODEX_PATH?.trim() || undefined) ??
      "codex";
  }

  async start(input: CreateAssignmentInput): Promise<AssignmentRecord> {
    const workingDirectory = await assertManagedWorkspace(
      sessionRole(input.role),
      input.working_directory,
    );
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
    const live = this.liveAssignments.get(assignmentId);
    if (!live || live.run_id !== runId) {
      throw new ArkTeamError(
        "AGENT_SESSION_UNAVAILABLE",
        "The approval is persisted but its live app-server session is unavailable",
      );
    }

    try {
      const update = await live.session.decide(approvalId, decision);
      const persisted = await this.store.recordAssignmentUpdate(
        runId,
        assignmentId,
        update,
        {
          approval_id: approvalId,
          decision,
        },
      );
      if (persisted.state !== "waiting_user") {
        this.liveAssignments.delete(assignmentId);
      }
      return persisted;
    } catch (error) {
      if (error instanceof ArkTeamError && error.code === "INVALID_INPUT") {
        throw error;
      }
      this.liveAssignments.delete(assignmentId);
      await this.recordSessionFailure(assignment, error);
      throw normalizeSessionFailure(error);
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
    const live = this.liveAssignments.get(assignmentId);
    this.liveAssignments.delete(assignmentId);
    const assignment = await this.store.stopAssignment(
      runId,
      assignmentId,
      "cancelled",
      reason,
    );
    await closeSession(live?.session);
    return assignment;
  }

  async stopRun(
    runId: string,
    state: "paused" | "cancelled",
    reason?: string,
  ): Promise<AssignmentRecord[]> {
    const active = (
      await this.store.listAssignments(runId, {
        states: ["running", "waiting_user"],
      })
    ).assignments;
    const sessions: ApprovalSessionHandle[] = [];
    for (const assignment of active) {
      const live = this.liveAssignments.get(assignment.assignment_id);
      if (live?.run_id === runId) {
        sessions.push(live.session);
      }
      this.liveAssignments.delete(assignment.assignment_id);
    }
    const stopped = await this.store.stopActiveAssignments(runId, state, reason);
    await Promise.all(sessions.map(async (session) => closeSession(session)));
    return stopped;
  }

  hasLiveSession(assignmentId: string): boolean {
    return this.liveAssignments.has(assignmentId);
  }

  private async launch(
    assignment: AssignmentRecord,
    resumeSessionId?: string,
  ): Promise<AssignmentRecord> {
    let session: ApprovalSessionHandle;
    try {
      if (this.sessionFactory !== null) {
        session = this.sessionFactory(assignment);
      } else {
        const run = await this.store.getRun(assignment.run_id);
        session = new AppServerApprovalSession({
          codex_path: this.codexPath,
          timeout_ms:
            run.project_config.execution.agent_timeout_minutes * 60_000,
        });
      }
    } catch (error) {
      await this.recordSessionFailure(assignment, error);
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
      });
      const persisted = await this.store.recordAssignmentUpdate(
        assignment.run_id,
        assignment.assignment_id,
        update,
      );
      if (persisted.state !== "waiting_user") {
        this.liveAssignments.delete(assignment.assignment_id);
      }
      return persisted;
    } catch (error) {
      this.liveAssignments.delete(assignment.assignment_id);
      await this.recordSessionFailure(assignment, error);
      throw normalizeSessionFailure(error);
    }
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
    );
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
