import { createHash } from "node:crypto";

import { z } from "zod";

import {
  sha256CanonicalJson,
  verificationRunSnapshotV2Schema,
} from "./verification-contract.js";
import {
  createVerificationScreenshotRuntimeV2Expectation,
  createVerificationScreenshotRuntimeV2Plan,
  normalizeVerificationScreenshotRuntimeV2Result,
  type NormalizedVerificationScreenshotResult,
  type VerificationScreenshotRuntimeV2Plan,
  type VerificationScreenshotRuntimeV2Result,
} from "./verification-visual-adapter.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_MESSAGE_CHARACTERS = 1_000;
const SECRET_EVIDENCE_PATTERN =
  /(?:authorization|bearer|cookie|password|secret|token|api[_-]?key)\s*(?:=|:)?\s*[^\s,;]*/gi;
const OPAQUE_SECRET_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{48,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

type SnapshotV2 = z.infer<typeof verificationRunSnapshotV2Schema>;
type EnabledUiContract = Extract<
  SnapshotV2["ui_contract"],
  { enabled: true }
>;
type BrowserCase = EnabledUiContract["browser_cases"][number];
type BrowserAction = BrowserCase["actions"][number];
type BrowserAssertion = BrowserCase["assertions"][number];

export interface VerificationBrowserViewport {
  readonly name: "375x812" | "768x1024" | "1440x900";
  readonly width: number;
  readonly height: number;
}

export interface VerificationBrowserDriverRequest {
  readonly schema_version: 1;
  readonly contract_id: "verification_browser_driver_v1";
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly case_id: string;
  readonly attempt_id: string;
  readonly case_sha256: string;
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
    readonly fresh: true;
    readonly isolated: true;
    readonly device_scale_factor: 1;
    readonly locale: "en-US";
    readonly timezone: "UTC";
    readonly color_scheme: "light";
    readonly reduced_motion: "no-preference";
    readonly viewports: readonly VerificationBrowserViewport[];
  };
  readonly network: {
    readonly allowed_origin: string;
    readonly redirects: "same-origin-only";
    readonly proxy: "disabled";
    readonly credentials: "omit";
  };
  readonly readiness: {
    readonly selector: string;
    readonly timeout_ms: 60_000;
    readonly wait: "auto";
  };
  readonly actions: readonly {
    readonly sequence: number;
    readonly action: BrowserAction;
  }[];
  readonly assertions: readonly {
    readonly sequence: number;
    readonly assertion: BrowserAssertion;
  }[];
  readonly auto_wait_timeout_ms: 60_000;
  readonly case_timeout_ms: 120_000;
  readonly trace: {
    readonly enabled: true;
    readonly relative_path: string;
    readonly media_type: "application/zip";
  };
  readonly policy: {
    readonly llm_verdict: "disabled";
    readonly visual_assertions: "disabled";
    readonly screenshots: "disabled";
    readonly self_heal: "disabled";
    readonly baseline_update: "disabled";
    readonly undeclared_actions: "disabled";
  };
}

export interface VerificationBrowserDriverResult {
  readonly schema_version: 1;
  readonly contract_id: "verification_browser_driver_result_v1";
  readonly case_id: string;
  readonly case_sha256: string;
  readonly adapter: {
    readonly name: string;
    readonly version: string;
  };
  readonly browser_build: string;
  readonly origin: string;
  readonly final_url: string;
  readonly context: VerificationBrowserDriverRequest["context"];
  readonly elapsed_ms: number;
  readonly readiness: {
    readonly passed: boolean;
    readonly elapsed_ms: number;
    readonly message: string | null;
  };
  readonly actions: readonly VerificationBrowserStepEvidence[];
  readonly assertions: readonly VerificationBrowserStepEvidence[];
  readonly navigation: readonly VerificationBrowserNavigationEvidence[];
  readonly console: readonly VerificationBrowserConsoleEvidence[];
  readonly page_errors: readonly VerificationBrowserMessageEvidence[];
  readonly dialogs: readonly VerificationBrowserDialogEvidence[];
  readonly trace: {
    readonly relative_path: string;
    readonly media_type: "application/zip";
    readonly sha256: string;
    readonly bytes: Uint8Array;
  };
  readonly passed: boolean;
  readonly message: string;
}

