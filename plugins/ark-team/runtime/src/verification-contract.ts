import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod/v4";

import { ArkTeamError } from "./errors.js";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^ark-\d{8}t\d{6}z-[a-z0-9]{6}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_PATTERN =
  /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*(?:=|:)/i;
const SECRET_ARGUMENT_PATTERN =
  /^(?:--?)?(?:api[_-]?key|authorization|cookie|password|secret|token)(?:$|[=:])/i;

const boundedStringSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.trim().length > 0, "blank value is forbidden")
  .refine((value) => !value.includes("\0"), "value contains NUL")
  .refine((value) => !SECRET_PATTERN.test(value), "secret-bearing value is forbidden");

const identifierSchema = z.string().regex(IDENTIFIER_PATTERN);
const shaSchema = z.string().regex(SHA_PATTERN);
const sha256Schema = z.string().regex(SHA256_PATTERN);

function isCanonicalRelativePath(value: string): boolean {
  return (
    !path.posix.isAbsolute(value) &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    path.posix.normalize(value) === value &&
    !value.split("/").some((component) => component === "" || component === "..")
  );
}

function isLocalPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  let decoded = value;
  let stable = false;
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        stable = true;
        break;
      }
      decoded = next;
    }
  } catch {
    return false;
  }
  return (
    stable &&
    decoded.startsWith("/") &&
    !decoded.startsWith("//") &&
    !decoded.includes("\\") &&
    !decoded.includes("?") &&
    !decoded.includes("#") &&
    !/[\u0000-\u001f\u007f]/.test(decoded) &&
    path.posix.normalize(decoded) === decoded &&
    !decoded.split("/").some((component) => component === "..")
  );
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path,
      message: "values must be unique",
    });
  }
}

const capabilitySchema = z.enum([
  "server",
  "api",
  "browser",
  "screenshot",
  "semantic_review",
  "comparison",
]);

const requiredCapabilitiesSchema = z
  .array(capabilitySchema)
  .min(1)
  .max(6)
  .superRefine((values, context) =>
    addDuplicateIssues(values, context, ["required_capabilities"]),
  );

const requiredViewportsSchema = z.tuple([
  z.literal("375x812"),
  z.literal("768x1024"),
  z.literal("1440x900"),
]);

const browserEnvironmentSchema = z
  .object({
    viewports: requiredViewportsSchema,
    device_scale_factor: z.literal(1),
    locale: z.literal("en-US"),
    timezone: z.literal("UTC"),
    color_scheme: z.literal("light"),
    reduced_motion: z.literal("no-preference"),
  })
  .strict();

const apiBodyDigestSchema = z.union([z.literal("none"), sha256Schema]);

const apiQuerySchema = z
  .record(
    z.string().min(1).max(128),
    boundedStringSchema.max(4_096),
  )
  .superRefine((query, context) => {
    const keys = Object.keys(query);
    if (keys.length > 50) {
      context.addIssue({
        code: "custom",
        message: "query map exceeds 50 entries",
      });
    }
    for (const key of keys) {
      if (SECRET_PATTERN.test(`${key}:`)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "secret-bearing query keys are forbidden",
        });
      }
    }
  });

export const verificationApiProbeSchema = z
  .object({
    id: identifierSchema,
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1).max(2_048).refine(isLocalPath, "invalid local API path"),
    query: apiQuerySchema,
    headers: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9-]+$/)
          .refine(
            (value) => !SECRET_PATTERN.test(`${value}:`),
            "secret-bearing request headers are forbidden",
          ),
        boundedStringSchema.max(4_096),
      )
      .superRefine((headers, context) => {
        const names = Object.keys(headers);
        if (names.length > 50) {
          context.addIssue({
            code: "custom",
            message: "header map exceeds 50 entries",
          });
        }
        addDuplicateIssues(
          names.map((value) => value.toLowerCase()),
          context,
          ["headers"],
        );
      }),
    body_digest: apiBodyDigestSchema,
    expected_status: z.number().int().min(100).max(599),
    expected_content_type: boundedStringSchema.max(256),
    required: z.boolean(),
  })
  .strict()
  .superRefine((probe, context) => {
    if (
      (probe.method === "GET" || probe.method === "HEAD") &&
      probe.body_digest !== "none"
    ) {
      context.addIssue({
        code: "custom",
        path: ["body_digest"],
        message: `${probe.method} probes cannot declare a request body`,
      });
    }
  });

const clickActionSchema = z
  .object({
    type: z.literal("click"),
    selector: boundedStringSchema,
  })
  .strict();
const fillActionSchema = z
  .object({
    type: z.literal("fill"),
    selector: boundedStringSchema,
    value: boundedStringSchema.max(10_000),
  })
  .strict();
const pressActionSchema = z
  .object({
    type: z.literal("press"),
    selector: boundedStringSchema,
    key: boundedStringSchema.max(100),
  })
  .strict();
