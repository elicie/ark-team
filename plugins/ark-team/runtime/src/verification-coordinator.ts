import { createServer } from "node:net";
import path from "node:path";

import type { RunRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import type {
  VerificationActionKind,
  VerificationCapability,
  VerificationErrorCode,
  VerificationLaneDecisionInput,
  VerificationLinkedRecord,
  VerificationOutcome,
  VerificationRunSnapshot,
  VerificationStage,
} from "./verification-contract.js";
import {
  sha256CanonicalJson,
  verificationEvidenceDisposition,
  verificationErrorDisposition,
} from "./verification-contract.js";
import type {
  CleanupVerificationArtifactsResult,
  RecordVerificationActionErrorInput,
  RecordVerificationActionErrorResult,
  RecordVerificationAttemptInput,
  RecordVerificationSnapshotInput,
  RunStore,
  TerminateVerificationForApprovalResult,
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
  /\b(?:authorization|bearer|cookie|password|secret|token|api[_-]?key)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{48,}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const REDACTED_DIAGNOSTIC =
  "verification action failed; diagnostic was redacted";
const MAX_DIAGNOSTIC_CHARACTERS = 1_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_COMMANDS = new Set([
  "ansible",
  "bash",
  "cmd",
  "cmd.exe",
  "docker",
  "docker-compose",
  "fish",
  "helm",
  "kubectl",
  "podman",
  "powershell",
  "pwsh",
  "scp",
  "sh",
  "ssh",
  "terraform",
  "tofu",
  "zsh",
]);
const APPROVAL_REQUIRED_OPERATIONS = [
  "arbitrary_code",
  "auto_heal",
  "baseline_update",
  "broad_tool",
  "cloud_browser",
  "credential",
  "deployment",
  "destructive",
  "docker",
  "download",
  "extension",
  "external_navigation",
  "file_access",
  "infrastructure",
  "permission",
  "persistent_profile",
  "product_file_change",
  "proxy",
  "raw_reasoning",
  "remote",
  "remote_browser",
  "remote_model",
  "transcript",
  "tunnel",
  "upload",
] as const;

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
  | "assertCurrentVerification"
  | "recordVerificationSnapshot"
  | "advanceVerificationState"
  | "appendVerificationRecord"
  | "recordVerificationAttempt"
  | "completeVerificationAttempt"
  | "recordVerificationActionError"
  | "terminateVerificationForApproval"
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
      capability?: VerificationCapability;
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

export type VerificationPortAvailabilityProbe = (
  port: number,
  bind: "0.0.0.0",
) => Promise<boolean>;

export interface ConfigureLocalVerificationInput {
  package_fingerprint: string;
}

export interface VerificationCapabilityProbeResult {
  available: boolean;
  version: string | null;
  diagnostic: string;
  adapter: {
    name: string;
    version: string;
  };
}

export interface VerificationServerStartRequest {
  argv: readonly string[];
  cwd: string;
  bind: "0.0.0.0";
  host: "dev";
  port: number;
  origin: string;
  readiness: {
    url: string;
    expected_status: number;
    timeout_ms: 30_000;
    redirect: "manual";
    max_redirects: 0;
  };
  registration: VerificationServerRegistration;
}

export interface VerificationServerRegistration {
  registration_id: string;
  framework: "nextjs" | "other";
  allowed_dev_origins: readonly string[];
}

export interface RunVerificationReadinessInput {
  action_id: string;
  server: Omit<VerificationServerRegistration, "registration_id">;
}

export interface VerificationCoordinatorRuntime {
  port_available?: VerificationPortAvailabilityProbe;
  capability_adapters: Readonly<
    Record<
      VerificationCapability,
      {
        name: string;
        version: string;
      }
    >
  >;
  capability_probe: (
    capability: VerificationCapability,
    signal: AbortSignal,
  ) => Promise<VerificationCapabilityProbeResult>;
  start_server: (
    request: DeepReadonly<VerificationServerStartRequest>,
    signal: AbortSignal,
  ) => Promise<void>;
  probe_http: (
    request: DeepReadonly<VerificationServerStartRequest>,
    signal: AbortSignal,
  ) => Promise<{ status: number }>;
  execute_local: (
    request: DeepReadonly<VerificationLocalEffectRequest>,
  ) => Promise<unknown>;
}

export interface VerificationReadinessValue {
  server_ready: boolean;
  unavailable: Array<{
    lane: "backend" | "ui";
    capability: VerificationCapability;
    outcome: "unavailable" | "skipped";
  }>;
}

export type VerificationApprovalRequiredOperation =
  (typeof APPROVAL_REQUIRED_OPERATIONS)[number];

export type VerificationLocalEffectRequest =
  | {
      kind: "command";
      argv: readonly string[];
      cwd: string;
    }
  | {
      kind: "network";
      url: string;
    }
  | {
      kind: "approval_required";
      operation: VerificationApprovalRequiredOperation;
    }
  | {
      kind: "agentic_session";
      task_id: string;
      profile: "fresh_ephemeral";
      origin_allowlist: readonly string[];
      allowed_actions: readonly string[];
      model_identity: string;
    };

export type VerificationLocalEffectResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "APPROVAL_REQUIRED";
      message: string;
      approval_id: string;
      request_sha256: string;
    };

export class VerificationCoordinator {
  private submissionQueue: Promise<void> = Promise.resolve();
  private runtime: Readonly<VerificationCoordinatorRuntime> | null = null;
  private readonly activeControllers = new Map<
    string,
    Map<string, AbortController>
  >();
  readonly #authority: symbol;

  constructor(private readonly store: VerificationCoordinatorStore) {
    this.#authority = store.claimVerificationCoordinatorAuthority();
  }

  registerLocalRuntime(runtime: VerificationCoordinatorRuntime): void {
    if (this.runtime !== null) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "local verification runtime is already registered",
      );
    }
    this.runtime = Object.freeze({ ...runtime });
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

  async configureLocal(
    runId: string,
    input: ConfigureLocalVerificationInput,
  ): Promise<RunRecord> {
    const run = await this.store.getRun(runId);
    if (
      run.verification_state !== null &&
      run.verification_state.terminal_outcome !== null
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "terminal local verification runs cannot be configured",
      );
    }
    const config = run.project_config.verification.coordinator;
    if (
      config === null ||
      config.schema_version !== 2 ||
      !config.enabled
    ) {
      throw new ArkTeamError(
        "CONFIG_INVALID",
        "local verification requires an enabled contract-v2 configuration",
      );
    }
    const serverPort = await selectVerificationServerPort(
      this.runtime?.port_available ?? defaultVerificationPortAvailability,
      config.server_port_floor,
      config.server_bind,
    );
    return this.configure(runId, {
      package_fingerprint: input.package_fingerprint,
      server_port: serverPort,
    });
  }

  async runReadiness(
    runId: string,
    input: RunVerificationReadinessInput,
  ): Promise<VerificationActionResult<VerificationReadinessValue>> {
    const runtime = this.requireLocalRuntime();
    const parsedInput = parseReadinessInput(input);
    let attemptNumber = 0;
    let serverStarted = false;
    return this.runAction(runId, {
      action_id: parsedInput.action_id,
      kind: "readiness",
      lane: null,
      check_id: null,
      input: {
        contract: "local-readiness-v2",
        server: parsedInput.server,
      },
      adapter: async (context) => {
        attemptNumber += 1;
        const snapshot = context.snapshot;
        if (snapshot.schema_version !== 2) {
          return {
            ok: false,
            code: "CONTRACT_VERSION_MISMATCH",
            message: "local readiness requires a contract-v2 snapshot",
          };
        }
        const mutableSnapshot = structuredClone(
          snapshot,
        ) as VerificationRunSnapshot & { schema_version: 2 };
        const registration = verificationServerRegistration(
          mutableSnapshot,
          parsedInput,
        );
        assertRegisteredVerificationServer(registration);
        const demands = verificationCapabilityDemands(mutableSnapshot);
        const capabilities = new Map<
          VerificationCapability,
          VerificationCapabilityProbeResult
        >();
        for (const capability of [
          ...new Set(demands.map((demand) => demand.capability)),
        ].sort()) {
          const registeredAdapter = runtime.capability_adapters[capability];
          try {
            const discovered = validateCapabilityProbeResult(
              await runtime.capability_probe(capability, context.signal),
              registeredAdapter,
            );
            capabilities.set(capability, {
              ...discovered,
              diagnostic: sanitizeDiagnostic(discovered.diagnostic),
            });
          } catch (error) {
            capabilities.set(capability, {
              available: false,
              version: null,
              diagnostic: sanitizeDiagnostic(
                error instanceof Error
                  ? error.message
                  : "capability probe failed",
              ),
              adapter: registeredAdapter,
            });
          }
        }

        const server = capabilities.get("server");
        let serverReady = false;
        if (server?.available) {
          const request = verificationServerStartRequest(
            mutableSnapshot,
            registration,
          );
          try {
            if (!serverStarted) {
              await runtime.start_server(
                deepFreeze(structuredClone(request)),
                context.signal,
              );
              serverStarted = true;
            }
            const response = validateReadinessResponse(
              await runtime.probe_http(
                deepFreeze(structuredClone(request)),
                context.signal,
              ),
            );
            serverReady =
              response.status === request.readiness.expected_status;
            const diagnostic = serverReady
              ? `registered ${registration.registration_id}; ${registration.framework}; HTTP ${response.status}; redirects disabled; timeout 30000ms`
              : `registered ${registration.registration_id}; HTTP ${response.status}; readiness failed`;
            capabilities.set("server", {
              ...server,
              available: serverReady,
              version: serverReady ? server.version : null,
              diagnostic: sanitizeDiagnostic(diagnostic),
            });
          } catch (error) {
            capabilities.set("server", {
              ...server,
              available: false,
              version: null,
              diagnostic: sanitizeDiagnostic(
                error instanceof Error
                  ? error.message
                  : "local server readiness failed",
              ),
            });
          }
        }

        const unavailable: VerificationReadinessValue["unavailable"] = [];
        for (const demand of demands) {
          const capability = capabilities.get(demand.capability);
          if (capability === undefined) {
            throw new ArkTeamError(
              "INVALID_RECORD",
              `capability probe omitted ${demand.capability}`,
            );
          }
          const outcome =
            demand.lane_required && demand.capability_required
              ? "unavailable"
              : "skipped";
          if (!capability.available) {
            unavailable.push({
              lane: demand.lane,
              capability: demand.capability,
              outcome,
            });
          }
          const payload = {
            kind: "capability" as const,
            capability: demand.capability,
            available: capability.available,
            version: capability.version,
            diagnostic: capability.diagnostic,
          };
          await context.submit({
            schema_version: 2,
            contract_id: "verification_contract_v2",
            record_id: `capability-${sha256CanonicalJson({
              action_id: parsedInput.action_id,
              attempt: attemptNumber,
              lane: demand.lane,
              capability: demand.capability,
            }).slice(0, 24)}`,
            record_type: "capability",
            run_id: snapshot.run_id,
            case_id: snapshot.case_id,
            check_id: null,
            snapshot_id: snapshot.snapshot_id,
            lane: demand.lane,
            stage: "capabilities",
            timestamp_utc: new Date().toISOString(),
            source_fingerprint: snapshot.source_fingerprint,
            package_fingerprint: snapshot.package.package_fingerprint,
            lane_required: demand.lane_required,
            check_required: demand.capability_required,
            previous_record_sha256: "0".repeat(64),
            payload_sha256: sha256CanonicalJson(payload),
            payload,
            adapter: capability.adapter,
            model: null,
            artifact_references: [],
          });
        }
        if (unavailable.length > 0 && attemptNumber < 2) {
          const serverUnavailable = unavailable.some(
            (candidate) => candidate.capability === "server",
          );
          return {
            ok: false,
            code: serverUnavailable
              ? ("SERVER_NOT_READY" as const)
              : ("CAPABILITY_UNAVAILABLE" as const),
            ...(serverUnavailable
              ? {}
              : { capability: unavailable[0]!.capability }),
            message: "local capability discovery will retry once",
          };
        }
        return {
          ok: true,
          value: { server_ready: serverReady, unavailable },
        };
      },
    });
  }

  async runGuardedLocalEffect<T>(
    runId: string,
    request: unknown,
  ): Promise<VerificationLocalEffectResult<T>> {
    const current = await this.store.assertCurrentVerification(
      runId,
      this.#authority,
    );
    const snapshot = requireV2Snapshot(current);
    if (
      current.verification_state === null ||
      current.verification_state.terminal_outcome !== null
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "terminal local verification runs cannot resume",
      );
    }
    let requestSha256: string;
    try {
      requestSha256 = sha256CanonicalJson(structuredClone(request));
    } catch {
      requestSha256 = sha256CanonicalJson({ invalid_request: true });
    }
    const parsed = parseLocalEffectRequest(request);
    const immutableRequest =
      parsed.request === null
        ? null
        : deepFreeze(structuredClone(parsed.request));
    const denial =
      parsed.denial ??
      (immutableRequest === null
        ? "invalid local effect request"
        : localEffectDenial(snapshot, immutableRequest));
    if (denial === null && immutableRequest !== null) {
      const value = await this.requireLocalRuntime().execute_local(
        immutableRequest,
      );
      return { ok: true, value: value as T };
    }
    this.abortActiveActions(runId);
    const terminated = await this.store.terminateVerificationForApproval(
      runId,
      {
        request_sha256: requestSha256,
        message: `local verification request requires separate approval: ${denial}`,
      },
      this.#authority,
    );
    return approvalTerminationResult(terminated, requestSha256);
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
    const unavailableCapabilities = unavailableCapabilitiesForAction(
      initial,
      snapshot,
      options.kind,
      options.lane,
    );
    const actionAdapter =
      unavailableCapabilities.length === 0
        ? options.adapter
        : async (): Promise<VerificationAdapterAttemptResult<TValue>> => ({
            ok: false,
            code: "CAPABILITY_UNAVAILABLE",
            capability: unavailableCapabilities[0]!,
            message: `dependent capability unavailable: ${unavailableCapabilities.join(", ")}`,
          });
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
      this.trackActiveAction(runId, options.action_id, controller);
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
          () => actionAdapter(context),
          timeoutMs,
          controller,
        );
      } catch (error) {
        attemptResult = normalizeActionFailure(error);
      } finally {
        active = false;
        controller.abort();
        this.untrackActiveAction(runId, options.action_id, controller);
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
      if (
        !attemptResult.ok &&
        options.kind !== "readiness" &&
        (attemptResult.code === "CAPABILITY_UNAVAILABLE" ||
          attemptResult.code === "SERVER_NOT_READY")
      ) {
        const reportedCapability =
          attemptResult.code === "SERVER_NOT_READY"
            ? "server"
            : attemptResult.capability;
        if (
          reportedCapability === undefined ||
          !requiredCapabilitiesForAction(snapshot, options.kind).includes(
            reportedCapability,
          )
        ) {
          attemptResult = {
            ok: false,
            code: "INVALID_RECORD",
            message:
              "capability failure does not name an exact action dependency",
          };
        }
      }
      if (!attemptResult.ok && attemptResult.code === "APPROVAL_REQUIRED") {
        this.abortActiveActions(runId);
      }

      const unavailableCapability =
        !attemptResult.ok &&
        (attemptResult.code === "CAPABILITY_UNAVAILABLE" ||
          attemptResult.code === "SERVER_NOT_READY")
          ? attemptResult.code === "SERVER_NOT_READY"
            ? "server"
            : attemptResult.capability
          : undefined;
      const completion = await this.store.completeVerificationAttempt(runId, {
        action_id: options.action_id,
        evidence_record_ids: [...attemptEvidenceIds],
        error_code: attemptResult.ok ? null : attemptResult.code,
        ...(unavailableCapability === undefined
          ? {}
          : { capability: unavailableCapability }),
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
      const disposition = actionFailureDisposition(
        snapshot,
        failureCode,
        options.kind,
        options.lane,
        options.check_id,
        unavailableCapability === undefined
          ? unavailableCapabilities
          : [unavailableCapability],
      );
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
        persistedAttempt?.status === "exhausted" ||
        persistedAttempt?.status === "aborted"
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
    return this.persistTerminalFailure(
      runId,
      options.action_id,
      failure,
      failure.code === "CAPABILITY_UNAVAILABLE" ||
        failure.code === "SERVER_NOT_READY"
        ? failure.code === "SERVER_NOT_READY"
          ? "server"
          : unavailableCapabilities[0]
        : undefined,
    );
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
    capability?: VerificationCapability,
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
      ...(capability === undefined ? {} : { capability }),
      message,
    }, this.#authority);
    const decisiveEvidenceRecordIds =
      persisted.run.verification_state?.attempts.find(
        (attempt) => attempt.action_id === actionId,
      )?.decisive_evidence_record_ids ?? failure.evidence_record_ids;
    const disposition =
      verificationEvidenceDisposition(persisted.record) ??
      verificationErrorDisposition(failure.code);
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

  private requireLocalRuntime(): Readonly<VerificationCoordinatorRuntime> {
    if (this.runtime === null) {
      throw new ArkTeamError(
        "ENVIRONMENT_UNAVAILABLE",
        "local verification runtime is not registered",
      );
    }
    return this.runtime;
  }

  private trackActiveAction(
    runId: string,
    actionId: string,
    controller: AbortController,
  ): void {
    const actions =
      this.activeControllers.get(runId) ?? new Map<string, AbortController>();
    actions.set(actionId, controller);
    this.activeControllers.set(runId, actions);
  }

  private untrackActiveAction(
    runId: string,
    actionId: string,
    controller: AbortController,
  ): void {
    const actions = this.activeControllers.get(runId);
    if (actions?.get(actionId) === controller) {
      actions.delete(actionId);
      if (actions.size === 0) {
        this.activeControllers.delete(runId);
      }
    }
  }

  private abortActiveActions(runId: string): void {
    for (const controller of this.activeControllers.get(runId)?.values() ?? []) {
      controller.abort();
    }
  }
}

export async function selectVerificationServerPort(
  isAvailable: VerificationPortAvailabilityProbe,
  floor = 10_001,
  bind: "0.0.0.0" = "0.0.0.0",
): Promise<number> {
  if (!Number.isInteger(floor) || floor < 10_001 || floor > 65_535) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "local verification port floor must be between 10001 and 65535",
    );
  }
  for (let port = floor; port <= 65_535; port += 1) {
    if (await isAvailable(port, bind)) {
      return port;
    }
  }
  throw new ArkTeamError(
    "ENVIRONMENT_UNAVAILABLE",
    "no local verification port is available at or above 10001",
  );
}

