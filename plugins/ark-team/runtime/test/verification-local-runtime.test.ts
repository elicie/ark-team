import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { IntegrationRecord } from "../src/domain.js";
import { ArkTeamError } from "../src/errors.js";
import { createArkTeamMcpServer } from "../src/mcp-server.js";
import { ArkTeamOrchestrator } from "../src/orchestrator.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
} from "../src/verification-contract.js";
import { VerificationCoordinator } from "../src/verification-coordinator.js";
import {
  createDefaultVerificationPmGate,
  createLocalBackendVerificationRuntime,
  localBackendIntegrationProblem,
} from "../src/verification-local-runtime.js";
import {
  VERIFICATION_PLAYWRIGHT_ADAPTER,
  VERIFICATION_PLAYWRIGHT_BROWSER_BUILD,
  VERIFICATION_PLAYWRIGHT_BROWSER_VERSION,
  VERIFICATION_UI_RUNTIME_SPEC_SHA256,
} from "../src/verification-playwright-runtime.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

test("TEST-1719 runs one body-free Backend QA probe through a real local server and curl", async (t) => {
  const root = await temporaryProject(t);
  const projectRoot = path.join(root, "project");
  const stateRoot = path.join(root, "state");
  await writeFile(
    path.join(projectRoot, "server.mjs"),
    [
      'import http from "node:http";',
      "let healthAttempts = 0;",
      "const server = http.createServer((request, response) => {",
      '  if (request.method === "HEAD" && request.url === "/head") {',
      '    response.writeHead(200, { "content-type": "text/plain", "content-length": "62914560" });',
      "    response.end();",
      "    return;",
      "  }",
      '  if (request.url !== "/health") {',
      "    response.writeHead(404).end();",
      "    return;",
      "  }",
      "  healthAttempts += 1;",
      "  if (healthAttempts < 3) {",
      '    response.writeHead(503, { "content-type": "application/json" });',
      '    response.end(JSON.stringify({ status: "warming" }));',
      "    return;",
      "  }",
      '  response.writeHead(200, { "content-type": "application/json" });',
      '  response.end(JSON.stringify({ status: "ok" }));',
      "});",
      "server.listen(Number(process.env.PORT), process.env.HOST);",
      'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, "launcher.mjs"),
    [
      'import { spawn } from "node:child_process";',
      'const child = spawn(process.execPath, ["server.mjs"], {',
      "  env: process.env,",
      '  stdio: "inherit",',
      "});",
      'process.on("SIGTERM", () => undefined);',
      'child.once("exit", (code) => process.exit(code ?? 1));',
      "",
    ].join("\n"),
    "utf8",
  );

  const runtime = createLocalBackendVerificationRuntime();
  if (runtime.curl_version === null) {
    t.skip("curl is unavailable");
    return;
  }
  const verification = validVerificationCoordinatorConfig();
  verification.ui = { enabled: false };
  verification.server_argv = [process.execPath, "launcher.mjs"];
  verification.server_readiness_path = "/health";
  if (!verification.backend.enabled) {
    assert.fail("Backend fixture is disabled");
  }
  verification.backend.api_adapter_version = runtime.curl_version;
  verification.backend.api_probes = [
    {
      id: "health",
      method: "GET",
      path: "/health",
      query: {},
      headers: { accept: "application/json" },
      body_digest: "none",
      expected_status: 200,
      expected_content_type: "application/json",
      required: true,
    },
    {
      id: "head",
      method: "HEAD",
      path: "/head",
      query: {},
      headers: { accept: "text/plain" },
      body_digest: "none",
      expected_status: 200,
      expected_content_type: "text/plain",
      required: true,
    },
  ];
  const projectConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  projectConfig.verification.coordinator = verification;
  const store = verificationStore(stateRoot, projectRoot);
  const run = await store.createRun({
    objective: "실사용 Backend QA",
    project_path: projectRoot,
    project_config: projectConfig,
  });
  const coordinator = new VerificationCoordinator(store);
  coordinator.registerLocalRuntime(runtime.runtime);

  let selectedPort: number | null = null;
  try {
    const result = await coordinator.runBootstrap(run.run_id, {
      package_fingerprint:
        APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
      server: {
        framework: "other",
        allowed_dev_origins: [],
      },
    });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") {
      assert.fail("real Backend QA unexpectedly produced a spec delta");
    }
    assert.equal(
      result.run.verification_state?.current_state,
      "pm_review_pending",
    );
    assert.equal(
      result.run.verification_state?.terminal_outcome,
      "passed",
    );
    const snapshot = result.run.verification_snapshot;
    assert.ok(snapshot !== null && snapshot.schema_version === 2);
    if (snapshot === null || snapshot.schema_version !== 2) {
      assert.fail("real Backend QA did not persist a v2 snapshot");
    }
    selectedPort = snapshot.server.port;
    assert.ok(selectedPort >= 10_001);
    assert.equal(snapshot.server.bind, "0.0.0.0");
    assert.equal(snapshot.server.host, "devbox");
    const requestRecord = result.run.verification_records.find(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "request" &&
        record.check_id === "health",
    );
    assert.ok(requestRecord?.payload.kind === "request");
    if (requestRecord?.payload.kind !== "request") {
      assert.fail("real Backend QA request evidence is missing");
    }
    assert.equal(requestRecord.payload.expected_status, 200);
    assert.equal(requestRecord.payload.actual_status, 200);
    const headRecord = result.run.verification_records.find(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "request" &&
        record.check_id === "head",
    );
    assert.ok(headRecord?.payload.kind === "request");
    if (headRecord?.payload.kind !== "request") {
      assert.fail("real Backend HEAD evidence is missing");
    }
    assert.equal(headRecord.payload.actual_status, 200);
  } finally {
    await runtime.stop();
  }
  assert.ok(selectedPort !== null);
  await assertPortCanBind(selectedPort);
});

