import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const pluginRoot = path.join(repositoryRoot, "plugins/ark-team");
const execFileAsync = promisify(execFile);
const PROVIDER_CANARY = "built-mcp-provider-canary";

let temporaryRoot: string;
let projectRoot: string;
let client: Client;
let transport: StdioClientTransport;

before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-mcp-test-"));
  projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);
  await execFileAsync("git", ["init", "-b", "main", projectRoot]);
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "config",
    "user.name",
    "Ark Team Test",
  ]);
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "config",
    "user.email",
    "ark-team-test@example.invalid",
  ]);
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "commit",
    "--allow-empty",
    "-m",
    "baseline",
  ]);
  const providerCatalogDirectory = path.join(
    temporaryRoot,
    "provider-catalog",
  );
  const providerCatalogPath = path.join(
    providerCatalogDirectory,
    "providers-v1.toml",
  );
  await mkdir(providerCatalogDirectory, { mode: 0o700 });
  await writeFile(
    providerCatalogPath,
    [
      "version = 1",
      "",
      "[providers.bundle_test]",
      'adapter = "builtin:openai-chat"',
      'base_url = "https://provider.example.invalid/v1"',
      'auth_kind = "inline_key"',
      `api_key = "${PROVIDER_CANARY}"`,
      'structured_output_mode = "validated_json"',
      'policy = "standard"',
      'allowed_models = ["model-bundle-test"]',
      "",
      "[providers.bundle_test.reasoning_effort_map]",
      'high = "high"',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  const pluginConfig = JSON.parse(
    await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"),
  ) as {
    mcpServers: {
      "ark-team": {
        command: string;
        args: string[];
        cwd: string;
      };
    };
  };
  const serverConfig = pluginConfig.mcpServers["ark-team"];

  transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    cwd: path.resolve(pluginRoot, serverConfig.cwd),
    env: {
      ...getDefaultEnvironment(),
      ARK_TEAM_STATE_ROOT: path.join(temporaryRoot, "state"),
      ARK_TEAM_PROVIDER_CONFIG: providerCatalogPath,
    },
    stderr: "pipe",
  });
  client = new Client(
    {
      name: "ark-team-test-client",
      version: "0.1.0",
    },
    {
      capabilities: {},
    },
  );
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("TEST-006 and TEST-1406 expose configured lifecycle through MCP", async () => {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "ark_team_advance",
      "ark_team_assignment_cancel",
    "ark_team_assignment_decide",
    "ark_team_assignment_list",
    "ark_team_assignment_recover",
    "ark_team_assignment_retry_decide",
      "ark_team_assignment_start",
      "ark_team_assignment_status",
      "ark_team_cancel",
      "ark_team_execute",
      "ark_team_list",
      "ark_team_logs",
      "ark_team_pause",
      "ark_team_plan_apply",
      "ark_team_remote_decide",
      "ark_team_resume",
      "ark_team_start",
      "ark_team_status",
      "ark_team_team_list",
    ],
  );

  await mkdir(path.join(projectRoot, ".codex"));
  await writeFile(
    path.join(projectRoot, ".codex", "team-orchestrator.toml"),
    [
      "version = 1",
      "",
      "[organization]",
      "max_teams = 2",
      "max_workers_per_team = 2",
    ].join("\n"),
    "utf8",
  );
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "add",
    ".codex/team-orchestrator.toml",
  ]);
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "commit",
    "-m",
    "project configuration",
  ]);
  const started = await client.callTool({
    name: "ark_team_start",
    arguments: {
      objective: "MCP smoke test",
      project_path: projectRoot,
    },
  });
  assert.equal(started.isError, undefined);
  const startedPayload = started.structuredContent as
    | {
        ok?: boolean;
        run?: {
          run_id: string;
          project_config_source?: string | null;
          project_config?: {
            organization?: { max_teams?: number; max_workers_per_team?: number };
          };
        };
      }
    | undefined;
  assert.equal(startedPayload?.ok, true);

  const run = startedPayload?.run;
  assert.equal(typeof run, "object");
  assert.notEqual(run, null);
  const runId = run?.run_id;
  assert.equal(typeof runId, "string");
  assert.equal(
    run?.project_config_source,
    path.join(projectRoot, ".codex", "team-orchestrator.toml"),
  );
  assert.equal(run?.project_config?.organization?.max_teams, 2);
  assert.equal(run?.project_config?.organization?.max_workers_per_team, 2);

  const status = await client.callTool({
    name: "ark_team_status",
    arguments: {
      run_id: runId,
    },
  });
  const statusPayload = status.structuredContent as
    | { ok?: boolean; run?: { run_id: string } }
    | undefined;
  assert.equal(statusPayload?.ok, true);
  assert.equal(statusPayload?.run?.run_id, runId);

  const applied = await client.callTool({
    name: "ark_team_plan_apply",
    arguments: {
      run_id: runId,
      plan: {
        kind: "pm_plan",
        objective: "MCP smoke test",
        teams: [
          {
            team_id: "team-a",
            mission: "Prepare the bounded team workspace.",
            owned_paths: ["src/team-a.ts"],
            dependencies: [],
            acceptance_criteria: ["The workspace is ready."],
            verification: ["Verify the linked worktree."],
            worker_count: 1,
          },
        ],
        integration: {
          strategy: "local_merge",
          acceptance_criteria: ["The team result can be integrated."],
          verification: ["Run repository tests."],
        },
      },
    },
  });
  assert.equal(applied.isError, undefined);
  const appliedPayload = applied.structuredContent as
    | {
        ok?: boolean;
        run?: { state?: string; team_count?: number };
        teams?: Array<{ working_directory?: string }>;
      }
    | undefined;
  assert.equal(appliedPayload?.ok, true);
  assert.equal(appliedPayload?.run?.state, "staffing");
  assert.equal(appliedPayload?.run?.team_count, 1);
  const worktreePath = appliedPayload?.teams?.[0]?.working_directory;
  assert.equal(typeof worktreePath, "string");
  assert.equal(
    (await readFile(path.join(worktreePath ?? "", ".git"), "utf8")).startsWith(
      "gitdir:",
    ),
    true,
  );

  const teams = await client.callTool({
    name: "ark_team_team_list",
    arguments: { run_id: runId },
  });
  const teamsPayload = teams.structuredContent as
    | { ok?: boolean; total?: number }
    | undefined;
  assert.equal(teamsPayload?.ok, true);
  assert.equal(teamsPayload?.total, 1);

  const externalStarted = await client.callTool({
    name: "ark_team_start",
    arguments: {
      objective: "Built MCP provider binding smoke test",
      project_path: projectRoot,
      model_overrides: {
        worker: {
          provider: "bundle_test",
          model: "model-bundle-test",
          reasoning_effort: "high",
        },
      },
    },
  });
  assert.equal(externalStarted.isError, undefined);
  const externalPayload = externalStarted.structuredContent as
    | {
        ok?: boolean;
        run?: {
          model_bindings?: {
            worker?: {
              adapter_sha256?: string | null;
            };
          };
        };
      }
    | undefined;
  assert.equal(externalPayload?.ok, true);
  const builtAdapter = await readFile(
    path.join(pluginRoot, "runtime/dist/adapters/openai-chat.js"),
  );
  const expectedAdapterSha256 = createHash("sha256")
    .update(builtAdapter)
    .digest("hex");
  assert.equal(
    externalPayload?.run?.model_bindings?.worker?.adapter_sha256,
    expectedAdapterSha256,
  );
  assert.equal(
    JSON.stringify(externalStarted).includes(PROVIDER_CANARY),
    false,
  );
});