async function defaultVerificationPortAvailability(
  port: number,
  bind: "0.0.0.0",
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(available);
    };
    server.unref();
    server.once("error", () => finish(false));
    server.listen({ host: bind, port, exclusive: true }, () => {
      server.close((error) => finish(error === undefined));
    });
  });
}

function verificationCapabilityDemands(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
): Array<{
  lane: "backend" | "ui";
  lane_required: boolean;
  capability: VerificationCapability;
  capability_required: boolean;
}> {
  const demands: ReturnType<typeof verificationCapabilityDemands> = [];
  const backend = snapshot.backend_contract;
  if (backend.enabled) {
    for (const capability of backend.required_capabilities) {
      demands.push({
        lane: "backend",
        lane_required: backend.required,
        capability,
        capability_required: true,
      });
    }
  }
  const ui = snapshot.ui_contract;
  if (ui.enabled) {
    for (const capability of ui.required_capabilities) {
      demands.push({
        lane: "ui",
        lane_required: ui.required,
        capability,
        capability_required: true,
      });
    }
    for (const capability of ui.optional_capabilities) {
      demands.push({
        lane: "ui",
        lane_required: ui.required,
        capability,
        capability_required: false,
      });
    }
  }
  return demands;
}

function parseReadinessInput(
  input: RunVerificationReadinessInput,
): RunVerificationReadinessInput {
  if (
    !hasExactKeys(input, ["action_id", "server"]) ||
    typeof input.action_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.action_id) ||
    !hasExactKeys(input.server, ["framework", "allowed_dev_origins"]) ||
    !["nextjs", "other"].includes(input.server.framework) ||
    !Array.isArray(input.server.allowed_dev_origins) ||
    input.server.allowed_dev_origins.length > 10 ||
    input.server.allowed_dev_origins.some(
      (origin) =>
        typeof origin !== "string" ||
        origin.length < 1 ||
        origin.length > 1_000,
    ) ||
    new Set(input.server.allowed_dev_origins).size !==
      input.server.allowed_dev_origins.length
  ) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "readiness requires one strict registered-server descriptor",
    );
  }
  if (
    input.server.framework === "nextjs" &&
    !input.server.allowed_dev_origins.includes("dev")
  ) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "Next.js local verification requires allowedDevOrigins to include dev",
    );
  }
  return deepFreeze(structuredClone(input)) as RunVerificationReadinessInput;
}

