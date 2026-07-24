import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type {
  AppServerMessage,
  AppServerProtocolClient,
  JsonRpcId,
} from "../src/app-server-client.js";
import {
  AppServerApprovalSession,
  type ApprovalSessionUpdate,
} from "../src/approval-session.js";
import { ArkTeamError } from "../src/errors.js";

const execFileAsync = promisify(execFile);

test("TEST-401 performs the handshake and verifies exact writer settings", async () => {
  await withWorktree(async (workingDirectory) => {
    const client = new FakeAppServerClient();
    const session = new AppServerApprovalSession({ client });
    const start = session.start({
      role: "pl",
      assignment: "Review the bounded team change.",
      working_directory: workingDirectory,
    });

    await client.waitForRequest("turn/start");
    client.emit(commandApproval(41));
    const update = await start;

    assert.equal(update.status, "waiting_user");
    assert.equal(update.role, "pl");
    assert.deepEqual(client.notifications, ["initialized"]);
    assert.deepEqual(
      client.requests.map(({ method }) => method),
      ["initialize", "thread/start", "turn/start"],
    );
    assert.deepEqual(client.params("initialize"), {
      clientInfo: {
        name: "ark_team",
        title: "Ark Team",
        version: "0.1.0",
      },
      capabilities: null,
    });
    assert.deepEqual(client.params("thread/start"), {
      model: "gpt-5.6-terra",
      cwd: workingDirectory,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: {
        agents: { enabled: false },
        apps: { _default: { enabled: false } },
        features: { multi_agent: false },
        model_reasoning_effort: "xhigh",
        web_search: "disabled",
        sandbox_workspace_write: { network_access: false },
      },
      developerInstructions:
        "Lead exactly one bounded Ark Team team inside the assigned linked Git worktree. " +
        "Preserve unrelated user work and verify observable evidence. " +
        "Do not spawn native subagents from this session. " +
        "Return WORKER_SPAWN_REQUEST records for work that the Ark Team controller should assign to managed worker sessions. " +
        "Consolidate worker outcomes into one PL report for the PM.",
      ephemeral: false,
    });
    assert.deepEqual(client.params("turn/start"), {
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text:
            "<ark_team_managed_role>\n" +
            "Role: ark_pl\n" +
            "Model contract: gpt-5.6-terra / xhigh\n" +
            "Permission contract: workspace-write / on-request\n" +
            "Lead exactly one bounded Ark Team team inside the assigned linked Git worktree. " +
            "Preserve unrelated user work and verify observable evidence. " +
            "Do not spawn native subagents from this session. " +
            "Return WORKER_SPAWN_REQUEST records for work that the Ark Team controller should assign to managed worker sessions. " +
            "Consolidate worker outcomes into one PL report for the PM.\n" +
            "Return only the observable role report. Never expose private chain-of-thought.\n" +
            "</ark_team_managed_role>\n" +
            "<ark_team_assignment>\n" +
            "Review the bounded team change.\n" +
            "</ark_team_assignment>",
          text_elements: [],
        },
      ],
      cwd: workingDirectory,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      model: "gpt-5.6-terra",
      effort: "xhigh",
    });

    await finishAfterDecision(session, client, update, "decline");
  });
});

