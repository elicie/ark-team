import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";
import { z } from "zod/v4";

import { ArkTeamError } from "./errors.js";
import {
  NATIVE_WORKER_MODEL_BINDING,
  effectiveReasoningEffortSchema,
  externalModelBindingSnapshotV1Schema,
  modelIdSchema,
  modelOverridesSchema,
  providerIdSchema,
  requestedReasoningEffortSchema,
  structuredOutputModeSchema,
  type ExternalModelBindingSnapshotV1,
  type ExternalModelOverride,
  type ResolvedModelBindingV1,
} from "./provider-types.js";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "./verification-contract.js";

const INLINE_KEY_HASH_SENTINEL = "<redacted:inline-key>";
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const BUILTIN_ADAPTER_IDS = [
  "builtin:openai-chat",
  "builtin:anthropic",
  "builtin:google",
  "builtin:openai-responses",
] as const;

const builtinAdapterReferenceSchema = z.enum(BUILTIN_ADAPTER_IDS);
const customAdapterReferenceSchema = z
  .string()
  .regex(/^custom:[a-z][a-z0-9_]{0,62}$/);
const adapterReferenceSchema = z.union([
  builtinAdapterReferenceSchema,
  customAdapterReferenceSchema,
]);

const baseUrlSchema = z.string().min(1).max(2_048);
const apiKeyEnvironmentSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(ENVIRONMENT_NAME_PATTERN);
const inlineApiKeySchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.includes("\r") &&
      !value.includes("\n") &&
      !value.includes("\0"),
    "inline API key contains forbidden whitespace or control characters",
  );
const policySchema = z.enum(["standard", "blocked"]);
const reasoningEffortMapSchema = z
  .partialRecord(
    requestedReasoningEffortSchema,
    effectiveReasoningEffortSchema,
  )
  .default({});
const allowedModelsSchema = z
  .array(modelIdSchema)
  .min(1)
  .max(1_000)
  .superRefine((models, context) => {
    if (new Set(models).size !== models.length) {
      context.addIssue({
        code: "custom",
        message: "allowed_models contains duplicates",
      });
    }
  });

const commonProviderFields = {
  adapter: adapterReferenceSchema,
  base_url: baseUrlSchema,
  allow_private_network: z.boolean().default(false),
  structured_output_mode: structuredOutputModeSchema,
  policy: policySchema,
  allowed_models: allowedModelsSchema.optional(),
  reasoning_effort_map: reasoningEffortMapSchema,
} as const;

const inlineProviderSchema = z
  .object({
    ...commonProviderFields,
    auth_kind: z.literal("inline_key"),
    api_key: inlineApiKeySchema,
  })
  .strict();
const environmentProviderSchema = z
  .object({
    ...commonProviderFields,
    auth_kind: z.literal("env_key"),
    api_key_env: apiKeyEnvironmentSchema,
  })
  .strict();
const unauthenticatedProviderSchema = z
  .object({
    ...commonProviderFields,
    auth_kind: z.literal("none"),
  })
  .strict();

const rawProviderSchema = z
  .discriminatedUnion("auth_kind", [
    inlineProviderSchema,
    environmentProviderSchema,
    unauthenticatedProviderSchema,
  ])
  .superRefine((provider, context) => {
    const problem = validateBaseUrl(
      provider.base_url,
      provider.allow_private_network,
    );
    if (problem !== null) {
      context.addIssue({
        code: "custom",
        path: ["base_url"],
        message: problem,
      });
    }
  });