export interface VerificationBrowserDriverV2Request
  extends Omit<
    VerificationBrowserDriverRequest,
    "schema_version" | "contract_id" | "policy"
  > {
  readonly schema_version: 2;
  readonly contract_id: "verification_browser_driver_v2";
  readonly package_fingerprint: string;
  readonly source_fingerprint: string;
  readonly screenshot: VerificationScreenshotRuntimeV2Plan;
  readonly policy: Omit<
    VerificationBrowserDriverRequest["policy"],
    "screenshots"
  > & {
    readonly screenshots: "required";
  };
}

export interface VerificationBrowserDriverV2Result
  extends Omit<
    VerificationBrowserDriverResult,
    "schema_version" | "contract_id"
  > {
  readonly schema_version: 2;
  readonly contract_id: "verification_browser_driver_result_v2";
  readonly screenshot: VerificationScreenshotRuntimeV2Result;
}

export interface VerificationBrowserStepEvidence {
  readonly sequence: number;
  readonly input_sha256: string;
  readonly passed: boolean;
  readonly elapsed_ms: number;
  readonly message: string | null;
}

export interface VerificationBrowserNavigationEvidence {
  readonly sequence: number;
  readonly url: string;
  readonly status: number;
  readonly elapsed_ms: number;
}

export interface VerificationBrowserConsoleEvidence {
  readonly sequence: number;
  readonly level: "debug" | "info" | "log" | "warn" | "error";
  readonly message: string;
}

export interface VerificationBrowserMessageEvidence {
  readonly sequence: number;
  readonly message: string;
}

export interface VerificationBrowserDialogEvidence
  extends VerificationBrowserMessageEvidence {
  readonly type: "alert" | "beforeunload" | "confirm" | "prompt";
  readonly action: "dismissed";
}

export interface VerificationBrowserEvidence
  extends Omit<VerificationBrowserDriverResult, "trace"> {
  readonly trace: {
    readonly relative_path: string;
    readonly media_type: "application/zip";
    readonly sha256: string;
    readonly byte_length: number;
  };
}

export interface NormalizedVerificationBrowserDriverResult {
  readonly evidence: VerificationBrowserEvidence;
  readonly trace_bytes: Uint8Array;
  readonly passed: boolean;
  readonly message: string;
}

export interface NormalizedVerificationBrowserDriverV2Result {
  readonly browser: NormalizedVerificationBrowserDriverResult;
  readonly screenshot: NormalizedVerificationScreenshotResult;
  readonly passed: boolean;
  readonly message: string;
}

export class VerificationBrowserContractError extends Error {
  readonly code = "BROWSER_CONTRACT_MISMATCH";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VerificationBrowserContractError";
  }
}

const requestInputSchema = z
  .object({
    snapshot: verificationRunSnapshotV2Schema,
    case_id: z.string().regex(IDENTIFIER_PATTERN),
    attempt_id: z.string().regex(IDENTIFIER_PATTERN),
  })
  .strict();

export function createVerificationBrowserDriverRequest(input: {
  readonly snapshot: unknown;
  readonly case_id: string;
  readonly attempt_id: string;
}): VerificationBrowserDriverRequest {
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw contractError("browser request input is invalid", parsed.error);
  }
  const { snapshot, case_id: caseId, attempt_id: attemptId } = parsed.data;
  if (!snapshot.ui_contract.enabled || snapshot.browser_environment === null) {
    throw contractError("browser request requires an enabled snapshotted UI lane");
  }
  const browserCase = snapshot.ui_contract.browser_cases.find(
    (candidate) => candidate.id === caseId,
  );
  if (browserCase === undefined) {
    throw contractError("browser request targets an undeclared case");
  }
  assertRecordedOrigin(snapshot.server.api_origin);
  const targetUrl = new URL(browserCase.path, snapshot.server.api_origin).toString();
  assertLocalUrl(targetUrl, snapshot.server.api_origin);

  const viewports = snapshot.browser_environment.viewports.map((viewport) => {
    const [width, height] = viewport.split("x").map(Number);
    return {
      name: viewport,
      width,
      height,
    };
  }) as VerificationBrowserViewport[];

  return deepFreeze({
    schema_version: 1,
    contract_id: "verification_browser_driver_v1",
    run_id: snapshot.run_id,
    snapshot_id: snapshot.snapshot_id,
    case_id: browserCase.id,
    attempt_id: attemptId,
    case_sha256: sha256CanonicalJson(browserCase),
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
    url: targetUrl,
    context: {
      fresh: true,
      isolated: true,
      device_scale_factor: snapshot.browser_environment.device_scale_factor,
      locale: snapshot.browser_environment.locale,
      timezone: snapshot.browser_environment.timezone,
      color_scheme: snapshot.browser_environment.color_scheme,
      reduced_motion: snapshot.browser_environment.reduced_motion,
      viewports,
    },
    network: {
      allowed_origin: snapshot.server.api_origin,
      redirects: "same-origin-only",
      proxy: "disabled",
      credentials: "omit",
    },
    readiness: {
      selector: browserCase.readiness,
      timeout_ms: snapshot.timeouts_ms.browser_ms,
      wait: "auto",
    },
    actions: browserCase.actions.map((action, sequence) => ({
      sequence,
      action: structuredClone(action),
    })),
    assertions: browserCase.assertions.map((assertion, sequence) => ({
      sequence,
      assertion: structuredClone(assertion),
    })),
    auto_wait_timeout_ms: snapshot.timeouts_ms.browser_ms,
    case_timeout_ms: snapshot.timeouts_ms.case_ms,
    trace: {
      enabled: true,
      relative_path: `traces/${browserCase.id}/${attemptId}.playwright-trace.zip`,
      media_type: "application/zip",
    },
    policy: {
      llm_verdict: "disabled",
      visual_assertions: "disabled",
      screenshots: "disabled",
      self_heal: "disabled",
      baseline_update: "disabled",
      undeclared_actions: "disabled",
    },
  });
}

