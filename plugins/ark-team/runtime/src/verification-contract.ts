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
export const VERIFICATION_SECRET_TEXT_PATTERN =
  /\b(?:authorization|bearer|cookie|password|secret|token|api[_-]?key)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{48,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const FORBIDDEN_LOCAL_SERVER_TOKENS = new Set([
  "ansible",
  "docker",
  "docker-compose",
  "helm",
  "kubectl",
  "podman",
  "scp",
  "ssh",
  "terraform",
  "tofu",
]);

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

const legacyCapabilitySchema = z.enum([
  "server",
  "api",
  "browser",
  "screenshot",
  "semantic_review",
  "comparison",
]);

const legacyRequiredCapabilitiesSchema = z
  .array(legacyCapabilitySchema)
  .min(1)
  .max(6)
  .superRefine((values, context) =>
    addDuplicateIssues(values, context, ["required_capabilities"]),
  );

const capabilitySchema = z.enum([
  "agentic_browser",
  "api",
  "browser",
  "comparison",
  "screenshot",
  "semantic_review",
  "server",
]);

export type VerificationCapability = z.infer<typeof capabilitySchema>;

const capabilityListSchema = z
  .array(capabilitySchema)
  .max(7)
  .superRefine((values, context) => {
    addDuplicateIssues(values, context, []);
    if ([...values].sort().join("\0") !== values.join("\0")) {
      context.addIssue({
        code: "custom",
        message: "capabilities must be lexically sorted",
      });
    }
  });

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

const legacyVerificationBrowserCaseSchema = z
  .object({
    id: identifierSchema,
    path: z.string().min(1).max(2_048).refine(isLocalPath, "invalid local browser path"),
    readiness: boundedStringSchema,
    actions: z.array(verificationBrowserActionSchema).max(50),
    required: z.boolean(),
  })
  .strict();

const visibleAssertionSchema = z
  .object({
    kind: z.literal("visible"),
    role: boundedStringSchema.max(128),
    name: boundedStringSchema.max(1_000),
  })
  .strict();
const textAssertionSchema = z
  .object({
    kind: z.literal("text"),
    selector: boundedStringSchema,
    value: boundedStringSchema.max(10_000),
  })
  .strict();
const urlAssertionSchema = z
  .object({
    kind: z.literal("url"),
    value: z.string().min(1).max(2_048).refine(isLocalPath, "invalid local URL assertion"),
  })
  .strict();
const valueAssertionSchema = z
  .object({
    kind: z.literal("value"),
    selector: boundedStringSchema,
    value: boundedStringSchema.max(10_000),
  })
  .strict();
const accessibilityAssertionSchema = z
  .object({
    kind: z.literal("accessibility_snapshot"),
    sha256: sha256Schema,
  })
  .strict();
const responseAssertionSchema = z
  .object({
    kind: z.literal("response"),
    path: z.string().min(1).max(2_048).refine(isLocalPath, "invalid local response path"),
    expected_status: z.number().int().min(100).max(599),
  })
  .strict();

export const verificationBrowserAssertionSchema = z.discriminatedUnion("kind", [
  visibleAssertionSchema,
  textAssertionSchema,
  urlAssertionSchema,
  valueAssertionSchema,
  accessibilityAssertionSchema,
  responseAssertionSchema,
]);

export const verificationBrowserCaseSchema = z
  .object({
    id: identifierSchema,
    path: z.string().min(1).max(2_048).refine(isLocalPath, "invalid local browser path"),
    readiness: boundedStringSchema,
    actions: z.array(verificationBrowserActionSchema).max(50),
    assertions: z.array(verificationBrowserAssertionSchema).min(1).max(50),
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

const legacyVerificationAttemptsSchema = z
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

const verificationAttemptsSchema = z
  .object({
    readiness: z.literal(2),
    api: z.literal(2),
    browser: z.literal(2),
    agentic_browser: z.literal(1),
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

export const legacyVerificationCoordinatorConfigSchema = z
  .object({
    schema_version: z.literal(1),
    enabled: z.boolean(),
    required_capabilities: legacyRequiredCapabilitiesSchema,
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
    browser_cases: z.array(legacyVerificationBrowserCaseSchema).min(1).max(50),
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
    attempts: legacyVerificationAttemptsSchema,
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

const exactVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value.trim() === value &&
      !SECRET_PATTERN.test(value) &&
      !/(?:^|[._-])latest(?:$|[._-])/i.test(value) &&
      !/[<>=*^~|]/.test(value),
    "version must be exact",
  );

const BASELINE_VIEWPORT_DIMENSIONS = Object.freeze({
  "375x812": Object.freeze({ width: 375, height: 812 }),
  "768x1024": Object.freeze({ width: 768, height: 1_024 }),
  "1440x900": Object.freeze({ width: 1_440, height: 900 }),
});
const BASELINE_VIEWPORT_ORDER = new Map(
  ["375x812", "768x1024", "1440x900"].map((viewport, index) => [
    viewport,
    index,
  ]),
);

export const verificationApprovedBaselineEntrySchema = z
  .object({
    case_id: identifierSchema,
    viewport: z.enum(["375x812", "768x1024", "1440x900"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    path: z
      .string()
      .regex(/^objects\/sha256\/[a-f0-9]{64}\.png$/),
    sha256: sha256Schema,
  })
  .strict()
  .superRefine((entry, context) => {
    const expectedDimensions = BASELINE_VIEWPORT_DIMENSIONS[entry.viewport];
    if (
      entry.width !== expectedDimensions.width ||
      entry.height !== expectedDimensions.height
    ) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: "baseline image dimensions do not match the viewport",
      });
    }
    if (entry.path !== `objects/sha256/${entry.sha256}.png`) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "baseline object path does not match its PNG hash",
      });
    }
  });

export type VerificationApprovedBaselineEntry = z.infer<
  typeof verificationApprovedBaselineEntrySchema
>;

export const verificationApprovedBaselineManifestSchema = z
  .object({
    schema_version: z.literal(1),
    baseline_id: identifierSchema,
    approval_id: identifierSchema,
    approver: boundedStringSchema,
    approved_at_utc: z.string().datetime({ offset: true }),
    source_commit: shaSchema,
    source_tree: shaSchema,
    environment: browserEnvironmentSchema,
    adapter: z
      .object({
        name: identifierSchema,
        version: exactVersionSchema,
      })
      .strict(),
    browser_build: exactVersionSchema,
    entries: z
      .array(verificationApprovedBaselineEntrySchema)
      .min(1)
      .max(150),
  })
  .strict()
  .superRefine((manifest, context) => {
    addDuplicateIssues(
      manifest.entries.map((entry) => `${entry.case_id}\0${entry.viewport}`),
      context,
      ["entries"],
    );
    for (let index = 1; index < manifest.entries.length; index += 1) {
      const previous = manifest.entries[index - 1]!;
      const current = manifest.entries[index]!;
      const caseOrder = Buffer.compare(
        Buffer.from(previous.case_id, "utf8"),
        Buffer.from(current.case_id, "utf8"),
      );
      const viewportOrder =
        (BASELINE_VIEWPORT_ORDER.get(previous.viewport) ?? -1) -
        (BASELINE_VIEWPORT_ORDER.get(current.viewport) ?? -1);
      if (caseOrder > 0 || (caseOrder === 0 && viewportOrder >= 0)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index],
          message:
            "baseline entries must be sorted bytewise by case and then by viewport order",
        });
        break;
      }
    }
  });

export type VerificationApprovedBaselineManifest = z.infer<
  typeof verificationApprovedBaselineManifestSchema
>;

export function verificationBaselineSetSha256(
  input: VerificationApprovedBaselineManifest,
): string {
  const manifest = verificationApprovedBaselineManifestSchema.parse(input);
  return sha256CanonicalJson({
    source_commit: manifest.source_commit,
    source_tree: manifest.source_tree,
    environment: manifest.environment,
    adapter: manifest.adapter,
    browser_build: manifest.browser_build,
    entries: manifest.entries,
  });
}

const modelIdentitySchema = exactVersionSchema.refine(
  (value) => !/^(?:auto|default|fallback)$/i.test(value),
  "model identity must be explicit",
);

