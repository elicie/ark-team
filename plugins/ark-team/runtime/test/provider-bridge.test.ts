import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StdioAppServerClient } from "../src/app-server-client.js";
import { ProviderBridge } from "../src/provider-bridge.js";
import { resolveRunWorkerBinding } from "../src/provider-config.js";
import type { ExternalModelBindingSnapshotV1 } from "../src/provider-types.js";

const INLINE_KEY_FIRST =
  "sk-ark-provider-bridge-inline-canary-first";
const INLINE_KEY_ROTATED =
  "sk-ark-provider-bridge-inline-canary-rotated";
const ENV_KEY_FIRST =
  "sk-ark-provider-bridge-env-canary-first";
const ENV_KEY_ROTATED =
  "sk-ark-provider-bridge-env-canary-rotated";
const ENV_KEY_NAME = "ARK_TEAM_PROVIDER_BRIDGE_TEST_UPSTREAM_KEY";
const MODEL = "fake-model";
const PROVIDER_ID = "fake_provider";

interface CapturedUpstreamRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
}

interface FakeUpstream {
  port: number;
  requests: CapturedUpstreamRequest[];
  failWithCredential(credential: string): void;
  succeed(): void;
  close(): Promise<void>;
}

test("TEST-005 authenticates the inline-key loopback bridge, translates SSE, rotates keys, and terminates on drift", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ark-team-provider-bridge-inline-"),
  );
  await chmod(temporaryRoot, 0o700);
  const upstream = await startFakeUpstream();
  const catalogPath = path.join(temporaryRoot, "providers.toml");
  const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
  const environment: NodeJS.ProcessEnv = {
    ARK_TEAM_PROVIDER_CONFIG: catalogPath,
  };
  let bridge: ProviderBridge | undefined;

  try {
    await writeOwnerOnlyCatalog(
      catalogPath,
      inlineCatalog(INLINE_KEY_FIRST, baseUrl),
    );
    const binding = await externalBinding(environment);
    bridge = await ProviderBridge.start({
      binding,
      codex_home: path.join(temporaryRoot, "external-codex-home"),
      environment,
      request_timeout_ms: 5_000,
      stream_idle_timeout_ms: 5_000,
    });

    assert.equal(bridge.diagnostics.host, "127.0.0.1");
    assert.ok(bridge.diagnostics.port >= 10001);
    assert.equal(
      new URL(bridge.external_runtime.bridge_base_url).hostname,
      "127.0.0.1",
    );
    assert.ok(
      Number(
        new URL(bridge.external_runtime.bridge_base_url).port,
      ) >= 10001,
    );
    assert.equal(
      JSON.stringify(bridge.external_runtime).includes(
        INLINE_KEY_FIRST,
      ),
      false,
    );

    const responsesUrl =
      `${bridge.external_runtime.bridge_base_url}/responses`;
    const requestCountBeforeRejections = upstream.requests.length;

    await assertJsonError(
      await postResponses(responsesUrl),
      401,
      "BRIDGE_UNAUTHORIZED",
    );
    const wrongBearer = "wrong-bridge-bearer-canary";
    const wrongBearerBody = await assertJsonError(
      await postResponses(responsesUrl, wrongBearer),
      401,
      "BRIDGE_UNAUTHORIZED",
    );
    assert.equal(wrongBearerBody.includes(wrongBearer), false);

    const bridgeToken = bridge.external_runtime.bridge_token;
    const bridgeOrigin = new URL(
      bridge.external_runtime.bridge_base_url,
    ).origin;
    await assertJsonError(
      await postResponses(
        `${bridgeOrigin}/v1/providers/wrong_provider/responses`,
        bridgeToken,
      ),
      404,
      "BRIDGE_ROUTE_NOT_FOUND",
    );
    const queryCanary = "credential-bearing-query-canary";
    const queryError = await assertJsonError(
      await postResponses(
        `${responsesUrl}?fixture=${queryCanary}`,
        bridgeToken,
      ),
      404,
      "BRIDGE_ROUTE_NOT_FOUND",
    );
    assert.equal(queryError.includes(queryCanary), false);
    assert.equal(
      upstream.requests.length,
      requestCountBeforeRejections,
    );
    await assertJsonError(
      await postRawResponses(
        responsesUrl,
        bridgeToken,
        {
          model: MODEL,
          input: [],
          stream: true,
          tools: [{ type: "evil", name: "must-not-pass" }],
        },
      ),
      400,
      "PROVIDER_RESPONSE_INVALID",
    );
    await assertJsonError(
      await postRawResponses(
        responsesUrl,
        bridgeToken,
        {
          model: MODEL,
          input: [
            {
              type: "unknown_item",
              content: "must-not-pass",
            },
          ],
          stream: true,
        },
      ),
      400,
      "PROVIDER_RESPONSE_INVALID",
    );
    assert.equal(
      upstream.requests.length,
      requestCountBeforeRejections,
    );

    const firstResponse = await postResponses(
      responsesUrl,
      bridgeToken,
    );
    await assertSuccessfulResponsesSse(firstResponse);
    const firstUpstream = lastUpstreamRequest(upstream.requests);
    assert.equal(firstUpstream.method, "POST");
    assert.equal(firstUpstream.url, "/v1/chat/completions");
    assert.equal(
      firstUpstream.authorization,
      `Bearer ${INLINE_KEY_FIRST}`,
    );
    assert.notEqual(
      firstUpstream.authorization,
      `Bearer ${bridgeToken}`,
    );
    assertUpstreamChatRequest(firstUpstream.body);

    upstream.failWithCredential(INLINE_KEY_FIRST);
    const failedResponse = await postResponses(
      responsesUrl,
      bridgeToken,
    );
    const failedBody = await assertFailedResponsesSse(
      failedResponse,
      INLINE_KEY_FIRST,
    );
    assert.equal(failedBody.includes(bridgeToken), false);
    assert.equal(
      lastUpstreamRequest(upstream.requests).authorization,
      `Bearer ${INLINE_KEY_FIRST}`,
    );

    await writeOwnerOnlyCatalog(
      catalogPath,
      inlineCatalog(INLINE_KEY_ROTATED, baseUrl),
    );
    upstream.succeed();
    const rotatedResponse = await postResponses(
      responsesUrl,
      bridgeToken,
    );
    await assertSuccessfulResponsesSse(rotatedResponse);
    assert.equal(
      lastUpstreamRequest(upstream.requests).authorization,
      `Bearer ${INLINE_KEY_ROTATED}`,
    );
    assert.equal(bridge.currentTerminalError(), null);

    await writeOwnerOnlyCatalog(
      catalogPath,
      inlineCatalog(
        INLINE_KEY_ROTATED,
        `http://127.0.0.1:${upstream.port}/changed-v1`,
      ),
    );
    const upstreamCountBeforeDrift = upstream.requests.length;
    const driftBody = await assertJsonError(
      await postResponses(responsesUrl, bridgeToken),
      409,
      "PROVIDER_CONFIG_DRIFT",
    );
    assert.equal(upstream.requests.length, upstreamCountBeforeDrift);
    assert.equal(driftBody.includes(INLINE_KEY_FIRST), false);
    assert.equal(driftBody.includes(INLINE_KEY_ROTATED), false);
    assert.equal(driftBody.includes(bridgeToken), false);
    assert.equal(
      bridge.currentTerminalError()?.code,
      "PROVIDER_CONFIG_DRIFT",
    );
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-005 keeps env-key credentials out of the bridge-derived child runtime and translates SSE", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ark-team-provider-bridge-env-"),
  );
  await chmod(temporaryRoot, 0o700);
  const upstream = await startFakeUpstream();
  const catalogPath = path.join(temporaryRoot, "providers.toml");
  const environment: NodeJS.ProcessEnv = {
    ARK_TEAM_PROVIDER_CONFIG: catalogPath,
    [ENV_KEY_NAME]: ENV_KEY_FIRST,
  };
  const previousProcessCredential = process.env[ENV_KEY_NAME];
  process.env[ENV_KEY_NAME] = ENV_KEY_FIRST;
  let bridge: ProviderBridge | undefined;
  let child: StdioAppServerClient | undefined;

  try {
    await writeOwnerOnlyCatalog(
      catalogPath,
      environmentCatalog(
        `http://127.0.0.1:${upstream.port}/v1`,
      ),
    );
    const binding = await externalBinding(environment);
    bridge = await ProviderBridge.start({
      binding,
      codex_home: path.join(temporaryRoot, "external-codex-home"),
      environment,
      request_timeout_ms: 5_000,
      stream_idle_timeout_ms: 5_000,
    });

    assert.equal(bridge.diagnostics.host, "127.0.0.1");
    assert.ok(bridge.diagnostics.port >= 10001);
    assert.deepEqual(
      bridge.external_runtime.upstream_env_names,
      [ENV_KEY_NAME],
    );
    const serializedRuntime = JSON.stringify(
      bridge.external_runtime,
    );
    assert.equal(serializedRuntime.includes(ENV_KEY_FIRST), false);
    assert.equal(serializedRuntime.includes(ENV_KEY_ROTATED), false);

    const fakeCodexPath = path.join(
      temporaryRoot,
      "fake-codex.mjs",
    );
    await writeFile(
      fakeCodexPath,
      fakeCodexSource(
        ENV_KEY_NAME,
        bridge.external_runtime.bridge_token_env,
      ),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );
    await chmod(fakeCodexPath, 0o700);
    child = new StdioAppServerClient({
      codex_path: fakeCodexPath,
      external_runtime: bridge.external_runtime,
    });
    const childCapture = (await child.request(
      "fixture/capture",
      {},
    )) as {
      argv: string[];
      bridgeTokenPresent: boolean;
      codexHome: string | null;
      upstreamKeyPresent: boolean;
    };
    assert.equal(childCapture.bridgeTokenPresent, true);
    assert.equal(childCapture.upstreamKeyPresent, false);
    assert.equal(
      childCapture.codexHome,
      bridge.external_runtime.codex_home,
    );
    const serializedArgv = JSON.stringify(childCapture.argv);
    assert.equal(serializedArgv.includes(ENV_KEY_FIRST), false);
    assert.equal(
      serializedArgv.includes(
        bridge.external_runtime.bridge_token,
      ),
      false,
    );
    await child.close();
    child = undefined;

    const responsesUrl =
      `${bridge.external_runtime.bridge_base_url}/responses`;
    const firstResponse = await postResponses(
      responsesUrl,
      bridge.external_runtime.bridge_token,
    );
    await assertSuccessfulResponsesSse(firstResponse);
    assert.equal(
      lastUpstreamRequest(upstream.requests).authorization,
      `Bearer ${ENV_KEY_FIRST}`,
    );

    environment[ENV_KEY_NAME] = ENV_KEY_ROTATED;
    const rotatedResponse = await postResponses(
      responsesUrl,
      bridge.external_runtime.bridge_token,
    );
    await assertSuccessfulResponsesSse(rotatedResponse);
    assert.equal(
      lastUpstreamRequest(upstream.requests).authorization,
      `Bearer ${ENV_KEY_ROTATED}`,
    );
    assert.equal(
      JSON.stringify(bridge.external_runtime).includes(
        ENV_KEY_ROTATED,
      ),
      false,
    );
  } finally {
    await child?.close();
    await bridge?.close();
    await upstream.close();
    if (previousProcessCredential === undefined) {
      delete process.env[ENV_KEY_NAME];
    } else {
      process.env[ENV_KEY_NAME] = previousProcessCredential;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-009 raw upstream activity keeps a long partial tool stream alive", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ark-team-provider-bridge-idle-"),
  );
  await chmod(temporaryRoot, 0o700);
  const catalogPath = path.join(temporaryRoot, "providers.toml");
  const environment: NodeJS.ProcessEnv = {
    ARK_TEAM_PROVIDER_CONFIG: catalogPath,
  };
  let bridge: ProviderBridge | undefined;

  try {
    await writeOwnerOnlyCatalog(
      catalogPath,
      inlineCatalog(
        INLINE_KEY_FIRST,
        "http://127.0.0.1:19999/v1",
      ),
    );
    const binding = await externalBinding(environment);
    bridge = await ProviderBridge.start({
      binding,
      codex_home: path.join(temporaryRoot, "external-codex-home"),
      environment,
      fetch_impl: async () => slowToolStreamResponse(),
      request_timeout_ms: 5_000,
      stream_idle_timeout_ms: 80,
    });

    const response = await postResponses(
      `${bridge.external_runtime.bridge_base_url}/responses`,
      bridge.external_runtime.bridge_token,
    );
    assert.equal(response.status, 200);
    const decoded = decodeSse(await response.text());
    assert.equal(decoded.done, true);
    assert.notEqual(
      requiredEvent(
        decoded.events,
        "response.function_call_arguments.done",
      ),
      undefined,
    );
    assert.notEqual(
      requiredEvent(decoded.events, "response.completed"),
      undefined,
    );
    assert.equal(bridge.currentTerminalError(), null);
  } finally {
    await bridge?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-009 request timeout terminates a stalled partial bridge upload", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ark-team-provider-bridge-upload-timeout-"),
  );
  await chmod(temporaryRoot, 0o700);
  const catalogPath = path.join(temporaryRoot, "providers.toml");
  const environment: NodeJS.ProcessEnv = {
    ARK_TEAM_PROVIDER_CONFIG: catalogPath,
  };
  let bridge: ProviderBridge | undefined;
  let upstreamCalls = 0;

  try {
    await writeOwnerOnlyCatalog(
      catalogPath,
      inlineCatalog(
        INLINE_KEY_FIRST,
        "http://127.0.0.1:19999/v1",
      ),
    );
    const binding = await externalBinding(environment);
    bridge = await ProviderBridge.start({
      binding,
      codex_home: path.join(temporaryRoot, "external-codex-home"),
      environment,
      fetch_impl: async () => {
        upstreamCalls += 1;
        throw new Error("stalled upload must not reach upstream");
      },
      request_timeout_ms: 40,
      stream_idle_timeout_ms: 5_000,
    });

    const startedAt = Date.now();
    await observePartialUploadTermination(
      `${bridge.external_runtime.bridge_base_url}/responses`,
      bridge.external_runtime.bridge_token,
    );
    assert.ok(Date.now() - startedAt < 750);
    assert.equal(upstreamCalls, 0);
  } finally {
    await bridge?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function externalBinding(
  environment: NodeJS.ProcessEnv,
): Promise<ExternalModelBindingSnapshotV1> {
  const binding = await resolveRunWorkerBinding(
    {
      worker: {
        provider: PROVIDER_ID,
        model: MODEL,
        reasoning_effort: "high",
      },
    },
    { environment },
  );
  assert.equal(binding.kind, "external");
  if (binding.kind !== "external") {
    throw new Error("fixture did not resolve an external binding");
  }
  return binding;
}

async function observePartialUploadTermination(
  url: string,
  bearer: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const client = httpRequest(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        "Content-Length": "1024",
      },
    });
    const timeout = setTimeout(() => {
      client.destroy();
      settle(new Error("partial upload did not terminate"));
    }, 750);
    const settle = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    client.once("response", (response) => {
      response.resume();
      response.once("end", () => settle());
      response.once("close", () => settle());
    });
    client.once("error", () => settle());
    client.once("close", () => settle());
    client.write("{");
  });
}

