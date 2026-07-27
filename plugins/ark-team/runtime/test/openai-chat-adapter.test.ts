import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAIChatAdapter } from "../src/adapters/openai-chat.js";
import {
  toolKindsForRequest,
  type AdapterContext,
  type NormalizedResponseEvent,
  type NormalizedResponsesRequest,
  type SafeProviderConfig,
} from "../src/provider-adapter.js";

const nativeConfig: SafeProviderConfig = {
  adapter: "builtin:openai-chat",
  base_url: "https://provider.example/api/v1/",
  auth_kind: "inline_key",
  structured_output_mode: "native_json_schema",
};

const validatedConfig: SafeProviderConfig = {
  ...nativeConfig,
  auth_kind: "env_key",
  structured_output_mode: "validated_json",
};

test("TEST-008 builds Chat history, tools, reasoning, and native text.format", () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const request: NormalizedResponsesRequest = {
    model: "provider-model",
    instructions: "System contract.",
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Developer contract." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Do work." }],
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Prior summary." }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: "{\"cmd\":\"pwd\"}",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "ok",
      },
    ],
    tools: [
      {
        type: "function",
        name: "exec_command",
        description: "Execute a command",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
        strict: true,
      },
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
      },
    ],
    tool_choice: { type: "function", name: "exec_command" },
    parallel_tool_calls: true,
    reasoning: { effort: "high" },
    stream: true,
    text: {
      format: {
        type: "json_schema",
        name: "worker_report",
        strict: true,
        schema: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    },
    max_output_tokens: 4096,
  };
  const upstream = adapter.buildRequest(request, {
    response_id: "resp-1",
    credential: "zai-key-canary",
    reasoning_effort: "xhigh",
  });
  assert.equal(upstream instanceof Promise, false);
  if (upstream instanceof Promise) {
    throw new Error("unexpected async request");
  }

  assert.equal(
    upstream.url,
    "https://provider.example/api/v1/chat/completions",
  );
  assert.equal(upstream.headers.Authorization, "Bearer zai-key-canary");
  const body = JSON.parse(upstream.body) as Record<string, unknown>;
  assert.equal(upstream.body.includes("zai-key-canary"), false);
  assert.equal(body.model, "provider-model");
  assert.equal(body.reasoning_effort, "xhigh");
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "worker_report",
      strict: true,
      schema: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
    },
  });

  const messages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0], {
    role: "system",
    content: "System contract.\n\nDeveloper contract.",
  });
  assert.deepEqual(messages[1], { role: "user", content: "Do work." });
  assert.deepEqual(messages[2], {
    role: "assistant",
    reasoning_content: "Prior summary.",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "exec_command",
          arguments: "{\"cmd\":\"pwd\"}",
        },
      },
    ],
    content: "",
  });
  assert.deepEqual(messages[3], {
    role: "tool",
    tool_call_id: "call-1",
    content: "ok",
  });

  const tools = body.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  assert.deepEqual(
    (tools[1]?.function as Record<string, unknown>).parameters,
    {
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
  );
});

test("TEST-009 validated_json emits a deterministic instruction and no response_format", () => {
  const adapter = createOpenAIChatAdapter(validatedConfig);
  const request: NormalizedResponsesRequest = {
    model: "provider-model",
    input: [{ type: "message", role: "user", content: "Return a report." }],
    stream: false,
    text: {
      format: {
        type: "json_schema",
        name: "report",
        strict: true,
        schema: {
          required: ["a", "b"],
          properties: {
            b: { type: "number" },
            a: { type: "string" },
          },
          type: "object",
        },
      },
    },
  };
  const upstream = adapter.buildRequest(request, {
    response_id: "resp-validated",
    credential: "environment-canary",
  });
  if (upstream instanceof Promise) {
    throw new Error("unexpected async request");
  }
  const body = JSON.parse(upstream.body) as Record<string, unknown>;
  assert.equal("response_format" in body, false);
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "system");
  assert.match(
    String(messages[0]?.content),
    /Return only one JSON value that validates against this JSON Schema\./,
  );
  assert.match(
    String(messages[0]?.content),
    /"properties":\{"a":\{"type":"string"\},"b":\{"type":"number"\}\}/,
  );
});