const promptTemplateSchema = z
  .string()
  .min(1)
  .max(16 * 1_024)
  .refine((value) => value.trim().length > 0, "prompt template is blank")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 16 * 1_024,
    "prompt template exceeds 16 KiB",
  )
  .refine(
    (value) => !SECRET_PATTERN.test(value),
    "secret-bearing prompt template is forbidden",
  );

const checklistSchema = z
  .array(boundedStringSchema)
  .min(1)
  .max(50)
  .superRefine((items, context) => {
    if (Buffer.byteLength(canonicalJson(items), "utf8") > 16 * 1_024) {
      context.addIssue({
        code: "custom",
        message: "checklist exceeds 16 KiB",
      });
    }
  });

const verificationAgenticTaskSchema = z
  .object({
    id: identifierSchema,
    required: z.literal(false),
    adapter: z.enum(["browser-use", "playwright-agent", "stagehand"]),
    adapter_version: exactVersionSchema,
    api_major: exactVersionSchema,
    model_identity: modelIdentitySchema,
    browser_build: exactVersionSchema,
    start_path: z.string().min(1).max(2_048).refine(isLocalPath),
    goal: z
      .string()
      .min(1)
      .max(4 * 1_024)
      .refine((value) => value.trim().length > 0, "goal is blank")
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 4 * 1_024,
        "goal exceeds 4 KiB",
      )
      .refine(
        (value) => !SECRET_PATTERN.test(value),
        "secret-bearing goal is forbidden",
      ),
    success_criteria: z.array(verificationBrowserAssertionSchema).min(1).max(50),
    allowed_actions: z
      .array(z.enum(["click", "navigate", "screenshot", "snapshot", "type"]))
      .min(1)
      .max(5),
    max_steps: z.literal(20),
    timeout_ms: z.literal(120_000),
    system_prompt_template: promptTemplateSchema,
    checklist: checklistSchema,
    prompt_sha256: sha256Schema,
    checklist_sha256: sha256Schema,
  })
  .strict()
  .superRefine((task, context) => {
    addDuplicateIssues(task.allowed_actions, context, ["allowed_actions"]);
    if (
      task.prompt_sha256 !==
      createHash("sha256").update(task.system_prompt_template, "utf8").digest("hex")
    ) {
      context.addIssue({
        code: "custom",
        path: ["prompt_sha256"],
        message: "prompt hash does not match the template bytes",
      });
    }
    if (task.checklist_sha256 !== sha256CanonicalJson(task.checklist)) {
      context.addIssue({
        code: "custom",
        path: ["checklist_sha256"],
        message: "checklist hash does not match canonical checklist bytes",
      });
    }
  });

const disabledLaneSchema = z.object({ enabled: z.literal(false) }).strict();

const enabledBackendLaneSchema = z
  .object({
    enabled: z.literal(true),
    required: z.boolean(),
    required_capabilities: z.tuple([z.literal("api"), z.literal("server")]),
    api_adapter: z.literal("curl"),
    api_adapter_version: exactVersionSchema,
    api_probes: z.array(verificationApiProbeSchema).min(1).max(50),
  })
  .strict()
  .superRefine((lane, context) => {
    addDuplicateIssues(
      lane.api_probes.map((probe) => probe.id),
      context,
      ["api_probes"],
    );
    if (lane.required && !lane.api_probes.some((probe) => probe.required)) {
      context.addIssue({
        code: "custom",
        path: ["api_probes"],
        message: "a required backend lane needs a required probe",
      });
    }
  });

const verificationBackendLaneSchema = z.discriminatedUnion("enabled", [
  disabledLaneSchema,
  enabledBackendLaneSchema,
]);

const enabledUiLaneSchema = z
  .object({
    enabled: z.literal(true),
    required: z.boolean(),
    required_capabilities: capabilityListSchema,
    optional_capabilities: capabilityListSchema,
    deterministic_adapter: z.literal("playwright-cli"),
    deterministic_adapter_version: exactVersionSchema,
    browser_build: exactVersionSchema,
    browser_cases: z.array(verificationBrowserCaseSchema).min(1).max(50),
    viewports: requiredViewportsSchema,
    baseline_root: z
      .string()
      .min(1)
      .max(1_000)
      .refine(
        isCanonicalRelativePath,
        "baseline_root must be canonical and project-relative",
      ),
    baseline_identity: verificationBaselineIdentitySchema,
    pixel_diff_fraction_max: z.literal(0.005),
    max_channel_delta: z.literal(8),
    critical_regions: z.array(criticalRegionSchema).max(100),
    semantic_review_required: z.boolean(),
    agentic_tasks: z.array(verificationAgenticTaskSchema).max(50),
  })
  .strict()
  .superRefine((lane, context) => {
    addDuplicateIssues(
      lane.browser_cases.map((browserCase) => browserCase.id),
      context,
      ["browser_cases"],
    );
    addDuplicateIssues(
      lane.agentic_tasks.map((task) => task.id),
      context,
      ["agentic_tasks"],
    );
    addDuplicateIssues(
      lane.critical_regions.map((region) => region.id),
      context,
      ["critical_regions"],
    );
    if (lane.required && !lane.browser_cases.some((browserCase) => browserCase.required)) {
      context.addIssue({
        code: "custom",
        path: ["browser_cases"],
        message: "a required UI lane needs a required browser case",
      });
    }
    const expectedRequired = [
      "browser",
      "comparison",
      "screenshot",
      ...(lane.semantic_review_required ? ["semantic_review"] : []),
      "server",
    ];
    const expectedOptional = [
      ...(lane.agentic_tasks.length > 0 ? ["agentic_browser"] : []),
      ...(!lane.semantic_review_required ? ["semantic_review"] : []),
    ];
    if (canonicalJson(lane.required_capabilities) !== canonicalJson(expectedRequired)) {
      context.addIssue({
        code: "custom",
        path: ["required_capabilities"],
        message: "required UI capabilities do not match enabled checks",
      });
    }
    if (canonicalJson(lane.optional_capabilities) !== canonicalJson(expectedOptional)) {
      context.addIssue({
        code: "custom",
        path: ["optional_capabilities"],
        message: "optional UI capabilities do not match enabled checks",
      });
    }
    if (
      lane.required_capabilities.some((capability) =>
        lane.optional_capabilities.includes(capability),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["optional_capabilities"],
        message: "required and optional capabilities must be disjoint",
      });
    }
  });

const verificationUiLaneSchema = z.discriminatedUnion("enabled", [
  disabledLaneSchema,
  enabledUiLaneSchema,
]);

const disabledVerificationCoordinatorConfigSchema = z
  .object({
    schema_version: z.literal(2),
    contract_id: z.literal("verification_contract_v2"),
    enabled: z.literal(false),
  })
  .strict();

export const verificationCoordinatorConfigV2Schema = z
  .object({
    schema_version: z.literal(2),
    contract_id: z.literal("verification_contract_v2"),
    enabled: z.literal(true),
    server_argv: z.array(boundedStringSchema).min(1).max(32),
    server_bind: z.literal("0.0.0.0"),
    server_host: z.literal("devbox"),
    server_port_floor: z.literal(10_001),
    server_readiness_path: z
      .string()
      .min(1)
      .max(2_048)
      .refine(isLocalPath, "invalid readiness path"),
    server_readiness_status: z.number().int().min(100).max(599),
    server_readiness_timeout_ms: z.literal(30_000),
    evidence_limits: verificationEvidenceLimitsSchema,
    console_bytes: z.literal(32 * 1_024),
    network_bytes: z.literal(32 * 1_024),
    retention_days: z.literal(30),
    retention_anchor: z.literal("terminal-report-created-at"),
    server_timeout_ms: z.literal(30_000),
    api_timeout_ms: z.literal(30_000),
    browser_timeout_ms: z.literal(60_000),
    case_timeout_ms: z.literal(120_000),
    attempts: verificationAttemptsSchema,
    approval_policy: z.literal("explicit-one-time-user-decision"),
    backend: verificationBackendLaneSchema,
    ui: verificationUiLaneSchema,
  })
  .strict()
  .superRefine((config, context) => {
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
      const normalized = argument.trim().toLowerCase();
      if (SECRET_ARGUMENT_PATTERN.test(argument)) {
        context.addIssue({
          code: "custom",
          path: ["server_argv", index],
          message: "server_argv must not contain credential arguments",
        });
      }
      if (
        FORBIDDEN_LOCAL_SERVER_TOKENS.has(path.basename(normalized)) ||
        FORBIDDEN_LOCAL_SERVER_TOKENS.has(normalized)
      ) {
        context.addIssue({
          code: "custom",
          path: ["server_argv", index],
          message:
            "server_argv must not invoke Docker, remote, or infrastructure tools",
        });
      }
      if (
        normalized === "3000" ||
        /^--?port(?:=|:)3000$/.test(normalized)
      ) {
        context.addIssue({
          code: "custom",
          path: ["server_argv", index],
          message: "server_argv must not select port 3000",
        });
      }
      if (/^(?:https?|wss?):\/\//.test(normalized)) {
        context.addIssue({
          code: "custom",
          path: ["server_argv", index],
          message: "server_argv must not target a remote service",
        });
      }
    });
    const requiredLaneCount =
      Number(config.backend.enabled && config.backend.required) +
      Number(config.ui.enabled && config.ui.required);
    if (requiredLaneCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["backend"],
        message: "at least one enabled lane must be required",
      });
    }
  });

