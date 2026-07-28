import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

import type { IntegrationRecord, RunRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import type { VerificationPmGate } from "./integration-coordinator.js";
import type {
  RecordVerificationSpecDeltaInput,
  RunStore,
} from "./state-store.js";
import type {
  VerificationApiRuntimeRequest,
  VerificationApiRuntimeResult,
} from "./verification-api-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  type VerificationCapability,
} from "./verification-contract.js";
import {
  VerificationBootstrapPmGate,
  VerificationCoordinator,
  type DeepReadonly,
  type RunVerificationBootstrapInput,
  type VerificationCoordinatorRuntime,
  type VerificationServerStartRequest,
} from "./verification-coordinator.js";
import {
  executeVerificationPlaywrightBrowserDriverV2,
  probeVerificationPlaywrightRuntime,
  VERIFICATION_PLAYWRIGHT_ADAPTER,
  VERIFICATION_PLAYWRIGHT_BROWSER_BUILD,
  type VerificationPlaywrightRuntimeProbe,
} from "./verification-playwright-runtime.js";

const LOOPBACK_ADDRESS = "127.0.0.1";
const SERVER_SHUTDOWN_GRACE_MS = 2_000;
const PROCESS_ERROR_LIMIT = 8 * 1_024;

type SpecDeltaInput = RecordVerificationSpecDeltaInput;
const defaultGates = new WeakMap<RunStore, VerificationPmGate>();

export interface LocalBackendVerificationRuntimeHandle {
  readonly runtime: VerificationCoordinatorRuntime;
  readonly curl_version: string | null;
  readonly playwright_probe: () => Promise<VerificationPlaywrightRuntimeProbe>;
  stop(): Promise<void>;
}

export function createDefaultVerificationPmGate(
  store: RunStore,
): VerificationPmGate {
  const existing = defaultGates.get(store);
  if (existing !== undefined) {
    return existing;
  }
  const runtime = createLocalBackendVerificationRuntime();
  const coordinator = new VerificationCoordinator(store);
  coordinator.registerLocalRuntime(runtime.runtime);
  const delegate = new VerificationBootstrapPmGate(
    coordinator,
    (runId) => resolveProductionBootstrapInput(store, runId),
  );

  const gate: VerificationPmGate = {
    async prepareOriginalPmReview(runId: string): Promise<RunRecord> {
      const current = await coordinator.getCurrentRun(runId);
      if (
        current.verification_state?.current_state === "original_pm_review" &&
        current.verification_state.terminal_outcome === "passed"
      ) {
        return current;
      }

      const context = await store.getRunContext(runId);
      const problem = await localBackendPreflightProblem(
        context.run,
        context.integration,
        runtime.curl_version,
        runtime.playwright_probe,
      );
      if (problem !== null) {
        await coordinator.recordSpecDelta(runId, problem);
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "SPEC_DELTA_REQUIRED blocks the unsupported local verification runtime",
        );
      }

      try {
        return await delegate.prepareOriginalPmReview(runId);
      } finally {
        await runtime.stop();
      }
    },
  };
  defaultGates.set(store, gate);
  return gate;
}

