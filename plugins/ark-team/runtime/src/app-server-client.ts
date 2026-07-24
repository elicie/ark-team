import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

interface StdioAppServerClientOptions {
  codex_path?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_STDERR_CHARACTERS = 64 * 1024;

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
    this.child = spawn(
      options.codex_path ?? "codex",
      [
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
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_CHARACTERS);
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
              message.error.message ?? "unknown error"
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
}

function isJsonObject(value: unknown): value is AppServerMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
