import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
  verificationApprovedBaselineManifestSchema,
  verificationBaselineSetSha256,
  verificationRunSnapshotV2Schema,
} from "./verification-contract.js";
import {
  decodeVerificationRgba8Png,
  encodeVerificationRgba8Png,
  inspectVerificationPng,
} from "./verification-png.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const VIEWPORTS = [
  { name: "375x812", width: 375, height: 812 },
  { name: "768x1024", width: 768, height: 1_024 },
  { name: "1440x900", width: 1_440, height: 900 },
] as const;

type SnapshotV2 = z.infer<typeof verificationRunSnapshotV2Schema>;
type Viewport = (typeof VIEWPORTS)[number]["name"];

export interface VerificationScreenshotRuntimeRequest {
  readonly schema_version: 1;
  readonly contract_id: "verification_screenshot_runtime_v1";
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly case_id: string;
  readonly attempt_id: string;
  readonly case_sha256: string;
  readonly package_fingerprint: string;
  readonly source_fingerprint: string;
  readonly adapter: {
    readonly name: "playwright-cli";
    readonly version: string;
  };
  readonly browser_build: string;
  readonly engine: "chromium";
  readonly execution: {
    readonly cwd: string;
    readonly shell: false;
  };
  readonly origin: string;
  readonly url: string;
  readonly context: {
    readonly case_state: "after-declared-actions";
    readonly device_scale_factor: 1;
    readonly locale: "en-US";
    readonly timezone: "UTC";
    readonly color_scheme: "light";
    readonly reduced_motion: "no-preference";
  };
  readonly network: {
    readonly allowed_origin: string;
    readonly redirects: "same-origin-only";
    readonly proxy: "disabled";
    readonly credentials: "omit";
  };
  readonly captures: readonly VerificationScreenshotCaptureRequest[];
  readonly timeout_ms: 60_000;
  readonly max_file_bytes: number;
  readonly policy: {
    readonly browser_chrome: "excluded";
    readonly full_page: false;
    readonly resize: "disabled";
    readonly crop: "disabled";
    readonly jpeg_conversion: "disabled";
    readonly color_space_conversion: "disabled";
    readonly alpha_normalization: "disabled";
    readonly post_processing: "disabled";
  };
}

export interface VerificationScreenshotCaptureRequest {
  readonly sequence: 0 | 1 | 2;
  readonly viewport: Viewport;
  readonly width: number;
  readonly height: number;
  readonly device_scale_factor: 1;
  readonly url: string;
  readonly relative_path: string;
  readonly media_type: "image/png";
}

export interface VerificationScreenshotRuntimeResult {
  readonly schema_version: 1;
  readonly contract_id: "verification_screenshot_runtime_result_v1";
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly case_id: string;
  readonly attempt_id: string;
  readonly case_sha256: string;
  readonly package_fingerprint: string;
  readonly source_fingerprint: string;
  readonly adapter: {
    readonly name: string;
    readonly version: string;
  };
  readonly browser_build: string;
  readonly origin: string;
  readonly url: string;
  readonly screenshots: readonly VerificationScreenshotRuntimeImage[];
}

export type VerificationScreenshotCapturePlanV2 = Omit<
  VerificationScreenshotCaptureRequest,
  "url"
>;

export interface VerificationScreenshotRuntimeV2Plan
  extends Omit<
    VerificationScreenshotRuntimeRequest,
    "schema_version" | "contract_id" | "url" | "captures" | "policy"
  > {
  readonly schema_version: 2;
  readonly contract_id: "verification_screenshot_runtime_v2";
  readonly initial_url: string;
  readonly expected_url_source: "validated-browser-final-url";
  readonly readiness: VerificationBrowserScreenshotReadiness;
  readonly captures: readonly VerificationScreenshotCapturePlanV2[];
  readonly policy: VerificationScreenshotRuntimeRequest["policy"] & {
    readonly navigation: "disabled";
    readonly actions: "disabled";
  };
}

export interface VerificationScreenshotRuntimeV2Expectation
  extends Omit<
    VerificationScreenshotRuntimeV2Plan,
    "initial_url" | "expected_url_source" | "captures"
  > {
  readonly url: string;
  readonly captures: readonly VerificationScreenshotCaptureRequest[];
}

export interface VerificationScreenshotRuntimeV2Result
  extends Omit<
    VerificationScreenshotRuntimeResult,
    "schema_version" | "contract_id"
  > {
  readonly schema_version: 2;
  readonly contract_id: "verification_screenshot_runtime_result_v2";
}

export interface VerificationBrowserScreenshotReadiness {
  readonly selector: string;
  readonly timeout_ms: 60_000;
  readonly wait: "auto";
}

export interface VerificationScreenshotRuntimeImage {
  readonly sequence: number;
  readonly viewport: Viewport;
  readonly width: number;
  readonly height: number;
  readonly device_scale_factor: 1;
  readonly url: string;
  readonly relative_path: string;
  readonly media_type: "image/png";
  readonly captured_at_utc: string;
  readonly byte_length: number;
  readonly sha256: string;
  readonly capture: {
    readonly browser_chrome: "excluded";
    readonly full_page: false;
    readonly resized: false;
    readonly cropped: false;
    readonly converted: false;
    readonly color_space_converted: false;
    readonly alpha_normalized: false;
    readonly post_processed: false;
  };
  readonly bytes: Uint8Array;
}