test("TEST-402 rejects PM and primary-checkout writer sessions before launch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-approval-refusal-"));
  try {
    const client = new FakeAppServerClient();
    const pm = new AppServerApprovalSession({ client });
    await assert.rejects(
      pm.start({
        role: "pm",
        assignment: "Do not launch.",
        working_directory: root,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );
    const invalid = new AppServerApprovalSession({ client });
    await assert.rejects(
      invalid.start({
        role: "reviewer" as never,
        assignment: "Do not launch.",
        working_directory: root,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );

    await mkdir(path.join(root, ".git"));
    const writer = new AppServerApprovalSession({ client });
    await assert.rejects(
      writer.start({
        role: "worker",
        assignment: "Do not launch.",
        working_directory: root,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "UNSAFE_AGENT_WORKSPACE",
    );
    assert.equal(client.requests.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-403 maps command, file, and permission decisions without auto-approval", async () => {
  await withWorktree(async (workingDirectory) => {
    const client = new FakeAppServerClient();
    const session = new AppServerApprovalSession({ client });
    const firstUpdate = session.start({
      role: "worker",
      assignment: "Exercise approval routing.",
      working_directory: workingDirectory,
    });

    await client.waitForRequest("turn/start");
    client.emit(commandApproval(51));
    let update = await firstUpdate;
    assertWaiting(update, "command");
    assert.equal(client.responses.length, 0);

    let next = session.decide(update.approval.approval_id, "approve_once");
    assert.deepEqual(client.responses.at(-1), {
      id: 51,
      result: { decision: "accept" },
    });
    client.emit(fileApproval(52));
    update = await next;
    assertWaiting(update, "file_change");

    next = session.decide(update.approval.approval_id, "approve_session");
    assert.deepEqual(client.responses.at(-1), {
      id: 52,
      result: { decision: "acceptForSession" },
    });
    client.emit(permissionApproval(53));
    update = await next;
    assertWaiting(update, "permissions");

    next = session.decide(update.approval.approval_id, "approve_once");
    assert.deepEqual(client.responses.at(-1), {
      id: 53,
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: { readOnly: ["/opt/reference"] },
        },
        scope: "turn",
      },
    });
    client.emit(permissionApproval(54));
    update = await next;
    assertWaiting(update, "permissions");

    next = session.decide(update.approval.approval_id, "approve_session");
    assert.deepEqual(client.responses.at(-1), {
      id: 54,
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: { readOnly: ["/opt/reference"] },
        },
        scope: "session",
      },
    });
    client.emit(permissionApproval(55));
    update = await next;
    assertWaiting(update, "permissions");

    next = session.decide(update.approval.approval_id, "decline");
    assert.deepEqual(client.responses.at(-1), {
      id: 55,
      result: {
        permissions: {},
        scope: "turn",
      },
    });
    client.emit(permissionApproval(56));
    update = await next;
    assertWaiting(update, "permissions");

    next = session.decide(update.approval.approval_id, "cancel");
    assert.deepEqual(client.responses.at(-1), {
      id: 56,
      result: {
        permissions: {},
        scope: "turn",
      },
    });
    client.emit(commandApproval(57));
    update = await next;
    assertWaiting(update, "command");

    next = session.decide(update.approval.approval_id, "decline");
    assert.deepEqual(client.responses.at(-1), {
      id: 57,
      result: { decision: "decline" },
    });
    client.emit(fileApproval(58));
    update = await next;
    assertWaiting(update, "file_change");

    const completed = session.decide(update.approval.approval_id, "cancel");
    assert.deepEqual(client.responses.at(-1), {
      id: 58,
      result: { decision: "cancel" },
    });
    emitCompletion(client);
    assert.equal((await completed).status, "completed");
  });
});

test("TEST-404 exposes opaque one-shot approval IDs and rejects invalid decisions", async () => {
  await withWorktree(async (workingDirectory) => {
    const client = new FakeAppServerClient();
    const session = new AppServerApprovalSession({ client });
    const firstUpdate = session.start({
      role: "worker",
      assignment: "Validate approval identifiers.",
      working_directory: workingDirectory,
    });

    await client.waitForRequest("turn/start");
    client.emit(commandApproval(61));
    const first = await firstUpdate;
    assertWaiting(first, "command");
    assert.match(first.approval.approval_id, /^[0-9a-f-]{36}$/);
    assert.notEqual(first.approval.approval_id, "61");

    await assert.rejects(
      session.decide(first.approval.approval_id, "invalid" as never),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );
    assert.equal(client.responses.length, 0);

    const secondUpdate = session.decide(first.approval.approval_id, "decline");
    client.emit(fileApproval(62));
    const second = await secondUpdate;
    assertWaiting(second, "file_change");
    await assert.rejects(
      session.decide(first.approval.approval_id, "approve_once"),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );
    assert.equal(client.responses.length, 1);

    await finishAfterDecision(session, client, second, "decline");
  });
});

test("TEST-405 returns final report and usage without raw event history", async () => {
  await withWorktree(async (workingDirectory) => {
    const client = new FakeAppServerClient();
    const session = new AppServerApprovalSession({ client });
    const start = session.start({
      role: "worker",
      assignment: "Return completion evidence.",
      working_directory: workingDirectory,
    });

    await client.waitForRequest("turn/start");
    emitCompletion(client);
    const update = await start;
    assert.equal(update.status, "completed");
    if (update.status !== "completed") {
      return;
    }
    assert.deepEqual(update, {
      status: "completed",
      session_id: "thread-1",
      turn_id: "turn-1",
      role: "worker",
      agent_name: "ark_worker",
      model: "gpt-5.6-luna",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
      final_report: "VISIBLE_FINAL_REPORT",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 20,
        cache_write_input_tokens: 0,
        output_tokens: 12,
        reasoning_output_tokens: 4,
      },
    });
    assert.deepEqual(
      Object.keys(update).sort(),
      [
        "agent_name",
        "approval_policy",
        "final_report",
        "model",
        "model_reasoning_effort",
        "role",
        "sandbox_mode",
        "session_id",
        "status",
        "turn_id",
        "usage",
      ].sort(),
    );
    assert.equal(client.closed, 1);
  });
});

test("TEST-406 fails closed on timeout, cancellation, connection, and protocol errors", async () => {
  await withWorktree(async (workingDirectory) => {
    const timeoutClient = new FakeAppServerClient();
    const timedOut = new AppServerApprovalSession({
      client: timeoutClient,
      timeout_ms: 5,
    }).start({
      role: "worker",
      assignment: "Wait forever.",
      working_directory: workingDirectory,
    });
    await assertSessionFailure(timedOut, "AGENT_SESSION_FAILED");
    assert.equal(timeoutClient.hasRequest("turn/interrupt"), true);
    assert.equal(timeoutClient.closed, 1);

    const cancelledClient = new FakeAppServerClient();
    const abortController = new AbortController();
    const cancelled = new AppServerApprovalSession({
      client: cancelledClient,
      timeout_ms: 1000,
    }).start({
      role: "worker",
      assignment: "Wait for cancellation.",
      working_directory: workingDirectory,
      signal: abortController.signal,
    });
    await cancelledClient.waitForRequest("turn/start");
    abortController.abort();
    await assertSessionFailure(cancelled, "AGENT_SESSION_FAILED");
    assert.equal(cancelledClient.hasRequest("turn/interrupt"), true);
    assert.equal(cancelledClient.closed, 1);

    const connectionClient = new FakeAppServerClient();
    const disconnected = new AppServerApprovalSession({
      client: connectionClient,
    }).start({
      role: "worker",
      assignment: "Observe a connection failure.",
      working_directory: workingDirectory,
    });
    await connectionClient.waitForRequest("turn/start");
    connectionClient.fail(new Error("simulated app-server exit"));
    await assertSessionFailure(disconnected, "AGENT_SESSION_FAILED");

    const protocolClient = new FakeAppServerClient();
    const malformed = new AppServerApprovalSession({ client: protocolClient }).start({
      role: "worker",
      assignment: "Observe a malformed request.",
      working_directory: workingDirectory,
    });
    await protocolClient.waitForRequest("turn/start");
    protocolClient.emit({
      id: 71,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    });
    await assertSessionFailure(malformed, "AGENT_SESSION_PROTOCOL_ERROR");
    assert.equal(protocolClient.closed, 1);

    const rerouteClient = new FakeAppServerClient();
    const rerouted = new AppServerApprovalSession({ client: rerouteClient }).start({
      role: "worker",
      assignment: "Reject a model reroute.",
      working_directory: workingDirectory,
    });
    await rerouteClient.waitForRequest("turn/start");
    rerouteClient.emit({
      method: "model/rerouted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        fromModel: "gpt-5.6-luna",
        toModel: "another-model",
        reason: "capacity",
      },
    });
    await assertSessionFailure(rerouted, "AGENT_SESSION_PROTOCOL_ERROR");
    assert.equal(rerouteClient.closed, 1);
  });
});