export function createLocalBackendVerificationRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): LocalBackendVerificationRuntimeHandle {
  const curlVersion = detectCurlVersion(environment);
  const apiAdapter = {
    name: "curl",
    version: curlVersion ?? "unavailable-v1",
  };
  let playwrightProbePromise:
    | Promise<VerificationPlaywrightRuntimeProbe>
    | undefined;
  const playwrightProbe = (): Promise<VerificationPlaywrightRuntimeProbe> => {
    playwrightProbePromise ??= probeVerificationPlaywrightRuntime();
    return playwrightProbePromise;
  };
  let serverProcess: ChildProcess | null = null;

  const runtime: VerificationCoordinatorRuntime = {
    browser_contract: "v2-combined",
    capability_adapters: {
      agentic_browser: {
        name: "unavailable-agentic-browser",
        version: "unavailable-v1",
      },
      api: apiAdapter,
      browser: {
        ...VERIFICATION_PLAYWRIGHT_ADAPTER,
      },
      comparison: {
        name: "ark-team-comparison",
        version: "1.0.0",
      },
      screenshot: {
        ...VERIFICATION_PLAYWRIGHT_ADAPTER,
      },
      semantic_review: {
        name: "unavailable-local-image",
        version: "unavailable-v1",
      },
      server: {
        name: "ark-team-local-process",
        version: "1.0.0",
      },
    },
    capability_probe: (capability) =>
      capabilityProbe(capability, curlVersion, playwrightProbe),
    start_server: async (request, signal) => {
      if (serverProcess !== null && processTreeIsActive(serverProcess)) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "a local verification server is already active",
        );
      }
      serverProcess = await startRegisteredServer(
        request,
        environment,
        signal,
      );
    },
    probe_http: (request, signal) =>
      probeRegisteredServer(request, signal),
    execute_local: async () => {
      throw new ArkTeamError(
        "ENVIRONMENT_UNAVAILABLE",
        "the reduced local runtime exposes only registered server and API effects",
      );
    },
    execute_browser: async (request, signal) => {
      if (request.schema_version !== 2) {
        throw new ArkTeamError(
          "CONTRACT_VERSION_MISMATCH",
          "the production browser runtime accepts only the combined v2 contract",
        );
      }
      return executeVerificationPlaywrightBrowserDriverV2(
        request,
        signal,
      );
    },
    ...(curlVersion === null
      ? {}
      : {
          execute_api: (
            request: DeepReadonly<VerificationApiRuntimeRequest>,
            signal: AbortSignal,
          ) => executeCurlRequest(request, curlVersion, environment, signal),
        }),
  };

  return {
    runtime,
    curl_version: curlVersion,
    playwright_probe: playwrightProbe,
    async stop(): Promise<void> {
      const active = serverProcess;
      serverProcess = null;
      if (active === null || !processTreeIsActive(active)) {
        return;
      }
      signalProcessTree(active, "SIGTERM");
      if (await waitForProcessTreeExit(active, SERVER_SHUTDOWN_GRACE_MS)) {
        return;
      }
      signalProcessTree(active, "SIGKILL");
      await waitForProcessTreeExit(active, SERVER_SHUTDOWN_GRACE_MS);
    },
  };
}

export function localBackendIntegrationProblem(
  integration: IntegrationRecord | null,
): SpecDeltaInput | null {
  if (
    integration?.strategy === "local_merge" &&
    integration.state === "local_merged"
  ) {
    return null;
  }
  if (integration?.strategy === "pull_request") {
    return delta(
      "environment_mismatch",
      "integration strategy is pull_request and the verified result is not present in the original checkout",
      "verification would inspect the pre-integration source instead of the reviewed integration worktree",
      "add an approved selected-worktree snapshot contract before enabling verification for pull-request integration",
    );
  }
  return delta(
    "environment_mismatch",
    "local verification did not receive one completed local_merge integration",
    "the production gate cannot identify an integrated source checkout",
    "complete local integration before invoking the verification PM gate",
  );
}