export interface VerificationScreenshotImageEvidence
  extends Omit<VerificationScreenshotRuntimeImage, "bytes" | "capture"> {
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly case_id: string;
  readonly case_sha256: string;
  readonly package_fingerprint: string;
  readonly source_fingerprint: string;
  readonly adapter: VerificationScreenshotRuntimeResult["adapter"];
  readonly browser_build: string;
  readonly capture: VerificationScreenshotRuntimeImage["capture"];
}

export interface VerificationScreenshotEvidence {
  readonly schema_version: 1;
  readonly contract_id: "verification_screenshot_evidence_v1";
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly case_id: string;
  readonly attempt_id: string;
  readonly case_sha256: string;
  readonly package_fingerprint: string;
  readonly source_fingerprint: string;
  readonly adapter: VerificationScreenshotRuntimeResult["adapter"];
  readonly browser_build: string;
  readonly origin: string;
  readonly url: string;
  readonly screenshots: readonly VerificationScreenshotImageEvidence[];
}

export interface NormalizedVerificationScreenshotResult {
  readonly evidence: VerificationScreenshotEvidence;
  readonly images: readonly {
    readonly evidence: VerificationScreenshotImageEvidence;
    readonly png_bytes: Uint8Array;
  }[];
}

export type VerificationSemanticReviewOutcome =
  | "approved"
  | "rejected"
  | "blocked"
  | "unavailable"
  | "skipped";

export interface VerificationVisualComparisonInput {
  readonly snapshot: unknown;
  readonly case_id: string;
  readonly viewport: Viewport;
  readonly baseline: {
    readonly manifest: unknown;
    readonly manifest_sha256: string;
    readonly baseline_set_sha256: string;
    readonly png_bytes: Uint8Array;
  };
  readonly actual: {
    readonly evidence: VerificationScreenshotImageEvidence;
    readonly png_bytes: Uint8Array;
  };
  readonly semantic_review_outcome: VerificationSemanticReviewOutcome | null;
}

export interface VerificationVisualComparisonEvidence {
  readonly schema_version: 1;
  readonly contract_id: "verification_visual_comparison_evidence_v1";
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly case_id: string;
  readonly viewport: Viewport;
  readonly width: number;
  readonly height: number;
  readonly algorithm: "rgba8-row-major-exact-v1";
  readonly transformations: "none";
  readonly baseline_id: string;
  readonly baseline_set_sha256: string;
  readonly baseline_manifest_sha256: string;
  readonly baseline_path: string;
  readonly baseline_sha256: string;
  readonly actual_path: string;
  readonly actual_sha256: string;
  readonly diff_path: string;
  readonly diff_sha256: string;
  readonly diff_byte_length: number;
  readonly pixel_count: number;
  readonly changed_pixel_count: number;
  readonly first_changed_pixel_index: number | null;
  readonly pixel_diff_fraction: number;
  readonly max_channel_delta: number;
  readonly critical_region_difference: boolean;
  readonly changed_critical_region_ids: readonly string[];
  readonly pixel_diff_fraction_max: 0.005;
  readonly max_channel_delta_max: 8;
  readonly semantic_review_required: boolean;
  readonly semantic_review_outcome: VerificationSemanticReviewOutcome | null;
  readonly passed: boolean;
  readonly message: string;
}

export interface VerificationVisualComparisonResult {
  readonly evidence: VerificationVisualComparisonEvidence;
  readonly diff_png_bytes: Uint8Array;
  readonly passed: boolean;
  readonly message: string;
}

export type VerificationVisualErrorCode =
  | "SCREENSHOT_CAPTURE_FAILED"
  | "BASELINE_NOT_APPROVED"
  | "COMPARISON_THRESHOLD_FAILED"
  | "INVALID_RECORD";

export class VerificationVisualContractError extends Error {
  constructor(
    readonly code: VerificationVisualErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "VerificationVisualContractError";
  }
}

const screenshotRequestInputSchema = z
  .object({
    snapshot: verificationRunSnapshotV2Schema,
    case_id: z.string().regex(IDENTIFIER_PATTERN),
    attempt_id: z.string().regex(IDENTIFIER_PATTERN),
  })
  .strict();