export const verificationCoordinatorConfigSchema = z.union([
  legacyVerificationCoordinatorConfigSchema,
  disabledVerificationCoordinatorConfigSchema,
  verificationCoordinatorConfigV2Schema,
]);

export type VerificationCoordinatorConfig = z.infer<
  typeof verificationCoordinatorConfigSchema
>;
export type VerificationCoordinatorConfigV2 = z.infer<
  typeof verificationCoordinatorConfigV2Schema
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

export type VerificationStage = z.infer<typeof verificationStageSchema>;

export const verificationOutcomeSchema = z.enum([
  "passed",
  "failed",
  "unavailable",
  "skipped",
  "error",
]);

export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;

export const verificationActionKindSchema = z.enum([
  "readiness",
  "api",
  "browser",
  "agentic_browser",
  "screenshot",
  "semantic_review",
  "comparison",
  "artifact_write",
  "cleanup",
]);

export type VerificationActionKind = z.infer<
  typeof verificationActionKindSchema
>;

const verificationActionMaxAttempts = {
  readiness: 2,
  api: 2,
  browser: 2,
  agentic_browser: 1,
  screenshot: 1,
  semantic_review: 1,
  comparison: 1,
  artifact_write: 1,
  cleanup: 1,
} as const satisfies Record<VerificationActionKind, 1 | 2>;

const verificationCoordinatorAttemptSchema = z
  .object({
    action_id: identifierSchema,
    kind: verificationActionKindSchema,
    lane: z.enum(["backend", "ui"]).nullable(),
    check_id: identifierSchema.nullable(),
    input_sha256: sha256Schema,
    attempt_count: z.number().int().min(1).max(2),
    max_attempts: z.number().int().min(1).max(2),
    evidence_record_ids: z.array(identifierSchema).max(500),
    decisive_evidence_record_ids: z.array(identifierSchema).max(500),
    status: z.enum([
      "in_progress",
      "failed",
      "succeeded",
      "exhausted",
      "aborted",
    ]),
    last_error_code: z.lazy(() => verificationErrorCodeSchema).nullable(),
  })
  .strict()
  .superRefine((attempt, context) => {
    addDuplicateIssues(attempt.evidence_record_ids, context, [
      "evidence_record_ids",
    ]);
    addDuplicateIssues(attempt.decisive_evidence_record_ids, context, [
      "decisive_evidence_record_ids",
    ]);
    if (
      attempt.decisive_evidence_record_ids.some(
        (recordId) => !attempt.evidence_record_ids.includes(recordId),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisive_evidence_record_ids"],
        message: "decisive evidence must belong to the complete attempt evidence",
      });
    }
    if (
      attempt.status === "in_progress" &&
      attempt.decisive_evidence_record_ids.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["decisive_evidence_record_ids"],
        message: "in-progress attempts cannot have decisive evidence",
      });
    }
    if (attempt.max_attempts !== verificationActionMaxAttempts[attempt.kind]) {
      context.addIssue({
        code: "custom",
        path: ["max_attempts"],
        message: "maximum attempts do not match the action kind",
      });
    }
    if (attempt.attempt_count > attempt.max_attempts) {
      context.addIssue({
        code: "custom",
        path: ["attempt_count"],
        message: "attempt count exceeds the action maximum",
      });
    }
    if (
      (attempt.status === "in_progress" ||
        attempt.status === "succeeded") !==
      (attempt.last_error_code === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["last_error_code"],
        message: "attempt status does not match its last error code",
      });
    }
    if (
      attempt.status === "exhausted" &&
      attempt.attempt_count !== attempt.max_attempts
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "exhausted attempts must consume the complete budget",
      });
    }
    if (
      attempt.status === "aborted" &&
      attempt.attempt_count >= attempt.max_attempts
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "aborted attempts must retain unused retry budget",
      });
    }
  });

export const verificationCoordinatorStateSchema = z
  .object({
    schema_version: z.literal(1),
    current_state: z.union([
      verificationStageSchema,
      verificationOutcomeSchema,
    ]),
    terminal_outcome: verificationOutcomeSchema.nullable(),
    attempts: z.array(verificationCoordinatorAttemptSchema).max(500),
  })
  .strict()
  .superRefine((state, context) => {
    addDuplicateIssues(
      state.attempts.map((attempt) => attempt.action_id),
      context,
      ["attempts"],
    );
    if (verificationOutcomeSchema.safeParse(state.current_state).success) {
      if (state.terminal_outcome !== state.current_state) {
        context.addIssue({
          code: "custom",
          path: ["terminal_outcome"],
          message: "terminal state and outcome must match",
        });
      }
      return;
    }
    if (
      state.current_state === "pm_review_pending" ||
      state.current_state === "original_pm_review"
    ) {
      if (state.terminal_outcome !== "passed") {
        context.addIssue({
          code: "custom",
          path: ["terminal_outcome"],
          message: "PM review states require a passed terminal outcome",
        });
      }
      return;
    }
    if (state.terminal_outcome !== null) {
      context.addIssue({
        code: "custom",
        path: ["terminal_outcome"],
        message: "preterminal states cannot have a terminal outcome",
      });
    }
  });

export type VerificationCoordinatorState = z.infer<
  typeof verificationCoordinatorStateSchema
>;

const verificationLaneCheckDecisionSchema = z
  .object({
    check_id: identifierSchema,
    required: z.boolean(),
    outcome: verificationOutcomeSchema,
    evidence_record_ids: z.array(identifierSchema).min(1).max(500),
    integrity_failure: z.boolean(),
  })
  .strict()
  .superRefine((check, context) => {
    addDuplicateIssues(check.evidence_record_ids, context, [
      "evidence_record_ids",
    ]);
  });

const verificationLaneCheckDecisionsSchema = z
  .array(verificationLaneCheckDecisionSchema)
  .min(1)
  .max(500)
  .superRefine((checks, context) => {
    addDuplicateIssues(
      checks.map((check) => check.check_id),
      context,
      [],
    );
  });

export const verificationLaneDecisionInputSchema = z
  .object({
    lane: z.enum(["backend", "ui"]),
    checks: verificationLaneCheckDecisionsSchema,
  })
  .strict();

export type VerificationLaneDecisionInput = z.infer<
  typeof verificationLaneDecisionInputSchema
>;

