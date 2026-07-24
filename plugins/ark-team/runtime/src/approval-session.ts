import { randomUUID } from "node:crypto";

import type { Usage } from "@openai/codex-sdk";
import { z } from "zod/v4";

import {
  type AppServerMessage,
  type AppServerProtocolClient,
  type JsonRpcId,
  StdioAppServerClient,
} from "./app-server-client.js";
import { ArkTeamError } from "./errors.js";
import {
  assertManagedWorkspace,
  buildManagedPrompt,
  managedCodexConfig,
  managedRoleProfiles,
  type ManagedRole,
} from "./managed-session.js";

export type ApprovalDecision =
  | "approve_once"
  | "approve_session"
  | "decline"
  | "cancel";

export interface ApprovalSessionRequest {
  role: ManagedRole;
  assignment: string;
  working_directory: string;
  signal?: AbortSignal;
}

export interface PendingApproval {
  approval_id: string;
  kind: "command" | "file_change" | "permissions";
  reason: string | null;
  command?: string;
  cwd?: string;
  grant_root?: string;
  requested_permissions?: unknown;
}

export interface ApprovalWaitingUpdate {
  status: "waiting_user";
  session_id: string;
  turn_id: string;
  role: Exclude<ManagedRole, "pm">;
  approval: PendingApproval;
}

export interface ApprovalCompletedUpdate {
  status: "completed";
  session_id: string;
  turn_id: string;
  role: Exclude<ManagedRole, "pm">;
  agent_name: "ark_pl" | "ark_worker";
  model: "gpt-5.6-terra" | "gpt-5.6-luna";
  model_reasoning_effort: "xhigh";
  sandbox_mode: "workspace-write";
  approval_policy: "on-request";
  final_report: string;
  usage: Usage;
}

export type ApprovalSessionUpdate = ApprovalWaitingUpdate | ApprovalCompletedUpdate;

export interface ApprovalSessionOptions {
  client?: AppServerProtocolClient;
  codex_path?: string;
  timeout_ms?: number;
}

interface WireApproval {
  public_id: string;
  wire_id: JsonRpcId;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval";
  requested_permissions?: RequestedPermissions;
}

interface RequestedPermissions {
  network: unknown | null;
  fileSystem: unknown | null;
}

interface UpdateWaiter {
  resolve: (update: ApprovalSessionUpdate) => void;
  reject: (error: ArkTeamError) => void;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const INTERRUPT_GRACE_MS = 2000;

const threadStartResponseSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
  }),
  model: z.string().min(1),
  approvalPolicy: z.literal("on-request"),
  approvalsReviewer: z.literal("user"),
  sandbox: z.object({
    type: z.literal("workspaceWrite"),
  }),
  reasoningEffort: z.literal("xhigh"),
});

const turnStartResponseSchema = z.object({
  turn: z.object({
    id: z.string().min(1),
  }),
});

const requestIdSchema = z.union([z.string(), z.number()]);

const commandApprovalSchema = z.object({
  id: requestIdSchema,
  method: z.literal("item/commandExecution/requestApproval"),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1),
    reason: z.string().nullable().optional(),
    command: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
  }),
});

const fileApprovalSchema = z.object({
  id: requestIdSchema,
  method: z.literal("item/fileChange/requestApproval"),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1),
    reason: z.string().nullable().optional(),
    grantRoot: z.string().nullable().optional(),
  }),
});

const permissionApprovalSchema = z.object({
  id: requestIdSchema,
  method: z.literal("item/permissions/requestApproval"),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    itemId: z.string().min(1),
    cwd: z.string().min(1),
    reason: z.string().nullable(),
    permissions: z.object({
      network: z.unknown().nullable(),
      fileSystem: z.unknown().nullable(),
    }),
  }),
});

const itemCompletedSchema = z.object({
  method: z.literal("item/completed"),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    item: z.object({
      type: z.string(),
    }).passthrough(),
  }),
});

const tokenUsageSchema = z.object({
  method: z.literal("thread/tokenUsage/updated"),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    tokenUsage: z.object({
      last: z.object({
        inputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative(),
        cacheWriteInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        reasoningOutputTokens: z.number().int().nonnegative(),
      }),
    }),
  }),
});