export function createVerificationScreenshotRequest(input: {
  readonly snapshot: unknown;
  readonly case_id: string;
  readonly attempt_id: string;
}): VerificationScreenshotRuntimeRequest {
  const parsed = screenshotRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot request input is invalid",
      parsed.error,
    );
  }
  const { snapshot, case_id: caseId, attempt_id: attemptId } = parsed.data;
  if (!snapshot.ui_contract.enabled || snapshot.browser_environment === null) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot request requires an enabled UI lane",
    );
  }
  const browserCase = snapshot.ui_contract.browser_cases.find(
    (candidate) => candidate.id === caseId,
  );
  if (browserCase === undefined) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot request targets an undeclared browser case",
    );
  }
  assertLocalOrigin(snapshot.server.api_origin);
  const url = new URL(browserCase.path, snapshot.server.api_origin).toString();
  assertLocalUrl(url, snapshot.server.api_origin);

  return deepFreeze({
    schema_version: 1,
    contract_id: "verification_screenshot_runtime_v1",
    run_id: snapshot.run_id,
    snapshot_id: snapshot.snapshot_id,
    case_id: browserCase.id,
    attempt_id: attemptId,
    case_sha256: sha256CanonicalJson(browserCase),
    package_fingerprint: snapshot.package.package_fingerprint,
    source_fingerprint: snapshot.source_fingerprint,
    adapter: {
      name: snapshot.ui_contract.deterministic_adapter,
      version: snapshot.ui_contract.deterministic_adapter_version,
    },
    browser_build: snapshot.ui_contract.browser_build,
    engine: "chromium",
    execution: {
      cwd: snapshot.source.worktree_root,
      shell: false,
    },
    origin: snapshot.server.api_origin,
    url,
    context: {
      case_state: "after-declared-actions",
      device_scale_factor: snapshot.browser_environment.device_scale_factor,
      locale: snapshot.browser_environment.locale,
      timezone: snapshot.browser_environment.timezone,
      color_scheme: snapshot.browser_environment.color_scheme,
      reduced_motion: snapshot.browser_environment.reduced_motion,
    },
    network: {
      allowed_origin: snapshot.server.api_origin,
      redirects: "same-origin-only",
      proxy: "disabled",
      credentials: "omit",
    },
    captures: VIEWPORTS.map((viewport, sequence) => ({
      sequence: sequence as 0 | 1 | 2,
      viewport: viewport.name,
      width: viewport.width,
      height: viewport.height,
      device_scale_factor: 1 as const,
      url,
      relative_path:
        `screenshots/${browserCase.id}/${viewport.name}.actual.png`,
      media_type: "image/png" as const,
    })),
    timeout_ms: snapshot.timeouts_ms.browser_ms,
    max_file_bytes: snapshot.evidence_policy.max_file_bytes,
    policy: {
      browser_chrome: "excluded",
      full_page: false,
      resize: "disabled",
      crop: "disabled",
      jpeg_conversion: "disabled",
      color_space_conversion: "disabled",
      alpha_normalization: "disabled",
      post_processing: "disabled",
    },
  });
}

export function createVerificationScreenshotRuntimeV2Plan(input: {
  readonly snapshot: unknown;
  readonly case_id: string;
  readonly attempt_id: string;
}): VerificationScreenshotRuntimeV2Plan {
  const parsed = screenshotRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot v2 plan input is invalid",
      parsed.error,
    );
  }
  const browserCase = parsed.data.snapshot.ui_contract.enabled
    ? parsed.data.snapshot.ui_contract.browser_cases.find(
        (candidate) => candidate.id === parsed.data.case_id,
      )
    : undefined;
  if (browserCase === undefined) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot v2 plan requires a declared browser case",
    );
  }
  const request = createVerificationScreenshotRequest(input);

  return deepFreeze({
    schema_version: 2,
    contract_id: "verification_screenshot_runtime_v2",
    run_id: request.run_id,
    snapshot_id: request.snapshot_id,
    case_id: request.case_id,
    attempt_id: request.attempt_id,
    case_sha256: request.case_sha256,
    package_fingerprint: request.package_fingerprint,
    source_fingerprint: request.source_fingerprint,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    engine: request.engine,
    execution: { ...request.execution },
    origin: request.origin,
    initial_url: request.url,
    expected_url_source: "validated-browser-final-url",
    context: { ...request.context },
    network: { ...request.network },
    readiness: {
      selector: browserCase.readiness,
      timeout_ms: request.timeout_ms,
      wait: "auto",
    },
    captures: request.captures.map((capture) => ({
      sequence: capture.sequence,
      viewport: capture.viewport,
      width: capture.width,
      height: capture.height,
      device_scale_factor: capture.device_scale_factor,
      relative_path: capture.relative_path,
      media_type: capture.media_type,
    })),
    timeout_ms: request.timeout_ms,
    max_file_bytes: request.max_file_bytes,
    policy: {
      ...request.policy,
      navigation: "disabled",
      actions: "disabled",
    },
  });
}