test("TEST-008 assembles reasoning, text, interleaved tool fragments, and usage", async () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const request: NormalizedResponsesRequest = {
    model: "provider-model",
    input: [],
    tools: [
      {
        type: "function",
        name: "first_tool",
        parameters: { type: "object" },
      },
      {
        type: "custom",
        name: "second_tool",
      },
    ],
    stream: true,
  };
  const context: AdapterContext = {
    response_id: "resp-stream",
    credential: "secret-stream-value",
    tool_kinds: toolKindsForRequest(request),
  };
  const response = streamResponse([
    {
      id: "chat-1",
      choices: [{ delta: { reasoning_content: "reason " } }],
    },
    {
      id: "chat-1",
      choices: [{ delta: { content: "hello " } }],
    },
    {
      id: "chat-1",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-a",
                function: { name: "first_tool", arguments: "{\"a\":" },
              },
              {
                index: 1,
                id: "call-b",
                function: { name: "second_tool", arguments: "{\"input\":\"" },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chat-1",
      choices: [
        {
          delta: {
            content: "world",
            tool_calls: [
              { id: "call-a", function: { arguments: "1}" } },
              { index: 1, function: { arguments: "patch\"}" } },
            ],
          },
        },
      ],
    },
    {
      id: "chat-1",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    },
    {
      id: "chat-1",
      choices: [],
      usage: {
        prompt_tokens: 10,
        prompt_tokens_details: {
          cached_tokens: 3,
          cache_write_tokens: 2,
        },
        completion_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 17,
      },
    },
    "[DONE]",
  ]);

  const events = await collect(adapter.parseStream(response, context));
  assert.deepEqual(
    events.slice(0, 2).map((event) => event.type),
    ["response_created", "response_in_progress"],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta),
    ["hello ", "world"],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "reasoning_delta")
      .map((event) => event.delta),
    ["reason "],
  );

  const calls = events.filter(
    (event) => event.type === "function_call_arguments_done",
  );
  assert.deepEqual(calls, [
    {
      type: "function_call_arguments_done",
      output_index: 2,
      item_id: "resp-stream_tool_0",
      tool_kind: "function",
      call_id: "call-a",
      name: "first_tool",
      arguments: "{\"a\":1}",
    },
    {
      type: "function_call_arguments_done",
      output_index: 3,
      item_id: "resp-stream_tool_1",
      tool_kind: "custom",
      call_id: "call-b",
      name: "second_tool",
      arguments: "patch",
    },
  ]);
  assert.deepEqual(events.find((event) => event.type === "usage"), {
    type: "usage",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 3,
      cache_write_input_tokens: 2,
      output_tokens: 7,
      reasoning_output_tokens: 4,
      total_tokens: 17,
    },
  });
  const completed = events.at(-1);
  assert.equal(completed?.type, "response_completed");
  if (completed?.type === "response_completed") {
    assert.equal(completed.usage?.total_tokens, 17);
  }
});

test("TEST-008 accepts finish_reason without [DONE] and rejects truncated or malformed streams", async () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const context: AdapterContext = {
    response_id: "resp-terminal",
    credential: "terminal-secret",
  };

  const finishOnly = await collect(
    adapter.parseStream(
      streamResponse([
        {
          choices: [
            { delta: { content: "complete" }, finish_reason: "stop" },
          ],
        },
      ], false),
      context,
    ),
  );
  assert.equal(finishOnly.at(-1)?.type, "response_completed");

  const truncated = await collect(
    adapter.parseStream(
      streamResponse([{ choices: [{ delta: { content: "partial" } }] }], false),
      context,
    ),
  );
  assert.equal(truncated.at(-1)?.type, "response_failed");
  assert.match(failureMessage(truncated), /without \[DONE\]/);

  const malformed = await collect(
    adapter.parseStream(
      new Response("data: {not-json}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      context,
    ),
  );
  assert.equal(malformed.at(-1)?.type, "response_failed");
  assert.match(failureMessage(malformed), /Malformed upstream SSE/);
});