const customAdapterConfigSchema = z
  .object({
    module: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) => path.isAbsolute(value) && !value.includes("\0"),
        "custom adapter module must be an absolute path",
      ),
    export: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
    api_version: z.literal(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const rawCatalogSchema = z
  .object({
    version: z.literal(1),
    providers: z.record(providerIdSchema, rawProviderSchema),
    adapters: z
      .record(
        z.string().regex(ADAPTER_ID_PATTERN),
        customAdapterConfigSchema,
      )
      .default({}),
  })
  .strict()
  .superRefine((catalog, context) => {
    for (const [providerId, provider] of Object.entries(
      catalog.providers,
    )) {
      if (!provider.adapter.startsWith("custom:")) {
        continue;
      }
      const adapterId = provider.adapter.slice("custom:".length);
      if (!(adapterId in catalog.adapters)) {
        context.addIssue({
          code: "custom",
          path: ["providers", providerId, "adapter"],
          message: "custom adapter is not registered",
        });
      }
    }
  });

type RawCatalogV1 = z.infer<typeof rawCatalogSchema>;
type RawProviderConfigV1 = z.infer<typeof rawProviderSchema>;

const safeInlineProviderSchema = z
  .object({
    ...commonProviderFields,
    auth_kind: z.literal("inline_key"),
  })
  .strict();
const safeEnvironmentProviderSchema = z
  .object({
    ...commonProviderFields,
    auth_kind: z.literal("env_key"),
    api_key_env: apiKeyEnvironmentSchema,
  })
  .strict();
const safeUnauthenticatedProviderSchema = z
  .object({
    ...commonProviderFields,
    auth_kind: z.literal("none"),
  })
  .strict();

export const safeProviderConfigV1Schema = z.discriminatedUnion(
  "auth_kind",
  [
    safeInlineProviderSchema,
    safeEnvironmentProviderSchema,
    safeUnauthenticatedProviderSchema,
  ],
);

export type SafeProviderConfigV1 = z.infer<
  typeof safeProviderConfigV1Schema
>;

export const safeProviderCatalogV1Schema = z
  .object({
    version: z.literal(1),
    providers: z.record(providerIdSchema, safeProviderConfigV1Schema),
    adapters: z.record(
      z.string().regex(ADAPTER_ID_PATTERN),
      customAdapterConfigSchema,
    ),
  })
  .strict();

export type SafeProviderCatalogV1 = z.infer<
  typeof safeProviderCatalogV1Schema
>;

export const providerCatalogSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    source_path: z.string().min(1).refine(path.isAbsolute),
    provider_config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    catalog: safeProviderCatalogV1Schema,
  })
  .strict();

export type ProviderCatalogSnapshot = z.infer<
  typeof providerCatalogSnapshotSchema
>;

export interface ProviderConfigRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  builtin_openai_chat_adapter_path?: string;
}

interface LoadedCatalogDocument {
  source_path: string;
  raw_catalog: RawCatalogV1;
  safe_catalog: SafeProviderCatalogV1;
  provider_config_sha256: string;
}

export async function loadProviderCatalogSnapshot(
  options: ProviderConfigRuntimeOptions = {},
): Promise<ProviderCatalogSnapshot> {
  const loaded = await loadCatalogDocument(options);
  return providerCatalogSnapshotSchema.parse({
    schema_version: 1,
    source_path: loaded.source_path,
    provider_config_sha256: loaded.provider_config_sha256,
    catalog: loaded.safe_catalog,
  });
}

export async function resolveRunWorkerBinding(
  modelOverrides: unknown,
  options: ProviderConfigRuntimeOptions = {},
): Promise<ResolvedModelBindingV1> {
  const parsedOverrides = modelOverridesSchema.safeParse(
    modelOverrides ?? {},
  );
  if (!parsedOverrides.success) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "model_overrides does not match the safe worker override schema",
    );
  }
  if (parsedOverrides.data.worker === undefined) {
    return NATIVE_WORKER_MODEL_BINDING;
  }

  const snapshot = await loadProviderCatalogSnapshot(options);
  return resolveExternalWorkerBinding(
    snapshot,
    parsedOverrides.data.worker,
    options,
  );
}

