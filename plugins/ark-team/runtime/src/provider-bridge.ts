import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { z } from "zod/v4";

import { createOpenAIChatAdapter } from "./adapters/openai-chat.js";
import type { ExternalAppServerRuntime } from "./app-server-client.js";
import {
  ArkTeamError,
  type ArkTeamErrorCode,
} from "./errors.js";
import type {
  NormalizedContent,
  NormalizedOutputItem,
  NormalizedResponseInputItem,
  NormalizedResponseEvent,
  NormalizedResponsesRequest,
  NormalizedTool,
  NormalizedUsage,
  ProviderAdapterV1,
  SafeProviderConfig,
} from "./provider-adapter.js";
import {
  assertExternalBindingCurrent,
  loadProviderCatalogSnapshot,
  resolveProviderCredential,
  type ProviderCatalogSnapshot,
  type ProviderConfigRuntimeOptions,
} from "./provider-config.js";
import type {
  ExternalModelBindingSnapshotV1,
} from "./provider-types.js";

const BRIDGE_HOST = "127.0.0.1";
const FIRST_BRIDGE_PORT = 10001;
const LAST_BRIDGE_PORT = 65535;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const BRIDGE_TOKEN_ENV_PREFIX =
  "ARK_TEAM_PROVIDER_BRIDGE_TOKEN_";

const boundedStringSchema = z.string().max(MAX_REQUEST_BYTES);
const contentPartSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["input_text", "output_text", "text"]),
      text: boundedStringSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("input_image"),
      image_url: boundedStringSchema,
      detail: z
        .enum(["auto", "low", "high", "original"])
        .optional(),
    })
    .strict(),
]);
const contentSchema = z.union([
  boundedStringSchema,
  z.array(contentPartSchema),
]);
const inputItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      role: z.enum(["system", "developer", "user", "assistant"]),
      content: contentSchema,
      id: boundedStringSchema.optional(),
      status: boundedStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      summary: z
        .array(
          z
            .object({
              type: z.literal("summary_text"),
              text: boundedStringSchema,
            })
            .strict(),
        )
        .optional(),
      content: z
        .array(
          z
            .object({
              type: z.literal("reasoning_text"),
              text: boundedStringSchema,
            })
            .strict(),
        )
        .optional(),
      encrypted_content: boundedStringSchema.nullable().optional(),
      id: boundedStringSchema.optional(),
      status: boundedStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call"),
      call_id: boundedStringSchema.min(1),
      name: boundedStringSchema.min(1),
      arguments: boundedStringSchema,
      id: boundedStringSchema.optional(),
      status: boundedStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call_output"),
      call_id: boundedStringSchema.min(1),
      output: contentSchema,
      id: boundedStringSchema.optional(),
      status: boundedStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("custom_tool_call"),
      call_id: boundedStringSchema.min(1),
      name: boundedStringSchema.min(1),
      input: boundedStringSchema,
      id: boundedStringSchema.optional(),
      status: boundedStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("custom_tool_call_output"),
      call_id: boundedStringSchema.min(1),
      output: contentSchema,
      id: boundedStringSchema.optional(),
      status: boundedStringSchema.optional(),
    })
    .strict(),
]);
const functionToolSchema = z
  .object({
    type: z.literal("function"),
    name: boundedStringSchema.min(1),
    description: boundedStringSchema.optional(),
    parameters: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  })
  .strict();
