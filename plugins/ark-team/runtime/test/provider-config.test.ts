import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import {
  assertExternalBindingCurrent,
  loadProviderCatalogSnapshot,
  resolveProviderCredential,
  resolveProviderSensitiveEnvironmentNames,
  resolveRunWorkerBinding,
} from "../src/provider-config.js";
import {
  NATIVE_WORKER_MODEL_BINDING,
  externalModelBindingSnapshotV1Schema,
  modelOverridesSchema,
} from "../src/provider-types.js";

const INLINE_CANARY = "inline-canary-do-not-persist";
const ROTATED_INLINE_CANARY = "rotated-inline-canary-do-not-persist";
const ENV_CANARY = "environment-canary-do-not-persist";

test("provider model schemas keep native defaults and reject secret-bearing overrides", async () => {
  assert.deepEqual(
    await resolveRunWorkerBinding(undefined, { environment: {} }),
    NATIVE_WORKER_MODEL_BINDING,
  );
  assert.deepEqual(
    await resolveProviderSensitiveEnvironmentNames(
      NATIVE_WORKER_MODEL_BINDING,
      {
        environment: {
          ARK_TEAM_PROVIDER_CONFIG:
            "native-path-must-not-read-catalog",
        },
      },
    ),
    [],
  );
  assert.equal(
    modelOverridesSchema.safeParse({
      worker: {
        provider: "company_ai",
        model: "model-1",
        reasoning_effort: "high",
        api_key: INLINE_CANARY,
      },
    }).success,
    false,
  );
  const error = await rejectedError(
    resolveRunWorkerBinding(
      {
        worker: {
          provider: "company_ai",
          model: "model-1",
          reasoning_effort: "high",
          api_key: INLINE_CANARY,
        },
      },
      { environment: {} },
    ),
  );
  assert.equal(error.code, "INVALID_INPUT");
  assert.equal(error.message.includes(INLINE_CANARY), false);

  assert.equal(
    externalModelBindingSnapshotV1Schema.safeParse({
      schema_version: 1,
      kind: "external",
      provider_id: "company_ai",
      app_server_provider_id: "ark_another_provider",
      adapter_id: "builtin:openai-chat",
      adapter_api_version: 1,
      adapter_sha256: null,
      provider_config_sha256: "a".repeat(64),
      model: "model-1",
      requested_reasoning_effort: "high",
      effective_reasoning_effort: "high",
      structured_output_mode: "validated_json",
    }).success,
    false,
  );
});

