import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ManagedAssignmentScheduler } from "../src/assignment-scheduler.js";
import type { RunRecord } from "../src/domain.js";
import {
  createArkTeamMcpServer,
  type ArkTeamExecutionController,
} from "../src/mcp-server.js";
import type {
  ExecuteArkTeamInput,
  ExecuteArkTeamResult,
  TeamExecutionCoordinator,
} from "../src/orchestrator.js";
import { PlanMaterializer } from "../src/plan-materializer.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { resolveRunWorkerBinding } from "../src/provider-config.js";
import {
  NATIVE_WORKER_MODEL_BINDING,
  type ModelOverrides,
} from "../src/provider-types.js";
import {
  RunStore,
  type CreateRunInput,
} from "../src/state-store.js";

const INLINE_CANARY = "provider-mcp-inline-canary";
const EXTERNAL_OVERRIDE = {
  worker: {
    provider: "company_ai",
    model: "model-1",
    reasoning_effort: "xhigh",
  },
} satisfies ModelOverrides;

test("TEST-003 forwards an explicit worker override through start and execute", async () => {
  await withProviderMcpFixture(async ({ client, store, orchestrator }) => {
    const started = await client.callTool({
      name: "ark_team_start",
      arguments: {
        objective: "Start an external worker run",
        project_path: store.projectPath,
        model_overrides: EXTERNAL_OVERRIDE,
      },
    });
    const executed = await client.callTool({
      name: "ark_team_execute",
      arguments: {
        objective: "Execute an external worker run",
        project_path: store.projectPath,
        model_overrides: EXTERNAL_OVERRIDE,
      },
    });

    assert.equal(started.isError, undefined);
    assert.equal(executed.isError, undefined);
    assert.deepEqual(store.inputs[0]?.model_overrides, EXTERNAL_OVERRIDE);
    assert.deepEqual(orchestrator.inputs[0]?.model_overrides, EXTERNAL_OVERRIDE);
    assert.deepEqual(store.inputs[1]?.model_overrides, EXTERNAL_OVERRIDE);

    for (const result of [started, executed]) {
      const payload = result.structuredContent as
        | {
            ok?: boolean;
            run?: {
              model_bindings?: {
                worker?: {
                  kind?: string;
                  provider_id?: string;
                  app_server_provider_id?: string;
                  adapter_id?: string;
                  model?: string;
                  requested_reasoning_effort?: string;
                  effective_reasoning_effort?: string;
                };
              };
            };
          }
        | undefined;
      const binding = payload?.run?.model_bindings?.worker;
      assert.equal(payload?.ok, true);
      assert.deepEqual(
        {
          kind: binding?.kind,
          provider_id: binding?.provider_id,
          app_server_provider_id: binding?.app_server_provider_id,
          adapter_id: binding?.adapter_id,
          model: binding?.model,
          requested_reasoning_effort:
            binding?.requested_reasoning_effort,
          effective_reasoning_effort:
            binding?.effective_reasoning_effort,
        },
        {
          kind: "external",
          provider_id: "company_ai",
          app_server_provider_id: "ark_company_ai",
          adapter_id: "builtin:openai-chat",
          model: "model-1",
          requested_reasoning_effort: "xhigh",
          effective_reasoning_effort: "max",
        },
      );
    }

    assert.equal(
      JSON.stringify([started, executed]).includes(INLINE_CANARY),
      false,
    );
  });
});

test("TEST-003 rejects unknown and invalid overrides in both MCP tool schemas", async () => {
  await withProviderMcpFixture(async ({ client, store, orchestrator }) => {
    const rejectedOverrides: unknown[] = [
      {
        worker: EXTERNAL_OVERRIDE.worker,
        pm: {
          provider: "company_ai",
          model: "model-1",
          reasoning_effort: "xhigh",
        },
      },
      {
        worker: {
          provider: "company_ai",
          model: "model-1",
          reasoning_effort: "ultra",
        },
      },
      {
        worker: {
          ...EXTERNAL_OVERRIDE.worker,
          api_key: INLINE_CANARY,
        },
      },
    ];

    for (const toolName of ["ark_team_start", "ark_team_execute"]) {
      for (const modelOverrides of rejectedOverrides) {
        const rejected = await client.callTool({
          name: toolName,
          arguments: {
            objective: "Reject an invalid worker override",
            project_path: store.projectPath,
            model_overrides: modelOverrides,
          },
        });
        assert.equal(rejected.isError, true);
        assert.equal(JSON.stringify(rejected).includes(INLINE_CANARY), false);
      }
    }

    assert.equal(store.inputs.length, 0);
    assert.equal(orchestrator.inputs.length, 0);
  });
});

