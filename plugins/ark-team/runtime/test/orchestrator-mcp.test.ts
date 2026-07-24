import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ManagedAssignmentScheduler } from "../src/assignment-scheduler.js";
import type {
  ManagedSessionRequest,
  ManagedSessionResult,
} from "../src/managed-session.js";
import { createArkTeamMcpServer } from "../src/mcp-server.js";
import {
  ArkTeamOrchestrator,
  type ManagedPmLauncher,
  type TeamExecutionCoordinator,
} from "../src/orchestrator.js";
import {
  PlanMaterializer,
  type TeamWorkspaceManager,
} from "../src/plan-materializer.js";
import type { PmPlan } from "../src/role-contracts.js";
import { RunStore } from "../src/state-store.js";

test("TEST-805 exposes automatic PM planning and materialization through MCP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-orchestrator-mcp-"));
  const project = path.join(root, "project");
  await mkdir(project);
  const store = new RunStore({ root_path: path.join(root, "state") });
  const plan = validPlan();
  const launcher = new FakePmLauncher(plan);
  const materializer = new PlanMaterializer(store, {
    worktree_manager: new FakeWorkspaceManager(path.join(root, "worktrees")),
  });
  const orchestrator = new ArkTeamOrchestrator(store, {
    pm_launcher: launcher,
    materializer,
    coordinator: new SnapshotCoordinator(store),
  });
  const coordinator = new SnapshotCoordinator(store);
  const server = createArkTeamMcpServer(
    store,
    new ManagedAssignmentScheduler(store),
    materializer,
    coordinator,
    orchestrator,
  );
  const client = new Client(
    { name: "ark-team-orchestrator-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const executed = await client.callTool({
      name: "ark_team_execute",
      arguments: {
        objective: "Execute one managed PM plan",
        project_path: project,
      },
    });
    assert.equal(executed.isError, undefined);
    const payload = executed.structuredContent as
      | {
          ok?: boolean;
          run?: { state?: string; team_count?: number };
          pm_session?: { session_id?: string };
          teams?: Array<{ team_id?: string }>;
        }
      | undefined;
    assert.equal(payload?.ok, true);
    assert.equal(payload?.run?.state, "staffing");
    assert.equal(payload?.run?.team_count, 1);
    assert.equal(payload?.pm_session?.session_id, "pm-mcp-session");
    assert.equal(payload?.teams?.[0]?.team_id, "team-a");
    assert.equal(launcher.requests.length, 1);
    assert.equal(launcher.requests[0]?.role, "pm");
    assert.equal(launcher.requests[0]?.output_contract, "pm_plan");

    const advanced = await client.callTool({
      name: "ark_team_advance",
      arguments: {
        run_id: (
          executed.structuredContent as
            | { run?: { run_id?: string } }
            | undefined
        )?.run?.run_id,
      },
    });
    const advancedPayload = advanced.structuredContent as
      | {
          ok?: boolean;
          progressed?: boolean;
          waiting_approvals?: number;
          waiting_retries?: number;
        }
      | undefined;
    assert.equal(advancedPayload?.ok, true);
    assert.equal(advancedPayload?.progressed, false);
    assert.equal(advancedPayload?.waiting_approvals, 0);
    assert.equal(advancedPayload?.waiting_retries, 0);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

class FakePmLauncher implements ManagedPmLauncher {
  readonly requests: ManagedSessionRequest[] = [];

  constructor(private readonly plan: PmPlan) {}

  async run(request: ManagedSessionRequest): Promise<ManagedSessionResult> {
    this.requests.push(request);
    return {
      session_id: "pm-mcp-session",
      role: "pm",
      agent_name: "ark_pm",
      model: "gpt-5.6-sol",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "read-only",
      requested_approval_policy: "never",
      final_report: JSON.stringify(this.plan),
      structured_report: this.plan,
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        cache_write_input_tokens: 0,
        output_tokens: 30,
        reasoning_output_tokens: 20,
      },
    };
  }
}

class SnapshotCoordinator implements TeamExecutionCoordinator {
  constructor(private readonly store: RunStore) {}

  async advance(runId: string) {
    return {
      run: await this.store.getRun(runId),
      teams: (await this.store.listTeams(runId)).teams,
      assignments: (await this.store.listAssignments(runId)).assignments,
      progressed: false,
      waiting_approvals: 0,
      waiting_retries: 0,
    };
  }
}

class FakeWorkspaceManager implements TeamWorkspaceManager {
  constructor(private readonly root: string) {}

  async prepare(
    run: { run_id: string },
    plan: PmPlan,
  ) {
    return plan.teams.map((team) => ({
      run_id: run.run_id,
      team_id: team.team_id,
      isolation_mode: "git_worktree" as const,
      working_directory: path.join(this.root, run.run_id, team.team_id),
      branch: `ark-team/${run.run_id}/${team.team_id}`,
      target_branch: "main",
      base_commit: "b".repeat(40),
    }));
  }

  async cleanup(): Promise<void> {}
}

function validPlan(): PmPlan {
  return {
    kind: "pm_plan",
    objective: "Execute one managed PM plan.",
    teams: [
      {
        team_id: "team-a",
        mission: "Deliver the team mission.",
        owned_paths: ["src/team-a.ts"],
        dependencies: [],
        acceptance_criteria: ["The mission is complete."],
        verification: ["Run focused tests."],
        worker_count: 1,
      },
    ],
    integration: {
      strategy: "local_merge",
      acceptance_criteria: ["The result integrates."],
      verification: ["Run all tests."],
    },
  };
}
