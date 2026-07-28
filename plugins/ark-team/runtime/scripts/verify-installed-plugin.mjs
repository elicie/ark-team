import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const PLAYWRIGHT_VERSION = "1.62.0";
const PLAYWRIGHT_INTEGRITY =
  "sha512-9zOJ6ZQRAena31MpOH9VSzIz8Ou3YJ/wtY/eQm5T2uhfhG7/U3COrMS8xOtUrZrp9OgdmzEnIYODye3nY1VqzA==";
const CHROMIUM_REVISION = "1234";
const CHROMIUM_VERSION = "151.0.7922.34";
const SPEC_SHA256 =
  "29f69eda06ba8bf47d32e0e3914686f147ef0e5e7c01d3d18f4cd3b4549f4047";
const RESOLVER_ARGUMENT =
  "--host-resolver-rules=MAP devbox 127.0.0.1";
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

const scriptPluginRoot = await realpath(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const pluginRoot = await resolveRoot(
  process.env.ARK_TEAM_INSTALLED_PLUGIN_ROOT,
  scriptPluginRoot,
  "ARK_TEAM_INSTALLED_PLUGIN_ROOT",
);
const expectedPluginRoot = await resolveRoot(
  process.env.ARK_TEAM_EXPECTED_PLUGIN_ROOT,
  undefined,
  "ARK_TEAM_EXPECTED_PLUGIN_ROOT",
);
if (expectedPluginRoot === pluginRoot) {
  throw new Error(
    "ARK_TEAM_EXPECTED_PLUGIN_ROOT must differ from the installed plugin root",
  );
}

for (const relativePath of parityFiles) {
  await Promise.all([
    access(path.join(pluginRoot, relativePath)),
    access(path.join(expectedPluginRoot, relativePath)),
  ]);
}

const [manifest, expectedManifest] = await Promise.all([
  readJson(path.join(pluginRoot, ".codex-plugin/plugin.json")),
  readJson(path.join(expectedPluginRoot, ".codex-plugin/plugin.json")),
]);
if (manifest.name !== "ark-team" || expectedManifest.name !== "ark-team") {
  throw new Error("installed or expected plugin manifest is not ark-team");
}
if (manifest.version !== expectedManifest.version) {
  throw new Error(
    `installed plugin version ${manifest.version} does not match ${expectedManifest.version}`,
  );
}

const parity = {};
for (const relativePath of parityFiles) {
  const [installedBytes, expectedBytes] = await Promise.all([
    readFile(path.join(pluginRoot, relativePath)),
    readFile(path.join(expectedPluginRoot, relativePath)),
  ]);
  const installedSha256 = sha256(installedBytes);
  if (installedSha256 !== sha256(expectedBytes)) {
    throw new Error(`installed plugin file is stale: ${relativePath}`);
  }
  parity[relativePath] = installedSha256;
}

const packageLock = await readJson(path.join(pluginRoot, "package-lock.json"));
const rootPlaywright =
  packageLock.packages?.[""]?.dependencies?.["@playwright/test"];
const lockedPlaywright =
  packageLock.packages?.["node_modules/@playwright/test"];
if (
  rootPlaywright !== PLAYWRIGHT_VERSION ||
  lockedPlaywright?.version !== PLAYWRIGHT_VERSION ||
  lockedPlaywright.integrity !== PLAYWRIGHT_INTEGRITY
) {
  throw new Error("installed plugin lockfile has unapproved Playwright bytes");
}

const installedRequire = createRequire(
  path.join(pluginRoot, "runtime/dist/server.js"),
);
const playwrightPackagePath = installedRequire.resolve(
  "@playwright/test/package.json",
);
await assertInsidePluginNodeModules(pluginRoot, playwrightPackagePath);
const playwrightPackage = await readJson(playwrightPackagePath);
if (playwrightPackage.version !== PLAYWRIGHT_VERSION) {
  throw new Error("installed @playwright/test version is not approved");
}

const corePackagePath = installedRequire.resolve(
  "playwright-core/package.json",
);
await assertInsidePluginNodeModules(pluginRoot, corePackagePath);
const browsers = await readJson(
  path.join(path.dirname(corePackagePath), "browsers.json"),
);
const headlessShell = browsers.browsers?.find(
  ({ name }) => name === "chromium-headless-shell",
);
if (
  headlessShell?.revision !== CHROMIUM_REVISION ||
  headlessShell.browserVersion !== CHROMIUM_VERSION
) {
  throw new Error("installed Playwright browser registry is not approved");
}

const installedSpecSha256 = sha256(
  await readFile(
    path.join(
      pluginRoot,
      "runtime/contracts/verification-ui-runtime/SPEC.md",
    ),
  ),
);
if (installedSpecSha256 !== SPEC_SHA256) {
  throw new Error("installed UI runtime SPEC bytes are not approved");
}

const stateRoot = await mkdtemp(path.join(tmpdir(), "ark-team-installed-"));
const transport = new StdioClientTransport({
  command: process.execPath,
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
    version: "0.2.0",
  },
  { capabilities: {} },
);
let fixture;
let browser;
let context;
let verificationResult;
let verificationError;
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
    throw new Error(
      `installed MCP tool list mismatch: ${JSON.stringify(tools)}`,
    );
  }

  fixture = await startFixtureServer();
  const { chromium } = installedRequire("@playwright/test");
  browser = await chromium.launch({
    headless: true,
    args: [RESOLVER_ARGUMENT],
    env: browserEnvironment(),
    timeout: 60_000,
  });
  if (browser.version() !== CHROMIUM_VERSION) {
    throw new Error(
      `installed Chromium ${browser.version()} does not match ${CHROMIUM_VERSION}`,
    );
  }
  context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  const page = await context.newPage();
  const response = await page.goto(fixture.url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (
    response?.status() !== 200 ||
    (await page.getByRole("heading").textContent()) !==
      "Ark Team installed UI smoke"
  ) {
    throw new Error("installed Playwright could not verify the devbox fixture");
  }
  const screenshot = await page.screenshot({ type: "png" });
  if (
    screenshot.length < 8 ||
    !screenshot.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  ) {
    throw new Error("installed Playwright did not produce a PNG screenshot");
  }

  verificationResult = {
    status: "INSTALLED_PLUGIN_VERIFIED",
    plugin_root: pluginRoot,
    expected_plugin_root: expectedPluginRoot,
    version: manifest.version,
    runtime_sha256: parity["runtime/dist/server.js"],
    tools: tools.length,
    playwright_version: playwrightPackage.version,
    browser_version: browser.version(),
    ui_smoke_url: fixture.url,
  };
} catch (error) {
  verificationError = error;
}