test("TEST-008 rejects malformed or empty upstream tool calls", async () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const context: AdapterContext = {
    response_id: "resp-invalid-tools",
    credential: "invalid-tool-secret",
  };
  const malformedStreams = [
    [
      {
        choices: { unexpected: true },
      },
      "[DONE]",
    ],
    [
      {
        choices: [{ delta: "not-an-object" }],
      },
      "[DONE]",
    ],
    [
      {
        choices: [{ delta: { content: 42 } }],
      },
      "[DONE]",
    ],
    [
      {
        choices: [{ delta: { reasoning_content: [] } }],
      },
      "[DONE]",
    ],
    [
      {
        choices: [{ delta: {}, finish_reason: 42 }],
      },
      "[DONE]",
    ],
    [
      {
        choices: [],
        usage: { prompt_tokens: "many" },
      },
      "[DONE]",
    ],
    [
      {
        choices: [
          {
            delta: { tool_calls: { index: 0 } },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    ],
    [
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: "call-1" }] },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    ],
    [
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    ],
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  function: {
                    name: "tool",
                    arguments: "not-json",
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    ],
  ] as const;
  for (const payloads of malformedStreams) {
    const events = await collect(
      adapter.parseStream(streamResponse(payloads), context),
    );
    assert.equal(events.at(-1)?.type, "response_failed");
    assert.equal(
      events.some((event) => event.type === "response_completed"),
      false,
    );
  }

  const malformedJsonResponses = [
    { choices: { unexpected: true } },
    {
      choices: [
        {
          finish_reason: "stop",
          message: { content: 42 },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: { reasoning_content: [] },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: 42,
          message: { content: "done" },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: { content: "done" },
        },
      ],
      usage: { prompt_tokens: "many" },
    },
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: "", tool_calls: {} },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: "", tool_calls: [] },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "tool", arguments: "not-json" },
              },
            ],
          },
        },
      ],
    },
  ];
  for (const payload of malformedJsonResponses) {
    const events = await adapter.parseResponse(
      Response.json(payload),
      context,
    );
    assert.equal(events.at(-1)?.type, "response_failed");
    assert.equal(
      events.some((event) => event.type === "response_completed"),
      false,
    );
  }
});

