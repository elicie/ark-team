import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { ArkTeamError } from "./errors.js";

export type JsonRpcId = string | number;
export type JsonObject = Record<string, unknown>;

export interface AppServerMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

export interface AppServerProtocolClient {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string): void;
  respond(id: JsonRpcId, result: unknown): void;
  respondError(id: JsonRpcId, code: number, message: string): void;
  onMessage(listener: (message: AppServerMessage) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
}

export interface ExternalAppServerRuntime {
  app_server_provider_id: string;
  bridge_base_url: string;
  bridge_token_env: string;
  bridge_token: string;
  upstream_env_names: readonly string[];
  codex_home: string;
}

export interface StdioAppServerClientOptions {
  codex_path?: string;
  external_runtime?: ExternalAppServerRuntime;
  provider_sensitive_env_names?: readonly string[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_STDERR_CHARACTERS = 64 * 1024;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const APP_SERVER_PROVIDER_ID_PATTERN = /^ark_[a-z][a-z0-9_]{0,62}$/;
const REDACTED_VALUE = "<redacted>";
const ALWAYS_SCRUBBED_PROVIDER_ENV_NAMES = [
  "ARK_TEAM_PROVIDER_CONFIG",
  "ZAI_API_KEY",
] as const;

export class StdioAppServerClient implements AppServerProtocolClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly messageListeners = new Set<(message: AppServerMessage) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
  private readonly exitPromise: Promise<void>;
  private requestSequence = 0;
  private stderr = "";
  private terminalError: Error | null = null;
  private closing = false;
  private closed = false;

  constructor(options: StdioAppServerClientOptions = {}) {
    const launch = buildLaunchConfiguration(options);
    this.redact = createRedactor(launch.redactedValues);
    this.child = spawn(
      options.codex_path ?? "codex",
      launch.args,
      {
        env: launch.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = this.redact(`${this.stderr}${chunk}`).slice(
        -MAX_STDERR_CHARACTERS,
      );
    });

    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      this.handleLine(line);
    });

    this.child.once("error", (error) => {
      this.fail(new Error(`Unable to start Codex app-server: ${error.message}`));
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.closed = true;
        if (!this.closing) {
          const detail = this.stderr.trim();
          this.fail(
            new Error(
              `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})${
                detail ? `: ${detail}` : ""
              }`,
            ),
          );
        }
        resolve();
      });
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestSequence;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(asError(error));
      }
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({
      id,
      error: {
        code,
        message,
      },
    });
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.terminalError) {
      queueMicrotask(() => listener(this.terminalError ?? new Error("app-server failed")));
    }
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    const closeError = new ArkTeamError(
      "AGENT_SESSION_FAILED",
      "Codex app-server client closed before a pending request completed",
    );
    for (const pending of this.pendingRequests.values()) {
      pending.reject(closeError);
    }
    this.pendingRequests.clear();
    if (this.closed) {
      return;
    }
    this.closing = true;
    this.child.stdin.end();
    this.child.kill("SIGTERM");

    let closeTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, 2000);
      }),
    ]);
    if (closeTimer) {
      clearTimeout(closeTimer);
    }
    if (!this.closed) {
      this.child.kill("SIGKILL");
      await this.exitPromise;
    }
  }

  private handleLine(line: string): void {
    let message: AppServerMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJsonObject(parsed)) {
        throw new Error("message is not an object");
      }
      message = parsed;
    } catch (error) {
      this.fail(new Error(`Invalid JSONL from Codex app-server: ${asError(error).message}`));
      return;
    }

    if (
      message.id !== undefined &&
      message.method === undefined &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        this.fail(new Error(`Unexpected app-server response ID: ${String(message.id)}`));
        return;
      }
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `Codex app-server request failed (${String(message.error.code)}): ${
              this.redact(message.error.message ?? "unknown error")
            }`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (error) {
        this.fail(asError(error));
      }
    }
  }

  private write(message: JsonObject): void {
    if (this.closed || this.closing || this.terminalError) {
      throw new ArkTeamError("AGENT_SESSION_FAILED", "Codex app-server is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.terminalError || this.closing) {
      return;
    }
    this.terminalError = error;
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const listener of this.failureListeners) {
      listener(error);
    }
  }

  private readonly redact: (value: string) => string;
}

interface AppServerLaunchConfiguration {
  args: string[];
  env: NodeJS.ProcessEnv;
  redactedValues: string[];
}