export function createVerificationBrowserDriverV2Request(input: {
  readonly snapshot: unknown;
  readonly case_id: string;
  readonly attempt_id: string;
}): VerificationBrowserDriverV2Request {
  const browser = createVerificationBrowserDriverRequest(input);
  let screenshot: VerificationScreenshotRuntimeV2Plan;
  try {
    screenshot = createVerificationScreenshotRuntimeV2Plan(input);
  } catch (error) {
    throw contractError("combined screenshot request is invalid", error);
  }
  assertCombinedRequestIdentity(browser, screenshot);

  return deepFreeze({
    ...browser,
    schema_version: 2,
    contract_id: "verification_browser_driver_v2",
    package_fingerprint: screenshot.package_fingerprint,
    source_fingerprint: screenshot.source_fingerprint,
    screenshot,
    policy: {
      ...browser.policy,
      screenshots: "required",
    },
  });
}

export function normalizeVerificationBrowserDriverV2Result(
  request: VerificationBrowserDriverV2Request,
  rawResult: unknown,
): NormalizedVerificationBrowserDriverV2Result {
  const envelope = z
    .object({
      schema_version: z.literal(2),
      contract_id: z.literal("verification_browser_driver_result_v2"),
      screenshot: z.unknown(),
    })
    .passthrough()
    .safeParse(rawResult);
  if (!envelope.success) {
    throw contractError("combined browser driver result is invalid", envelope.error);
  }

  const { screenshot: rawScreenshot, ...rawBrowserV2 } = envelope.data;
  const rawBrowserV1 = {
    ...rawBrowserV2,
    schema_version: 1,
    contract_id: "verification_browser_driver_result_v1",
  };
  const browser = normalizeVerificationBrowserDriverResult(
    toV1BrowserRequest(request),
    rawBrowserV1,
  );

  // The v1 normalizer above is the authority that validates same-origin before
  // the raw final URL becomes the exact screenshot expectation.
  const finalUrl = (
    rawBrowserV1 as unknown as VerificationBrowserDriverResult
  ).final_url;
  let screenshot;
  try {
    const expectation = createVerificationScreenshotRuntimeV2Expectation({
      plan: request.screenshot,
      final_url: finalUrl,
    });
    screenshot = normalizeVerificationScreenshotRuntimeV2Result(
      expectation,
      rawScreenshot,
    );
  } catch (error) {
    throw contractError("combined screenshot result is invalid", error);
  }

  return Object.freeze({
    browser,
    screenshot,
    passed: browser.passed,
    message: browser.message,
  });
}