function verificationServerRegistration(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  input: RunVerificationReadinessInput,
): VerificationServerRegistration {
  return {
    registration_id: `server-${sha256CanonicalJson({
      run_id: snapshot.run_id,
      snapshot_id: snapshot.snapshot_id,
      source_fingerprint: snapshot.source_fingerprint,
      action_id: input.action_id,
      server: input.server,
    }).slice(0, 24)}`,
    framework: input.server.framework,
    allowed_dev_origins: [...input.server.allowed_dev_origins],
  };
}

function validateCapabilityProbeResult(
  result: VerificationCapabilityProbeResult,
  registeredAdapter: { name: string; version: string },
): VerificationCapabilityProbeResult {
  if (
    !hasExactKeys(result, [
      "available",
      "version",
      "diagnostic",
      "adapter",
    ]) ||
    typeof result.available !== "boolean" ||
    (result.version !== null && typeof result.version !== "string") ||
    typeof result.diagnostic !== "string" ||
    !hasExactKeys(result.adapter, ["name", "version"]) ||
    result.adapter.name !== registeredAdapter.name ||
    result.adapter.version !== registeredAdapter.version ||
    (result.available && result.version === null) ||
    (!result.available && result.version !== null)
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "capability probe returned an invalid registered result",
    );
  }
  return result;
}

