import type { RunRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import type {
  VerificationActionKind,
  VerificationErrorCode,
  VerificationLaneDecisionInput,
  VerificationLinkedRecord,
  VerificationOutcome,
  VerificationRunSnapshot,
  VerificationStage,
} from "./verification-contract.js";
import {
  sha256CanonicalJson,
  verificationErrorDisposition,
} from "./verification-contract.js";
import type {
  CleanupVerificationArtifactsResult,
  RecordVerificationActionErrorInput,
  RecordVerificationActionErrorResult,
  RecordVerificationAttemptInput,
  RecordVerificationSnapshotInput,
  RunStore,
  VerificationStateTransitionResult,
  WriteVerificationArtifactInput,
  WriteVerificationArtifactResult,
} from "./state-store.js";

const ADAPTER_RECORD_TYPES = new Set<VerificationLinkedRecord["record_type"]>([
  "capability",
  "request",
  "browser",
  "agentic_browser",
  "screenshot",
  "review",
  "comparison",
]);

const SECRET_DIAGNOSTIC_PATTERN =
  /\b(?:authorization|bearer|cookie|password|secret|token|api[_-]?key)\b/i;
const REDACTED_DIAGNOSTIC =
  "verification action failed; diagnostic was redacted";
const MAX_DIAGNOSTIC_CHARACTERS = 1_000;

export type VerificationLifecycleAdvanceState = VerificationStage;
export type VerificationActionErrorCode = VerificationErrorCode;
export type ConfigureVerificationInput = RecordVerificationSnapshotInput;
export type VerificationStateAdvanceResult = VerificationStateTransitionResult;
export type VerificationActionAttemptInput = RecordVerificationAttemptInput;
export type VerificationActionErrorInput = RecordVerificationActionErrorInput;
export type VerificationActionErrorResult =
  RecordVerificationActionErrorResult;
export type VerificationCoordinatorStore = Pick<
  RunStore,
  | "claimVerificationCoordinatorAuthority"
  | "getRun"
  | "recordVerificationSnapshot"
  | "advanceVerificationState"
  | "appendVerificationRecord"
  | "recordVerificationAttempt"
  | "completeVerificationAttempt"
  | "recordVerificationActionError"
  | "finalizeVerification"
  | "writeVerificationArtifact"
  | "cleanupVerificationArtifacts"
>;

export type DeepReadonly<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? T
  : T extends readonly (infer Element)[]
    ? readonly DeepReadonly<Element>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface VerificationAdapterContext<TInput> {
  readonly snapshot: DeepReadonly<VerificationRunSnapshot>;
  readonly input: DeepReadonly<TInput>;
  readonly signal: AbortSignal;
  readonly submit: (record: VerificationLinkedRecord) => Promise<string>;
}

export type VerificationAdapterAttemptResult<TValue> =
  | {
      ok: true;
      value: TValue;
    }
  | {
      ok: false;
      code: VerificationActionErrorCode;
      message: string;
    };

export type VerificationActionResult<TValue> =
  | {
      ok: true;
      value: TValue;
      evidence_record_ids: string[];
    }
  | {
      ok: false;
      code: VerificationActionErrorCode;
      message: string;
      evidence_record_ids: string[];
      outcome: VerificationOutcome;
      integrity_failure: boolean;
    };

export interface RunVerificationActionInput<TInput, TValue> {
  action_id: string;
  kind: VerificationActionKind;
  lane: "backend" | "ui" | null;
  check_id: string | null;
  input: TInput;
  adapter: (
    context: VerificationAdapterContext<TInput>,
  ) => Promise<VerificationAdapterAttemptResult<TValue>>;
}

export class VerificationCoordinator {
  private submissionQueue: Promise<void> = Promise.resolve();
  readonly #authority: symbol;

  constructor(private readonly store: VerificationCoordinatorStore) {
    this.#authority = store.claimVerificationCoordinatorAuthority();
  }

  configure(
    runId: string,
    input: ConfigureVerificationInput,
  ): Promise<RunRecord> {
    return this.store.recordVerificationSnapshot(
      runId,
      input,
      this.#authority,
    );
  }

  advance(
    runId: string,
    next: VerificationLifecycleAdvanceState,
  ): Promise<VerificationStateAdvanceResult> {
    return this.store.advanceVerificationState(
      runId,
      next,
      this.#authority,
    );
  }

  async submitAdapterRecord(
    runId: string,
    input: VerificationLinkedRecord,
  ): Promise<string> {
    const operation = this.submissionQueue.then(() =>
      this.persistAdapterRecord(runId, input),
    );
    this.submissionQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persistAdapterRecord(
    runId: string,
    input: VerificationLinkedRecord,
  ): Promise<string> {
    if (!ADAPTER_RECORD_TYPES.has(input.record_type)) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "adapter cannot persist coordinator-owned verification state",
      );
    }
    if (input.schema_version !== 2) {
      throw new ArkTeamError(
        "CONTRACT_VERSION_MISMATCH",
        "contract-v1 adapter evidence is read-only",
      );
    }
    const current = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(current);
    const expectedStage = adapterRecordStage(input.record_type);
    if (current.verification_state?.current_state !== expectedStage) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        `adapter ${input.record_type} evidence requires ${expectedStage} state`,
      );
    }
    const laneRequired =
      input.lane === null
        ? null
        : input.lane === "backend"
          ? snapshot.backend_contract.enabled
            ? snapshot.backend_contract.required
            : null
          : snapshot.ui_contract.enabled
            ? snapshot.ui_contract.required
            : null;
    if (input.lane !== null && laneRequired === null) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "adapter evidence targets a disabled verification lane",
      );
    }
    const checkRequired = resolveCheckRequired(
      snapshot,
      input.lane,
      input.check_id,
      input,
    );
    const payload = structuredClone(input.payload);
    const record: VerificationLinkedRecord = {
      ...structuredClone(input),
      schema_version: 2,
      contract_id: "verification_contract_v2",
      run_id: current.run_id,
      case_id: snapshot.case_id,
      snapshot_id: snapshot.snapshot_id,
      stage: expectedStage,
      source_fingerprint: snapshot.source_fingerprint,
      package_fingerprint: snapshot.package.package_fingerprint,
      lane_required: laneRequired,
      check_required: checkRequired,
      previous_record_sha256: sha256CanonicalJson(
        current.verification_records.at(-1)!,
      ),
      payload_sha256: sha256CanonicalJson(payload),
      payload,
    } as VerificationLinkedRecord;
    const run = await this.store.appendVerificationRecord(
      runId,
      record,
      this.#authority,
    );
    const persisted = run.verification_records.at(-1);
    if (persisted?.record_id !== record.record_id) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "adapter evidence was not appended as the latest verification record",
      );
    }
    return persisted.record_id;
  }

  finalize(
    runId: string,
    lanes: readonly VerificationLaneDecisionInput[],
  ): Promise<RunRecord> {
    return this.store.finalizeVerification(
      runId,
      {
        lanes: structuredClone([...lanes]),
      },
      this.#authority,
    );
  }

  writeArtifact(
    runId: string,
    input: WriteVerificationArtifactInput,
  ): Promise<WriteVerificationArtifactResult> {
    return this.store.writeVerificationArtifact(
      runId,
      input,
      this.#authority,
    );
  }

  cleanupArtifacts(
    runId: string,
  ): Promise<CleanupVerificationArtifactsResult> {
    return this.store.cleanupVerificationArtifacts(
      runId,
      this.#authority,
    );
  }

  async runAction<TInput, TValue>(
    runId: string,
    options: RunVerificationActionInput<TInput, TValue>,
  ): Promise<VerificationActionResult<TValue>> {
    const initial = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(initial);
    const expectedStage = actionStage(options.kind);
    if (initial.verification_state?.current_state !== expectedStage) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        `${options.kind} action requires ${expectedStage} state`,
      );
    }
    let immutableSnapshot: DeepReadonly<VerificationRunSnapshot>;
    let immutableInput: DeepReadonly<TInput>;
    let snapshotSha256: string;
    let inputSha256: string;
    try {
      immutableSnapshot = deepFreeze(structuredClone(snapshot));
      immutableInput = deepFreeze(structuredClone(options.input));
      snapshotSha256 = sha256CanonicalJson(immutableSnapshot);
      inputSha256 = sha256CanonicalJson(immutableInput);
    } catch {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "verification action input is not canonical JSON",
      );
    }

    const attemptLimit = actionAttemptLimit(snapshot, options.kind);
    const timeoutMs = actionTimeoutMs(snapshot, options);
    let lastFailure: VerificationActionResult<never> | null = null;

    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      let reservation;
      try {
        reservation = await this.store.recordVerificationAttempt(runId, {
          action_id: options.action_id,
          kind: options.kind,
          lane: options.lane,
          check_id: options.check_id,
          input_sha256: inputSha256,
          evidence_record_ids: [],
        }, this.#authority);
      } catch (error) {
        const failure = normalizeActionFailure(error);
        const disposition = verificationErrorDisposition(
          failure.ok ? "INVALID_RECORD" : failure.code,
        );
        return {
          ok: false,
          code: failure.ok ? "INVALID_RECORD" : failure.code,
          message: sanitizeDiagnostic(
            failure.ok
              ? "verification attempt reservation failed"
              : failure.message,
          ),
          evidence_record_ids: [],
          ...disposition,
        };
      }
      if (!reservation.reserved) {
        const errorRecord = reservation.error_record;
        if (errorRecord?.payload.kind !== "error") {
          throw new ArkTeamError(
            "CORRUPT_STATE",
            "rejected verification attempt has no linked error",
          );
        }
        const disposition = verificationErrorDisposition(
          errorRecord.payload.code,
        );
        return {
          ok: false,
          code: errorRecord.payload.code,
          message: errorRecord.payload.message,
          evidence_record_ids: [errorRecord.record_id],
          ...disposition,
        };
      }

      const attemptEvidenceIds: string[] = [];
      const controller = new AbortController();
      let active = true;
      const context: VerificationAdapterContext<TInput> = Object.freeze({
        snapshot: immutableSnapshot,
        input: immutableInput,
        signal: controller.signal,
        submit: async (record: VerificationLinkedRecord) => {
          if (!active || controller.signal.aborted) {
            throw new ArkTeamError(
              "INVALID_RECORD",
              "adapter submitted evidence outside its active attempt",
            );
          }
          assertAdapterRecordMatchesAction(
            options.kind,
            options.lane,
            options.check_id,
            record,
          );
          const recordId = await this.submitAdapterRecord(runId, record);
          attemptEvidenceIds.push(recordId);
          return recordId;
        },
      });

      let attemptResult: VerificationAdapterAttemptResult<TValue>;
      try {
        attemptResult = await raceAction(
          () => options.adapter(context),
          timeoutMs,
          controller,
        );
      } catch (error) {
        attemptResult = normalizeActionFailure(error);
      } finally {
        active = false;
        controller.abort();
      }

      const drifted = await this.hasImmutableInputDrift(
        runId,
        immutableSnapshot,
        immutableInput,
        snapshotSha256,
        inputSha256,
      );
      if (drifted) {
        attemptResult = {
          ok: false,
          code: "INVALID_RECORD",
          message: "verification action changed immutable snapshot or input",
        };
      }

      const completion = await this.store.completeVerificationAttempt(runId, {
        action_id: options.action_id,
        evidence_record_ids: [...attemptEvidenceIds],
        error_code: attemptResult.ok ? null : attemptResult.code,
        message: attemptResult.ok
          ? null
          : sanitizeDiagnostic(attemptResult.message),
      }, this.#authority);

      if (attemptResult.ok && completion.error_code === null) {
        return {
          ok: true,
          value: attemptResult.value,
          evidence_record_ids: [...attemptEvidenceIds],
        };
      }

      const failureCode =
        completion.error_code ??
        (attemptResult.ok ? "INVALID_RECORD" : attemptResult.code);
      const disposition = verificationErrorDisposition(failureCode);
      lastFailure = {
        ok: false,
        code: failureCode,
        message: sanitizeDiagnostic(
          attemptResult.ok
            ? `verification action failed closed with ${failureCode}`
            : attemptResult.message,
        ),
        evidence_record_ids: [...attemptEvidenceIds],
        ...disposition,
      };
      const persistedAttempt =
        completion.run.verification_state?.attempts.find(
          (candidate) => candidate.action_id === options.action_id,
        );
      if (
        failureCode === "INVALID_RECORD" ||
        disposition.integrity_failure ||
        persistedAttempt?.status === "exhausted"
      ) {
        break;
      }
    }

    const failure = lastFailure ?? {
      ok: false as const,
      code: "INVALID_RECORD" as const,
      message: "verification action produced no result",
      evidence_record_ids: [],
      outcome: "error" as const,
      integrity_failure: false,
    };
    return this.persistTerminalFailure(runId, options.action_id, failure);
  }

  private async hasImmutableInputDrift<TInput>(
    runId: string,
    snapshot: DeepReadonly<VerificationRunSnapshot>,
    input: DeepReadonly<TInput>,
    expectedSnapshotSha256: string,
    expectedInputSha256: string,
  ): Promise<boolean> {
    try {
      const current = await this.store.getRun(runId);
      return (
        current.verification_snapshot === null ||
        sha256CanonicalJson(current.verification_snapshot) !==
          expectedSnapshotSha256 ||
        sha256CanonicalJson(snapshot) !== expectedSnapshotSha256 ||
        sha256CanonicalJson(input) !== expectedInputSha256
      );
    } catch {
      return true;
    }
  }

  private async persistTerminalFailure(
    runId: string,
    actionId: string,
    failure: VerificationActionResult<never>,
  ): Promise<VerificationActionResult<never>> {
    if (failure.ok) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "successful action cannot be persisted as an error",
      );
    }
    const message = sanitizeDiagnostic(failure.message);
    const persisted = await this.store.recordVerificationActionError(runId, {
      action_id: actionId,
      code: failure.code,
      message,
    }, this.#authority);
    const decisiveEvidenceRecordIds =
      persisted.run.verification_state?.attempts.find(
        (attempt) => attempt.action_id === actionId,
      )?.decisive_evidence_record_ids ?? failure.evidence_record_ids;
    const disposition = verificationErrorDisposition(failure.code);
    return {
      ok: false,
      code: failure.code,
      message,
      evidence_record_ids: [
        ...new Set([
          ...decisiveEvidenceRecordIds,
          persisted.record.record_id,
        ]),
      ],
      ...disposition,
    };
  }
}