const customToolSchema = z
  .object({
    type: z.literal("custom"),
    name: boundedStringSchema.min(1),
    description: boundedStringSchema.optional(),
    format: z
      .union([
        z.object({ type: z.literal("text") }).strict(),
        z
          .object({
            type: z.literal("grammar"),
            syntax: z.enum(["lark", "regex"]),
            definition: boundedStringSchema,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z
    .object({
      type: z.enum(["function", "custom"]),
      name: boundedStringSchema.min(1),
    })
    .strict(),
]);
const textFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("json_object") }).strict(),
  z
    .object({
      type: z.literal("json_schema"),
      name: boundedStringSchema.min(1),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean(),
      description: boundedStringSchema.optional(),
    })
    .strict(),
]);
const bridgeResponsesRequestSchema = z
  .object({
    model: boundedStringSchema.min(1),
    instructions: boundedStringSchema.nullable().optional(),
    input: z.union([boundedStringSchema, z.array(inputItemSchema)]),
    tools: z
      .array(z.discriminatedUnion("type", [
        functionToolSchema,
        customToolSchema,
      ]))
      .optional(),
    tool_choice: toolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({
        effort: boundedStringSchema.optional(),
        summary: z
          .enum(["auto", "concise", "detailed"])
          .optional(),
      })
      .strict()
      .optional(),
    stream: z.boolean(),
    text: z
      .object({
        format: textFormatSchema.optional(),
        verbosity: z.enum(["low", "medium", "high"]).optional(),
      })
      .strict()
      .optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().finite().optional(),
    top_p: z.number().finite().optional(),
    stop: z
      .union([boundedStringSchema, z.array(boundedStringSchema)])
      .optional(),
    presence_penalty: z.number().finite().optional(),
    frequency_penalty: z.number().finite().optional(),
    store: z.literal(false).optional(),
    background: z.literal(false).optional(),
    include: z
      .array(z.literal("reasoning.encrypted_content"))
      .optional(),
    previous_response_id: z.null().optional(),
    truncation: z.literal("disabled").optional(),
    metadata: z.record(z.string(), boundedStringSchema).optional(),
    prompt_cache_key: boundedStringSchema.optional(),
    client_metadata: z.record(z.string(), z.json()).optional(),
  })
  .strict();

export interface ProviderBridgeOptions
  extends ProviderConfigRuntimeOptions {
  binding: ExternalModelBindingSnapshotV1;
  codex_home: string;
  fetch_impl?: typeof fetch;
  request_timeout_ms?: number;
  stream_idle_timeout_ms?: number;
}

export interface ProviderBridgeDiagnostics {
  host: typeof BRIDGE_HOST;
  port: number;
  provider_id: string;
  adapter_id: string;
}

export class ProviderBridge {
  readonly diagnostics: ProviderBridgeDiagnostics;
  readonly external_runtime: ExternalAppServerRuntime;

  private server: Server | null = null;
  private terminalProviderError: ArkTeamError | null = null;

  private constructor(
    private readonly binding: ExternalModelBindingSnapshotV1,
    private readonly snapshot: ProviderCatalogSnapshot,
    private readonly adapter: ProviderAdapterV1,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch,
    private readonly requestTimeoutMs: number,
    private readonly streamIdleTimeoutMs: number,
    private readonly bridgeToken: string,
    bridgeTokenEnv: string,
    codexHome: string,
    upstreamEnvNames: readonly string[],
    port: number,
  ) {
    this.diagnostics = {
      host: BRIDGE_HOST,
      port,
      provider_id: binding.provider_id,
      adapter_id: binding.adapter_id,
    };
    this.external_runtime = {
      app_server_provider_id: binding.app_server_provider_id,
      bridge_base_url:
        `http://${BRIDGE_HOST}:${port}/v1/providers/${binding.provider_id}`,
      bridge_token_env: bridgeTokenEnv,
      bridge_token: bridgeToken,
      upstream_env_names: upstreamEnvNames,
      codex_home: codexHome,
    };
  }