const waitActionSchema = z
  .object({
    type: z.literal("wait_for_selector"),
    selector: boundedStringSchema,
  })
  .strict();

export const verificationBrowserActionSchema = z.discriminatedUnion("type", [
  clickActionSchema,
  fillActionSchema,
  pressActionSchema,
  waitActionSchema,
]);

export const verificationBrowserCaseSchema = z
  .object({
    id: identifierSchema,
    path: z.string().min(1).max(2_048).refine(isLocalPath, "invalid local browser path"),
    readiness: boundedStringSchema,
    actions: z.array(verificationBrowserActionSchema).max(50),
    required: z.boolean(),
  })
  .strict();

const criticalRegionSchema = z
  .object({
    id: identifierSchema,
    x: z.number().int().nonnegative().max(374),
    y: z.number().int().nonnegative().max(811),
    width: z.number().int().positive().max(375),
    height: z.number().int().positive().max(812),
  })
  .strict()
  .superRefine((region, context) => {
    if (region.x + region.width > 375 || region.y + region.height > 812) {
      context.addIssue({
        code: "custom",
        message: "critical region exceeds the required viewport bounds",
      });
    }
  });

export const verificationBaselineIdentitySchema = z
  .object({
    id: identifierSchema,
    sha256: sha256Schema,
    source_commit: shaSchema,
    source_tree: shaSchema,
    environment: browserEnvironmentSchema,
  })
  .strict();

const verificationComparisonPolicySchema = z
  .object({
    pixel_diff_fraction_max: z.literal(0.005),
    max_channel_delta: z.literal(8),
    critical_regions: z.array(criticalRegionSchema).max(100),
  })
  .strict()
  .superRefine((policy, context) =>
    addDuplicateIssues(
      policy.critical_regions.map((region) => region.id),
      context,
      ["critical_regions"],
    ),
  );

const verificationEvidencePolicySchema = z
  .object({
    console_event_limit: z.literal(100),
    console_byte_limit: z.literal(32 * 1_024),
    network_event_limit: z.literal(100),
    network_byte_limit: z.literal(32 * 1_024),
    api_preview_byte_limit: z.literal(64 * 1_024),
    retention_days: z.literal(30),
    semantic_review_required: z.boolean(),
    max_files: z.literal(500),
    max_file_bytes: z.literal(50 * 1_024 * 1_024),
    max_total_bytes: z.literal(500 * 1_024 * 1_024),
    max_metadata_bytes_per_check: z.literal(64 * 1_024),
  })
  .strict();

const verificationTimeoutsSchema = z
  .object({
    server_ms: z.literal(30_000),
    api_ms: z.literal(30_000),
    browser_ms: z.literal(60_000),
    case_ms: z.literal(120_000),
  })
  .strict();

const verificationAttemptsSchema = z
  .object({
    readiness: z.literal(2),
    api: z.literal(2),
    browser: z.literal(2),
    screenshot: z.literal(1),
    comparison: z.literal(1),
    semantic_review: z.literal(1),
    artifact_write: z.literal(1),
    cleanup: z.literal(1),
  })
  .strict();

const verificationEvidenceLimitsSchema = z
  .object({
    console_events: z.literal(100),
    network_events: z.literal(100),
    metadata_bytes: z.literal(64 * 1_024),
    api_preview_bytes: z.literal(64 * 1_024),
    file_bytes: z.literal(50 * 1_024 * 1_024),
    total_bytes: z.literal(500 * 1_024 * 1_024),
    file_count: z.literal(500),
  })
  .strict();