test("TEST-605 resumes a structured writer turn with the exact app-server profile", async () => {
  await withWorktree(async (workingDirectory) => {
    const client = new FakeAppServerClient();
    const session = new AppServerApprovalSession({ client });
    const completion = session.start({
      role: "pl",
      assignment: "Consolidate the completed worker reports.",
      working_directory: workingDirectory,
      resume_session_id: "thread-existing",
      output_contract: "pl_report",
    });

    await client.waitForRequest("turn/start");
    emitCompletion(client, JSON.stringify(validPlReport()), {
      threadId: "thread-existing",
    });
    const update = await completion;
    assert.equal(update.status, "completed");
    if (update.status !== "completed") {
      return;
    }
    assert.equal(update.session_id, "thread-existing");
    assert.equal(update.structured_report?.kind, "pl_report");
    assert.deepEqual(
      client.requests.map(({ method }) => method),
      ["initialize", "thread/resume", "turn/start"],
    );
    assert.deepEqual(client.params("thread/resume"), {
      threadId: "thread-existing",
      model: "gpt-5.6-terra",
      cwd: workingDirectory,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: {
        agents: { enabled: false },
        apps: { _default: { enabled: false } },
        features: { multi_agent: false },
        model_reasoning_effort: "xhigh",
        web_search: "disabled",
        sandbox_workspace_write: { network_access: false },
      },
      developerInstructions:
        "Lead exactly one bounded Ark Team team inside the assigned linked Git worktree. " +
        "Preserve unrelated user work and verify observable evidence. " +
        "Do not spawn native subagents from this session. " +
        "Return WORKER_SPAWN_REQUEST records for work that the Ark Team controller should assign to managed worker sessions. " +
        "Consolidate worker outcomes into one PL report for the PM.",
    });
    const turnParams = client.params("turn/start");
    assert.equal(
      typeof turnParams === "object" &&
        turnParams !== null &&
        "outputSchema" in turnParams &&
        typeof turnParams.outputSchema === "object" &&
        turnParams.outputSchema !== null &&
        "additionalProperties" in turnParams.outputSchema
        ? turnParams.outputSchema.additionalProperties
        : undefined,
      false,
    );
  });
});

