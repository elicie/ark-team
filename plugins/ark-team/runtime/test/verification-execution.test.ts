import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import type { VerificationApiRuntimeRequest } from "../src/verification-api-adapter.js";
import type {
  VerificationAgenticBrowserRequest,
  VerificationAgenticBrowserRuntimeResult,
} from "../src/verification-agentic-browser-adapter.js";
import type {
  VerificationBrowserDriverRequest,
  VerificationBrowserDriverResult,
} from "../src/verification-browser-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  sha256CanonicalJson,
  type VerificationLinkedRecord,
  type VerificationRunSnapshot,
} from "../src/verification-contract.js";
import {
  VerificationCoordinator,
  type DeepReadonly,
} from "../src/verification-coordinator.js";
import {
  VERIFICATION_SEMANTIC_REVIEW_CHECKS,
  type VerificationSemanticReviewRequest,
  type VerificationSemanticReviewRuntimeResult,
} from "../src/verification-semantic-review-adapter.js";
import {
  encodeVerificationRgba8Png,
} from "../src/verification-png.js";
import type {
  VerificationScreenshotRuntimeRequest,
  VerificationScreenshotRuntimeResult,
} from "../src/verification-visual-adapter.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const CREATED_AT = "2026-07-27T20:00:00.000Z";
const TRACE_BYTES = Uint8Array.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);

