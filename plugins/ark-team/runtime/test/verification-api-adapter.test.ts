import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  VerificationApiAdapterError,
  createVerificationApiRequest,
  normalizeVerificationApiResult,
  type VerificationApiRuntimeRequest,
  type VerificationApiRuntimeResult,
} from "../src/verification-api-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  buildVerificationRunSnapshot,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const BODY = Buffer.from('{"name":"fixture"}', "utf8");
const BODY_SHA256 = createHash("sha256").update(BODY).digest("hex");

test("TEST-1709 builds one literal local curl request and normalizes bounded redacted evidence", () => {
  const request = createRequest();

  assert.deepEqual(request.request.query, [
    ["a", "x&y"],
    ["b", "two words"],
  ]);
  assert.equal(
    request.request.url,
    "http://dev:10001/items?a=x%26y&b=two+words",
  );
  assert.equal(request.execution.shell, false);
  assert.equal(request.request.proxy, false);
  assert.equal(request.request.credentials, "omit");
  assert.equal(request.request.redirect, "manual");
  assert.equal(request.request.max_redirects, 0);
  assert.deepEqual(
    request.execution.stdin === null
      ? null
      : [...request.execution.stdin],
    [...BODY],
  );
  assert.ok(request.execution.argv.includes("--proxy"));
  assert.ok(request.execution.argv.includes("--noproxy"));
  assert.ok(request.execution.argv.includes("--max-redirs"));
  assert.equal(request.execution.argv[1], "--disable");
  assert.ok(
    request.execution.argv.includes(
      "x-literal: $(touch /tmp/should-not-exist); echo",
    ),
  );
  assert.equal(request.identity.adapter.name, "curl");
  assert.equal(request.identity.probe_id, "create-item");
  assert.equal(request.identity.probe_required, true);
  assert.equal(request.identity.probe_sha256.length, 64);

  const body = Buffer.from(
    "ok token=abcdefghijklmnopqrstuvwxyz123456 user@example.com",
    "utf8",
  );
  const normalized = normalizeVerificationApiResult(
    request,
    runtimeResult(request, {
      body,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "session=abcdefghijklmnopqrstuvwxyz123456",
        "X-Request-Id": "fixture-1",
      },
    }),
  );

  assert.equal(normalized.passed, true);
  assert.equal(normalized.error_code, null);
  assert.equal(normalized.evidence.actual_status, 201);
  assert.equal(
    normalized.evidence.actual_content_type,
    "application/json; charset=utf-8",
  );
  assert.equal(
    normalized.evidence.body_sha256,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(normalized.evidence.response_sha256?.length, 64);
  assert.equal(normalized.evidence.elapsed_ms, 27);
  assert.doesNotMatch(normalized.evidence.body_preview, /user@example\.com/);
  assert.doesNotMatch(
    normalized.evidence.body_preview,
    /abcdefghijklmnopqrstuvwxyz123456/,
  );
  assert.ok(normalized.evidence.body_preview.includes("<redacted>"));
  assert.deepEqual(
    normalized.evidence.headers.find(
      (header) => header.name === "set-cookie",
    ),
    { name: "set-cookie", value: "<redacted>" },
  );
  assert.deepEqual(normalized.evidence.identity, request.identity);
  assert.equal(normalized.evidence.request_sha256, request.request_sha256);
});

test("TEST-1709 rejects absent or mismatched request body bytes before runtime execution", () => {
  assertApiError(
    () => createRequest(null),
    "API_CONTRACT_MISMATCH",
  );
  assertApiError(
    () => createRequest(Buffer.from("different", "utf8")),
    "API_CONTRACT_MISMATCH",
  );

  const noBodyConfig = validVerificationCoordinatorConfig();
  noBodyConfig.ui = { enabled: false };
  if (!noBodyConfig.backend.enabled) {
    assert.fail("fixture backend lane is disabled");
  }
  const noBodySnapshot = buildSnapshot(noBodyConfig);
  if (!noBodySnapshot.backend_contract.enabled) {
    assert.fail("snapshot backend lane is disabled");
  }
  const noBodyProbeId = noBodySnapshot.backend_contract.api_probes[0]!.id;
  assertApiError(
    () =>
      createVerificationApiRequest(
        noBodySnapshot,
        noBodyProbeId,
        new Uint8Array(),
      ),
    "API_CONTRACT_MISMATCH",
  );
});

