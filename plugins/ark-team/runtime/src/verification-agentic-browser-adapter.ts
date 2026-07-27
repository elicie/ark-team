import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
  verificationRunSnapshotV2Schema,
} from "./verification-contract.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SECRET_PATTERN =
  /(?:authorization|bearer|cookie|password|secret|token|api[_-]?key)\s*(?:=|:)?\s*[^\s,;]*/gi;
const OPAQUE_SECRET_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{48,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

type SnapshotV2 = z.infer<typeof verificationRunSnapshotV2Schema>;
type EnabledUiContract = Extract<
  SnapshotV2["ui_contract"],
  { enabled: true }
>;
type AgenticTask = EnabledUiContract["agentic_tasks"][number];
type AgenticAction = AgenticTask["allowed_actions"][number];

export interface VerificationAgenticBrowserRequest {
  readonly schema_version: 1;
  readonly contract_id: "verification_agentic_browser_v1";
  readonly run_id: string;
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly task_sha256: string;
  readonly input_sha256: string;
  readonly adapter: {
    readonly name: "browser-use" | "playwright-agent" | "stagehand";
    readonly version: string;
    readonly api_major: string;
  };
  readonly browser_build: string;
  readonly model_identity: string;
  readonly origin: string;
  readonly origin_allowlist: readonly [string];
  readonly start_url: string;
  readonly execution: {
    readonly cwd: string;
    readonly profile: "fresh_ephemeral";
    readonly persistent_profile: "disabled";
    readonly shell: false;
    readonly remote_browser: "disabled";
    readonly cloud_browser: "disabled";
    readonly tunnel: "disabled";
    readonly proxy: "disabled";
    readonly separate_remote_model: "disabled";
  };
  readonly goal: string;
  readonly success_criteria: AgenticTask["success_criteria"];
  readonly deterministic_postconditions_sha256: string;
  readonly allowed_actions: readonly AgenticAction[];
  readonly max_steps: 20;
  readonly timeout_ms: 120_000;
  readonly system_prompt_template: string;
  readonly prompt_sha256: string;
  readonly checklist: readonly string[];
  readonly checklist_sha256: string;
  readonly limits: {
    readonly findings: 50;
    readonly findings_bytes: 16_384;
  };
  readonly policy: {
    readonly advisory_only: true;
    readonly deterministic_recheck_required: true;
    readonly generated_changes: "candidate_only";
    readonly apply_generated_changes: "disabled";
    readonly raw_reasoning: "disabled";
    readonly transcript: "disabled";
    readonly external_navigation: "disabled";
  };
}

export interface VerificationAgenticLedgerEntry {
  readonly sequence: number;
  readonly action: AgenticAction;
  readonly url: string;
  readonly parameters: Readonly<Record<string, string | number | boolean | null>>;
  readonly result: "completed" | "blocked" | "error";
  readonly error_code: string | null;
  readonly artifact_references: readonly {
    readonly artifact_id: string;
    readonly relative_path: string;
    readonly sha256: string;
  }[];
  readonly timestamp_utc: string;
}

export interface VerificationAgenticCandidate {
  readonly kind:
    | "plan"
    | "locator"
    | "script"
    | "test"
    | "healer_patch"
    | "baseline";
  readonly relative_path: string;
  readonly sha256: string;
  readonly applied: false;
}

export interface VerificationAgenticBrowserRuntimeResult {
  readonly schema_version: 1;
  readonly contract_id: "verification_agentic_browser_result_v1";
  readonly task_id: string;
  readonly task_sha256: string;
  readonly input_sha256: string;
  readonly adapter: VerificationAgenticBrowserRequest["adapter"];
  readonly browser_build: string;
  readonly model_identity: string;
  readonly origin: string;
  readonly execution_status: "completed" | "blocked" | "error";
  readonly finding_status: "finding" | "no_finding" | "unknown";
  readonly self_verdict?:
    | "achieved"
    | "not_achieved"
    | "unknown"
    | undefined;
  readonly judge_verdict?:
    | "achieved"
    | "not_achieved"
    | "unknown"
    | undefined;
  readonly findings: readonly string[];
  readonly ledger: readonly VerificationAgenticLedgerEntry[];
  readonly candidates: readonly VerificationAgenticCandidate[];
  readonly started_at_utc: string;
  readonly finished_at_utc: string;
  readonly elapsed_ms: number;
}

export interface VerificationAgenticBrowserEvidence
  extends VerificationAgenticBrowserRuntimeResult {
  readonly ledger_sha256: string;
  readonly step_count: number;
  readonly deterministic_recheck: {
    readonly required: true;
    readonly status: "pending" | "passed" | "failed";
    readonly evidence_sha256?: string | undefined;
    readonly trace_sha256?: string | undefined;
  };
  readonly can_pass_ui_lane: false;
}

export interface NormalizedVerificationAgenticBrowserResult {
  readonly evidence: VerificationAgenticBrowserEvidence;
  readonly ledger_bytes: Uint8Array;
  readonly result_bytes: Uint8Array;
}

export class VerificationAgenticBrowserContractError extends Error {
  readonly code = "INVALID_RECORD";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VerificationAgenticBrowserContractError";
  }
}