async function localBackendPreflightProblem(
  run: RunRecord,
  integration: IntegrationRecord | null,
  curlVersion: string | null,
  playwrightProbe: () => Promise<VerificationPlaywrightRuntimeProbe>,
): Promise<SpecDeltaInput | null> {
  const config = run.project_config.verification.coordinator;
  if (
    config === null ||
    config.schema_version !== 2 ||
    !config.enabled
  ) {
    return delta(
      "contradiction",
      "the production PM gate was invoked without an enabled contract-v2 coordinator",
      "BOOTSTRAP-1701 has no active configuration",
      "enable one approved contract-v2 coordinator configuration",
    );
  }
  if (
    config.backend.enabled &&
    config.backend.api_probes.some(
      (probe) => probe.body_digest !== "none",
    )
  ) {
    return delta(
      "omission",
      "a Backend probe declares body bytes but no approved byte source exists",
      "the runtime cannot reproduce the snapshotted request body from a digest alone",
      "add an approved bounded API body source contract or use body-free probes",
    );
  }
  if (
    config.backend.enabled &&
    (curlVersion === null ||
      config.backend.api_adapter_version !== curlVersion)
  ) {
    return delta(
      "environment_mismatch",
      `registered curl version ${curlVersion ?? "unavailable"} does not match the configured exact version`,
      "Backend probe evidence cannot claim the configured adapter identity",
      "install and configure the same exact local curl version",
    );
  }
  if (config.ui.enabled) {
    if (
      config.ui.deterministic_adapter !==
        VERIFICATION_PLAYWRIGHT_ADAPTER.name ||
      config.ui.deterministic_adapter_version !==
        VERIFICATION_PLAYWRIGHT_ADAPTER.version ||
      config.ui.browser_build !== VERIFICATION_PLAYWRIGHT_BROWSER_BUILD
    ) {
      return delta(
        "environment_mismatch",
        "configured UI adapter or browser build differs from the approved production identity",
        "UI evidence could not claim the configured deterministic runtime",
        "configure the exact approved Playwright adapter and bundled Chromium build",
      );
    }
    const probe = await playwrightProbe();
    if (
      !probe.available ||
      probe.adapter.name !== VERIFICATION_PLAYWRIGHT_ADAPTER.name ||
      probe.adapter.version !== VERIFICATION_PLAYWRIGHT_ADAPTER.version ||
      probe.browser_build !== VERIFICATION_PLAYWRIGHT_BROWSER_BUILD
    ) {
      return delta(
        "environment_mismatch",
        `approved Playwright runtime is unavailable: ${probe.reason ?? "identity mismatch"}`,
        "deterministic UI actions and screenshots cannot execute",
        "provision the exact locked Chromium revision without changing the runtime contract",
      );
    }
  }
  const serverInspection = await inspectProjectServerRegistration(
    run.project_path,
    config.server_argv,
  );
  if (
    !serverInspection.ok &&
    serverInspection.reason === "next_allowed_origin"
  ) {
    return delta(
      "omission",
      "a Next.js project needs one statically verified allowedDevOrigins literal",
      "the runtime cannot prove that devbox is an accepted development origin",
      "include devbox in one statically literal root Next.js allowedDevOrigins array",
    );
  }
  if (!serverInspection.ok) {
    return delta(
      "omission",
      "the target framework cannot be proven from bounded root project metadata",
      "the runtime cannot safely register the server as non-Next.js or prove allowedDevOrigins",
      "add an approved exact server framework and allowedDevOrigins registration source",
    );
  }
  return localBackendIntegrationProblem(integration);
}

async function resolveProductionBootstrapInput(
  store: RunStore,
  runId: string,
): Promise<RunVerificationBootstrapInput> {
  const context = await store.getRunContext(runId);
  const config = context.run.project_config.verification.coordinator;
  if (
    config === null ||
    config.schema_version !== 2 ||
    !config.enabled
  ) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "production verification bootstrap has no enabled v2 configuration",
    );
  }
  const inspection = await inspectProjectServerRegistration(
    context.run.project_path,
    config.server_argv,
  );
  if (!inspection.ok) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "production verification server registration is not statically verified",
    );
  }
  const semanticChecklistByCase = config.ui.enabled
    ? Object.fromEntries(
        config.ui.browser_cases.map((browserCase) => [
          browserCase.id,
          {
            identity: "ark-ui-semantic-checklist",
            version: "1.0.0",
          },
        ]),
      )
    : undefined;
  return {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server: inspection.registration,
    ...(config.ui.enabled
      ? {
          ui_evidence_source: "approved_store" as const,
          semantic_checklist_by_case: semanticChecklistByCase!,
        }
      : {}),
  };
}

async function capabilityProbe(
  capability: VerificationCapability,
  curlVersion: string | null,
  playwrightProbe: () => Promise<VerificationPlaywrightRuntimeProbe>,
) {
  const browserProbe =
    capability === "browser" || capability === "screenshot"
      ? await playwrightProbe()
      : null;
  const adapter =
    capability === "api"
      ? {
          name: "curl",
          version: curlVersion ?? "unavailable-v1",
        }
      : capability === "server"
        ? {
            name: "ark-team-local-process",
            version: "1.0.0",
          }
        : capability === "browser" || capability === "screenshot"
          ? VERIFICATION_PLAYWRIGHT_ADAPTER
          : capability === "comparison"
            ? {
                name: "ark-team-comparison",
                version: "1.0.0",
              }
            : capability === "semantic_review"
              ? {
                  name: "unavailable-local-image",
                  version: "unavailable-v1",
                }
              : {
                  name: "unavailable-agentic-browser",
                  version: "unavailable-v1",
                };
  const available =
    capability === "server" ||
    capability === "comparison" ||
    (capability === "api" && curlVersion !== null) ||
    ((capability === "browser" || capability === "screenshot") &&
      browserProbe?.available === true);
  return {
    available,
    version:
      capability === "server"
        ? "1.0.0"
        : capability === "api" && curlVersion !== null
          ? curlVersion
          : capability === "comparison"
            ? "1.0.0"
            : (capability === "browser" ||
                  capability === "screenshot") &&
                browserProbe?.available
              ? VERIFICATION_PLAYWRIGHT_ADAPTER.version
          : null,
    diagnostic: available
      ? `registered local ${capability} capability`
      : browserProbe?.reason ??
        `${capability} capability is not registered in the reduced runtime`,
    adapter,
  };
}