export async function resolveProviderCredential(
  snapshot: ProviderCatalogSnapshot,
  providerId: string,
  options: ProviderConfigRuntimeOptions = {},
): Promise<string | null> {
  const parsedSnapshot = providerCatalogSnapshotSchema.safeParse(snapshot);
  if (!parsedSnapshot.success || !providerIdSchema.safeParse(providerId).success) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_INVALID",
      "provider credential request is invalid",
    );
  }

  const current = await loadCatalogDocument(options);
  if (
    current.provider_config_sha256 !==
    parsedSnapshot.data.provider_config_sha256
  ) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_DRIFT",
      "provider catalog changed after the model binding was selected",
    );
  }
  const provider = current.raw_catalog.providers[providerId];
  if (provider === undefined) {
    throw new ArkTeamError(
      "PROVIDER_NOT_FOUND",
      `provider is not present in the current catalog: ${providerId}`,
    );
  }
  assertProviderPolicy(providerId, provider);

  if (provider.auth_kind === "none") {
    return null;
  }
  if (provider.auth_kind === "inline_key") {
    return provider.api_key;
  }

  const environment = options.environment ?? process.env;
  const credential = environment[provider.api_key_env];
  if (
    credential === undefined ||
    credential.length === 0 ||
    credential.trim().length === 0
  ) {
    throw new ArkTeamError(
      "PROVIDER_CREDENTIAL_MISSING",
      `provider credential is unavailable: ${providerId}`,
    );
  }
  return credential;
}

export async function assertExternalBindingCurrent(
  binding: ExternalModelBindingSnapshotV1,
  options: ProviderConfigRuntimeOptions = {},
): Promise<void> {
  const parsedBinding =
    externalModelBindingSnapshotV1Schema.safeParse(binding);
  if (!parsedBinding.success) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_DRIFT",
      "persisted external model binding is invalid",
    );
  }

  const snapshot = await loadProviderCatalogSnapshot(options);
  if (
    snapshot.provider_config_sha256 !==
    parsedBinding.data.provider_config_sha256
  ) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_DRIFT",
      "provider catalog changed after the model binding was selected",
    );
  }

  const currentBinding = await resolveExternalWorkerBinding(
    snapshot,
    {
      provider: parsedBinding.data.provider_id,
      model: parsedBinding.data.model,
      reasoning_effort:
        parsedBinding.data.requested_reasoning_effort,
    },
    options,
  );
  if (canonicalJson(currentBinding) !== canonicalJson(parsedBinding.data)) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_DRIFT",
      "provider catalog no longer resolves to the persisted model binding",
    );
  }
}

export async function resolveProviderSensitiveEnvironmentNames(
  binding: ResolvedModelBindingV1,
  options: ProviderConfigRuntimeOptions = {},
): Promise<string[]> {
  if (binding.kind === "native") {
    return [];
  }
  await assertExternalBindingCurrent(binding, options);
  const snapshot = await loadProviderCatalogSnapshot(options);
  return [
    ...new Set(
      Object.values(snapshot.catalog.providers).flatMap((provider) =>
        provider.auth_kind === "env_key"
          ? [provider.api_key_env]
          : [],
      ),
    ),
  ].sort();
}

async function resolveExternalWorkerBinding(
  snapshot: ProviderCatalogSnapshot,
  override: ExternalModelOverride,
  options: ProviderConfigRuntimeOptions,
): Promise<ExternalModelBindingSnapshotV1> {
  const provider = snapshot.catalog.providers[override.provider];
  if (provider === undefined) {
    throw new ArkTeamError(
      "PROVIDER_NOT_FOUND",
      `provider is not present in the catalog: ${override.provider}`,
    );
  }
  assertProviderPolicy(override.provider, provider);

  if (provider.adapter !== "builtin:openai-chat") {
    throw new ArkTeamError(
      "ADAPTER_NOT_FOUND",
      `selected provider adapter is not available in this slice: ${provider.adapter}`,
    );
  }
  if (
    provider.allowed_models !== undefined &&
    !provider.allowed_models.includes(override.model)
  ) {
    throw new ArkTeamError(
      "PROVIDER_CAPABILITY_UNSUPPORTED",
      `model is not allowed for provider ${override.provider}`,
    );
  }
  const effectiveEffort =
    provider.reasoning_effort_map[override.reasoning_effort];
  if (effectiveEffort === undefined) {
    throw new ArkTeamError(
      "PROVIDER_CAPABILITY_UNSUPPORTED",
      `reasoning effort is not mapped for provider ${override.provider}`,
    );
  }

  await resolveProviderCredential(
    snapshot,
    override.provider,
    options,
  );
  const adapterSha256 = await resolveBuiltinAdapterSha256(
    provider.adapter,
    options,
  );

  return externalModelBindingSnapshotV1Schema.parse({
    schema_version: 1,
    kind: "external",
    provider_id: override.provider,
    app_server_provider_id: `ark_${override.provider}`,
    adapter_id: provider.adapter,
    adapter_api_version: 1,
    adapter_sha256: adapterSha256,
    provider_config_sha256: snapshot.provider_config_sha256,
    model: override.model,
    requested_reasoning_effort: override.reasoning_effort,
    effective_reasoning_effort: effectiveEffort,
    structured_output_mode: provider.structured_output_mode,
  });
}