const turnCompletedSchema = z.object({
  method: z.literal("turn/completed"),
  params: z.object({
    threadId: z.string().min(1),
    turn: z.object({
      id: z.string().min(1),
      status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
      error: z
        .object({
          message: z.string().optional(),
        })
        .nullable()
        .optional(),
      items: z.array(z.unknown()).optional(),
    }),
  }),
});

const modelReroutedSchema = z.object({
  method: z.literal("model/rerouted"),
  params: z.object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    fromModel: z.string().min(1),
    toModel: z.string().min(1),
  }),
});

export class AppServerApprovalSession {
  private readonly suppliedClient: AppServerProtocolClient | undefined;
  private readonly codexPath: string;
  private readonly timeoutMs: number;
  private client: AppServerProtocolClient | null = null;
  private role: Exclude<ManagedRole, "pm"> | null = null;
  private sessionId: string | null = null;
  private turnId: string | null = null;
  private pendingApproval: WireApproval | null = null;
  private finalReport = "";
  private usage: Usage | null = null;
  private updateQueue: ApprovalSessionUpdate[] = [];
  private updateWaiters: UpdateWaiter[] = [];
  private failure: ArkTeamError | null = null;
  private started = false;
  private terminal = false;
  private timeout: NodeJS.Timeout | null = null;
  private removeAbortListener: (() => void) | null = null;
  private removeMessageListener: (() => void) | null = null;
  private removeFailureListener: (() => void) | null = null;
  private cleanupPromise: Promise<void> | null = null;