test("IS-1705 connects registered API/browser requests to JSON and trace evidence records", async (t) => {
  const fakeServer = await startLocalFakeServer(t);
  let apiRequest: DeepReadonly<VerificationApiRuntimeRequest> | undefined;
  let browserRequest:
    | DeepReadonly<VerificationBrowserDriverRequest>
    | undefined;
  const fixture = await createFixture(t, {
    execute_api: async (request) => {
      apiRequest = request;
      return executeApiAgainstLocalServer(request);
    },
    execute_browser: async (request) => {
      browserRequest = request;
      assert.equal(await loadLocalPage(request.url), "<h1>Home</h1>");
      return validBrowserResult(request);
    },
  }, fakeServer.port);
  const snapshot = requireV2Snapshot(
    (await fixture.store.getRun(fixture.run_id)).verification_snapshot,
  );
  if (!snapshot.backend_contract.enabled || !snapshot.ui_contract.enabled) {
    assert.fail("execution fixture requires both verification lanes");
  }
  const probe = snapshot.backend_contract.api_probes[0]!;
  const browserCase = snapshot.ui_contract.browser_cases[0]!;

  const api = await fixture.coordinator.runApiProbe(fixture.run_id, {
    action_id: "execute-home-api",
    probe_id: probe.id,
  });
  if (!api.ok) {
    assert.fail(api.message);
  }
  assert.equal(api.ok, true);
  assert.ok(apiRequest);
  assert.equal(apiRequest.identity.snapshot_id, snapshot.snapshot_id);
  assert.deepEqual(apiRequest.identity.adapter, {
    name: snapshot.backend_contract.api_adapter,
    version: snapshot.backend_contract.api_adapter_version,
  });
  assert.equal(apiRequest.request.origin, snapshot.server.api_origin);
  assert.equal(apiRequest.execution.shell, false);
  assert.equal(apiRequest.request.proxy, false);
  assert.equal(apiRequest.request.credentials, "omit");
  assert.equal(apiRequest.request.redirect, "manual");

  const apiEvidenceBytes = await readArtifact(
    snapshot,
    api.value.evidence_artifact.relative_path,
  );
  assert.equal(
    sha256Bytes(apiEvidenceBytes),
    api.value.evidence_artifact.sha256,
  );
  assert.deepEqual(
    JSON.parse(apiEvidenceBytes.toString("utf8")),
    api.value.evidence,
  );

  const browser = await fixture.coordinator.runBrowserCase(fixture.run_id, {
    action_id: "execute-home-browser",
    case_id: browserCase.id,
  });
  if (!browser.ok) {
    assert.fail(browser.message);
  }
  assert.equal(browser.ok, true);
  assert.ok(browserRequest);
  assert.equal(browserRequest.snapshot_id, snapshot.snapshot_id);
  assert.equal(browserRequest.case_sha256, sha256CanonicalJson(browserCase));
  assert.deepEqual(browserRequest.adapter, {
    name: snapshot.ui_contract.deterministic_adapter,
    version: snapshot.ui_contract.deterministic_adapter_version,
  });
  assert.equal(browserRequest.origin, snapshot.server.api_origin);
  assert.deepEqual(browserRequest.execution, {
    cwd: snapshot.source.worktree_root,
    shell: false,
  });
  assert.equal(browserRequest.context.fresh, true);
  assert.equal(browserRequest.context.isolated, true);
  assert.equal(browserRequest.network.proxy, "disabled");
  assert.equal(browserRequest.policy.llm_verdict, "disabled");
  assert.equal(browserRequest.policy.screenshots, "disabled");

  const browserEvidenceBytes = await readArtifact(
    snapshot,
    browser.value.evidence_artifact.relative_path,
  );
  assert.equal(
    sha256Bytes(browserEvidenceBytes),
    browser.value.evidence_artifact.sha256,
  );
  assert.deepEqual(
    JSON.parse(browserEvidenceBytes.toString("utf8")),
    browser.value.evidence,
  );
  const traceBytes = await readArtifact(
    snapshot,
    browser.value.trace_artifact.relative_path,
  );
  assert.deepEqual([...traceBytes], [...TRACE_BYTES]);
  assert.equal(sha256Bytes(traceBytes), browser.value.trace_artifact.sha256);

  const run = await fixture.store.getRun(fixture.run_id);
  const requestRecord = findRecord(run.verification_records, "request", probe.id);
  assert.deepEqual(requestRecord.artifact_references, [
    api.value.evidence_artifact,
  ]);
  assert.equal(requestRecord.adapter?.name, "curl");
  if (requestRecord.payload.kind !== "request") {
    assert.fail("API evidence record has an unexpected payload");
  }
  assert.equal(
    requestRecord.payload.request_sha256,
    api.value.evidence.request_sha256,
  );
  assert.equal(
    requestRecord.payload.response_sha256,
    api.value.evidence.response_sha256,
  );

  const browserRecord = findRecord(
    run.verification_records,
    "browser",
    browserCase.id,
  );
  assert.deepEqual(browserRecord.artifact_references, [
    browser.value.evidence_artifact,
    browser.value.trace_artifact,
  ]);
  if (browserRecord.payload.kind !== "browser") {
    assert.fail("browser evidence record has an unexpected payload");
  }
  if (!("assertion_count" in browserRecord.payload)) {
    assert.fail("schema-2 browser evidence is missing assertion count");
  }
  assert.equal(browserRecord.payload.case_sha256, browserRequest.case_sha256);
  assert.equal(
    browserRecord.payload.assertion_count,
    browserRequest.assertions.length,
  );
  assert.deepEqual(
    fakeServer.requests.map(({ method, url, host }) => ({
      method,
      url,
      host,
    })),
    [
      {
        method: "GET",
        url: "/",
        host: `dev:${fakeServer.port}`,
      },
      {
        method: "GET",
        url: "/",
        host: `dev:${fakeServer.port}`,
      },
    ],
  );
});

