import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createVerificationBrowserDriverRequest,
  normalizeVerificationBrowserDriverResult,
  VerificationBrowserContractError,
  type VerificationBrowserDriverRequest,
  type VerificationBrowserDriverResult,
} from "../src/verification-browser-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  buildVerificationRunSnapshot,
  sha256CanonicalJson,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

test("TEST-1710 fixes the fresh deterministic Chromium request to the snapshot", () => {
  const request = createRequest();

  assert.equal(request.engine, "chromium");
  assert.deepEqual(request.execution, {
    cwd: "/tmp/ark-team-project",
    shell: false,
  });
  assert.deepEqual(request.context, {
    fresh: true,
    isolated: true,
    device_scale_factor: 1,
    locale: "en-US",
    timezone: "UTC",
    color_scheme: "light",
    reduced_motion: "no-preference",
    viewports: [
      { name: "375x812", width: 375, height: 812 },
      { name: "768x1024", width: 768, height: 1_024 },
      { name: "1440x900", width: 1_440, height: 900 },
    ],
  });
  assert.equal(request.origin, "http://dev:10001");
  assert.equal(request.url, "http://dev:10001/");
  assert.deepEqual(request.network, {
    allowed_origin: "http://dev:10001",
    redirects: "same-origin-only",
    proxy: "disabled",
    credentials: "omit",
  });
  assert.deepEqual(request.readiness, {
    selector: "body",
    timeout_ms: 60_000,
    wait: "auto",
  });
  assert.equal(request.auto_wait_timeout_ms, 60_000);
  assert.equal(request.case_timeout_ms, 120_000);
  assert.deepEqual(request.actions, [
    {
      sequence: 0,
      action: { type: "click", selector: "[data-testid=menu]" },
    },
    {
      sequence: 1,
      action: {
        type: "wait_for_selector",
        selector: "[data-testid=ready]",
      },
    },
  ]);
  assert.deepEqual(
    request.assertions.map(({ sequence, assertion }) => ({
      sequence,
      assertion,
    })),
    [
      {
        sequence: 0,
        assertion: { kind: "visible", role: "heading", name: "Home" },
      },
    ],
  );
  assert.deepEqual(request.trace, {
    enabled: true,
    relative_path:
      "traces/home-browser/browser-attempt-1.playwright-trace.zip",
    media_type: "application/zip",
  });
  assert.deepEqual(request.policy, {
    llm_verdict: "disabled",
    visual_assertions: "disabled",
    screenshots: "disabled",
    self_heal: "disabled",
    baseline_update: "disabled",
    undeclared_actions: "disabled",
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.context.viewports), true);
});

test("TEST-1710 accepts exact ordered evidence, redacts it, and separates trace bytes", () => {
  const request = createRequest();
  const raw = validResult(request);
  raw.console.push({
    sequence: 0,
    level: "warn",
    message: "authorization: bearer-secret user@example.com",
  });
  raw.page_errors.push({
    sequence: 0,
    message: "token=secret-value",
  });
  raw.navigation.push({
    sequence: 1,
    url:
      "http://dev:10001/search?q=user@example.com&note=navigation-secret",
    status: 200,
    elapsed_ms: 2,
  });
  raw.final_url = raw.navigation[1]!.url;

  const normalized = normalizeVerificationBrowserDriverResult(request, raw);

  assert.equal(normalized.passed, true);
  assert.equal(normalized.evidence.passed, true);
  assert.equal(
    normalized.evidence.assertions[0]?.input_sha256,
    sha256CanonicalJson(request.assertions[0]!.assertion),
  );
  assert.equal(normalized.evidence.console[0]?.message.includes("bearer-secret"), false);
  assert.equal(normalized.evidence.console[0]?.message.includes("user@example.com"), false);
  assert.equal(normalized.evidence.page_errors[0]?.message.includes("secret-value"), false);
  assert.doesNotMatch(
    JSON.stringify({
      final_url: normalized.evidence.final_url,
      navigation: normalized.evidence.navigation,
    }),
    /user@example\.com|navigation-secret/,
  );
  assert.deepEqual(normalized.trace_bytes, raw.trace.bytes);
  assert.equal("bytes" in normalized.evidence.trace, false);
  assert.equal(
    normalized.evidence.trace.byte_length,
    normalized.trace_bytes.byteLength,
  );
});

test("TEST-1710 preserves a bounded deterministic assertion failure as non-pass", () => {
  const request = createRequest();
  const raw = validResult(request);
  raw.assertions[0] = {
    ...raw.assertions[0]!,
    passed: false,
    message: "heading was not visible; cookie=session-secret",
  };
  raw.passed = false;
  raw.message = "declared assertion failed";

  const normalized = normalizeVerificationBrowserDriverResult(request, raw);

  assert.equal(normalized.passed, false);
  assert.equal(normalized.evidence.assertions[0]?.passed, false);
  assert.equal(
    normalized.evidence.assertions[0]?.message?.includes("session-secret"),
    false,
  );
  assert.equal(normalized.message, "declared assertion failed");
});