export function createVerificationScreenshotRuntimeV2Expectation(input: {
  readonly plan: VerificationScreenshotRuntimeV2Plan;
  readonly final_url: string;
}): VerificationScreenshotRuntimeV2Expectation {
  const { plan, final_url: finalUrl } = input;
  assertLocalOrigin(plan.origin);
  assertLocalUrl(plan.initial_url, plan.origin);
  assertLocalUrl(finalUrl, plan.origin);

  return deepFreeze({
    schema_version: 2,
    contract_id: "verification_screenshot_runtime_v2",
    run_id: plan.run_id,
    snapshot_id: plan.snapshot_id,
    case_id: plan.case_id,
    attempt_id: plan.attempt_id,
    case_sha256: plan.case_sha256,
    package_fingerprint: plan.package_fingerprint,
    source_fingerprint: plan.source_fingerprint,
    adapter: { ...plan.adapter },
    browser_build: plan.browser_build,
    engine: plan.engine,
    execution: { ...plan.execution },
    origin: plan.origin,
    url: finalUrl,
    context: { ...plan.context },
    network: { ...plan.network },
    readiness: { ...plan.readiness },
    captures: plan.captures.map((capture) => ({
      ...capture,
      url: finalUrl,
    })),
    timeout_ms: plan.timeout_ms,
    max_file_bytes: plan.max_file_bytes,
    policy: { ...plan.policy },
  });
}

export function normalizeVerificationScreenshotRuntimeV2Result(
  expectation: VerificationScreenshotRuntimeV2Expectation,
  rawResult: unknown,
): NormalizedVerificationScreenshotResult {
  const envelope = z
    .object({
      schema_version: z.literal(2),
      contract_id: z.literal("verification_screenshot_runtime_result_v2"),
    })
    .passthrough()
    .safeParse(rawResult);
  if (!envelope.success) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot runtime v2 result is invalid",
      envelope.error,
    );
  }

  const requestV1: VerificationScreenshotRuntimeRequest = {
    schema_version: 1,
    contract_id: "verification_screenshot_runtime_v1",
    run_id: expectation.run_id,
    snapshot_id: expectation.snapshot_id,
    case_id: expectation.case_id,
    attempt_id: expectation.attempt_id,
    case_sha256: expectation.case_sha256,
    package_fingerprint: expectation.package_fingerprint,
    source_fingerprint: expectation.source_fingerprint,
    adapter: { ...expectation.adapter },
    browser_build: expectation.browser_build,
    engine: expectation.engine,
    execution: { ...expectation.execution },
    origin: expectation.origin,
    url: expectation.url,
    context: { ...expectation.context },
    network: { ...expectation.network },
    captures: expectation.captures.map((capture) => ({ ...capture })),
    timeout_ms: expectation.timeout_ms,
    max_file_bytes: expectation.max_file_bytes,
    policy: {
      browser_chrome: expectation.policy.browser_chrome,
      full_page: expectation.policy.full_page,
      resize: expectation.policy.resize,
      crop: expectation.policy.crop,
      jpeg_conversion: expectation.policy.jpeg_conversion,
      color_space_conversion: expectation.policy.color_space_conversion,
      alpha_normalization: expectation.policy.alpha_normalization,
      post_processing: expectation.policy.post_processing,
    },
  };
  const resultV1 = {
    ...envelope.data,
    schema_version: 1,
    contract_id: "verification_screenshot_runtime_result_v1",
  };
  return normalizeVerificationScreenshotResult(requestV1, resultV1);
}

export function normalizeVerificationScreenshotResult(
  request: VerificationScreenshotRuntimeRequest,
  rawResult: unknown,
): NormalizedVerificationScreenshotResult {
  const parsed = screenshotResultSchema(request).safeParse(rawResult);
  if (!parsed.success) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot runtime result is invalid",
      parsed.error,
    );
  }
  const result = parsed.data;
  assertScreenshotResultIdentity(request, result);

  const images = result.screenshots.map((screenshot, index) => {
    const expected = request.captures[index];
    if (
      expected === undefined ||
      screenshot.sequence !== expected.sequence ||
      screenshot.viewport !== expected.viewport ||
      screenshot.width !== expected.width ||
      screenshot.height !== expected.height ||
      screenshot.device_scale_factor !== expected.device_scale_factor ||
      screenshot.url !== expected.url ||
      screenshot.relative_path !== expected.relative_path ||
      screenshot.media_type !== expected.media_type
    ) {
      throw visualError(
        "SCREENSHOT_CAPTURE_FAILED",
        "screenshot evidence is missing, reordered, or differs from the request",
      );
    }
    assertLocalUrl(screenshot.url, request.origin);
    const pngBytes = Uint8Array.from(screenshot.bytes);
    if (
      pngBytes.byteLength === 0 ||
      pngBytes.byteLength > request.max_file_bytes ||
      pngBytes.byteLength !== screenshot.byte_length ||
      sha256Bytes(pngBytes) !== screenshot.sha256
    ) {
      throw visualError(
        "SCREENSHOT_CAPTURE_FAILED",
        "screenshot byte length or SHA-256 does not match its PNG bytes",
      );
    }
    let metadata;
    try {
      metadata = inspectVerificationPng(pngBytes);
    } catch (error) {
      throw visualError(
        "SCREENSHOT_CAPTURE_FAILED",
        "screenshot bytes are not a valid PNG",
        error,
      );
    }
    if (
      metadata.width !== expected.width ||
      metadata.height !== expected.height
    ) {
      throw visualError(
        "SCREENSHOT_CAPTURE_FAILED",
        "screenshot PNG dimensions differ from the exact viewport",
      );
    }

    const evidence: VerificationScreenshotImageEvidence = {
      run_id: request.run_id,
      snapshot_id: request.snapshot_id,
      case_id: request.case_id,
      case_sha256: request.case_sha256,
      package_fingerprint: request.package_fingerprint,
      source_fingerprint: request.source_fingerprint,
      adapter: { ...request.adapter },
      browser_build: request.browser_build,
      sequence: screenshot.sequence,
      viewport: screenshot.viewport,
      width: screenshot.width,
      height: screenshot.height,
      device_scale_factor: screenshot.device_scale_factor,
      url: screenshot.url,
      relative_path: screenshot.relative_path,
      media_type: screenshot.media_type,
      captured_at_utc: screenshot.captured_at_utc,
      byte_length: screenshot.byte_length,
      sha256: screenshot.sha256,
      capture: { ...screenshot.capture },
    };
    return {
      evidence: deepFreeze(evidence),
      png_bytes: pngBytes,
    };
  });

  const evidence: VerificationScreenshotEvidence = {
    schema_version: 1,
    contract_id: "verification_screenshot_evidence_v1",
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
    screenshots: images.map(({ evidence: screenshot }) => screenshot),
  };
  if (
    Buffer.byteLength(JSON.stringify(evidence), "utf8") >
    64 * 1_024
  ) {
    throw visualError(
      "INVALID_RECORD",
      "screenshot metadata exceeds the fixed 64 KiB limit",
    );
  }
  return {
    evidence: deepFreeze(evidence),
    images,
  };
}