function adapterRecordStage(
  recordType: VerificationLinkedRecord["record_type"],
): "capabilities" | "executing" | "collecting" {
  if (recordType === "capability") {
    return "capabilities";
  }
  if (
    recordType === "request" ||
    recordType === "browser" ||
    recordType === "agentic_browser"
  ) {
    return "executing";
  }
  if (
    recordType === "screenshot" ||
    recordType === "review" ||
    recordType === "comparison"
  ) {
    return "collecting";
  }
  throw new ArkTeamError(
    "INVALID_RECORD",
    "record type is not adapter-owned",
  );
}

function actionStage(
  kind: VerificationActionKind,
): "capabilities" | "executing" | "collecting" {
  if (kind === "readiness") {
    return "capabilities";
  }
  if (
    kind === "api" ||
    kind === "browser" ||
    kind === "agentic_browser"
  ) {
    return "executing";
  }
  if (
    kind === "screenshot" ||
    kind === "semantic_review" ||
    kind === "comparison" ||
    kind === "artifact_write"
  ) {
    return "collecting";
  }
  throw new ArkTeamError(
    "INVALID_TRANSITION",
    "destructive cleanup uses the post-terminal cleanup coordinator",
  );
}

function assertAdapterRecordMatchesAction(
  kind: VerificationActionKind,
  lane: "backend" | "ui" | null,
  checkId: string | null,
  record: VerificationLinkedRecord,
): void {
  if (record.schema_version !== 2) {
    throw new ArkTeamError(
      "CONTRACT_VERSION_MISMATCH",
      "contract-v1 adapter evidence is read-only",
    );
  }
  if (kind === "readiness") {
    if (record.record_type === "capability" && record.check_id === null) {
      return;
    }
    throw new ArkTeamError(
      "INVALID_RECORD",
      "readiness actions may submit only lane capability evidence",
    );
  }
  const expectedRecordType =
    kind === "api"
      ? "request"
      : kind === "browser"
        ? "browser"
        : kind === "agentic_browser"
          ? "agentic_browser"
          : kind === "screenshot"
            ? "screenshot"
            : kind === "semantic_review"
              ? "review"
              : kind === "comparison"
                ? "comparison"
                : null;
  if (
    expectedRecordType === null ||
    record.record_type !== expectedRecordType ||
    record.lane !== lane ||
    record.check_id !== checkId
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "adapter evidence does not match its reserved action kind and scope",
    );
  }
}