function buildLaunchConfiguration(
  options: StdioAppServerClientOptions,
): AppServerLaunchConfiguration {
  const externalRuntime = options.external_runtime;
  const args = [
    "app-server",
    "--listen",
    "stdio://",
    "--strict-config",
    "-c",
    "agents.enabled=false",
    "-c",
    "apps._default.enabled=false",
    "-c",
    "features.multi_agent=false",
  ];
  const sensitiveEnvironmentNames = [
    ...new Set([
      ...ALWAYS_SCRUBBED_PROVIDER_ENV_NAMES,
      ...(options.provider_sensitive_env_names ?? []),
      ...(externalRuntime?.upstream_env_names ?? []),
    ]),
  ];
  if (
    sensitiveEnvironmentNames.some(
      (name) => !ENVIRONMENT_NAME_PATTERN.test(name),
    )
  ) {
    throw invalidExternalRuntime(
      "provider-sensitive environment variable name is invalid",
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const redactedValues: string[] = [];
  for (const name of sensitiveEnvironmentNames) {
    const currentValue = env[name];
    if (currentValue) {
      redactedValues.push(currentValue);
    }
    delete env[name];
  }
  if (externalRuntime === undefined) {
    return {
      args,
      env,
      redactedValues,
    };
  }

  assertExternalRuntime(externalRuntime);
  prepareCodexHome(externalRuntime.codex_home);
  args.push(
    "-c",
    `model_providers.${externalRuntime.app_server_provider_id}.name=${tomlString("Ark external provider")}`,
    "-c",
    `model_providers.${externalRuntime.app_server_provider_id}.base_url=${tomlString(externalRuntime.bridge_base_url)}`,
    "-c",
    `model_providers.${externalRuntime.app_server_provider_id}.wire_api="responses"`,
    "-c",
    `model_providers.${externalRuntime.app_server_provider_id}.env_key=${tomlString(externalRuntime.bridge_token_env)}`,
  );

  redactedValues.push(externalRuntime.bridge_token);
  env.CODEX_HOME = externalRuntime.codex_home;
  env[externalRuntime.bridge_token_env] = externalRuntime.bridge_token;
  return {
    args,
    env,
    redactedValues,
  };
}

function assertExternalRuntime(runtime: ExternalAppServerRuntime): void {
  if (!APP_SERVER_PROVIDER_ID_PATTERN.test(runtime.app_server_provider_id)) {
    throw invalidExternalRuntime("app_server_provider_id is invalid");
  }
  if (
    !ENVIRONMENT_NAME_PATTERN.test(runtime.bridge_token_env) ||
    runtime.upstream_env_names.some(
      (name) => !ENVIRONMENT_NAME_PATTERN.test(name),
    )
  ) {
    throw invalidExternalRuntime("environment variable name is invalid");
  }
  if (runtime.upstream_env_names.includes(runtime.bridge_token_env)) {
    throw invalidExternalRuntime(
      "bridge token environment must differ from upstream credential environments",
    );
  }
  if (
    !runtime.bridge_token ||
    runtime.bridge_token.includes("\0") ||
    runtime.bridge_token.includes("\r") ||
    runtime.bridge_token.includes("\n")
  ) {
    throw invalidExternalRuntime("bridge token is invalid");
  }
  if (!path.isAbsolute(runtime.codex_home)) {
    throw invalidExternalRuntime("codex_home must be absolute");
  }

  let bridgeUrl: URL;
  try {
    bridgeUrl = new URL(runtime.bridge_base_url);
  } catch (error) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "external app-server bridge URL is invalid",
      { cause: error },
    );
  }
  const port = Number(bridgeUrl.port);
  if (
    bridgeUrl.protocol !== "http:" ||
    bridgeUrl.hostname !== "127.0.0.1" ||
    !Number.isSafeInteger(port) ||
    port < 10001 ||
    bridgeUrl.username ||
    bridgeUrl.password ||
    bridgeUrl.search ||
    bridgeUrl.hash
  ) {
    throw invalidExternalRuntime(
      "external app-server bridge URL must be an uncredentialed loopback HTTP URL on port 10001 or above",
    );
  }
}

function prepareCodexHome(codexHome: string): void {
  try {
    mkdirSync(codexHome, {
      recursive: true,
      mode: 0o700,
    });
    const stats = lstatSync(codexHome);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw invalidExternalRuntime("codex_home must be a real directory");
    }
    if (
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw invalidExternalRuntime("codex_home must be owned by the current user");
    }
    chmodSync(codexHome, 0o700);
  } catch (error) {
    if (error instanceof ArkTeamError) {
      throw error;
    }
    throw new ArkTeamError(
      "INVALID_INPUT",
      "unable to prepare external app-server CODEX_HOME",
      { cause: error },
    );
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function createRedactor(values: readonly string[]): (value: string) => string {
  const uniqueValues = [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  return (value) => {
    let redacted = value;
    for (const secret of uniqueValues) {
      redacted = redacted.split(secret).join(REDACTED_VALUE);
    }
    return redacted;
  };
}

function invalidExternalRuntime(message: string): ArkTeamError {
  return new ArkTeamError("INVALID_INPUT", message);
}

function isJsonObject(value: unknown): value is AppServerMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