const comparisonInputSchema = z
  .object({
    snapshot: verificationRunSnapshotV2Schema,
    case_id: z.string().regex(IDENTIFIER_PATTERN),
    viewport: z.enum(["375x812", "768x1024", "1440x900"]),
    baseline: z
      .object({
        manifest: z.unknown(),
        manifest_sha256: z.string().regex(SHA256_PATTERN),
        baseline_set_sha256: z.string().regex(SHA256_PATTERN),
        png_bytes: z.instanceof(Uint8Array),
      })
      .strict(),
    actual: z
      .object({
        evidence: z.unknown(),
        png_bytes: z.instanceof(Uint8Array),
      })
      .strict(),
    semantic_review_outcome: z
      .enum(["approved", "rejected", "blocked", "unavailable", "skipped"])
      .nullable(),
  })
  .strict();

export function compareVerificationPngs(
  input: VerificationVisualComparisonInput,
): VerificationVisualComparisonResult {
  const parsedInput = comparisonInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw visualError(
      "INVALID_RECORD",
      "visual comparison input is invalid",
      parsedInput.error,
    );
  }
  const parsed = parsedInput.data;
  const { snapshot } = parsed;
  if (
    !snapshot.ui_contract.enabled ||
    snapshot.browser_environment === null ||
    snapshot.baseline_identity === null
  ) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "visual comparison requires an enabled UI lane and approved baseline identity",
    );
  }
  const browserCase = snapshot.ui_contract.browser_cases.find(
    (candidate) => candidate.id === parsed.case_id,
  );
  if (browserCase === undefined) {
    throw visualError(
      "INVALID_RECORD",
      "visual comparison targets an undeclared browser case",
    );
  }
  const expectedViewport = VIEWPORTS.find(
    (candidate) => candidate.name === parsed.viewport,
  )!;
  const actualEvidenceParse = screenshotImageEvidenceSchema.safeParse(
    parsed.actual.evidence,
  );
  if (!actualEvidenceParse.success) {
    throw visualError(
      "INVALID_RECORD",
      "actual screenshot evidence is invalid",
      actualEvidenceParse.error,
    );
  }
  const actualEvidence = actualEvidenceParse.data;
  assertComparisonActualIdentity(
    snapshot,
    browserCase,
    expectedViewport,
    actualEvidence,
  );

  const manifestParse =
    verificationApprovedBaselineManifestSchema.safeParse(
      parsed.baseline.manifest,
    );
  if (!manifestParse.success) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline manifest is invalid",
      manifestParse.error,
    );
  }
  const manifest = manifestParse.data;
  assertExactBaselineMatrix(snapshot, manifest);
  const manifestSha256 = sha256Bytes(
    Buffer.from(canonicalJson(manifest), "utf8"),
  );
  const baselineSetSha256 = verificationBaselineSetSha256(manifest);
  if (
    manifestSha256 !== parsed.baseline.manifest_sha256 ||
    baselineSetSha256 !== parsed.baseline.baseline_set_sha256 ||
    baselineSetSha256 !== snapshot.baseline_identity.sha256 ||
    manifest.baseline_id !== snapshot.baseline_identity.id ||
    manifest.source_commit !== snapshot.source.source_commit ||
    manifest.source_tree !== snapshot.source.source_tree ||
    canonicalJson(manifest.environment) !==
      canonicalJson(snapshot.browser_environment) ||
    manifest.adapter.name !== snapshot.ui_contract.deterministic_adapter ||
    manifest.adapter.version !==
      snapshot.ui_contract.deterministic_adapter_version ||
    manifest.browser_build !== snapshot.ui_contract.browser_build
  ) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline manifest or identity differs from the snapshot",
    );
  }
  const baselineEntry = manifest.entries.find(
    (entry) =>
      entry.case_id === parsed.case_id &&
      entry.viewport === parsed.viewport,
  );
  if (
    baselineEntry === undefined ||
    baselineEntry.width !== expectedViewport.width ||
    baselineEntry.height !== expectedViewport.height ||
    baselineEntry.path !==
      `objects/sha256/${baselineEntry.sha256}.png`
  ) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline does not contain the exact case and viewport",
    );
  }

  const baselineBytes = Uint8Array.from(parsed.baseline.png_bytes);
  const actualBytes = Uint8Array.from(parsed.actual.png_bytes);
  if (
    baselineBytes.byteLength === 0 ||
    baselineBytes.byteLength > snapshot.evidence_policy.max_file_bytes ||
    sha256Bytes(baselineBytes) !== baselineEntry.sha256
  ) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline PNG bytes do not match their object hash",
    );
  }
  if (
    actualBytes.byteLength === 0 ||
    actualBytes.byteLength > snapshot.evidence_policy.max_file_bytes ||
    actualBytes.byteLength !== actualEvidence.byte_length ||
    sha256Bytes(actualBytes) !== actualEvidence.sha256
  ) {
    throw visualError(
      "INVALID_RECORD",
      "actual screenshot PNG bytes do not match their evidence hash",
    );
  }

  let baseline;
  let actual;
  try {
    baseline = decodeVerificationRgba8Png(baselineBytes);
  } catch (error) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline is not a strict RGBA8 PNG",
      error,
    );
  }
  try {
    actual = decodeVerificationRgba8Png(actualBytes);
  } catch (error) {
    throw visualError(
      "INVALID_RECORD",
      "actual screenshot is not a strict RGBA8 PNG",
      error,
    );
  }
  if (
    baseline.width !== baselineEntry.width ||
    baseline.height !== baselineEntry.height
  ) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline PNG dimensions differ from its manifest",
    );
  }
  if (
    actual.width !== actualEvidence.width ||
    actual.height !== actualEvidence.height ||
    actual.width !== baseline.width ||
    actual.height !== baseline.height
  ) {
    throw visualError(
      "INVALID_RECORD",
      "baseline and actual PNG dimensions must be exactly equal",
    );
  }

  const pixelCount = baseline.width * baseline.height;
  const diffRgba = new Uint8Array(pixelCount * 4);
  const changedPixels = new Uint8Array(pixelCount);
  let changedPixelCount = 0;
  let firstChangedPixelIndex: number | null = null;
  let maxChannelDelta = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const byteOffset = pixelIndex * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        (baseline.rgba[byteOffset + channel] ?? 0) -
          (actual.rgba[byteOffset + channel] ?? 0),
      );
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      changed ||= delta !== 0;
    }
    if (changed) {
      changedPixels[pixelIndex] = 1;
      changedPixelCount += 1;
      firstChangedPixelIndex ??= pixelIndex;
      diffRgba[byteOffset] = 255;
      diffRgba[byteOffset + 1] = 0;
      diffRgba[byteOffset + 2] = 255;
      diffRgba[byteOffset + 3] = 255;
    }
  }

  const changedCriticalRegionIds =
    snapshot.ui_contract.critical_regions
      .filter((region) =>
        regionContainsDifference(region, baseline.width, changedPixels),
      )
      .map((region) => region.id);
  const pixelDiffFraction = changedPixelCount / pixelCount;
  const semanticReviewPass =
    !snapshot.ui_contract.semantic_review_required ||
    parsed.semantic_review_outcome === "approved";
  const passed =
    semanticReviewPass &&
    changedCriticalRegionIds.length === 0 &&
    pixelDiffFraction <= snapshot.ui_contract.pixel_diff_fraction_max &&
    maxChannelDelta <= snapshot.ui_contract.max_channel_delta;
  const reasons = [
    ...(!semanticReviewPass
      ? ["required semantic review is not approved"]
      : []),
    ...(changedCriticalRegionIds.length > 0
      ? ["a declared critical region differs"]
      : []),
    ...(pixelDiffFraction > snapshot.ui_contract.pixel_diff_fraction_max
      ? ["pixel diff fraction exceeds 0.005"]
      : []),
    ...(maxChannelDelta > snapshot.ui_contract.max_channel_delta
      ? ["maximum channel delta exceeds 8"]
      : []),
  ];
  const message = passed ? "comparison passed" : reasons.join("; ");
  const diffPngBytes = encodeVerificationRgba8Png({
    width: baseline.width,
    height: baseline.height,
    rgba: diffRgba,
  });
  const diffPath =
    `diffs/${parsed.case_id}/${parsed.viewport}.diff.png`;
  const evidence: VerificationVisualComparisonEvidence = {
    schema_version: 1,
    contract_id: "verification_visual_comparison_evidence_v1",
    run_id: snapshot.run_id,
    snapshot_id: snapshot.snapshot_id,
    case_id: parsed.case_id,
    viewport: parsed.viewport,
    width: baseline.width,
    height: baseline.height,
    algorithm: "rgba8-row-major-exact-v1",
    transformations: "none",
    baseline_id: manifest.baseline_id,
    baseline_set_sha256: baselineSetSha256,
    baseline_manifest_sha256: manifestSha256,
    baseline_path: baselineEntry.path,
    baseline_sha256: baselineEntry.sha256,
    actual_path: actualEvidence.relative_path,
    actual_sha256: actualEvidence.sha256,
    diff_path: diffPath,
    diff_sha256: sha256Bytes(diffPngBytes),
    diff_byte_length: diffPngBytes.byteLength,
    pixel_count: pixelCount,
    changed_pixel_count: changedPixelCount,
    first_changed_pixel_index: firstChangedPixelIndex,
    pixel_diff_fraction: pixelDiffFraction,
    max_channel_delta: maxChannelDelta,
    critical_region_difference: changedCriticalRegionIds.length > 0,
    changed_critical_region_ids: changedCriticalRegionIds,
    pixel_diff_fraction_max: snapshot.ui_contract.pixel_diff_fraction_max,
    max_channel_delta_max: snapshot.ui_contract.max_channel_delta,
    semantic_review_required:
      snapshot.ui_contract.semantic_review_required,
    semantic_review_outcome: parsed.semantic_review_outcome,
    passed,
    message,
  };
  return {
    evidence: deepFreeze(evidence),
    diff_png_bytes: diffPngBytes,
    passed,
    message,
  };
}