  static async start(
    options: ProviderBridgeOptions,
  ): Promise<ProviderBridge> {
    const environment = options.environment ?? process.env;
    assertPositiveTimeout(
      options.request_timeout_ms,
      "request_timeout_ms",
    );
    assertPositiveTimeout(
      options.stream_idle_timeout_ms,
      "stream_idle_timeout_ms",
    );
    await assertExternalBindingCurrent(options.binding, {
      environment,
    });
    const snapshot = await loadProviderCatalogSnapshot({ environment });
    const configured =
      snapshot.catalog.providers[options.binding.provider_id];
    if (configured === undefined) {
      throw new ArkTeamError(
        "PROVIDER_NOT_FOUND",
        "persisted external provider is unavailable",
      );
    }
    if (configured.adapter !== options.binding.adapter_id) {
      throw new ArkTeamError(
        "PROVIDER_CONFIG_DRIFT",
        "provider adapter no longer matches the persisted binding",
      );
    }
    if (configured.adapter !== "builtin:openai-chat") {
      throw new ArkTeamError(
        "ADAPTER_NOT_FOUND",
        "this slice only supports the builtin OpenAI Chat adapter",
      );
    }

    const safeProvider: SafeProviderConfig = {
      adapter: configured.adapter,
      base_url: configured.base_url,
      auth_kind: configured.auth_kind,
      structured_output_mode:
        configured.structured_output_mode,
    };
    const adapter = createOpenAIChatAdapter(safeProvider);
    adapter.validateConfig(safeProvider);
    const capabilities = adapter.capabilities(safeProvider);
    if (
      !capabilities.streaming ||
      !capabilities.tools ||
      !capabilities.reasoning ||
      capabilities.structured_output !==
        options.binding.structured_output_mode
    ) {
      throw new ArkTeamError(
        "PROVIDER_CAPABILITY_UNSUPPORTED",
        "external provider does not satisfy the worker capability contract",
      );
    }

    const bridgeToken = randomBytes(32).toString("base64url");
    const bridgeTokenEnv =
      `${BRIDGE_TOKEN_ENV_PREFIX}${randomBytes(8)
        .toString("hex")
        .toUpperCase()}`;
    let bridge: ProviderBridge | null = null;
    let server: Server | null = null;
    try {
      for (
        let port = FIRST_BRIDGE_PORT;
        port <= LAST_BRIDGE_PORT;
        port += 1
      ) {
        const candidate = new ProviderBridge(
          options.binding,
          snapshot,
          adapter,
          environment,
          options.fetch_impl ?? fetch,
          options.request_timeout_ms ??
            DEFAULT_REQUEST_TIMEOUT_MS,
          options.stream_idle_timeout_ms ??
            DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          bridgeToken,
          bridgeTokenEnv,
          options.codex_home,
          Object.values(snapshot.catalog.providers).flatMap(
            (provider) =>
              provider.auth_kind === "env_key"
                ? [provider.api_key_env]
                : [],
          ),
          port,
        );
        server = createServer((request, response) => {
          void candidate.handle(request, response);
        });
        try {
          await listen(server, port);
          candidate.server = server;
          bridge = candidate;
          break;
        } catch (error) {
          server.close();
          server = null;
          if (!isAddressInUse(error)) {
            throw error;
          }
        }
      }
    } catch (error) {
      server?.close();
      if (error instanceof ArkTeamError) {
        throw error;
      }
      throw new ArkTeamError(
        "PROVIDER_BRIDGE_UNAVAILABLE",
        "unable to start the loopback provider bridge",
        { cause: error },
      );
    }
    if (bridge === null) {
      throw new ArkTeamError(
        "PROVIDER_BRIDGE_UNAVAILABLE",
        "no loopback provider bridge port is available",
      );
    }
    return bridge;
  }

  currentTerminalError(): ArkTeamError | null {
    return this.terminalProviderError;
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

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      if (!request.complete && !request.destroyed) {
        request.destroy();
      }
    };
    request.once("aborted", abort);
    response.once("close", abort);
    const requestTimer = setTimeout(
      abort,
      this.requestTimeoutMs,
    );
    try {
      if (!isLoopbackPeer(request.socket.remoteAddress)) {
        writeJsonError(response, 403, "BRIDGE_FORBIDDEN");
        return;
      }
      if (!matchesBearerToken(request, this.bridgeToken)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        writeJsonError(response, 401, "BRIDGE_UNAUTHORIZED");
        return;
      }
      const expectedPath =
        `/v1/providers/${this.binding.provider_id}/responses`;
      const requestUrl = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      );
      if (
        request.method !== "POST" ||
        requestUrl.pathname !== expectedPath ||
        requestUrl.search.length > 0
      ) {
        writeJsonError(response, 404, "BRIDGE_ROUTE_NOT_FOUND");
        return;
      }

      this.terminalProviderError = null;
      await assertExternalBindingCurrent(this.binding, {
        environment: this.environment,
      });
      const credential = await resolveProviderCredential(
        this.snapshot,
        this.binding.provider_id,
        { environment: this.environment },
      );
      const body = await readRequestBody(
        request,
        MAX_REQUEST_BYTES,
        controller.signal,
      );
      const normalized = parseResponsesRequest(
        body,
        this.binding,
      );
      const responseId = `resp_ark_${randomUUID().replaceAll("-", "")}`;
      const streamIdleGuard = normalized.stream
        ? new StreamIdleGuard(
            controller,
            this.streamIdleTimeoutMs,
          )
        : undefined;
      const context = {
        response_id: responseId,
        credential,
        reasoning_effort:
          this.binding.effective_reasoning_effort,
        signal: controller.signal,
        tool_kinds: Object.fromEntries(
          (normalized.tools ?? []).map((tool) => [
            tool.name,
            tool.type,
          ]),
        ),
        ...(streamIdleGuard === undefined
          ? {}
          : {
              on_stream_activity: () => streamIdleGuard.touch(),
            }),
      } as const;
      const upstream = await this.adapter.buildRequest(
        normalized,
        context,
      );
      const upstreamResponse = await this.fetchImpl(upstream.url, {
        method: upstream.method,
        headers: upstream.headers,
        body: upstream.body,
        signal: controller.signal,
        redirect: "error",
      });

