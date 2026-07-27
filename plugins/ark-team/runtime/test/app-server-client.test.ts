import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  type AppServerMessage,
  type AppServerProtocolClient,
  type ExternalAppServerRuntime,
  StdioAppServerClient,
} from "../src/app-server-client.js";

test("TEST-005 launches an isolated external app-server child without upstream secret leakage", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ark-team-app-server-client-"),
  );
  const executable = path.join(temporaryRoot, "fake-codex.mjs");
  const codexHome = path.join(temporaryRoot, "external-codex-home");
  const upstreamEnvironmentName = "ARK_TEAM_TEST_UPSTREAM_KEY";
  const upstreamCanary = "upstream-canary-value";
  const bridgeCanary = "bridge-canary-value";
  const forwardedZaiCanary = "unrelated-forwarded-zai-canary";
  const previousUpstream = process.env[upstreamEnvironmentName];
  const previousCatalog = process.env.ARK_TEAM_PROVIDER_CONFIG;
  const previousZai = process.env.ZAI_API_KEY;
  process.env[upstreamEnvironmentName] = upstreamCanary;
  process.env.ZAI_API_KEY = forwardedZaiCanary;
  process.env.ARK_TEAM_PROVIDER_CONFIG = path.join(
    temporaryRoot,
    "credential-catalog-canary.toml",
  );

  try {
    await writeFile(
      executable,
      fakeCodexSource(
        upstreamEnvironmentName,
        "ARK_TEAM_TEST_BRIDGE_TOKEN",
      ),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );
    await chmod(executable, 0o700);

    const runtime: ExternalAppServerRuntime = {
      app_server_provider_id: "ark_fake_provider",
      bridge_base_url:
        "http://127.0.0.1:10001/v1/providers/fake_provider",
      bridge_token_env: "ARK_TEAM_TEST_BRIDGE_TOKEN",
      bridge_token: bridgeCanary,
      upstream_env_names: [upstreamEnvironmentName],
      codex_home: codexHome,
    };
    const client = new StdioAppServerClient({
      codex_path: executable,
      external_runtime: runtime,
    });
    const capture = waitForMethod(client, "fixture/capture");
    await client.request("initialize", {});
    const captured = (await capture).params as {
      argv: string[];
      codexHome: string | null;
      bridgeToken: string | null;
      upstreamKey: string | null;
      providerCatalog: string | null;
      forwardedZaiKey: string | null;
    };

    assert.equal(captured.codexHome, codexHome);
    assert.equal(captured.bridgeToken, bridgeCanary);
    assert.equal(captured.upstreamKey, null);
    assert.equal(captured.providerCatalog, null);
    assert.equal(captured.forwardedZaiKey, null);
    assert.equal((await stat(codexHome)).mode & 0o777, 0o700);

    const serializedArgv = JSON.stringify(captured.argv);
    assert.doesNotMatch(serializedArgv, new RegExp(bridgeCanary));
    assert.doesNotMatch(serializedArgv, new RegExp(upstreamCanary));
    assert.match(
      serializedArgv,
      /model_providers\.ark_fake_provider\.wire_api=\\"responses\\"/,
    );
    assert.match(
      serializedArgv,
      /model_providers\.ark_fake_provider\.env_key=\\"ARK_TEAM_TEST_BRIDGE_TOKEN\\"/,
    );

    await assert.rejects(
      client.request("fixture/fail", {}),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, new RegExp(bridgeCanary));
        assert.match(message, /<redacted>/);
        return true;
      },
    );

    await assert.rejects(
      client.request("fixture/exit", {}),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        assert.doesNotMatch(message, new RegExp(bridgeCanary));
        assert.match(message, /fixture stderr <redacted>/);
        return true;
      },
    );
    await client.close();
  } finally {
    if (previousUpstream === undefined) {
      delete process.env[upstreamEnvironmentName];
    } else {
      process.env[upstreamEnvironmentName] = previousUpstream;
    }
    if (previousCatalog === undefined) {
      delete process.env.ARK_TEAM_PROVIDER_CONFIG;
    } else {
      process.env.ARK_TEAM_PROVIDER_CONFIG = previousCatalog;
    }
    if (previousZai === undefined) {
      delete process.env.ZAI_API_KEY;
    } else {
      process.env.ZAI_API_KEY = previousZai;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-005 scrubs provider-only variables from a native app-server child while preserving native auth", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ark-team-app-server-native-env-"),
  );
  const executable = path.join(temporaryRoot, "fake-codex.mjs");
  const providerEnvironmentName =
    "ARK_TEAM_TEST_CATALOG_DECLARED_PROVIDER_KEY";
  const providerCanary = "catalog-declared-provider-canary";
  const zaiCanary = "static-forwarded-zai-canary";
  const nativeOpenAiCanary = "native-openai-auth-canary";
  const previous = {
    provider: process.env[providerEnvironmentName],
    catalog: process.env.ARK_TEAM_PROVIDER_CONFIG,
    zai: process.env.ZAI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  process.env[providerEnvironmentName] = providerCanary;
  process.env.ARK_TEAM_PROVIDER_CONFIG = path.join(
    temporaryRoot,
    "inline-catalog-canary.toml",
  );
  process.env.ZAI_API_KEY = zaiCanary;
  process.env.OPENAI_API_KEY = nativeOpenAiCanary;

  try {
    await writeFile(
      executable,
      fakeCodexSource(
        providerEnvironmentName,
        "ARK_TEAM_UNUSED_BRIDGE_TOKEN",
      ),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );
    await chmod(executable, 0o700);

    const client = new StdioAppServerClient({
      codex_path: executable,
      provider_sensitive_env_names: [providerEnvironmentName],
    });
    const capture = waitForMethod(client, "fixture/capture");
    await client.request("initialize", {});
    const captured = (await capture).params as {
      upstreamKey: string | null;
      providerCatalog: string | null;
      forwardedZaiKey: string | null;
      nativeOpenAiKey: string | null;
    };
    assert.equal(captured.upstreamKey, null);
    assert.equal(captured.providerCatalog, null);
    assert.equal(captured.forwardedZaiKey, null);
    assert.equal(captured.nativeOpenAiKey, nativeOpenAiCanary);
    await client.close();
  } finally {
    restoreEnvironment(providerEnvironmentName, previous.provider);
    restoreEnvironment(
      "ARK_TEAM_PROVIDER_CONFIG",
      previous.catalog,
    );
    restoreEnvironment("ZAI_API_KEY", previous.zai);
    restoreEnvironment("OPENAI_API_KEY", previous.openai);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-406 close rejects an in-flight app-server RPC", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ark-team-app-server-hang-"),
  );
  const executable = path.join(temporaryRoot, "hanging-codex.mjs");
  try {
    await writeFile(
      executable,
      `#!${process.execPath}
import { createInterface } from "node:readline";
createInterface({ input: process.stdin, crlfDelay: Infinity });
`,
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const client = new StdioAppServerClient({
      codex_path: executable,
    });
    const pending = client.request("initialize", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closing = client.close();
    await assert.rejects(
      pending,
      (error: unknown) => {
        assert.equal(
          typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "AGENT_SESSION_FAILED",
          true,
        );
        return true;
      },
    );
    await closing;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function waitForMethod(
  client: AppServerProtocolClient,
  method: string,
): Promise<AppServerMessage> {
  return new Promise((resolve) => {
    const remove = client.onMessage((message) => {
      if (message.method === method) {
        remove();
        resolve(message);
      }
    });
  });
}

function fakeCodexSource(
  upstreamEnvironmentName: string,
  bridgeTokenEnvironmentName: string,
): string {
  return `#!${process.execPath}
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let captured = false;
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (!captured) {
    captured = true;
    process.stdout.write(JSON.stringify({
      method: "fixture/capture",
      params: {
        argv: process.argv.slice(2),
        codexHome: process.env.CODEX_HOME ?? null,
        bridgeToken: process.env[${JSON.stringify(bridgeTokenEnvironmentName)}] ?? null,
        upstreamKey: process.env[${JSON.stringify(upstreamEnvironmentName)}] ?? null,
        providerCatalog: process.env.ARK_TEAM_PROVIDER_CONFIG ?? null,
        forwardedZaiKey: process.env.ZAI_API_KEY ?? null,
        nativeOpenAiKey: process.env.OPENAI_API_KEY ?? null,
      },
    }) + "\\n");
  }
  if (request.method === "fixture/fail") {
    process.stdout.write(JSON.stringify({
      id: request.id,
      error: {
        code: 400,
        message: "fixture rejected " + process.env[${JSON.stringify(bridgeTokenEnvironmentName)}],
      },
    }) + "\\n");
    return;
  }
  if (request.method === "fixture/exit") {
    process.stderr.write("fixture stderr " + process.env[${JSON.stringify(bridgeTokenEnvironmentName)}] + "\\n");
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
});
`;
}

function restoreEnvironment(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
