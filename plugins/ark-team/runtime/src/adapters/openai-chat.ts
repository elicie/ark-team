/*!
 * Adapted from OpenCodex v2.7.41
 * (commit ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10),
 * original source: src/adapters/openai-chat.ts and directly required helpers.
 * OpenCodex is MIT licensed; see ../../../LICENSES/OpenCodex-MIT.txt.
 *
 * Ark-specific changes include the Ark-owned ProviderAdapterV1 contract,
 * Responses text.format preservation, deterministic normalized lifecycle
 * events, request-time credentials, and removal of OpenCodex product/provider
 * registry behavior.
 */

import type {
  AdapterContext,
  NormalizedContent,
  NormalizedOutputItem,
  NormalizedProviderError,
  NormalizedResponseEvent,
  NormalizedResponsesRequest,
  NormalizedTextFormat,
  NormalizedTool,
  NormalizedToolKind,
  NormalizedUsage,
  ProviderAdapterV1,
  ProviderCapabilities,
  SafeProviderConfig,
  UpstreamRequest,
} from "../provider-adapter.js";

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_SUCCESS_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SSE_BUFFER_CHARACTERS = 2 * 1024 * 1024;
const MAX_SSE_TOTAL_CHARACTERS = 16 * 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARACTERS = 400;
const REDACTED_SECRET = "[REDACTED]";

interface ChatAssistantMessage {
  role: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: ChatToolCall[];
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface PendingToolCall {
  key: string;
  id: string;
  name: string;
  arguments: string;
}

interface StreamItemState {
  id: string;
  output_index: number;
  text: string;
  redactor: StreamingSecretRedactor;
}

interface ParsedChatChoice {
  message?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  finish_reason?: string | null;
}

class OpenAIChatAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenAIChatAdapterError";
    this.code = code;
  }
}

class StreamingSecretRedactor {
  private readonly exactSecret: string | null;
  private readonly failureTable: number[];
  private matchedCharacters = 0;
  private genericPending = "";

  constructor(exactSecret?: string | null) {
    this.exactSecret = exactSecret || null;
    this.failureTable =
      this.exactSecret === null
        ? []
        : buildFailureTable(this.exactSecret);
  }

  push(value: string): string {
    let exactSafe = "";
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index] ?? "";
      if (this.exactSecret === null) {
        exactSafe += character;
        continue;
      }
      while (
        this.matchedCharacters > 0 &&
        this.exactSecret[this.matchedCharacters] !== character
      ) {
        const fallback =
          this.failureTable[this.matchedCharacters - 1] ?? 0;
        exactSafe += this.exactSecret.slice(
          0,
          this.matchedCharacters - fallback,
        );
        this.matchedCharacters = fallback;
      }
      if (
        this.exactSecret[this.matchedCharacters] === character
      ) {
        this.matchedCharacters += 1;
        if (this.matchedCharacters === this.exactSecret.length) {
          exactSafe += REDACTED_SECRET;
          this.matchedCharacters = 0;
        }
      } else {
        exactSafe += character;
      }
    }
    this.genericPending += exactSafe;
    const sensitiveSuffixStart = genericSensitiveSuffixStart(
      this.genericPending,
    );
    const emitThrough =
      sensitiveSuffixStart ??
      this.genericPending.length;
    const ready = this.genericPending.slice(0, emitThrough);
    this.genericPending = this.genericPending.slice(emitThrough);
    return redactSecretPatterns(ready);
  }

  finish(): string {
    if (this.exactSecret !== null && this.matchedCharacters > 0) {
      this.genericPending += this.exactSecret.slice(
        0,
        this.matchedCharacters,
      );
      this.matchedCharacters = 0;
    }
    const safe = redactSecretPatterns(this.genericPending);
    this.genericPending = "";
    return safe;
  }
}

function genericSensitiveSuffixStart(value: string): number | undefined {
  const candidates = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]*$/i,
    /\bsk-[A-Za-z0-9._-]*$/,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)=[^&\s"',;]*$/i,
  ];
  let earliest: number | undefined;
  for (const pattern of candidates) {
    const match = pattern.exec(value);
    if (match?.index !== undefined) {
      earliest =
        earliest === undefined
          ? match.index
          : Math.min(earliest, match.index);
    }
  }
  const lower = value.toLowerCase();
  const markers = [
    "bearer ",
    "sk-",
    "api_key=",
    "api-key=",
    "apikey=",
    "access_token=",
    "access-token=",
    "accesstoken=",
    "refresh_token=",
    "refresh-token=",
    "refreshtoken=",
    "secret=",
  ];
  for (const marker of markers) {
    for (
      let suffixLength = 1;
      suffixLength < marker.length;
      suffixLength += 1
    ) {
      const start = lower.length - suffixLength;
      if (
        start >= 0 &&
        lower.slice(start) === marker.slice(0, suffixLength) &&
        (start === 0 || !/[A-Za-z0-9_]/.test(lower[start - 1] ?? ""))
      ) {
        earliest =
          earliest === undefined
            ? start
            : Math.min(earliest, start);
      }
    }
  }
  return earliest;
}

function buildFailureTable(pattern: string): number[] {
  const failure = new Array<number>(pattern.length).fill(0);
  let prefixLength = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (
      prefixLength > 0 &&
      pattern[index] !== pattern[prefixLength]
    ) {
      prefixLength = failure[prefixLength - 1] ?? 0;
    }
    if (pattern[index] === pattern[prefixLength]) {
      prefixLength += 1;
    }
    failure[index] = prefixLength;
  }
  return failure;
}