      const events = normalized.stream
        ? this.adapter.parseStream(upstreamResponse, context)
        : asAsyncEvents(
            await this.adapter.parseResponse(
              upstreamResponse,
              context,
            ),
          );
      if (normalized.stream) {
        streamIdleGuard?.start();
        try {
          await writeEventStream(
            response,
            events,
            normalized,
            responseId,
            controller.signal,
            (event) => {
              streamIdleGuard?.touch();
              this.observeProviderEvent(event);
            },
          );
        } finally {
          streamIdleGuard?.stop();
        }
      } else {
        await writeJsonResponse(
          response,
          events,
          normalized,
          responseId,
          controller.signal,
          (event) => this.observeProviderEvent(event),
        );
      }
    } catch (error) {
      const normalized = normalizeBridgeError(error);
      this.terminalProviderError = normalized;
      if (!response.headersSent) {
        writeJsonError(
          response,
          bridgeErrorStatus(normalized),
          normalized.code,
          normalized.message,
        );
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      clearTimeout(requestTimer);
      request.off("aborted", abort);
      response.off("close", abort);
    }
  }

  private observeProviderEvent(
    event: NormalizedResponseEvent,
  ): void {
    if (event.type === "response_completed") {
      this.terminalProviderError = null;
      return;
    }
    if (event.type === "response_failed") {
      this.terminalProviderError = new ArkTeamError(
        providerErrorCode(event.error.code),
        event.error.message.slice(0, 400),
      );
    }
  }
}

class StreamIdleGuard {
  private timer: NodeJS.Timeout | undefined;
  private active = false;

  constructor(
    private readonly controller: AbortController,
    private readonly timeoutMs: number,
  ) {}

  start(): void {
    this.active = true;
    this.touch();
  }