test("TEST-1710 rejects cross-origin, undeclared, visual/LLM/heal/baseline, and unbounded results", () => {
  const request = createRequest();
  const cases: Array<{
    name: string;
    mutate: (result: Record<string, unknown>) => void;
  }> = [
    {
      name: "cross-origin navigation",
      mutate: (result) => {
        (result.navigation as Array<Record<string, unknown>>)[0]!.url =
          "https://example.com/";
        result.final_url = "https://example.com/";
      },
    },
    {
      name: "missing assertion",
      mutate: (result) => {
        result.assertions = [];
      },
    },
    {
      name: "reordered action",
      mutate: (result) => {
        const actions = result.actions as Array<Record<string, unknown>>;
        const firstHash = actions[0]!.input_sha256;
        actions[0]!.input_sha256 = actions[1]!.input_sha256;
        actions[1]!.input_sha256 = firstHash;
      },
    },
    {
      name: "undeclared assertion",
      mutate: (result) => {
        (result.assertions as Array<Record<string, unknown>>)[0]!.input_sha256 =
          "f".repeat(64);
      },
    },
    {
      name: "LLM verdict",
      mutate: (result) => {
        result.llm_verdict = "passed";
      },
    },
    {
      name: "visual assertion",
      mutate: (result) => {
        result.screenshot_assertion = { baseline: "auto" };
      },
    },
    {
      name: "automatic healer",
      mutate: (result) => {
        result.healed_selector = "#generated";
      },
    },
    {
      name: "baseline update",
      mutate: (result) => {
        result.baseline_update = true;
      },
    },
    {
      name: "unbounded result",
      mutate: (result) => {
        result.message = "x".repeat(1_001);
      },
    },
    {
      name: "context substitution",
      mutate: (result) => {
        (result.context as Record<string, unknown>).locale = "ko-KR";
      },
    },
  ];

  for (const fixture of cases) {
    const result = validResult(request) as unknown as Record<string, unknown>;
    fixture.mutate(result);
    assert.throws(
      () => normalizeVerificationBrowserDriverResult(request, result),
      isBrowserContractError,
      fixture.name,
    );
  }
});

test("TEST-1710 rejects invalid input cases instead of inferring browser behavior", () => {
  const snapshot = validSnapshot() as unknown as Record<string, unknown>;
  const ui = snapshot.ui_contract as Record<string, unknown>;
  const browserCases = ui.browser_cases as Array<Record<string, unknown>>;
  browserCases[0]!.assertions = [
    {
      kind: "screenshot",
      baseline: "auto",
    },
  ];

  assert.throws(
    () =>
      createVerificationBrowserDriverRequest({
        snapshot,
        case_id: "home-browser",
        attempt_id: "browser-attempt-1",
      }),
    isBrowserContractError,
  );
  assert.throws(
    () =>
      createVerificationBrowserDriverRequest({
        snapshot: validSnapshot(),
        case_id: "undeclared-browser-case",
        attempt_id: "browser-attempt-1",
      }),
    isBrowserContractError,
  );
});

function createRequest(): VerificationBrowserDriverRequest {
  return createVerificationBrowserDriverRequest({
    snapshot: validSnapshot(),
    case_id: "home-browser",
    attempt_id: "browser-attempt-1",
  });
}

function validSnapshot() {
  const config = validVerificationCoordinatorConfig();
  if (!config.ui.enabled) {
    throw new Error("browser fixture requires the UI lane");
  }
  config.ui.browser_cases[0]!.actions = [
    { type: "click", selector: "[data-testid=menu]" },
    {
      type: "wait_for_selector",
      selector: "[data-testid=ready]",
    },
  ];
  return buildVerificationRunSnapshot({
    run_id: "ark-20260727t000000z-170510",
    project_path: "/tmp/ark-team-project",
    artifact_root:
      "/tmp/ark-team-state/ark-20260727t000000z-170510/verification",
    server_port: 10_001,
    created_at_utc: "2026-07-27T00:00:00.000Z",
    package_fingerprint: APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    source: validVerificationSourceIdentity(),
    config,
  });
}

function validResult(
  request: VerificationBrowserDriverRequest,
): Mutable<VerificationBrowserDriverResult> {
  const traceBytes = Uint8Array.from([80, 75, 3, 4]);
  return {
    schema_version: 1,
    contract_id: "verification_browser_driver_result_v1",
    case_id: request.case_id,
    case_sha256: request.case_sha256,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    origin: request.origin,
    final_url: request.url,
    context: structuredClone(request.context) as Mutable<
      VerificationBrowserDriverRequest["context"]
    >,
    elapsed_ms: 50,
    readiness: {
      passed: true,
      elapsed_ms: 10,
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
      elapsed_ms: 5,
      message: null,
    })),
    navigation: [
      {
        sequence: 0,
        url: request.url,
        status: 200,
        elapsed_ms: 8,
      },
    ],
    console: [],
    page_errors: [],
    dialogs: [],
    trace: {
      relative_path: request.trace.relative_path,
      media_type: "application/zip",
      sha256: createHash("sha256").update(traceBytes).digest("hex"),
      bytes: traceBytes,
    },
    passed: true,
    message: "all declared deterministic assertions passed",
  };
}

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Element)[]
    ? Mutable<Element>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

function isBrowserContractError(error: unknown): boolean {
  return (
    error instanceof VerificationBrowserContractError &&
    error.code === "BROWSER_CONTRACT_MISMATCH"
  );
}