const legacyVerificationRecordTypeSchema = z.enum([
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

const legacyVerificationErrorCodeSchema = z.enum([
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

const legacyVerificationRecordPayloadSchema = z.discriminatedUnion("kind", [
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
      capability: legacyCapabilitySchema,
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
      code: legacyVerificationErrorCodeSchema,
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

export const legacyVerificationLinkedRecordSchema = z
  .object({
    schema_version: z.literal(1),
    record_id: identifierSchema,
    record_type: legacyVerificationRecordTypeSchema,
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
    payload: legacyVerificationRecordPayloadSchema,
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

const verificationRecordTypeSchema = z.enum([
  "source",
  "config",
  "snapshot",
  "capability",
  "request",
  "browser",
  "agentic_browser",
  "screenshot",
  "review",
  "comparison",
  "artifact",
  "cleanup",
  "lane_summary",
  "error",
  "report",
  "rollback",
  "spec_delta",
]);

export const VERIFICATION_PM_HANDOFF_TRACEABILITY = Object.freeze(
  [
    ["OBJ-1701", "REQ-1701", "IS-1701"],
    ["OBJ-1701", "REQ-1702", "IS-1701"],
    ["OBJ-1702", "REQ-1703", "IS-1703"],
    ["OBJ-1702", "REQ-1704", "IS-1701"],
    ["OBJ-1703", "REQ-1705", "IS-1701"],
    ["OBJ-1703", "REQ-1706", "IS-1702"],
    ["OBJ-1704", "REQ-1707", "IS-1703"],
    ["OBJ-1704", "REQ-1708", "IS-1703"],
    ["OBJ-1705", "REQ-1709", "IS-1705"],
    ["OBJ-1705", "REQ-1710", "IS-1705"],
    ["OBJ-1706", "REQ-1711", "IS-1706"],
    ["OBJ-1706", "REQ-1712", "IS-1706"],
    ["OBJ-1706", "REQ-1713", "IS-1706"],
    ["OBJ-1707", "REQ-1714", "IS-1704"],
    ["OBJ-1707", "REQ-1715", "IS-1704"],
    ["OBJ-1707", "REQ-1716", "IS-1704"],
    ["OBJ-1708", "REQ-1717", "IS-1707"],
    ["OBJ-1708", "REQ-1718", "IS-1707"],
    ["OBJ-1709", "REQ-1719", "IS-1707"],
    ["OBJ-1709", "REQ-1720", "IS-1707"],
    ["OBJ-1709", "REQ-1721", "IS-1707"],
    ["OBJ-1710", "REQ-1722", "IS-1703"],
    ["OBJ-1710", "REQ-1723", "IS-1706"],
  ].map(([objectiveId, requirementId, implementationSliceId]) => {
    const sequence = requirementId!.slice(4);
    return Object.freeze({
      objective_id: objectiveId!,
      requirement_id: requirementId!,
      acceptance_id: `AC-${sequence}`,
      test_id: `TEST-${sequence}`,
      implementation_slice_id: implementationSliceId!,
    });
  }),
);

const verificationPmHandoffTraceabilitySchema = z
  .array(
    z
      .object({
        objective_id: z.string().regex(/^OBJ-[0-9]{4}$/),
        requirement_id: z.string().regex(/^REQ-[0-9]{4}$/),
        acceptance_id: z.string().regex(/^AC-[0-9]{4}$/),
        test_id: z.string().regex(/^TEST-[0-9]{4}$/),
        implementation_slice_id: z.string().regex(/^IS-[0-9]{4}$/),
      })
      .strict(),
  )
  .length(VERIFICATION_PM_HANDOFF_TRACEABILITY.length);

const verificationSpecDeltaAffectedIdsSchema = z
  .array(identifierSchema)
  .min(5)
  .max(50)
  .superRefine((affectedIds, context) => {
    addDuplicateIssues(affectedIds, context, []);
    const prefixes = ["OBJ", "REQ", "AC", "TEST", "IS"] as const;
    if (
      affectedIds.some(
        (affectedId) =>
          !/^(?:OBJ|REQ|AC|TEST|IS)-[0-9]{4}$/.test(affectedId),
      ) ||
      prefixes.some(
        (prefix) =>
          !affectedIds.some((affectedId) =>
            affectedId.startsWith(`${prefix}-`),
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "affected_ids must contain exact OBJ, REQ, AC, TEST, and IS identifiers",
      });
    }
  });

const verificationSpecDeltaTextSchema = boundedStringSchema.refine(
  (value) =>
    !VERIFICATION_SECRET_TEXT_PATTERN.test(value) &&
    !/(?:chain[_ -]?of[_ -]?thought|private reasoning|model thoughts?|transcript)/i.test(
      value,
    ),
  "secret or private reasoning content is forbidden",
);

export const verificationSpecDeltaRecordSchema = z
  .object({
    status: z.literal("SPEC_DELTA_REQUIRED"),
    runtime_status: z.literal("not_started"),
    affected_ids: verificationSpecDeltaAffectedIdsSchema,
    classification: z.enum([
      "omission",
      "contradiction",
      "unsafe_input",
      "environment_mismatch",
      "unverifiable",
    ]),
    source_snapshot: z
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
        commit: shaSchema,
        tree: shaSchema,
        package_fingerprint: sha256Schema,
      })
      .strict(),
    evidence: z
      .array(
        z
          .object({
            kind: identifierSchema.refine(
              (value) =>
                !VERIFICATION_SECRET_TEXT_PATTERN.test(value) &&
                !/(?:chain[_-]?of[_-]?thought|reasoning|thought|transcript)/i.test(
                  value,
                ),
              "secret or private reasoning evidence is forbidden",
            ),
            value: verificationSpecDeltaTextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    impact: verificationSpecDeltaTextSchema,
    proposed_resolution: verificationSpecDeltaTextSchema,
    blocking_stage: z.string().regex(/^IS-[0-9]{4}$/),
    created_at_utc: z
      .string()
      .datetime({ offset: true })
      .refine((value) => value.endsWith("Z"), "created_at_utc must be UTC"),
  })
  .strict()
  .superRefine((record, context) => {
    if (!record.affected_ids.includes(record.blocking_stage)) {
      context.addIssue({
        code: "custom",
        path: ["blocking_stage"],
        message: "blocking_stage must be present in affected_ids",
      });
    }
  });

export const verificationSpecDeltaPayloadSchema =
  verificationSpecDeltaRecordSchema.extend({
    kind: z.literal("spec_delta"),
  });

export type VerificationSpecDeltaRecord = z.infer<
  typeof verificationSpecDeltaRecordSchema
>;

export type VerificationSpecDeltaPayload = z.infer<
  typeof verificationSpecDeltaPayloadSchema
>;

export const verificationErrorCodeSchema = z.enum([
  "SOURCE_DRIFT",
  "PACKAGE_FINGERPRINT_MISMATCH",
  "CONTRACT_VERSION_MISMATCH",
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

export type VerificationErrorCode = z.infer<
  typeof verificationErrorCodeSchema
>;

export function verificationErrorDisposition(
  code: VerificationErrorCode,
): {
  outcome: VerificationOutcome;
  integrity_failure: boolean;
} {
  if (
    [
      "SOURCE_DRIFT",
      "PACKAGE_FINGERPRINT_MISMATCH",
      "CONTRACT_VERSION_MISMATCH",
      "SCENARIO_SNAPSHOT_MISMATCH",
      "ARTIFACT_ROOT_INVALID",
      "BASELINE_NOT_APPROVED",
    ].includes(code)
  ) {
    return { outcome: "error", integrity_failure: true };
  }
  if (
    [
      "API_CONTRACT_MISMATCH",
      "BROWSER_CONTRACT_MISMATCH",
      "SCREENSHOT_CAPTURE_FAILED",
      "IMAGE_REVIEW_REJECTED",
      "COMPARISON_THRESHOLD_FAILED",
    ].includes(code)
  ) {
    return { outcome: "failed", integrity_failure: false };
  }
  if (
    [
      "CAPABILITY_UNAVAILABLE",
      "SERVER_NOT_READY",
      "ENVIRONMENT_UNAVAILABLE",
    ].includes(code)
  ) {
    return { outcome: "unavailable", integrity_failure: false };
  }
  if (code === "APPROVAL_REQUIRED") {
    return { outcome: "skipped", integrity_failure: false };
  }
  return { outcome: "error", integrity_failure: false };
}

export const verificationCleanupAuditSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().regex(RUN_ID_PATTERN),
    snapshot_id: identifierSchema,
    artifact_root: z
      .string()
      .min(1)
      .refine(
        (value) =>
          path.isAbsolute(value) &&
          path.normalize(value) === value &&
          path.resolve(value) === value,
        "artifact_root must be absolute and canonical",
      ),
    terminal_report_record_id: identifierSchema,
    terminal_report_at: z.string().datetime({ offset: true }),
    terminal_outcome: verificationOutcomeSchema,
    terminal_report_sha256: sha256Schema,
    artifact_record_ids: z.array(identifierSchema).max(500),
    artifact_manifest_sha256: sha256Schema,
    artifact_count: z.number().int().nonnegative().max(500),
    total_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(500 * 1_024 * 1_024),
    baseline_manifest_sha256: sha256Schema.nullable(),
    requested_at_utc: z.string().datetime({ offset: true }),
    destructive_attempt: z.literal(1),
    status: z.enum(["pending", "cleaned", "cleanup_error"]),
    completed_at_utc: z.string().datetime({ offset: true }).nullable(),
    error_code: z.literal("ARTIFACT_ROOT_INVALID").nullable(),
    error_message: boundedStringSchema.nullable(),
  })
  .strict()
  .superRefine((audit, context) => {
    addDuplicateIssues(audit.artifact_record_ids, context, [
      "artifact_record_ids",
    ]);
    if (audit.artifact_count !== audit.artifact_record_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["artifact_count"],
        message: "artifact count does not match artifact record IDs",
      });
    }
    const isPending = audit.status === "pending";
    const isError = audit.status === "cleanup_error";
    if (isPending !== (audit.completed_at_utc === null)) {
      context.addIssue({
        code: "custom",
        path: ["completed_at_utc"],
        message: "cleanup completion time does not match audit status",
      });
    }
    if (
      (isError &&
        (audit.error_code === null || audit.error_message === null)) ||
      (!isError &&
        (audit.error_code !== null || audit.error_message !== null))
    ) {
      context.addIssue({
        code: "custom",
        path: ["error_code"],
        message: "cleanup error provenance does not match audit status",
      });
    }
  });

export type VerificationCleanupAudit = z.infer<
  typeof verificationCleanupAuditSchema
>;

const closedAgenticVerdictSchema = z.enum([
  "achieved",
  "not_achieved",
  "unknown",
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
      version: exactVersionSchema.nullable(),
      diagnostic: boundedStringSchema.optional(),
    })
    .strict()
    .superRefine((capability, context) => {
      if (capability.available && capability.version === null) {
        context.addIssue({
          code: "custom",
          path: ["version"],
          message: "available capability requires an exact version",
        });
      }
      if (
        capability.diagnostic !== undefined &&
        !capability.available &&
        capability.version !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["version"],
          message: "new unavailable capability evidence cannot claim a version",
        });
      }
    }),
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
      assertion_count: z.number().int().positive().max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agentic_browser"),
      execution_status: z.enum(["completed", "blocked", "error"]),
      finding_status: z.enum(["finding", "no_finding", "unknown"]),
      self_verdict: closedAgenticVerdictSchema.optional(),
      judge_verdict: closedAgenticVerdictSchema.optional(),
      findings: z.array(boundedStringSchema).max(50),
      input_sha256: sha256Schema,
      ledger_sha256: sha256Schema,
      step_count: z.number().int().nonnegative().max(20),
    })
    .strict()
    .superRefine((result, context) => {
      if (Buffer.byteLength(canonicalJson(result.findings), "utf8") > 16 * 1_024) {
        context.addIssue({
          code: "custom",
          path: ["findings"],
          message: "agentic findings exceed 16 KiB",
        });
      }
    }),
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
        "application/zip",
        "text/plain",
      ]),
      byte_length: z.number().int().positive().max(50 * 1_024 * 1_024),
      sha256: sha256Schema,
      image_metadata: z
        .object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict()
        .nullable()
        .optional(),
    })
    .strict()
    .superRefine((artifact, context) => {
      if (
        artifact.media_type === "application/zip" &&
        !artifact.relative_path.endsWith(".playwright-trace.zip")
      ) {
        context.addIssue({
          code: "custom",
          path: ["relative_path"],
          message: "only Playwright trace ZIP artifacts are allowed",
        });
      }
    }),
  z
    .object({
      kind: z.literal("cleanup"),
      disposition: z.enum([
        "retention_active",
        "cleaned",
        "cleanup_error",
      ]),
      code: verificationErrorCodeSchema.nullable(),
      message: boundedStringSchema.nullable(),
    })
    .strict()
    .superRefine((cleanup, context) => {
      const isError = cleanup.disposition === "cleanup_error";
      if (isError !== (cleanup.code !== null && cleanup.message !== null)) {
        context.addIssue({
          code: "custom",
          message: "cleanup error provenance does not match its disposition",
        });
      }
    }),
  z
    .object({
      kind: z.literal("lane_summary"),
      lane: z.enum(["backend", "ui"]),
      outcome: verificationOutcomeSchema,
      evidence_record_ids: z.array(identifierSchema).min(1).max(500),
      checks: verificationLaneCheckDecisionsSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("error"),
      code: verificationErrorCodeSchema,
      message: boundedStringSchema,
      action_id: identifierSchema.optional(),
      attempt_count: z.number().int().min(1).max(2).optional(),
      evidence_record_ids: z.array(identifierSchema).max(500).optional(),
      outcome: verificationOutcomeSchema.optional(),
      integrity_failure: z.boolean().optional(),
      approval_id: z.string().uuid().optional(),
      request_sha256: sha256Schema.optional(),
      capability: capabilitySchema.optional(),
      capability_required: z.boolean().optional(),
    })
    .strict()
    .superRefine((error, context) => {
      if (
        error.approval_id !== undefined &&
        (error.code !== "APPROVAL_REQUIRED" ||
          error.outcome !== "error" ||
          error.integrity_failure !== false ||
          error.request_sha256 === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["approval_id"],
          message:
            "approval IDs require an APPROVAL_REQUIRED security error disposition",
        });
      }
      if (
        (error.capability !== undefined ||
          error.capability_required !== undefined) &&
        (!["CAPABILITY_UNAVAILABLE", "SERVER_NOT_READY"].includes(
          error.code,
        ) ||
          error.capability === undefined ||
          error.capability_required === undefined ||
          (error.code === "SERVER_NOT_READY" &&
            error.capability !== "server"))
      ) {
        context.addIssue({
          code: "custom",
          path: ["capability"],
          message:
            "capability markers require a complete local capability failure scope",
        });
      }
    }),
  z
    .object({
      kind: z.literal("report"),
      outcome: verificationOutcomeSchema,
      evidence_record_ids: z.array(identifierSchema).max(500),
      traceability: verificationPmHandoffTraceabilitySchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rollback"),
      contract_id: z.literal("verification_contract_v2"),
      new_starts_enabled: z.literal(false),
      preserves_existing_records: z.literal(true),
      reason: boundedStringSchema,
    })
    .strict(),
  verificationSpecDeltaPayloadSchema,
]);