test("UIR-TEST-001 production runtime exposes only the exact cached Playwright identity", async () => {
  const runtime = createLocalBackendVerificationRuntime();
  assert.equal(runtime.runtime.browser_contract, "v2-combined");
  assert.deepEqual(
    runtime.runtime.capability_adapters.browser,
    VERIFICATION_PLAYWRIGHT_ADAPTER,
  );
  assert.deepEqual(
    runtime.runtime.capability_adapters.screenshot,
    VERIFICATION_PLAYWRIGHT_ADAPTER,
  );
  assert.deepEqual(runtime.runtime.capability_adapters.comparison, {
    name: "ark-team-comparison",
    version: "1.0.0",
  });
  assert.equal(runtime.runtime.execute_screenshots, undefined);

  const first = runtime.playwright_probe();
  const second = runtime.playwright_probe();
  assert.strictEqual(first, second);
  const probe = await first;
  assert.equal(probe.available, true, probe.reason ?? undefined);
  assert.equal(probe.package_version, "1.62.0");
  assert.equal(probe.browser_version, VERIFICATION_PLAYWRIGHT_BROWSER_VERSION);
  assert.equal(probe.browser_build, VERIFICATION_PLAYWRIGHT_BROWSER_BUILD);
  assert.equal(probe.spec_sha256, VERIFICATION_UI_RUNTIME_SPEC_SHA256);

  const browser = await runtime.runtime.capability_probe(
    "browser",
    AbortSignal.timeout(60_000),
  );
  const screenshot = await runtime.runtime.capability_probe(
    "screenshot",
    AbortSignal.timeout(60_000),
  );
  assert.equal(browser.available, true);
  assert.equal(screenshot.available, true);
  assert.equal(browser.version, VERIFICATION_PLAYWRIGHT_ADAPTER.version);
  assert.equal(screenshot.version, VERIFICATION_PLAYWRIGHT_ADAPTER.version);
});

