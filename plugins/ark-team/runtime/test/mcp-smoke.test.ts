import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const pluginRoot = path.join(repositoryRoot, "plugins/ark-team");

let temporaryRoot: string;
let projectRoot: string;
let client: Client;
let transport: StdioClientTransport;

before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-mcp-test-"));
  projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot);

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
      "ark_team_cancel",
      "ark_team_list",
      "ark_team_logs",
      "ark_team_pause",
      "ark_team_resume",
      "ark_team_start",
      "ark_team_status",
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
});