export const verificationCoordinatorConfigSchema = z
  .object({
    schema_version: z.literal(1),
    enabled: z.boolean(),
    required_capabilities: requiredCapabilitiesSchema,
    server_argv: z.array(boundedStringSchema).min(1).max(32),
    server_bind: z.literal("0.0.0.0"),
    server_host: z.literal("dev"),
    server_port_floor: z.literal(10_001),
    server_readiness_path: z
      .string()
      .min(1)
      .max(2_048)
      .refine(isLocalPath, "invalid readiness path"),
    server_readiness_status: z.number().int().min(100).max(599),
    server_readiness_timeout_ms: z.literal(30_000),
    api_probes: z.array(verificationApiProbeSchema).min(1).max(50),
    api_adapter: z.literal("curl"),
    browser_adapter: z.literal("playwright-cli"),
    browser_cases: z.array(verificationBrowserCaseSchema).min(1).max(50),
    viewports: requiredViewportsSchema,
    baseline_root: z
      .string()
      .min(1)
      .max(1_000)
      .refine(isCanonicalRelativePath, "baseline_root must be canonical and project-relative"),
    baseline_identity: verificationBaselineIdentitySchema,
    pixel_diff_fraction_max: z.literal(0.005),
    max_channel_delta: z.literal(8),
    critical_regions: z.array(criticalRegionSchema).max(100),
    evidence_limits: verificationEvidenceLimitsSchema,
    console_bytes: z.literal(32 * 1_024),
    network_bytes: z.literal(32 * 1_024),
    semantic_review_required: z.boolean(),
    retention_days: z.literal(30),
    server_timeout_ms: z.literal(30_000),
    api_timeout_ms: z.literal(30_000),
    browser_timeout_ms: z.literal(60_000),
    case_timeout_ms: z.literal(120_000),
    attempts: verificationAttemptsSchema,
    approval_policy: z.literal("explicit-one-time-user-decision"),
  })
  .strict()
  .superRefine((config, context) => {
    addDuplicateIssues(
      config.api_probes.map((probe) => probe.id),
      context,
      ["api_probes"],
    );
    addDuplicateIssues(
      config.browser_cases.map((browserCase) => browserCase.id),
      context,
      ["browser_cases"],
    );
    addDuplicateIssues(
      config.critical_regions.map((region) => region.id),
      context,
      ["critical_regions"],
    );
    for (const capability of ["server", "api"] as const) {
      if (!config.required_capabilities.includes(capability)) {
        context.addIssue({
          code: "custom",
          path: ["required_capabilities"],
          message: `verification coordinator requires the ${capability} capability`,
        });
      }
    }
    if (
      config.semantic_review_required &&
      !config.required_capabilities.includes("semantic_review")
    ) {
      context.addIssue({
        code: "custom",
        path: ["required_capabilities"],
        message: "required semantic review must be declared as a capability",
      });
    }
    if (
      config.api_probes.some((probe) => probe.required) &&
      !config.required_capabilities.includes("api")
    ) {
      context.addIssue({
        code: "custom",
        path: ["required_capabilities"],
        message: "required API probes require the api capability",
      });
    }
    if (config.browser_cases.some((browserCase) => browserCase.required)) {
      for (const capability of ["browser", "screenshot", "comparison"] as const) {
        if (!config.required_capabilities.includes(capability)) {
          context.addIssue({
            code: "custom",
            path: ["required_capabilities"],
            message: `required browser cases require the ${capability} capability`,
          });
        }
      }
    }
    if (
      config.required_capabilities.includes("comparison") &&
      !config.required_capabilities.includes("screenshot")
    ) {
      context.addIssue({
        code: "custom",
        path: ["required_capabilities"],
        message: "comparison requires the screenshot capability",
      });
    }
    if (
      config.required_capabilities.includes("screenshot") &&
      !config.required_capabilities.includes("browser")
    ) {
      context.addIssue({
        code: "custom",
        path: ["required_capabilities"],
        message: "screenshot capture requires the browser capability",
      });
    }
    if (
      config.required_capabilities.includes("semantic_review") &&
      !config.required_capabilities.includes("screenshot")
    ) {
      context.addIssue({
        code: "custom",
        path: ["required_capabilities"],
        message: "semantic review requires the screenshot capability",
      });
    }
    const executable = path.basename(config.server_argv[0] ?? "").toLowerCase();
    if (
      ["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"].includes(
        executable,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["server_argv", 0],
        message: "server_argv must not invoke a shell",
      });
    }
    config.server_argv.forEach((argument, index) => {
      if (SECRET_ARGUMENT_PATTERN.test(argument)) {
        context.addIssue({
          code: "custom",
          path: ["server_argv", index],
          message: "server_argv must not contain credential arguments",
        });
      }
    });
  });

export type VerificationCoordinatorConfig = z.infer<
  typeof verificationCoordinatorConfigSchema
>;

export const verificationStageSchema = z.enum([
  "integrated",
  "configured",
  "snapshotted",
  "capabilities",
  "ready",
  "executing",
  "collecting",
  "deciding",
  "pm_review_pending",
  "original_pm_review",
]);

export const verificationOutcomeSchema = z.enum([
  "passed",
  "failed",
  "unavailable",
  "skipped",
  "error",
]);

const verificationRecordTypeSchema = z.enum([
  "source",
  "config",
  "snapshot",
  "capability",
  "request",
  "browser",
  "screenshot",
  "review",
  "comparison",
  "artifact",
  "error",
  "report",
  "rollback",
  "spec_delta",
]);

const verificationErrorCodeSchema = z.enum([
  "SOURCE_DRIFT",
  "PACKAGE_FINGERPRINT_MISMATCH",
  "CONFIG_INVALID",
  "SCENARIO_SNAPSHOT_MISMATCH",
  "ARTIFACT_ROOT_INVALID",
  "BASELINE_NOT_APPROVED",
  "CAPABILITY_UNAVAILABLE",
  "SERVER_NOT_READY",
  "API_CONTRACT_MISMATCH",
  "BROWSER_CONTRACT_MISMATCH",
  "SCREENSHOT_CAPTURE_FAILED",
  "IMAGE_REVIEW_REJECTED",
  "COMPARISON_THRESHOLD_FAILED",
  "APPROVAL_REQUIRED",
  "TIMEOUT",
  "ENVIRONMENT_UNAVAILABLE",
  "INVALID_RECORD",
]);

const verificationRecordPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("source"),
      source_sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("config"),
      config_sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("snapshot"),
      snapshot_sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("capability"),
      capability: capabilitySchema,
      available: z.boolean(),
      version: boundedStringSchema.max(128).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("request"),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().min(1).max(2_048).refine(isLocalPath, "invalid request path"),
      expected_status: z.number().int().min(100).max(599),
      actual_status: z.number().int().min(100).max(599),
      request_sha256: sha256Schema,
      response_sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser"),
      case_sha256: sha256Schema,
      action_count: z.number().int().nonnegative().max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("screenshot"),
      viewport: z.enum(["375x812", "768x1024", "1440x900"]),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      image_sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("review"),
      outcome: z.enum(["passed", "failed", "unavailable", "error"]),
      image_sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("comparison"),
      outcome: z.enum(["passed", "failed", "error"]),
      baseline_sha256: sha256Schema,
      actual_sha256: sha256Schema,
      diff_sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      artifact_id: identifierSchema,
      relative_path: z
        .string()
        .min(1)
        .max(1_000)
        .refine(isCanonicalRelativePath, "invalid artifact path"),
      media_type: z.enum([
        "image/png",
        "application/json",
        "application/x-ndjson",
        "text/plain",
      ]),
      byte_length: z.number().int().positive().max(50 * 1_024 * 1_024),
      sha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: verificationErrorCodeSchema,
      message: boundedStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("report"),
      outcome: verificationOutcomeSchema,
      evidence_record_ids: z.array(identifierSchema).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rollback"),
      contract_id: z.literal("verification_contract_v1"),
      new_starts_enabled: z.literal(false),
      preserves_existing_records: z.literal(true),
      reason: boundedStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("spec_delta"),
      status: z.literal("SPEC_DELTA_REQUIRED"),
      runtime_status: z.literal("not_started"),
      affected_ids: z.array(identifierSchema).min(1).max(50),
      classification: z.enum([
        "omission",
        "contradiction",
        "unsafe_input",
        "environment_mismatch",
        "unverifiable",
      ]),
      source_snapshot: z
        .object({
          worktree_root: z.string().min(1).refine(path.isAbsolute),
          commit: shaSchema,
          tree: shaSchema,
          package_fingerprint: sha256Schema,
        })
        .strict(),
      evidence: z
        .array(
          z
            .object({
              kind: identifierSchema,
              value: boundedStringSchema,
            })
            .strict(),
        )
        .max(50),
      impact: boundedStringSchema,
      proposed_resolution: boundedStringSchema,
      blocking_stage: identifierSchema,
      created_at_utc: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export const verificationLinkedRecordSchema = z
  .object({
    schema_version: z.literal(1),
    record_id: identifierSchema,
    record_type: verificationRecordTypeSchema,
    run_id: z.string().regex(RUN_ID_PATTERN),
    case_id: identifierSchema,
    snapshot_id: identifierSchema,
    stage: verificationStageSchema,
    timestamp_utc: z.string().datetime({ offset: true }),
    source_fingerprint: sha256Schema,
    package_fingerprint: sha256Schema,
    required: z.boolean(),
    previous_record_sha256: sha256Schema.nullable(),
    payload_sha256: sha256Schema,
    payload: verificationRecordPayloadSchema,
    adapter: z
      .object({
        name: identifierSchema,
        version: boundedStringSchema.max(128),
      })
      .strict()
      .nullable(),
    artifact_references: z
      .array(
        z
          .object({
            artifact_id: identifierSchema,
            relative_path: z
              .string()
              .min(1)
              .max(1_000)
              .refine(
                isCanonicalRelativePath,
                "artifact reference must be canonical and relative",
              ),
            sha256: sha256Schema,
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.record_type !== record.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "record payload kind does not match record_type",
      });
    }
    if (record.payload_sha256 !== sha256CanonicalJson(record.payload)) {
      context.addIssue({
        code: "custom",
        path: ["payload_sha256"],
        message: "record payload hash does not match",
      });
    }
    if (
      [
        "capability",
        "request",
        "browser",
        "screenshot",
        "review",
        "comparison",
      ].includes(
        record.record_type,
      ) &&
      record.adapter === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapter"],
        message: "adapter identity is required for this record type",
      });
    }
    if (
      ["screenshot", "review", "comparison", "artifact"].includes(
        record.record_type,
      ) &&
      record.artifact_references.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifact_references"],
        message: "artifact-linked record has no artifact reference",
      });
    }
  });

export type VerificationLinkedRecord = z.infer<
  typeof verificationLinkedRecordSchema