const requestInputSchema = z
  .object({
    snapshot: verificationRunSnapshotV2Schema,
    task_id: z.string().regex(IDENTIFIER_PATTERN),
    attempt_id: z.string().regex(IDENTIFIER_PATTERN),
  })
  .strict();

export function createVerificationAgenticBrowserRequest(input: {
  readonly snapshot: unknown;
  readonly task_id: string;
  readonly attempt_id: string;
}): VerificationAgenticBrowserRequest {
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) {
    throw contractError("agentic request input is invalid", parsed.error);
  }
  const { snapshot, task_id: taskId, attempt_id: attemptId } = parsed.data;
  if (!snapshot.ui_contract.enabled) {
    throw contractError("agentic request requires an enabled UI lane");
  }
  const task = snapshot.ui_contract.agentic_tasks.find(
    (candidate) => candidate.id === taskId,
  );
  if (task === undefined) {
    throw contractError("agentic request targets an undeclared task");
  }
  assertLocalOrigin(snapshot.server.api_origin);
  const startUrl = new URL(task.start_path, snapshot.server.api_origin).toString();
  assertLocalUrl(startUrl, snapshot.server.api_origin);

  const requestWithoutInputHash = {
    schema_version: 1 as const,
    contract_id: "verification_agentic_browser_v1" as const,
    run_id: snapshot.run_id,
    snapshot_id: snapshot.snapshot_id,
    task_id: task.id,
    attempt_id: attemptId,
    task_sha256: sha256CanonicalJson(task),
    adapter: {
      name: task.adapter,
      version: task.adapter_version,
      api_major: task.api_major,
    },
    browser_build: task.browser_build,
    model_identity: task.model_identity,
    origin: snapshot.server.api_origin,
    origin_allowlist: [snapshot.server.api_origin] as const,
    start_url: startUrl,
    execution: {
      cwd: snapshot.source.worktree_root,
      profile: "fresh_ephemeral" as const,
      persistent_profile: "disabled" as const,
      shell: false as const,
      remote_browser: "disabled" as const,
      cloud_browser: "disabled" as const,
      tunnel: "disabled" as const,
      proxy: "disabled" as const,
      separate_remote_model: "disabled" as const,
    },
    goal: task.goal,
    success_criteria: structuredClone(task.success_criteria),
    deterministic_postconditions_sha256: sha256CanonicalJson(
      task.success_criteria,
    ),
    allowed_actions: [...task.allowed_actions],
    max_steps: task.max_steps,
    timeout_ms: task.timeout_ms,
    system_prompt_template: task.system_prompt_template,
    prompt_sha256: task.prompt_sha256,
    checklist: [...task.checklist],
    checklist_sha256: task.checklist_sha256,
    limits: {
      findings: 50 as const,
      findings_bytes: 16_384 as const,
    },
    policy: {
      advisory_only: true as const,
      deterministic_recheck_required: true as const,
      generated_changes: "candidate_only" as const,
      apply_generated_changes: "disabled" as const,
      raw_reasoning: "disabled" as const,
      transcript: "disabled" as const,
      external_navigation: "disabled" as const,
    },
  };
  return deepFreeze({
    ...requestWithoutInputHash,
    input_sha256: sha256CanonicalJson(requestWithoutInputHash),
  });
}

