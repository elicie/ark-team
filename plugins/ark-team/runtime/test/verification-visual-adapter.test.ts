import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  compareVerificationPngs,
  createVerificationScreenshotRequest,
  normalizeVerificationScreenshotResult,
  VerificationVisualContractError,
  type VerificationScreenshotRuntimeRequest,
  type VerificationScreenshotRuntimeResult,
} from "../src/verification-visual-adapter.js";
import {
  decodeVerificationRgba8Png,
  encodeVerificationRgba8Png,
} from "../src/verification-png.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  buildVerificationRunSnapshot,
  canonicalJson,
  verificationBaselineSetSha256,
  type VerificationApprovedBaselineManifest,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const VIEWPORTS = [
  { name: "375x812", width: 375, height: 812 },
  { name: "768x1024", width: 768, height: 1_024 },
  { name: "1440x900", width: 1_440, height: 900 },
] as const;

test("TEST-1711 fixes exactly three screenshot captures to the snapshot", () => {
  const fixture = visualFixture();
  const { request } = fixture;

  assert.equal(request.execution.cwd, "/tmp/ark-team-project");
  assert.equal(request.execution.shell, false);
  assert.equal(request.origin, "http://dev:10001");
  assert.equal(request.url, "http://dev:10001/");
  assert.deepEqual(request.adapter, {
    name: "playwright-cli",
    version: "1.62.0",
  });
  assert.equal(request.browser_build, "chromium-139.0.0");
  assert.deepEqual(
    request.captures.map((capture) => ({
      viewport: capture.viewport,
      width: capture.width,
      height: capture.height,
      dpr: capture.device_scale_factor,
      path: capture.relative_path,
    })),
    [
      {
        viewport: "375x812",
        width: 375,
        height: 812,
        dpr: 1,
        path: "screenshots/home-browser/375x812.actual.png",
      },
      {
        viewport: "768x1024",
        width: 768,
        height: 1_024,
        dpr: 1,
        path: "screenshots/home-browser/768x1024.actual.png",
      },
      {
        viewport: "1440x900",
        width: 1_440,
        height: 900,
        dpr: 1,
        path: "screenshots/home-browser/1440x900.actual.png",
      },
    ],
  );
  assert.deepEqual(request.policy, {
    browser_chrome: "excluded",
    full_page: false,
    resize: "disabled",
    crop: "disabled",
    jpeg_conversion: "disabled",
    color_space_conversion: "disabled",
    alpha_normalization: "disabled",
    post_processing: "disabled",
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.captures), true);
});