function validateReadinessResponse(response: {
  status: number;
}): { status: number } {
  if (
    !hasExactKeys(response, ["status"]) ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "local readiness returned an invalid HTTP result",
    );
  }
  return response;
}

function verificationServerStartRequest(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  registration: VerificationServerRegistration,
): VerificationServerStartRequest {
  const readinessUrl = new URL(
    snapshot.resolved_config.server_readiness_path,
    snapshot.server.api_origin,
  ).toString();
  const request: VerificationServerStartRequest = {
    argv: [...snapshot.resolved_config.server_argv],
    cwd: snapshot.source.worktree_root,
    bind: snapshot.server.bind,
    host: snapshot.server.host,
    port: snapshot.server.port,
    origin: snapshot.server.api_origin,
    readiness: {
      url: readinessUrl,
      expected_status: snapshot.resolved_config.server_readiness_status,
      timeout_ms: snapshot.resolved_config.server_readiness_timeout_ms,
      redirect: "manual",
      max_redirects: 0,
    },
    registration,
  };
  const commandDenial = localEffectDenial(snapshot, {
    kind: "command",
    argv: request.argv,
    cwd: request.cwd,
  });
  const networkDenial = localEffectDenial(snapshot, {
    kind: "network",
    url: request.readiness.url,
  });
  if (commandDenial !== null || networkDenial !== null) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "local server launch contract is outside the immutable local boundary",
    );
  }
  return request;
}