export function normalizeVerificationAgenticBrowserResult(
  request: VerificationAgenticBrowserRequest,
  rawResult: unknown,
): NormalizedVerificationAgenticBrowserResult {
  const parsed = runtimeResultSchema(request).safeParse(rawResult);
  if (!parsed.success) {
    throw contractError("agentic browser result is invalid", parsed.error);
  }
  const result = parsed.data;
  assertResultIdentity(request, result);
  assertUtcTiming(request, result);
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  result.ledger.forEach((entry, sequence) => {
    if (entry.sequence !== sequence) {
      throw contractError("agentic action ledger is not contiguous and ordered");
    }
    if (!request.allowed_actions.includes(entry.action)) {
      throw contractError("agentic action ledger contains an undeclared action");
    }
    assertLocalUrl(entry.url, request.origin);
    const timestamp = Date.parse(entry.timestamp_utc);
    if (timestamp < previousTimestamp) {
      throw contractError("agentic ledger timestamps are not ordered");
    }
    previousTimestamp = timestamp;
  });

  const ledger = result.ledger.map((entry) => ({
    ...entry,
    url: redactUrl(entry.url),
    parameters: Object.fromEntries(
      Object.entries(entry.parameters).map(([key, value]) => [
        redactText(key),
        typeof value === "string" ? redactText(value) : value,
      ]),
    ),
    error_code:
      entry.error_code === null ? null : redactText(entry.error_code),
  }));
  const findings = result.findings.map(redactText);
  if (Buffer.byteLength(canonicalJson(findings), "utf8") > 16_384) {
    throw contractError("agentic findings exceed 16 KiB");
  }
  const ledgerBytes = Buffer.from(
    ledger.map((entry) => canonicalJson(entry)).join("\n") + "\n",
    "utf8",
  );
  if (ledgerBytes.byteLength > 64 * 1_024) {
    throw contractError("agentic action ledger exceeds 64 KiB");
  }
  const ledgerSha256 = sha256Bytes(ledgerBytes);
  const evidence: VerificationAgenticBrowserEvidence = {
    ...result,
    findings,
    ledger,
    ledger_sha256: ledgerSha256,
    step_count: ledger.length,
    deterministic_recheck: {
      required: true,
      status: "pending",
    },
    can_pass_ui_lane: false,
  };
  const resultBytes = Buffer.from(canonicalJson(evidence), "utf8");
  if (resultBytes.byteLength > 64 * 1_024) {
    throw contractError("agentic result metadata exceeds 64 KiB");
  }
  return deepFreeze({
    evidence,
    ledger_bytes: Uint8Array.from(ledgerBytes),
    result_bytes: Uint8Array.from(resultBytes),
  });
}

function runtimeResultSchema(request: VerificationAgenticBrowserRequest) {
  const boundedText = z.string().min(1).max(1_000).refine(
    (value) => !value.includes("\0"),
    "text contains NUL",
  );
  const artifactReference = z
    .object({
      artifact_id: z.string().regex(IDENTIFIER_PATTERN),
      relative_path: z
        .string()
        .min(1)
        .max(1_000)
        .refine(isSafeArtifactPath, "artifact path is unsafe"),
      sha256: z.string().regex(SHA256_PATTERN),
    })
    .strict();
  const parameterValue = z.union([
    z.string().max(1_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ]);
  return z
    .object({
      schema_version: z.literal(1),
      contract_id: z.literal("verification_agentic_browser_result_v1"),
      task_id: z.string().regex(IDENTIFIER_PATTERN),
      task_sha256: z.string().regex(SHA256_PATTERN),
      input_sha256: z.string().regex(SHA256_PATTERN),
      adapter: z
        .object({
          name: z.enum(["browser-use", "playwright-agent", "stagehand"]),
          version: z.string().min(1).max(128),
          api_major: z.string().min(1).max(128),
        })
        .strict(),
      browser_build: z.string().min(1).max(128),
      model_identity: z.string().min(1).max(128),
      origin: z.string().min(1).max(2_048),
      execution_status: z.enum(["completed", "blocked", "error"]),
      finding_status: z.enum(["finding", "no_finding", "unknown"]),
      self_verdict: z
        .enum(["achieved", "not_achieved", "unknown"])
        .optional(),
      judge_verdict: z
        .enum(["achieved", "not_achieved", "unknown"])
        .optional(),
      findings: z.array(boundedText).max(50),
      ledger: z
        .array(
          z
            .object({
              sequence: z.number().int().nonnegative().max(19),
              action: z.enum([
                "click",
                "navigate",
                "screenshot",
                "snapshot",
                "type",
              ]),
              url: z.string().min(1).max(2_048),
              parameters: z.record(z.string().max(128), parameterValue),
              result: z.enum(["completed", "blocked", "error"]),
              error_code: boundedText.nullable(),
              artifact_references: z.array(artifactReference).max(5),
              timestamp_utc: z.string().regex(UTC_PATTERN),
            })
            .strict()
            .superRefine((entry, context) => {
              if (Object.keys(entry.parameters).length > 20) {
                context.addIssue({
                  code: "custom",
                  path: ["parameters"],
                  message: "agentic parameters exceed 20 entries",
                });
              }
              if (
                Object.keys(entry.parameters).some((key) =>
                  /(?:chain[_ -]?of[_ -]?thought|reasoning|thought|transcript)/i.test(
                    key,
                  ),
                )
              ) {
                context.addIssue({
                  code: "custom",
                  path: ["parameters"],
                  message:
                    "agentic parameters cannot persist reasoning or transcripts",
                });
              }
            }),
        )
        .max(request.max_steps),
      candidates: z
        .array(
          z
            .object({
              kind: z.enum([
                "plan",
                "locator",
                "script",
                "test",
                "healer_patch",
                "baseline",
              ]),
              relative_path: z
                .string()
                .min(1)
                .max(1_000)
                .refine(isSafeArtifactPath, "candidate path is unsafe"),
              sha256: z.string().regex(SHA256_PATTERN),
              applied: z.literal(false),
            })
            .strict(),
        )
        .max(20),
      started_at_utc: z.string().regex(UTC_PATTERN),
      finished_at_utc: z.string().regex(UTC_PATTERN),
      elapsed_ms: z.number().int().nonnegative().max(request.timeout_ms),
    })
    .strict()
    .superRefine((result, context) => {
      if (result.execution_status === "completed" && result.ledger.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["ledger"],
          message: "completed agentic execution requires ledger evidence",
        });
      }
      if (
        (result.finding_status === "finding") !==
        (result.findings.length > 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["findings"],
          message: "agentic finding status does not match findings",
        });
      }
      const candidateRoot = `agentic/${request.task_id}/candidates/`;
      result.candidates.forEach((candidate, index) => {
        if (!candidate.relative_path.startsWith(candidateRoot)) {
          context.addIssue({
            code: "custom",
            path: ["candidates", index, "relative_path"],
            message: "agentic candidate is outside its task candidate root",
          });
        }
      });
    });
}