const verificationArtifactReferenceSchema = z
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
  .strict();

export const verificationLinkedRecordV2Schema = z
  .object({
    schema_version: z.literal(2),
    contract_id: z.literal("verification_contract_v2"),
    record_id: identifierSchema,
    record_type: verificationRecordTypeSchema,
    run_id: z.string().regex(RUN_ID_PATTERN),
    case_id: identifierSchema,
    check_id: identifierSchema.nullable(),
    snapshot_id: identifierSchema,
    lane: z.enum(["backend", "ui"]).nullable(),
    stage: verificationStageSchema,
    timestamp_utc: z.string().datetime({ offset: true }),
    source_fingerprint: sha256Schema,
    package_fingerprint: sha256Schema,
    lane_required: z.boolean().nullable(),
    check_required: z.boolean(),
    previous_record_sha256: sha256Schema.nullable(),
    payload_sha256: sha256Schema,
    payload: verificationRecordPayloadSchema,
    adapter: z
      .object({
        name: identifierSchema,
        version: exactVersionSchema,
      })
      .strict()
      .nullable(),
    model: z
      .object({
        identity: modelIdentitySchema,
      })
      .strict()
      .nullable(),
    artifact_references: z.array(verificationArtifactReferenceSchema).max(500),
  })
  .strict()
  .superRefine((record, context) => {
    const requiresCheckScope = [
      "request",
      "browser",
      "agentic_browser",
      "screenshot",
      "review",
      "comparison",
    ].includes(record.record_type);
    if (
      (requiresCheckScope && record.check_id === null) ||
      (!requiresCheckScope &&
        record.record_type !== "error" &&
        record.check_id !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["check_id"],
        message:
          "check-scoped verification evidence requires exactly one check ID",
      });
    }
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
    if ((record.lane === null) !== (record.lane_required === null)) {
      context.addIssue({
        code: "custom",
        path: ["lane_required"],
        message: "lane requiredness must be present exactly when lane is present",
      });
    }
    if (
      [
        "capability",
        "request",
        "browser",
        "agentic_browser",
        "screenshot",
        "review",
        "comparison",
        "lane_summary",
      ].includes(record.record_type) &&
      record.lane === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["lane"],
        message: "this record type requires lane provenance",
      });
    }
    if (
      (record.record_type === "request" && record.lane !== "backend") ||
      ([
        "browser",
        "agentic_browser",
        "screenshot",
        "review",
        "comparison",
      ].includes(record.record_type) &&
        record.lane !== "ui")
    ) {
      context.addIssue({
        code: "custom",
        path: ["lane"],
        message: "record type does not match its QA lane",
      });
    }
    if (
      record.payload.kind === "lane_summary" &&
      record.payload.lane !== record.lane
    ) {
      context.addIssue({
        code: "custom",
        path: ["lane"],
        message: "lane summary payload does not match record lane",
      });
    }
    if (
      [
        "capability",
        "request",
        "browser",
        "agentic_browser",
        "screenshot",
        "review",
        "comparison",
      ].includes(record.record_type) &&
      record.adapter === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapter"],
        message: "adapter identity is required for this record type",
      });
    }
    if (
      record.record_type === "agentic_browser" &&
      (record.check_required ||
        record.model === null ||
        record.artifact_references.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["check_required"],
        message:
          "agentic browser evidence must remain advisory with model and artifact provenance",
      });
    }
    if (
      ["screenshot", "review", "comparison", "artifact", "cleanup"].includes(
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
    const usesV4PayloadContract =
      record.package_fingerprint !==
      LEGACY_APPROVED_VERIFICATION_PACKAGE_V3.package_fingerprint;
    if (
      usesV4PayloadContract &&
      record.payload.kind === "artifact"
    ) {
      const artifact = record.payload;
      if (artifact.image_metadata === undefined) {
        context.addIssue({
          code: "custom",
          path: ["payload", "image_metadata"],
          message: "schema-2 v4 artifact records require image metadata",
        });
        return;
      }
      const expectedMediaType = artifact.relative_path.endsWith(
        ".playwright-trace.zip",
      )
        ? "application/zip"
        : artifact.relative_path.endsWith(".png")
          ? "image/png"
          : artifact.relative_path.endsWith(".jsonl")
            ? "application/x-ndjson"
            : artifact.relative_path.endsWith(".json")
              ? "application/json"
              : artifact.relative_path.endsWith(".txt")
                ? "text/plain"
                : null;
      if (expectedMediaType === null) {
        context.addIssue({
          code: "custom",
          path: ["payload", "relative_path"],
          message: "artifact suffix is not supported",
        });
      } else if (artifact.media_type !== expectedMediaType) {
        context.addIssue({
          code: "custom",
          path: ["payload", "media_type"],
          message: "artifact media type does not match its exact suffix",
        });
      }
      if (
        (artifact.media_type === "image/png") !==
        (artifact.image_metadata !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "image_metadata"],
          message: "PNG artifacts require dimensions and other artifacts forbid them",
        });
      }
    }
  });