export function createOpenAIChatAdapter(
  config: SafeProviderConfig,
): ProviderAdapterV1 {
  validateOpenAIChatConfig(config);

  return {
    apiVersion: 1,
    id: "builtin:openai-chat",

    capabilities(candidate): ProviderCapabilities {
      validateOpenAIChatConfig(candidate);
      return Object.freeze({
        streaming: true,
        tools: true,
        parallel_tools: true,
        reasoning: true,
        images: false,
        structured_output: candidate.structured_output_mode,
      });
    },

    validateConfig(candidate): void {
      validateOpenAIChatConfig(candidate);
    },

    buildRequest(
      request: NormalizedResponsesRequest,
      context: AdapterContext,
    ): UpstreamRequest {
      validateContext(context);
      const credential = credentialForRequest(config, context);
      const body = buildChatRequestBody(config, request, context);
      const headers: Record<string, string> = {
        Accept: request.stream ? "text/event-stream" : "application/json",
        "Content-Type": "application/json",
      };
      if (credential !== undefined) {
        headers.Authorization = `Bearer ${credential}`;
      }
      return {
        url: chatCompletionsUrl(config.base_url),
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      };
    },

    async *parseStream(
      response: Response,
      context: AdapterContext,
    ): AsyncIterable<NormalizedResponseEvent> {
      validateContext(context);
      yield* parseOpenAIChatStream(response, context, formatOpenAIChatError);
    },

    async parseResponse(
      response: Response,
      context: AdapterContext,
    ): Promise<NormalizedResponseEvent[]> {
      validateContext(context);
      return parseOpenAIChatResponse(response, context, formatOpenAIChatError);
    },

    formatError: formatOpenAIChatError,
  };
}

function validateOpenAIChatConfig(config: SafeProviderConfig): void {
  if (config.adapter !== "builtin:openai-chat") {
    throw new OpenAIChatAdapterError(
      "ADAPTER_NOT_FOUND",
      "OpenAI Chat adapter received a different adapter ID",
    );
  }
  let url: URL;
  try {
    url = new URL(config.base_url);
  } catch {
    throw new OpenAIChatAdapterError(
      "PROVIDER_CONFIG_INVALID",
      "OpenAI Chat base_url must be an absolute URL",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_CONFIG_INVALID",
      "OpenAI Chat base_url contains unsupported URL components",
    );
  }
}

function validateContext(context: AdapterContext): void {
  if (!context.response_id.trim()) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      "response_id must not be empty",
    );
  }
}

function credentialForRequest(
  config: SafeProviderConfig,
  context: AdapterContext,
): string | undefined {
  if (config.auth_kind === "none") {
    return undefined;
  }
  if (
    context.credential === undefined ||
    context.credential === null ||
    context.credential.trim().length === 0
  ) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_CREDENTIAL_MISSING",
      "OpenAI Chat upstream credential is unavailable",
    );
  }
  return context.credential;
}

function chatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url.toString();
}

function buildChatRequestBody(
  config: SafeProviderConfig,
  request: NormalizedResponsesRequest,
  context: AdapterContext,
): Record<string, unknown> {
  if (!request.model.trim()) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_CONFIG_INVALID",
      "Responses model must not be empty",
    );
  }

  const format = request.text?.format;
  const validatedInstruction =
    config.structured_output_mode === "validated_json" && format !== undefined
      ? validatedJsonInstruction(format)
      : undefined;
  const tools = toolsToChatFormat(request.tools);
  const body: Record<string, unknown> = {
    model: request.model,
    messages: messagesToChatFormat(request, validatedInstruction),
    stream: request.stream,
  };

  if (tools !== undefined) {
    body.tools = tools;
    body.parallel_tool_calls = request.parallel_tool_calls !== false;
    const toolChoice = toolChoiceToChatFormat(request.tool_choice);
    if (toolChoice !== undefined) {
      body.tool_choice = toolChoice;
    }
  }

  const reasoningEffort =
    context.reasoning_effort ?? request.reasoning?.effort;
  if (reasoningEffort !== undefined) {
    body.reasoning_effort = reasoningEffort;
  }
  if (request.max_output_tokens !== undefined) {
    body.max_tokens = request.max_output_tokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    body.top_p = request.top_p;
  }
  if (request.stop !== undefined) {
    body.stop = request.stop;
  }
  if (request.presence_penalty !== undefined) {
    body.presence_penalty = request.presence_penalty;
  }
  if (request.frequency_penalty !== undefined) {
    body.frequency_penalty = request.frequency_penalty;
  }
  if (request.stream) {
    body.stream_options = { include_usage: true };
  }

  if (
    config.structured_output_mode === "native_json_schema" &&
    format !== undefined
  ) {
    body.response_format = responseFormatToChatFormat(format);
  }
  return body;
}