async function resolveBuiltinAdapterSha256(
  adapterId: "builtin:openai-chat",
  options: ProviderConfigRuntimeOptions,
): Promise<string> {
  const configuredPath = options.builtin_openai_chat_adapter_path;
  if (configuredPath !== undefined && !path.isAbsolute(configuredPath)) {
    throw new ArkTeamError(
      "ADAPTER_NOT_FOUND",
      "builtin adapter artifact path must be absolute",
    );
  }
  const candidates: readonly (string | URL)[] =
    configuredPath === undefined
      ? [
          new URL("./adapters/openai-chat.js", import.meta.url),
          new URL("./adapters/openai-chat.ts", import.meta.url),
        ]
      : [configuredPath];
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(candidate);
      return createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        configuredPath === undefined
      ) {
        continue;
      }
      throw new ArkTeamError(
        "ADAPTER_NOT_FOUND",
        `builtin adapter artifact is unavailable: ${adapterId}`,
      );
    }
  }
  throw new ArkTeamError(
    "ADAPTER_NOT_FOUND",
    `builtin adapter artifact is unavailable: ${adapterId}`,
  );
}

async function loadCatalogDocument(
  options: ProviderConfigRuntimeOptions,
): Promise<LoadedCatalogDocument> {
  const environment = options.environment ?? process.env;
  const configuredPath = environment.ARK_TEAM_PROVIDER_CONFIG;
  if (
    configuredPath === undefined ||
    configuredPath.trim().length === 0
  ) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_UNAVAILABLE",
      "ARK_TEAM_PROVIDER_CONFIG is required for an external model override",
    );
  }
  const requestedPath = configuredPath.trim();
  if (
    !path.isAbsolute(requestedPath) ||
    requestedPath.includes("\0")
  ) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_INVALID",
      "ARK_TEAM_PROVIDER_CONFIG must be an absolute path",
    );
  }

  let sourcePath: string;
  let text: string;
  let fileStats: Stats;
  try {
    sourcePath = await realpath(requestedPath);
    const file = await open(sourcePath, "r");
    try {
      fileStats = await file.stat();
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_UNAVAILABLE",
      "provider catalog cannot be read",
    );
  }

  let parsedToml: unknown;
  try {
    parsedToml = parse(text);
  } catch {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_INVALID",
      "provider catalog is not valid TOML",
    );
  }
  const parsedCatalog = rawCatalogSchema.safeParse(parsedToml);
  if (!parsedCatalog.success) {
    throw new ArkTeamError(
      "PROVIDER_CONFIG_INVALID",
      "provider catalog does not match the strict version 1 schema",
    );
  }

  if (
    Object.values(parsedCatalog.data.providers).some(
      (provider) => provider.auth_kind === "inline_key",
    )
  ) {
    await assertInlineCatalogPermissions(sourcePath, fileStats);
  }

  const safeCatalog = projectSafeCatalog(parsedCatalog.data);
  return {
    source_path: sourcePath,
    raw_catalog: parsedCatalog.data,
    safe_catalog: safeCatalog,
    provider_config_sha256: sha256CanonicalJson(
      projectRedactedCatalog(parsedCatalog.data),
    ),
  };
}