function detectCurlVersion(environment: NodeJS.ProcessEnv): string | null {
  const result = spawnSync("curl", ["--version"], {
    encoding: "utf8",
    env: commandEnvironment(environment),
    shell: false,
  });
  if (
    result.status !== 0 ||
    typeof result.stdout !== "string"
  ) {
    return null;
  }
  return /^curl\s+([^\s]+)/.exec(result.stdout)?.[1] ?? null;
}

async function startRegisteredServer(
  request: Readonly<VerificationServerStartRequest>,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ChildProcess> {
  if (signal.aborted) {
    throw new ArkTeamError(
      "ENVIRONMENT_UNAVAILABLE",
      "local server start was aborted",
    );
  }
  const child = spawn(request.argv[0]!, request.argv.slice(1), {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    env: serverEnvironment(environment, request),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(
        new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          "registered local server could not start",
          { cause: error },
        ),
      );
    };
    const onAbort = (): void => {
      cleanup();
      signalProcessTree(child, "SIGTERM");
      reject(
        new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          "registered local server start was aborted",
        ),
      );
    };
    const cleanup = (): void => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return child;
}

async function probeRegisteredServer(
  request: Readonly<VerificationServerStartRequest>,
  signal: AbortSignal,
): Promise<{ status: number }> {
  const deadline = Date.now() + request.readiness.timeout_ms;
  let lastError: unknown = null;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      const target = loopbackUrl(request.readiness.url);
      const status = await requestReadinessStatus(
        target,
        new URL(request.readiness.url).host,
        signal,
      );
      if (status === request.readiness.expected_status) {
        return { status };
      }
      lastError = new Error(
        `registered local server returned readiness status ${status}`,
      );
    } catch (error) {
      lastError = error;
      if (signal.aborted) {
        break;
      }
    }
    await delay(50, signal);
  }
  throw new ArkTeamError(
    "ENVIRONMENT_UNAVAILABLE",
    "registered local server readiness timed out",
    { cause: lastError },
  );
}

async function requestReadinessStatus(
  target: string,
  hostHeader: string,
  signal: AbortSignal,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      target,
      {
        method: "GET",
        headers: { host: hostHeader },
        signal,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function executeCurlRequest(
  request: DeepReadonly<VerificationApiRuntimeRequest>,
  curlVersion: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<VerificationApiRuntimeResult> {
  if (
    request.identity.adapter.version !== curlVersion ||
    request.execution.stdin !== null ||
    request.request.body_sha256 !== "none"
  ) {
    throw new ArkTeamError(
      "ENVIRONMENT_UNAVAILABLE",
      "registered curl runtime accepts only matching body-free requests",
    );
  }
  const startedAt = Date.now();
  const result = await runBoundedProcess(
    request.execution.argv,
    request.execution.cwd,
    commandEnvironment(environment),
    signal,
    request.request.method === "HEAD"
      ? request.limits.max_metadata_bytes
      : request.limits.max_response_bytes +
        request.limits.max_metadata_bytes,
  );
  const parsed = parseCurlResponse(result.stdout);
  return {
    request_sha256: request.request_sha256,
    url: request.request.url,
    status: parsed.status,
    headers: parsed.headers,
    body: parsed.body,
    elapsed_ms: Date.now() - startedAt,
  };
}

async function runBoundedProcess(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  stdoutLimit: number,
): Promise<{ stdout: Buffer }> {
  if (signal.aborted) {
    throw new ArkTeamError(
      "ENVIRONMENT_UNAVAILABLE",
      "registered curl execution was aborted",
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (
      error: Error | null,
      value?: { stdout: Buffer },
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error !== null) {
        reject(error);
      } else {
        resolve(value!);
      }
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish(
        new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          "registered curl execution was aborted",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) =>
      finish(
        new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          "registered curl process could not start",
          { cause: error },
        ),
      ),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > stdoutLimit) {
        child.kill("SIGTERM");
        finish(
          new ArkTeamError(
            "ENVIRONMENT_UNAVAILABLE",
            "registered curl response exceeded its byte limit",
          ),
        );
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= PROCESS_ERROR_LIMIT) {
        return;
      }
      const remaining = PROCESS_ERROR_LIMIT - stderrBytes;
      const bounded = Buffer.from(chunk).subarray(0, remaining);
      stderrBytes += bounded.byteLength;
      stderr.push(bounded);
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new ArkTeamError(
            "ENVIRONMENT_UNAVAILABLE",
            `registered curl process exited with code ${code ?? "unknown"}`,
          ),
        );
        return;
      }
      finish(null, { stdout: Buffer.concat(stdout) });
    });
  });
}