function messagesToChatFormat(
  request: NormalizedResponsesRequest,
  validatedInstruction: string | undefined,
): unknown[] {
  const messages: unknown[] = [];
  const systemParts: string[] = [];
  if (request.instructions) {
    systemParts.push(request.instructions);
  }
  for (const item of request.input) {
    if (item.type === "message" && (item.role === "system" || item.role === "developer")) {
      const text = contentToText(item.content);
      if (text) {
        systemParts.push(text);
      }
    }
  }
  if (validatedInstruction !== undefined) {
    systemParts.push(validatedInstruction);
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  let assistant: ChatAssistantMessage | undefined;
  let unresolvedToolCalls: Array<{ id: string; name: string }> = [];
  let orphanSequence = 0;

  const ensureAssistant = (): ChatAssistantMessage => {
    assistant ??= { role: "assistant" };
    return assistant;
  };
  const flushAssistant = (): void => {
    if (assistant === undefined) {
      return;
    }
    const hasContent = typeof assistant.content === "string";
    const hasReasoning = typeof assistant.reasoning_content === "string";
    const hasTools = (assistant.tool_calls?.length ?? 0) > 0;
    if (hasContent || hasReasoning || hasTools) {
      if (hasTools && assistant.content === undefined) {
        assistant.content = "";
      }
      messages.push(assistant);
      for (const call of assistant.tool_calls ?? []) {
        unresolvedToolCalls.push({
          id: call.id,
          name: call.function.name,
        });
      }
    }
    assistant = undefined;
  };
  const closeUnresolvedToolCalls = (): void => {
    flushAssistant();
    for (const call of unresolvedToolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content:
          `[ark] no tool result was recorded for "${call.name}"; ` +
          "execution status is unknown.",
      });
    }
    unresolvedToolCalls = [];
  };

  for (const item of request.input) {
    switch (item.type) {
      case "message": {
        if (item.role === "system" || item.role === "developer") {
          break;
        }
        if (item.role === "user") {
          closeUnresolvedToolCalls();
          messages.push({
            role: "user",
            content: contentToText(item.content),
          });
          break;
        }
        const text = contentToText(item.content);
        if (text) {
          const current = ensureAssistant();
          current.content = `${current.content ?? ""}${text}`;
        }
        break;
      }
      case "reasoning": {
        const summary = (item.summary ?? []).map((part) => part.text).join("");
        const raw = (item.content ?? []).map((part) => part.text).join("");
        const reasoning = summary || raw;
        if (reasoning) {
          const current = ensureAssistant();
          current.reasoning_content =
            `${current.reasoning_content ?? ""}${reasoning}`;
        }
        break;
      }
      case "function_call": {
        const current = ensureAssistant();
        current.tool_calls ??= [];
        current.tool_calls.push({
          id: requiredString(item.call_id, "function call ID"),
          type: "function",
          function: {
            name: requiredString(item.name, "function name"),
            arguments: item.arguments,
          },
        });
        break;
      }
      case "custom_tool_call": {
        const current = ensureAssistant();
        current.tool_calls ??= [];
        current.tool_calls.push({
          id: requiredString(item.call_id, "custom tool call ID"),
          type: "function",
          function: {
            name: requiredString(item.name, "custom tool name"),
            arguments: JSON.stringify({ input: item.input }),
          },
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        flushAssistant();
        const callId = requiredString(item.call_id, "tool result call ID");
        const match = unresolvedToolCalls.findIndex((call) => call.id === callId);
        if (match < 0) {
          closeUnresolvedToolCalls();
          const synthesizedName = `tool_result_${++orphanSequence}`;
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: callId,
                type: "function",
                function: { name: synthesizedName, arguments: "{}" },
              },
            ],
          });
        } else {
          unresolvedToolCalls.splice(match, 1);
        }
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: contentToText(item.output),
        });
        break;
      }
    }
  }
  closeUnresolvedToolCalls();
  return messages;
}

function contentToText(content: NormalizedContent): string {
  if (typeof content === "string") {
    return content;
  }
  const text: string[] = [];
  for (const part of content) {
    if (part.type === "input_image") {
      throw new OpenAIChatAdapterError(
        "PROVIDER_CAPABILITY_UNSUPPORTED",
        "OpenAI Chat adapter image input is not enabled by this contract",
      );
    }
    text.push(part.text);
  }
  return text.join("");
}