test("TEST-011 stream and HTTP errors are bounded and redact known or exact credentials", async () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const exactSecret = "arbitrary-zai-canary-value";
  const upstreamBodyCanary = "upstream-body-canary-not-a-key";
  const context: AdapterContext = {
    response_id: "resp-error",
    credential: exactSecret,
  };
  const inlineError = await collect(
    adapter.parseStream(
      streamResponse([
        {
          error: {
            message: `upstream echoed ${exactSecret}`,
            code: "bad_request",
          },
        },
      ]),
      context,
    ),
  );
  assert.equal(failureMessage(inlineError).includes(exactSecret), false);
  assert.equal(
    failureMessage(inlineError),
    "Upstream provider stream failed",
  );

  const httpError = await collect(
    adapter.parseStream(
      new Response(
        JSON.stringify({
          error: { message: upstreamBodyCanary },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
      context,
    ),
  );
  assert.equal(failureMessage(httpError).includes(upstreamBodyCanary), false);
  const failed = httpError.at(-1);
  assert.equal(failed?.type, "response_failed");
  if (failed?.type === "response_failed") {
    assert.equal(failed.error.status, 401);
    assert.equal(failed.error.retryable, false);
    assert.ok(failed.error.message.length <= 400);
    assert.equal(
      failed.error.message,
      "Upstream provider returned HTTP 401",
    );
  }
});

test("TEST-011 redacts credentials from successful stream and JSON payloads", async () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const credential = "provider-success-canary-value";
  const [first, second] = [
    credential.slice(0, 12),
    credential.slice(12),
  ];
  const context: AdapterContext = {
    response_id: "resp-success-redaction",
    credential,
  };

  const streamEvents = await collect(
    adapter.parseStream(
      streamResponse([
        {
          choices: [
            {
              delta: {
                reasoning_content: `reason:${first}`,
                content: `text:${first}`,
                tool_calls: [
                  {
                    index: 0,
                    id: credential,
                    function: {
                      name: credential,
                      arguments: `{"secret":"${first}`,
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
                reasoning_content: second,
                content: second,
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: `${second}"}` },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ]),
      context,
    ),
  );
  const serializedStream = JSON.stringify(streamEvents);
  assert.equal(serializedStream.includes(credential), false);
  assert.match(serializedStream, /\[REDACTED\]/);

  const splitGenericCredential = "sk-other-secret-canary";
  const genericStreamEvents = await collect(
    adapter.parseStream(
      streamResponse([
        {
          choices: [{ delta: { content: "Bearer sk-" } }],
        },
        {
          choices: [
            {
              delta: { content: "other-secret-canary" },
              finish_reason: "stop",
            },
          ],
        },
        "[DONE]",
      ]),
      {
        response_id: "resp-generic-redaction",
        credential: "different-exact-secret",
      },
    ),
  );
  const serializedGenericStream = JSON.stringify(genericStreamEvents);
  assert.equal(
    serializedGenericStream.includes(`Bearer ${splitGenericCredential}`),
    false,
  );
  assert.equal(serializedGenericStream.includes(splitGenericCredential), false);
  assert.match(serializedGenericStream, /\[REDACTED\]/);

  const jsonEvents = await adapter.parseResponse(
    Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            reasoning_content: `reason:${credential}`,
            content: `text:${credential}`,
            tool_calls: [
              {
                id: credential,
                function: {
                  name: credential,
                  arguments: `{"secret":"${credential}"}`,
                },
              },
            ],
          },
        },
      ],
    }),
    context,
  );
  const serializedJson = JSON.stringify(jsonEvents);
  assert.equal(serializedJson.includes(credential), false);
  assert.match(serializedJson, /\[REDACTED\]/);

  const upstreamErrorCanary = "successful-http-error-body-canary";
  const jsonErrorEvents = await adapter.parseResponse(
    Response.json({
      error: { message: upstreamErrorCanary },
    }),
    context,
  );
  assert.equal(
    JSON.stringify(jsonErrorEvents).includes(upstreamErrorCanary),
    false,
  );
  assert.equal(
    failureMessage(jsonErrorEvents),
    "Upstream provider response failed",
  );
});

test("TEST-008 parses non-stream text, reasoning, multiple tools, usage, and invalid choices", async () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const context: AdapterContext = {
    response_id: "resp-json",
    credential: "json-secret",
    tool_kinds: {
      exec_command: "function",
      apply_patch: "custom",
    },
  };
  const events = await adapter.parseResponse(
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            reasoning_content: "summary",
            content: "done",
            tool_calls: [
              {
                id: "call-1",
                function: {
                  name: "exec_command",
                  arguments: "{\"cmd\":\"pwd\"}",
                },
              },
              {
                id: "call-2",
                function: {
                  name: "apply_patch",
                  arguments: "{\"input\":\"*** Begin Patch\"}",
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 4,
        total_tokens: 9,
      },
    }),
    context,
  );
  assert.deepEqual(
    events.slice(0, 2).map((event) => event.type),
    ["response_created", "response_in_progress"],
  );
  assert.equal(events.at(-1)?.type, "response_completed");
  assert.equal(
    events.filter((event) => event.type === "function_call_arguments_done")
      .length,
    2,
  );
  assert.equal(
    events.find(
      (event) =>
        event.type === "function_call_arguments_done" &&
        event.call_id === "call-2",
    )?.type,
    "function_call_arguments_done",
  );
  const customCall = events.find(
    (event) =>
      event.type === "function_call_arguments_done" &&
      event.call_id === "call-2",
  );
  assert.equal(customCall?.type, "function_call_arguments_done");
  if (customCall?.type === "function_call_arguments_done") {
    assert.equal(customCall.tool_kind, "custom");
    assert.equal(customCall.arguments, "*** Begin Patch");
  }

  const invalid = await adapter.parseResponse(
    Response.json({ choices: [] }),
    context,
  );
  assert.equal(invalid.at(-1)?.type, "response_failed");
  assert.match(failureMessage(invalid), /message choice/);
});

test("TEST-009 fails closed for missing credentials and image input", () => {
  const adapter = createOpenAIChatAdapter(nativeConfig);
  const baseRequest: NormalizedResponsesRequest = {
    model: "provider-model",
    input: [],
    stream: false,
  };
  assert.throws(
    () =>
      adapter.buildRequest(baseRequest, {
        response_id: "resp-no-key",
      }),
    /credential is unavailable/,
  );
  assert.throws(
    () =>
      adapter.buildRequest(
        {
          ...baseRequest,
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: "https://example.test/image.png",
                },
              ],
            },
          ],
        },
        {
          response_id: "resp-image",
          credential: "image-secret",
        },
      ),
    /image input is not enabled/,
  );
});

async function collect(
  events: AsyncIterable<NormalizedResponseEvent>,
): Promise<NormalizedResponseEvent[]> {
  const collected: NormalizedResponseEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function streamResponse(
  payloads: readonly (Record<string, unknown> | string)[],
  trailingNewline = true,
): Response {
  const body = payloads
    .map((payload) =>
      `data: ${
        typeof payload === "string" ? payload : JSON.stringify(payload)
      }\n\n`,
    )
    .join("");
  return new Response(trailingNewline ? body : body.replace(/\n\n$/, ""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function failureMessage(events: readonly NormalizedResponseEvent[]): string {
  const failed = [...events]
    .reverse()
    .find((event) => event.type === "response_failed");
  assert.ok(failed);
  if (failed.type !== "response_failed") {
    throw new Error("unreachable");
  }
  return failed.error.message;
}