function slowToolStreamResponse(): Response {
  const encoder = new TextEncoder();
  const frames = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-slow",
                function: {
                  name: "slow_tool",
                  arguments: "{\"value\":\"",
                },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: "a" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: "b" },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: "\"}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    "[DONE]",
  ] as const;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      let index = 0;
      const push = (): void => {
        if (cancelled) {
          return;
        }
        const frame = frames[index];
        if (frame === undefined) {
          controller.close();
          return;
        }
        const payload =
          typeof frame === "string" ? frame : JSON.stringify(frame);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        index += 1;
        setTimeout(push, 30);
      };
      push();
    },
    cancel(): void {
      cancelled = true;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function postResponses(
  url: string,
  bridgeToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bridgeToken !== undefined) {
    headers.Authorization = `Bearer ${bridgeToken}`;
  }
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      input: "Return the fixture result.",
      stream: true,
      reasoning: {
        effort: "high",
      },
      text: {
        format: {
          type: "json_schema",
          name: "fixture_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              ok: {
                type: "boolean",
              },
            },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    }),
  });
}

async function postRawResponses(
  url: string,
  bridgeToken: string,
  body: unknown,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bridgeToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function assertJsonError(
  response: Response,
  expectedStatus: number,
  expectedCode: string,
): Promise<string> {
  assert.equal(response.status, expectedStatus);
  const body = await response.text();
  const parsed = asRecord(JSON.parse(body));
  const error = asRecord(parsed.error);
  assert.equal(error.code, expectedCode);
  assert.ok(
    typeof error.message === "string" &&
      error.message.length <= 400,
  );
  return body;
}

async function assertSuccessfulResponsesSse(
  response: Response,
): Promise<void> {
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/event-stream\b/,
  );
  const decoded = decodeSse(await response.text());
  assert.equal(decoded.done, true);
  assert.equal(
    decoded.events.some(
      (event) => event.type === "response.failed",
    ),
    false,
  );
  assert.notEqual(
    requiredEvent(decoded.events, "response.created"),
    undefined,
  );
  assert.notEqual(
    requiredEvent(decoded.events, "response.in_progress"),
    undefined,
  );
  assert.deepEqual(
    decoded.events.slice(0, 2).map((event) => event.type),
    ["response.created", "response.in_progress"],
  );

  const textDelta = requiredEvent(
    decoded.events,
    "response.output_text.delta",
  );
  assert.equal(textDelta.delta, '{"ok":true}');

  const outputDone = requiredEvent(
    decoded.events,
    "response.output_item.done",
  );
  const item = asRecord(outputDone.item);
  assert.equal(item.type, "message");
  assert.equal(item.status, "completed");
  assert.ok(Array.isArray(item.content));
  assert.equal(
    asRecord(item.content[0]).text,
    '{"ok":true}',
  );

  const completed = requiredEvent(
    decoded.events,
    "response.completed",
  );
  const completedResponse = asRecord(completed.response);
  assert.equal(completedResponse.status, "completed");
  assert.deepEqual(asRecord(completedResponse.usage), {
    input_tokens: 9,
    input_tokens_details: {
      cached_tokens: 2,
    },
    output_tokens: 4,
    output_tokens_details: {
      reasoning_tokens: 1,
    },
    total_tokens: 13,
  });
}