  touch(): void {
    if (!this.active) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => this.controller.abort(),
      this.timeoutMs,
    );
  }

  stop(): void {
    this.active = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

class ResponsesEventEncoder {
  private sequence = 0;
  private usage: NormalizedUsage | undefined;
  private status:
    | "in_progress"
    | "completed"
    | "incomplete"
    | "failed" = "in_progress";
  private incompleteDetails:
    | Record<string, unknown>
    | undefined;
  private error: Record<string, unknown> | undefined;
  private readonly output = new Map<number, Record<string, unknown>>();
  private readonly itemKinds = new Map<
    string,
    "function" | "custom"
  >();

  constructor(
    private readonly request: NormalizedResponsesRequest,
    private readonly responseId: string,
  ) {}

  encode(event: NormalizedResponseEvent): Record<string, unknown>[] {
    switch (event.type) {
      case "response_created":
        return [
          this.withSequence({
            type: "response.created",
            response: this.response("in_progress"),
          }),
        ];
      case "response_in_progress":
        return [
          this.withSequence({
            type: "response.in_progress",
            response: this.response("in_progress"),
          }),
        ];
      case "output_item_added": {
        const item = wireItem(event.item, false);
        this.output.set(event.output_index, item);
        if (event.item.type === "tool_call") {
          this.itemKinds.set(
            event.item.id,
            event.item.tool_kind,
          );
        }
        const added = this.withSequence({
          type: "response.output_item.added",
          output_index: event.output_index,
          item,
        });
        if (event.item.type !== "reasoning") {
          return [added];
        }
        return [
          added,
          this.withSequence({
            type: "response.reasoning_summary_part.added",
            item_id: event.item.id,
            output_index: event.output_index,
            summary_index: 0,
            part: {
              type: "summary_text",
              text: "",
            },
          }),
        ];
      }
      case "text_delta":
        return [
          this.withSequence({
            type: "response.output_text.delta",
            item_id: event.item_id,
            output_index: event.output_index,
            content_index: event.content_index,
            delta: event.delta,
            logprobs: [],
          }),
        ];
      case "text_done":
        return [
          this.withSequence({
            type: "response.output_text.done",
            item_id: event.item_id,
            output_index: event.output_index,
            content_index: event.content_index,
            text: event.text,
            logprobs: [],
          }),
        ];
      case "reasoning_delta":
        return [
          this.withSequence({
            type: "response.reasoning_summary_text.delta",
            item_id: event.item_id,
            output_index: event.output_index,
            summary_index: event.content_index,
            delta: event.delta,
          }),
        ];
      case "reasoning_done":
        return [
          this.withSequence({
            type: "response.reasoning_summary_text.done",
            item_id: event.item_id,
            output_index: event.output_index,
            summary_index: event.content_index,
            text: event.text,
          }),
          this.withSequence({
            type: "response.reasoning_summary_part.done",
            item_id: event.item_id,
            output_index: event.output_index,
            summary_index: event.content_index,
            part: {
              type: "summary_text",
              text: event.text,
            },
          }),
        ];
      case "function_call_arguments_delta": {
        const custom =
          this.itemKinds.get(event.item_id) === "custom";
        return [
          this.withSequence({
            type: custom
              ? "response.custom_tool_call_input.delta"
              : "response.function_call_arguments.delta",
            item_id: event.item_id,
            output_index: event.output_index,
            ...(custom ? {} : { call_id: event.call_id }),
            delta: event.delta,
          }),
        ];
      }
      case "function_call_arguments_done": {
        const custom = event.tool_kind === "custom";
        return [
          this.withSequence({
            type: custom
              ? "response.custom_tool_call_input.done"
              : "response.function_call_arguments.done",
            item_id: event.item_id,
            output_index: event.output_index,
            ...(custom ? {} : { call_id: event.call_id }),
            ...(custom
              ? { input: event.arguments }
              : { arguments: event.arguments }),
          }),
        ];
      }
      case "output_item_done": {
        const item = wireItem(event.item, true);
        this.output.set(event.output_index, item);
        return [
          this.withSequence({
            type: "response.output_item.done",
            output_index: event.output_index,
            item,
          }),
        ];
      }
      case "usage":
        this.usage = event.usage;
        return [];
      case "response_completed":
        this.usage = event.usage ?? this.usage;
        this.status = "completed";
        return [
          this.withSequence({
            type: "response.completed",
            response: this.response("completed"),
          }),
        ];
      case "response_incomplete":
        this.usage = event.usage ?? this.usage;
        this.status = "incomplete";
        this.incompleteDetails = {
          reason: event.reason,
        };
        return [
          this.withSequence({
            type: "response.incomplete",
            response: this.response("incomplete", {
              reason: event.reason,
            }),
          }),
        ];
      case "response_failed":
        this.usage = event.usage ?? this.usage;
        this.status = "failed";
        this.error = {
          code: event.error.code,
          message: event.error.message,
        };
        return [
          this.withSequence({
            type: "response.failed",
            response: this.response("failed", undefined, {
              code: event.error.code,
              message: event.error.message,
            }),
          }),
        ];
    }
  }

  finalResponse(): Record<string, unknown> {
    return this.response(
      this.status === "in_progress"
        ? "completed"
        : this.status,
      this.incompleteDetails,
      this.error,
    );
  }

  private response(
    status: "in_progress" | "completed" | "incomplete" | "failed",
    incompleteDetails?: Record<string, unknown>,
    error?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id: this.responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      error: error ?? null,
      incomplete_details: incompleteDetails ?? null,
      instructions: this.request.instructions ?? null,
      max_output_tokens: this.request.max_output_tokens ?? null,
      model: this.request.model,
      output: [...this.output.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, item]) => item),
      parallel_tool_calls:
        this.request.parallel_tool_calls ?? true,
      previous_response_id: null,
      reasoning: this.request.reasoning ?? null,
      store: false,
      temperature: this.request.temperature ?? null,
      text: this.request.text ?? {
        format: {
          type: "text",
        },
      },
      tool_choice: this.request.tool_choice ?? "auto",
      tools: this.request.tools ?? [],
      top_p: this.request.top_p ?? null,
      truncation: "disabled",
      usage:
        this.usage === undefined
          ? null
          : wireUsage(this.usage),
      metadata: {},
    };
  }

  private withSequence(
    event: Record<string, unknown>,
  ): Record<string, unknown> {
    const sequence = this.sequence;
    this.sequence += 1;
    return {
      ...event,
      sequence_number: sequence,
    };
  }
}

