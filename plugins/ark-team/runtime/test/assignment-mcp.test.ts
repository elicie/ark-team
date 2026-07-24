import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ManagedAssignmentScheduler,
  type ApprovalSessionHandle,
} from "../src/assignment-scheduler.js";
import type {
  ApprovalDecision,
  ApprovalSessionRequest,
  ApprovalSessionUpdate,
} from "../src/approval-session.js";
import { createArkTeamMcpServer } from "../src/mcp-server.js";
import { RunStore } from "../src/state-store.js";

const execFileAsync = promisify(execFile);
const approvalId = "33333333-3333-4333-8333-333333333333";

test("TEST-507 exposes the persistent assignment approval flow through MCP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-assignment-mcp-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  const store = new RunStore({
    root_path: path.join(root, "state"),
    assignment_suffix: () => "000000000001",
  });
  const session = new McpScriptedSession();
  const scheduler = new ManagedAssignmentScheduler(store, {
    session_factory: () => session,
  });
  const server = createArkTeamMcpServer(store, scheduler);
  const client = new Client(
    {
      name: "ark-team-assignment-test",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
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
      "test/mcp-assignment",
      worktree,
    ]);
    const run = await store.createRun({
      objective: "Exercise MCP assignment scheduling",
      project_path: repository,
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const started = await client.callTool({
      name: "ark_team_assignment_start",
      arguments: {
        run_id: run.run_id,
        team_id: "team-a",
        role: "pl",
        assignment: "Lead the MCP test team",
        working_directory: worktree,
      },
    });
    assert.equal(started.isError, undefined);
    const startedPayload = started.structuredContent as
      | {
          ok?: boolean;
          assignment?: {
            assignment_id: string;
            state: string;
            pending_approval?: { approval_id?: string };
          };
        }
      | undefined;
    assert.equal(startedPayload?.ok, true);
    assert.equal(startedPayload?.assignment?.state, "waiting_user");
    assert.equal(
      startedPayload?.assignment?.pending_approval?.approval_id,
      approvalId,
    );
    const assignmentId = startedPayload?.assignment?.assignment_id;
    assert.equal(typeof assignmentId, "string");

    const decided = await client.callTool({
      name: "ark_team_assignment_decide",
      arguments: {
        run_id: run.run_id,
        assignment_id: assignmentId,
        approval_id: approvalId,
        decision: "decline",
      },
    });
    const decidedPayload = decided.structuredContent as
      | {
          ok?: boolean;
          assignment?: {
            state?: string;
            final_report?: string;
            report_target?: { type?: string };
            usage?: { input_tokens?: number };
          };
        }
      | undefined;
    assert.equal(decidedPayload?.ok, true);
    assert.equal(decidedPayload?.assignment?.state, "completed");
    assert.equal(decidedPayload?.assignment?.final_report, "MCP_PL_REPORT");
    assert.equal(decidedPayload?.assignment?.report_target?.type, "pm");
    assert.equal(decidedPayload?.assignment?.usage?.input_tokens, 50);

    const listed = await client.callTool({
      name: "ark_team_assignment_list",
      arguments: {
        run_id: run.run_id,
        states: ["completed"],
      },
    });
    const listedPayload = listed.structuredContent as
      | { ok?: boolean; total?: number }
      | undefined;
    assert.equal(listedPayload?.ok, true);
    assert.equal(listedPayload?.total, 1);
    assert.deepEqual(session.decisions, [
      { approval_id: approvalId, decision: "decline" },
    ]);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-1007 exposes one exhausted-retry decision through MCP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-retry-mcp-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  const store = new RunStore({
    root_path: path.join(root, "state"),
    assignment_suffix: () => "000000000002",
  });
  const scheduler = new ManagedAssignmentScheduler(store, {
    session_factory: () => new RetrySession(),
  });
  const server = createArkTeamMcpServer(store, scheduler);
  const client = new Client(
    { name: "ark-team-retry-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
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
      "test/mcp-retry",
      worktree,
    ]);
    const run = await store.createRun({
      objective: "Exercise MCP retry decision",
      project_path: repository,
    });
    const assignment = await store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Retry this PL task",
      working_directory: worktree,
    });
    await store.failAssignment(
      run.run_id,
      assignment.assignment_id,
      "retry budget exhausted",
    );
    const waiting = await store.requestAssignmentRetry({
      run_id: run.run_id,
      assignment_id: assignment.assignment_id,
      kind: "internal_failure_exhausted",
      mode: "fresh_session",
      reason: "Automatic retries are exhausted",
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const decided = await client.callTool({
      name: "ark_team_assignment_retry_decide",
      arguments: {
        run_id: run.run_id,
        assignment_id: assignment.assignment_id,
        retry_request_id: waiting.pending_retry?.retry_request_id,
        decision: "retry_once",
      },
    });
    const payload = decided.structuredContent as
      | {
          ok?: boolean;
          assignment?: {
            state?: string;
            final_report?: string;
            session_attempt_count?: number;
            pending_retry?: unknown;
          };
        }
      | undefined;
    assert.equal(payload?.ok, true);
    assert.equal(payload?.assignment?.state, "completed");
    assert.equal(payload?.assignment?.final_report, "RETRIED_PL_REPORT");
    assert.equal(payload?.assignment?.session_attempt_count, 2);
    assert.equal(payload?.assignment?.pending_retry, null);

    const replayed = await client.callTool({
      name: "ark_team_assignment_retry_decide",
      arguments: {
        run_id: run.run_id,
        assignment_id: assignment.assignment_id,
        retry_request_id: waiting.pending_retry?.retry_request_id,
        decision: "retry_once",
      },
    });
    assert.equal(replayed.isError, true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

class McpScriptedSession implements ApprovalSessionHandle {
  readonly decisions: Array<{
    approval_id: string;
    decision: ApprovalDecision;
  }> = [];

  async start(_request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    return {
      status: "waiting_user",
      session_id: "mcp-session",
      turn_id: "mcp-turn",
      role: "pl",
      approval: {
        approval_id: approvalId,
        kind: "command",
        reason: "MCP approval test",
        command: "touch outside",
      },
    };
  }

  async decide(
    resolvedApprovalId: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    this.decisions.push({
      approval_id: resolvedApprovalId,
      decision,
    });
    return {
      status: "completed",
      session_id: "mcp-session",
      turn_id: "mcp-turn",
      role: "pl",
      agent_name: "ark_pl",
      model: "gpt-5.6-terra",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
      final_report: "MCP_PL_REPORT",
      usage: {
        input_tokens: 50,
        cached_input_tokens: 10,
        cache_write_input_tokens: 0,
        output_tokens: 8,
        reasoning_output_tokens: 3,
      },
    };
  }

  async close(): Promise<void> {}
}

class RetrySession implements ApprovalSessionHandle {
  async start(_request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    return {
      status: "completed",
      session_id: "retry-session",
      turn_id: "retry-turn",
      role: "pl",
      agent_name: "ark_pl",
      model: "gpt-5.6-terra",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
      final_report: "RETRIED_PL_REPORT",
      usage: {
        input_tokens: 25,
        cached_input_tokens: 5,
        cache_write_input_tokens: 0,
        output_tokens: 7,
        reasoning_output_tokens: 2,
      },
    };
  }

  async decide(
    _approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    throw new Error("No approval was expected");
  }

  async close(): Promise<void> {}
}
