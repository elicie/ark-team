import { randomUUID } from "node:crypto";

import { z } from "zod/v4";

import {
  type AppServerMessage,
  type AppServerProtocolClient,
  type ExternalAppServerRuntime,
  type JsonRpcId,
  StdioAppServerClient,
} from "./app-server-client.js";
import { ArkTeamError } from "./errors.js";
import {
  assertManagedWorkspace,
  buildManagedPrompt,
  isManagedRole,
  managedCodexConfig,
  managedRoleProfiles,
  type ManagedRole,
  type Usage,
} from "./managed-role.js";
import type { ResolvedModelBindingV1 } from "./provider-types.js";
import {
  assertManagedOutputContractRole,
  managedOutputJsonSchemas,
  parseManagedOutput,
  type ManagedOutput,
  type ManagedOutputContract,
} from "./role-contracts.js";

export type ApprovalDecision =
  | "approve_once"
  | "approve_session"
  | "decline"
  | "cancel";

export interface ApprovalSessionRequest {
  role: ManagedRole;
  assignment: string;
  working_directory: string;
  resume_session_id?: string;
  output_contract?: ManagedOutputContract;
  model_binding?: ResolvedModelBindingV1;
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
  role: ManagedRole;
  agent_name: "ark_pm" | "ark_pl" | "ark_worker";
  model: string;
  model_reasoning_effort: string;
  sandbox_mode: "read-only" | "workspace-write";
  approval_policy: "never" | "on-request";
  final_report: string;
  structured_report?: ManagedOutput;
  usage: Usage;
}

export type ApprovalSessionUpdate = ApprovalWaitingUpdate | ApprovalCompletedUpdate;

export interface ApprovalSessionOptions {
  client?: AppServerProtocolClient;
  codex_path?: string;
  timeout_ms?: number;
  external_runtime?: ExternalAppServerRuntime;
  provider_sensitive_env_names?: readonly string[];
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
const MAX_PRE_TURN_MESSAGES = 100;
const TURN_SCOPED_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/completed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "model/rerouted",
]);