async function writeEventStream(
  response: ServerResponse,
  events: AsyncIterable<NormalizedResponseEvent>,
  request: NormalizedResponsesRequest,
  responseId: string,
  signal: AbortSignal,
  observe: (event: NormalizedResponseEvent) => void,
): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const encoder = new ResponsesEventEncoder(request, responseId);
  for await (const event of events) {
    observe(event);
    for (const wireEvent of encoder.encode(event)) {
      await writeChunk(
        response,
        `event: ${String(wireEvent.type)}\ndata: ${JSON.stringify(wireEvent)}\n\n`,
        signal,
      );
    }
  }
  await writeChunk(response, "data: [DONE]\n\n", signal);
  response.end();
}

async function writeJsonResponse(
  response: ServerResponse,
  events: AsyncIterable<NormalizedResponseEvent>,
  request: NormalizedResponsesRequest,
  responseId: string,
  signal: AbortSignal,
  observe: (event: NormalizedResponseEvent) => void,
): Promise<void> {
  const encoder = new ResponsesEventEncoder(request, responseId);
  for await (const event of events) {
    observe(event);
    encoder.encode(event);
  }
  const body = JSON.stringify(encoder.finalResponse());
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  await writeChunk(response, body, signal);
  response.end();
}

function parseResponsesRequest(
  body: string,
  binding: ExternalModelBindingSnapshotV1,
): NormalizedResponsesRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ArkTeamError(
      "PROVIDER_RESPONSE_INVALID",
      "bridge request body is not valid JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw new ArkTeamError(
      "PROVIDER_RESPONSE_INVALID",
      "bridge request body must be an object",
    );
  }
  const validated = bridgeResponsesRequestSchema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const issuePath =
      issue === undefined || issue.path.length === 0
        ? "<root>"
        : issue.path.join(".");
    const issueFields =
      issue?.code === "unrecognized_keys"
        ? ` (${issue.keys.join(",")})`
        : "";
    throw new ArkTeamError(
      "PROVIDER_RESPONSE_INVALID",
      `bridge request body does not match the supported Responses schema at ${issuePath}${issueFields}`,
    );
  }
  const request = validated.data;
  if (request.model !== binding.model) {
    throw new ArkTeamError(
      "PROVIDER_RESPONSE_INVALID",
      "bridge request model does not match the persisted binding",
    );
  }
  const input: NormalizedResponseInputItem[] =
    typeof request.input === "string"
      ? [
          {
            type: "message",
            role: "user",
            content: request.input,
          },
        ]
      : normalizeBridgeInput(request.input);
  const tools =
    request.tools === undefined
      ? undefined
      : normalizeBridgeTools(request.tools);
  if (
    request.reasoning?.effort !== undefined &&
    request.reasoning.effort !==
      binding.effective_reasoning_effort
  ) {
    throw new ArkTeamError(
      "PROVIDER_RESPONSE_INVALID",
      "bridge request reasoning effort does not match the persisted binding",
    );
  }

  return {
    model: request.model,
    ...(request.instructions === undefined ||
    request.instructions === null
      ? {}
      : { instructions: request.instructions }),
    input,
    ...(tools === undefined
      ? {}
      : { tools }),
    ...(request.tool_choice === undefined
      ? {}
      : { tool_choice: request.tool_choice }),
    ...(request.parallel_tool_calls === undefined
      ? {}
      : {
          parallel_tool_calls: request.parallel_tool_calls,
        }),
    ...(request.reasoning === undefined
      ? {}
      : {
          reasoning: {
            ...(request.reasoning.effort === undefined
              ? {}
              : { effort: request.reasoning.effort }),
          },
        }),
    stream: request.stream,
    ...(request.text === undefined
      ? {}
      : {
          text: {
            ...(request.text.format === undefined
              ? {}
              : {
                  format:
                    request.text.format.type === "json_schema"
                      ? {
                          type: "json_schema" as const,
                          name: request.text.format.name,
                          schema: request.text.format.schema,
                          strict: request.text.format.strict,
                        }
                      : { type: request.text.format.type },
                }),
            ...(request.text.verbosity === undefined
              ? {}
              : { verbosity: request.text.verbosity }),
          },
        }),
    ...(request.max_output_tokens === undefined
      ? {}
      : { max_output_tokens: request.max_output_tokens }),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...(request.presence_penalty === undefined
      ? {}
      : { presence_penalty: request.presence_penalty }),
    ...(request.frequency_penalty === undefined
      ? {}
      : { frequency_penalty: request.frequency_penalty }),
  };
}