test("inline credentials stay out of safe snapshots and key-only rotation preserves the hash", async () => {
  await withCatalog(
    inlineCatalog(INLINE_CANARY),
    async ({ catalogPath, environment }) => {
      const snapshot = await loadProviderCatalogSnapshot({ environment });
      const serialized = JSON.stringify(snapshot);
      assert.match(snapshot.provider_config_sha256, /^[a-f0-9]{64}$/);
      assert.equal(serialized.includes(INLINE_CANARY), false);
      assert.equal(serialized.includes("api_key"), false);
      assert.deepEqual(
        Object.keys(snapshot.catalog.providers.company_ai ?? {}).sort(),
        [
          "adapter",
          "allow_private_network",
          "allowed_models",
          "auth_kind",
          "base_url",
          "policy",
          "reasoning_effort_map",
          "structured_output_mode",
        ].sort(),
      );

      const binding = await resolveRunWorkerBinding(
        {
          worker: {
            provider: "company_ai",
            model: "model-1",
            reasoning_effort: "xhigh",
          },
        },
        { environment },
      );
      assert.equal(binding.kind, "external");
      if (binding.kind !== "external") {
        return;
      }
      assert.match(binding.adapter_sha256 ?? "", /^[a-f0-9]{64}$/);
      assert.deepEqual(
        {
          provider_id: binding.provider_id,
          app_server_provider_id: binding.app_server_provider_id,
          adapter_id: binding.adapter_id,
          model: binding.model,
          requested: binding.requested_reasoning_effort,
          effective: binding.effective_reasoning_effort,
          structured: binding.structured_output_mode,
        },
        {
          provider_id: "company_ai",
          app_server_provider_id: "ark_company_ai",
          adapter_id: "builtin:openai-chat",
          model: "model-1",
          requested: "xhigh",
          effective: "max",
          structured: "validated_json",
        },
      );
      assert.equal(
        await resolveProviderCredential(
          snapshot,
          "company_ai",
          { environment },
        ),
        INLINE_CANARY,
      );

      await writeFile(
        catalogPath,
        inlineCatalog(ROTATED_INLINE_CANARY),
        "utf8",
      );
      const rotated = await loadProviderCatalogSnapshot({ environment });
      assert.equal(
        rotated.provider_config_sha256,
        snapshot.provider_config_sha256,
      );
      assert.equal(
        await resolveProviderCredential(
          snapshot,
          "company_ai",
          { environment },
        ),
        ROTATED_INLINE_CANARY,
      );
      await assertExternalBindingCurrent(binding, { environment });

      await writeFile(
        catalogPath,
        inlineCatalog(
          ROTATED_INLINE_CANARY,
          "https://changed.example.invalid/v1",
        ),
        "utf8",
      );
      const changed = await loadProviderCatalogSnapshot({ environment });
      assert.notEqual(
        changed.provider_config_sha256,
        snapshot.provider_config_sha256,
      );
      const drift = await rejectedError(
        assertExternalBindingCurrent(binding, { environment }),
      );
      assert.equal(drift.code, "PROVIDER_CONFIG_DRIFT");
      assert.equal(drift.message.includes(ROTATED_INLINE_CANARY), false);
    },
  );
});

test("TEST-004 builtin adapter byte changes invalidate the persisted binding", async () => {
  await withCatalog(
    inlineCatalog(INLINE_CANARY),
    async ({ catalogDirectory, environment }) => {
      const adapterPath = path.join(
        catalogDirectory,
        "openai-chat-adapter.js",
      );
      await writeFile(adapterPath, "adapter revision one\n", "utf8");
      const options = {
        environment,
        builtin_openai_chat_adapter_path: adapterPath,
      };
      const binding = await resolveRunWorkerBinding(
        {
          worker: {
            provider: "company_ai",
            model: "model-1",
            reasoning_effort: "xhigh",
          },
        },
        options,
      );
      assert.equal(binding.kind, "external");
      if (binding.kind !== "external") {
        return;
      }
      assert.match(binding.adapter_sha256 ?? "", /^[a-f0-9]{64}$/);
      await assertExternalBindingCurrent(binding, options);

      await writeFile(adapterPath, "adapter revision two\n", "utf8");
      const drift = await rejectedError(
        assertExternalBindingCurrent(binding, options),
      );
      assert.equal(drift.code, "PROVIDER_CONFIG_DRIFT");
      assert.match(drift.message, /persisted model binding/);
      assert.equal(drift.message.includes(INLINE_CANARY), false);
    },
  );
});