export const verificationLinkedRecordSchema = z.union([
  legacyVerificationLinkedRecordSchema,
  verificationLinkedRecordV2Schema,
]);

export type VerificationLinkedRecord = z.infer<
  typeof verificationLinkedRecordSchema
>;

export function verificationEvidenceDisposition(
  record: VerificationLinkedRecord,
): {
  outcome: VerificationOutcome;
  integrity_failure: boolean;
} | null {
  switch (record.payload.kind) {
    case "request":
      return {
        outcome:
          record.payload.actual_status === record.payload.expected_status
            ? "passed"
            : "failed",
        integrity_failure: false,
      };
    case "browser":
    case "screenshot":
    case "artifact":
      return { outcome: "passed", integrity_failure: false };
    case "agentic_browser":
      return {
        outcome:
          record.payload.execution_status === "completed"
            ? "passed"
            : record.payload.execution_status === "blocked"
              ? "unavailable"
              : "error",
        integrity_failure: false,
      };
    case "review":
    case "comparison":
      return {
        outcome: record.payload.outcome,
        integrity_failure: false,
      };
    case "capability":
      return {
        outcome: record.payload.available
          ? "passed"
          : record.schema_version === 2 &&
              record.payload.diagnostic !== undefined &&
              !(record.lane_required === true && record.check_required)
            ? "skipped"
            : "unavailable",
        integrity_failure: false,
      };
    case "error":
      if (
        record.schema_version === 2 &&
        record.payload.code === "APPROVAL_REQUIRED" &&
        record.payload.approval_id !== undefined
      ) {
        return { outcome: "error", integrity_failure: false };
      }
      if (
        record.schema_version === 2 &&
        ["CAPABILITY_UNAVAILABLE", "SERVER_NOT_READY"].includes(
          record.payload.code,
        ) &&
        record.payload.capability !== undefined &&
        record.payload.capability_required !== undefined &&
        !(
          record.lane_required === true &&
          record.check_required &&
          record.payload.capability_required
        )
      ) {
        return { outcome: "skipped", integrity_failure: false };
      }
      return verificationErrorDisposition(record.payload.code);
    default:
      return null;
  }
}

export function appendVerificationLinkedRecord(
  existing: readonly VerificationLinkedRecord[],
  input: VerificationLinkedRecord,
): readonly VerificationLinkedRecord[] {
  const records = existing.map((record) =>
    verificationLinkedRecordSchema.parse(record),
  );
  const record = verificationLinkedRecordSchema.parse(input);
  if (
    records.length > 0 &&
    records.some(
      (candidate) => candidate.schema_version !== record.schema_version,
    )
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "verification record hash chains cannot mix schema versions",
    );
  }
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

const legacyVerificationRollbackRecordSchema = z
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

const verificationRollbackRecordV2Schema = z
  .object({
    schema_version: z.literal(2),
    contract_id: z.literal("verification_contract_v2"),
    package_fingerprint: sha256Schema,
    new_starts_enabled: z.literal(false),
    preserves_existing_records: z.literal(true),
    reason: boundedStringSchema,
    recorded_at_utc: z.string().datetime({ offset: true }),
  })
  .strict();

export const verificationRollbackRecordSchema = z.union([
  legacyVerificationRollbackRecordSchema,
  verificationRollbackRecordV2Schema,
]);

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

const legacyVerificationPackageIdentitySchema = z
  .object({
    package_id: z.literal("verification-spec-v2"),
    package_status: z.literal("SPEC_APPROVED"),
    package_fingerprint: sha256Schema,
    authority_date: z.literal("2026-07-26"),
    reference_boundary: z.literal("NONE"),
    spec_sha256: sha256Schema,
  })
  .strict();

const LEGACY_APPROVED_VERIFICATION_PACKAGE = Object.freeze({
  package_id: "verification-spec-v2",
  package_status: "SPEC_APPROVED",
  package_fingerprint:
    "095ae3afac8429264c82145d83a912ac39c0a26f3c30e9ab38398348356256af",
  authority_date: "2026-07-26",
  reference_boundary: "NONE",
  spec_sha256:
    "277fb413390f83f49fdf34fab4a42e3eca83d3f499fe5442e884f165a0128399",
}) satisfies z.infer<typeof legacyVerificationPackageIdentitySchema>;

export const verificationPackageIdentityV3Schema = z
  .object({
    package_id: z.literal("verification-spec-v3"),
    package_status: z.literal("SPEC_APPROVED"),
    package_fingerprint: z.literal(
      "af32edde6b11335892ad1f7777f80fd30b66bb239c1a82e95fd3f4bbcfc5e58c",
    ),
    authority_date: z.literal("2026-07-27"),
    reference_boundary: z.literal("NONE"),
    spec_sha256: z.literal(
      "1392eb7604eb6d3f2dedc50d2810070f7467d1bad1c8dc9bd05471b83828441c",
    ),
  })
  .strict();

export const LEGACY_APPROVED_VERIFICATION_PACKAGE_V3 = Object.freeze({
  package_id: "verification-spec-v3",
  package_status: "SPEC_APPROVED",
  package_fingerprint:
    "af32edde6b11335892ad1f7777f80fd30b66bb239c1a82e95fd3f4bbcfc5e58c",
  authority_date: "2026-07-27",
  reference_boundary: "NONE",
  spec_sha256:
    "1392eb7604eb6d3f2dedc50d2810070f7467d1bad1c8dc9bd05471b83828441c",
}) satisfies z.infer<typeof verificationPackageIdentityV3Schema>;

