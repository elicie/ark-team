import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = process.env.ARK_TEAM_INSTALLED_PLUGIN_ROOT?.trim();
if (!pluginRoot || !path.isAbsolute(pluginRoot)) {
  throw new Error(
    "ARK_TEAM_INSTALLED_PLUGIN_ROOT must identify an absolute installed plugin root",
  );
}

const expectedTools = [
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
].sort();

await Promise.all([
  access(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
  access(path.join(pluginRoot, ".mcp.json")),
  access(path.join(pluginRoot, "skills", "ark-team", "SKILL.md")),
  access(path.join(pluginRoot, "runtime", "dist", "server.js")),
]);
const manifest = JSON.parse(
  await readFile(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    "utf8",
  ),
);
if (manifest.name !== "ark-team") {
  throw new Error("Installed plugin manifest is not ark-team");
}

const stateRoot = await mkdtemp(path.join(tmpdir(), "ark-team-installed-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["runtime/dist/server.js"],
  cwd: pluginRoot,
  env: {
    ...getDefaultEnvironment(),
    ARK_TEAM_STATE_ROOT: stateRoot,
  },
  stderr: "pipe",
});
const client = new Client(
  {
    name: "ark-team-installed-verifier",
    version: "0.1.0",
  },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
    throw new Error(
      `Installed MCP tool list mismatch: ${JSON.stringify(tools)}`,
    );
  }
  console.log(
    JSON.stringify({
      status: "INSTALLED_PLUGIN_VERIFIED",
      plugin_root: pluginRoot,
      version: manifest.version,
      tools: tools.length,
    }),
  );
} finally {
  await client.close();
  await rm(stateRoot, { recursive: true, force: true });
}