function normalizeBridgeInput(
  input: Exclude<
    z.infer<typeof bridgeResponsesRequestSchema>["input"],
    string
  >,
): NormalizedResponseInputItem[] {
  return input.map((item): NormalizedResponseInputItem => {
    switch (item.type) {
      case "message":
        return {
          type: "message",
          role: item.role,
          content: normalizeBridgeContent(item.content),
        };
      case "reasoning":
        return {
          type: "reasoning",
          ...(item.summary === undefined
            ? {}
            : {
                summary: item.summary.map((part) => ({
                  type: "summary_text" as const,
                  text: part.text,
                })),
              }),
          ...(item.content === undefined
            ? {}
            : {
                content: item.content.map((part) => ({
                  type: "reasoning_text" as const,
                  text: part.text,
                })),
              }),
        };
      case "function_call":
        return {
          type: "function_call",
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        };
      case "function_call_output":
        return {
          type: "function_call_output",
          call_id: item.call_id,
          output: normalizeBridgeContent(item.output),
        };
      case "custom_tool_call":
        return {
          type: "custom_tool_call",
          call_id: item.call_id,
          name: item.name,
          input: item.input,
        };
      case "custom_tool_call_output":
        return {
          type: "custom_tool_call_output",
          call_id: item.call_id,
          output: normalizeBridgeContent(item.output),
        };
    }
  });
}

function normalizeBridgeContent(
  content: z.infer<typeof contentSchema>,
): NormalizedContent {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) =>
    part.type === "input_image"
      ? {
          type: "input_image" as const,
          image_url: part.image_url,
          ...(part.detail === undefined
            ? {}
            : { detail: part.detail }),
        }
      : {
          type: part.type,
          text: part.text,
        },
  );
}

function normalizeBridgeTools(
  tools: NonNullable<
    z.infer<typeof bridgeResponsesRequestSchema>["tools"]
  >,
): NormalizedTool[] {
  return tools.map((tool): NormalizedTool =>
    tool.type === "function"
      ? {
          type: "function",
          name: tool.name,
          parameters: tool.parameters,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          ...(tool.strict === undefined
            ? {}
            : { strict: tool.strict }),
        }
      : {
          type: "custom",
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
        },
  );
}

function wireItem(
  item: NormalizedOutputItem,
  completed: boolean,
): Record<string, unknown> {
  if (item.type === "message") {
    return {
      id: item.id,
      type: "message",
      status: completed ? "completed" : "in_progress",
      role: "assistant",
      content: completed
        ? [
            {
              type: "output_text",
              annotations: [],
              logprobs: [],
              text: item.text,
            },
          ]
        : [],
    };
  }
  if (item.type === "reasoning") {
    return {
      id: item.id,
      type: "reasoning",
      status: completed ? "completed" : "in_progress",
      summary:
        completed && item.text
          ? [
              {
                type: "summary_text",
                text: item.text,
              },
            ]
          : [],
      content: null,
      encrypted_content: null,
    };
  }
  if (item.tool_kind === "custom") {
    return {
      id: item.id,
      type: "custom_tool_call",
      status: completed ? "completed" : "in_progress",
      call_id: item.call_id,
      name: item.name,
      input: item.arguments,
    };
  }
  return {
    id: item.id,
    type: "function_call",
    status: completed ? "completed" : "in_progress",
    call_id: item.call_id,
    name: item.name,
    arguments: item.arguments,
  };
}

function wireUsage(
  usage: NormalizedUsage,
): Record<string, unknown> {
  return {
    input_tokens: usage.input_tokens,
    input_tokens_details: {
      cached_tokens: usage.cached_input_tokens,
    },
    output_tokens: usage.output_tokens,
    output_tokens_details: {
      reasoning_tokens: usage.reasoning_output_tokens,
    },
    total_tokens: usage.total_tokens,
  };
}