function resolveCheckRequired(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  lane: "backend" | "ui" | null,
  checkId: string | null,
  record: VerificationLinkedRecord,
): boolean {
  if (checkId === null) {
    if (record.payload.kind === "capability") {
      const requiredCapabilities =
        lane === "backend" && snapshot.backend_contract.enabled
          ? snapshot.backend_contract.required_capabilities
          : lane === "ui" && snapshot.ui_contract.enabled
            ? snapshot.ui_contract.required_capabilities
            : [];
      const optionalCapabilities =
        lane === "ui" && snapshot.ui_contract.enabled
          ? snapshot.ui_contract.optional_capabilities
          : [];
      if (
        !requiredCapabilities.includes(record.payload.capability) &&
        !optionalCapabilities.includes(record.payload.capability)
      ) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "capability evidence is not declared by the enabled lane",
        );
      }
      return requiredCapabilities.includes(record.payload.capability);
    }
    return false;
  }
  const required =
    lane === "backend" && snapshot.backend_contract.enabled
      ? snapshot.backend_contract.api_probes.find(
          (probe) => probe.id === checkId,
        )?.required
      : lane === "ui" && snapshot.ui_contract.enabled
        ? (snapshot.ui_contract.browser_cases.find(
            (browserCase) => browserCase.id === checkId,
          )?.required ??
          snapshot.ui_contract.agentic_tasks.find(
            (task) => task.id === checkId,
          )?.required)
        : undefined;
  if (required === undefined) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "adapter evidence targets an unknown snapshotted check",
    );
  }
  return required;
}

