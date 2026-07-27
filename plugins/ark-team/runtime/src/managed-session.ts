import {
  AppServerApprovalSession,
  type ApprovalSessionOptions,
  type ApprovalSessionRequest,
  type ApprovalSessionUpdate,
} from "./approval-session.js";
import { ArkTeamError } from "./errors.js";
import {
  assertManagedWorkspace,
  isManagedRole,
  managedRoleProfiles,
  type ManagedSessionRequest,
  type ManagedSessionResult,
} from "./managed-role.js";
import {
  assertManagedOutputContractRole,
  parseManagedOutput,
} from "./role-contracts.js";

export * from "./managed-role.js";

export interface ManagedAppServerSession {
  start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate>;
  close(): Promise<void>;
}

export interface ManagedSessionLauncherOptions {
  codex_path?: string;
  timeout_ms?: number;
  session_factory?: (options: ApprovalSessionOptions) => ManagedAppServerSession;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

export class ManagedCodexSessionLauncher {
  private readonly codexPath: string;
  private readonly timeoutMs: number;
  private readonly sessionFactory: (
    options: ApprovalSessionOptions,
  ) => ManagedAppServerSession;

  constructor(options: ManagedSessionLauncherOptions = {}) {
    this.codexPath = options.codex_path ?? "codex";
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new ArkTeamError("INVALID_INPUT", "timeout_ms must be a positive integer");
    }
    this.sessionFactory =
      options.session_factory ??
      ((sessionOptions) => new AppServerApprovalSession(sessionOptions));
  }

  async run(request: ManagedSessionRequest): Promise<ManagedSessionResult> {
    if (!isManagedRole(request.role)) {
      throw new ArkTeamError("INVALID_INPUT", "role must be pm, pl, or worker");
    }

    const assignment = request.assignment.trim();
    if (!assignment) {
      throw new ArkTeamError("INVALID_INPUT", "assignment must not be empty");
    }
    const workingDirectory = await assertManagedWorkspace(
      request.role,
      request.working_directory,
    );
    if (request.output_contract !== undefined) {
      assertManagedOutputContractRole(request.role, request.output_contract);
    }
    const resumeSessionId = request.resume_session_id?.trim();
    if (request.resume_session_id !== undefined && !resumeSessionId) {
      throw new ArkTeamError("INVALID_INPUT", "resume_session_id must not be empty");
    }
    const timeoutMs = request.timeout_ms ?? this.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "request timeout_ms must be a positive integer",
      );
    }

    const session = this.sessionFactory({
      codex_path: this.codexPath,
      timeout_ms: timeoutMs,
    });
    let update: ApprovalSessionUpdate;
    try {
      update = await session.start({
        role: request.role,
        assignment,
        working_directory: workingDirectory,
        ...(resumeSessionId === undefined
          ? {}
          : { resume_session_id: resumeSessionId }),
        ...(request.output_contract === undefined
          ? {}
          : { output_contract: request.output_contract }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (error instanceof ArkTeamError) {
        throw error;
      }
      throw new ArkTeamError("AGENT_SESSION_FAILED", "Managed Codex session failed", {
        cause: error,
      });
    }

    if (update.status === "waiting_user") {
      await session.close();
      throw new ArkTeamError(
        "AGENT_SESSION_FAILED",
        "Managed session requires an interactive approval; use the assignment scheduler",
      );
    }

    const profile = managedRoleProfiles[request.role];
    if (
      update.role !== request.role ||
      update.agent_name !== profile.agent_name ||
      update.model !== profile.model ||
      update.model_reasoning_effort !== profile.model_reasoning_effort ||
      update.sandbox_mode !== profile.sandbox_mode ||
      update.approval_policy !== profile.approval_policy ||
      !update.session_id.trim() ||
      !update.final_report.trim() ||
      (resumeSessionId !== undefined && update.session_id !== resumeSessionId)
    ) {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "Managed app-server result does not match the requested role profile",
      );
    }

    const structuredReport =
      request.output_contract === undefined
        ? undefined
        : parseManagedOutput(request.output_contract, update.final_report);

    return {
      session_id: update.session_id,
      role: request.role,
      agent_name: profile.agent_name,
      model: profile.model,
      model_reasoning_effort: profile.model_reasoning_effort,
      sandbox_mode: profile.sandbox_mode,
      requested_approval_policy: profile.approval_policy,
      final_report: update.final_report,
      ...(structuredReport === undefined
        ? {}
        : { structured_report: structuredReport }),
      usage: update.usage,
    };
  }
}
