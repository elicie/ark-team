import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDirectory, "../..");
const sourceOnly = process.argv.includes("--source-only");
const commit = "ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10";

const contractPath = path.join(
  pluginRoot,
  "runtime/src/provider-adapter.ts",
);
const adapterPath = path.join(
  pluginRoot,
  "runtime/src/adapters/openai-chat.ts",
);
const noticePath = path.join(
  pluginRoot,
  "LICENSES/OpenCodex-MIT.txt",
);
const manifestPath = path.join(pluginRoot, ".mcp.json");

const [contract, adapter, notice, manifestText] = await Promise.all([
  readFile(contractPath, "utf8"),
  readFile(adapterPath, "utf8"),
  readFile(noticePath, "utf8"),
  readFile(manifestPath, "utf8"),
]);

assertIncludes(contract, [
  "OpenCodex v2.7.41",
  commit,
  "src/adapters/base.ts",
  "../../LICENSES/OpenCodex-MIT.txt",
]);
assertIncludes(adapter, [
  "OpenCodex v2.7.41",
  commit,
  "src/adapters/openai-chat.ts",
  "../../../LICENSES/OpenCodex-MIT.txt",
]);
assertIncludes(notice, [
  "Project: OpenCodex",
  "Tag: v2.7.41",
  `Commit: ${commit}`,
  "src/adapters/base.ts",
  "src/adapters/openai-chat.ts",
  "MIT License",
  "The above copyright notice and this permission notice shall be included",
]);

for (const source of [contract, adapter]) {
  if (
    /\b(?:import|export)\b[\s\S]{0,200}\bfrom\s+["'][^"']*opencodex[^"']*["']/i.test(
      source,
    )
  ) {
    throw new Error(
      "provider adapter source imports forbidden OpenCodex product internals",
    );
  }
}

const manifest = JSON.parse(manifestText);
const forwarded =
  manifest?.mcpServers?.["ark-team"]?.env_vars;
if (
  !Array.isArray(forwarded) ||
  !forwarded.includes("ARK_TEAM_PROVIDER_CONFIG")
) {
  throw new Error(
    "plugin MCP manifest must forward ARK_TEAM_PROVIDER_CONFIG",
  );
}

if (!sourceOnly) {
  const builtAdapterPath = path.join(
    pluginRoot,
    "runtime/dist/adapters/openai-chat.js",
  );
  await access(builtAdapterPath);
  const builtAdapter = await readFile(builtAdapterPath, "utf8");
  assertIncludes(builtAdapter, [
    "OpenCodex v2.7.41",
    commit,
    "src/adapters/openai-chat.ts",
  ]);
}

process.stdout.write(
  `TEST-013 provider provenance and MIT notice verified (${sourceOnly ? "source" : "distribution"})\n`,
);

function assertIncludes(value, expected) {
  for (const marker of expected) {
    if (!value.includes(marker)) {
      throw new Error(`provider provenance marker is missing: ${marker}`);
    }
  }
}
