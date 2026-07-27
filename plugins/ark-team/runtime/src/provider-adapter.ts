/*!
 * Portions of this contract are adapted from OpenCodex v2.7.41
 * (commit ac73f189cf7e3f4ee55690ed8dc7e354b7e6ed10),
 * originally src/adapters/base.ts and directly required shared types.
 * OpenCodex is MIT licensed; see ../../LICENSES/OpenCodex-MIT.txt.
 *
 * Ark Team owns this API and its normalized Responses semantics. It is not an
 * import of, or compatibility promise for, OpenCodex package internals.
 */

export type ProviderAuthKind = "inline_key" | "env_key" | "none";
export type StructuredOutputMode =
  | "native_json_schema"
  | "validated_json";
export type NormalizedToolKind = "function" | "custom";

export interface SafeProviderConfig {
  readonly adapter: string;
  readonly base_url: string;
  readonly auth_kind: ProviderAuthKind;
  readonly structured_output_mode: StructuredOutputMode;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly parallel_tools: boolean;
  readonly reasoning: boolean;
  readonly images: boolean;
  readonly structured_output:
    | "native_json_schema"
    | "validated_json"
    | "unsupported";
}

export interface AdapterContext {
  /**
   * Bridge-owned response identity. Adapters derive deterministic output item
   * IDs from it but do not persist or log it.
   */
  readonly response_id: string;
  /**
   * Request-time upstream credential. The bridge owns its lifecycle; adapters
   * may place it only in the returned upstream Authorization header.
   */
  readonly credential?: string | null;
  readonly reasoning_effort?: string;
  readonly signal?: AbortSignal;
  readonly tool_kinds?: Readonly<Record<string, NormalizedToolKind>>;
  /**
   * Called when upstream streaming bytes arrive, including frames that do not
   * yet produce a normalized event (for example partial tool arguments).
   */
  readonly on_stream_activity?: () => void;
}

export type NormalizedContentPart =
  | {
      readonly type: "input_text" | "output_text" | "text";
      readonly text: string;
    }
  | {
      readonly type: "input_image";
      readonly image_url: string;
      readonly detail?: "auto" | "low" | "high" | "original";
    };

export type NormalizedContent =
  | string
  | readonly NormalizedContentPart[];

export type NormalizedResponseInputItem =
  | {
      readonly type: "message";
      readonly role: "system" | "developer" | "user" | "assistant";
      readonly content: NormalizedContent;
    }
  | {
      readonly type: "reasoning";
      readonly summary?: readonly {
        readonly type: "summary_text";
        readonly text: string;
      }[];
      readonly content?: readonly {
        readonly type: "reasoning_text";
        readonly text: string;
      }[];
    }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "function_call_output";
      readonly call_id: string;
      readonly output: NormalizedContent;
    }
  | {
      readonly type: "custom_tool_call";
      readonly call_id: string;
      readonly name: string;
      readonly input: string;
    }
  | {
      readonly type: "custom_tool_call_output";
      readonly call_id: string;
      readonly output: NormalizedContent;
    };

export type NormalizedTool =
  | {
      readonly type: "function";
      readonly name: string;
      readonly description?: string;
      readonly parameters: Record<string, unknown>;
      readonly strict?: boolean;
    }
  | {
      readonly type: "custom";
      readonly name: string;
      readonly description?: string;
    };

export type NormalizedToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      readonly type: NormalizedToolKind;
      readonly name: string;
    };

export type NormalizedTextFormat =
  | {
      readonly type: "text";
    }
  | {
      readonly type: "json_object";
    }
  | {
      readonly type: "json_schema";
      readonly name: string;
      readonly schema: Record<string, unknown>;
      readonly strict: boolean;
    };

export interface NormalizedResponsesRequest {
  readonly model: string;
  readonly instructions?: string;
  readonly input: readonly NormalizedResponseInputItem[];
  readonly tools?: readonly NormalizedTool[];
  readonly tool_choice?: NormalizedToolChoice;
  readonly parallel_tool_calls?: boolean;
  readonly reasoning?: {
    readonly effort?: string;
  };
  readonly stream: boolean;
  readonly text?: {
    readonly format?: NormalizedTextFormat;
    readonly verbosity?: "low" | "medium" | "high";
  };
  readonly max_output_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop?: string | readonly string[];
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
}

export interface UpstreamRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export interface NormalizedUsage {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
  readonly total_tokens: number;
}

export interface NormalizedProviderError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly retryable: boolean;
}

export type NormalizedOutputItem =
  | {
      readonly type: "message";
      readonly id: string;
      readonly role: "assistant";
      readonly text: string;
    }
  | {
      readonly type: "reasoning";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly tool_kind: NormalizedToolKind;
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    };

export type NormalizedResponseEvent =
  | {
      readonly type: "response_created";
      readonly response_id: string;
    }
  | {
      readonly type: "response_in_progress";
      readonly response_id: string;
    }
  | {
      readonly type: "output_item_added";
      readonly output_index: number;
      readonly item: NormalizedOutputItem;
    }
  | {
      readonly type: "text_delta";
      readonly output_index: number;
      readonly item_id: string;
      readonly content_index: 0;
      readonly delta: string;
    }
  | {
      readonly type: "text_done";
      readonly output_index: number;
      readonly item_id: string;
      readonly content_index: 0;
      readonly text: string;
    }
  | {
      readonly type: "reasoning_delta";
      readonly output_index: number;
      readonly item_id: string;
      readonly content_index: 0;
      readonly delta: string;
    }
  | {
      readonly type: "reasoning_done";
      readonly output_index: number;
      readonly item_id: string;
      readonly content_index: 0;
      readonly text: string;
    }
  | {
      readonly type: "function_call_arguments_delta";
      readonly output_index: number;
      readonly item_id: string;
      readonly call_id: string;
      readonly delta: string;
    }
  | {
      readonly type: "function_call_arguments_done";
      readonly output_index: number;
      readonly item_id: string;
      readonly tool_kind: NormalizedToolKind;
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "output_item_done";
      readonly output_index: number;
      readonly item: NormalizedOutputItem;
    }
  | {
      readonly type: "usage";
      readonly usage: NormalizedUsage;
    }
  | {
      readonly type: "response_completed";
      readonly response_id: string;
      readonly usage?: NormalizedUsage;
    }
  | {
      readonly type: "response_incomplete";
      readonly response_id: string;
      readonly reason: string;
      readonly usage?: NormalizedUsage;
    }
  | {
      readonly type: "response_failed";
      readonly response_id: string;
      readonly error: NormalizedProviderError;
      readonly usage?: NormalizedUsage;
    };

export interface ProviderAdapterV1 {
  readonly apiVersion: 1;
  readonly id: string;

  capabilities(config: SafeProviderConfig): ProviderCapabilities;
  validateConfig(config: SafeProviderConfig): void;

  buildRequest(
    request: NormalizedResponsesRequest,
    context: AdapterContext,
  ): UpstreamRequest | Promise<UpstreamRequest>;

  parseStream(
    response: Response,
    context: AdapterContext,
  ): AsyncIterable<NormalizedResponseEvent>;

  parseResponse(
    response: Response,
    context: AdapterContext,
  ): Promise<NormalizedResponseEvent[]>;

  formatError(
    status: number,
    headers: Headers,
    body: string,
  ): NormalizedProviderError;
}

export function toolKindsForRequest(
  request: Pick<NormalizedResponsesRequest, "tools">,
): Readonly<Record<string, NormalizedToolKind>> {
  return Object.freeze(
    Object.fromEntries(
      (request.tools ?? []).map((tool) => [tool.name, tool.type]),
    ),
  );
}