>;

export function appendVerificationLinkedRecord(
  existing: readonly VerificationLinkedRecord[],
  input: VerificationLinkedRecord,
): readonly VerificationLinkedRecord[] {
  const records = existing.map((record) =>
    verificationLinkedRecordSchema.parse(record),
  );
  const record = verificationLinkedRecordSchema.parse(input);
  if (records.some((candidate) => candidate.record_id === record.record_id)) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "verification record IDs are append-only and unique",
    );
  }
  const previous = records.at(-1);
  const expectedPreviousHash =
    previous === undefined ? null : sha256CanonicalJson(previous);
  if (record.previous_record_sha256 !== expectedPreviousHash) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "verification record does not extend the append-only hash chain",
    );
  }
  return Object.freeze([...records, record]);
}

export const verificationRollbackRecordSchema = z
  .object({
    schema_version: z.literal(1),
    contract_id: z.literal("verification_contract_v1"),
    package_fingerprint: sha256Schema,
    new_starts_enabled: z.literal(false),
    preserves_existing_records: z.literal(true),
    reason: boundedStringSchema,
    recorded_at_utc: z.string().datetime({ offset: true }),
  })
  .strict();

export type VerificationRollbackRecord = z.infer<
  typeof verificationRollbackRecordSchema
>;

export const verificationSourceIdentitySchema = z
  .object({
    worktree_root: z
      .string()
      .min(1)
      .refine(
        (value) =>
          path.isAbsolute(value) &&
          path.normalize(value) === value &&
          path.resolve(value) === value,
        "worktree_root must be absolute and canonical",
      ),
    source_label: boundedStringSchema,
    source_ref: boundedStringSchema.nullable(),
    source_commit: shaSchema,
    source_tree: shaSchema,
    worktree_state: z.enum(["GIT_CLEAN", "GIT_DIRTY"]),
    porcelain_status: z.array(
      z
        .string()
        .min(1)
        .max(1_000)
        .refine(
          (value) => !SECRET_PATTERN.test(value),
          "secret-bearing source status is forbidden",
        ),
    ),
    capture_method: z.literal("git-literal-argv-v1"),
    captured_at_utc: z.string().datetime({ offset: true }),
  })
  .strict();

export type VerificationSourceIdentity = z.infer<
  typeof verificationSourceIdentitySchema
>;

export const verificationPackageIdentitySchema = z
  .object({
    package_id: z.literal("verification-spec-v2"),
    package_status: z.literal("SPEC_APPROVED"),
    package_fingerprint: sha256Schema,
    authority_date: z.literal("2026-07-26"),
    reference_boundary: z.literal("NONE"),
    spec_sha256: sha256Schema,
  })
  .strict();

export const APPROVED_VERIFICATION_SPEC_SHA256 =
  "277fb413390f83f49fdf34fab4a42e3eca83d3f499fe5442e884f165a0128399";

export const APPROVED_VERIFICATION_PACKAGE = Object.freeze({
  package_id: "verification-spec-v2",
  package_status: "SPEC_APPROVED",
  package_fingerprint:
    "095ae3afac8429264c82145d83a912ac39c0a26f3c30e9ab38398348356256af",
  authority_date: "2026-07-26",
  reference_boundary: "NONE",
  spec_sha256: APPROVED_VERIFICATION_SPEC_SHA256,
}) satisfies z.infer<typeof verificationPackageIdentitySchema>;

const verificationServerSnapshotSchema = z
  .object({
    host: z.literal("dev"),
    bind: z.literal("0.0.0.0"),
    port: z.number().int().min(10_001).max(65_535),
    api_origin: z.string().url(),
  })
  .strict()
  .superRefine((server, context) => {
    if (server.api_origin !== `http://dev:${server.port}`) {
      context.addIssue({
        code: "custom",
        path: ["api_origin"],
        message: "api_origin does not match the recorded local port",
      });
    }
  });