function parseCurlResponse(bytes: Buffer): {
  status: number;
  headers: Record<string, string | string[]>;
  body: Uint8Array;
} {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = headerBoundary(bytes, offset);
    if (end === null) {
      break;
    }
    const headerText = bytes.subarray(offset, end.start).toString("latin1");
    const lines = headerText.split(/\r?\n/);
    const status = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/.exec(lines[0] ?? "");
    if (status === null) {
      break;
    }
    const statusCode = Number(status[1]);
    const headers: Record<string, string | string[]> = {};
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      const previous = headers[name];
      headers[name] =
        previous === undefined
          ? value
          : Array.isArray(previous)
            ? [...previous, value]
            : [previous, value];
    }
    offset = end.end;
    if (statusCode >= 100 && statusCode < 200) {
      continue;
    }
    return {
      status: statusCode,
      headers,
      body: Uint8Array.from(bytes.subarray(offset)),
    };
  }
  throw new ArkTeamError(
    "INVALID_RECORD",
    "registered curl response has no valid HTTP header block",
  );
}

function headerBoundary(
  bytes: Buffer,
  offset: number,
): { start: number; end: number } | null {
  const crlf = bytes.indexOf("\r\n\r\n", offset, "latin1");
  const lf = bytes.indexOf("\n\n", offset, "latin1");
  if (crlf === -1 && lf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { start: crlf, end: crlf + 4 };
  }
  return { start: lf, end: lf + 2 };
}

function serverEnvironment(
  environment: NodeJS.ProcessEnv,
  request: Readonly<VerificationServerStartRequest>,
): NodeJS.ProcessEnv {
  return {
    ...commandEnvironment(environment),
    NODE_ENV: "test",
    PORT: String(request.port),
    HOST: request.bind,
    HOSTNAME: request.bind,
    BROWSER: "none",
  };
}

function commandEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
  ]) {
    if (environment[name] !== undefined) {
      selected[name] = environment[name];
    }
  }
  return selected;
}

function loopbackUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "devbox") {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "local verification URL is not the registered dev origin",
    );
  }
  url.hostname = LOOPBACK_ADDRESS;
  return url.toString();
}

type ProjectServerInspection =
  | {
      readonly ok: true;
      readonly registration: {
        readonly framework: "nextjs" | "other";
        readonly allowed_dev_origins: readonly string[];
      };
    }
  | {
      readonly ok: false;
      readonly reason: "next_allowed_origin" | "unknown";
    };