function requireV2Snapshot(run: RunRecord): VerificationRunSnapshot & {
  schema_version: 2;
} {
  const snapshot = run.verification_snapshot;
  if (snapshot === null) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "verification action requires an immutable run snapshot",
    );
  }
  if (snapshot.schema_version !== 2) {
    throw new ArkTeamError(
      "CONTRACT_VERSION_MISMATCH",
      "contract-v1 verification runs are read-only",
    );
  }
  return snapshot;
}

function actionAttemptLimit(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  kind: VerificationActionKind,
): number {
  return snapshot.attempt_policy[kind];
}

function actionTimeoutMs<TInput, TValue>(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  options: RunVerificationActionInput<TInput, TValue>,
): number {
  switch (options.kind) {
    case "readiness":
      return snapshot.resolved_config.server_readiness_timeout_ms;
    case "api":
      return snapshot.timeouts_ms.api_ms;
    case "browser":
      return snapshot.timeouts_ms.browser_ms;
    case "agentic_browser": {
      const task = snapshot.ui_contract.enabled
        ? snapshot.ui_contract.agentic_tasks.find(
            (candidate) => candidate.id === options.check_id,
          )
        : undefined;
      return task?.timeout_ms ?? snapshot.timeouts_ms.case_ms;
    }
    case "screenshot":
    case "semantic_review":
    case "comparison":
    case "artifact_write":
    case "cleanup":
      return snapshot.timeouts_ms.case_ms;
  }
}