test("TEST-1709 reports strict status, content-type, redirect, and result-shape mismatches with evidence", () => {
  const request = createRequest();

  const status = normalizeVerificationApiResult(
    request,
    runtimeResult(request, { status: 500 }),
  );
  assert.equal(status.passed, false);
  assert.equal(status.error_code, "API_CONTRACT_MISMATCH");
  assert.equal(status.evidence.actual_status, 500);
  assert.equal(status.evidence.response_sha256?.length, 64);

  const contentType = normalizeVerificationApiResult(
    request,
    runtimeResult(request, {
      headers: { "Content-Type": "text/html" },
    }),
  );
  assert.equal(contentType.passed, false);
  assert.match(contentType.message ?? "", /content type/);

  const redirect = normalizeVerificationApiResult(
    request,
    runtimeResult(request, {
      headers: {
        "Content-Type": "application/json",
        Location:
          "https://example.invalid/stolen?token=redirect-secret",
      },
    }),
  );
  assert.equal(redirect.passed, false);
  assert.match(redirect.message ?? "", /cross-origin/);
  assert.ok(redirect.evidence.observed_url);
  const observedUrl = new URL(redirect.evidence.observed_url);
  assert.equal(observedUrl.origin, request.request.origin);
  assert.equal(observedUrl.pathname, request.request.path);
  assert.deepEqual(
    [...observedUrl.searchParams.values()],
    ["<redacted>", "<redacted>"],
  );
  assert.doesNotMatch(
    JSON.stringify(redirect.evidence.headers),
    /redirect-secret/,
  );

  const credentialed = normalizeVerificationApiResult(
    request,
    runtimeResult(request, {
      url: "http://user:password@dev:10001/items?token=url-secret",
    }),
  );
  assert.equal(credentialed.passed, false);
  assert.doesNotMatch(
    credentialed.evidence.observed_url ?? "",
    /user|password|url-secret/,
  );

  const invalid = normalizeVerificationApiResult(request, {
    ...runtimeResult(request),
    unexpected: true,
  });
  assert.equal(invalid.passed, false);
  assert.equal(invalid.error_code, "INVALID_RECORD");
  assert.equal(invalid.evidence.response_sha256, null);

  const changedRequest = structuredClone(request);
  changedRequest.request.url = "http://dev:10001/other";
  const changed = normalizeVerificationApiResult(
    changedRequest,
    runtimeResult(changedRequest),
  );
  assert.equal(changed.passed, false);
  assert.equal(changed.error_code, "INVALID_RECORD");
});

test("TEST-1709 bounds body preview, headers, and oversized response evidence", () => {
  const request = createRequest();
  const previewBody = Buffer.from(
    "safe text ".repeat(
      Math.ceil((request.limits.max_preview_bytes + 1_024) / 10),
    ),
    "utf8",
  );
  const preview = normalizeVerificationApiResult(
    request,
    runtimeResult(request, { body: previewBody }),
  );
  assert.equal(preview.passed, true);
  assert.equal(preview.evidence.body_preview_truncated, true);
  assert.ok(
    preview.evidence.body_preview_bytes <= request.limits.max_preview_bytes,
  );

  const tooManyHeaders = Object.fromEntries(
    Array.from(
      { length: request.limits.max_header_count + 1 },
      (_, index) => [`x-fixture-${index}`, `${index}`],
    ),
  );
  tooManyHeaders["content-type"] = "application/json";
  const headers = normalizeVerificationApiResult(
    request,
    runtimeResult(request, { headers: tooManyHeaders }),
  );
  assert.equal(headers.passed, false);
  assert.match(headers.message ?? "", /header count/);
  assert.ok(
    Buffer.byteLength(JSON.stringify(headers.evidence.headers), "utf8") <=
      request.limits.max_metadata_bytes,
  );

  const oversized = new Uint8Array(request.limits.max_response_bytes + 1);
  const body = normalizeVerificationApiResult(
    request,
    runtimeResult(request, { body: oversized }),
  );
  assert.equal(body.passed, false);
  assert.match(body.message ?? "", /body exceeds/);
  assert.equal(body.evidence.body_preview, "<redacted:oversized-response>");
  assert.equal(body.evidence.body_preview_truncated, true);
  assert.equal(body.evidence.body_sha256?.length, 64);
});

function createRequest(
  bodyBytes: Uint8Array | null = BODY,
): VerificationApiRuntimeRequest {
  const config = validVerificationCoordinatorConfig();
  config.ui = { enabled: false };
  if (!config.backend.enabled) {
    assert.fail("fixture backend lane is disabled");
  }
  config.backend.api_probes = [
    {
      id: "create-item",
      method: "POST",
      path: "/items",
      query: {
        b: "two words",
        a: "x&y",
      },
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-literal": "$(touch /tmp/should-not-exist); echo",
      },
      body_digest: BODY_SHA256,
      expected_status: 201,
      expected_content_type: "application/json",
      required: true,
    },
  ];
  const snapshot = buildSnapshot(config);
  return bodyBytes === null
    ? createVerificationApiRequest(snapshot, "create-item")
    : createVerificationApiRequest(snapshot, "create-item", bodyBytes);
}

function buildSnapshot(
  config: ReturnType<typeof validVerificationCoordinatorConfig>,
) {
  return buildVerificationRunSnapshot({
    run_id: "ark-20260727t120000z-api170",
    project_path: "/tmp/ark-team-project",
    artifact_root: "/tmp/ark-team-project/.ark-team/verification/run",
    server_port: 10_001,
    created_at_utc: "2026-07-27T12:00:00.000Z",
    package_fingerprint: APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    source: validVerificationSourceIdentity(),
    config,
  });
}

function runtimeResult(
  request: VerificationApiRuntimeRequest,
  override: Partial<VerificationApiRuntimeResult> = {},
): VerificationApiRuntimeResult {
  return {
    request_sha256: request.request_sha256,
    url: request.request.url,
    status: request.request.expected_status,
    headers: { "Content-Type": request.request.expected_content_type },
    body: Buffer.from('{"ok":true}', "utf8"),
    elapsed_ms: 27,
    ...override,
  };
}

function assertApiError(
  action: () => unknown,
  code: VerificationApiAdapterError["code"],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof VerificationApiAdapterError);
    assert.equal(error.code, code);
    return true;
  });
}