function toolsToChatFormat(
  tools: readonly NormalizedTool[] | undefined,
): unknown[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => {
    const description = tool.description ? { description: tool.description } : {};
    if (tool.type === "function") {
      return {
        type: "function",
        function: {
          name: requiredString(tool.name, "tool name"),
          ...description,
          parameters: tool.parameters,
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      };
    }
    return {
      type: "function",
      function: {
        name: requiredString(tool.name, "custom tool name"),
        ...description,
        parameters: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Raw custom tool input.",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
    };
  });
}

function toolChoiceToChatFormat(
  toolChoice: NormalizedResponsesRequest["tool_choice"],
): unknown {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (
    toolChoice === "auto" ||
    toolChoice === "none" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  return {
    type: "function",
    function: { name: requiredString(toolChoice.name, "tool choice name") },
  };
}

function responseFormatToChatFormat(
  format: NormalizedTextFormat,
): Record<string, unknown> {
  if (format.type === "text") {
    return { type: "text" };
  }
  if (format.type === "json_object") {
    return { type: "json_object" };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: requiredString(format.name, "JSON schema name"),
      strict: format.strict,
      schema: format.schema,
    },
  };
}

function validatedJsonInstruction(format: NormalizedTextFormat): string {
  if (format.type === "text") {
    return "Return only the requested final text.";
  }
  if (format.type === "json_object") {
    return "Return only one valid JSON object. Do not add Markdown fences or commentary.";
  }
  return [
    "Return only one JSON value that validates against this JSON Schema.",
    "Do not add Markdown fences or commentary.",
    `Schema name: ${format.name}`,
    `JSON Schema: ${canonicalJson(format.schema)}`,
  ].join("\n");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function* parseOpenAIChatStream(
  response: Response,
  context: AdapterContext,
  formatError: ProviderAdapterV1["formatError"],
): AsyncIterable<NormalizedResponseEvent> {
  yield { type: "response_created", response_id: context.response_id };
  yield {
    type: "response_in_progress",
    response_id: context.response_id,
  };
  if (!response.ok) {
    let body: string;
    try {
      body = await readBoundedText(response, MAX_ERROR_BODY_BYTES);
    } catch {
      yield {
        type: "response_failed",
        response_id: context.response_id,
        error: providerError(
          "PROVIDER_RESPONSE_INVALID",
          `Upstream provider returned HTTP ${response.status} with an oversized error body`,
          response.status,
        ),
      };
      return;
    }
    yield {
      type: "response_failed",
      response_id: context.response_id,
      error: redactContextSecret(
        formatError(response.status, response.headers, body),
        context,
      ),
    };
    return;
  }
  if (response.body === null) {
    yield responseFailure(context, "Upstream response body is unavailable");
    return;
  }

  let nextOutputIndex = 0;
  let message: StreamItemState | undefined;
  let reasoning: StreamItemState | undefined;
  let usage: NormalizedUsage | undefined;
  let finishReason: string | undefined;
  let sawDone = false;
  const pendingToolCalls: PendingToolCall[] = [];

  const addText = (delta: string): NormalizedResponseEvent[] => {
    if (!delta) {
      return [];
    }
    const events: NormalizedResponseEvent[] = [];
    if (message === undefined) {
      message = {
        id: outputItemId(context, "message", 0),
        output_index: nextOutputIndex++,
        text: "",
        redactor: new StreamingSecretRedactor(context.credential),
      };
      events.push({
        type: "output_item_added",
        output_index: message.output_index,
        item: messageItem(message.id, ""),
      });
    }
    const safeDelta = message.redactor.push(delta);
    message.text += safeDelta;
    if (safeDelta) {
      events.push({
        type: "text_delta",
        output_index: message.output_index,
        item_id: message.id,
        content_index: 0,
        delta: safeDelta,
      });
    }
    return events;
  };
  const addReasoning = (delta: string): NormalizedResponseEvent[] => {
    if (!delta) {
      return [];
    }
    const events: NormalizedResponseEvent[] = [];
    if (reasoning === undefined) {
      reasoning = {
        id: outputItemId(context, "reasoning", 0),
        output_index: nextOutputIndex++,
        text: "",
        redactor: new StreamingSecretRedactor(context.credential),
      };
      events.push({
        type: "output_item_added",
        output_index: reasoning.output_index,
        item: reasoningItem(reasoning.id, ""),
      });
    }
    const safeDelta = reasoning.redactor.push(delta);
    reasoning.text += safeDelta;
    if (safeDelta) {
      events.push({
        type: "reasoning_delta",
        output_index: reasoning.output_index,
        item_id: reasoning.id,
        content_index: 0,
        delta: safeDelta,
      });
    }
    return events;
  };
  const finishItems = (): NormalizedResponseEvent[] => {
    const events: NormalizedResponseEvent[] = [];
    const textual = [reasoning, message]
      .filter((item): item is StreamItemState => item !== undefined)
      .sort((left, right) => left.output_index - right.output_index);
    for (const item of textual) {
      const finalDelta = item.redactor.finish();
      item.text += finalDelta;
      if (item === reasoning) {
        if (finalDelta) {
          events.push({
            type: "reasoning_delta",
            output_index: item.output_index,
            item_id: item.id,
            content_index: 0,
            delta: finalDelta,
          });
        }
        events.push({
          type: "reasoning_done",
          output_index: item.output_index,
          item_id: item.id,
          content_index: 0,
          text: item.text,
        });
        events.push({
          type: "output_item_done",
          output_index: item.output_index,
          item: reasoningItem(item.id, item.text),
        });
      } else {
        if (finalDelta) {
          events.push({
            type: "text_delta",
            output_index: item.output_index,
            item_id: item.id,
            content_index: 0,
            delta: finalDelta,
          });
        }
        events.push({
          type: "text_done",
          output_index: item.output_index,
          item_id: item.id,
          content_index: 0,
          text: item.text,
        });
        events.push({
          type: "output_item_done",
          output_index: item.output_index,
          item: messageItem(item.id, item.text),
        });
      }
    }
    for (const [index, call] of pendingToolCalls.entries()) {
      if (!call.id || !call.name) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream tool call did not provide an ID and function name",
        );
      }
      const toolKind = context.tool_kinds?.[call.name] ?? "function";
      const safeCall: PendingToolCall = {
        ...call,
        id: redactPayloadSecrets(call.id, context.credential),
        name: redactPayloadSecrets(call.name, context.credential),
        arguments: normalizeToolArguments(
          toolKind,
          call.arguments,
          context.credential,
        ),
      };
      const outputIndex = nextOutputIndex++;
      const itemId = outputItemId(context, "tool", index);
      const item = toolCallItem(itemId, toolKind, safeCall);
      events.push({
        type: "output_item_added",
        output_index: outputIndex,
        item: toolCallItem(itemId, toolKind, {
          ...safeCall,
          arguments: "",
        }),
      });
      if (safeCall.arguments) {
        events.push({
          type: "function_call_arguments_delta",
          output_index: outputIndex,
          item_id: itemId,
          call_id: safeCall.id,
          delta: safeCall.arguments,
        });
      }
      events.push({
        type: "function_call_arguments_done",
        output_index: outputIndex,
        item_id: itemId,
        tool_kind: toolKind,
        call_id: safeCall.id,
        name: safeCall.name,
        arguments: safeCall.arguments,
      });
      events.push({
        type: "output_item_done",
        output_index: outputIndex,
        item,
      });
    }
    pendingToolCalls.length = 0;
    return events;
  };
  const finishResponse = (): NormalizedResponseEvent[] => {
    if (
      finishReason === "tool_calls" &&
      pendingToolCalls.length === 0
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream reported tool_calls without a tool call",
      );
    }
    const events = finishItems();
    if (finishReason === "length" || finishReason === "content_filter") {
      events.push({
        type: "response_incomplete",
        response_id: context.response_id,
        reason:
          finishReason === "length" ? "max_output_tokens" : "content_filter",
        ...(usage === undefined ? {} : { usage }),
      });
    } else {
      events.push({
        type: "response_completed",
        response_id: context.response_id,
        ...(usage === undefined ? {} : { usage }),
      });
    }
    return events;
  };

  try {
    for await (const payload of sseDataPayloads(
      response.body,
      context.on_stream_activity,
    )) {
      if (payload === "[DONE]") {
        sawDone = true;
        for (const event of finishResponse()) {
          yield event;
        }
        return;
      }

      let chunk: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (!isRecord(parsed)) {
          throw new Error("not an object");
        }
        chunk = parsed;
      } catch {
        yield responseFailure(context, "Malformed upstream SSE data frame", usage);
        return;
      }
      if (chunk.error !== undefined) {
        yield {
          type: "response_failed",
          response_id: context.response_id,
          error: providerError(
            "PROVIDER_RESPONSE_INVALID",
            "Upstream provider stream failed",
            undefined,
          ),
          ...(usage === undefined ? {} : { usage }),
        };
        return;
      }
      let chunkUsage: NormalizedUsage | undefined;
      if (chunk.usage !== undefined && chunk.usage !== null) {
        if (!isRecord(chunk.usage)) {
          throw new OpenAIChatAdapterError(
            "PROVIDER_RESPONSE_INVALID",
            "Upstream usage is malformed",
          );
        }
        chunkUsage = usageFromOpenAIChat(chunk.usage);
        usage = chunkUsage;
        yield { type: "usage", usage };
      }

      if (!Array.isArray(chunk.choices) || chunk.choices.length > 1) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream choices is malformed",
        );
      }
      const choices = chunk.choices as ParsedChatChoice[];
      const choice = choices[0];
      if (choice === undefined) {
        if (chunkUsage === undefined) {
          throw new OpenAIChatAdapterError(
            "PROVIDER_RESPONSE_INVALID",
            "Upstream stream chunk contained no choice or usage",
          );
        }
        continue;
      }
      if (!isRecord(choice)) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream choice is malformed",
        );
      }
      if (
        choice.finish_reason !== undefined &&
        choice.finish_reason !== null &&
        typeof choice.finish_reason !== "string"
      ) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream finish_reason is malformed",
        );
      }
      if (
        typeof choice.finish_reason === "string" &&
        choice.finish_reason.length > 0
      ) {
        finishReason = choice.finish_reason;
      }
      if (!isRecord(choice.delta)) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream delta is malformed",
        );
      }
      const rawReasoning = choice.delta.reasoning_content;
      if (
        rawReasoning !== undefined &&
        rawReasoning !== null &&
        typeof rawReasoning !== "string"
      ) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream reasoning content is malformed",
        );
      }
      if (typeof rawReasoning === "string") {
        for (const event of addReasoning(rawReasoning)) {
          yield event;
        }
      }
      const rawText = choice.delta.content;
      if (
        rawText !== undefined &&
        rawText !== null &&
        typeof rawText !== "string"
      ) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream text content is malformed",
        );
      }
      if (typeof rawText === "string") {
        for (const event of addText(rawText)) {
          yield event;
        }
      }
      if ("tool_calls" in choice.delta) {
        collectToolCallFragments(
          choice.delta.tool_calls,
          pendingToolCalls,
        );
      }
    }

    if (!sawDone && finishReason === undefined && usage === undefined) {
      yield responseFailure(
        context,
        "Upstream stream ended without [DONE], finish_reason, or terminal usage",
      );
      return;
    }
    for (const event of finishResponse()) {
      yield event;
    }
  } catch (error) {
    yield responseFailure(
      context,
      error instanceof OpenAIChatAdapterError
        ? error.message
        : "Unable to consume upstream response stream",
      usage,
    );
  }
}