export const verificationRunSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    snapshot_id: identifierSchema,
    package: verificationPackageIdentitySchema,
    source: verificationSourceIdentitySchema,
    source_fingerprint: sha256Schema,
    run_id: z.string().regex(RUN_ID_PATTERN),
    case_id: z.literal("BOOTSTRAP-1701"),
    scenario_version: z.literal(1),
    stage: z.literal("snapshotted"),
    required: z.literal(true),
    created_at_utc: z.string().datetime({ offset: true }),
    artifact_root: z.string().min(1).refine(path.isAbsolute, "artifact_root must be absolute"),
    artifact_references: z.array(boundedStringSchema).max(500),
    baseline_root: z.string().min(1).refine(path.isAbsolute, "baseline_root must be absolute"),
    baseline_identity: verificationBaselineIdentitySchema,
    server: verificationServerSnapshotSchema,
    browser_environment: browserEnvironmentSchema,
    required_capabilities: requiredCapabilitiesSchema,
    api_contract: z
      .object({
        adapter: z.literal("curl"),
        probes: z.array(verificationApiProbeSchema).min(1).max(50),
      })
      .strict(),
    browser_contract: z
      .object({
        adapter: z.literal("playwright-cli"),
        cases: z.array(verificationBrowserCaseSchema).min(1).max(50),
      })
      .strict(),
    timeouts_ms: verificationTimeoutsSchema,
    attempt_policy: verificationAttemptsSchema,
    comparison_policy: verificationComparisonPolicySchema,
    evidence_policy: verificationEvidencePolicySchema,
    approval_policy: z.literal(
      "explicit-one-time-user-decision",
    ),
    resolved_config: verificationCoordinatorConfigSchema,
    resolved_config_canonical: z.string().min(2),
    resolved_config_sha256: sha256Schema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      canonicalJson(snapshot.package) !==
      canonicalJson(APPROVED_VERIFICATION_PACKAGE)
    ) {
      context.addIssue({
        code: "custom",
        path: ["package"],
        message: "snapshot package does not match the approved package",
      });
    }
    if (
      snapshot.source.worktree_state !== "GIT_CLEAN" ||
      snapshot.source.porcelain_status.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "snapshot source must be a clean dynamic capture",
      });
    }
    if (
      snapshot.source_fingerprint !==
      sha256CanonicalJson(snapshot.source)
    ) {
      context.addIssue({
        code: "custom",
        path: ["source_fingerprint"],
        message: "source fingerprint does not match the source record",
      });
    }
    if (
      snapshot.baseline_identity.source_commit !==
        snapshot.source.source_commit ||
      snapshot.baseline_identity.source_tree !== snapshot.source.source_tree
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseline_identity"],
        message: "baseline identity does not match the approved source",
      });
    }
    const config = snapshot.resolved_config;
    if (snapshot.server.port < config.server_port_floor) {
      context.addIssue({
        code: "custom",
        path: ["server", "port"],
        message: "recorded server port is below the configured floor",
      });
    }
    if (snapshot.resolved_config_canonical !== canonicalJson(config)) {
      context.addIssue({
        code: "custom",
        path: ["resolved_config_canonical"],
        message: "resolved configuration canonical bytes do not match",
      });
    }
    if (
      snapshot.resolved_config_sha256 !==
      sha256CanonicalJson(config)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolved_config_sha256"],
        message: "resolved configuration hash does not match",
      });
    }
    const linkedValues: Array<[unknown, unknown, PropertyKey[]]> = [
      [snapshot.baseline_identity, config.baseline_identity, ["baseline_identity"]],
      [snapshot.browser_environment.viewports, config.viewports, ["browser_environment"]],
      [snapshot.required_capabilities, config.required_capabilities, ["required_capabilities"]],
      [snapshot.api_contract.adapter, config.api_adapter, ["api_contract", "adapter"]],
      [snapshot.api_contract.probes, config.api_probes, ["api_contract", "probes"]],
      [snapshot.browser_contract.adapter, config.browser_adapter, ["browser_contract", "adapter"]],
      [snapshot.browser_contract.cases, config.browser_cases, ["browser_contract", "cases"]],
      [
        snapshot.timeouts_ms,
        {
          server_ms: config.server_timeout_ms,
          api_ms: config.api_timeout_ms,
          browser_ms: config.browser_timeout_ms,
          case_ms: config.case_timeout_ms,
        },
        ["timeouts_ms"],
      ],
      [snapshot.attempt_policy, config.attempts, ["attempt_policy"]],
      [
        snapshot.comparison_policy,
        {
          pixel_diff_fraction_max: config.pixel_diff_fraction_max,
          max_channel_delta: config.max_channel_delta,
          critical_regions: config.critical_regions,
        },
        ["comparison_policy"],
      ],
      [
        snapshot.evidence_policy,
        {
          console_event_limit: config.evidence_limits.console_events,
          console_byte_limit: config.console_bytes,
          network_event_limit: config.evidence_limits.network_events,
          network_byte_limit: config.network_bytes,
          api_preview_byte_limit: config.evidence_limits.api_preview_bytes,
          retention_days: config.retention_days,
          semantic_review_required: config.semantic_review_required,
          max_files: config.evidence_limits.file_count,
          max_file_bytes: config.evidence_limits.file_bytes,
          max_total_bytes: config.evidence_limits.total_bytes,
          max_metadata_bytes_per_check: config.evidence_limits.metadata_bytes,
        },
        ["evidence_policy"],
      ],
      [snapshot.approval_policy, config.approval_policy, ["approval_policy"]],
    ];
    for (const [actual, expected, issuePath] of linkedValues) {
      if (canonicalJson(actual) !== canonicalJson(expected)) {
        context.addIssue({
          code: "custom",
          path: issuePath,
          message: "snapshot value does not match resolved configuration",
        });
      }
    }
  });