function assertExactBaselineMatrix(
  snapshot: SnapshotV2,
  manifest: z.infer<typeof verificationApprovedBaselineManifestSchema>,
): void {
  if (!snapshot.ui_contract.enabled) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline matrix requires an enabled UI snapshot",
    );
  }
  const expected = [...snapshot.ui_contract.browser_cases]
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.id, "utf8"),
        Buffer.from(right.id, "utf8"),
      ),
    )
    .flatMap((browserCase) =>
      VIEWPORTS.map(
        (viewport) => `${browserCase.id}\0${viewport.name}`,
      ),
    );
  const actual = manifest.entries.map(
    (entry) => `${entry.case_id}\0${entry.viewport}`,
  );
  if (actual.join("\0") !== expected.join("\0")) {
    throw visualError(
      "BASELINE_NOT_APPROVED",
      "approved baseline manifest does not cover the exact case and viewport matrix",
    );
  }
}

const utcInstantSchema = z
  .string()
  .regex(UTC_INSTANT_PATTERN)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() ===
        (value.includes(".") ? value : value.replace("Z", ".000Z")),
    "capture time must be a canonical UTC instant",
  );

const captureMetadataSchema = z
  .object({
    browser_chrome: z.literal("excluded"),
    full_page: z.literal(false),
    resized: z.literal(false),
    cropped: z.literal(false),
    converted: z.literal(false),
    color_space_converted: z.literal(false),
    alpha_normalized: z.literal(false),
    post_processed: z.literal(false),
  })
  .strict();