test("IS-1706 persists screenshots, semantic review, comparison guard, and advisory agentic evidence", async (t) => {
  const fixture = await createFixture(
    t,
    {
      execute_api: async (request) => validApiResult(request),
      execute_browser: async (request) => validBrowserResult(request),
      execute_screenshots: async (request) => validScreenshotResult(request),
      semantic_review_active_turn: () => ({
        capability: "localImage",
        adapter: {
          name: "fixture-image-review",
          version: "1.0.0",
        },
      }),
      execute_semantic_review: async (request) =>
        validSemanticReviewResult(request),
      execute_agentic_browser: async (request) =>
        validAgenticResult(request),
    },
    10_001,
    true,
  );
  const snapshot = requireV2Snapshot(
    (await fixture.store.getRun(fixture.run_id)).verification_snapshot,
  );
  if (!snapshot.ui_contract.enabled) {
    assert.fail("visual execution fixture requires the UI lane");
  }
  const browserCase = snapshot.ui_contract.browser_cases[0]!;
  const task = snapshot.ui_contract.agentic_tasks[0]!;

  const browser = await fixture.coordinator.runBrowserCase(fixture.run_id, {
    action_id: "visual-browser",
    case_id: browserCase.id,
  });
  if (!browser.ok) {
    assert.fail(browser.message);
  }
  assert.equal(
    (await fixture.coordinator.advance(fixture.run_id, "collecting")).accepted,
    true,
  );

  const screenshots = await fixture.coordinator.runScreenshots(
    fixture.run_id,
    {
      action_id: "visual-screenshots",
      case_id: browserCase.id,
    },
  );
  if (!screenshots.ok) {
    assert.fail(screenshots.message);
  }
  assert.equal(screenshots.value.images.length, 3);
  for (const image of screenshots.value.images) {
    assert.equal(
      sha256Bytes(
        await readArtifact(snapshot, image.artifact.relative_path),
      ),
      image.artifact.sha256,
    );
  }
  const comparisonInputs = {
    actuals: screenshots.value.images.map((image) => ({
      evidence: image.evidence,
      png_bytes: image.png_bytes,
    })),
    baseline_png_bytes: Object.fromEntries(
      screenshots.value.images.map((image) => [
        image.evidence.viewport,
        image.png_bytes,
      ]),
    ) as {
      "375x812": Uint8Array;
      "768x1024": Uint8Array;
      "1440x900": Uint8Array;
    },
  };
  await assert.rejects(
    () =>
      fixture.coordinator.runComparison(fixture.run_id, {
        action_id: "forged-semantic-approval",
        case_id: browserCase.id,
        ...comparisonInputs,
        semantic_review_outcome: "approved",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_RECORD",
  );

  const review = await fixture.coordinator.runSemanticReview(
    fixture.run_id,
    {
      action_id: "visual-review",
      case_id: browserCase.id,
      screenshot_paths: screenshots.value.images.map((image) =>
        path.join(snapshot.artifact_root, image.artifact.relative_path),
      ),
      checklist: {
        identity: "ui-visual-review",
        version: "1.0.0",
      },
    },
  );
  if (!review.ok) {
    assert.fail(review.message);
  }
  assert.equal(review.value.outcome, "approved");

  const comparison = await fixture.coordinator.runComparison(
    fixture.run_id,
    {
      action_id: "visual-comparison-no-baseline",
      case_id: browserCase.id,
      ...comparisonInputs,
      semantic_review_outcome: review.value.outcome,
    },
  );
  assert.equal(comparison.ok, false);
  if (!comparison.ok) {
    assert.equal(comparison.code, "BASELINE_NOT_APPROVED");
  }

  const agentic = await fixture.coordinator.runAgenticBrowser(
    fixture.run_id,
    {
      action_id: "visual-agentic",
      task_id: task.id,
    },
  );
  if (!agentic.ok) {
    assert.fail(agentic.message);
  }
  assert.equal(agentic.value.evidence.can_pass_ui_lane, false);
  assert.equal(agentic.value.evidence.deterministic_recheck.required, true);
  assert.equal(agentic.value.evidence.deterministic_recheck.status, "passed");

  const run = await fixture.store.getRun(fixture.run_id);
  assert.equal(
    run.verification_records.filter(
      (record) => record.record_type === "screenshot",
    ).length,
    3,
  );
  assert.equal(
    run.verification_records.filter(
      (record) => record.record_type === "review",
    ).length,
    3,
  );
  const agenticRecord = findRecord(
    run.verification_records,
    "agentic_browser",
    task.id,
  );
  assert.equal(agenticRecord.stage, "collecting");
  assert.equal(agenticRecord.check_required, false);
  assert.equal(agenticRecord.artifact_references.length, 4);
});

test("TEST-1710 fails closed when the registered browser runtime is missing", async (t) => {
  const fixture = await createFixture(t, {
    execute_api: async (request) => ({
      request_sha256: request.request_sha256,
      url: request.request.url,
      status: request.request.expected_status,
      headers: {
        "content-type": request.request.expected_content_type,
      },
      body: new Uint8Array(),
      elapsed_ms: 1,
    }),
  });

  const result = await fixture.coordinator.runBrowserCase(fixture.run_id, {
    action_id: "missing-browser-runtime",
    case_id: "home-browser",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "CAPABILITY_UNAVAILABLE");
  }
  const run = await fixture.store.getRun(fixture.run_id);
  assert.equal(
    run.verification_records.some(
      (record) =>
        record.record_type === "browser" ||
        (record.schema_version === 2 &&
          record.payload.kind === "artifact" &&
          record.lane === "ui"),
    ),
    false,
  );
  assert.equal(
    run.verification_state?.attempts.find(
      (attempt) => attempt.action_id === "missing-browser-runtime",
    )?.attempt_count,
    2,
  );
});

test("TEST-1708 ignores a late aborted API runtime without creating evidence", async (t) => {
  let calls = 0;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  let resolveLate!: () => void;
  const firstStart = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const secondStart = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const fixture = await createFixture(t, {
    execute_api: async (request) => {
      calls += 1;
      const result = validApiResult(request);
      if (calls === 1) {
        firstStarted();
        return new Promise((resolve) => {
          resolveLate = () => resolve(result);
        });
      }
      secondStarted();
      return result;
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });

  try {
    const resultPromise = fixture.coordinator.runApiProbe(fixture.run_id, {
      action_id: "late-api-runtime",
      probe_id: "home-api",
    });
    await firstStart;
    t.mock.timers.tick(30_000);
    await secondStart;
    const result = await resultPromise;
    if (!result.ok) {
      assert.fail(result.message);
    }
    resolveLate();
    await Promise.resolve();

    const expectedToken = sha256CanonicalJson({
      action_id: "late-api-runtime",
      attempt: 2,
      probe_id: "home-api",
    }).slice(0, 24);
    assert.equal(
      result.value.evidence_artifact.relative_path,
      `api/home-api/${expectedToken}.json`,
    );
    const run = await fixture.store.getRun(fixture.run_id);
    assert.equal(
      run.verification_records.filter(
        (record) =>
          record.schema_version === 2 &&
          record.record_type === "artifact" &&
          record.lane === "backend",
      ).length,
      1,
    );
    assert.equal(
      run.verification_records.filter(
        (record) => record.record_type === "request",
      ).length,
      1,
    );
  } finally {
    t.mock.timers.reset();
  }
});

interface ExecutionFixture {
  store: RunStore;
  coordinator: VerificationCoordinator;
  run_id: string;
}

async function createFixture(
  t: TestContext,
  effects: {
    execute_api: NonNullable<
      Parameters<VerificationCoordinator["registerLocalRuntime"]>[0]["execute_api"]
    >;
    execute_browser?: NonNullable<
      Parameters<VerificationCoordinator["registerLocalRuntime"]>[0]["execute_browser"]
    >;
    execute_screenshots?: NonNullable<
      Parameters<VerificationCoordinator["registerLocalRuntime"]>[0]["execute_screenshots"]
    >;
    semantic_review_active_turn?: NonNullable<
      Parameters<VerificationCoordinator["registerLocalRuntime"]>[0]["semantic_review_active_turn"]
    >;
    execute_semantic_review?: NonNullable<
      Parameters<VerificationCoordinator["registerLocalRuntime"]>[0]["execute_semantic_review"]
    >;
    execute_agentic_browser?: NonNullable<
      Parameters<VerificationCoordinator["registerLocalRuntime"]>[0]["execute_agentic_browser"]
    >;
  },
  serverPort = 10_001,
  includeAgentic = false,
): Promise<ExecutionFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-execution-1705-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);

  const verification = validVerificationCoordinatorConfig();
  if (!verification.ui.enabled) {
    assert.fail("verification fixture UI lane is disabled");
  }
  if (!includeAgentic) {
    verification.ui.agentic_tasks = [];
    verification.ui.optional_capabilities = [];
  }
  const projectConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  projectConfig.verification.coordinator = verification;

  const store = new RunStore({
    root_path: stateRoot,
    now: () => new Date(CREATED_AT),
    suffix: () => "170500",
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
  const created = await store.createRun({
    objective: "IS-1705 deterministic execution integration",
    project_path: projectRoot,
    project_config: projectConfig,
  });
  const coordinator = new VerificationCoordinator(store);
  const capabilityAdapters = {
    agentic_browser: { name: "browser-use", version: "0.13.6" },
    api: {
      name: verification.backend.enabled
        ? verification.backend.api_adapter
        : "curl",
      version: verification.backend.enabled
        ? verification.backend.api_adapter_version
        : "8.14.1",
    },
    browser: {
      name: verification.ui.deterministic_adapter,
      version: verification.ui.deterministic_adapter_version,
    },
    comparison: { name: "fixture-comparison", version: "1.0.0" },
    screenshot: {
      name: verification.ui.deterministic_adapter,
      version: verification.ui.deterministic_adapter_version,
    },
    semantic_review: { name: "fixture-image-review", version: "1.0.0" },
    server: { name: "fixture-server", version: "1.0.0" },
  } as const;
  coordinator.registerLocalRuntime({
    port_available: async () => true,
    capability_adapters: capabilityAdapters,
    capability_probe: async (capability) => ({
      available: true,
      version: capabilityAdapters[capability].version,
      diagnostic: `${capability} available`,
      adapter: capabilityAdapters[capability],
    }),
    start_server: async () => undefined,
    probe_http: async () => ({ status: 200 }),
    execute_local: async () => undefined,
    execute_api: effects.execute_api,
    ...(effects.execute_browser === undefined
      ? {}
      : { execute_browser: effects.execute_browser }),
    ...(effects.execute_screenshots === undefined
      ? {}
      : { execute_screenshots: effects.execute_screenshots }),
    ...(effects.semantic_review_active_turn === undefined
      ? {}
      : {
          semantic_review_active_turn:
            effects.semantic_review_active_turn,
        }),
    ...(effects.execute_semantic_review === undefined
      ? {}
      : { execute_semantic_review: effects.execute_semantic_review }),
    ...(effects.execute_agentic_browser === undefined
      ? {}
      : { execute_agentic_browser: effects.execute_agentic_browser }),
  });

  assert.equal(
    (await coordinator.advance(created.run_id, "configured")).accepted,
    true,
  );
  const snapshotted = await coordinator.configure(created.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: serverPort,
  });
  assert.equal(
    snapshotted.verification_state?.current_state,
    "snapshotted",
  );
  assert.equal(
    (await coordinator.advance(created.run_id, "capabilities")).accepted,
    true,
  );
  const readiness = await coordinator.runReadiness(created.run_id, {
    action_id: "execution-readiness",
    server: { framework: "other", allowed_dev_origins: [] },
  });
  assert.equal(readiness.ok, true);
  for (const stage of ["ready", "executing"] as const) {
    assert.equal(
      (await coordinator.advance(created.run_id, stage)).accepted,
      true,
    );
  }
  return { store, coordinator, run_id: created.run_id };
}

function validBrowserResult(
  request: DeepReadonly<VerificationBrowserDriverRequest>,
): VerificationBrowserDriverResult {
  return {
    schema_version: 1,
    contract_id: "verification_browser_driver_result_v1",
    case_id: request.case_id,
    case_sha256: request.case_sha256,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    origin: request.origin,
    final_url: request.url,
    context: structuredClone(request.context) as VerificationBrowserDriverRequest["context"],
    elapsed_ms: 25,
    readiness: {
      passed: true,
      elapsed_ms: 5,
      message: null,
    },
    actions: request.actions.map(({ sequence, action }) => ({
      sequence,
      input_sha256: sha256CanonicalJson(action),
      passed: true,
      elapsed_ms: 1,
      message: null,
    })),
    assertions: request.assertions.map(({ sequence, assertion }) => ({
      sequence,
      input_sha256: sha256CanonicalJson(assertion),
      passed: true,
      elapsed_ms: 2,
      message: null,
    })),
    navigation: [
      {
        sequence: 0,
        url: request.url,
        status: 200,
        elapsed_ms: 4,
      },
    ],
    console: [],
    page_errors: [],
    dialogs: [],
    trace: {
      relative_path: request.trace.relative_path,
      media_type: request.trace.media_type,
      sha256: sha256Bytes(TRACE_BYTES),
      bytes: TRACE_BYTES,
    },
    passed: true,
    message: "declared deterministic assertions passed",
  };
}

function validApiResult(
  request: DeepReadonly<VerificationApiRuntimeRequest>,
) {
  return {
    request_sha256: request.request_sha256,
    url: request.request.url,
    status: request.request.expected_status,
    headers: {
      "content-type": request.request.expected_content_type,
    },
    body: new TextEncoder().encode("<h1>Home</h1>"),
    elapsed_ms: 12,
  };
}

function validScreenshotResult(
  request: DeepReadonly<VerificationScreenshotRuntimeRequest>,
): VerificationScreenshotRuntimeResult {
  return {
    schema_version: 1,
    contract_id: "verification_screenshot_runtime_result_v1",
    run_id: request.run_id,
    snapshot_id: request.snapshot_id,
    case_id: request.case_id,
    attempt_id: request.attempt_id,
    case_sha256: request.case_sha256,
    package_fingerprint: request.package_fingerprint,
    source_fingerprint: request.source_fingerprint,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    origin: request.origin,
    url: request.url,
    screenshots: request.captures.map((capture) => {
      const rgba = new Uint8Array(capture.width * capture.height * 4);
      rgba.fill(255);
      const bytes = encodeVerificationRgba8Png({
        width: capture.width,
        height: capture.height,
        rgba,
      });
      return {
        sequence: capture.sequence,
        viewport: capture.viewport,
        width: capture.width,
        height: capture.height,
        device_scale_factor: 1,
        url: capture.url,
        relative_path: capture.relative_path,
        media_type: "image/png",
        captured_at_utc: "2026-07-27T20:00:01.000Z",
        byte_length: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        capture: {
          browser_chrome: "excluded",
          full_page: false,
          resized: false,
          cropped: false,
          converted: false,
          color_space_converted: false,
          alpha_normalized: false,
          post_processed: false,
        },
        bytes,
      };
    }),
  };
}

function validSemanticReviewResult(
  request: DeepReadonly<VerificationSemanticReviewRequest>,
): VerificationSemanticReviewRuntimeResult {
  return {
    schema_version: 1,
    contract_id: "verification_semantic_review_result_v1",
    input_sha256: request.input_sha256,
    adapter: { ...request.identity.adapter },
    checklist: {
      identity: request.checklist.identity,
      version: request.checklist.version,
      sha256: request.checklist.sha256,
    },
    reviewed_at_utc: "2026-07-27T20:00:02.000Z",
    outcome: "approved",
    observations: VERIFICATION_SEMANTIC_REVIEW_CHECKS.map((check) => ({
      check,
      observation: `${check} 이상 없음`,
    })),
  };
}

function validAgenticResult(
  request: DeepReadonly<VerificationAgenticBrowserRequest>,
): VerificationAgenticBrowserRuntimeResult {
  return {
    schema_version: 1,
    contract_id: "verification_agentic_browser_result_v1",
    task_id: request.task_id,
    task_sha256: request.task_sha256,
    input_sha256: request.input_sha256,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    model_identity: request.model_identity,
    origin: request.origin,
    execution_status: "completed",
    finding_status: "no_finding",
    self_verdict: "achieved",
    judge_verdict: "unknown",
    findings: [],
    ledger: [
      {
        sequence: 0,
        action: request.allowed_actions[0]!,
        url: request.start_url,
        parameters: { path: "/" },
        result: "completed",
        error_code: null,
        artifact_references: [],
        timestamp_utc: "2026-07-27T20:00:03.500Z",
      },
    ],
    candidates: [
      {
        kind: "test",
        relative_path: `agentic/${request.task_id}/candidates/test.json`,
        sha256: "d".repeat(64),
        applied: false,
      },
    ],
    started_at_utc: "2026-07-27T20:00:03.000Z",
    finished_at_utc: "2026-07-27T20:00:04.000Z",
    elapsed_ms: 1_000,
  };
}

function requireV2Snapshot(
  snapshot: VerificationRunSnapshot | null,
): VerificationRunSnapshot & { schema_version: 2 } {
  if (snapshot === null || snapshot.schema_version !== 2) {
    throw new Error("contract-v2 verification snapshot is required");
  }
  return snapshot;
}

function findRecord(
  records: readonly VerificationLinkedRecord[],
  recordType: "request" | "browser" | "agentic_browser",
  checkId: string,
): Extract<VerificationLinkedRecord, { schema_version: 2 }> {
  const record = records.find(
    (candidate) =>
      candidate.schema_version === 2 &&
      candidate.record_type === recordType &&
      candidate.check_id === checkId,
  );
  if (record === undefined || record.schema_version !== 2) {
    throw new Error(`${recordType} evidence record is missing`);
  }
  return record;
}

function readArtifact(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  relativePath: string,
): Promise<Buffer> {
  return readFile(path.join(snapshot.artifact_root, relativePath));
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface LocalFakeServer {
  server: Server;
  port: number;
  requests: Array<{
    method: string;
    url: string;
    host: string;
  }>;
}

async function startLocalFakeServer(
  t: TestContext,
): Promise<LocalFakeServer> {
  const requests: LocalFakeServer["requests"] = [];
  for (let port = 10_001; port <= 10_100; port += 1) {
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        host: request.headers.host ?? "",
      });
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Home</h1>");
    });
    try {
      await listen(server, port);
      t.after(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          }),
      );
      return { server, port, requests };
    } catch (error) {
      server.removeAllListeners();
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE"
      ) {
        throw error;
      }
    }
  }
  throw new Error("no local fake-server port is available at or above 10001");
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "0.0.0.0", port, exclusive: true });
  });
}

