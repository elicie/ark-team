import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createVerificationSemanticReviewRequest,
  normalizeVerificationSemanticReviewResult,
  VERIFICATION_SEMANTIC_REVIEW_CHECKS,
  VerificationSemanticReviewContractError,
  VerificationSemanticReviewUnavailableError,
  type CreateVerificationSemanticReviewRequestInput,
  type VerificationSemanticReviewRequest,
  type VerificationSemanticReviewRuntimeResult,
} from "../src/verification-semantic-review-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  buildVerificationRunSnapshot,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("TEST-1712 creates only exact localImage extensions for signaled canonical PNGs", async (t) => {
  const fixture = await createFixture(true);
  t.after(fixture.cleanup);
  const secondPath = path.join(
    fixture.screenshotRoot,
    "home-browser",
    "768x1024.actual.png",
  );
  await writeFile(secondPath, PNG);

  const request = await createVerificationSemanticReviewRequest({
    ...fixture.input,
    screenshot_paths: [fixture.screenshotPath, secondPath],
    active_turn_signal: activeTurnSignal(),
  });

  assert.deepEqual(request.turn_extensions, [
    { type: "localImage", path: fixture.screenshotPath },
    { type: "localImage", path: secondPath },
  ]);
  assert.deepEqual(
    Object.keys(request.turn_extensions[0]!).sort(),
    ["path", "type"],
  );
  assert.equal(request.identity.required, true);
  assert.deepEqual(request.identity.adapter, {
    name: "local-image",
    version: "active-turn",
  });
  assert.equal(request.images[0]?.byte_length, PNG.byteLength);
  assert.equal(
    request.images[0]?.sha256,
    createHash("sha256").update(PNG).digest("hex"),
  );
  assert.match(request.input_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(request.checklist.checks, VERIFICATION_SEMANTIC_REVIEW_CHECKS);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.turn_extensions), true);
});

test("TEST-1712 maps an absent active-turn signal to required unavailable or optional skipped", async (t) => {
  const requiredFixture = await createFixture(true);
  const optionalFixture = await createFixture(false);
  t.after(requiredFixture.cleanup);
  t.after(optionalFixture.cleanup);

  await assert.rejects(
    createVerificationSemanticReviewRequest(requiredFixture.input),
    (error) => {
      assert.equal(error instanceof VerificationSemanticReviewUnavailableError, true);
      if (!(error instanceof VerificationSemanticReviewUnavailableError)) {
        return false;
      }
      assert.equal(error.code, "CAPABILITY_UNAVAILABLE");
      assert.equal(error.required, true);
      assert.equal(error.outcome, "unavailable");
      return true;
    },
  );
  await assert.rejects(
    createVerificationSemanticReviewRequest(optionalFixture.input),
    (error) => {
      assert.equal(error instanceof VerificationSemanticReviewUnavailableError, true);
      if (!(error instanceof VerificationSemanticReviewUnavailableError)) {
        return false;
      }
      assert.equal(error.required, false);
      assert.equal(error.outcome, "skipped");
      return true;
    },
  );
});

test("TEST-1712 rejects malformed, symlinked, outside-root, and oversized PNG inputs", async (t) => {
  const fixture = await createFixture(true);
  t.after(fixture.cleanup);
  const caseRoot = path.dirname(fixture.screenshotPath);
  const symlinkPath = path.join(caseRoot, "symlink.actual.png");
  const outsidePath = path.join(fixture.tempRoot, "outside.actual.png");
  const directoryPath = path.join(caseRoot, "directory.actual.png");
  const oversizedPath = path.join(caseRoot, "oversized.actual.png");
  await symlink(fixture.screenshotPath, symlinkPath);
  await writeFile(outsidePath, PNG);
  await mkdir(directoryPath);
  const oversized = Buffer.alloc(10 * 1_024 * 1_024 + 1);
  PNG.copy(oversized, 0, 0, 8);
  await writeFile(oversizedPath, oversized);

  const invalidPaths = [
    "relative.actual.png",
    `${caseRoot}${path.sep}..${path.sep}home-browser${path.sep}375x812.actual.png`,
    symlinkPath,
    outsidePath,
    directoryPath,
    oversizedPath,
  ];
  for (const invalidPath of invalidPaths) {
    await assert.rejects(
      createVerificationSemanticReviewRequest({
        ...fixture.input,
        screenshot_paths: [invalidPath],
        active_turn_signal: activeTurnSignal(),
      }),
      isContractError,
      invalidPath,
    );
  }
});