async function parseOpenAIChatResponse(
  response: Response,
  context: AdapterContext,
  formatError: ProviderAdapterV1["formatError"],
): Promise<NormalizedResponseEvent[]> {
  const events: NormalizedResponseEvent[] = [
    { type: "response_created", response_id: context.response_id },
    {
      type: "response_in_progress",
      response_id: context.response_id,
    },
  ];
  let body: string;
  try {
    body = await readBoundedText(
      response,
      response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
    );
  } catch {
    events.push({
      type: "response_failed",
      response_id: context.response_id,
      error: providerError(
        "PROVIDER_RESPONSE_INVALID",
        response.ok
          ? "Upstream response exceeded the body limit"
          : `Upstream provider returned HTTP ${response.status} with an oversized error body`,
        response.status,
      ),
    });
    return events;
  }
  if (!response.ok) {
    events.push({
      type: "response_failed",
      response_id: context.response_id,
      error: redactContextSecret(
        formatError(response.status, response.headers, body),
        context,
      ),
    });
    return events;
  }

  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      throw new Error("not an object");
    }
    json = parsed;
  } catch {
    events.push(responseFailure(context, "Malformed upstream JSON response"));
    return events;
  }
  if (json.error !== undefined) {
    events.push({
      type: "response_failed",
      response_id: context.response_id,
      error: providerError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream provider response failed",
        undefined,
      ),
    });
    return events;
  }

  let choice: ParsedChatChoice & { message: Record<string, unknown> };
  let usage: NormalizedUsage | undefined;
  try {
    if (!Array.isArray(json.choices) || json.choices.length !== 1) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream response contained an invalid message choice",
      );
    }
    const candidate = json.choices[0];
    if (!isRecord(candidate) || !isRecord(candidate.message)) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream response contained no message choice",
      );
    }
    const message = candidate.message;
    if (
      candidate.finish_reason !== undefined &&
      candidate.finish_reason !== null &&
      typeof candidate.finish_reason !== "string"
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream finish_reason is malformed",
      );
    }
    for (const [label, value] of [
      ["reasoning content", message.reasoning_content],
      ["text content", message.content],
    ] as const) {
      if (
        value !== undefined &&
        value !== null &&
        typeof value !== "string"
      ) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          `Upstream ${label} is malformed`,
        );
      }
    }
    if (
      json.usage !== undefined &&
      json.usage !== null &&
      !isRecord(json.usage)
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream usage is malformed",
      );
    }
    choice = {
      message,
      ...(
        candidate.finish_reason === null ||
        typeof candidate.finish_reason === "string"
          ? { finish_reason: candidate.finish_reason }
          : {}
      ),
    };
    usage =
      isRecord(json.usage)
        ? usageFromOpenAIChat(json.usage)
        : undefined;
  } catch (error) {
    events.push(
      responseFailure(
        context,
        error instanceof OpenAIChatAdapterError
          ? error.message
          : "Upstream response is malformed",
      ),
    );
    return events;
  }

  let outputIndex = 0;
  const rawReasoning = choice.message.reasoning_content;
  if (typeof rawReasoning === "string" && rawReasoning.length > 0) {
    const reasoning = redactPayloadSecrets(rawReasoning, context.credential);
    const id = outputItemId(context, "reasoning", 0);
    const item = reasoningItem(id, reasoning);
    events.push(
      { type: "output_item_added", output_index: outputIndex, item: reasoningItem(id, "") },
      {
        type: "reasoning_delta",
        output_index: outputIndex,
        item_id: id,
        content_index: 0,
        delta: reasoning,
      },
      {
        type: "reasoning_done",
        output_index: outputIndex,
        item_id: id,
        content_index: 0,
        text: reasoning,
      },
      { type: "output_item_done", output_index: outputIndex, item },
    );
    outputIndex++;
  }

  const rawText = choice.message.content;
  if (typeof rawText === "string" && rawText.length > 0) {
    const text = redactPayloadSecrets(rawText, context.credential);
    const id = outputItemId(context, "message", 0);
    const item = messageItem(id, text);
    events.push(
      { type: "output_item_added", output_index: outputIndex, item: messageItem(id, "") },
      {
        type: "text_delta",
        output_index: outputIndex,
        item_id: id,
        content_index: 0,
        delta: text,
      },
      {
        type: "text_done",
        output_index: outputIndex,
        item_id: id,
        content_index: 0,
        text,
      },
      { type: "output_item_done", output_index: outputIndex, item },
    );
    outputIndex++;
  }

  const rawToolCallsValue = choice.message.tool_calls;
  if (
    rawToolCallsValue !== undefined &&
    !Array.isArray(rawToolCallsValue)
  ) {
    events.push(responseFailure(context, "Upstream tool_calls is malformed"));
    return events;
  }
  const rawToolCalls = rawToolCallsValue ?? [];
  const finishReason =
    typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : undefined;
  if (finishReason === "tool_calls" && rawToolCalls.length === 0) {
    events.push(
      responseFailure(
        context,
        "Upstream reported tool_calls without a tool call",
      ),
    );
    return events;
  }
  for (const [index, rawCall] of rawToolCalls.entries()) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) {
      events.push(responseFailure(context, "Upstream tool call is malformed"));
      return events;
    }
    const callId = stringValue(rawCall.id);
    const name = stringValue(rawCall.function.name);
    const argumentsValue = stringValue(rawCall.function.arguments);
    if (!callId || !name || argumentsValue === undefined) {
      events.push(responseFailure(context, "Upstream tool call is incomplete"));
      return events;
    }
    const safeCallId = redactPayloadSecrets(callId, context.credential);
    const safeName = redactPayloadSecrets(name, context.credential);
    const toolKind = context.tool_kinds?.[name] ?? "function";
    let safeArguments: string;
    try {
      safeArguments = normalizeToolArguments(
        toolKind,
        argumentsValue,
        context.credential,
      );
    } catch (error) {
      events.push(
        responseFailure(
          context,
          error instanceof OpenAIChatAdapterError
            ? error.message
            : "Upstream tool call arguments are malformed",
        ),
      );
      return events;
    }
    const id = outputItemId(context, "tool", index);
    const call: PendingToolCall = {
      key: `index:${index}`,
      id: safeCallId,
      name: safeName,
      arguments: safeArguments,
    };
    const item = toolCallItem(id, toolKind, call);
    events.push({
      type: "output_item_added",
      output_index: outputIndex,
      item: toolCallItem(id, toolKind, { ...call, arguments: "" }),
    });
    if (safeArguments) {
      events.push({
        type: "function_call_arguments_delta",
        output_index: outputIndex,
        item_id: id,
        call_id: safeCallId,
        delta: safeArguments,
      });
    }
    events.push(
      {
        type: "function_call_arguments_done",
        output_index: outputIndex,
        item_id: id,
        tool_kind: toolKind,
        call_id: safeCallId,
        name: safeName,
        arguments: safeArguments,
      },
      { type: "output_item_done", output_index: outputIndex, item },
    );
    outputIndex++;
  }

  if (usage !== undefined) {
    events.push({ type: "usage", usage });
  }
  if (finishReason === "length" || finishReason === "content_filter") {
    events.push({
      type: "response_incomplete",
      response_id: context.response_id,
      reason:
        finishReason === "length" ? "max_output_tokens" : "content_filter",
      ...(usage === undefined ? {} : { usage }),
    });
  } else {
    events.push({
      type: "response_completed",
      response_id: context.response_id,
      ...(usage === undefined ? {} : { usage }),
    });
  }
  return events;
}

