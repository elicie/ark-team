import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { AppServerApprovalSession } from "../src/approval-session.js";
import { ProviderBridge } from "../src/provider-bridge.js";
import { resolveRunWorkerBinding } from "../src/provider-config.js";
import type { ExternalModelBindingSnapshotV1 } from "../src/provider-types.js";
import type { WorkerReport } from "../src/role-contracts.js";

const execFileAsync = promisify(execFile);
const LOOPBACK_HOST = "127.0.0.1";
const FIRST_TEST_PORT = 10001;
const LAST_TEST_PORT = 10100;
const MODEL = "fake-e2e-model";
const EXPECTED_USAGE = {
  input_tokens: 29,
  cached_input_tokens: 7,
  cache_write_input_tokens: 0,
  output_tokens: 19,
  reasoning_output_tokens: 3,
};

const AUTH_VARIANTS = [
  {
    authKind: "inline_key",
    providerId: "fake_inline",
    credential: "inline-e2e-key-canary",
    environmentName: null,
  },
  {
    authKind: "env_key",
    providerId: "fake_env",
    credential: "environment-e2e-key-canary",
    environmentName: "ARK_TEAM_E2E_PROVIDER_KEY",
  },
] as const;

test(
  "SLICE-001 completes strict worker reports through Codex app-server for inline_key and env_key",
  { timeout: 120_000 },
  async (context) => {
    const { stdout: version } = await execFileAsync("codex", [
      "--version",
    ]);
    assert.equal(version.trim(), "codex-cli 0.145.0");

    const root = await mkdtemp(
      path.join(tmpdir(), "ark-team-provider-app-server-e2e-"),
    );
    const userConfigPath = path.join(
      homedir(),
      ".codex",
      "config.toml",
    );
    const userConfigBefore = await fileIdentity(userConfigPath);
    context.after(async () => {
      try {
        assert.deepEqual(
          await fileIdentity(userConfigPath),
          userConfigBefore,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    const worktree = await createLinkedWorktree(root);
    for (const variant of AUTH_VARIANTS) {
      await context.test(
        `TEST-005/009/012 ${variant.authKind}`,
        { timeout: 50_000 },
        async () => {
          await runAuthVariant(root, worktree, variant);
        },
      );
    }
  },
);

async function runAuthVariant(
  root: string,
  worktree: string,
  variant: (typeof AUTH_VARIANTS)[number],
): Promise<void> {
  const report = workerReport(variant.authKind);
  const upstream = await FakeOpenAIChatUpstream.start({
    expectedCredential: variant.credential,
    expectedModel: MODEL,
    report,
  });
  assert.equal(upstream.port >= FIRST_TEST_PORT, true);
  let bridge: ProviderBridge | null = null;
  let session: AppServerApprovalSession | null = null;
  let restoreProxyEnvironment: (() => void) | null = null;

  try {
    const fixtureRoot = path.join(root, variant.authKind);
    const catalogDirectory = path.join(fixtureRoot, "catalog");
    const catalogPath = path.join(
      catalogDirectory,
      "providers-v1.toml",
    );
    const codexHome = path.join(
      fixtureRoot,
      "state",
      "run-e2e",
      "external-codex-home",
    );
    await mkdir(catalogDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      catalogPath,
      providerCatalog(variant, upstream.port),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await chmod(catalogDirectory, 0o700);
    await chmod(catalogPath, 0o600);

    const environment: NodeJS.ProcessEnv = {
      ARK_TEAM_PROVIDER_CONFIG: catalogPath,
      ...(variant.environmentName === null
        ? {}
        : {
            [variant.environmentName]: variant.credential,
          }),
    };
    const binding = await externalBinding(
      variant.providerId,
      environment,
    );
    bridge = await ProviderBridge.start({
      binding,
      codex_home: codexHome,
      environment,
      request_timeout_ms: 30_000,
      stream_idle_timeout_ms: 15_000,
    });

    assert.deepEqual(
      {
        host: bridge.diagnostics.host,
        portAtLeast10001:
          bridge.diagnostics.port >= FIRST_TEST_PORT,
        provider_id: bridge.diagnostics.provider_id,
        adapter_id: bridge.diagnostics.adapter_id,
      },
      {
        host: LOOPBACK_HOST,
        portAtLeast10001: true,
        provider_id: variant.providerId,
        adapter_id: "builtin:openai-chat",
      },
    );
    assert.equal(
      bridge.external_runtime.codex_home,
      codexHome,
    );
    assert.deepEqual(
      bridge.external_runtime.upstream_env_names,
      variant.environmentName === null
        ? []
        : [variant.environmentName],
    );
    assert.equal(
      JSON.stringify({
        binding,
        runtime: bridge.external_runtime,
      }).includes(variant.credential),
      false,
    );

    restoreProxyEnvironment = installLoopbackProxyGuard(
      upstream.origin,
    );
    session = new AppServerApprovalSession({
      codex_path: "codex",
      timeout_ms: 40_000,
      external_runtime: bridge.external_runtime,
    });
    const update = await session.start({
      role: "worker",
      assignment:
        "Return the deterministic worker report. Do not call tools or modify files.",
      working_directory: worktree,
      output_contract: "worker_report",
      model_binding: binding,
    });

    assert.equal(update.status, "completed");
    if (update.status !== "completed") {
      return;
    }
    assert.equal(update.model, MODEL);
    assert.equal(update.model_reasoning_effort, "max");
    assert.equal(update.sandbox_mode, "workspace-write");
    assert.equal(update.approval_policy, "on-request");
    assert.equal(update.final_report, JSON.stringify(report));
    assert.deepEqual(update.structured_report, report);
    assert.deepEqual(update.usage, EXPECTED_USAGE);

    // Any best-effort child traffic outside the configured bridge is
    // terminated by the loopback proxy guard and is never forwarded.
    assert.equal(upstream.observations.length, 1);
    assert.deepEqual(upstream.observations[0], {
      authorizationMatches: true,
      model: MODEL,
      stream: true,
      requestsUsage: true,
      reasoningEffort: "max",
      strictWorkerSchema: true,
    });
    assert.equal(
      JSON.stringify({
        update,
        observations: upstream.observations,
      }).includes(variant.credential),
      false,
    );
    assert.equal(
      await directoryContains(codexHome, variant.credential),
      false,
    );
    assert.equal((await stat(codexHome)).mode & 0o777, 0o700);

    const catalogText = await readFile(catalogPath, "utf8");
    assert.equal(
      catalogText.includes(variant.credential),
      variant.authKind === "inline_key",
    );
  } finally {
    try {
      await session?.close();
    } finally {
      restoreProxyEnvironment?.();
      try {
        await bridge?.close();
      } finally {
        await upstream.close();
      }
    }
  }
}

async function externalBinding(
  providerId: string,
  environment: NodeJS.ProcessEnv,
): Promise<ExternalModelBindingSnapshotV1> {
  const binding = await resolveRunWorkerBinding(
    {
      worker: {
        provider: providerId,
        model: MODEL,
        reasoning_effort: "xhigh",
      },
    },
    { environment },
  );
  assert.equal(binding.kind, "external");
  if (binding.kind !== "external") {
    throw new Error("external provider fixture resolved to native");
  }
  return binding;
}

function providerCatalog(
  variant: (typeof AUTH_VARIANTS)[number],
  upstreamPort: number,
): string {
  return [
    "version = 1",
    "",
    `[providers.${variant.providerId}]`,
    'adapter = "builtin:openai-chat"',
    `base_url = "http://${LOOPBACK_HOST}:${upstreamPort}/v1"`,
    "allow_private_network = true",
    `auth_kind = "${variant.authKind}"`,
    ...(variant.environmentName === null
      ? [`api_key = "${variant.credential}"`]
      : [`api_key_env = "${variant.environmentName}"`]),
    'structured_output_mode = "native_json_schema"',
    'policy = "standard"',
    `allowed_models = ["${MODEL}"]`,
    "",
    `[providers.${variant.providerId}.reasoning_effort_map]`,
    'xhigh = "max"',
    "",
  ].join("\n");
}

function workerReport(authKind: string): WorkerReport {
  return {
    kind: "worker_report",
    team_id: "team-e2e",
    worker_key: `worker-${authKind.replace("_", "-")}`,
    status: "completed",
    summary: `The ${authKind} app-server E2E fixture completed.`,
    changed_files: [],
    commit_sha: null,
    verification: [
      {
        name: "fake upstream",
        status: "passed",
        evidence:
          "The deterministic loopback OpenAI Chat stream completed.",
      },
    ],
    blockers: [],
  };
}

interface UpstreamObservation {
  authorizationMatches: boolean;
  model: string | null;
  stream: boolean;
  requestsUsage: boolean;
  reasoningEffort: string | null;
  strictWorkerSchema: boolean;
}

interface FakeUpstreamOptions {
  expectedCredential: string;
  expectedModel: string;
  report: WorkerReport;
}

class FakeOpenAIChatUpstream {
  readonly observations: UpstreamObservation[] = [];
  unexpectedRequestCount = 0;
  port = 0;
  origin = "";
  private server: Server | null = null;

  private constructor(private readonly options: FakeUpstreamOptions) {}

  static async start(
    options: FakeUpstreamOptions,
  ): Promise<FakeOpenAIChatUpstream> {
    const fixture = new FakeOpenAIChatUpstream(options);
    await fixture.listen();
    return fixture;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null || !server.listening) {
      return;
    }
    server.closeIdleConnections();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async listen(): Promise<void> {
    for (
      let port = FIRST_TEST_PORT;
      port <= LAST_TEST_PORT;
      port += 1
    ) {
      const server = createServer((request, response) => {
        void this.respond(request, response);
      });
      server.on("connect", (_request, socket) => {
        this.unexpectedRequestCount += 1;
        socket.destroy();
      });
      try {
        await listen(server, port);
        this.server = server;
        this.port = port;
        this.origin = `http://${LOOPBACK_HOST}:${port}`;
        return;
      } catch (error) {
        if (!isAddressInUse(error)) {
          throw error;
        }
      }
    }
    throw new Error(
      `no loopback test port available from ${FIRST_TEST_PORT} to ${LAST_TEST_PORT}`,
    );
  }

  private async respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      request.method !== "POST" ||
      request.url !== "/v1/chat/completions"
    ) {
      this.unexpectedRequestCount += 1;
      response.writeHead(404);
      response.end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readRequestBody(request));
      if (!isRecord(parsed)) {
        throw new Error("request body is not an object");
      }
      body = parsed;
    } catch {
      this.unexpectedRequestCount += 1;
      response.writeHead(400);
      response.end();
      return;
    }

    const authorizationMatches =
      request.headers.authorization ===
      `Bearer ${this.options.expectedCredential}`;
    const observation: UpstreamObservation = {
      authorizationMatches,
      model: typeof body.model === "string" ? body.model : null,
      stream: body.stream === true,
      requestsUsage:
        isRecord(body.stream_options) &&
        body.stream_options.include_usage === true,
      reasoningEffort:
        typeof body.reasoning_effort === "string"
          ? body.reasoning_effort
          : null,
      strictWorkerSchema: hasStrictWorkerSchema(
        body.response_format,
      ),
    };
    this.observations.push(observation);

    if (
      !authorizationMatches ||
      observation.model !== this.options.expectedModel
    ) {
      response.writeHead(
        authorizationMatches ? 400 : 401,
        { "Content-Type": "application/json" },
      );
      response.end(
        JSON.stringify({
          error: {
            message: "fake upstream request validation failed",
          },
        }),
      );
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "close",
    });
    const report = JSON.stringify(this.options.report);
    const splitAt = Math.ceil(report.length / 2);
    const chunks = [
      {
        id: "chatcmpl-ark-e2e",
        object: "chat.completion.chunk",
        created: 1_785_105_600,
        model: this.options.expectedModel,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: report.slice(0, splitAt),
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chatcmpl-ark-e2e",
        object: "chat.completion.chunk",
        created: 1_785_105_600,
        model: this.options.expectedModel,
        choices: [
          {
            index: 0,
            delta: {
              content: report.slice(splitAt),
            },
            finish_reason: "stop",
          },
        ],
      },
      {
        id: "chatcmpl-ark-e2e",
        object: "chat.completion.chunk",
        created: 1_785_105_600,
        model: this.options.expectedModel,
        choices: [],
        usage: {
          prompt_tokens: EXPECTED_USAGE.input_tokens,
          prompt_tokens_details: {
            cached_tokens: EXPECTED_USAGE.cached_input_tokens,
            cache_write_tokens:
              EXPECTED_USAGE.cache_write_input_tokens,
          },
          completion_tokens: EXPECTED_USAGE.output_tokens,
          completion_tokens_details: {
            reasoning_tokens:
              EXPECTED_USAGE.reasoning_output_tokens,
          },
          total_tokens:
            EXPECTED_USAGE.input_tokens +
            EXPECTED_USAGE.output_tokens,
        },
      },
    ];
    for (const chunk of chunks) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  }
}

function hasStrictWorkerSchema(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "json_schema") {
    return false;
  }
  const jsonSchema = value.json_schema;
  if (
    !isRecord(jsonSchema) ||
    jsonSchema.strict !== true ||
    !isRecord(jsonSchema.schema)
  ) {
    return false;
  }
  const schema = jsonSchema.schema;
  const required = schema.required;
  return (
    schema.type === "object" &&
    schema.additionalProperties === false &&
    Array.isArray(required) &&
    [
      "kind",
      "team_id",
      "worker_key",
      "status",
      "summary",
      "changed_files",
      "commit_sha",
      "verification",
      "blockers",
    ].every((field) => required.includes(field))
  );
}