export type VerificationRunSnapshot = z.infer<
  typeof verificationRunSnapshotSchema
>;

export interface BuildVerificationRunSnapshotInput {
  run_id: string;
  project_path: string;
  artifact_root: string;
  server_port: number;
  created_at_utc: string;
  package_fingerprint: string;
  source: VerificationSourceIdentity;
  config: VerificationCoordinatorConfig;
}

export function buildVerificationRunSnapshot(
  input: BuildVerificationRunSnapshotInput,
): VerificationRunSnapshot {
  assertVerificationPackageFingerprint(input.package_fingerprint);
  assertVerificationSourceIdentity(input.source);
  const parsedConfig = verificationCoordinatorConfigSchema.safeParse(input.config);
  if (!parsedConfig.success) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "verification coordinator configuration is invalid",
      { cause: parsedConfig.error },
    );
  }
  const config = parsedConfig.data;
  if (!config.enabled) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "verification coordinator is not enabled",
    );
  }
  if (
    config.baseline_identity.source_commit !== input.source.source_commit ||
    config.baseline_identity.source_tree !== input.source.source_tree
  ) {
    throw new ArkTeamError(
      "SOURCE_DRIFT",
      "approved baseline identity does not match the captured source",
    );
  }
  const parsedSnapshot = verificationRunSnapshotSchema.safeParse({
    schema_version: 1,
    snapshot_id: `${input.run_id}-verification-v1`,
    package: APPROVED_VERIFICATION_PACKAGE,
    source: input.source,
    source_fingerprint: sha256CanonicalJson(input.source),
    run_id: input.run_id,
    case_id: "BOOTSTRAP-1701",
    scenario_version: 1,
    stage: "snapshotted",
    required: true,
    created_at_utc: input.created_at_utc,
    artifact_root: input.artifact_root,
    artifact_references: [],
    baseline_root: path.resolve(input.project_path, config.baseline_root),
    baseline_identity: config.baseline_identity,
    server: {
      host: config.server_host,
      bind: config.server_bind,
      port: input.server_port,
      api_origin: `http://dev:${input.server_port}`,
    },
    browser_environment: config.baseline_identity.environment,
    required_capabilities: config.required_capabilities,
    api_contract: {
      adapter: config.api_adapter,
      probes: config.api_probes,
    },
    browser_contract: {
      adapter: config.browser_adapter,
      cases: config.browser_cases,
    },
    timeouts_ms: {
      server_ms: config.server_timeout_ms,
      api_ms: config.api_timeout_ms,
      browser_ms: config.browser_timeout_ms,
      case_ms: config.case_timeout_ms,
    },
    attempt_policy: config.attempts,
    comparison_policy: {
      pixel_diff_fraction_max: config.pixel_diff_fraction_max,
      max_channel_delta: config.max_channel_delta,
      critical_regions: config.critical_regions,
    },
    evidence_policy: {
      console_event_limit: config.evidence_limits.console_events,
      console_byte_limit: config.console_bytes,
      network_event_limit: config.evidence_limits.network_events,
      network_byte_limit: config.network_bytes,
      api_preview_byte_limit: config.evidence_limits.api_preview_bytes,
      retention_days: config.retention_days,
      semantic_review_required: config.semantic_review_required,
      max_files: config.evidence_limits.file_count,
      max_file_bytes: config.evidence_limits.file_bytes,
      max_total_bytes: config.evidence_limits.total_bytes,
      max_metadata_bytes_per_check: config.evidence_limits.metadata_bytes,
    },
    approval_policy: config.approval_policy,
    resolved_config: config,
    resolved_config_canonical: canonicalJson(config),
    resolved_config_sha256: sha256CanonicalJson(config),
  });
  if (!parsedSnapshot.success) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "verification run snapshot is invalid",
      { cause: parsedSnapshot.error },
    );
  }
  return parsedSnapshot.data;
}

export function verificationRunSnapshotSha256(
  snapshot: VerificationRunSnapshot,
): string {
  return sha256CanonicalJson(verificationRunSnapshotSchema.parse(snapshot));
}

export function assertVerificationPackageFingerprint(
  fingerprint: string,
): void {
  if (fingerprint !== APPROVED_VERIFICATION_PACKAGE.package_fingerprint) {
    throw new ArkTeamError(
      "PACKAGE_FINGERPRINT_MISMATCH",
      "verification package fingerprint does not match the approved package",
    );
  }
}

export function verificationSpecSha256(
  bytes: string | Uint8Array,
): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verificationPackageFingerprint(
  bytes: string | Uint8Array,
): string {
  return sha256CanonicalJson({
    package_id: APPROVED_VERIFICATION_PACKAGE.package_id,
    authority_date: APPROVED_VERIFICATION_PACKAGE.authority_date,
    spec_bytes:
      typeof bytes === "string"
        ? bytes
        : Buffer.from(bytes).toString("utf8"),
  });
}