export function normalizeVerificationBrowserDriverResult(
  request: VerificationBrowserDriverRequest,
  rawResult: unknown,
): NormalizedVerificationBrowserDriverResult {
  const parsed = driverResultSchema(request).safeParse(rawResult);
  if (!parsed.success) {
    throw contractError("browser driver result is invalid", parsed.error);
  }
  const result = parsed.data;
  assertResultIdentity(request, result);
  assertExactContext(request.context, result.context);
  assertOrderedSteps(request.actions, result.actions);
  assertOrderedSteps(request.assertions, result.assertions);
  assertEvidenceBounds(request, result);
  assertLocalUrl(result.final_url, request.origin);
  for (const navigation of result.navigation) {
    assertLocalUrl(navigation.url, request.origin);
  }
  if (result.navigation[0]?.url !== request.url) {
    throw contractError("browser navigation did not begin at the declared URL");
  }
  if (result.navigation.at(-1)?.url !== result.final_url) {
    throw contractError("browser final URL does not match navigation evidence");
  }

  const expectedPassed =
    result.readiness.passed &&
    result.actions.every((step) => step.passed) &&
    result.assertions.every((step) => step.passed);
  if (result.passed !== expectedPassed) {
    throw contractError(
      "browser pass result does not match readiness, actions, and assertions",
    );
  }

  const traceBytes = Uint8Array.from(result.trace.bytes);
  const traceSha256 = createHash("sha256").update(traceBytes).digest("hex");
  if (traceSha256 !== result.trace.sha256) {
    throw contractError("browser trace hash does not match its bytes");
  }

  const evidence: VerificationBrowserEvidence = {
    ...result,
    final_url: redactUrlEvidence(result.final_url),
    readiness: {
      ...result.readiness,
      message: redactMessage(result.readiness.message),
    },
    actions: result.actions.map(redactStep),
    assertions: result.assertions.map(redactStep),
    navigation: result.navigation.map((event) => ({
      ...event,
      url: redactUrlEvidence(event.url),
    })),
    console: result.console.map((event) => ({
      ...event,
      message: redactMessage(event.message) ?? "",
    })),
    page_errors: result.page_errors.map((event) => ({
      ...event,
      message: redactMessage(event.message) ?? "",
    })),
    dialogs: result.dialogs.map((event) => ({
      ...event,
      message: redactMessage(event.message) ?? "",
    })),
    trace: {
      relative_path: result.trace.relative_path,
      media_type: result.trace.media_type,
      sha256: result.trace.sha256,
      byte_length: traceBytes.byteLength,
    },
    message: redactMessage(result.message) ?? "",
  };

  if (
    Buffer.byteLength(JSON.stringify(evidence), "utf8") >
    64 * 1_024
  ) {
    throw contractError("browser result metadata exceeds 64 KiB");
  }

  return {
    evidence: deepFreeze(evidence),
    trace_bytes: traceBytes,
    passed: evidence.passed,
    message: evidence.message,
  };
}

const boundedMessageSchema = z
  .string()
  .max(MAX_EVIDENCE_MESSAGE_CHARACTERS)
  .refine((value) => !value.includes("\0"), "message contains NUL");
const nullableMessageSchema = boundedMessageSchema.nullable();