const threadStartResponseSchema = z.object({
  thread: z.object({
    id: z.string().min(1),
  }),
  model: z.string().min(1),
  modelProvider: z.string().min(1),
  cwd: z.string().min(1),
  runtimeWorkspaceRoots: z.array(z.string()).optional(),
  approvalPolicy: z.union([z.literal("never"), z.literal("on-request")]),
  approvalsReviewer: z.literal("user"),
  sandbox: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("readOnly"),
      networkAccess: z.literal(false),
    }),
    z.object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(z.string()),
      networkAccess: z.literal(false),
    }),
  ]),
  reasoningEffort: z.string().min(1),
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
  private readonly externalRuntime: ExternalAppServerRuntime | undefined;
  private readonly providerSensitiveEnvironmentNames: readonly string[];
  private client: AppServerProtocolClient | null = null;
  private role: ManagedRole | null = null;
  private selectedModel: string | null = null;
  private selectedReasoningEffort: string | null = null;
  private outputContract: ManagedOutputContract | null = null;
  private sessionId: string | null = null;
  private turnId: string | null = null;
  private pendingApproval: WireApproval | null = null;
  private finalReport = "";
  private usage: Usage | null = null;
  private preTurnMessages: AppServerMessage[] = [];
  private updateQueue: ApprovalSessionUpdate[] = [];
  private updateWaiters: UpdateWaiter[] = [];
  private terminalFailureListeners = new Set<(error: ArkTeamError) => void>();
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
    this.externalRuntime = options.external_runtime;
    this.providerSensitiveEnvironmentNames =
      options.provider_sensitive_env_names ?? [];
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new ArkTeamError("INVALID_INPUT", "timeout_ms must be a positive integer");
    }
  }

  async start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    if (this.started) {
      throw new ArkTeamError("INVALID_INPUT", "approval session has already started");
    }
    this.started = true;
    if (!isManagedRole(request.role)) {
      throw new ArkTeamError("INVALID_INPUT", "role must be pm, pl, or worker");
    }
    const assignment = request.assignment.trim();
    if (!assignment) {
      throw new ArkTeamError("INVALID_INPUT", "assignment must not be empty");
    }
    if (request.signal?.aborted) {
      throw new ArkTeamError(
        "AGENT_SESSION_FAILED",
        "Managed Codex app-server session was cancelled before it started",
      );
    }
    const workingDirectory = await assertManagedWorkspace(
      request.role,
      request.working_directory,
    );
    if (request.output_contract !== undefined) {
      assertManagedOutputContractRole(request.role, request.output_contract);
      this.outputContract = request.output_contract;
    }
    const resumeSessionId = request.resume_session_id?.trim();
    if (request.resume_session_id !== undefined && !resumeSessionId) {
      throw new ArkTeamError("INVALID_INPUT", "resume_session_id must not be empty");
    }
    const profile = managedRoleProfiles[request.role];
    const binding = resolveSessionBinding(
      request.role,
      request.model_binding,
      this.externalRuntime,
    );
    this.role = request.role;
    this.selectedModel = binding.model;
    this.selectedReasoningEffort = binding.reasoningEffort;
    this.client =
      this.suppliedClient ??
      new StdioAppServerClient({
        codex_path: this.codexPath,
        provider_sensitive_env_names:
          this.providerSensitiveEnvironmentNames,
        ...(this.externalRuntime === undefined
          ? {}
          : { external_runtime: this.externalRuntime }),
      });
    this.removeMessageListener = this.client.onMessage((message) => {
      this.handleMessage(message);
    });
    this.removeFailureListener = this.client.onFailure((error) => {
      this.fail("Codex app-server connection failed", error);
      void this.cleanup();
    });
    this.startDeadline(request.signal);

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

      const threadParams = {
        model: binding.model,
        ...(binding.modelProvider === null
          ? {}
          : { modelProvider: binding.modelProvider }),
        cwd: workingDirectory,
        approvalPolicy: profile.approval_policy,
        approvalsReviewer: "user",
        sandbox: profile.sandbox_mode,
        config: {
          ...managedCodexConfig,
          model_reasoning_effort: binding.reasoningEffort,
          web_search: "disabled",
          ...(profile.sandbox_mode === "workspace-write"
            ? {
                sandbox_workspace_write: {
                  network_access: false,
                },
              }
            : {}),
        },
        developerInstructions: profile.instructions,
      };
      const threadResponse = threadStartResponseSchema.parse(
        resumeSessionId === undefined
          ? await this.client.request("thread/start", {
              ...threadParams,
              ephemeral: false,
            })
          : await this.client.request("thread/resume", {
              threadId: resumeSessionId,
              ...threadParams,
            }),
      );
      if (threadResponse.model !== binding.model) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `app-server selected ${threadResponse.model} instead of ${binding.model}`,
        );
      }
      if (
        binding.modelProvider !== null &&
        threadResponse.modelProvider !== binding.modelProvider
      ) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `app-server selected provider ${threadResponse.modelProvider} instead of ${binding.modelProvider}`,
        );
      }
      if (threadResponse.reasoningEffort !== binding.reasoningEffort) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `app-server selected ${threadResponse.reasoningEffort} reasoning effort instead of ${binding.reasoningEffort}`,
        );
      }
      if (threadResponse.cwd !== workingDirectory) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `app-server selected a different working directory: ${threadResponse.cwd}`,
        );
      }
      if (threadResponse.approvalPolicy !== profile.approval_policy) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `app-server selected ${threadResponse.approvalPolicy} approval instead of ${profile.approval_policy}`,
        );
      }
      if (profile.sandbox_mode === "read-only") {
        if (threadResponse.sandbox.type !== "readOnly") {
          throw new ArkTeamError(
            "AGENT_SESSION_PROTOCOL_ERROR",
            "app-server did not preserve the PM read-only sandbox",
          );
        }
      } else {
        if (threadResponse.sandbox.type !== "workspaceWrite") {
          throw new ArkTeamError(
            "AGENT_SESSION_PROTOCOL_ERROR",
            "app-server did not preserve the writer workspace-write sandbox",
          );
        }
        const writableRoots = [
          ...threadResponse.sandbox.writableRoots,
          ...(threadResponse.runtimeWorkspaceRoots ?? []),
        ];
        if (!writableRoots.includes(workingDirectory)) {
          throw new ArkTeamError(
            "AGENT_SESSION_PROTOCOL_ERROR",
            "app-server workspace-write sandbox does not include the assigned worktree",
          );
        }
      }
      if (
        resumeSessionId !== undefined &&
        threadResponse.thread.id !== resumeSessionId
      ) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          `Resumed app-server session returned a different thread ID: ${threadResponse.thread.id}`,
        );
      }
      this.sessionId = threadResponse.thread.id;

      const turnResponse = turnStartResponseSchema.parse(
        await this.client.request("turn/start", {
          threadId: this.sessionId,
          input: [
            {
              type: "text",
              text: buildManagedPrompt(
                request.role,
                assignment,
                request.output_contract,
                {
                  model: binding.model,
                  reasoning_effort: binding.reasoningEffort,
                },
              ),
              text_elements: [],
            },
          ],
          cwd: workingDirectory,
          approvalPolicy: profile.approval_policy,
          approvalsReviewer: "user",
          model: binding.model,
          effort: binding.reasoningEffort,
          ...(request.output_contract === undefined
            ? {}
            : {
                outputSchema:
                  managedOutputJsonSchemas[request.output_contract],
              }),
        }),
      );
      this.turnId = turnResponse.turn.id;
      this.flushPreTurnMessages(resumeSessionId !== undefined);
    } catch (error) {
      await this.closeAfterFailure("Unable to start managed Codex app-server session", error);
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
      await this.cleanup();
      return;
    }
    const client = this.client;
    const threadId = this.sessionId;
    const turnId = this.turnId;
    if (client && threadId && turnId) {
      await boundedInterrupt(client, threadId, turnId);
    }
    this.fail("Managed Codex app-server session was cancelled");
    await this.cleanup();
  }

  onTerminalFailure(listener: (error: ArkTeamError) => void): () => void {
    if (this.failure) {
      const failure = this.failure;
      queueMicrotask(() => {
        try {
          listener(failure);
        } catch {
          // A lifecycle observer must not prevent session cleanup.
        }
      });
      return () => {};
    }
    this.terminalFailureListeners.add(listener);
    return () => {
      this.terminalFailureListeners.delete(listener);
    };
  }

  private handleMessage(message: AppServerMessage): void {
    if (this.terminal || !message.method) {
      return;
    }
    try {
      if (this.turnId === null && TURN_SCOPED_METHODS.has(message.method)) {
        if (this.preTurnMessages.length >= MAX_PRE_TURN_MESSAGES) {
          throw new ArkTeamError(
            "AGENT_SESSION_PROTOCOL_ERROR",
            "app-server emitted too many turn messages before turn/start completed",
          );
        }
        this.preTurnMessages.push(message);
        return;
      }
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

  private flushPreTurnMessages(resuming: boolean): void {
    const activeTurnId = this.requireTurnId();
    for (const message of this.preTurnMessages.splice(0)) {
      const turnId = messageTurnId(message);
      if (resuming && turnId !== null && turnId !== activeTurnId) {
        continue;
      }
      this.handleMessage(message);
      if (this.terminal) {
        return;
      }
    }
  }

  private handleApprovalRequest(message: AppServerMessage): void {
    if (this.requireRole() === "pm") {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "read-only PM session emitted an unexpected approval request",
      );
    }
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
      role: this.requireWriterRole(),
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
    let structuredReport: ManagedOutput | undefined;
    if (this.outputContract !== null) {
      try {
        structuredReport = parseManagedOutput(this.outputContract, this.finalReport);
      } catch (error) {
        this.fail("Completed app-server turn returned an invalid structured report", error);
        void this.cleanup();
        return;
      }
    }
    this.terminal = true;
    this.clearDeadline();
    this.emitUpdate({
      status: "completed",
      session_id: this.requireSessionId(),
      turn_id: this.requireTurnId(),
      role,
      agent_name: profile.agent_name,
      model: this.requireSelectedModel(),
      model_reasoning_effort: this.requireSelectedReasoningEffort(),
      sandbox_mode: profile.sandbox_mode,
      approval_policy: profile.approval_policy,
      final_report: this.finalReport,
      ...(structuredReport === undefined
        ? {}
        : { structured_report: structuredReport }),
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
      void this.interruptAndFail("Managed Codex app-server session was cancelled");
    };
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
      this.removeAbortListener = () => signal?.removeEventListener("abort", abort);
    }
    this.timeout = setTimeout(() => {
      void this.interruptAndFail("Managed Codex app-server session timed out");
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
    for (const listener of this.terminalFailureListeners) {
      try {
        listener(this.failure);
      } catch {
        // A lifecycle observer must not prevent session cleanup.
      }
    }
    this.terminalFailureListeners.clear();
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

  private requireRole(): ManagedRole {
    if (!this.role) {
      throw new ArkTeamError("AGENT_SESSION_PROTOCOL_ERROR", "managed role is unavailable");
    }
    return this.role;
  }

  private requireSelectedModel(): string {
    if (!this.selectedModel) {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "selected model is unavailable",
      );
    }
    return this.selectedModel;
  }

  private requireSelectedReasoningEffort(): string {
    if (!this.selectedReasoningEffort) {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "selected reasoning effort is unavailable",
      );
    }
    return this.selectedReasoningEffort;
  }

  private requireWriterRole(): Exclude<ManagedRole, "pm"> {
    const role = this.requireRole();
    if (role === "pm") {
      throw new ArkTeamError(
        "AGENT_SESSION_PROTOCOL_ERROR",
        "writer role is unavailable for the PM session",
      );
    }
    return role;
  }
}

interface SessionBinding {
  model: string;
  reasoningEffort: string;
  modelProvider: string | null;
}

function resolveSessionBinding(
  role: ManagedRole,
  binding: ResolvedModelBindingV1 | undefined,
  externalRuntime: ExternalAppServerRuntime | undefined,
): SessionBinding {
  const profile = managedRoleProfiles[role];
  if (binding === undefined) {
    if (externalRuntime !== undefined) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "external app-server runtime requires an external model binding",
      );
    }
    return {
      model: profile.model,
      reasoningEffort: profile.model_reasoning_effort,
      modelProvider: null,
    };
  }

  if (binding.kind === "native") {
    if (externalRuntime !== undefined) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "native model binding cannot use an external app-server runtime",
      );
    }
    if (
      binding.model !== profile.model ||
      binding.requested_reasoning_effort !== profile.model_reasoning_effort ||
      binding.effective_reasoning_effort !== profile.model_reasoning_effort
    ) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "native model binding does not match the managed role profile",
      );
    }
    return {
      model: binding.model,
      reasoningEffort: binding.effective_reasoning_effort,
      modelProvider: null,
    };
  }

  if (role !== "worker") {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "external model bindings are supported only for worker sessions",
    );
  }
  if (externalRuntime === undefined) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "external model binding requires a prepared app-server runtime",
    );
  }
  if (
    externalRuntime.app_server_provider_id !== binding.app_server_provider_id
  ) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "external app-server runtime does not match the model binding",
    );
  }
  return {
    model: binding.model,
    reasoningEffort: binding.effective_reasoning_effort,
    modelProvider: binding.app_server_provider_id,
  };
}

function messageTurnId(message: AppServerMessage): string | null {
  if (
    typeof message.params !== "object" ||
    message.params === null ||
    Array.isArray(message.params)
  ) {
    return null;
  }
  if (
    "turnId" in message.params &&
    typeof message.params.turnId === "string"
  ) {
    return message.params.turnId;
  }
  if (
    "turn" in message.params &&
    typeof message.params.turn === "object" &&
    message.params.turn !== null &&
    !Array.isArray(message.params.turn) &&
    "id" in message.params.turn &&
    typeof message.params.turn.id === "string"
  ) {
    return message.params.turn.id;
  }
  return null;
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