async function inspectProjectServerRegistration(
  projectPath: string,
  serverArgv: readonly string[],
): Promise<ProjectServerInspection> {
  let framework: "nextjs" | "other" | "unknown" = "unknown";
  if (
    serverArgv.some((value) =>
      ["next", "next.cmd", "next.exe"].includes(
        path.basename(value).toLowerCase(),
      ),
    )
  ) {
    framework = "nextjs";
  } else {
    let raw: string;
    try {
      raw = await readFile(path.join(projectPath, "package.json"), "utf8");
    } catch (error) {
      framework = isNodeError(error, "ENOENT") ? "other" : "unknown";
      raw = "";
    }
    if (raw !== "") {
      try {
        const parsed = JSON.parse(raw) as {
          dependencies?: Record<string, unknown>;
          devDependencies?: Record<string, unknown>;
          workspaces?: unknown;
        };
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          (parsed.dependencies !== undefined &&
            (typeof parsed.dependencies !== "object" ||
              parsed.dependencies === null ||
              Array.isArray(parsed.dependencies))) ||
          (parsed.devDependencies !== undefined &&
            (typeof parsed.devDependencies !== "object" ||
              parsed.devDependencies === null ||
              Array.isArray(parsed.devDependencies)))
        ) {
          framework = "unknown";
        } else if (
          Object.hasOwn(parsed.dependencies ?? {}, "next") ||
          Object.hasOwn(parsed.devDependencies ?? {}, "next")
        ) {
          framework = "nextjs";
        } else {
          framework = Object.hasOwn(parsed, "workspaces")
            ? "unknown"
            : "other";
        }
      } catch {
        framework = "unknown";
      }
    }
  }
  if (framework === "unknown") {
    return { ok: false, reason: "unknown" };
  }
  if (framework === "other") {
    return {
      ok: true,
      registration: {
        framework: "other",
        allowed_dev_origins: [],
      },
    };
  }
  const candidates = [
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
    "next.config.ts",
  ];
  const files: string[] = [];
  for (const candidate of candidates) {
    const candidatePath = path.join(projectPath, candidate);
    try {
      const metadata = await lstat(candidatePath);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size > 256 * 1_024
      ) {
        return { ok: false, reason: "next_allowed_origin" };
      }
      files.push(candidatePath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        return { ok: false, reason: "next_allowed_origin" };
      }
    }
  }
  if (files.length !== 1) {
    return { ok: false, reason: "next_allowed_origin" };
  }
  let configSource: string;
  try {
    configSource = await readFile(files[0]!, "utf8");
  } catch {
    return { ok: false, reason: "next_allowed_origin" };
  }
  const literalMatches = [
    ...configSource.matchAll(
      /\ballowedDevOrigins\s*:\s*\[([^\]]{0,1000})\]/g,
    ),
  ];
  const allowedOrigins =
    literalMatches.length === 1
      ? parseStaticAllowedDevOrigins(literalMatches[0]![1]!)
      : null;
  if (allowedOrigins === null || !allowedOrigins.includes("devbox")) {
    return { ok: false, reason: "next_allowed_origin" };
  }
  return {
    ok: true,
    registration: {
      framework: "nextjs",
      allowed_dev_origins: ["devbox"],
    },
  };
}

function parseStaticAllowedDevOrigins(source: string): string[] | null {
  const parts = source.split(",").map((value) => value.trim());
  if (parts.at(-1) === "") {
    parts.pop();
  }
  if (parts.length === 0 || parts.length > 10) {
    return null;
  }
  const values: string[] = [];
  for (const part of parts) {
    const match = /^(["'])([A-Za-z0-9.-]+)\1$/.exec(part);
    if (match === null || values.includes(match[2]!)) {
      return null;
    }
    values.push(match[2]!);
  }
  return values;
}

function delta(
  classification: SpecDeltaInput["classification"],
  evidence: string,
  impact: string,
  proposedResolution: string,
): SpecDeltaInput {
  return {
    affected_ids: [
      "OBJ-1709",
      "REQ-1719",
      "AC-1719",
      "TEST-1719",
      "IS-1707",
    ],
    classification,
    evidence: [{ kind: "runtime", value: evidence }],
    impact,
    proposed_resolution: proposedResolution,
    blocking_stage: "IS-1707",
  };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      new ArkTeamError(
        "ENVIRONMENT_UNAVAILABLE",
        "local readiness wait was aborted",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(
        new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          "local readiness wait was aborted",
        ),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForProcessTreeExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processTreeIsActive(child) && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return !processTreeIsActive(child);
}

function processTreeIsActive(child: ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (isNodeError(error, "ESRCH")) {
        return;
      }
    }
  }
  child.kill(signal);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}