test("TEST-1711 accepts exact PNG metadata and separates JSON-safe evidence from bytes", () => {
  const fixture = visualFixture();
  const normalized = normalizeVerificationScreenshotResult(
    fixture.request,
    validScreenshotResult(fixture),
  );

  assert.equal(normalized.images.length, 3);
  assert.equal(normalized.evidence.screenshots.length, 3);
  assert.equal(
    normalized.evidence.package_fingerprint,
    APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
  );
  for (const [index, image] of normalized.images.entries()) {
    const expected = VIEWPORTS[index]!;
    assert.equal(image.evidence.viewport, expected.name);
    assert.equal(image.evidence.width, expected.width);
    assert.equal(image.evidence.height, expected.height);
    assert.equal(image.evidence.device_scale_factor, 1);
    assert.equal(image.evidence.byte_length, image.png_bytes.byteLength);
    assert.equal(image.evidence.sha256, sha256Bytes(image.png_bytes));
    assert.equal("bytes" in image.evidence, false);
  }
  assert.doesNotMatch(JSON.stringify(normalized.evidence), /\"bytes\"/);
});

test("TEST-1711 rejects missing, reordered, transformed, wrong-dimension, hash-drifted, and non-PNG results", () => {
  const fixture = visualFixture();
  const cases: Array<{
    name: string;
    mutate: (result: Mutable<VerificationScreenshotRuntimeResult>) => void;
  }> = [
    {
      name: "missing screenshot",
      mutate: (result) => {
        result.screenshots.pop();
      },
    },
    {
      name: "reordered screenshot",
      mutate: (result) => {
        result.screenshots.reverse();
      },
    },
    {
      name: "unrecorded transform",
      mutate: (result) => {
        (
          result.screenshots[0]!.capture as unknown as {
            resized: boolean;
          }
        ).resized = true;
      },
    },
    {
      name: "wrong dimensions",
      mutate: (result) => {
        const png = rgbaPng(376, 812);
        result.screenshots[0]!.bytes = png;
        result.screenshots[0]!.byte_length = png.byteLength;
        result.screenshots[0]!.sha256 = sha256Bytes(png);
      },
    },
    {
      name: "hash drift",
      mutate: (result) => {
        result.screenshots[0]!.sha256 = "f".repeat(64);
      },
    },
    {
      name: "non-PNG",
      mutate: (result) => {
        const bytes = Uint8Array.from([1, 2, 3]);
        result.screenshots[0]!.bytes = bytes;
        result.screenshots[0]!.byte_length = bytes.byteLength;
        result.screenshots[0]!.sha256 = sha256Bytes(bytes);
      },
    },
  ];

  for (const fixtureCase of cases) {
    const result = validScreenshotResult(fixture);
    fixtureCase.mutate(result);
    assert.throws(
      () =>
        normalizeVerificationScreenshotResult(fixture.request, result),
      isVisualError("SCREENSHOT_CAPTURE_FAILED"),
      fixtureCase.name,
    );
  }
});

test("TEST-1713 produces deterministic transparent/magenta RGBA8 diff without mutating baseline", () => {
  const fixture = visualFixture();
  const normalized = normalizeVerificationScreenshotResult(
    fixture.request,
    validScreenshotResult(fixture),
  );
  const actual = normalized.images[0]!;
  const baseline = fixture.baselinePngs.get("375x812")!;
  const before = Uint8Array.from(baseline);
  const first = compare(fixture, actual, baseline, "approved");
  const second = compare(fixture, actual, baseline, "approved");

  assert.equal(first.passed, true);
  assert.equal(first.evidence.changed_pixel_count, 0);
  assert.equal(first.evidence.pixel_diff_fraction, 0);
  assert.equal(first.evidence.max_channel_delta, 0);
  assert.deepEqual(first.diff_png_bytes, second.diff_png_bytes);
  assert.equal(first.evidence.diff_sha256, sha256Bytes(first.diff_png_bytes));
  assert.equal(
    Buffer.compare(Buffer.from(baseline), Buffer.from(before)),
    0,
  );
  const decodedDiff = decodeVerificationRgba8Png(first.diff_png_bytes);
  assert.deepEqual(decodedDiff.rgba.subarray(0, 4), Uint8Array.of(0, 0, 0, 0));
});

test("TEST-1713 accepts the exact threshold boundary and rejects one pixel beyond it", () => {
  const fixture = visualFixture();
  const pixelCount = 1_440 * 900;
  const boundaryCount = pixelCount * 0.005;
  assert.equal(Number.isInteger(boundaryCount), true);

  const boundaryRgba = new Uint8Array(pixelCount * 4);
  for (let index = 0; index < boundaryCount; index += 1) {
    boundaryRgba[index * 4] = 8;
  }
  const boundaryActual = actualImage(
    fixture,
    "1440x900",
    encodeVerificationRgba8Png({
      width: 1_440,
      height: 900,
      rgba: boundaryRgba,
    }),
  );
  const boundary = compare(
    fixture,
    boundaryActual,
    fixture.baselinePngs.get("1440x900")!,
    "approved",
  );
  assert.equal(boundary.evidence.changed_pixel_count, boundaryCount);
  assert.equal(boundary.evidence.pixel_diff_fraction, 0.005);
  assert.equal(boundary.evidence.max_channel_delta, 8);
  assert.equal(boundary.passed, true);
  const boundaryDiff = decodeVerificationRgba8Png(
    boundary.diff_png_bytes,
  );
  assert.deepEqual(
    boundaryDiff.rgba.subarray(0, 4),
    Uint8Array.of(255, 0, 255, 255),
  );
  assert.deepEqual(
    boundaryDiff.rgba.subarray(
      boundaryCount * 4,
      boundaryCount * 4 + 4,
    ),
    Uint8Array.of(0, 0, 0, 0),
  );

  boundaryRgba[boundaryCount * 4] = 8;
  const beyondActual = actualImage(
    fixture,
    "1440x900",
    encodeVerificationRgba8Png({
      width: 1_440,
      height: 900,
      rgba: boundaryRgba,
    }),
  );
  const beyond = compare(
    fixture,
    beyondActual,
    fixture.baselinePngs.get("1440x900")!,
    "approved",
  );
  assert.equal(beyond.evidence.changed_pixel_count, boundaryCount + 1);
  assert.equal(beyond.passed, false);

  const channelRgba = new Uint8Array(pixelCount * 4);
  channelRgba[0] = 9;
  const channelActual = actualImage(
    fixture,
    "1440x900",
    encodeVerificationRgba8Png({
      width: 1_440,
      height: 900,
      rgba: channelRgba,
    }),
  );
  const channel = compare(
    fixture,
    channelActual,
    fixture.baselinePngs.get("1440x900")!,
    "approved",
  );
  assert.equal(channel.evidence.max_channel_delta, 9);
  assert.equal(channel.passed, false);
});

test("TEST-1713 enforces critical regions and required semantic review while optional review stays advisory", () => {
  const criticalFixture = visualFixture({
    criticalRegion: true,
  });
  const changed = new Uint8Array(375 * 812 * 4);
  changed[0] = 1;
  const criticalActual = actualImage(
    criticalFixture,
    "375x812",
    encodeVerificationRgba8Png({
      width: 375,
      height: 812,
      rgba: changed,
    }),
  );
  const critical = compare(
    criticalFixture,
    criticalActual,
    criticalFixture.baselinePngs.get("375x812")!,
    "approved",
  );
  assert.equal(critical.evidence.pixel_diff_fraction < 0.005, true);
  assert.equal(critical.evidence.max_channel_delta <= 8, true);
  assert.deepEqual(critical.evidence.changed_critical_region_ids, ["hero"]);
  assert.equal(critical.passed, false);

  const requiredFixture = visualFixture();
  const requiredActual = actualImage(
    requiredFixture,
    "375x812",
    requiredFixture.baselinePngs.get("375x812")!,
  );
  assert.equal(
    compare(
      requiredFixture,
      requiredActual,
      requiredFixture.baselinePngs.get("375x812")!,
      "rejected",
    ).passed,
    false,
  );

  const optionalFixture = visualFixture({ semanticReviewRequired: false });
  const optionalActual = actualImage(
    optionalFixture,
    "375x812",
    optionalFixture.baselinePngs.get("375x812")!,
  );
  const optional = compare(
    optionalFixture,
    optionalActual,
    optionalFixture.baselinePngs.get("375x812")!,
    "rejected",
  );
  assert.equal(optional.evidence.semantic_review_outcome, "rejected");
  assert.equal(optional.passed, true);
});

test("TEST-1713 rejects dimension, RGBA8 format, baseline identity, and hash mismatches", () => {
  const fixture = visualFixture();
  const actual = actualImage(
    fixture,
    "375x812",
    fixture.baselinePngs.get("375x812")!,
  );

  const wrongDimensions = structuredClone(actual);
  (
    wrongDimensions.evidence as unknown as { width: number }
  ).width = 376;
  assert.throws(
    () =>
      compare(
        fixture,
        wrongDimensions,
        fixture.baselinePngs.get("375x812")!,
        "approved",
      ),
    isVisualError("INVALID_RECORD"),
  );

  const grayPng = gray8Png(375, 812);
  const grayActual = actualImage(fixture, "375x812", grayPng);
  assert.throws(
    () =>
      compare(
        fixture,
        grayActual,
        fixture.baselinePngs.get("375x812")!,
        "approved",
      ),
    isVisualError("INVALID_RECORD"),
  );

  const incompatible = structuredClone(fixture.manifest);
  incompatible.baseline_id = "different-baseline";
  assert.throws(
    () =>
      compareVerificationPngs({
        snapshot: fixture.snapshot,
        case_id: "home-browser",
        viewport: "375x812",
        baseline: {
          manifest: incompatible,
          manifest_sha256: sha256Bytes(
            Buffer.from(canonicalJson(incompatible), "utf8"),
          ),
          baseline_set_sha256: fixture.baselineSetSha256,
          png_bytes: fixture.baselinePngs.get("375x812")!,
        },
        actual,
        semantic_review_outcome: "approved",
      }),
    isVisualError("BASELINE_NOT_APPROVED"),
  );

  const tampered = Uint8Array.from(
    fixture.baselinePngs.get("375x812")!,
  );
  const lastIndex = tampered.byteLength - 1;
  tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 1;
  assert.throws(
    () => compare(fixture, actual, tampered, "approved"),
    isVisualError("BASELINE_NOT_APPROVED"),
  );
});

interface VisualFixture {
  snapshot: ReturnType<typeof buildVerificationRunSnapshot>;
  request: VerificationScreenshotRuntimeRequest;
  manifest: VerificationApprovedBaselineManifest;
  manifestSha256: string;
  baselineSetSha256: string;
  baselinePngs: Map<(typeof VIEWPORTS)[number]["name"], Uint8Array>;
}

function visualFixture(options: {
  semanticReviewRequired?: boolean;
  criticalRegion?: boolean;
} = {}): VisualFixture {
  const config = validVerificationCoordinatorConfig();
  if (!config.ui.enabled) {
    throw new Error("visual fixture requires an enabled UI lane");
  }
  if (options.semanticReviewRequired === false) {
    config.ui.semantic_review_required = false;
    config.ui.required_capabilities = [
      "browser",
      "comparison",
      "screenshot",
      "server",
    ];
    config.ui.optional_capabilities = [
      "agentic_browser",
      "semantic_review",
    ];
  }
  if (options.criticalRegion) {
    config.ui.critical_regions = [
      { id: "hero", x: 0, y: 0, width: 1, height: 1 },
    ];
  }
  const source = validVerificationSourceIdentity();
  const baselinePngs = new Map<
    (typeof VIEWPORTS)[number]["name"],
    Uint8Array
  >();
  for (const viewport of VIEWPORTS) {
    baselinePngs.set(
      viewport.name,
      rgbaPng(viewport.width, viewport.height),
    );
  }
  const manifest: VerificationApprovedBaselineManifest = {
    schema_version: 1,
    baseline_id: config.ui.baseline_identity.id,
    approval_id: "approval-visual-1",
    approver: "fixture-user",
    approved_at_utc: "2026-07-27T00:00:00.000Z",
    source_commit: source.source_commit,
    source_tree: source.source_tree,
    environment: structuredClone(config.ui.baseline_identity.environment),
    adapter: {
      name: config.ui.deterministic_adapter,
      version: config.ui.deterministic_adapter_version,
    },
    browser_build: config.ui.browser_build,
    entries: VIEWPORTS.map((viewport) => {
      const sha256 = sha256Bytes(baselinePngs.get(viewport.name)!);
      return {
        case_id: "home-browser",
        viewport: viewport.name,
        width: viewport.width,
        height: viewport.height,
        path: `objects/sha256/${sha256}.png`,
        sha256,
      };
    }),
  };
  const baselineSetSha256 = verificationBaselineSetSha256(manifest);
  config.ui.baseline_identity.sha256 = baselineSetSha256;
  const snapshot = buildVerificationRunSnapshot({
    run_id: "ark-20260727t000000z-170611",
    project_path: "/tmp/ark-team-project",
    artifact_root:
      "/tmp/ark-team-state/ark-20260727t000000z-170611/verification",
    server_port: 10_001,
    created_at_utc: "2026-07-27T00:00:00.000Z",
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    source,
    config,
  });
  const request = createVerificationScreenshotRequest({
    snapshot,
    case_id: "home-browser",
    attempt_id: "screenshot-attempt-1",
  });
  return {
    snapshot,
    request,
    manifest,
    manifestSha256: sha256Bytes(
      Buffer.from(canonicalJson(manifest), "utf8"),
    ),
    baselineSetSha256,
    baselinePngs,
  };
}

function validScreenshotResult(
  fixture: VisualFixture,
): Mutable<VerificationScreenshotRuntimeResult> {
  return {
    schema_version: 1,
    contract_id: "verification_screenshot_runtime_result_v1",
    run_id: fixture.request.run_id,
    snapshot_id: fixture.request.snapshot_id,
    case_id: fixture.request.case_id,
    attempt_id: fixture.request.attempt_id,
    case_sha256: fixture.request.case_sha256,
    package_fingerprint: fixture.request.package_fingerprint,
    source_fingerprint: fixture.request.source_fingerprint,
    adapter: { ...fixture.request.adapter },
    browser_build: fixture.request.browser_build,
    origin: fixture.request.origin,
    url: fixture.request.url,
    screenshots: fixture.request.captures.map((capture) => {
      const bytes = Uint8Array.from(
        fixture.baselinePngs.get(capture.viewport)!,
      );
      return {
        ...capture,
        captured_at_utc: "2026-07-27T00:00:01.000Z",
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

function actualImage(
  fixture: VisualFixture,
  viewport: (typeof VIEWPORTS)[number]["name"],
  pngBytes: Uint8Array,
) {
  const raw = validScreenshotResult(fixture);
  const target = raw.screenshots.find(
    (screenshot) => screenshot.viewport === viewport,
  )!;
  target.bytes = Uint8Array.from(pngBytes);
  target.byte_length = pngBytes.byteLength;
  target.sha256 = sha256Bytes(pngBytes);
  const normalized = normalizeVerificationScreenshotResult(
    fixture.request,
    raw,
  );
  return normalized.images.find(
    (image) => image.evidence.viewport === viewport,
  )!;
}

function compare(
  fixture: VisualFixture,
  actual: ReturnType<typeof actualImage>,
  baseline: Uint8Array,
  semanticReviewOutcome:
    | "approved"
    | "rejected"
    | "blocked"
    | "unavailable"
    | "skipped"
    | null,
) {
  return compareVerificationPngs({
    snapshot: fixture.snapshot,
    case_id: "home-browser",
    viewport: actual.evidence.viewport,
    baseline: {
      manifest: fixture.manifest,
      manifest_sha256: fixture.manifestSha256,
      baseline_set_sha256: fixture.baselineSetSha256,
      png_bytes: baseline,
    },
    actual,
    semantic_review_outcome: semanticReviewOutcome,
  });
}

function rgbaPng(width: number, height: number): Uint8Array {
  return encodeVerificationRgba8Png({
    width,
    height,
    rgba: new Uint8Array(width * height * 4),
  });
}

function gray8Png(width: number, height: number): Uint8Array {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const scanlines = Buffer.alloc(height * (width + 1));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.byteLength,
  );
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isVisualError(code: VerificationVisualContractError["code"]) {
  return (error: unknown): boolean =>
    error instanceof VerificationVisualContractError &&
    error.code === code;
}

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};