test("TEST-1719 default gate records SPEC_DELTA for UI, body, and framework sources that have no approved runtime contract", async (t) => {
  const root = await temporaryProject(t);
  const projectRoot = path.join(root, "project");
  const store = verificationStore(path.join(root, "state"), projectRoot);
  const gate = createDefaultVerificationPmGate(store);

  const uiConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  uiConfig.verification.coordinator =
    validVerificationCoordinatorConfig();
  const uiRun = await store.createRun({
    objective: "UI QA 계약 누락",
    project_path: projectRoot,
    project_config: uiConfig,
  });
  await assert.rejects(
    () => gate.prepareOriginalPmReview(uiRun.run_id),
    isSpecDeltaBlock,
  );
  assert.equal(
    (await store.getVerificationSpecDelta(uiRun.run_id))?.classification,
    "environment_mismatch",
  );

  const approvedUiConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  const approvedUiVerification = validVerificationCoordinatorConfig();
  approvedUiVerification.backend = { enabled: false };
  if (!approvedUiVerification.ui.enabled) {
    assert.fail("UI fixture is disabled");
  }
  approvedUiVerification.ui.deterministic_adapter =
    VERIFICATION_PLAYWRIGHT_ADAPTER.name;
  approvedUiVerification.ui.deterministic_adapter_version =
    VERIFICATION_PLAYWRIGHT_ADAPTER.version;
  approvedUiVerification.ui.browser_build =
    VERIFICATION_PLAYWRIGHT_BROWSER_BUILD;
  for (const task of approvedUiVerification.ui.agentic_tasks) {
    task.browser_build = VERIFICATION_PLAYWRIGHT_BROWSER_BUILD;
  }
  approvedUiVerification.ui.semantic_review_required = false;
  approvedUiVerification.ui.required_capabilities = [
    "browser",
    "comparison",
    "screenshot",
    "server",
  ];
  approvedUiVerification.ui.optional_capabilities = [
    "agentic_browser",
    "semantic_review",
  ];
  approvedUiConfig.verification.coordinator = approvedUiVerification;
  const approvedUiRun = await store.createRun({
    objective: "승인 UI 런타임 사전검증",
    project_path: projectRoot,
    project_config: approvedUiConfig,
  });
  await assert.rejects(
    () => gate.prepareOriginalPmReview(approvedUiRun.run_id),
    isSpecDeltaBlock,
  );
  const approvedUiDelta = await store.getVerificationSpecDelta(
    approvedUiRun.run_id,
  );
  assert.equal(approvedUiDelta?.classification, "environment_mismatch");
  assert.match(
    approvedUiDelta?.evidence[0]?.value ?? "",
    /completed local_merge integration/,
  );

  const bodyConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  const bodyVerification = validVerificationCoordinatorConfig();
  bodyVerification.ui = { enabled: false };
  if (!bodyVerification.backend.enabled) {
    assert.fail("Backend fixture is disabled");
  }
  bodyVerification.backend.api_probes[0]!.method = "POST";
  bodyVerification.backend.api_probes[0]!.body_digest = "a".repeat(64);
  bodyConfig.verification.coordinator = bodyVerification;
  const bodyRun = await store.createRun({
    objective: "Backend body source 계약 누락",
    project_path: projectRoot,
    project_config: bodyConfig,
  });
  await assert.rejects(
    () => gate.prepareOriginalPmReview(bodyRun.run_id),
    isSpecDeltaBlock,
  );
  assert.equal(
    (await store.getVerificationSpecDelta(bodyRun.run_id))
      ?.classification,
    "omission",
  );

  const localRuntime = createLocalBackendVerificationRuntime();
  assert.ok(localRuntime.curl_version !== null);
  if (localRuntime.curl_version === null) {
    return;
  }
  await writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ dependencies: { next: "16.0.0" } }),
    "utf8",
  );
  const frameworkConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  const frameworkVerification = validVerificationCoordinatorConfig();
  frameworkVerification.ui = { enabled: false };
  if (!frameworkVerification.backend.enabled) {
    assert.fail("Backend fixture is disabled");
  }
  frameworkVerification.backend.api_adapter_version =
    localRuntime.curl_version;
  frameworkConfig.verification.coordinator = frameworkVerification;
  const frameworkRun = await store.createRun({
    objective: "server framework 계약 누락",
    project_path: projectRoot,
    project_config: frameworkConfig,
  });
  await assert.rejects(
    () => gate.prepareOriginalPmReview(frameworkRun.run_id),
    isSpecDeltaBlock,
  );
  assert.equal(
    (await store.getVerificationSpecDelta(frameworkRun.run_id))
      ?.classification,
    "omission",
  );

  await writeFile(
    path.join(projectRoot, "next.config.mjs"),
    [
      'throw new Error("configuration inspection must not execute source");',
      'export default { allowedDevOrigins: ["dev", "devbox"] };',
      "",
    ].join("\n"),
    "utf8",
  );
  const registeredFrameworkRun = await store.createRun({
    objective: "정적 Next.js dev origin 등록",
    project_path: projectRoot,
    project_config: frameworkConfig,
  });
  await assert.rejects(
    () => gate.prepareOriginalPmReview(registeredFrameworkRun.run_id),
    isSpecDeltaBlock,
  );
  const registeredFrameworkDelta =
    await store.getVerificationSpecDelta(registeredFrameworkRun.run_id);
  assert.equal(
    registeredFrameworkDelta?.classification,
    "environment_mismatch",
    JSON.stringify(registeredFrameworkDelta),
  );
  assert.match(
    registeredFrameworkDelta?.evidence[0]?.value ?? "",
    /completed local_merge integration/,
  );
});