const cleanupErrors = [];
for (const [label, operation] of [
  ["browser context", context && (() => context.close())],
  ["browser", browser && (() => browser.close())],
  ["fixture server", fixture && (() => fixture.close())],
  ["MCP client", () => client.close()],
  [
    "temporary state",
    () => rm(stateRoot, { recursive: true, force: true }),
  ],
]) {
  if (!operation) {
    continue;
  }
  try {
    await boundedCleanup(label, operation);
  } catch (error) {
    cleanupErrors.push(error);
  }
}

if (verificationError || cleanupErrors.length > 0) {
  const errors = [
    ...(verificationError ? [verificationError] : []),
    ...cleanupErrors,
  ];
  throw errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "installed plugin verification failed");
}
console.log(JSON.stringify(verificationResult));

async function resolveRoot(value, fallback, variableName) {
  const candidate = value?.trim() || fallback;
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error(`${variableName} must identify an absolute plugin root`);
  }
  return realpath(candidate);
}

async function boundedCleanup(label, operation) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} cleanup timed out after 5 seconds`));
    }, 5_000);
    timeout.unref();
  });
  try {
    await Promise.race([operation(), timeoutPromise]);
  } catch (error) {
    throw new Error(`${label} cleanup failed`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertInsidePluginNodeModules(root, filePath) {
  const [moduleRoot, resolvedFile] = await Promise.all([
    realpath(path.join(root, "node_modules")),
    realpath(filePath),
  ]);
  const relation = path.relative(moduleRoot, resolvedFile);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error(
      `installed dependency escaped plugin node_modules: ${filePath}`,
    );
  }
}

function browserEnvironment() {
  const environment = {};
  for (const key of [
    "FONTCONFIG_PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "PATH",
    "TMPDIR",
    "XDG_DATA_DIRS",
  ]) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key];
    }
  }
  environment.TZ = "UTC";
  return environment;
}

async function startFixtureServer() {
  for (let port = 10_001; port <= 10_100; port += 1) {
    const server = createServer((request, response) => {
      if (request.headers.host !== `devbox:${port}`) {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      response.end(
        "<!doctype html><title>Ark Team smoke</title><h1>Ark Team installed UI smoke</h1>",
      );
    });
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "0.0.0.0");
      });
      return {
        url: `http://devbox:${port}/`,
        close: () =>
          new Promise((resolve, reject) => {
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          }),
      };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw new Error("no verification fixture port is available at 10001-10100");
}
