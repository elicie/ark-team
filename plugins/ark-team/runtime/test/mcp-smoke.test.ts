import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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

test("TEST-006 exposes lifecycle tools and persists a run through MCP", async () => {
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "ark_team_assignment_cancel",
      "ark_team_assignment_decide",
      "ark_team_assignment_list",
      "ark_team_assignment_start",
      "ark_team_assignment_status",
      "ark_team_cancel",
      "ark_team_execute",
      "ark_team_list",
      "ark_team_logs",
      "ark_team_pause",
      "ark_team_plan_apply",
      "ark_team_resume",
      "ark_team_start",
      "ark_team_status",
      "ark_team_team_list",
    ],
  );

  const started = await client.callTool({
    name: "ark_team_start",
    arguments: {
      objective: "MCP smoke test",
      project_path: projectRoot,
    },
  });
  assert.equal(started.isError, undefined);
  const startedPayload = started.structuredContent as
    | { ok?: boolean; run?: { run_id: string } }
    | undefined;
  assert.equal(startedPayload?.ok, true);

  const run = startedPayload?.run;
  assert.equal(typeof run, "object");
  assert.notEqual(run, null);
  const runId = run?.run_id;
  assert.equal(typeof runId, "string");

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
});