test("env_key and none auth variants are strict and resolve only current credentials", async () => {
  await withCatalog(
    [
      "version = 1",
      "",
      "[providers.env_provider]",
      'adapter = "builtin:openai-chat"',
      'base_url = "https://env.example.invalid/v1"',
      'auth_kind = "env_key"',
      'api_key_env = "COMPANY_API_KEY"',
      'structured_output_mode = "native_json_schema"',
      'policy = "standard"',
      'allowed_models = ["model-env"]',
      "",
      "[providers.env_provider.reasoning_effort_map]",
      'high = "high"',
      "",
      "[providers.none_provider]",
      'adapter = "builtin:openai-chat"',
      'base_url = "http://127.0.0.1:10001/v1"',
      "allow_private_network = true",
      'auth_kind = "none"',
      'structured_output_mode = "validated_json"',
      'policy = "standard"',
      'allowed_models = ["model-none"]',
      "",
      "[providers.none_provider.reasoning_effort_map]",
      'minimal = "minimal"',
      "",
    ].join("\n"),
    async ({ environment }) => {
      environment.COMPANY_API_KEY = ENV_CANARY;
      const snapshot = await loadProviderCatalogSnapshot({ environment });
      assert.equal(JSON.stringify(snapshot).includes(ENV_CANARY), false);
      assert.equal(
        await resolveProviderCredential(
          snapshot,
          "env_provider",
          { environment },
        ),
        ENV_CANARY,
      );
      assert.equal(
        await resolveProviderCredential(
          snapshot,
          "none_provider",
          { environment },
        ),
        null,
      );
      const binding = await resolveRunWorkerBinding(
        {
          worker: {
            provider: "env_provider",
            model: "model-env",
            reasoning_effort: "high",
          },
        },
        { environment },
      );
      assert.deepEqual(
        await resolveProviderSensitiveEnvironmentNames(
          binding,
          { environment },
        ),
        ["COMPANY_API_KEY"],
      );

      delete environment.COMPANY_API_KEY;
      const missing = await rejectedError(
        resolveProviderCredential(
          snapshot,
          "env_provider",
          { environment },
        ),
      );
      assert.equal(missing.code, "PROVIDER_CREDENTIAL_MISSING");
      assert.equal(missing.message.includes(ENV_CANARY), false);
    },
  );

  await withCatalog(
    [
      "version = 1",
      "",
      "[providers.mixed]",
      'adapter = "builtin:openai-chat"',
      'base_url = "https://mixed.example.invalid/v1"',
      'auth_kind = "env_key"',
      'api_key_env = "MIXED_KEY"',
      `api_key = "${INLINE_CANARY}"`,
      'structured_output_mode = "validated_json"',
      'policy = "standard"',
      "",
    ].join("\n"),
    async ({ environment }) => {
      const invalid = await rejectedError(
        loadProviderCatalogSnapshot({ environment }),
      );
      assert.equal(invalid.code, "PROVIDER_CONFIG_INVALID");
      assert.equal(invalid.message.includes(INLINE_CANARY), false);
    },
  );
});

test("inline catalogs recheck owner-only file and immediate-directory permissions", async () => {
  await withCatalog(
    inlineCatalog(INLINE_CANARY),
    async ({ catalogPath, catalogDirectory, environment }) => {
      await chmod(catalogPath, 0o644);
      let error = await rejectedError(
        loadProviderCatalogSnapshot({ environment }),
      );
      assert.equal(
        error.code,
        "PROVIDER_CONFIG_INSECURE_PERMISSIONS",
      );

      await chmod(catalogPath, 0o600);
      await chmod(catalogDirectory, 0o755);
      error = await rejectedError(
        loadProviderCatalogSnapshot({ environment }),
      );
      assert.equal(
        error.code,
        "PROVIDER_CONFIG_INSECURE_PERMISSIONS",
      );

      await chmod(catalogDirectory, 0o700);
      const snapshot = await loadProviderCatalogSnapshot({ environment });
      await chmod(catalogPath, 0o640);
      error = await rejectedError(
        resolveProviderCredential(
          snapshot,
          "company_ai",
          { environment },
        ),
      );
      assert.equal(
        error.code,
        "PROVIDER_CONFIG_INSECURE_PERMISSIONS",
      );
      assert.equal(error.message.includes(INLINE_CANARY), false);
    },
  );
});