function assertResultIdentity(
  request: VerificationAgenticBrowserRequest,
  result: VerificationAgenticBrowserRuntimeResult,
): void {
  if (
    result.task_id !== request.task_id ||
    result.task_sha256 !== request.task_sha256 ||
    result.input_sha256 !== request.input_sha256 ||
    result.adapter.name !== request.adapter.name ||
    result.adapter.version !== request.adapter.version ||
    result.adapter.api_major !== request.adapter.api_major ||
    result.browser_build !== request.browser_build ||
    result.model_identity !== request.model_identity ||
    result.origin !== request.origin
  ) {
    throw contractError("agentic result identity differs from the request");
  }
}

function assertUtcTiming(
  request: VerificationAgenticBrowserRequest,
  result: VerificationAgenticBrowserRuntimeResult,
): void {
  const started = Date.parse(result.started_at_utc);
  const finished = Date.parse(result.finished_at_utc);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started ||
    finished - started !== result.elapsed_ms ||
    result.elapsed_ms > request.timeout_ms
  ) {
    throw contractError("agentic UTC timing is invalid or unbounded");
  }
  for (const entry of result.ledger) {
    const timestamp = Date.parse(entry.timestamp_utc);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < started ||
      timestamp > finished
    ) {
      throw contractError("agentic ledger timestamp is outside execution bounds");
    }
  }
}

function assertLocalOrigin(origin: string): void {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "dev" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    Number(parsed.port) < 10_001
  ) {
    throw contractError("agentic origin is not the recorded local dev origin");
  }
}

function assertLocalUrl(value: string, origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw contractError("agentic evidence contains an invalid URL", error);
  }
  if (
    parsed.origin !== origin ||
    parsed.protocol !== "http:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw contractError("agentic evidence contains an external URL");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:authorization|cookie|password|secret|token|api[_-]?key)/i.test(key)) {
      throw contractError("agentic evidence URL contains a credential query key");
    }
  }
}

function isSafeArtifactPath(value: string): boolean {
  return (
    !path.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.startsWith("../") &&
    !value.includes("\\") &&
    [
      ".json",
      ".jsonl",
      ".png",
      ".txt",
      ".playwright-trace.zip",
    ].some((suffix) => value.endsWith(suffix))
  );
}

function redactUrl(value: string): string {
  const url = new URL(value);
  const keys = [...url.searchParams.keys()];
  url.search = "";
  url.hash = "";
  for (const key of keys) {
    url.searchParams.append(redactText(key), "<redacted>");
  }
  return redactText(url.toString());
}

function redactText(value: string): string {
  return value
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(OPAQUE_SECRET_PATTERN, "[REDACTED]");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contractError(
  message: string,
  cause?: unknown,
): VerificationAgenticBrowserContractError {
  return new VerificationAgenticBrowserContractError(message, { cause });
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value) &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