function driverResultSchema(request: VerificationBrowserDriverRequest) {
  const elapsedSchema = z.number().int().nonnegative().max(request.case_timeout_ms);
  const stepSchema = z
    .object({
      sequence: z.number().int().nonnegative().max(49),
      input_sha256: z.string().regex(SHA256_PATTERN),
      passed: z.boolean(),
      elapsed_ms: z
        .number()
        .int()
        .nonnegative()
        .max(request.auto_wait_timeout_ms),
      message: nullableMessageSchema,
    })
    .strict();
  const sequencedMessageSchema = z
    .object({
      sequence: z.number().int().nonnegative().max(99),
      message: boundedMessageSchema,
    })
    .strict();
  return z
    .object({
      schema_version: z.literal(1),
      contract_id: z.literal("verification_browser_driver_result_v1"),
      case_id: z.string().regex(IDENTIFIER_PATTERN),
      case_sha256: z.string().regex(SHA256_PATTERN),
      adapter: z
        .object({
          name: z.string().regex(IDENTIFIER_PATTERN),
          version: z.string().min(1).max(128),
        })
        .strict(),
      browser_build: z.string().min(1).max(128),
      origin: z.string().max(2_048),
      final_url: z.string().max(2_048),
      context: z
        .object({
          fresh: z.literal(true),
          isolated: z.literal(true),
          device_scale_factor: z.literal(1),
          locale: z.literal("en-US"),
          timezone: z.literal("UTC"),
          color_scheme: z.literal("light"),
          reduced_motion: z.literal("no-preference"),
          viewports: z
            .array(
              z
                .object({
                  name: z.enum(["375x812", "768x1024", "1440x900"]),
                  width: z.number().int().positive(),
                  height: z.number().int().positive(),
                })
                .strict(),
            )
            .length(request.context.viewports.length),
        })
        .strict(),
      elapsed_ms: elapsedSchema,
      readiness: z
        .object({
          passed: z.boolean(),
          elapsed_ms: z
            .number()
            .int()
            .nonnegative()
            .max(request.readiness.timeout_ms),
          message: nullableMessageSchema,
        })
        .strict(),
      actions: z.array(stepSchema).length(request.actions.length),
      assertions: z.array(stepSchema).length(request.assertions.length),
      navigation: z
        .array(
          z
            .object({
              sequence: z.number().int().nonnegative().max(99),
              url: z.string().min(1).max(2_048),
              status: z.number().int().min(100).max(599),
              elapsed_ms: elapsedSchema,
            })
            .strict(),
        )
        .min(1)
        .max(100),
      console: z
        .array(
          z
            .object({
              sequence: z.number().int().nonnegative().max(99),
              level: z.enum(["debug", "info", "log", "warn", "error"]),
              message: boundedMessageSchema,
            })
            .strict(),
        )
        .max(100),
      page_errors: z.array(sequencedMessageSchema).max(100),
      dialogs: z
        .array(
          sequencedMessageSchema
            .extend({
              type: z.enum(["alert", "beforeunload", "confirm", "prompt"]),
              action: z.literal("dismissed"),
            })
            .strict(),
        )
        .max(100),
      trace: z
        .object({
          relative_path: z.string().min(1).max(1_000),
          media_type: z.literal("application/zip"),
          sha256: z.string().regex(SHA256_PATTERN),
          bytes: z.instanceof(Uint8Array),
        })
        .strict(),
      passed: z.boolean(),
      message: boundedMessageSchema,
    })
    .strict();
}

function assertResultIdentity(
  request: VerificationBrowserDriverRequest,
  result: z.infer<ReturnType<typeof driverResultSchema>>,
): void {
  if (
    result.case_id !== request.case_id ||
    result.case_sha256 !== request.case_sha256 ||
    result.adapter.name !== request.adapter.name ||
    result.adapter.version !== request.adapter.version ||
    result.browser_build !== request.browser_build ||
    result.origin !== request.origin ||
    result.trace.relative_path !== request.trace.relative_path
  ) {
    throw contractError("browser result identity differs from the request");
  }
  if (
    result.trace.bytes.byteLength < 1 ||
    result.trace.bytes.byteLength > 50 * 1_024 * 1_024
  ) {
    throw contractError("browser trace bytes are empty or exceed 50 MiB");
  }
}

function assertCombinedRequestIdentity(
  browser: VerificationBrowserDriverRequest,
  screenshot: VerificationScreenshotRuntimeV2Plan,
): void {
  if (
    screenshot.run_id !== browser.run_id ||
    screenshot.snapshot_id !== browser.snapshot_id ||
    screenshot.case_id !== browser.case_id ||
    screenshot.attempt_id !== browser.attempt_id ||
    screenshot.case_sha256 !== browser.case_sha256 ||
    screenshot.adapter.name !== browser.adapter.name ||
    screenshot.adapter.version !== browser.adapter.version ||
    screenshot.browser_build !== browser.browser_build ||
    screenshot.engine !== browser.engine ||
    screenshot.execution.cwd !== browser.execution.cwd ||
    screenshot.execution.shell !== browser.execution.shell ||
    screenshot.origin !== browser.origin ||
    screenshot.initial_url !== browser.url ||
    screenshot.network.allowed_origin !== browser.network.allowed_origin ||
    screenshot.readiness.selector !== browser.readiness.selector ||
    screenshot.readiness.timeout_ms !== browser.readiness.timeout_ms
  ) {
    throw contractError(
      "combined screenshot contract identity differs from the browser request",
    );
  }
}