test("TEST-1719 pull-request integration fails closed until its selected worktree source is specified", () => {
  const problem = localBackendIntegrationProblem({
    strategy: "pull_request",
    state: "remote_completed",
  } as IntegrationRecord);

  assert.equal(problem?.classification, "environment_mismatch");
  assert.match(problem?.impact ?? "", /pre-integration source/);
  assert.equal(
    localBackendIntegrationProblem({
      strategy: "local_merge",
      state: "local_merged",
    } as IntegrationRecord),
    null,
  );
});

test("TEST-1719 default entry points register the verification gate without claiming authority for injected controllers", async (t) => {
  const root = await temporaryProject(t);
  const defaultMcpStore = verificationStore(
    path.join(root, "default-mcp-state"),
    path.join(root, "project"),
  );
  const defaultServer = createArkTeamMcpServer(defaultMcpStore);
  assert.throws(
    () => new VerificationCoordinator(defaultMcpStore),
    isAlreadyClaimed,
  );
  await defaultServer.close();

  const defaultOrchestratorStore = verificationStore(
    path.join(root, "default-orchestrator-state"),
    path.join(root, "project"),
  );
  new ArkTeamOrchestrator(defaultOrchestratorStore);
  assert.throws(
    () => new VerificationCoordinator(defaultOrchestratorStore),
    isAlreadyClaimed,
  );

  const injectedStore = verificationStore(
    path.join(root, "injected-state"),
    path.join(root, "project"),
  );
  const injectedServer = createArkTeamMcpServer(
    injectedStore,
    undefined,
    undefined,
    {
      advance: async () => {
        throw new Error("not called");
      },
    },
    {
      execute: async () => {
        throw new Error("not called");
      },
    },
  );
  new VerificationCoordinator(injectedStore);
  await injectedServer.close();
});

function verificationStore(
  stateRoot: string,
  projectRoot: string,
): RunStore {
  return new RunStore({
    root_path: stateRoot,
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
}

async function temporaryProject(t: TestContext): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "ark-team-local-runtime-"),
  );
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function isSpecDeltaBlock(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    error.code === "INVALID_TRANSITION" &&
    /SPEC_DELTA_REQUIRED/.test(error.message)
  );
}

function isAlreadyClaimed(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    error.code === "INVALID_TRANSITION" &&
    /already claimed/.test(error.message)
  );
}

async function assertPortCanBind(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
}