test("TEST-1712 preserves approve, reject, and block while redacting secrets and PII", async (t) => {
  const fixture = await createFixture(true);
  t.after(fixture.cleanup);
  const request = await createVerificationSemanticReviewRequest({
    ...fixture.input,
    active_turn_signal: activeTurnSignal(),
  });

  for (const outcome of ["approved", "rejected", "blocked"] as const) {
    const result = validResult(request, outcome);
    result.observations[0] = {
      check: "clipping",
      observation:
        "authorization: top-secret user@example.com 010-1234-5678 화면 확인",
    };
    const normalized = normalizeVerificationSemanticReviewResult(
      request,
      result,
    );

    assert.equal(normalized.evidence.outcome, outcome);
    assert.equal(normalized.approved, outcome === "approved");
    assert.equal(
      normalized.error_code,
      outcome === "approved" ? null : "IMAGE_REVIEW_REJECTED",
    );
    assert.doesNotMatch(
      normalized.evidence.observations[0]!.observation,
      /top-secret|user@example\.com|010-1234-5678/,
    );
    assert.match(
      normalized.evidence.observations[0]!.observation,
      /\[REDACTED\]/,
    );
  }
});

test("TEST-1712 rejects unknown, unbounded, incomplete, or identity-drifted review results", async (t) => {
  const fixture = await createFixture(true);
  t.after(fixture.cleanup);
  const request = await createVerificationSemanticReviewRequest({
    ...fixture.input,
    active_turn_signal: activeTurnSignal(),
  });

  const invalidResults: unknown[] = [
    { ...validResult(request, "approved"), outcome: "unknown" },
    { ...validResult(request, "approved"), reasoning: "private chain of thought" },
    { ...validResult(request, "approved"), transcript: "raw conversation" },
    {
      ...validResult(request, "approved"),
      input_sha256: "f".repeat(64),
    },
    {
      ...validResult(request, "approved"),
      observations: validResult(request, "approved").observations.slice(0, 4),
    },
    {
      ...validResult(request, "approved"),
      observations: Array.from({ length: 51 }, (_, index) => ({
        check: VERIFICATION_SEMANTIC_REVIEW_CHECKS[
          index % VERIFICATION_SEMANTIC_REVIEW_CHECKS.length
        ]!,
        observation: `observation-${index}`,
      })),
    },
    {
      ...validResult(request, "approved"),
      observations: [
        ...validResult(request, "approved").observations,
        ...Array.from({ length: 10 }, (_, index) => ({
          check:
            VERIFICATION_SEMANTIC_REVIEW_CHECKS[
              index % VERIFICATION_SEMANTIC_REVIEW_CHECKS.length
            ]!,
          observation: "x".repeat(2_000),
        })),
      ],
    },
  ];

  for (const invalidResult of invalidResults) {
    assert.throws(
      () => normalizeVerificationSemanticReviewResult(request, invalidResult),
      isContractError,
    );
  }
});

async function createFixture(required: boolean) {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "ark-team-semantic-review-"),
  );
  const artifactRoot = path.join(tempRoot, "verification");
  const screenshotRoot = path.join(artifactRoot, "screenshots");
  const caseRoot = path.join(screenshotRoot, "home-browser");
  const screenshotPath = path.join(caseRoot, "375x812.actual.png");
  await mkdir(caseRoot, { recursive: true });
  await writeFile(screenshotPath, PNG);

  const config = validVerificationCoordinatorConfig();
  if (!config.ui.enabled) {
    throw new Error("semantic-review fixture requires the UI lane");
  }
  if (!required) {
    config.ui.semantic_review_required = false;
    config.ui.required_capabilities = config.ui.required_capabilities.filter(
      (capability) => capability !== "semantic_review",
    );
    config.ui.optional_capabilities = ["agentic_browser", "semantic_review"];
  }
  const snapshot = buildVerificationRunSnapshot({
    run_id: required
      ? "ark-20260727t000000z-170612"
      : "ark-20260727t000001z-170612",
    project_path: "/tmp/ark-team-project",
    artifact_root: artifactRoot,
    server_port: 10_001,
    created_at_utc: "2026-07-27T00:00:00.000Z",
    package_fingerprint: APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    source: validVerificationSourceIdentity(),
    config,
  });
  const input: CreateVerificationSemanticReviewRequestInput = {
    snapshot,
    screenshot_paths: [screenshotPath],
    checklist: {
      identity: "ui-semantic-review",
      version: "1.0.0",
    },
  };
  return {
    tempRoot,
    screenshotRoot,
    screenshotPath,
    input,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

function activeTurnSignal() {
  return {
    capability: "localImage" as const,
    adapter: {
      name: "local-image",
      version: "active-turn",
    },
  };
}

function validResult(
  request: VerificationSemanticReviewRequest,
  outcome: "approved" | "rejected" | "blocked",
): {
  -readonly [Key in keyof VerificationSemanticReviewRuntimeResult]:
    VerificationSemanticReviewRuntimeResult[Key] extends readonly (
      infer Item
    )[]
      ? Item[]
      : VerificationSemanticReviewRuntimeResult[Key];
} {
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
    reviewed_at_utc: "2026-07-27T00:00:01.000Z",
    outcome,
    observations: VERIFICATION_SEMANTIC_REVIEW_CHECKS.map((check) => ({
      check,
      observation: `${check} 확인 완료`,
    })),
  };
}

function isContractError(error: unknown): boolean {
  return (
    error instanceof VerificationSemanticReviewContractError &&
    error.code === "INVALID_RECORD"
  );
}