test("catalog path, URL, model, effort, adapter, and policy preflight fail closed", async () => {
  let error = await rejectedError(
    loadProviderCatalogSnapshot({ environment: {} }),
  );
  assert.equal(error.code, "PROVIDER_CONFIG_UNAVAILABLE");

  error = await rejectedError(
    loadProviderCatalogSnapshot({
      environment: { ARK_TEAM_PROVIDER_CONFIG: "relative.toml" },
    }),
  );
  assert.equal(error.code, "PROVIDER_CONFIG_INVALID");

  for (const baseUrl of [
    "https://user:secret@example.invalid/v1",
    "https://example.invalid/v1?api_key=secret",
    "https://example.invalid/v1#fragment",
    "http://example.invalid/v1",
  ]) {
    await withCatalog(
      inlineCatalog(INLINE_CANARY, baseUrl),
      async ({ environment }) => {
        const invalid = await rejectedError(
          loadProviderCatalogSnapshot({ environment }),
        );
        assert.equal(invalid.code, "PROVIDER_CONFIG_INVALID");
        assert.equal(invalid.message.includes("secret"), false);
      },
    );
  }

  await withCatalog(
    inlineCatalog(INLINE_CANARY, undefined, {
      policy: "blocked",
    }),
    async ({ environment }) => {
      const blocked = await rejectedError(
        resolveExternal(environment, "model-1", "xhigh"),
      );
      assert.equal(blocked.code, "PROVIDER_POLICY_BLOCKED");
    },
  );

  await withCatalog(
    inlineCatalog(INLINE_CANARY),
    async ({ environment }) => {
      let rejected = await rejectedError(
        resolveExternal(environment, "other-model", "xhigh"),
      );
      assert.equal(
        rejected.code,
        "PROVIDER_CAPABILITY_UNSUPPORTED",
      );
      rejected = await rejectedError(
        resolveExternal(environment, "model-1", "low"),
      );
      assert.equal(
        rejected.code,
        "PROVIDER_CAPABILITY_UNSUPPORTED",
      );
    },
  );

  await withCatalog(
    inlineCatalog(INLINE_CANARY, undefined, {
      adapter: "builtin:anthropic",
    }),
    async ({ environment }) => {
      const missing = await rejectedError(
        resolveExternal(environment, "model-1", "xhigh"),
      );
      assert.equal(missing.code, "ADAPTER_NOT_FOUND");
    },
  );
});

interface CatalogFixture {
  catalogPath: string;
  catalogDirectory: string;
  environment: NodeJS.ProcessEnv;
}

async function withCatalog(
  contents: string,
  operation: (fixture: CatalogFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(
    path.join(tmpdir(), "ark-team-provider-config-"),
  );
  const catalogDirectory = path.join(root, "catalogs");
  const catalogPath = path.join(catalogDirectory, "providers-v1.toml");
  try {
    await mkdir(catalogDirectory, { mode: 0o700 });
    await writeFile(catalogPath, contents, {
      encoding: "utf8",
      mode: 0o600,
    });
    await operation({
      catalogPath,
      catalogDirectory,
      environment: {
        ARK_TEAM_PROVIDER_CONFIG: catalogPath,
      },
    });
  } finally {
    await chmod(catalogDirectory, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

function inlineCatalog(
  apiKey: string,
  baseUrl = "https://api.example.invalid/v1",
  overrides: {
    policy?: "standard" | "blocked";
    adapter?: "builtin:openai-chat" | "builtin:anthropic";
  } = {},
): string {
  return [
    "version = 1",
    "",
    "[providers.company_ai]",
    `adapter = "${overrides.adapter ?? "builtin:openai-chat"}"`,
    `base_url = "${baseUrl}"`,
    'auth_kind = "inline_key"',
    `api_key = "${apiKey}"`,
    'structured_output_mode = "validated_json"',
    `policy = "${overrides.policy ?? "standard"}"`,
    'allowed_models = ["model-1"]',
    "",
    "[providers.company_ai.reasoning_effort_map]",
    'high = "high"',
    'xhigh = "max"',
    "",
  ].join("\n");
}

function resolveExternal(
  environment: NodeJS.ProcessEnv,
  model: string,
  reasoningEffort: "low" | "xhigh",
) {
  return resolveRunWorkerBinding(
    {
      worker: {
        provider: "company_ai",
        model,
        reasoning_effort: reasoningEffort,
      },
    },
    { environment },
  );
}

async function rejectedError(
  promise: Promise<unknown>,
): Promise<ArkTeamError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ArkTeamError);
    return error;
  }
  assert.fail("expected operation to reject");
}