test("TEST-606 fails closed on writer resume mismatch and invalid structured output", async () => {
  await withWorktree(async (workingDirectory) => {
    const mismatchClient = new FakeAppServerClient({
      resumed_thread_id: "another-thread",
    });
    await assertSessionFailure(
      new AppServerApprovalSession({ client: mismatchClient }).start({
        role: "worker",
        assignment: "Reject mismatched resume evidence.",
        working_directory: workingDirectory,
        resume_session_id: "expected-thread",
        output_contract: "worker_report",
      }),
      "AGENT_SESSION_PROTOCOL_ERROR",
    );

    const weakenedProfileClient = new FakeAppServerClient({
      network_access: true,
    });
    await assertSessionFailure(
      new AppServerApprovalSession({ client: weakenedProfileClient }).start({
        role: "worker",
        assignment: "Reject a weakened sandbox profile.",
        working_directory: workingDirectory,
        resume_session_id: "expected-thread",
        output_contract: "worker_report",
      }),
      "AGENT_SESSION_PROTOCOL_ERROR",
    );

    const invalidClient = new FakeAppServerClient();
    const invalid = new AppServerApprovalSession({ client: invalidClient }).start({
      role: "worker",
      assignment: "Return invalid structured output.",
      working_directory: workingDirectory,
      output_contract: "worker_report",
    });
    await invalidClient.waitForRequest("turn/start");
    emitCompletion(invalidClient, "not-json");
    await assertSessionFailure(invalid, "AGENT_SESSION_PROTOCOL_ERROR");
  });
});

interface FakeAppServerOptions {
  resumed_thread_id?: string;
  network_access?: boolean;
}

class FakeAppServerClient implements AppServerProtocolClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: string[] = [];
  readonly responses: Array<{ id: JsonRpcId; result?: unknown; error?: unknown }> = [];
  closed = 0;
  private readonly messageListeners = new Set<(message: AppServerMessage) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();

  constructor(private readonly options: FakeAppServerOptions = {}) {}

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "initialize" || method === "turn/interrupt") {
      return {};
    }
    if (method === "thread/start" || method === "thread/resume") {
      const model =
        typeof params === "object" &&
        params !== null &&
        "model" in params &&
        typeof params.model === "string"
          ? params.model
          : "unknown";
      const cwd =
        typeof params === "object" &&
        params !== null &&
        "cwd" in params &&
        typeof params.cwd === "string"
          ? params.cwd
          : "/unknown";
      const threadId =
        method === "thread/resume" &&
        typeof params === "object" &&
        params !== null &&
        "threadId" in params &&
        typeof params.threadId === "string"
          ? params.threadId
          : "thread-1";
      return {
        thread: {
          id:
            method === "thread/resume"
              ? (this.options.resumed_thread_id ?? threadId)
              : threadId,
        },
        model,
        cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [cwd],
          readOnlyAccess: { type: "fullAccess" },
          networkAccess: this.options.network_access ?? false,
        },
        reasoningEffort: "xhigh",
      };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`Unexpected fake request: ${method}`);
  }

  notify(method: string): void {
    this.notifications.push(method);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.responses.push({ id, error: { code, message } });
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  emit(message: AppServerMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  fail(error: Error): void {
    for (const listener of this.failureListeners) {
      listener(error);
    }
  }

  params(method: string): unknown {
    return this.requests.find((request) => request.method === method)?.params;
  }

  hasRequest(method: string): boolean {
    return this.requests.some((request) => request.method === method);
  }

  async waitForRequest(method: string): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if (this.hasRequest(method)) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`Timed out waiting for fake request ${method}`);
  }
}