function collectToolCallFragments(
  rawToolCalls: unknown,
  pending: PendingToolCall[],
): void {
  if (!Array.isArray(rawToolCalls)) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      "Upstream tool_calls delta is malformed",
    );
  }
  for (const rawCall of rawToolCalls) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream tool call delta is malformed",
      );
    }
    if (
      rawCall.index !== undefined &&
      (typeof rawCall.index !== "number" ||
        !Number.isInteger(rawCall.index) ||
        rawCall.index < 0)
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream tool call index is malformed",
      );
    }
    const index = rawCall.index as number | undefined;
    if (
      rawCall.id !== undefined &&
      (typeof rawCall.id !== "string" || rawCall.id.length === 0)
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream tool call ID is malformed",
      );
    }
    const id = stringValue(rawCall.id);
    const key =
      index !== undefined
        ? `index:${index}`
        : id
          ? `id:${id}`
          : pending.length === 1
            ? pending[0]?.key
            : undefined;
    if (key === undefined) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream tool call delta cannot be associated with a call",
      );
    }
    let call =
      pending.find((candidate) => candidate.key === key);
    if (call === undefined && id) {
      call = pending.find((candidate) => candidate.id === id);
    }
    if (call === undefined) {
      call = {
        key,
        id: "",
        name: "",
        arguments: "",
      };
      pending.push(call);
    }
    if (!call.id && id) {
      call.id = id;
    }
    if (
      rawCall.function.name !== undefined &&
      typeof rawCall.function.name !== "string"
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream tool call name is malformed",
      );
    }
    if (
      rawCall.function.arguments !== undefined &&
      typeof rawCall.function.arguments !== "string"
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream tool call arguments are malformed",
      );
    }
    const name = stringValue(rawCall.function.name);
    const argumentDelta = stringValue(rawCall.function.arguments);
    if (!call.name && name) {
      call.name = name;
    }
    if (argumentDelta) {
      call.arguments += argumentDelta;
    }
  }
}