async function readRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    if (signal.aborted) {
      throw new ArkTeamError(
        "PROVIDER_BRIDGE_UNAVAILABLE",
        "bridge request was cancelled",
      );
    }
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maximumBytes) {
      throw new ArkTeamError(
        "PROVIDER_RESPONSE_INVALID",
        "bridge request body exceeds the safe size limit",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeChunk(
  response: ServerResponse,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    signal.aborted ||
    response.destroyed ||
    response.writableEnded
  ) {
    throw bridgeCancelled();
  }
  if (!response.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        response.off("drain", drained);
        response.off("close", cancelled);
        response.off("error", cancelled);
        signal.removeEventListener("abort", cancelled);
      };
      const drained = () => {
        cleanup();
        resolve();
      };
      const cancelled = () => {
        cleanup();
        reject(bridgeCancelled());
      };
      response.once("drain", drained);
      response.once("close", cancelled);
      response.once("error", cancelled);
      signal.addEventListener("abort", cancelled, { once: true });
      if (
        signal.aborted ||
        response.destroyed ||
        response.writableEnded
      ) {
        cancelled();
      }
    });
  }
}

function bridgeCancelled(): ArkTeamError {
  return new ArkTeamError(
    "PROVIDER_BRIDGE_UNAVAILABLE",
    "bridge request was cancelled",
  );
}

async function* asAsyncEvents(
  events: readonly NormalizedResponseEvent[],
): AsyncIterable<NormalizedResponseEvent> {
  for (const event of events) {
    yield event;
  }
}

function matchesBearerToken(
  request: IncomingMessage,
  expected: string,
): boolean {
  const authorization = request.headers.authorization;
  if (
    authorization === undefined ||
    Array.isArray(authorization) ||
    !authorization.startsWith("Bearer ")
  ) {
    return false;
  }
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return (
    actual.length === target.length &&
    timingSafeEqual(actual, target)
  );
}

function isLoopbackPeer(address: string | undefined): boolean {
  return (
    address === BRIDGE_HOST ||
    address === "::ffff:127.0.0.1"
  );
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
      host: BRIDGE_HOST,
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

function writeJsonError(
  response: ServerResponse,
  status: number,
  code: string,
  message = "provider bridge request failed",
): void {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  const body = JSON.stringify({
    error: {
      type: "ark_provider_error",
      code,
      message: message.slice(0, 400),
    },
  });
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function normalizeBridgeError(error: unknown): ArkTeamError {
  if (error instanceof ArkTeamError) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    return new ArkTeamError(
      "PROVIDER_BRIDGE_UNAVAILABLE",
      "external provider request timed out or was cancelled",
      { cause: error },
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    isProviderErrorCode(error.code)
  ) {
    return new ArkTeamError(
      error.code,
      "message" in error && typeof error.message === "string"
        ? error.message.slice(0, 400)
        : "external provider request failed",
      { cause: error },
    );
  }
  return new ArkTeamError(
    "PROVIDER_BRIDGE_UNAVAILABLE",
    "external provider request failed",
    { cause: error },
  );
}

function bridgeErrorStatus(error: ArkTeamError): number {
  if (
    error.code === "PROVIDER_RESPONSE_INVALID" ||
    error.code === "PROVIDER_CAPABILITY_UNSUPPORTED"
  ) {
    return 400;
  }
  if (
    error.code === "PROVIDER_CONFIG_DRIFT" ||
    error.code === "PROVIDER_CONFIG_INSECURE_PERMISSIONS" ||
    error.code === "PROVIDER_POLICY_BLOCKED"
  ) {
    return 409;
  }
  return 502;
}

function providerErrorCode(code: string): ArkTeamErrorCode {
  return isProviderErrorCode(code)
    ? code
    : "PROVIDER_RESPONSE_INVALID";
}

function isProviderErrorCode(
  code: string,
): code is ArkTeamErrorCode {
  return (
    code === "ADAPTER_API_VERSION_UNSUPPORTED" ||
    code === "ADAPTER_HASH_MISMATCH" ||
    code === "ADAPTER_NOT_FOUND" ||
    code === "PROVIDER_BRIDGE_UNAVAILABLE" ||
    code === "PROVIDER_CAPABILITY_UNSUPPORTED" ||
    code === "PROVIDER_CONFIG_DRIFT" ||
    code === "PROVIDER_CONFIG_INSECURE_PERMISSIONS" ||
    code === "PROVIDER_CONFIG_INVALID" ||
    code === "PROVIDER_CONFIG_UNAVAILABLE" ||
    code === "PROVIDER_CREDENTIAL_MISSING" ||
    code === "PROVIDER_NOT_FOUND" ||
    code === "PROVIDER_POLICY_BLOCKED" ||
    code === "PROVIDER_RESPONSE_INVALID"
  );
}

function assertPositiveTimeout(
  value: number | undefined,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 1)
  ) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      `${name} must be a positive integer`,
    );
  }
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
