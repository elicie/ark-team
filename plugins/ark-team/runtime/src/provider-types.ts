import { z } from "zod/v4";

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const APP_SERVER_PROVIDER_ID_PATTERN =
  /^ark_[a-z][a-z0-9_]{0,62}$/;

export const providerIdSchema = z.string().regex(PROVIDER_ID_PATTERN);

export const modelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value === value.trim() &&
      !/[\u0000-\u001f\u007f\s]/u.test(value),
    "model ID must not contain whitespace or control characters",
  );

export const requestedReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type RequestedReasoningEffort = z.infer<
  typeof requestedReasoningEffortSchema
>;

export const effectiveReasoningEffortSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      value === value.trim() &&
      !/[\u0000-\u001f\u007f\s]/u.test(value),
    "effective reasoning effort must not contain whitespace or control characters",
  );

export const structuredOutputModeSchema = z.enum([
  "native_json_schema",
  "validated_json",
]);

export type StructuredOutputMode = z.infer<
  typeof structuredOutputModeSchema
>;

export const externalModelOverrideSchema = z
  .object({
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning_effort: requestedReasoningEffortSchema,
  })
  .strict();

export type ExternalModelOverride = z.infer<
  typeof externalModelOverrideSchema
>;

export const modelOverridesSchema = z
  .object({
    worker: externalModelOverrideSchema.optional(),
  })
  .strict();

export type ModelOverrides = z.infer<typeof modelOverridesSchema>;

export const nativeModelBindingSnapshotV1Schema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("native"),
    provider_id: z.literal("openai"),
    model: modelIdSchema,
    requested_reasoning_effort: requestedReasoningEffortSchema,
    effective_reasoning_effort: effectiveReasoningEffortSchema,
  })
  .strict();

export type NativeModelBindingSnapshotV1 = z.infer<
  typeof nativeModelBindingSnapshotV1Schema
>;

const adapterIdSchema = z
  .string()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      /^builtin:(?:openai-chat|anthropic|google|openai-responses)$/.test(
        value,
      ) || /^custom:[a-z][a-z0-9_]{0,62}$/.test(value),
    "invalid adapter ID",
  );

export const externalModelBindingSnapshotV1Schema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("external"),
    provider_id: providerIdSchema,
    app_server_provider_id: z
      .string()
      .regex(APP_SERVER_PROVIDER_ID_PATTERN),
    adapter_id: adapterIdSchema,
    adapter_api_version: z.literal(1),
    adapter_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    provider_config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    model: modelIdSchema,
    requested_reasoning_effort: requestedReasoningEffortSchema,
    effective_reasoning_effort: effectiveReasoningEffortSchema,
    structured_output_mode: structuredOutputModeSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (
      binding.app_server_provider_id !== `ark_${binding.provider_id}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["app_server_provider_id"],
        message: "app-server provider ID does not match provider_id",
      });
    }
    if (
      binding.adapter_id.startsWith("builtin:") &&
      binding.adapter_sha256 === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapter_sha256"],
        message: "builtin adapters require a revision hash",
      });
    }
    if (
      binding.adapter_id.startsWith("custom:") &&
      binding.adapter_sha256 === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapter_sha256"],
        message: "custom adapters require a module hash",
      });
    }
  });

export type ExternalModelBindingSnapshotV1 = z.infer<
  typeof externalModelBindingSnapshotV1Schema
>;

export const resolvedModelBindingV1Schema = z.discriminatedUnion("kind", [
  nativeModelBindingSnapshotV1Schema,
  externalModelBindingSnapshotV1Schema,
]);

export type ResolvedModelBindingV1 = z.infer<
  typeof resolvedModelBindingV1Schema
>;

export function createNativeModelBinding(
  model: string,
  reasoningEffort: RequestedReasoningEffort,
): NativeModelBindingSnapshotV1 {
  return nativeModelBindingSnapshotV1Schema.parse({
    schema_version: 1,
    kind: "native",
    provider_id: "openai",
    model,
    requested_reasoning_effort: reasoningEffort,
    effective_reasoning_effort: reasoningEffort,
  });
}

export const NATIVE_WORKER_MODEL_BINDING: NativeModelBindingSnapshotV1 =
  Object.freeze(createNativeModelBinding("gpt-5.6-luna", "xhigh"));