test("TEST-003 and TEST-012 preserve no-override input and response compatibility", async () => {
  await withProviderMcpFixture(async ({ client, store, orchestrator }) => {
    const started = await client.callTool({
      name: "ark_team_start",
      arguments: {
        objective: "Start the native worker default",
        project_path: store.projectPath,
      },
    });
    const executed = await client.callTool({
      name: "ark_team_execute",
      arguments: {
        objective: "Execute the native worker default",
        project_path: store.projectPath,
      },
    });

    assert.equal(started.isError, undefined);
    assert.equal(executed.isError, undefined);
    assert.equal(
      Object.hasOwn(store.inputs[0] ?? {}, "model_overrides"),
      false,
    );
    assert.equal(
      Object.hasOwn(orchestrator.inputs[0] ?? {}, "model_overrides"),
      false,
    );
    assert.equal(
      Object.hasOwn(store.inputs[1] ?? {}, "model_overrides"),
      false,
    );

    const startedPayload = started.structuredContent as
      | {
          ok?: boolean;
          run?: RunRecord;
        }
      | undefined;
    const executedPayload = executed.structuredContent as
      | ({ ok?: boolean } & Partial<ExecuteArkTeamResult>)
      | undefined;
    assert.deepEqual(Object.keys(startedPayload ?? {}).sort(), [
      "ok",
      "run",
    ]);
    assert.deepEqual(Object.keys(executedPayload ?? {}).sort(), [
      "assignments",
      "integration",
      "ok",
      "pm_report",
      "pm_session",
      "progressed",
      "remote_action_required",
      "run",
      "teams",
      "waiting_approvals",
      "waiting_retries",
    ]);
    assert.equal(startedPayload?.ok, true);
    assert.equal(executedPayload?.ok, true);
    assert.deepEqual(
      startedPayload?.run?.model_bindings.worker,
      NATIVE_WORKER_MODEL_BINDING,
    );
    assert.deepEqual(
      executedPayload?.run?.model_bindings.worker,
      NATIVE_WORKER_MODEL_BINDING,
    );
  });
});

interface ProviderMcpFixture {
  client: Client;
  store: FakeProviderStore;
  orchestrator: FakeExecutionController;
}

async function withProviderMcpFixture(
  operation: (fixture: ProviderMcpFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-provider-mcp-"));
  const projectPath = path.join(root, "project");
  const catalogDirectory = path.join(root, "catalog");
  const catalogPath = path.join(catalogDirectory, "providers-v1.toml");
  const environment: NodeJS.ProcessEnv = {
    ARK_TEAM_PROVIDER_CONFIG: catalogPath,
  };

  await mkdir(projectPath);
  await mkdir(catalogDirectory, { mode: 0o700 });
  await writeFile(catalogPath, providerCatalog(), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(catalogDirectory, 0o700);
  await chmod(catalogPath, 0o600);

  const store = new FakeProviderStore(
    path.join(root, "state"),
    projectPath,
    environment,
  );
  const scheduler = new ManagedAssignmentScheduler(store, {
    provider_environment: environment,
  });
  const materializer = new PlanMaterializer(store);
  const coordinator: TeamExecutionCoordinator = {
    async advance() {
      throw new Error("fake coordinator must not be called");
    },
  };
  const orchestrator = new FakeExecutionController(store);
  const server = createArkTeamMcpServer(
    store,
    scheduler,
    materializer,
    coordinator,
    orchestrator,
  );
  const client = new Client(
    { name: "ark-team-provider-mcp-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await operation({ client, store, orchestrator });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

class FakeProviderStore extends RunStore {
  readonly inputs: CreateRunInput[] = [];
  private sequence = 0;

  constructor(
    rootPath: string,
    readonly projectPath: string,
    private readonly fakeProviderEnvironment: NodeJS.ProcessEnv,
  ) {
    super({
      root_path: rootPath,
      environment: fakeProviderEnvironment,
    });
  }

  override async createRun(input: CreateRunInput): Promise<RunRecord> {
    this.inputs.push(structuredClone(input));
    const workerBinding = await resolveRunWorkerBinding(
      input.model_overrides,
      { environment: this.fakeProviderEnvironment },
    );
    this.sequence += 1;
    const timestamp = "2026-07-27T00:00:00.000Z";
    return {
      schema_version: 1,
      run_id: `ark-20260727t000000z-${String(this.sequence).padStart(6, "0")}`,
      objective: input.objective,
      project_path: input.project_path,
      state: "planning",
      resume_state: null,
      created_at: timestamp,
      updated_at: timestamp,
      revision: 1,
      event_count: 1,
      assignment_count: 0,
      team_count: 0,
      project_config: input.project_config ?? DEFAULT_PROJECT_CONFIG,
      project_config_source: input.project_config_source ?? null,
      project_config_sha256: null,
      verification_snapshot: null,
      verification_snapshot_sha256: null,
      verification_records: [],
      verification_state: null,
      verification_cleanup_audit: null,
      model_bindings: {
        worker: workerBinding,
      },
    };
  }
}

class FakeExecutionController implements ArkTeamExecutionController {
  readonly inputs: ExecuteArkTeamInput[] = [];

  constructor(private readonly store: FakeProviderStore) {}

  async execute(input: ExecuteArkTeamInput): Promise<ExecuteArkTeamResult> {
    this.inputs.push(structuredClone(input));
    const run = await this.store.createRun(input);
    return {
      run,
      pm_session: {
        session_id: "fake-pm-session",
        agent_name: "ark_pm",
        model: "gpt-5.6-sol",
        model_reasoning_effort: "xhigh",
        sandbox_mode: "read-only",
        approval_policy: "never",
        usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
        planned_at: "2026-07-27T00:00:00.000Z",
        turn_count: 1,
        final_report: null,
        final_usage: null,
        completed_at: null,
      },
      teams: [],
      assignments: [],
      integration: null,
      pm_report: null,
      remote_action_required: false,
      progressed: false,
      waiting_approvals: 0,
      waiting_retries: 0,
    };
  }
}

function providerCatalog(): string {
  return [
    "version = 1",
    "",
    "[providers.company_ai]",
    'adapter = "builtin:openai-chat"',
    'base_url = "https://api.example.invalid/v1"',
    'auth_kind = "inline_key"',
    `api_key = "${INLINE_CANARY}"`,
    'structured_output_mode = "validated_json"',
    'policy = "standard"',
    'allowed_models = ["model-1"]',
    "",
    "[providers.company_ai.reasoning_effort_map]",
    'xhigh = "max"',
    "",
  ].join("\n");
}