function normalizeToolArguments(
  toolKind: NormalizedToolKind,
  rawArguments: string,
  credential?: string | null,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new OpenAIChatAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      "Upstream tool call arguments are not valid JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      "Upstream tool call arguments must be a JSON object",
    );
  }
  if (toolKind === "custom") {
    const keys = Object.keys(parsed);
    if (
      keys.length !== 1 ||
      keys[0] !== "input" ||
      typeof parsed.input !== "string"
    ) {
      throw new OpenAIChatAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Upstream custom tool arguments must contain only a string input",
      );
    }
    return redactPayloadSecrets(parsed.input, credential);
  }
  return JSON.stringify(redactJsonValue(parsed, credential));
}

function redactJsonValue(
  value: unknown,
  credential?: string | null,
): unknown {
  if (typeof value === "string") {
    return redactPayloadSecrets(value, credential);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, credential));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactPayloadSecrets(key, credential),
        redactJsonValue(item, credential),
      ]),
    );
  }
  return value;
}

async function* sseDataPayloads(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let totalCharacters = 0;

  const consumeLine = (line: string): string | undefined => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized === "") {
      if (dataLines.length === 0) {
        return undefined;
      }
      const payload = dataLines.join("\n");
      dataLines = [];
      return payload;
    }
    if (normalized.startsWith("data:")) {
      const data = normalized.slice(5);
      dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.byteLength > 0) {
        onActivity?.();
      }
      const decoded = decoder.decode(value, { stream: true });
      totalCharacters += decoded.length;
      if (totalCharacters > MAX_SSE_TOTAL_CHARACTERS) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream SSE stream exceeded the total size limit",
        );
      }
      buffer += decoded;
      if (buffer.length > MAX_SSE_BUFFER_CHARACTERS) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream SSE frame exceeded the buffer limit",
        );
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const payload = consumeLine(line);
        if (payload !== undefined) {
          yield payload;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const payload = consumeLine(buffer);
      if (payload !== undefined) {
        yield payload;
      }
    }
    if (dataLines.length > 0) {
      yield dataLines.join("\n");
    }
  } finally {
    reader.releaseLock();
  }
}