function commandApproval(id: number): AppServerMessage {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `command-${id}`,
      reason: "command needs approval",
      command: "touch outside",
      cwd: "/tmp/worktree",
    },
  };
}

function fileApproval(id: number): AppServerMessage {
  return {
    id,
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `file-${id}`,
      reason: "file change needs approval",
      grantRoot: "/tmp/outside",
    },
  };
}

function permissionApproval(id: number): AppServerMessage {
  return {
    id,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: `permission-${id}`,
      cwd: "/tmp/worktree",
      reason: "additional permissions required",
      permissions: {
        network: { enabled: true },
        fileSystem: { readOnly: ["/opt/reference"] },
      },
    },
  };
}

function emitCompletion(
  client: FakeAppServerClient,
  finalReport = "VISIBLE_FINAL_REPORT",
  ids: { threadId?: string; turnId?: string } = {},
): void {
  const threadId = ids.threadId ?? "thread-1";
  const turnId = ids.turnId ?? "turn-1";
  client.emit({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        id: "reasoning-1",
        type: "reasoning",
        text: "PRIVATE_REASONING_MUST_NOT_ESCAPE",
      },
    },
  });
  client.emit({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: {
        id: "message-1",
        type: "agentMessage",
        text: finalReport,
        phase: "final_answer",
      },
    },
  });
  client.emit({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: {
          inputTokens: 120,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 0,
          outputTokens: 12,
          reasoningOutputTokens: 4,
        },
      },
    },
  });
  client.emit({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        items: [
          {
            id: "message-1",
            type: "agentMessage",
            text: finalReport,
            phase: "final_answer",
          },
        ],
      },
    },
  });
}

function validPlReport() {
  return {
    kind: "pl_report",
    team_id: "team-a",
    status: "completed",
    summary: "The team mission is complete.",
    worker_reports: [
      {
        kind: "worker_report",
        team_id: "team-a",
        worker_key: "worker-a",
        status: "completed",
        summary: "The bounded worker task is complete.",
        changed_files: ["src/feature.ts"],
        commit_sha: "abcdef1",
        verification: [
          {
            name: "focused tests",
            status: "passed",
            evidence: "The focused test passed.",
          },
        ],
        blockers: [],
      },
    ],
    integration_commit_sha: "abcdef2",
    verification: [
      {
        name: "team tests",
        status: "passed",
        evidence: "All team tests passed.",
      },
    ],
    blockers: [],
  };
}

async function finishAfterDecision(
  session: AppServerApprovalSession,
  client: FakeAppServerClient,
  update: ApprovalSessionUpdate,
  decision: "decline" | "cancel",
): Promise<void> {
  assert.equal(update.status, "waiting_user");
  if (update.status !== "waiting_user") {
    return;
  }
  const completion = session.decide(update.approval.approval_id, decision);
  emitCompletion(client);
  assert.equal((await completion).status, "completed");
}

function assertWaiting(
  update: ApprovalSessionUpdate,
  kind: "command" | "file_change" | "permissions",
): asserts update is Extract<ApprovalSessionUpdate, { status: "waiting_user" }> {
  assert.equal(update.status, "waiting_user");
  if (update.status === "waiting_user") {
    assert.equal(update.approval.kind, kind);
  }
}

async function assertSessionFailure(
  promise: Promise<ApprovalSessionUpdate>,
  code: ArkTeamError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ArkTeamError && error.code === code,
  );
}

async function withWorktree(
  callback: (workingDirectory: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-approval-test-"));
  try {
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "worker");
    await execFileAsync("git", ["init", "-b", "main", repository]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "Ark Team Test",
    ]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "ark-team-test@example.invalid",
    ]);
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "--allow-empty",
      "-m",
      "test baseline",
    ]);
    await execFileAsync("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      "test/worker",
      worktree,
    ]);
    await callback(worktree);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