function assertRegisteredVerificationServer(
  server: VerificationServerRegistration,
): void {
  if (
    server === null ||
    typeof server !== "object" ||
    !IDENTIFIER_PATTERN.test(server.registration_id) ||
    !["nextjs", "other"].includes(server.framework) ||
    !Array.isArray(server.allowed_dev_origins) ||
    server.allowed_dev_origins.some(
      (origin) => typeof origin !== "string" || origin.length > 1_000,
    )
  ) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "readiness requires one registered local server process",
    );
  }
  if (
    server.framework === "nextjs" &&
    !server.allowed_dev_origins.includes("dev")
  ) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "Next.js local verification requires allowedDevOrigins to include dev",
    );
  }
}

function parseLocalEffectRequest(request: unknown): {
  request: VerificationLocalEffectRequest | null;
  denial: string | null;
} {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return { request: null, denial: "invalid local effect request" };
  }
  const candidate = request as Record<string, unknown>;
  if (candidate.kind === "command") {
    if (
      !hasExactKeys(candidate, ["kind", "argv", "cwd"]) ||
      !Array.isArray(candidate.argv) ||
      candidate.argv.some((argument) => typeof argument !== "string") ||
      typeof candidate.cwd !== "string"
    ) {
      return {
        request: null,
        denial: "command contains unsupported environment, input, or fields",
      };
    }
    return {
      request: {
        kind: "command",
        argv: [...candidate.argv] as string[],
        cwd: candidate.cwd,
      },
      denial: null,
    };
  }
  if (candidate.kind === "network") {
    if (
      !hasExactKeys(candidate, ["kind", "url"]) ||
      typeof candidate.url !== "string"
    ) {
      return {
        request: null,
        denial: "network request contains headers, proxy, body, or unknown fields",
      };
    }
    return {
      request: { kind: "network", url: candidate.url },
      denial: null,
    };
  }
  if (candidate.kind === "approval_required") {
    if (
      !hasExactKeys(candidate, ["kind", "operation"]) ||
      typeof candidate.operation !== "string" ||
      !APPROVAL_REQUIRED_OPERATIONS.includes(
        candidate.operation as VerificationApprovalRequiredOperation,
      )
    ) {
      return { request: null, denial: "unsupported dangerous operation" };
    }
    return {
      request: {
        kind: "approval_required",
        operation:
          candidate.operation as VerificationApprovalRequiredOperation,
      },
      denial: null,
    };
  }
  if (candidate.kind === "agentic_session") {
    if (
      !hasExactKeys(candidate, [
        "kind",
        "task_id",
        "profile",
        "origin_allowlist",
        "allowed_actions",
        "model_identity",
      ]) ||
      typeof candidate.task_id !== "string" ||
      candidate.profile !== "fresh_ephemeral" ||
      !Array.isArray(candidate.origin_allowlist) ||
      candidate.origin_allowlist.some((value) => typeof value !== "string") ||
      !Array.isArray(candidate.allowed_actions) ||
      candidate.allowed_actions.some((value) => typeof value !== "string") ||
      typeof candidate.model_identity !== "string"
    ) {
      return { request: null, denial: "unsafe agentic session descriptor" };
    }
    return {
      request: {
        kind: "agentic_session",
        task_id: candidate.task_id,
        profile: "fresh_ephemeral",
        origin_allowlist: [...candidate.origin_allowlist] as string[],
        allowed_actions: [...candidate.allowed_actions] as string[],
        model_identity: candidate.model_identity,
      },
      denial: null,
    };
  }
  return { request: null, denial: "unsupported or broad local effect" };
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function localEffectDenial(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  request: DeepReadonly<VerificationLocalEffectRequest>,
): string | null {
  if (request.kind === "approval_required") {
    return APPROVAL_REQUIRED_OPERATIONS.includes(request.operation)
      ? request.operation
      : "unsupported operation";
  }
  if (request.kind === "network") {
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      return "invalid network target";
    }
    if (
      target.origin !== snapshot.server.api_origin ||
      target.username !== "" ||
      target.password !== "" ||
      SECRET_DIAGNOSTIC_PATTERN.test(
        `${target.search}${target.hash}`,
      )
    ) {
      return "remote or credential-bearing network target";
    }
    return null;
  }
  if (request.kind === "agentic_session") {
    const task = snapshot.ui_contract.enabled
      ? snapshot.ui_contract.agentic_tasks.find(
          (candidate) => candidate.id === request.task_id,
        )
      : undefined;
    if (
      task === undefined ||
      request.profile !== "fresh_ephemeral" ||
      request.origin_allowlist.length !== 1 ||
      request.origin_allowlist[0] !== snapshot.server.api_origin ||
      request.model_identity !== task.model_identity ||
      request.allowed_actions.length !== task.allowed_actions.length ||
      task.allowed_actions.some(
        (action, index) => request.allowed_actions[index] !== action,
      )
    ) {
      return "unsafe agentic session";
    }
    return null;
  }
  if (
    request.argv.length < 1 ||
    request.argv.length > 32 ||
    request.argv.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length < 1 ||
        argument.length > 1_000 ||
        argument.includes("\0"),
    )
  ) {
    return "non-literal command";
  }
  const executable = path.basename(request.argv[0]!).toLowerCase();
  if (FORBIDDEN_COMMANDS.has(executable)) {
    return "Docker, remote, shell, or infrastructure command";
  }
  if (
    request.argv.some(
      (argument) =>
        SECRET_DIAGNOSTIC_PATTERN.test(argument) ||
        /^(?:https?|wss?):\/\//i.test(argument) ||
        argument === "3000" ||
        /^--?port(?:=|:)3000$/i.test(argument),
    )
  ) {
    return "credential, remote, or forbidden-port command";
  }
  if (
    request.argv.length !== snapshot.resolved_config.server_argv.length ||
    request.argv.some(
      (argument, index) =>
        argument !== snapshot.resolved_config.server_argv[index],
    )
  ) {
    return "unregistered command";
  }
  const cwd = request.cwd;
  if (
    !path.isAbsolute(cwd) ||
    path.normalize(cwd) !== cwd ||
    path.resolve(cwd) !== cwd ||
    (cwd !== snapshot.source.worktree_root &&
      cwd !== snapshot.artifact_root)
  ) {
    return "out-of-root command";
  }
  return null;
}