async function createLinkedWorktree(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.name",
    "Ark Team E2E",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "ark-team-e2e@example.invalid",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "commit",
    "--allow-empty",
    "-m",
    "test baseline",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "worktree",
    "add",
    "-b",
    "test/provider-app-server-e2e",
    worktree,
  ]);
  return worktree;
}

function installLoopbackProxyGuard(proxyOrigin: string): () => void {
  const updates: Record<string, string> = {
    HTTP_PROXY: proxyOrigin,
    HTTPS_PROXY: proxyOrigin,
    ALL_PROXY: proxyOrigin,
    http_proxy: proxyOrigin,
    https_proxy: proxyOrigin,
    all_proxy: proxyOrigin,
    NO_PROXY: `${LOOPBACK_HOST},localhost`,
    no_proxy: `${LOOPBACK_HOST},localhost`,
  };
  const previous = Object.fromEntries(
    Object.keys(updates).map((name) => [
      name,
      process.env[name],
    ]),
  );
  Object.assign(process.env, updates);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

async function readRequestBody(
  request: IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 16 * 1024 * 1024) {
      throw new Error("fake upstream request is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen({
      host: LOOPBACK_HOST,
      port,
      exclusive: true,
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "EADDRINUSE"
  );
}

async function fileIdentity(
  filePath: string,
): Promise<{
  sha256: string;
  size: string;
  mtimeNs: string;
} | null> {
  try {
    const [bytes, metadata] = await Promise.all([
      readFile(filePath),
      stat(filePath, { bigint: true }),
    ]);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
    };
  } catch (error) {
    if (
      isRecord(error) &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function directoryContains(
  directory: string,
  value: string,
): Promise<boolean> {
  const needle = Buffer.from(value);
  for (const entry of await readdir(directory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContains(entryPath, value)) {
        return true;
      }
    } else if (
      entry.isFile() &&
      (await readFile(entryPath)).includes(needle)
    ) {
      return true;
    }
  }
  return false;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