export const verificationPackageIdentityV4Schema = z
  .object({
    package_id: z.literal("verification-spec-v4"),
    package_status: z.literal("SPEC_APPROVED"),
    package_fingerprint: z.literal(
      "9bb79af8c03d4d9c9c5dc3e815c5784a7f4861e90c89667a40160ffee1b2b2c0",
    ),
    authority_date: z.literal("2026-07-27"),
    reference_boundary: z.literal("NONE"),
    spec_sha256: z.literal(
      "8be56f57500ab15ada7bd42b5a6da34c08df8ed27dbced0b7ef70b66d3c18827",
    ),
  })
  .strict();

export const verificationPackageIdentitySchema = z.union([
  verificationPackageIdentityV3Schema,
  verificationPackageIdentityV4Schema,
]);

export const APPROVED_VERIFICATION_SPEC_SHA256 =
  "8be56f57500ab15ada7bd42b5a6da34c08df8ed27dbced0b7ef70b66d3c18827";

export const APPROVED_VERIFICATION_PACKAGE = Object.freeze({
  package_id: "verification-spec-v4",
  package_status: "SPEC_APPROVED",
  package_fingerprint:
    "9bb79af8c03d4d9c9c5dc3e815c5784a7f4861e90c89667a40160ffee1b2b2c0",
  authority_date: "2026-07-27",
  reference_boundary: "NONE",
  spec_sha256: APPROVED_VERIFICATION_SPEC_SHA256,
}) satisfies z.infer<typeof verificationPackageIdentityV4Schema>;

const verificationServerSnapshotSchema = z
  .object({
    host: z.literal("devbox"),
    bind: z.literal("0.0.0.0"),
    port: z.number().int().min(10_001).max(65_535),
    api_origin: z.string().url(),
  })
  .strict()
  .superRefine((server, context) => {
    if (server.api_origin !== `http://devbox:${server.port}`) {
      context.addIssue({
        code: "custom",
        path: ["api_origin"],
        message: "api_origin does not match the recorded local port",
      });
    }
  });

const legacyVerificationServerSnapshotSchema = z
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
        message: "legacy api_origin does not match the recorded local port",
      });
    }
  });

const legacyVerificationRunSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    snapshot_id: identifierSchema,
    package: legacyVerificationPackageIdentitySchema,
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
    server: legacyVerificationServerSnapshotSchema,
    browser_environment: browserEnvironmentSchema,
    required_capabilities: legacyRequiredCapabilitiesSchema,
    api_contract: z
      .object({
        adapter: z.literal("curl"),
        probes: z.array(verificationApiProbeSchema).min(1).max(50),
      })
      .strict(),
    browser_contract: z
      .object({
        adapter: z.literal("playwright-cli"),
        cases: z.array(legacyVerificationBrowserCaseSchema).min(1).max(50),
      })
      .strict(),
    timeouts_ms: verificationTimeoutsSchema,
    attempt_policy: legacyVerificationAttemptsSchema,
    comparison_policy: verificationComparisonPolicySchema,
    evidence_policy: verificationEvidencePolicySchema,
    approval_policy: z.literal(
      "explicit-one-time-user-decision",
    ),
    resolved_config: legacyVerificationCoordinatorConfigSchema,
    resolved_config_canonical: z.string().min(2),
    resolved_config_sha256: sha256Schema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      canonicalJson(snapshot.package) !==
      canonicalJson(LEGACY_APPROVED_VERIFICATION_PACKAGE)
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

const verificationEvidencePolicyV2Schema = verificationEvidencePolicySchema.extend({
  retention_anchor: z.literal("terminal-report-created-at"),
});