function approvalTerminationResult<T>(
  terminated: TerminateVerificationForApprovalResult,
  requestSha256: string,
): VerificationLocalEffectResult<T> {
  if (terminated.error_record.schema_version !== 2) {
    throw new ArkTeamError(
      "CORRUPT_STATE",
      "approval denial persisted a legacy verification record",
    );
  }
  const payload = terminated.error_record.payload;
  if (
    payload.kind !== "error" ||
    payload.code !== "APPROVAL_REQUIRED" ||
    payload.approval_id === undefined ||
    payload.request_sha256 !== requestSha256
  ) {
    throw new ArkTeamError(
      "CORRUPT_STATE",
      "approval denial did not persist its opaque identity and request hash",
    );
  }
  return {
    ok: false,
    code: "APPROVAL_REQUIRED",
    message: payload.message,
    approval_id: payload.approval_id,
    request_sha256: payload.request_sha256,
  };
}

function unavailableCapabilitiesForAction(
  run: RunRecord,
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  kind: VerificationActionKind,
  lane: "backend" | "ui" | null,
): VerificationCapability[] {
  const required = requiredCapabilitiesForAction(snapshot, kind);
  if (required.length === 0 || lane === null) {
    return [];
  }
  const readiness = run.verification_state?.attempts.find(
    (attempt) =>
      attempt.kind === "readiness" && attempt.status === "succeeded",
  );
  if (readiness === undefined) {
    return required;
  }
  const records = new Map(
    run.verification_records.map((record) => [record.record_id, record]),
  );
  const failureCapabilities = new Map<string, VerificationCapability>();
  for (const record of run.verification_records) {
    if (
      record.schema_version === 2 &&
      record.payload.kind === "error" &&
      record.payload.action_id !== undefined &&
      record.payload.capability !== undefined &&
      ["CAPABILITY_UNAVAILABLE", "SERVER_NOT_READY"].includes(
        record.payload.code,
      )
    ) {
      failureCapabilities.set(
        record.payload.action_id,
        record.payload.capability,
      );
    }
  }
  const dynamicallyUnavailable = new Set<VerificationCapability>();
  for (const attempt of run.verification_state?.attempts ?? []) {
    if (
      (attempt.last_error_code === "CAPABILITY_UNAVAILABLE" ||
        attempt.last_error_code === "SERVER_NOT_READY") &&
      attempt.kind !== "readiness"
    ) {
      const capability =
        failureCapabilities.get(attempt.action_id) ??
        (attempt.last_error_code === "SERVER_NOT_READY"
          ? "server"
          : primaryCapabilityForAction(attempt.kind));
      if (capability !== null) {
        dynamicallyUnavailable.add(capability);
      }
    }
  }
  return required.filter((capability) => {
    if (dynamicallyUnavailable.has(capability)) {
      return true;
    }
    const record = readiness.decisive_evidence_record_ids
      .map((recordId) => records.get(recordId))
      .find(
        (candidate) =>
          candidate?.schema_version === 2 &&
          candidate.lane === lane &&
          candidate.payload.kind === "capability" &&
          candidate.payload.capability === capability,
      );
    return (
      record === undefined ||
      record.payload.kind !== "capability" ||
      !record.payload.available
    );
  });
}