function usageFromOpenAIChat(
  usage: Record<string, unknown>,
): NormalizedUsage {
  const promptDetails = optionalUsageDetails(
    usage.prompt_tokens_details,
    "prompt_tokens_details",
  );
  const completionDetails = optionalUsageDetails(
    usage.completion_tokens_details,
    "completion_tokens_details",
  );
  const inputTokens = requiredUsageInteger(
    usage.prompt_tokens,
    "prompt_tokens",
  );
  const outputTokens = requiredUsageInteger(
    usage.completion_tokens,
    "completion_tokens",
  );
  return {
    input_tokens: inputTokens,
    cached_input_tokens: optionalUsageInteger(
      promptDetails.cached_tokens,
      "prompt_tokens_details.cached_tokens",
    ),
    cache_write_input_tokens: optionalUsageInteger(
      promptDetails.cache_write_tokens,
      "prompt_tokens_details.cache_write_tokens",
    ),
    output_tokens: outputTokens,
    reasoning_output_tokens: optionalUsageInteger(
      completionDetails.reasoning_tokens,
      "completion_tokens_details.reasoning_tokens",
    ),
    total_tokens: requiredUsageInteger(
      usage.total_tokens,
      "total_tokens",
    ),
  };
}

function optionalUsageDetails(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      `Upstream ${label} is malformed`,
    );
  }
  return value;
}

function requiredUsageInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      `Upstream ${label} is malformed`,
    );
  }
  return value;
}

function optionalUsageInteger(value: unknown, label: string): number {
  return value === undefined || value === null
    ? 0
    : requiredUsageInteger(value, label);
}

function messageItem(id: string, text: string): NormalizedOutputItem {
  return { type: "message", id, role: "assistant", text };
}

function reasoningItem(id: string, text: string): NormalizedOutputItem {
  return { type: "reasoning", id, text };
}

function toolCallItem(
  id: string,
  toolKind: NormalizedToolKind,
  call: Pick<PendingToolCall, "id" | "name" | "arguments">,
): NormalizedOutputItem {
  return {
    type: "tool_call",
    id,
    tool_kind: toolKind,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
  };
}

function outputItemId(
  context: AdapterContext,
  kind: "message" | "reasoning" | "tool",
  index: number,
): string {
  return `${context.response_id}_${kind}_${index}`;
}

function responseFailure(
  context: AdapterContext,
  message: string,
  usage?: NormalizedUsage,
): NormalizedResponseEvent {
  return {
    type: "response_failed",
    response_id: context.response_id,
    error: providerError(
      "PROVIDER_RESPONSE_INVALID",
      redactKnownSecrets(message, context.credential),
      undefined,
    ),
    ...(usage === undefined ? {} : { usage }),
  };
}

function formatOpenAIChatError(
  status: number,
  _headers: Headers,
  _body: string,
): NormalizedProviderError {
  return providerError(
    "PROVIDER_RESPONSE_INVALID",
    `Upstream provider returned HTTP ${status}`,
    status,
  );
}

function providerError(
  code: string,
  message: string,
  status: number | undefined,
): NormalizedProviderError {
  return {
    code,
    message: message.slice(0, MAX_ERROR_MESSAGE_CHARACTERS),
    ...(status === undefined ? {} : { status }),
    retryable:
      status === undefined ||
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500,
  };
}

function redactContextSecret(
  error: NormalizedProviderError,
  context: AdapterContext,
): NormalizedProviderError {
  return {
    ...error,
    message: redactKnownSecrets(error.message, context.credential),
  };
}

function redactKnownSecrets(
  value: string,
  exactSecret?: string | null,
): string {
  return redactSecretPatterns(value, exactSecret).slice(
    0,
    MAX_ERROR_MESSAGE_CHARACTERS,
  );
}

function redactPayloadSecrets(
  value: string,
  exactSecret?: string | null,
): string {
  return redactSecretPatterns(value, exactSecret);
}

function redactSecretPatterns(
  value: string,
  exactSecret?: string | null,
): string {
  let redacted = value;
  if (exactSecret) {
    redacted = redacted.split(exactSecret).join(REDACTED_SECRET);
  }
  return redacted
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
      `Bearer ${REDACTED_SECRET}`,
    )
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9._-]{6,}\b/g, REDACTED_SECRET)
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)=)([^&\s"',;]+)/gi,
      `$1${REDACTED_SECRET}`,
    );
}

async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new OpenAIChatAdapterError(
          "PROVIDER_RESPONSE_INVALID",
          "Upstream response exceeded the body limit",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function requiredString(value: string, label: string): string {
  if (!value.trim()) {
    throw new OpenAIChatAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      `${label} must not be empty`,
    );
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