export const verificationRunSnapshotV2Schema = z
  .object({
    schema_version: z.literal(2),
    contract_id: z.literal("verification_contract_v2"),
    snapshot_id: identifierSchema,
    package: verificationPackageIdentitySchema,
    source: verificationSourceIdentitySchema,
    source_fingerprint: sha256Schema,
    run_id: z.string().regex(RUN_ID_PATTERN),
    case_id: z.literal("BOOTSTRAP-1701"),
    scenario_version: z.literal(2),
    stage: z.literal("snapshotted"),
    required: z.literal(true),
    created_at_utc: z.string().datetime({ offset: true }),
    artifact_root: z
      .string()
      .min(1)
      .refine(path.isAbsolute, "artifact_root must be absolute"),
    artifact_references: z.array(boundedStringSchema).max(500),
    baseline_root: z
      .string()
      .min(1)
      .refine(path.isAbsolute, "baseline_root must be absolute")
      .nullable(),
    baseline_identity: verificationBaselineIdentitySchema.nullable(),
    server: verificationServerSnapshotSchema,
    browser_environment: browserEnvironmentSchema.nullable(),
    backend_contract: verificationBackendLaneSchema,
    ui_contract: verificationUiLaneSchema,
    timeouts_ms: verificationTimeoutsSchema,
    attempt_policy: verificationAttemptsSchema,
    evidence_policy: verificationEvidencePolicyV2Schema,
    approval_policy: z.literal("explicit-one-time-user-decision"),
    resolved_config: verificationCoordinatorConfigV2Schema,
    resolved_config_canonical: z.string().min(2),
    resolved_config_sha256: sha256Schema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const packageIdentity = canonicalJson(snapshot.package);
    if (
      packageIdentity !== canonicalJson(APPROVED_VERIFICATION_PACKAGE) &&
      packageIdentity !==
        canonicalJson(LEGACY_APPROVED_VERIFICATION_PACKAGE_V3)
    ) {
      context.addIssue({
        code: "custom",
        path: ["package"],
        message:
          "snapshot package does not match an exact approved compatibility identity",
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
    if (snapshot.source_fingerprint !== sha256CanonicalJson(snapshot.source)) {
      context.addIssue({
        code: "custom",
        path: ["source_fingerprint"],
        message: "source fingerprint does not match the source record",
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
    if (snapshot.resolved_config_sha256 !== sha256CanonicalJson(config)) {
      context.addIssue({
        code: "custom",
        path: ["resolved_config_sha256"],
        message: "resolved configuration hash does not match",
      });
    }

    const expectedBaselineIdentity = config.ui.enabled
      ? config.ui.baseline_identity
      : null;
    const expectedBrowserEnvironment = config.ui.enabled
      ? config.ui.baseline_identity.environment
      : null;
    if (
      expectedBaselineIdentity !== null &&
      (expectedBaselineIdentity.source_commit !== snapshot.source.source_commit ||
        expectedBaselineIdentity.source_tree !== snapshot.source.source_tree)
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseline_identity"],
        message: "baseline identity does not match the approved source",
      });
    }
    if (config.ui.enabled !== (snapshot.baseline_root !== null)) {
      context.addIssue({
        code: "custom",
        path: ["baseline_root"],
        message: "baseline root must exist exactly when the UI lane is enabled",
      });
    }

    const linkedValues: Array<[unknown, unknown, PropertyKey[]]> = [
      [snapshot.baseline_identity, expectedBaselineIdentity, ["baseline_identity"]],
      [
        snapshot.browser_environment,
        expectedBrowserEnvironment,
        ["browser_environment"],
      ],
      [snapshot.backend_contract, config.backend, ["backend_contract"]],
      [snapshot.ui_contract, config.ui, ["ui_contract"]],
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
        snapshot.evidence_policy,
        {
          console_event_limit: config.evidence_limits.console_events,
          console_byte_limit: config.console_bytes,
          network_event_limit: config.evidence_limits.network_events,
          network_byte_limit: config.network_bytes,
          api_preview_byte_limit: config.evidence_limits.api_preview_bytes,
          retention_days: config.retention_days,
          retention_anchor: config.retention_anchor,
          semantic_review_required:
            config.ui.enabled && config.ui.semantic_review_required,
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

export const verificationRunSnapshotSchema = z.union([
  legacyVerificationRunSnapshotSchema,
  verificationRunSnapshotV2Schema,
]);

export type VerificationRunSnapshot = z.infer<
  typeof verificationRunSnapshotSchema
>;

export function verificationRecordMatchesSnapshot(
  snapshot: VerificationRunSnapshot,
  record: VerificationLinkedRecord,
): boolean {
  if (snapshot.schema_version !== 2 || record.schema_version !== 2) {
    return snapshot.schema_version === record.schema_version;
  }
  if (record.lane === null) {
    if (record.lane_required !== null) {
      return false;
    }
  } else {
    const laneContract =
      record.lane === "backend"
        ? snapshot.backend_contract
        : snapshot.ui_contract;
    if (
      !laneContract.enabled ||
      record.lane_required !== laneContract.required
    ) {
      return false;
    }
  }

  const requiresCheckScope = [
    "request",
    "browser",
    "agentic_browser",
    "screenshot",
    "review",
    "comparison",
  ].includes(record.record_type);
  if (
    (requiresCheckScope && record.check_id === null) ||
    (!requiresCheckScope &&
      record.record_type !== "error" &&
      record.check_id !== null)
  ) {
    return false;
  }
  if (record.record_type === "error") {
    if (
      record.payload.kind === "error" &&
      record.payload.capability !== undefined
    ) {
      if (record.lane === null) {
        return false;
      }
      const declaredCapabilities =
        record.lane === "backend" && snapshot.backend_contract.enabled
          ? snapshot.backend_contract.required_capabilities
          : record.lane === "ui" && snapshot.ui_contract.enabled
            ? [
                ...snapshot.ui_contract.required_capabilities,
                ...snapshot.ui_contract.optional_capabilities,
              ]
            : [];
      if (!declaredCapabilities.includes(record.payload.capability)) {
        return false;
      }
      const requiredCapabilities =
        record.lane === "backend" && snapshot.backend_contract.enabled
          ? snapshot.backend_contract.required_capabilities
          : record.lane === "ui" && snapshot.ui_contract.enabled
            ? snapshot.ui_contract.required_capabilities
            : [];
      if (
        record.payload.capability_required !==
        requiredCapabilities.includes(record.payload.capability)
      ) {
        return false;
      }
    }
    if (record.check_id === null) {
      return true;
    }
    if (record.lane === "backend" && snapshot.backend_contract.enabled) {
      const probe = snapshot.backend_contract.api_probes.find(
        (candidate) => candidate.id === record.check_id,
      );
      return probe !== undefined && record.check_required === probe.required;
    }
    if (record.lane === "ui" && snapshot.ui_contract.enabled) {
      const check =
        snapshot.ui_contract.browser_cases.find(
          (candidate) => candidate.id === record.check_id,
        ) ??
        snapshot.ui_contract.agentic_tasks.find(
          (candidate) => candidate.id === record.check_id,
        );
      return check !== undefined && record.check_required === check.required;
    }
    return false;
  }
  if (
    record.record_type === "capability" &&
    record.payload.kind === "capability"
  ) {
    const requiredCapabilities =
      record.lane === "backend" && snapshot.backend_contract.enabled
        ? snapshot.backend_contract.required_capabilities
        : record.lane === "ui" && snapshot.ui_contract.enabled
          ? snapshot.ui_contract.required_capabilities
          : [];
    const optionalCapabilities =
      record.lane === "ui" && snapshot.ui_contract.enabled
        ? snapshot.ui_contract.optional_capabilities
        : [];
    return (
      (requiredCapabilities.includes(record.payload.capability) ||
        optionalCapabilities.includes(record.payload.capability)) &&
      record.check_required ===
        requiredCapabilities.includes(record.payload.capability)
    );
  }
  if (!requiresCheckScope || record.check_id === null) {
    return true;
  }

  if (
    record.record_type === "request" &&
    record.lane === "backend" &&
    record.payload.kind === "request" &&
    snapshot.backend_contract.enabled
  ) {
    const probe = snapshot.backend_contract.api_probes.find(
      (candidate) => candidate.id === record.check_id,
    );
    return (
      probe !== undefined &&
      record.payload.method === probe.method &&
      record.payload.path === probe.path &&
      record.payload.expected_status === probe.expected_status &&
      record.check_required === probe.required &&
      record.adapter?.name === snapshot.backend_contract.api_adapter &&
      record.adapter.version === snapshot.backend_contract.api_adapter_version
    );
  }
  if (
    record.record_type === "agentic_browser" &&
    record.lane === "ui" &&
    record.payload.kind === "agentic_browser" &&
    snapshot.ui_contract.enabled
  ) {
    const task = snapshot.ui_contract.agentic_tasks.find(
      (candidate) => candidate.id === record.check_id,
    );
    return (
      task !== undefined &&
      record.check_required === task.required &&
      record.adapter?.name === task.adapter &&
      record.adapter.version === task.adapter_version &&
      record.model?.identity === task.model_identity
    );
  }
  if (
    ["browser", "screenshot", "review", "comparison"].includes(
      record.record_type,
    ) &&
    record.lane === "ui" &&
    record.payload.kind === record.record_type &&
    snapshot.ui_contract.enabled
  ) {
    const browserCase = snapshot.ui_contract.browser_cases.find(
      (candidate) => candidate.id === record.check_id,
    );
    const deterministicAdapterMatches =
      !["browser", "screenshot"].includes(record.record_type) ||
      (record.adapter?.name === snapshot.ui_contract.deterministic_adapter &&
        record.adapter.version ===
          snapshot.ui_contract.deterministic_adapter_version);
    const caseHashMatches =
      record.record_type !== "browser" ||
      (record.payload.kind === "browser" &&
        browserCase !== undefined &&
        record.payload.case_sha256 === sha256CanonicalJson(browserCase));
    return (
      browserCase !== undefined &&
      record.check_required === browserCase.required &&
      deterministicAdapterMatches &&
      caseHashMatches
    );
  }
  return false;
}

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
): z.infer<typeof verificationRunSnapshotV2Schema> {
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
  if (config.schema_version !== 2) {
    throw new ArkTeamError(
      "CONTRACT_VERSION_MISMATCH",
      "contract-v1 verification configuration is read-only",
    );
  }
  if (!config.enabled) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "verification coordinator is not enabled",
    );
  }
  if (
    config.ui.enabled &&
    (config.ui.baseline_identity.source_commit !== input.source.source_commit ||
      config.ui.baseline_identity.source_tree !== input.source.source_tree)
  ) {
    throw new ArkTeamError(
      "SOURCE_DRIFT",
      "approved baseline identity does not match the captured source",
    );
  }
  const parsedSnapshot = verificationRunSnapshotV2Schema.safeParse({
    schema_version: 2,
    contract_id: "verification_contract_v2",
    snapshot_id: `${input.run_id}-verification-v2`,
    package: APPROVED_VERIFICATION_PACKAGE,
    source: input.source,
    source_fingerprint: sha256CanonicalJson(input.source),
    run_id: input.run_id,
    case_id: "BOOTSTRAP-1701",
    scenario_version: 2,
    stage: "snapshotted",
    required: true,
    created_at_utc: input.created_at_utc,
    artifact_root: input.artifact_root,
    artifact_references: [],
    baseline_root: config.ui.enabled
      ? path.resolve(input.project_path, config.ui.baseline_root)
      : null,
    baseline_identity: config.ui.enabled ? config.ui.baseline_identity : null,
    server: {
      host: config.server_host,
      bind: config.server_bind,
      port: input.server_port,
      api_origin: `http://devbox:${input.server_port}`,
    },
    browser_environment: config.ui.enabled
      ? config.ui.baseline_identity.environment
      : null,
    backend_contract: config.backend,
    ui_contract: config.ui,
    timeouts_ms: {
      server_ms: config.server_timeout_ms,
      api_ms: config.api_timeout_ms,
      browser_ms: config.browser_timeout_ms,
      case_ms: config.case_timeout_ms,
    },
    attempt_policy: config.attempts,
    evidence_policy: {
      console_event_limit: config.evidence_limits.console_events,
      console_byte_limit: config.console_bytes,
      network_event_limit: config.evidence_limits.network_events,
      network_byte_limit: config.network_bytes,
      api_preview_byte_limit: config.evidence_limits.api_preview_bytes,
      retention_days: config.retention_days,
      retention_anchor: config.retention_anchor,
      semantic_review_required:
        config.ui.enabled && config.ui.semantic_review_required,
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