function primaryCapabilityForAction(
  kind: VerificationActionKind,
): VerificationCapability | null {
  switch (kind) {
    case "api":
      return "api";
    case "browser":
      return "browser";
    case "agentic_browser":
      return "agentic_browser";
    case "screenshot":
      return "screenshot";
    case "semantic_review":
      return "semantic_review";
    case "comparison":
      return "comparison";
    case "readiness":
    case "artifact_write":
    case "cleanup":
      return null;
  }
}

function requiredCapabilitiesForAction(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  kind: VerificationActionKind,
): VerificationCapability[] {
  switch (kind) {
    case "api":
      return ["api", "server"];
    case "browser":
      return ["browser", "server"];
    case "agentic_browser":
      return ["agentic_browser", "server"];
    case "screenshot":
      return ["browser", "screenshot", "server"];
    case "semantic_review":
      return ["screenshot", "semantic_review"];
    case "comparison":
      return [
        "comparison",
        "screenshot",
        ...(snapshot.evidence_policy.semantic_review_required
          ? (["semantic_review"] as const)
          : []),
      ];
    case "readiness":
    case "artifact_write":
    case "cleanup":
      return [];
  }
}

function actionFailureDisposition(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  code: VerificationErrorCode,
  kind: VerificationActionKind,
  lane: "backend" | "ui" | null,
  checkId: string | null,
  unavailableCapabilities: readonly VerificationCapability[],
): { outcome: VerificationOutcome; integrity_failure: boolean } {
  if (code === "APPROVAL_REQUIRED") {
    return { outcome: "error", integrity_failure: false };
  }
  if (code !== "CAPABILITY_UNAVAILABLE" && code !== "SERVER_NOT_READY") {
    return verificationErrorDisposition(code);
  }
  const laneRequired =
    lane === "backend"
      ? snapshot.backend_contract.enabled &&
        snapshot.backend_contract.required
      : lane === "ui"
        ? snapshot.ui_contract.enabled && snapshot.ui_contract.required
        : false;
  const checkRequired =
    checkId === null
      ? false
      : lane === "backend" && snapshot.backend_contract.enabled
        ? (snapshot.backend_contract.api_probes.find(
            (probe) => probe.id === checkId,
          )?.required ?? false)
        : lane === "ui" && snapshot.ui_contract.enabled
          ? (snapshot.ui_contract.browser_cases.find(
              (browserCase) => browserCase.id === checkId,
            )?.required ??
            snapshot.ui_contract.agentic_tasks.find(
              (task) => task.id === checkId,
            )?.required ??
            false)
          : false;
  const capabilities =
    code === "SERVER_NOT_READY"
      ? (["server"] as const)
      : unavailableCapabilities.length > 0
        ? unavailableCapabilities
        : primaryCapabilityForAction(kind) === null
          ? []
          : [primaryCapabilityForAction(kind)!];
  const requiredCapabilities =
    lane === "backend" && snapshot.backend_contract.enabled
      ? snapshot.backend_contract.required_capabilities
      : lane === "ui" && snapshot.ui_contract.enabled
        ? snapshot.ui_contract.required_capabilities
        : [];
  return {
    outcome:
      laneRequired &&
      checkRequired &&
      capabilities.some((capability) =>
        requiredCapabilities.includes(capability),
      )
        ? "unavailable"
        : "skipped",
    integrity_failure: false,
  };
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
  if (
    normalized.length > MAX_DIAGNOSTIC_CHARACTERS ||
    SECRET_DIAGNOSTIC_PATTERN.test(normalized)
  ) {
    return REDACTED_DIAGNOSTIC;
  }
  return normalized;
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