async function raceAction<T>(
  execute: () => Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VerificationTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(execute), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class VerificationTimeoutError extends Error {
  constructor() {
    super("verification action timed out");
    this.name = "VerificationTimeoutError";
  }
}

function normalizeActionFailure(
  error: unknown,
): VerificationAdapterAttemptResult<never> {
  if (error instanceof VerificationTimeoutError) {
    return {
      ok: false,
      code: "TIMEOUT",
      message: error.message,
    };
  }
  if (error instanceof TypeError) {
    return {
      ok: false,
      code: "INVALID_RECORD",
      message: "verification action attempted to mutate immutable input",
    };
  }
  if (error instanceof ArkTeamError && isVerificationErrorCode(error.code)) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
    };
  }
  if (
    error instanceof ArkTeamError &&
    error.code === "INVALID_TRANSITION"
  ) {
    return {
      ok: false,
      code: "INVALID_RECORD",
      message: error.message,
    };
  }
  return {
    ok: false,
    code: "ENVIRONMENT_UNAVAILABLE",
    message:
      error instanceof Error
        ? error.message
        : "verification action failed without a diagnostic",
  };
}

function isVerificationErrorCode(
  code: string,
): code is VerificationActionErrorCode {
  return new Set<VerificationActionErrorCode>([
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
  ]).has(code as VerificationActionErrorCode);
}

function sanitizeDiagnostic(message: string): string {
  const normalized = message.trim() || "verification action failed";
  if (SECRET_DIAGNOSTIC_PATTERN.test(normalized)) {
    return REDACTED_DIAGNOSTIC;
  }
  return normalized.slice(0, MAX_DIAGNOSTIC_CHARACTERS);
}


function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