const screenshotImageEvidenceSchema = z
  .object({
    run_id: z.string().regex(IDENTIFIER_PATTERN),
    snapshot_id: z.string().regex(IDENTIFIER_PATTERN),
    case_id: z.string().regex(IDENTIFIER_PATTERN),
    case_sha256: z.string().regex(SHA256_PATTERN),
    package_fingerprint: z.string().regex(SHA256_PATTERN),
    source_fingerprint: z.string().regex(SHA256_PATTERN),
    adapter: z
      .object({
        name: z.string().regex(IDENTIFIER_PATTERN),
        version: z.string().min(1).max(128),
      })
      .strict(),
    browser_build: z.string().min(1).max(128),
    sequence: z.number().int().min(0).max(2),
    viewport: z.enum(["375x812", "768x1024", "1440x900"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    device_scale_factor: z.literal(1),
    url: z.string().min(1).max(2_048),
    relative_path: z.string().min(1).max(1_000),
    media_type: z.literal("image/png"),
    captured_at_utc: utcInstantSchema,
    byte_length: z.number().int().positive().max(50 * 1_024 * 1_024),
    sha256: z.string().regex(SHA256_PATTERN),
    capture: captureMetadataSchema,
  })
  .strict();

function screenshotResultSchema(
  request: VerificationScreenshotRuntimeRequest,
) {
  const screenshotSchema = z
    .object({
      sequence: z.number().int().min(0).max(2),
      viewport: z.enum(["375x812", "768x1024", "1440x900"]),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      device_scale_factor: z.literal(1),
      url: z.string().min(1).max(2_048),
      relative_path: z.string().min(1).max(1_000),
      media_type: z.literal("image/png"),
      captured_at_utc: utcInstantSchema,
      byte_length: z
        .number()
        .int()
        .positive()
        .max(request.max_file_bytes),
      sha256: z.string().regex(SHA256_PATTERN),
      capture: captureMetadataSchema,
      bytes: z.instanceof(Uint8Array),
    })
    .strict();
  return z
    .object({
      schema_version: z.literal(1),
      contract_id: z.literal(
        "verification_screenshot_runtime_result_v1",
      ),
      run_id: z.string().regex(IDENTIFIER_PATTERN),
      snapshot_id: z.string().regex(IDENTIFIER_PATTERN),
      case_id: z.string().regex(IDENTIFIER_PATTERN),
      attempt_id: z.string().regex(IDENTIFIER_PATTERN),
      case_sha256: z.string().regex(SHA256_PATTERN),
      package_fingerprint: z.string().regex(SHA256_PATTERN),
      source_fingerprint: z.string().regex(SHA256_PATTERN),
      adapter: z
        .object({
          name: z.string().regex(IDENTIFIER_PATTERN),
          version: z.string().min(1).max(128),
        })
        .strict(),
      browser_build: z.string().min(1).max(128),
      origin: z.string().min(1).max(2_048),
      url: z.string().min(1).max(2_048),
      screenshots: z.array(screenshotSchema).length(3),
    })
    .strict();
}

function assertScreenshotResultIdentity(
  request: VerificationScreenshotRuntimeRequest,
  result: z.infer<ReturnType<typeof screenshotResultSchema>>,
): void {
  if (
    result.run_id !== request.run_id ||
    result.snapshot_id !== request.snapshot_id ||
    result.case_id !== request.case_id ||
    result.attempt_id !== request.attempt_id ||
    result.case_sha256 !== request.case_sha256 ||
    result.package_fingerprint !== request.package_fingerprint ||
    result.source_fingerprint !== request.source_fingerprint ||
    result.adapter.name !== request.adapter.name ||
    result.adapter.version !== request.adapter.version ||
    result.browser_build !== request.browser_build ||
    result.origin !== request.origin ||
    result.url !== request.url
  ) {
    throw visualError(
      "SCREENSHOT_CAPTURE_FAILED",
      "screenshot runtime result identity differs from the request",
    );
  }
  assertLocalOrigin(result.origin);
  assertLocalUrl(result.url, result.origin);
}

function assertComparisonActualIdentity(
  snapshot: SnapshotV2,
  browserCase: Extract<
    SnapshotV2["ui_contract"],
    { enabled: true }
  >["browser_cases"][number],
  viewport: (typeof VIEWPORTS)[number],
  actual: VerificationScreenshotImageEvidence,
): void {
  if (!snapshot.ui_contract.enabled) {
    throw visualError(
      "INVALID_RECORD",
      "actual screenshot requires an enabled UI snapshot",
    );
  }
  const ui = snapshot.ui_contract;
  if (
    actual.run_id !== snapshot.run_id ||
    actual.snapshot_id !== snapshot.snapshot_id ||
    actual.case_id !== browserCase.id ||
    actual.case_sha256 !== sha256CanonicalJson(browserCase) ||
    actual.package_fingerprint !== snapshot.package.package_fingerprint ||
    actual.source_fingerprint !== snapshot.source_fingerprint ||
    actual.adapter.name !== ui.deterministic_adapter
  ) {
    throw visualError(
      "INVALID_RECORD",
      "actual screenshot identity differs from the snapshot",
    );
  }
  if (
    actual.adapter.version !== ui.deterministic_adapter_version ||
    actual.browser_build !== ui.browser_build ||
    actual.viewport !== viewport.name ||
    actual.sequence !==
      VIEWPORTS.findIndex((candidate) => candidate.name === viewport.name) ||
    actual.width !== viewport.width ||
    actual.height !== viewport.height ||
    actual.device_scale_factor !== 1 ||
    actual.relative_path !==
      `screenshots/${browserCase.id}/${viewport.name}.actual.png`
  ) {
    throw visualError(
      "INVALID_RECORD",
      "actual screenshot metadata differs from the exact visual contract",
    );
  }
  assertLocalUrl(actual.url, snapshot.server.api_origin);
}

function regionContainsDifference(
  region: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  imageWidth: number,
  changedPixels: Uint8Array,
): boolean {
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      if (changedPixels[y * imageWidth + x] === 1) {
        return true;
      }
    }
  }
  return false;
}

function assertLocalOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (error) {
    throw visualError(
      "INVALID_RECORD",
      "visual origin is not a valid URL",
      error,
    );
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "devbox" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    Number(parsed.port) < 10_001
  ) {
    throw visualError(
      "INVALID_RECORD",
      "visual origin is not the recorded local dev origin",
    );
  }
}

function assertLocalUrl(value: string, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw visualError(
      "INVALID_RECORD",
      "visual URL is invalid",
      error,
    );
  }
  if (
    parsed.origin !== origin ||
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw visualError(
      "INVALID_RECORD",
      "visual URL is cross-origin or credentialed",
    );
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function visualError(
  code: VerificationVisualErrorCode,
  message: string,
  cause?: unknown,
): VerificationVisualContractError {
  return new VerificationVisualContractError(code, message, { cause });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