function projectSafeCatalog(
  catalog: RawCatalogV1,
): SafeProviderCatalogV1 {
  const providers: Record<string, SafeProviderConfigV1> = {};
  for (const [providerId, provider] of Object.entries(
    catalog.providers,
  )) {
    const common = {
      adapter: provider.adapter,
      base_url: provider.base_url,
      allow_private_network: provider.allow_private_network,
      structured_output_mode: provider.structured_output_mode,
      policy: provider.policy,
      ...(provider.allowed_models === undefined
        ? {}
        : { allowed_models: [...provider.allowed_models] }),
      reasoning_effort_map: {
        ...provider.reasoning_effort_map,
      },
    };
    providers[providerId] =
      provider.auth_kind === "env_key"
        ? {
            ...common,
            auth_kind: "env_key",
            api_key_env: provider.api_key_env,
          }
        : provider.auth_kind === "inline_key"
          ? {
              ...common,
              auth_kind: "inline_key",
            }
          : {
              ...common,
              auth_kind: "none",
            };
  }
  return safeProviderCatalogV1Schema.parse({
    version: catalog.version,
    providers,
    adapters: catalog.adapters,
  });
}

function projectRedactedCatalog(catalog: RawCatalogV1): unknown {
  return {
    version: catalog.version,
    providers: Object.fromEntries(
      Object.entries(catalog.providers).map(
        ([providerId, provider]) => [
          providerId,
          provider.auth_kind === "inline_key"
            ? {
                ...provider,
                api_key: INLINE_KEY_HASH_SENTINEL,
              }
            : provider,
        ],
      ),
    ),
    adapters: catalog.adapters,
  };
}

async function assertInlineCatalogPermissions(
  sourcePath: string,
  fileStats: Stats,
): Promise<void> {
  const currentUserId = process.getuid?.();
  if (currentUserId === undefined) {
    throw insecurePermissions();
  }

  try {
    const directoryStats = await stat(path.dirname(sourcePath));
    if (
      !fileStats.isFile() ||
      fileStats.uid !== currentUserId ||
      (fileStats.mode & 0o077) !== 0 ||
      !directoryStats.isDirectory() ||
      directoryStats.uid !== currentUserId ||
      (directoryStats.mode & 0o077) !== 0
    ) {
      throw insecurePermissions();
    }
  } catch (error) {
    if (
      error instanceof ArkTeamError &&
      error.code === "PROVIDER_CONFIG_INSECURE_PERMISSIONS"
    ) {
      throw error;
    }
    throw insecurePermissions();
  }
}

function assertProviderPolicy(
  providerId: string,
  provider: Pick<RawProviderConfigV1, "policy">,
): void {
  if (provider.policy === "blocked") {
    throw new ArkTeamError(
      "PROVIDER_POLICY_BLOCKED",
      `provider policy blocks live activation: ${providerId}`,
    );
  }
}

function validateBaseUrl(
  rawUrl: string,
  allowPrivateNetwork: boolean,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "base_url must be an absolute URL";
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.search.length > 0
  ) {
    return "base_url must not contain credentials, query, or fragment";
  }
  if (parsed.protocol === "https:") {
    return null;
  }
  if (
    parsed.protocol === "http:" &&
    allowPrivateNetwork &&
    isPrivateOrLocalHostname(parsed.hostname)
  ) {
    return null;
  }
  return "base_url must use HTTPS unless private HTTP is explicitly allowed";
}

function isPrivateOrLocalHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (!hostname.includes(".") && !hostname.includes(":"))
  ) {
    return true;
  }
  if (
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe8") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb")
  ) {
    return true;
  }
  const octets = hostname.split(".").map((value) => Number(value));
  if (
    octets.length !== 4 ||
    octets.some(
      (value) =>
        !Number.isInteger(value) || value < 0 || value > 255,
    )
  ) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function insecurePermissions(): ArkTeamError {
  return new ArkTeamError(
    "PROVIDER_CONFIG_INSECURE_PERMISSIONS",
    "inline-key provider catalog and its directory must be owner-only",
  );
}
