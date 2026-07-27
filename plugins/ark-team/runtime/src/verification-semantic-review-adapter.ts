import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
  verificationRunSnapshotV2Schema,
  type VerificationRunSnapshot,
} from "./verification-contract.js";
import { inspectVerificationPng } from "./verification-png.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_IMAGE_BYTES = 10_485_760 as const;
const MAX_OBSERVATIONS = 50 as const;
const MAX_OBSERVATION_BYTES = 16_384 as const;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const VERIFICATION_SEMANTIC_REVIEW_CHECKS = Object.freeze([
  "clipping",
  "missing_or_extra_ui",
  "legibility",
  "layout_shift",
  "privacy_leakage",
] as const);

type VerificationRunSnapshotV2 = Extract<
  VerificationRunSnapshot,
  { schema_version: 2 }
>;

export type VerificationSemanticReviewCheck =
  (typeof VERIFICATION_SEMANTIC_REVIEW_CHECKS)[number];

export interface VerificationSemanticReviewAdapterIdentity {
  readonly name: string;
  readonly version: string;
}

export interface VerificationSemanticReviewChecklistIdentity {
  readonly identity: string;
  readonly version: string;
}

export interface VerificationSemanticReviewActiveTurnSignal {
  readonly capability: "localImage";
  readonly adapter: VerificationSemanticReviewAdapterIdentity;
}

export interface CreateVerificationSemanticReviewRequestInput {
  readonly snapshot: VerificationRunSnapshotV2;
  readonly screenshot_paths: readonly string[];
  readonly checklist: VerificationSemanticReviewChecklistIdentity;
  readonly active_turn_signal?:
    | VerificationSemanticReviewActiveTurnSignal
    | null;
}

export interface VerificationSemanticReviewImageInput {
  readonly path: string;
  readonly byte_length: number;
  readonly sha256: string;
}

export interface VerificationSemanticReviewRequest {
  readonly schema_version: 1;
  readonly contract_id: "verification_semantic_review_v1";
  readonly kind: "verification_semantic_review_request";
  readonly identity: {
    readonly schema_version: 2;
    readonly contract_id: "verification_contract_v2";
    readonly run_id: string;
    readonly snapshot_id: string;
    readonly source_fingerprint: string;
    readonly package_fingerprint: string;
    readonly lane: "ui";
    readonly required: boolean;
    readonly adapter: VerificationSemanticReviewAdapterIdentity;
  };
  readonly input_sha256: string;
  readonly screenshot_root: string;
  readonly images: readonly VerificationSemanticReviewImageInput[];
  readonly turn_extensions: readonly {
    readonly type: "localImage";
    readonly path: string;
  }[];
  readonly checklist: VerificationSemanticReviewChecklistIdentity & {
    readonly sha256: string;
    readonly checks: readonly VerificationSemanticReviewCheck[];
  };
  readonly limits: {
    readonly max_images: 3;
    readonly max_image_bytes: 10_485_760;
    readonly max_observations: 50;
    readonly max_observation_bytes: 16_384;
  };
}

export interface VerificationSemanticReviewObservation {
  readonly check: VerificationSemanticReviewCheck;
  readonly observation: string;
}

export interface VerificationSemanticReviewRuntimeResult {
  readonly schema_version: 1;
  readonly contract_id: "verification_semantic_review_result_v1";
  readonly input_sha256: string;
  readonly adapter: VerificationSemanticReviewAdapterIdentity;
  readonly checklist: {
    readonly identity: string;
    readonly version: string;
    readonly sha256: string;
  };
  readonly reviewed_at_utc: string;
  readonly outcome: "approved" | "rejected" | "blocked";
  readonly observations: readonly VerificationSemanticReviewObservation[];
}

export interface VerificationSemanticReviewEvidence
  extends VerificationSemanticReviewRuntimeResult {}

export interface VerificationSemanticReviewNormalizedResult {
  readonly approved: boolean;
  readonly error_code: "IMAGE_REVIEW_REJECTED" | null;
  readonly message: string | null;
  readonly evidence: VerificationSemanticReviewEvidence;
}

export class VerificationSemanticReviewContractError extends Error {
  readonly code = "INVALID_RECORD";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VerificationSemanticReviewContractError";
  }
}

export class VerificationSemanticReviewUnavailableError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE";
  readonly required: boolean;
  readonly outcome: "unavailable" | "skipped";

  constructor(required: boolean) {
    super("active-turn localImage capability is unavailable");
    this.name = "VerificationSemanticReviewUnavailableError";
    this.required = required;
    this.outcome = required ? "unavailable" : "skipped";
  }
}

const exactVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value === value.trim() &&
      value.toLowerCase() !== "latest" &&
      !/(?:\*|\^|~|[<>]=?|\|\|)/.test(value),
    "version must be exact",
  );

const adapterIdentitySchema = z
  .object({
    name: z.string().regex(IDENTIFIER_PATTERN),
    version: exactVersionSchema,
  })
  .strict();

const checklistIdentitySchema = z
  .object({
    identity: z.string().regex(IDENTIFIER_PATTERN),
    version: exactVersionSchema,
  })
  .strict();

const activeTurnSignalSchema = z
  .object({
    capability: z.literal("localImage"),
    adapter: adapterIdentitySchema,
  })
  .strict();

const requestInputSchema = z
  .object({
    snapshot: verificationRunSnapshotV2Schema,
    screenshot_paths: z.array(z.string()).min(1).max(3),
    checklist: checklistIdentitySchema,
    active_turn_signal: activeTurnSignalSchema.nullish(),
  })
  .strict();

const observationSchema = z
  .object({
    check: z.enum(VERIFICATION_SEMANTIC_REVIEW_CHECKS),
    observation: z.string().min(1).max(2_048),
  })
  .strict();

const runtimeResultSchema = z
  .object({
    schema_version: z.literal(1),
    contract_id: z.literal("verification_semantic_review_result_v1"),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    adapter: adapterIdentitySchema,
    checklist: checklistIdentitySchema.extend({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    reviewed_at_utc: z
      .string()
      .datetime({ offset: true })
      .refine((value) => value.endsWith("Z"), "review time must be UTC"),
    outcome: z.enum(["approved", "rejected", "blocked"]),
    observations: z.array(observationSchema).min(1).max(MAX_OBSERVATIONS),
  })
  .strict();

export async function createVerificationSemanticReviewRequest(
  input: CreateVerificationSemanticReviewRequestInput,
): Promise<VerificationSemanticReviewRequest> {
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw contractError("semantic-review request input is invalid", parsed.error);
  }
  const { snapshot, active_turn_signal: activeTurnSignal } = parsed.data;
  if (!snapshot.ui_contract.enabled) {
    throw contractError("semantic review requires an enabled UI lane");
  }
  const required = snapshot.ui_contract.semantic_review_required;
  if (activeTurnSignal === null || activeTurnSignal === undefined) {
    throw new VerificationSemanticReviewUnavailableError(required);
  }

  const screenshotRoot = path.join(snapshot.artifact_root, "screenshots");
  await assertCanonicalDirectory(screenshotRoot);
  const uniquePaths = new Set(parsed.data.screenshot_paths);
  if (uniquePaths.size !== parsed.data.screenshot_paths.length) {
    throw contractError("semantic-review screenshot paths must be unique");
  }
  const images = await Promise.all(
    parsed.data.screenshot_paths.map((screenshotPath) =>
      inspectScreenshot(screenshotRoot, screenshotPath),
    ),
  );
  const checklist = {
    ...parsed.data.checklist,
    checks: [...VERIFICATION_SEMANTIC_REVIEW_CHECKS],
    sha256: sha256CanonicalJson({
      ...parsed.data.checklist,
      checks: VERIFICATION_SEMANTIC_REVIEW_CHECKS,
    }),
  };
  const identity = {
    schema_version: 2 as const,
    contract_id: "verification_contract_v2" as const,
    run_id: snapshot.run_id,
    snapshot_id: snapshot.snapshot_id,
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    lane: "ui" as const,
    required,
    adapter: activeTurnSignal.adapter,
  };
  const inputSha256 = sha256CanonicalJson({
    identity,
    screenshot_root: screenshotRoot,
    images,
    checklist,
  });

  return deepFreeze({
    schema_version: 1,
    contract_id: "verification_semantic_review_v1",
    kind: "verification_semantic_review_request",
    identity,
    input_sha256: inputSha256,
    screenshot_root: screenshotRoot,
    images,
    turn_extensions: images.map((image) => ({
      type: "localImage" as const,
      path: image.path,
    })),
    checklist,
    limits: {
      max_images: 3,
      max_image_bytes: MAX_IMAGE_BYTES,
      max_observations: MAX_OBSERVATIONS,
      max_observation_bytes: MAX_OBSERVATION_BYTES,
    },
  });
}

export function normalizeVerificationSemanticReviewResult(
  request: VerificationSemanticReviewRequest,
  result: unknown,
): VerificationSemanticReviewNormalizedResult {
  const parsed = runtimeResultSchema.safeParse(result);
  if (!parsed.success) {
    throw contractError("semantic-review result is invalid", parsed.error);
  }
  if (
    parsed.data.input_sha256 !== request.input_sha256 ||
    canonicalJson(parsed.data.adapter) !== canonicalJson(request.identity.adapter) ||
    canonicalJson(parsed.data.checklist) !==
      canonicalJson({
        identity: request.checklist.identity,
        version: request.checklist.version,
        sha256: request.checklist.sha256,
      })
  ) {
    throw contractError("semantic-review result identity does not match its input");
  }
  const rawObservationBytes = Buffer.byteLength(
    canonicalJson(parsed.data.observations),
    "utf8",
  );
  if (rawObservationBytes > MAX_OBSERVATION_BYTES) {
    throw contractError("semantic-review observations exceed 16 KiB");
  }
  const observedChecks = new Set(
    parsed.data.observations.map((observation) => observation.check),
  );
  if (
    VERIFICATION_SEMANTIC_REVIEW_CHECKS.some(
      (check) => !observedChecks.has(check),
    )
  ) {
    throw contractError("semantic-review observations do not cover the checklist");
  }

  const evidence = deepFreeze({
    ...parsed.data,
    observations: parsed.data.observations.map((observation) => ({
      ...observation,
      observation: redactSensitiveText(observation.observation),
    })),
  });
  const approved = evidence.outcome === "approved";
  return {
    approved,
    error_code: approved ? null : "IMAGE_REVIEW_REJECTED",
    message: approved ? null : `semantic review ${evidence.outcome}`,
    evidence,
  };
}

async function assertCanonicalDirectory(directory: string): Promise<void> {
  assertCanonicalAbsolutePath(directory, "screenshot root");
  try {
    const [stats, resolved] = await Promise.all([
      lstat(directory),
      realpath(directory),
    ]);
    if (!stats.isDirectory() || stats.isSymbolicLink() || resolved !== directory) {
      throw contractError("screenshot root must be a canonical non-symlink directory");
    }
  } catch (error) {
    if (error instanceof VerificationSemanticReviewContractError) {
      throw error;
    }
    throw contractError("screenshot root is unavailable", error);
  }
}

async function inspectScreenshot(
  screenshotRoot: string,
  screenshotPath: string,
): Promise<VerificationSemanticReviewImageInput> {
  assertCanonicalAbsolutePath(screenshotPath, "screenshot path");
  if (path.extname(screenshotPath) !== ".png") {
    throw contractError("semantic-review input must have the .png suffix");
  }
  const relative = path.relative(screenshotRoot, screenshotPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw contractError("semantic-review input is outside the screenshot root");
  }

  try {
    const [pathStats, resolved] = await Promise.all([
      lstat(screenshotPath),
      realpath(screenshotPath),
    ]);
    if (
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      resolved !== screenshotPath
    ) {
      throw contractError(
        "semantic-review input must be a canonical regular non-symlink file",
      );
    }
    const handle = await open(
      screenshotPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const openedStats = await handle.stat();
      if (
        !openedStats.isFile() ||
        openedStats.dev !== pathStats.dev ||
        openedStats.ino !== pathStats.ino ||
        openedStats.size <= 0 ||
        openedStats.size > MAX_IMAGE_BYTES
      ) {
        throw contractError("semantic-review PNG is invalid or exceeds 10 MiB");
      }
      const bytes = await handle.readFile();
      if (
        bytes.byteLength !== openedStats.size ||
        bytes.byteLength < PNG_SIGNATURE.byteLength ||
        !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
      ) {
        throw contractError("semantic-review input is not a valid PNG byte stream");
      }
      try {
        inspectVerificationPng(bytes);
      } catch (error) {
        throw contractError(
          "semantic-review input is not a structurally valid PNG",
          error,
        );
      }
      return {
        path: screenshotPath,
        byte_length: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof VerificationSemanticReviewContractError) {
      throw error;
    }
    throw contractError("semantic-review PNG is unavailable", error);
  }
}

function assertCanonicalAbsolutePath(value: string, label: string): void {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value
  ) {
    throw contractError(`${label} must be absolute and canonical`);
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      "[REDACTED]",
    )
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/=_:.-]+/gi, "[REDACTED]")
    .replace(
      /\b(?:api[_-]?key|authorization|cookie|password|secret|token)\b\s*[:=]\s*[^\s,;]+/gi,
      "[REDACTED]",
    )
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED]")
    .replace(/\b\d{6}-?[1-4]\d{6}\b/g, "[REDACTED]")
    .replace(/\b(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[-. ]?\d{4}\b/g, "[REDACTED]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, "[REDACTED]");
}

function contractError(
  message: string,
  cause?: unknown,
): VerificationSemanticReviewContractError {
  return new VerificationSemanticReviewContractError(message, { cause });
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