export function assertVerificationPackageBytes(
  bytes: string | Uint8Array,
): void {
  if (
    verificationSpecSha256(bytes) !== APPROVED_VERIFICATION_SPEC_SHA256 ||
    verificationPackageFingerprint(bytes) !==
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint
  ) {
    throw new ArkTeamError(
      "PACKAGE_FINGERPRINT_MISMATCH",
      "verification package bytes do not match the approved package",
    );
  }
}

export function assertVerificationSourceIdentity(
  actualInput: VerificationSourceIdentity,
  expectedInput?: VerificationSourceIdentity,
): void {
  const parsedActual = verificationSourceIdentitySchema.safeParse(actualInput);
  const parsedExpected =
    expectedInput === undefined
      ? undefined
      : verificationSourceIdentitySchema.safeParse(expectedInput);
  if (!parsedActual.success || parsedExpected?.success === false) {
    throw new ArkTeamError(
      "SOURCE_DRIFT",
      "verification source identity is malformed",
      {
        cause:
          parsedActual.success && parsedExpected?.success === false
            ? parsedExpected.error
            : parsedActual.error,
      },
    );
  }
  const actual = parsedActual.data;
  const clean =
    actual.worktree_state === "GIT_CLEAN" &&
    actual.porcelain_status.length === 0;
  if (!clean) {
    throw new ArkTeamError(
      "SOURCE_DRIFT",
      "verification source is not a clean implementation baseline",
    );
  }
  if (parsedExpected?.success === true) {
    const expected = parsedExpected.data;
    const identityKeys: Array<keyof VerificationSourceIdentity> = [
      "worktree_root",
      "source_label",
      "source_ref",
      "source_commit",
      "source_tree",
      "worktree_state",
      "porcelain_status",
      "capture_method",
    ];
    if (
      identityKeys.some(
        (key) => canonicalJson(actual[key]) !== canonicalJson(expected[key]),
      )
    ) {
      throw new ArkTeamError(
        "SOURCE_DRIFT",
        "verification source does not match the captured implementation baseline",
      );
    }
  }
}

export async function captureVerificationSource(
  projectPath: string,
  now: () => Date = () => new Date(),
): Promise<VerificationSourceIdentity> {
  let selectedRoot: string;
  try {
    selectedRoot = await realpath(projectPath);
  } catch (error) {
    throw new ArkTeamError("SOURCE_DRIFT", "verification source root is unavailable", {
      cause: error,
    });
  }
  try {
    const worktreeResult = await git(selectedRoot, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const worktreeRoot = await realpath(worktreeResult.stdout.trim());
    const [commitResult, treeResult, refResult, statusResult] = await Promise.all([
      git(worktreeRoot, ["rev-parse", "--verify", "HEAD"]),
      git(worktreeRoot, ["rev-parse", "--verify", "HEAD^{tree}"]),
      gitOptional(worktreeRoot, ["symbolic-ref", "--quiet", "HEAD"]),
      git(worktreeRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ]);
    const sourceCommit = commitResult.stdout.trim();
    const sourceTree = treeResult.stdout.trim();
    const sourceRef = refResult?.stdout.trim() || null;
    const sourceLabel =
      sourceRef === null
        ? `detached@${sourceCommit}`
        : sourceRef;
    const statusEntries = statusResult.stdout
      .split("\0")
      .filter((entry) => entry.length > 0);
    return verificationSourceIdentitySchema.parse({
      worktree_root: worktreeRoot,
      source_label: sourceLabel,
      source_ref: sourceRef,
      source_commit: sourceCommit,
      source_tree: sourceTree,
      worktree_state: statusEntries.length === 0 ? "GIT_CLEAN" : "GIT_DIRTY",
      porcelain_status: statusEntries,
      capture_method: "git-literal-argv-v1",
      captured_at_utc: now().toISOString(),
    });
  } catch (error) {
    if (error instanceof ArkTeamError) {
      throw error;
    }
    throw new ArkTeamError(
      "SOURCE_DRIFT",
      "unable to capture the verification Git source identity",
      { cause: error },
    );
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePointStrings(left, right))
        .map(([key, nested]) => {
          if (nested === undefined) {
            throw new ArkTeamError(
              "INVALID_RECORD",
              "canonical JSON does not permit undefined values",
            );
          }
          return [key, canonicalize(nested)];
        }),
    );
  }
  throw new ArkTeamError(
    "INVALID_RECORD",
    "value cannot be represented as canonical JSON",
  );
}

function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

async function git(
  workingDirectory: string,
  argv: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["-C", workingDirectory, ...argv], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

async function gitOptional(
  workingDirectory: string,
  argv: string[],
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    return await git(workingDirectory, argv);
  } catch {
    return null;
  }
}
