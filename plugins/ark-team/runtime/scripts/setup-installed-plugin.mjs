import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const parityFiles = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "package.json",
  "package-lock.json",
  "runtime/contracts/verification-ui-runtime/SPEC.md",
  "runtime/dist/adapters/openai-chat.js",
  "runtime/dist/approval-session.js",
  "runtime/dist/server.js",
  "runtime/dist/session-cli.js",
  "runtime/scripts/setup-installed-plugin.mjs",
  "runtime/scripts/sync-verification-ui-spec.mjs",
  "runtime/scripts/verify-installed-plugin.mjs",
  "skills/ark-team/SKILL.md",
];

if (Number.parseInt(process.versions.node, 10) < 20) {
  throw new Error("ark-team UI QA requires Node.js 20 or newer");
}

const expectedPluginRoot = await realpath(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const installedRootValue = process.env.ARK_TEAM_INSTALLED_PLUGIN_ROOT?.trim();
if (!installedRootValue || !path.isAbsolute(installedRootValue)) {
  throw new Error(
    "ARK_TEAM_INSTALLED_PLUGIN_ROOT must identify the absolute installed plugin root",
  );
}
const pluginRoot = await realpath(installedRootValue);
if (expectedPluginRoot === pluginRoot) {
  throw new Error(
    "setup must run from the source plugin, not the installed plugin",
  );
}
const manifest = JSON.parse(
  await readFile(
    path.join(pluginRoot, ".codex-plugin/plugin.json"),
    "utf8",
  ),
);
const expectedManifest = JSON.parse(
  await readFile(
    path.join(expectedPluginRoot, ".codex-plugin/plugin.json"),
    "utf8",
  ),
);
if (manifest.name !== "ark-team" || expectedManifest.name !== "ark-team") {
  throw new Error("setup requires installed and source ark-team plugin roots");
}
if (manifest.version !== expectedManifest.version) {
  throw new Error(
    `installed plugin version ${manifest.version} does not match ${expectedManifest.version}`,
  );
}

for (const relativePath of parityFiles) {
  const [installedBytes, expectedBytes] = await Promise.all([
    readFile(path.join(pluginRoot, relativePath)),
    readFile(path.join(expectedPluginRoot, relativePath)),
  ]);
  if (!installedBytes.equals(expectedBytes)) {
    throw new Error(`installed plugin file is stale: ${relativePath}`);
  }
}

await run(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
);
await run(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "playwright", "install", "chromium"],
);
await run(process.execPath, [
  path.join(pluginRoot, "runtime/scripts/verify-installed-plugin.mjs"),
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      env: {
        ...process.env,
        ARK_TEAM_INSTALLED_PLUGIN_ROOT: pluginRoot,
        ARK_TEAM_EXPECTED_PLUGIN_ROOT: expectedPluginRoot,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} failed with ${signal === null ? `exit ${code}` : `signal ${signal}`}`,
        ),
      );
    });
  });
}
