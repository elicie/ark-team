import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createArkTeamMcpServer } from "./mcp-server.js";
import { resolveStateRoot, RunStore } from "./state-store.js";

async function main(): Promise<void> {
  const store = new RunStore({ root_path: resolveStateRoot() });
  const server = createArkTeamMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Ark Team MCP server running on stdio; state root: ${store.root_path}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Ark Team MCP server failed: ${message}`);
  process.exitCode = 1;
});