  constructor(options: ApprovalSessionOptions = {}) {
    this.suppliedClient = options.client;
    this.codexPath = options.codex_path ?? "codex";
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new ArkTeamError("INVALID_INPUT", "timeout_ms must be a positive integer");
    }
  }

  async start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    if (this.started) {
      throw new ArkTeamError("INVALID_INPUT", "approval session has already started");
    }
    this.started = true;
    if (request.role === "pm") {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "PM remains on the read-only SDK backend and cannot use the writer approval gateway",
      );
    }
    if (request.role !== "pl" && request.role !== "worker") {
      throw new ArkTeamError("INVALID_INPUT", "role must be pl or worker");
    }
    const assignment = request.assignment.trim();
    if (!assignment) {
      throw new ArkTeamError("INVALID_INPUT", "assignment must not be empty");
    }
    if (request.signal?.aborted) {
      throw new ArkTeamError(
        "AGENT_SESSION_FAILED",
        "Approval-gated Codex session was cancelled before it started",
      );
    }
    const workingDirectory = await assertManagedWorkspace(
      request.role,
      request.working_directory,
    );
    this.role = request.role;
    this.client = this.suppliedClient ?? new StdioAppServerClient({ codex_path: this.codexPath });
    this.removeMessageListener = this.client.onMessage((message) => {
      this.handleMessage(message);
    });
    this.removeFailureListener = this.client.onFailure((error) => {
      this.fail("Codex app-server connection failed", error);
      void this.cleanup();
    });
    this.startDeadline(request.signal);

    const profile = managedRoleProfiles[request.role];
    try {
      await this.client.request("initialize", {
        clientInfo: {
          name: "ark_team",
          title: "Ark Team",
          version: "0.1.0",
        },
        capabilities: null,
      });
      this.client.notify("initialized");

      const threadResponse = threadStartResponseSchema.parse(
        await this.client.request("thread/start", {
          model: profile.model,
          cwd: workingDirectory,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          config: {
            ...managedCodexConfig,
            model_reasoning_effort: profile.model_reasoning_effort,
            web_search: "disabled",
            sandbox_workspace_write: {
              network_access: false,
            },
          },
          developerInstructions: profile.instructions,
          ephemeral: false,
        }),
      );
      if (threadResponse.model !== profile.model) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `app-server selected ${threadResponse.model} instead of ${profile.model}`,
        );
      }
      this.sessionId = threadResponse.thread.id;

      const turnResponse = turnStartResponseSchema.parse(
        await this.client.request("turn/start", {
          threadId: this.sessionId,
          input: [
            {
              type: "text",
              text: buildManagedPrompt(request.role, assignment),
              text_elements: [],
            },
          ],
          cwd: workingDirectory,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          model: profile.model,
          effort: profile.model_reasoning_effort,
        }),
      );
      this.turnId = turnResponse.turn.id;
    } catch (error) {
      await this.closeAfterFailure("Unable to start approval-gated Codex session", error);
    }

    return this.nextUpdate();
  }

  async decide(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    if (!this.client || !this.pendingApproval || this.terminal) {
      throw new ArkTeamError("INVALID_INPUT", "no approval is currently pending");
    }
    if (this.pendingApproval.public_id !== approvalId) {
      throw new ArkTeamError("INVALID_INPUT", "approval_id is unknown or already resolved");
    }
    if (!isApprovalDecision(decision)) {
      throw new ArkTeamError("INVALID_INPUT", "invalid approval decision");
    }

    const pending = this.pendingApproval;
    const response = approvalResponse(pending, decision);
    try {
      this.client.respond(pending.wire_id, response);
    } catch (error) {
      this.fail("Unable to deliver the approval decision", error);
      await this.cleanup();
      throw (
        this.failure ??
        new ArkTeamError("AGENT_SESSION_FAILED", "Unable to deliver the approval decision", {
          cause: error,
        })
      );
    }
    this.pendingApproval = null;
    return this.nextUpdate();
  }

  async close(): Promise<void> {
    if (this.terminal) {
      await this.cleanupPromise;
      return;
    }
    const client = this.client;
    const threadId = this.sessionId;
    const turnId = this.turnId;
    if (client && threadId && turnId) {
      await boundedInterrupt(client, threadId, turnId);
    }
    this.fail("Approval-gated Codex session was cancelled");
    await this.cleanup();
  }

  private handleMessage(message: AppServerMessage): void {
    if (this.terminal || !message.method) {
      return;
    }
    try {
      if (
        message.method === "item/commandExecution/requestApproval" ||
        message.method === "item/fileChange/requestApproval" ||
        message.method === "item/permissions/requestApproval"
      ) {
        this.handleApprovalRequest(message);
        return;
      }
      if (message.method === "item/completed") {
        this.handleItemCompleted(message);
        return;
      }
      if (message.method === "thread/tokenUsage/updated") {
        this.handleUsage(message);
        return;
      }
      if (message.method === "turn/completed") {
        this.handleTurnCompleted(message);
        return;
      }
      if (message.method === "model/rerouted") {
        const parsed = modelReroutedSchema.parse(message);
        this.assertActiveTurn(parsed.params.threadId, parsed.params.turnId);
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `app-server rerouted ${parsed.params.fromModel} to ${parsed.params.toModel}`,
        );
      }
      if (message.id !== undefined) {
        this.client?.respondError(message.id, -32601, "Unsupported app-server request");
        this.fail(`Unsupported app-server request: ${message.method}`);
        void this.cleanup();
      }
    } catch (error) {
      this.fail("Invalid app-server protocol message", error);
      void this.cleanup();
    }
  }

  private handleApprovalRequest(message: AppServerMessage): void {
    if (this.pendingApproval) {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "app-server emitted more than one unresolved approval",
      );
    }

    let approval: PendingApproval;
    let wire: WireApproval;
    if (message.method === "item/commandExecution/requestApproval") {
      const parsed = commandApprovalSchema.parse(message);
      this.assertActiveTurn(parsed.params.threadId, parsed.params.turnId);
      const publicId = randomUUID();
      approval = {
        approval_id: publicId,
        kind: "command",
        reason: parsed.params.reason ?? null,
        ...(parsed.params.command ? { command: parsed.params.command } : {}),
        ...(parsed.params.cwd ? { cwd: parsed.params.cwd } : {}),
      };
      wire = {
        public_id: publicId,
        wire_id: parsed.id,
        method: parsed.method,
      };
    } else if (message.method === "item/fileChange/requestApproval") {
      const parsed = fileApprovalSchema.parse(message);
      this.assertActiveTurn(parsed.params.threadId, parsed.params.turnId);
      const publicId = randomUUID();
      approval = {
        approval_id: publicId,
        kind: "file_change",
        reason: parsed.params.reason ?? null,
        ...(parsed.params.grantRoot ? { grant_root: parsed.params.grantRoot } : {}),
      };
      wire = {
        public_id: publicId,
        wire_id: parsed.id,
        method: parsed.method,
      };
    } else {
      const parsed = permissionApprovalSchema.parse(message);
      this.assertActiveTurn(parsed.params.threadId, parsed.params.turnId);
      const publicId = randomUUID();
      approval = {
        approval_id: publicId,
        kind: "permissions",
        reason: parsed.params.reason,
        cwd: parsed.params.cwd,
        requested_permissions: parsed.params.permissions,
      };
      wire = {
        public_id: publicId,
        wire_id: parsed.id,
        method: parsed.method,
        requested_permissions: parsed.params.permissions,
      };
    }

    this.pendingApproval = wire;
    this.emitUpdate({
      status: "waiting_user",
      session_id: this.requireSessionId(),
      turn_id: this.requireTurnId(),
      role: this.requireRole(),
      approval,
    });
  }

  private handleItemCompleted(message: AppServerMessage): void {
    const parsed = itemCompletedSchema.parse(message);
    this.assertActiveTurn(parsed.params.threadId, parsed.params.turnId);
    const item = parsed.params.item;
    if (
      item.type === "agentMessage" &&
      typeof item.text === "string" &&
      (item.phase === "final_answer" || item.phase === null || item.phase === undefined)
    ) {
      this.finalReport = item.text.trim();
    }
  }

  private handleUsage(message: AppServerMessage): void {
    const parsed = tokenUsageSchema.parse(message);
    this.assertActiveTurn(parsed.params.threadId, parsed.params.turnId);
    const usage = parsed.params.tokenUsage.last;
    this.usage = {
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      cache_write_input_tokens: usage.cacheWriteInputTokens,
      output_tokens: usage.outputTokens,
      reasoning_output_tokens: usage.reasoningOutputTokens,
    };
  }

  private handleTurnCompleted(message: AppServerMessage): void {
    const parsed = turnCompletedSchema.parse(message);
    this.assertActiveTurn(parsed.params.threadId, parsed.params.turn.id);
    if (parsed.params.turn.items) {
      for (const item of parsed.params.turn.items) {
        if (
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "agentMessage" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          this.finalReport = item.text.trim();
        }
      }
    }
    if (parsed.params.turn.status !== "completed") {
      this.fail(
        `Approval-gated Codex turn ended with status ${parsed.params.turn.status}${
          parsed.params.turn.error?.message
            ? `: ${parsed.params.turn.error.message}`
            : ""
        }`,
      );
      void this.cleanup();
      return;
    }
    if (!this.finalReport || !this.usage) {
      this.fail("Completed app-server turn did not provide a final report and usage");
      void this.cleanup();
      return;
    }

    const role = this.requireRole();
    const profile = managedRoleProfiles[role];
    this.terminal = true;
    this.clearDeadline();
    this.emitUpdate({
      status: "completed",
      session_id: this.requireSessionId(),
      turn_id: this.requireTurnId(),
      role,
      agent_name: profile.agent_name as "ark_pl" | "ark_worker",
      model: profile.model as "gpt-5.6-terra" | "gpt-5.6-luna",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
      final_report: this.finalReport,
      usage: this.usage,
    });
    void this.cleanup();
  }

  private assertActiveTurn(threadId: string, turnId: string): void {
    if (threadId !== this.sessionId || turnId !== this.turnId) {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "app-server message does not belong to the active session and turn",
      );
    }
  }

  private startDeadline(signal?: AbortSignal): void {
    const abort = (): void => {
      void this.interruptAndFail("Approval-gated Codex session was cancelled");
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
      this.removeAbortListener = () => signal?.removeEventListener("abort", abort);
    }
    this.timeout = setTimeout(() => {
      void this.interruptAndFail("Approval-gated Codex session timed out");
    }, this.timeoutMs);
  }

  private async interruptAndFail(message: string): Promise<void> {
    if (this.terminal) {
      return;
    }
    if (this.client && this.sessionId && this.turnId) {
      await boundedInterrupt(this.client, this.sessionId, this.turnId);
    }
    this.fail(message);
    await this.cleanup();
  }

  private emitUpdate(update: ApprovalSessionUpdate): void {
    const waiter = this.updateWaiters.shift();
    if (waiter) {
      waiter.resolve(update);
    } else {
      this.updateQueue.push(update);
    }
  }

  private nextUpdate(): Promise<ApprovalSessionUpdate> {
    const queued = this.updateQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.updateWaiters.push({ resolve, reject });
    });
  }

  private fail(message: string, cause?: unknown): void {
    if (this.failure || this.terminal) {
      return;
    }
    this.terminal = true;
    this.clearDeadline();
    this.failure = new ArkTeamError(
      cause instanceof z.ZodError ||
        (cause instanceof ArkTeamError &&
          cause.code === "AGENT_SESSION_PROTOCOL_ERROR")
        ? "AGENT_SESSION_PROTOCOL_ERROR"
        : "AGENT_SESSION_FAILED",
      message,
      cause === undefined ? undefined : { cause },
    );
    for (const waiter of this.updateWaiters.splice(0)) {
      waiter.reject(this.failure);
    }
  }

  private async closeAfterFailure(message: string, cause: unknown): Promise<never> {
    this.fail(message, cause);
    await this.cleanup();
    throw this.failure ?? new ArkTeamError("AGENT_SESSION_FAILED", message, { cause });
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupPromise) {
      await this.cleanupPromise;
      return;
    }
    this.clearDeadline();
    this.removeMessageListener?.();
    this.removeFailureListener?.();
    this.removeMessageListener = null;
    this.removeFailureListener = null;
    this.cleanupPromise = this.client?.close() ?? Promise.resolve();
    await this.cleanupPromise;
  }

  private clearDeadline(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.removeAbortListener?.();
    this.removeAbortListener = null;
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new ArkTeamError("AGENT_SESSION_PROTOCOL_ERROR", "session ID is unavailable");
    }
    return this.sessionId;
  }

  private requireTurnId(): string {
    if (!this.turnId) {
      throw new ArkTeamError("AGENT_SESSION_PROTOCOL_ERROR", "turn ID is unavailable");
    }
    return this.turnId;
  }

  private requireRole(): Exclude<ManagedRole, "pm"> {
    if (!this.role) {
      throw new ArkTeamError("AGENT_SESSION_PROTOCOL_ERROR", "writer role is unavailable");
    }
    return this.role;
  }
}