function toV1BrowserRequest(
  request: VerificationBrowserDriverV2Request,
): VerificationBrowserDriverRequest {
  return {
    schema_version: 1,
    contract_id: "verification_browser_driver_v1",
    run_id: request.run_id,
    snapshot_id: request.snapshot_id,
    case_id: request.case_id,
    attempt_id: request.attempt_id,
    case_sha256: request.case_sha256,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    engine: request.engine,
    execution: { ...request.execution },
    origin: request.origin,
    url: request.url,
    context: {
      ...request.context,
      viewports: request.context.viewports.map((viewport) => ({ ...viewport })),
    },
    network: { ...request.network },
    readiness: { ...request.readiness },
    actions: request.actions.map((action) => structuredClone(action)),
    assertions: request.assertions.map((assertion) => structuredClone(assertion)),
    auto_wait_timeout_ms: request.auto_wait_timeout_ms,
    case_timeout_ms: request.case_timeout_ms,
    trace: { ...request.trace },
    policy: {
      llm_verdict: request.policy.llm_verdict,
      visual_assertions: request.policy.visual_assertions,
      screenshots: "disabled",
      self_heal: request.policy.self_heal,
      baseline_update: request.policy.baseline_update,
      undeclared_actions: request.policy.undeclared_actions,
    },
  };
}

function assertExactContext(
  expected: VerificationBrowserDriverRequest["context"],
  actual: VerificationBrowserDriverResult["context"],
): void {
  if (sha256CanonicalJson(expected) !== sha256CanonicalJson(actual)) {
    throw contractError("browser context differs from the snapshotted context");
  }
}

function assertOrderedSteps(
  declared: readonly { readonly sequence: number; readonly action?: BrowserAction; readonly assertion?: BrowserAssertion }[],
  actual: readonly VerificationBrowserStepEvidence[],
): void {
  declared.forEach((entry, sequence) => {
    const input = entry.action ?? entry.assertion;
    const evidence = actual[sequence];
    if (
      evidence === undefined ||
      entry.sequence !== sequence ||
      evidence.sequence !== sequence ||
      input === undefined ||
      evidence.input_sha256 !== sha256CanonicalJson(input)
    ) {
      throw contractError("browser step evidence is missing, reordered, or undeclared");
    }
  });
}

function assertEvidenceBounds(
  request: VerificationBrowserDriverRequest,
  result: VerificationBrowserDriverResult,
): void {
  if (
    Buffer.byteLength(JSON.stringify(result.console), "utf8") > 32 * 1_024
  ) {
    throw contractError("browser console evidence exceeds 32 KiB");
  }
  if (
    Buffer.byteLength(JSON.stringify(result.navigation), "utf8") > 32 * 1_024
  ) {
    throw contractError("browser navigation evidence exceeds 32 KiB");
  }
  assertSequences(result.navigation);
  assertSequences(result.console);
  assertSequences(result.page_errors);
  assertSequences(result.dialogs);
  if (
    result.elapsed_ms > request.case_timeout_ms ||
    result.readiness.elapsed_ms > request.readiness.timeout_ms
  ) {
    throw contractError("browser evidence reports an unbounded wait");
  }
}

function assertSequences(values: readonly { sequence: number }[]): void {
  if (values.some((value, index) => value.sequence !== index)) {
    throw contractError("browser evidence sequence is not contiguous and ordered");
  }
}

function assertRecordedOrigin(origin: string): void {
  const parsed = new URL(origin);
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
    throw contractError("browser origin is not the recorded local dev origin");
  }
}

function assertLocalUrl(value: string, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw contractError("browser evidence contains an invalid URL", error);
  }
  if (
    parsed.origin !== origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.protocol !== "http:"
  ) {
    throw contractError("browser evidence contains cross-origin or credentialed URL");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:authorization|cookie|password|secret|token|api[_-]?key)/i.test(key)) {
      throw contractError("browser evidence URL contains a credential query key");
    }
  }
}

function redactUrlEvidence(value: string): string {
  const url = new URL(value);
  const query = [...url.searchParams.entries()].map(([name]) => [
    redactMessage(name) ?? "",
    "<redacted>",
  ] as const);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  for (const [name, redactedValue] of query) {
    url.searchParams.append(name, redactedValue);
  }
  return redactMessage(url.toString()) ?? "";
}

function redactStep(
  step: VerificationBrowserStepEvidence,
): VerificationBrowserStepEvidence {
  return {
    ...step,
    message: redactMessage(step.message),
  };
}

function redactMessage(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value
    .replace(SECRET_EVIDENCE_PATTERN, "[REDACTED]")
    .replace(OPAQUE_SECRET_PATTERN, "[REDACTED]");
}

function contractError(message: string, cause?: unknown): VerificationBrowserContractError {
  return new VerificationBrowserContractError(message, { cause });
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