async function assertFailedResponsesSse(
  response: Response,
  credentialCanary: string,
): Promise<string> {
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes(credentialCanary), false);
  const decoded = decodeSse(body);
  assert.equal(decoded.done, true);
  const failed = requiredEvent(
    decoded.events,
    "response.failed",
  );
  const failedResponse = asRecord(failed.response);
  assert.equal(failedResponse.status, "failed");
  const error = asRecord(failedResponse.error);
  assert.equal(error.code, "PROVIDER_RESPONSE_INVALID");
  assert.ok(
    typeof error.message === "string" &&
      error.message.length <= 400,
  );
  assert.equal(
    error.message,
    "Upstream provider returned HTTP 429",
  );
  return body;
}

function decodeSse(body: string): {
  events: Record<string, unknown>[];
  done: boolean;
} {
  const events: Record<string, unknown>[] = [];
  let done = false;
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    events.push(asRecord(JSON.parse(data)));
  }
  return { events, done };
}

function requiredEvent(
  events: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown> {
  const event = events.find((candidate) => candidate.type === type);
  assert.ok(event, `missing Responses event: ${type}`);
  return event;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function assertUpstreamChatRequest(body: string): void {
  const parsed = asRecord(JSON.parse(body));
  assert.equal(parsed.model, MODEL);
  assert.equal(parsed.stream, true);
  assert.equal(parsed.reasoning_effort, "high");
  assert.deepEqual(parsed.stream_options, {
    include_usage: true,
  });
  assert.deepEqual(parsed.response_format, {
    type: "json_schema",
    json_schema: {
      name: "fixture_result",
      strict: true,
      schema: {
        type: "object",
        properties: {
          ok: {
            type: "boolean",
          },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  });
}

function lastUpstreamRequest(
  requests: readonly CapturedUpstreamRequest[],
): CapturedUpstreamRequest {
  const request = requests[requests.length - 1];
  assert.ok(request);
  return request;
}

async function writeOwnerOnlyCatalog(
  catalogPath: string,
  contents: string,
): Promise<void> {
  await writeFile(catalogPath, contents, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(catalogPath, 0o600);
}

function inlineCatalog(
  credential: string,
  baseUrl: string,
): string {
  return [
    "version = 1",
    "",
    `[providers.${PROVIDER_ID}]`,
    'adapter = "builtin:openai-chat"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    "allow_private_network = true",
    'auth_kind = "inline_key"',
    `api_key = ${JSON.stringify(credential)}`,
    'structured_output_mode = "native_json_schema"',
    'policy = "standard"',
    `allowed_models = [${JSON.stringify(MODEL)}]`,
    "",
    `[providers.${PROVIDER_ID}.reasoning_effort_map]`,
    'high = "high"',
    "",
  ].join("\n");
}

function environmentCatalog(baseUrl: string): string {
  return [
    "version = 1",
    "",
    `[providers.${PROVIDER_ID}]`,
    'adapter = "builtin:openai-chat"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    "allow_private_network = true",
    'auth_kind = "env_key"',
    `api_key_env = ${JSON.stringify(ENV_KEY_NAME)}`,
    'structured_output_mode = "native_json_schema"',
    'policy = "standard"',
    `allowed_models = [${JSON.stringify(MODEL)}]`,
    "",
    `[providers.${PROVIDER_ID}.reasoning_effort_map]`,
    'high = "high"',
    "",
  ].join("\n");
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: CapturedUpstreamRequest[] = [];
  const behavior: {
    credential: string;
    mode: "success" | "failure";
  } = {
    credential: "",
    mode: "success",
  };
  let server: Server | undefined;
  let port: number | undefined;

  for (let candidate = 20001; candidate <= 65535; candidate += 1) {
    const current = createServer((request, response) => {
      void handleFakeUpstreamRequest(
        request,
        response,
        requests,
        behavior,
      ).catch(() => {
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
      });
    });
    try {
      await listen(current, candidate);
      server = current;
      port = candidate;
      break;
    } catch (error) {
      current.close();
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }

  if (server === undefined || port === undefined) {
    throw new Error("no fake upstream port is available");
  }
  const listeningServer = server;
  return {
    port,
    requests,
    failWithCredential(credential): void {
      behavior.mode = "failure";
      behavior.credential = credential;
    },
    succeed(): void {
      behavior.mode = "success";
      behavior.credential = "";
    },
    async close(): Promise<void> {
      if (!listeningServer.listening) {
        return;
      }
      listeningServer.closeIdleConnections();
      listeningServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        listeningServer.close(() => resolve());
      });
    },
  };
}

async function handleFakeUpstreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: CapturedUpstreamRequest[],
  behavior: {
    credential: string;
    mode: "success" | "failure";
  },
): Promise<void> {
  const body = await readIncomingBody(request);
  requests.push({
    method: request.method ?? "",
    url: request.url ?? "",
    authorization: request.headers.authorization ?? null,
    body,
  });

  if (
    request.method !== "POST" ||
    request.url !== "/v1/chat/completions"
  ) {
    response.writeHead(404, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify({
        error: {
          message: "fixture route not found",
        },
      }),
    );
    return;
  }

  if (behavior.mode === "failure") {
    response.writeHead(429, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify({
        error: {
          message:
            `fixture rejected Bearer ${behavior.credential}: ` +
            "x".repeat(1_000),
        },
      }),
    );
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  response.end(
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-fixture",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: '{"ok":true}',
            },
            finish_reason: null,
          },
        ],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-fixture",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 9,
          prompt_tokens_details: {
            cached_tokens: 2,
          },
          completion_tokens: 4,
          completion_tokens_details: {
            reasoning_tokens: 1,
          },
          total_tokens: 13,
        },
      })}`,
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n"),
  );
}

async function readIncomingBody(
  request: IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    );
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
      host: "127.0.0.1",
      port,
      exclusive: true,
    });
  });
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EADDRINUSE"
  );
}

function fakeCodexSource(
  upstreamEnvironmentName: string,
  bridgeTokenEnvironmentName: string,
): string {
  return `#!${process.execPath}
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    id: request.id,
    result: {
      argv: process.argv.slice(2),
      bridgeTokenPresent:
        typeof process.env[${JSON.stringify(bridgeTokenEnvironmentName)}] === "string",
      codexHome: process.env.CODEX_HOME ?? null,
      upstreamKeyPresent:
        process.env[${JSON.stringify(upstreamEnvironmentName)}] !== undefined,
    },
  }) + "\\n");
});
`;
}