function approvalResponse(pending: WireApproval, decision: ApprovalDecision): unknown {
  if (pending.method === "item/permissions/requestApproval") {
    if (decision === "approve_once" || decision === "approve_session") {
      const requested = pending.requested_permissions;
      return {
        permissions: {
          ...(requested?.network === null || requested?.network === undefined
            ? {}
            : { network: requested.network }),
          ...(requested?.fileSystem === null || requested?.fileSystem === undefined
            ? {}
            : { fileSystem: requested.fileSystem }),
        },
        scope: decision === "approve_once" ? "turn" : "session",
      };
    }
    return {
      permissions: {},
      scope: "turn",
    };
  }

  const mappedDecision = {
    approve_once: "accept",
    approve_session: "acceptForSession",
    decline: "decline",
    cancel: "cancel",
  } as const;
  return {
    decision: mappedDecision[decision],
  };
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return (
    value === "approve_once" ||
    value === "approve_session" ||
    value === "decline" ||
    value === "cancel"
  );
}

async function boundedInterrupt(
  client: AppServerProtocolClient,
  threadId: string,
  turnId: string,
): Promise<void> {
  let graceTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.request("turn/interrupt", { threadId, turnId }).then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, INTERRUPT_GRACE_MS);
      }),
    ]);
  } finally {
    if (graceTimer) {
      clearTimeout(graceTimer);
    }
  }
}