async function executeApiAgainstLocalServer(
  request: DeepReadonly<VerificationApiRuntimeRequest>,
) {
  const startedAt = Date.now();
  const response = await requestLocal(
    request.request.url,
    request.request.method,
    Object.fromEntries(request.request.headers),
    request.execution.stdin,
  );
  return {
    request_sha256: request.request_sha256,
    url: request.request.url,
    status: response.status,
    headers: response.headers,
    body: response.body,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
  };
}

async function loadLocalPage(url: string): Promise<string> {
  const response = await requestLocal(url, "GET", {}, null);
  assert.equal(response.status, 200);
  return response.body.toString("utf8");
}

function requestLocal(
  value: string,
  method: string,
  headers: Readonly<Record<string, string>>,
  body: DeepReadonly<Uint8Array> | null,
): Promise<{
  status: number;
  headers: Record<string, string | readonly string[]>;
  body: Buffer;
}> {
  const url = new URL(value);
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        hostname: "127.0.0.1",
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...headers,
          host: url.host,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          resolve({
            status: requiredStatus(response),
            headers: responseHeaders(response),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.once("error", reject);
    if (body !== null) {
      request.write(Buffer.from(body));
    }
    request.end();
  });
}

function requiredStatus(response: IncomingMessage): number {
  if (response.statusCode === undefined) {
    throw new Error("local fake server returned no status");
  }
  return response.statusCode;
}

function responseHeaders(
  response: IncomingMessage,
): Record<string, string | readonly string[]> {
  return Object.fromEntries(
    Object.entries(response.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}
