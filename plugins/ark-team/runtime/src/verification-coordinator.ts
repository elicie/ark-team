import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";

import type { RunRecord } from "./domain.js";
import { ArkTeamError } from "./errors.js";
import {
  createVerificationAgenticBrowserRequest,
  normalizeVerificationAgenticBrowserResult,
  VerificationAgenticBrowserContractError,
  type VerificationAgenticBrowserEvidence,
  type VerificationAgenticBrowserRequest,
} from "./verification-agentic-browser-adapter.js";
import {
  createVerificationApiRequest,
  normalizeVerificationApiResult,
  VerificationApiAdapterError,
  type VerificationApiEvidence,
  type VerificationApiRuntimeRequest,
} from "./verification-api-adapter.js";
import {
  createVerificationBrowserDriverV2Request,
  createVerificationBrowserDriverRequest,
  normalizeVerificationBrowserDriverV2Result,
  normalizeVerificationBrowserDriverResult,
  VerificationBrowserContractError,
  type VerificationBrowserEvidence,
  type VerificationBrowserDriverV2Request,
  type VerificationBrowserDriverRequest,
} from "./verification-browser-adapter.js";
import {
  createVerificationSemanticReviewRequest,
  normalizeVerificationSemanticReviewResult,
  VerificationSemanticReviewContractError,
  VerificationSemanticReviewUnavailableError,
  type VerificationSemanticReviewActiveTurnSignal,
  type VerificationSemanticReviewChecklistIdentity,
  type VerificationSemanticReviewEvidence,
  type VerificationSemanticReviewRequest,
} from "./verification-semantic-review-adapter.js";
import {
  compareVerificationPngs,
  createVerificationScreenshotRuntimeV2Expectation,
  createVerificationScreenshotRequest,
  normalizeVerificationScreenshotRuntimeV2Result,
  normalizeVerificationScreenshotResult,
  VerificationVisualContractError,
  type VerificationScreenshotEvidence,
  type VerificationScreenshotImageEvidence,
  type VerificationScreenshotRuntimeRequest,
  type VerificationScreenshotRuntimeV2Result,
  type VerificationSemanticReviewOutcome,
  type VerificationVisualComparisonEvidence,
} from "./verification-visual-adapter.js";
import type {
  VerificationActionKind,
  VerificationCapability,
  VerificationErrorCode,
  VerificationLaneDecisionInput,
  VerificationLinkedRecord,
  VerificationOutcome,
  VerificationRollbackRecord,
  VerificationRunSnapshot,
  VerificationSpecDeltaRecord,
  VerificationStage,
} from "./verification-contract.js";
import {
  VERIFICATION_SECRET_TEXT_PATTERN,
  canonicalJson,
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
  RecordVerificationSpecDeltaInput,
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
  | "readVerificationArtifact"
  | "cleanupVerificationArtifacts"
  | "verifyApprovedBaseline"
  | "recordVerificationRollback"
  | "getVerificationRollback"
  | "recordVerificationSpecDelta"
  | "getVerificationSpecDelta"
  | "revalidateVerificationArtifacts"
>;

export const VERIFICATION_ROLLOUT_STAGES = Object.freeze([
  "source_config_snapshot",
  "artifacts_baselines",
  "coordinator_lane_aggregation",
  "capability_server",
  "backend_api",
  "deterministic_ui",
  "visual_checks",
  "agentic_ui",
  "bootstrap",
] as const);

export interface VerificationRolloutAnnouncement {
  contract_id: "verification_contract_v2";
  schema_version: 2;
  package_id: "verification-spec-v4";
  package_fingerprint: string;
  source_fingerprint: string;
  snapshot_id: string;
  stages: typeof VERIFICATION_ROLLOUT_STAGES;
}

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
  timeout_ms?: number;
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
  host: "devbox";
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

export interface RunVerificationApiProbeInput {
  action_id: string;
  probe_id: string;
  body_base64?: string;
}

export interface RunVerificationBrowserCaseInput {
  action_id: string;
  case_id: string;
}

export interface RunVerificationScreenshotInput {
  action_id: string;
  case_id: string;
}

export interface RunVerificationSemanticReviewInput {
  action_id: string;
  case_id: string;
  screenshot_paths: readonly string[];
  checklist: VerificationSemanticReviewChecklistIdentity;
}

export interface RunVerificationComparisonInput {
  action_id: string;
  case_id: string;
  actuals: readonly {
    evidence: VerificationScreenshotImageEvidence;
    png_bytes: Uint8Array;
  }[];
  baseline_png_bytes: Readonly<
    Record<"375x812" | "768x1024" | "1440x900", Uint8Array>
  >;
  semantic_review_outcome: VerificationSemanticReviewOutcome | null;
}

export interface RunVerificationAgenticBrowserInput {
  action_id: string;
  task_id: string;
}

type VerificationBootstrapViewport = "375x812" | "768x1024" | "1440x900";

export interface RunVerificationBootstrapInput {
  package_fingerprint: string;
  server: Omit<VerificationServerRegistration, "registration_id">;
  ui_evidence_source?: "approved_store";
  api_body_base64_by_probe?: Readonly<Record<string, string>>;
  semantic_checklist_by_case?: Readonly<
    Record<string, VerificationSemanticReviewChecklistIdentity>
  >;
  baseline_png_bytes_by_case?: Readonly<
    Record<
      string,
      Readonly<Record<VerificationBootstrapViewport, Uint8Array>>
    >
  >;
}

export interface VerificationBootstrapStep {
  sequence: number;
  name:
    | "identity"
    | "config"
    | "snapshot"
    | "capabilities"
    | "server"
    | "backend"
    | "deterministic_ui"
    | "visual"
    | "agentic_ui"
    | "lane_summaries"
    | "terminal_handoff";
  status: "completed" | "not_applicable";
  evidence_record_ids: string[];
}

export type VerificationBootstrapResult =
  | {
      status: "completed";
      case_id: "BOOTSTRAP-1701";
      steps: VerificationBootstrapStep[];
      run: RunRecord;
    }
  | {
      status: "SPEC_DELTA_REQUIRED";
      case_id: "BOOTSTRAP-1701";
      steps: VerificationBootstrapStep[];
      delta: VerificationSpecDeltaRecord;
    };

export interface VerificationApiProbeValue {
  evidence: VerificationApiEvidence;
  evidence_artifact: {
    artifact_id: string;
    relative_path: string;
    sha256: string;
  };
}

export interface VerificationBrowserCaseValue {
  evidence: VerificationBrowserEvidence;
  evidence_artifact: {
    artifact_id: string;
    relative_path: string;
    sha256: string;
  };
  trace_artifact: {
    artifact_id: string;
    relative_path: string;
    sha256: string;
  };
}

export interface VerificationScreenshotValue {
  evidence: VerificationScreenshotEvidence;
  evidence_artifact: VerificationArtifactReferenceValue;
  images: Array<{
    evidence: VerificationScreenshotImageEvidence;
    artifact: VerificationArtifactReferenceValue;
    png_bytes: Uint8Array;
  }>;
}

export interface VerificationSemanticReviewValue {
  evidence: VerificationSemanticReviewEvidence;
  evidence_artifact: VerificationArtifactReferenceValue;
  outcome: "approved" | "rejected" | "blocked";
}

export interface VerificationComparisonValue {
  comparisons: Array<{
    evidence: VerificationVisualComparisonEvidence;
    evidence_artifact: VerificationArtifactReferenceValue;
    diff_artifact: VerificationArtifactReferenceValue;
  }>;
}

export interface VerificationAgenticBrowserValue {
  evidence: VerificationAgenticBrowserEvidence;
  ledger_artifact: VerificationArtifactReferenceValue;
  result_artifact: VerificationArtifactReferenceValue;
}

export interface VerificationArtifactReferenceValue {
  artifact_id: string;
  relative_path: string;
  sha256: string;
}

export interface VerificationCoordinatorRuntime {
  browser_contract?: "v2-combined";
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
  execute_api?: (
    request: DeepReadonly<VerificationApiRuntimeRequest>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  execute_browser?: (
    request: DeepReadonly<
      VerificationBrowserDriverRequest | VerificationBrowserDriverV2Request
    >,
    signal: AbortSignal,
  ) => Promise<unknown>;
  execute_screenshots?: (
    request: DeepReadonly<VerificationScreenshotRuntimeRequest>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  semantic_review_active_turn?: () =>
    | VerificationSemanticReviewActiveTurnSignal
    | null;
  execute_semantic_review?: (
    request: DeepReadonly<VerificationSemanticReviewRequest>,
    signal: AbortSignal,
  ) => Promise<unknown>;
  execute_agentic_browser?: (
    request: DeepReadonly<VerificationAgenticBrowserRequest>,
    signal: AbortSignal,
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
  private readonly attemptNumbers = new WeakMap<object, number>();
  private readonly attemptDeadlines = new WeakMap<
    object,
    VerificationActionDeadline
  >();
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

  async announceRollout(
    runId: string,
  ): Promise<VerificationRolloutAnnouncement> {
    const run = await this.store.assertCurrentVerification(
      runId,
      this.#authority,
    );
    const snapshot = requireV2Snapshot(run);
    if (snapshot.package.package_id !== "verification-spec-v4") {
      throw new ArkTeamError(
        "CONTRACT_VERSION_MISMATCH",
        "only verification-spec-v4 can announce a contract-v2 rollout",
      );
    }
    return Object.freeze({
      contract_id: "verification_contract_v2",
      schema_version: 2,
      package_id: "verification-spec-v4",
      package_fingerprint: snapshot.package.package_fingerprint,
      source_fingerprint: snapshot.source_fingerprint,
      snapshot_id: snapshot.snapshot_id,
      stages: VERIFICATION_ROLLOUT_STAGES,
    });
  }

  disableLocalVerification(
    reason: string,
  ): Promise<VerificationRollbackRecord> {
    return this.store.recordVerificationRollback({ reason });
  }

  getLocalVerificationRollback(): Promise<VerificationRollbackRecord | null> {
    return this.store.getVerificationRollback();
  }

  async recordSpecDelta(
    runId: string,
    input: RecordVerificationSpecDeltaInput,
  ): Promise<VerificationSpecDeltaRecord> {
    this.abortActiveActions(runId);
    return this.store.recordVerificationSpecDelta(
      runId,
      input,
      this.#authority,
    );
  }

  getSpecDelta(
    runId: string,
  ): Promise<VerificationSpecDeltaRecord | null> {
    return this.store.getVerificationSpecDelta(runId);
  }

  getCurrentRun(runId: string): Promise<RunRecord> {
    return this.store.getRun(runId);
  }

  async recoverLocal(runId: string): Promise<RunRecord> {
    return this.recoverLocalEnvironment(runId, true);
  }

  private async recoverLocalEnvironment(
    runId: string,
    requireServerReadiness: boolean,
  ): Promise<RunRecord> {
    const initial = await this.store.getRun(runId);
    const snapshot = initial.verification_snapshot;
    if (snapshot === null || snapshot.schema_version !== 2) {
      throw new ArkTeamError(
        "CONTRACT_VERSION_MISMATCH",
        "contract-v1 verification runs are read-only",
      );
    }
    if (initial.verification_state?.terminal_outcome !== null) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "terminal verification runs never resume",
      );
    }
    const run = await this.store.revalidateVerificationArtifacts(
      runId,
      this.#authority,
    );
    const state = run.verification_state?.current_state;
    if (
      state === undefined ||
      verificationStageIndex(state) <
        verificationStageIndex("capabilities")
    ) {
      return run;
    }
    const runtime = this.requireLocalRuntime();
    const demands = verificationCapabilityDemands(snapshot);
    const recordedCapabilities = run.verification_records.filter(
      (
        record,
      ): record is Extract<VerificationLinkedRecord, { schema_version: 2 }> =>
        record.schema_version === 2 &&
        record.payload.kind === "capability",
    );
    for (const capability of [
      ...new Set(demands.map((demand) => demand.capability)),
    ].sort()) {
      const records = recordedCapabilities.filter(
        (record) =>
          record.payload.kind === "capability" &&
          record.payload.capability === capability,
      );
      if (
        records.length === 0 &&
        verificationStageIndex(state) >
          verificationStageIndex("capabilities")
      ) {
        throw new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          `recovery cannot revalidate missing ${capability} capability evidence`,
        );
      }
      let discovered: VerificationCapabilityProbeResult;
      try {
        discovered = validateCapabilityProbeResult(
          await runtime.capability_probe(
            capability,
            AbortSignal.timeout(snapshot.timeouts_ms.server_ms),
          ),
          runtime.capability_adapters[capability],
        );
      } catch (error) {
        throw new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          `recovery capability probe failed for ${capability}`,
          { cause: error },
        );
      }
      const effectivelyRequired = demands.some(
        (demand) =>
          demand.capability === capability &&
          demand.lane_required &&
          demand.capability_required,
      );
      if (
        (effectivelyRequired && !discovered.available) ||
        records.some(
          (record) =>
            record.adapter?.name !== discovered.adapter.name ||
            record.adapter.version !== discovered.adapter.version ||
            (record.payload.kind === "capability" &&
              record.payload.available &&
              (!discovered.available ||
                record.payload.version !== discovered.version)),
        )
      ) {
        throw new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          `recovery environment no longer matches ${capability} capability evidence`,
        );
      }
    }
    if (
      requireServerReadiness &&
      verificationStageIndex(state) >= verificationStageIndex("ready")
    ) {
      const registration = {
        registration_id: `recovery-${sha256CanonicalJson({
          run_id: runId,
          snapshot_id: snapshot.snapshot_id,
        }).slice(0, 24)}`,
        framework: "other" as const,
        allowed_dev_origins: [] as const,
      };
      const request = verificationServerStartRequest(snapshot, registration);
      try {
        const response = validateReadinessResponse(
          await runtime.probe_http(
            deepFreeze(structuredClone(request)),
            AbortSignal.timeout(snapshot.timeouts_ms.server_ms),
          ),
        );
        if (response.status !== request.readiness.expected_status) {
          throw new Error(
            `unexpected recovery readiness status ${response.status}`,
          );
        }
      } catch (error) {
        throw new ArkTeamError(
          "ENVIRONMENT_UNAVAILABLE",
          "registered local verification server is unavailable during recovery",
          { cause: error },
        );
      }
    }
    return run;
  }

  async runBootstrap(
    runId: string,
    input: RunVerificationBootstrapInput,
  ): Promise<VerificationBootstrapResult> {
    const steps: VerificationBootstrapStep[] = [];
    const initial = await this.store.getRun(runId);
    const inputProblem = verificationBootstrapInputProblem(initial, input);
    if (inputProblem !== null) {
      return {
        status: "SPEC_DELTA_REQUIRED",
        case_id: "BOOTSTRAP-1701",
        steps,
        delta: await this.recordSpecDelta(runId, inputProblem),
      };
    }
    try {
      this.requireLocalRuntime();
    } catch {
      return {
        status: "SPEC_DELTA_REQUIRED",
        case_id: "BOOTSTRAP-1701",
        steps,
        delta: await this.recordSpecDelta(runId, {
          affected_ids: [
            "OBJ-1709",
            "REQ-1719",
            "AC-1719",
            "TEST-1719",
            "IS-1707",
          ],
          classification: "environment_mismatch",
          evidence: [
            {
              kind: "runtime",
              value: "registered local verification runtime is unavailable",
            },
          ],
          impact: "BOOTSTRAP-1701 cannot discover local capabilities",
          proposed_resolution:
            "register one exact local verification runtime and start a new snapshot",
          blocking_stage: "IS-1707",
        }),
      };
    }

    requireAcceptedVerificationTransition(
      await this.advance(runId, "configured"),
      "configured",
    );
    const snapshotted = await this.configureLocal(runId, {
      package_fingerprint: input.package_fingerprint,
    });
    const snapshot = requireV2Snapshot(snapshotted);
    const setupRecords = snapshotted.verification_records.filter(
      (record) =>
        record.schema_version === 2 &&
        ["source", "config", "snapshot"].includes(record.payload.kind),
    );
    for (const [sequence, name, kind] of [
      [1, "identity", "source"],
      [2, "config", "config"],
      [3, "snapshot", "snapshot"],
    ] as const) {
      steps.push({
        sequence,
        name,
        status: "completed",
        evidence_record_ids: setupRecords
          .filter((record) => record.payload.kind === kind)
          .map((record) => record.record_id),
      });
    }
    await this.announceRollout(runId);

    let approvedBaselineBytes:
      | Readonly<
          Record<
            string,
            Readonly<
              Record<VerificationBootstrapViewport, Uint8Array>
            >
          >
        >
      | undefined;
    if (snapshot.ui_contract.enabled) {
      try {
        const approvedBaseline =
          await this.store.verifyApprovedBaseline(runId);
        if (input.ui_evidence_source === "approved_store") {
          approvedBaselineBytes = approvedBaseline.png_bytes_by_case;
        }
      } catch (error) {
        if (
          error instanceof ArkTeamError &&
          error.code === "BASELINE_NOT_APPROVED"
        ) {
          return {
            status: "SPEC_DELTA_REQUIRED",
            case_id: "BOOTSTRAP-1701",
            steps,
            delta: await this.recordSpecDelta(runId, {
              affected_ids: [
                "OBJ-1709",
                "REQ-1719",
                "AC-1719",
                "TEST-1719",
                "IS-1707",
              ],
              classification: "unverifiable",
              evidence: [
                {
                  kind: "baseline",
                  value: "approved baseline manifest could not be verified",
                },
              ],
              impact:
                "UI visual comparison cannot start without immutable baseline evidence",
              proposed_resolution:
                "supply the approved content-addressed baseline and start a new snapshot",
              blocking_stage: "IS-1707",
            }),
          };
        }
        throw error;
      }
    }

    requireAcceptedVerificationTransition(
      await this.advance(runId, "capabilities"),
      "capabilities",
    );
    const readiness = await this.runReadiness(runId, {
      action_id: bootstrapActionId("readiness", snapshot.case_id),
      server: input.server,
    });
    steps.push({
      sequence: 4,
      name: "capabilities",
      status: "completed",
      evidence_record_ids: [...readiness.evidence_record_ids],
    });
    steps.push({
      sequence: 5,
      name: "server",
      status: "completed",
      evidence_record_ids: [...readiness.evidence_record_ids],
    });
    requireAcceptedVerificationTransition(
      await this.advance(runId, "ready"),
      "ready",
    );
    requireAcceptedVerificationTransition(
      await this.advance(runId, "executing"),
      "executing",
    );

    const backendEvidence: string[] = [];
    if (snapshot.backend_contract.enabled) {
      for (const probe of snapshot.backend_contract.api_probes) {
        const bodyBase64 =
          probe.body_digest === "none"
            ? undefined
            : input.api_body_base64_by_probe?.[probe.id];
        if (probe.body_digest !== "none" && bodyBase64 === undefined) {
          throw new ArkTeamError(
            "INVALID_RECORD",
            "prevalidated API request body disappeared",
          );
        }
        const result = await this.runApiProbe(runId, {
          action_id: bootstrapActionId("api", probe.id),
          probe_id: probe.id,
          ...(probe.body_digest === "none"
            ? {}
            : { body_base64: bodyBase64! }),
        });
        backendEvidence.push(...result.evidence_record_ids);
      }
    }
    steps.push({
      sequence: 6,
      name: "backend",
      status: snapshot.backend_contract.enabled
        ? "completed"
        : "not_applicable",
      evidence_record_ids: backendEvidence,
    });

    const browserSucceeded = new Map<string, boolean>();
    const deterministicEvidence: string[] = [];
    if (snapshot.ui_contract.enabled) {
      for (const browserCase of snapshot.ui_contract.browser_cases) {
        const result = await this.runBrowserCase(runId, {
          action_id: bootstrapActionId("browser", browserCase.id),
          case_id: browserCase.id,
        });
        browserSucceeded.set(browserCase.id, result.ok);
        deterministicEvidence.push(...result.evidence_record_ids);
      }
    }
    steps.push({
      sequence: 7,
      name: "deterministic_ui",
      status: snapshot.ui_contract.enabled
        ? "completed"
        : "not_applicable",
      evidence_record_ids: deterministicEvidence,
    });
    requireAcceptedVerificationTransition(
      await this.advance(runId, "collecting"),
      "collecting",
    );

    const visualEvidence: string[] = [];
    if (snapshot.ui_contract.enabled) {
      for (const browserCase of snapshot.ui_contract.browser_cases) {
        if (!browserSucceeded.get(browserCase.id)) {
          continue;
        }
        const screenshots = await this.runScreenshots(runId, {
          action_id: bootstrapActionId("screenshot", browserCase.id),
          case_id: browserCase.id,
        });
        visualEvidence.push(...screenshots.evidence_record_ids);
        if (!screenshots.ok) {
          continue;
        }
        const checklist =
          input.semantic_checklist_by_case?.[browserCase.id];
        if (checklist === undefined) {
          throw new ArkTeamError(
            "INVALID_RECORD",
            "prevalidated semantic checklist disappeared",
          );
        }
        const semantic = await this.runSemanticReview(runId, {
          action_id: bootstrapActionId(
            "semantic-review",
            browserCase.id,
          ),
          case_id: browserCase.id,
          screenshot_paths: screenshots.value.images.map((image) =>
            path.join(snapshot.artifact_root, image.artifact.relative_path),
          ),
          checklist,
        });
        visualEvidence.push(...semantic.evidence_record_ids);
        const baselines =
          approvedBaselineBytes?.[browserCase.id] ??
          input.baseline_png_bytes_by_case?.[browserCase.id];
        if (baselines === undefined) {
          throw new ArkTeamError(
            "INVALID_RECORD",
            "prevalidated baseline bytes disappeared",
          );
        }
        const comparison = await this.runComparison(runId, {
          action_id: bootstrapActionId("comparison", browserCase.id),
          case_id: browserCase.id,
          actuals: screenshots.value.images.map((image) => ({
            evidence: image.evidence,
            png_bytes: image.png_bytes,
          })),
          baseline_png_bytes: baselines,
          semantic_review_outcome: semantic.ok
            ? semantic.value.outcome
            : null,
        });
        visualEvidence.push(...comparison.evidence_record_ids);
      }
    }
    steps.push({
      sequence: 8,
      name: "visual",
      status: snapshot.ui_contract.enabled
        ? "completed"
        : "not_applicable",
      evidence_record_ids: visualEvidence,
    });

    const agenticEvidence: string[] = [];
    if (snapshot.ui_contract.enabled) {
      for (const task of snapshot.ui_contract.agentic_tasks) {
        const recheckCase = snapshot.ui_contract.browser_cases.find(
          (browserCase) =>
            browserCase.path === task.start_path &&
            canonicalJson(browserCase.assertions) ===
              canonicalJson(task.success_criteria),
        );
        const result =
          recheckCase !== undefined &&
          browserSucceeded.get(recheckCase.id)
            ? await this.runAgenticBrowser(runId, {
                action_id: bootstrapActionId("agentic", task.id),
                task_id: task.id,
              })
            : await this.runAction(runId, {
                action_id: bootstrapActionId("agentic", task.id),
                kind: "agentic_browser",
                lane: "ui",
                check_id: task.id,
                input: {
                  task_id: task.id,
                  deterministic_recheck_available: false,
                },
                adapter: async () => ({
                  ok: false,
                  code: "BROWSER_CONTRACT_MISMATCH",
                  message:
                    "agentic exploration skipped because deterministic UI evidence did not pass",
                }),
              });
        agenticEvidence.push(...result.evidence_record_ids);
      }
    }
    steps.push({
      sequence: 9,
      name: "agentic_ui",
      status:
        snapshot.ui_contract.enabled &&
        snapshot.ui_contract.agentic_tasks.length > 0
          ? "completed"
          : "not_applicable",
      evidence_record_ids: agenticEvidence,
    });

    requireAcceptedVerificationTransition(
      await this.advance(runId, "deciding"),
      "deciding",
    );
    const beforeDecision = await this.store.getRun(runId);
    const terminal = await this.finalize(
      runId,
      deriveBootstrapLaneDecisions(beforeDecision),
    );
    if (terminal.verification_state?.terminal_outcome === null) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "BOOTSTRAP-1701 did not produce one terminal outcome",
      );
    }
    const laneSummaries = terminal.verification_records.filter(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "lane_summary",
    );
    steps.push({
      sequence: 10,
      name: "lane_summaries",
      status: "completed",
      evidence_record_ids: laneSummaries.map((record) => record.record_id),
    });
    const reports = terminal.verification_records.filter(
      (record) =>
        record.schema_version === 2 && record.payload.kind === "report",
    );
    steps.push({
      sequence: 11,
      name: "terminal_handoff",
      status: "completed",
      evidence_record_ids: reports.map((record) => record.record_id),
    });
    let handoff = terminal;
    if (terminal.verification_state?.terminal_outcome === "passed") {
      const pending = await this.advance(runId, "pm_review_pending");
      if (!pending.accepted) {
        return {
          status: "SPEC_DELTA_REQUIRED",
          case_id: "BOOTSTRAP-1701",
          steps,
          delta: await this.recordSpecDelta(runId, {
            affected_ids: [
              "OBJ-1709",
              "REQ-1720",
              "AC-1720",
              "TEST-1720",
              "IS-1707",
            ],
            classification: "contradiction",
            evidence: [
              {
                kind: "pm_gate",
                value: "passed report lacks complete PM handoff evidence",
              },
            ],
            impact: "original PM review cannot start",
            proposed_resolution:
              "repair the missing deterministic handoff evidence and start a new snapshot",
            blocking_stage: "IS-1707",
          }),
        };
      }
      handoff = pending.run;
    }
    return {
      status: "completed",
      case_id: "BOOTSTRAP-1701",
      steps,
      run: handoff,
    };
  }

  async resumeCombinedBootstrap(
    runId: string,
    input: RunVerificationBootstrapInput,
  ): Promise<RunRecord> {
    const current = await this.recoverLocalEnvironment(runId, false);
    const snapshot = requireV2Snapshot(current);
    const runtime = this.requireLocalRuntime();
    if (
      runtime.browser_contract !== "v2-combined" ||
      !snapshot.ui_contract.enabled ||
      input.package_fingerprint !==
        snapshot.package.package_fingerprint
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "only the exact combined UI bootstrap can resume",
      );
    }
    const state = current.verification_state?.current_state;
    if (state !== "executing" && state !== "collecting") {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "combined UI bootstrap can resume only at the browser/screenshot boundary",
      );
    }
    if (
      current.verification_state?.attempts.some((attempt) =>
        [
          "screenshot",
          "semantic_review",
          "comparison",
          "agentic_browser",
        ].includes(attempt.kind),
      )
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "combined UI bootstrap recovery found work after the durable browser boundary",
      );
    }
    for (const browserCase of snapshot.ui_contract.browser_cases) {
      requireCombinedBrowserRecord(current, browserCase.id);
    }

    const caseIds = snapshot.ui_contract.browser_cases
      .map((browserCase) => browserCase.id)
      .sort();
    const checklistIds = Object.keys(
      input.semantic_checklist_by_case ?? {},
    ).sort();
    if (
      caseIds.length !== checklistIds.length ||
      caseIds.some((caseId, index) => caseId !== checklistIds[index])
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "combined UI bootstrap recovery requires one exact checklist per browser case",
      );
    }
    const injectedBaselineIds = Object.keys(
      input.baseline_png_bytes_by_case ?? {},
    ).sort();
    if (
      input.ui_evidence_source === "approved_store" &&
      injectedBaselineIds.length !== 0
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "approved-store recovery rejects injected baseline bytes",
      );
    }
    if (
      input.ui_evidence_source !== "approved_store" &&
      (caseIds.length !== injectedBaselineIds.length ||
        caseIds.some(
          (caseId, index) => caseId !== injectedBaselineIds[index],
        ))
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "combined UI bootstrap recovery requires the exact baseline cases",
      );
    }
    const approvedBaseline =
      await this.store.verifyApprovedBaseline(runId);
    const baselineBytesByCase =
      input.ui_evidence_source === "approved_store"
        ? approvedBaseline.png_bytes_by_case
        : input.baseline_png_bytes_by_case;
    if (baselineBytesByCase === undefined) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "combined UI bootstrap recovery has no approved baseline bytes",
      );
    }

    if (state === "executing") {
      const collecting = await this.advance(runId, "collecting");
      if (!collecting.accepted) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "combined UI bootstrap recovery could not enter collecting",
        );
      }
    }

    for (const browserCase of snapshot.ui_contract.browser_cases) {
      const screenshots = await this.runScreenshots(runId, {
        action_id: bootstrapActionId("screenshot", browserCase.id),
        case_id: browserCase.id,
      });
      if (!screenshots.ok) {
        continue;
      }
      const checklist =
        input.semantic_checklist_by_case?.[browserCase.id];
      const baselines = baselineBytesByCase[browserCase.id];
      if (checklist === undefined || baselines === undefined) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "combined UI bootstrap recovery input changed after validation",
        );
      }
      const semantic = await this.runSemanticReview(runId, {
        action_id: bootstrapActionId(
          "semantic-review",
          browserCase.id,
        ),
        case_id: browserCase.id,
        screenshot_paths: screenshots.value.images.map((image) =>
          path.join(snapshot.artifact_root, image.artifact.relative_path),
        ),
        checklist,
      });
      await this.runComparison(runId, {
        action_id: bootstrapActionId("comparison", browserCase.id),
        case_id: browserCase.id,
        actuals: screenshots.value.images.map((image) => ({
          evidence: image.evidence,
          png_bytes: image.png_bytes,
        })),
        baseline_png_bytes: baselines,
        semantic_review_outcome: semantic.ok
          ? semantic.value.outcome
          : null,
      });
    }

    for (const task of snapshot.ui_contract.agentic_tasks) {
      await this.runAction(runId, {
        action_id: bootstrapActionId("agentic", task.id),
        kind: "agentic_browser",
        lane: "ui",
        check_id: task.id,
        input: {
          task_id: task.id,
          deterministic_recheck_available: false,
        },
        adapter: async () => ({
          ok: false,
          code: "CAPABILITY_UNAVAILABLE",
          capability: "agentic_browser",
          message:
            "agentic exploration is not restarted after the durable browser boundary",
        }),
      });
    }

    const deciding = await this.advance(runId, "deciding");
    if (!deciding.accepted) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "combined UI bootstrap recovery could not enter deciding",
      );
    }
    const terminal = await this.finalize(
      runId,
      deriveBootstrapLaneDecisions(
        await this.store.getRun(runId),
      ),
    );
    if (terminal.verification_state?.terminal_outcome !== "passed") {
      return terminal;
    }
    const pending = await this.advance(runId, "pm_review_pending");
    if (!pending.accepted) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "combined UI bootstrap recovery could not enter PM review pending",
      );
    }
    return pending.run;
  }

  async beginOriginalPmReview(runId: string): Promise<RunRecord> {
    const current = await this.store.assertCurrentVerification(
      runId,
      this.#authority,
    );
    if (
      current.verification_state?.current_state !== "pm_review_pending" ||
      current.verification_state.terminal_outcome !== "passed"
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "original PM review requires one complete passed verification handoff",
      );
    }
    const reviewed = await this.advance(runId, "original_pm_review");
    if (!reviewed.accepted) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "complete verification handoff could not enter original PM review",
      );
    }
    return reviewed.run;
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
        const submitCapability = async (
          demand: (typeof demands)[number],
          capability: VerificationCapabilityProbeResult,
          phase: "discovery" | "readiness",
        ): Promise<void> => {
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
              phase,
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
        };
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

        for (const demand of demands) {
          const capability = capabilities.get(demand.capability);
          if (capability === undefined) {
            throw new ArkTeamError(
              "INVALID_RECORD",
              `capability probe omitted ${demand.capability}`,
            );
          }
          await submitCapability(demand, capability, "discovery");
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
        const settledServer = capabilities.get("server");
        if (settledServer !== undefined) {
          for (const demand of demands.filter(
            (candidate) => candidate.capability === "server",
          )) {
            await submitCapability(demand, settledServer, "readiness");
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

  async runApiProbe(
    runId: string,
    input: RunVerificationApiProbeInput,
  ): Promise<VerificationActionResult<VerificationApiProbeValue>> {
    const parsedInput = parseApiProbeInput(input);
    const current = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(current);
    if (!snapshot.backend_contract.enabled) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "API probes cannot run when the backend lane is disabled",
      );
    }
    const backend = snapshot.backend_contract;
    const probe = backend.api_probes.find(
      (candidate) => candidate.id === parsedInput.probe_id,
    );
    if (probe === undefined) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "API probe is not declared in the immutable snapshot",
      );
    }
    const bodyBytes =
      parsedInput.body_base64 === undefined
        ? undefined
        : decodeCanonicalBase64(parsedInput.body_base64);
    const runtime = this.requireLocalRuntime();

    return this.runAction(runId, {
      action_id: parsedInput.action_id,
      kind: "api",
      lane: "backend",
      check_id: probe.id,
      input: {
        probe_id: probe.id,
        body_sha256:
          bodyBytes === undefined ? "none" : sha256Bytes(bodyBytes),
      },
      adapter: async (context) => {
        const registered = runtime.capability_adapters.api;
        if (
          runtime.execute_api === undefined ||
          registered.name !== backend.api_adapter ||
          registered.version !==
            backend.api_adapter_version
        ) {
          return {
            ok: false,
            code: "CAPABILITY_UNAVAILABLE",
            capability: "api",
            message: "registered API runtime does not match the snapshot",
          };
        }

        let request: VerificationApiRuntimeRequest;
        try {
          request = createVerificationApiRequest(
            snapshot,
            probe.id,
            bodyBytes,
          );
        } catch (error) {
          if (error instanceof VerificationApiAdapterError) {
            return {
              ok: false,
              code: error.code,
              message: error.message,
            };
          }
          throw error;
        }
        const rawResult = await runtime.execute_api(
          request,
          context.signal,
        );
        this.completeTimedEffect(context);
        const normalized = normalizeVerificationApiResult(request, rawResult);
        if (
          normalized.evidence.actual_status === null ||
          normalized.evidence.response_sha256 === null
        ) {
          return {
            ok: false,
            code: normalized.error_code ?? "INVALID_RECORD",
            message:
              normalized.message ??
              "registered API runtime returned incomplete evidence",
          };
        }

        const artifactToken = sha256CanonicalJson({
          action_id: parsedInput.action_id,
          attempt: this.attemptNumber(context),
          probe_id: probe.id,
        }).slice(0, 24);
        const evidenceBytes = canonicalJsonBytes(normalized.evidence);
        const evidenceArtifact = await this.writeArtifact(runId, {
          artifact_id: `api-evidence-${artifactToken}`,
          relative_path: `api/${probe.id}/${artifactToken}.json`,
          media_type: "application/json",
          bytes: evidenceBytes,
          sha256: sha256Bytes(evidenceBytes),
          lane: "backend",
        });
        const evidenceReference =
          verificationArtifactReference(evidenceArtifact);
        const payload = {
          kind: "request" as const,
          method: probe.method,
          path: probe.path,
          expected_status: probe.expected_status,
          actual_status: normalized.evidence.actual_status,
          request_sha256: normalized.evidence.request_sha256,
          response_sha256: normalized.evidence.response_sha256,
        };
        await context.submit({
          schema_version: 2,
          contract_id: "verification_contract_v2",
          record_id: `request-${artifactToken}`,
          record_type: "request",
          run_id: snapshot.run_id,
          case_id: snapshot.case_id,
          check_id: probe.id,
          snapshot_id: snapshot.snapshot_id,
          lane: "backend",
          stage: "executing",
          timestamp_utc: new Date().toISOString(),
          source_fingerprint: snapshot.source_fingerprint,
          package_fingerprint: snapshot.package.package_fingerprint,
          lane_required: backend.required,
          check_required: probe.required,
          previous_record_sha256: "0".repeat(64),
          payload_sha256: sha256CanonicalJson(payload),
          payload,
          adapter: {
            name: backend.api_adapter,
            version: backend.api_adapter_version,
          },
          model: null,
          artifact_references: [evidenceReference],
        });

        if (!normalized.passed) {
          return {
            ok: false,
            code: normalized.error_code ?? "API_CONTRACT_MISMATCH",
            message:
              normalized.message ?? "API response does not match the snapshot",
          };
        }
        return {
          ok: true,
          value: {
            evidence: normalized.evidence,
            evidence_artifact: evidenceReference,
          },
        };
      },
    });
  }

  async runBrowserCase(
    runId: string,
    input: RunVerificationBrowserCaseInput,
  ): Promise<VerificationActionResult<VerificationBrowserCaseValue>> {
    const parsedInput = parseBrowserCaseInput(input);
    const current = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(current);
    if (!snapshot.ui_contract.enabled) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "browser cases cannot run when the UI lane is disabled",
      );
    }
    const ui = snapshot.ui_contract;
    const browserCase = ui.browser_cases.find(
      (candidate) => candidate.id === parsedInput.case_id,
    );
    if (browserCase === undefined) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "browser case is not declared in the immutable snapshot",
      );
    }
    const runtime = this.requireLocalRuntime();

    return this.runAction(runId, {
      action_id: parsedInput.action_id,
      kind: "browser",
      lane: "ui",
      check_id: browserCase.id,
      input: { case_id: browserCase.id },
      ...(runtime.browser_contract === "v2-combined"
        ? { timeout_ms: snapshot.timeouts_ms.case_ms }
        : {}),
      adapter: async (context) => {
        const registered = runtime.capability_adapters.browser;
        if (
          runtime.execute_browser === undefined ||
          registered.name !== ui.deterministic_adapter ||
          registered.version !== ui.deterministic_adapter_version
        ) {
          return {
            ok: false,
            code: "CAPABILITY_UNAVAILABLE",
            capability: "browser",
            message: "registered browser runtime does not match the snapshot",
          };
        }

        const artifactToken = sha256CanonicalJson({
          action_id: parsedInput.action_id,
          attempt: this.attemptNumber(context),
          case_id: browserCase.id,
        }).slice(0, 24);
        try {
          const request =
            runtime.browser_contract === "v2-combined"
              ? createVerificationBrowserDriverV2Request({
                  snapshot,
                  case_id: browserCase.id,
                  attempt_id: `browser-${artifactToken}`,
                })
              : createVerificationBrowserDriverRequest({
                  snapshot,
                  case_id: browserCase.id,
                  attempt_id: `browser-${artifactToken}`,
                });
          const rawResult = await runtime.execute_browser(
            request,
            context.signal,
          );
          this.completeTimedEffect(context);
          let combined = null;
          let normalized;
          if (request.schema_version === 2) {
            combined = normalizeVerificationBrowserDriverV2Result(
              request,
              rawResult,
            );
            normalized = combined.browser;
          } else {
            normalized = normalizeVerificationBrowserDriverResult(
              request,
              rawResult,
            );
          }
          const traceArtifact = await this.writeArtifact(runId, {
            artifact_id: `browser-trace-${artifactToken}`,
            relative_path: request.trace.relative_path,
            media_type: request.trace.media_type,
            bytes: normalized.trace_bytes,
            sha256: sha256Bytes(normalized.trace_bytes),
            lane: "ui",
          });
          const evidenceBytes = canonicalJsonBytes(normalized.evidence);
          const evidenceArtifact = await this.writeArtifact(runId, {
            artifact_id: `browser-evidence-${artifactToken}`,
            relative_path: `browser/${browserCase.id}/${artifactToken}.json`,
            media_type: "application/json",
            bytes: evidenceBytes,
            sha256: sha256Bytes(evidenceBytes),
            lane: "ui",
          });
          const traceReference =
            verificationArtifactReference(traceArtifact);
          const evidenceReference =
            verificationArtifactReference(evidenceArtifact);
          const combinedReferences: VerificationArtifactReferenceValue[] = [];
          if (combined !== null) {
            const screenshotEvidenceBytes = canonicalJsonBytes(
              combined.screenshot.evidence,
            );
            combinedReferences.push(
              verificationArtifactReference(
                await this.writeArtifact(runId, {
                  artifact_id:
                    `combined-screenshot-evidence-${artifactToken}`,
                  relative_path:
                    `screenshots/${browserCase.id}/${artifactToken}.combined.json`,
                  media_type: "application/json",
                  bytes: screenshotEvidenceBytes,
                  sha256: sha256Bytes(screenshotEvidenceBytes),
                  lane: "ui",
                }),
              ),
            );
            for (const image of combined.screenshot.images) {
              combinedReferences.push(
                verificationArtifactReference(
                  await this.writeArtifact(runId, {
                    artifact_id:
                      `combined-screenshot-${artifactToken}-${image.evidence.viewport}`,
                    relative_path: image.evidence.relative_path,
                    media_type: "image/png",
                    bytes: image.png_bytes,
                    sha256: image.evidence.sha256,
                    lane: "ui",
                  }),
                ),
              );
            }
          }
          const payload = {
            kind: "browser" as const,
            case_sha256: request.case_sha256,
            action_count: request.actions.length,
            assertion_count: request.assertions.length,
          };
          await context.submit({
            schema_version: 2,
            contract_id: "verification_contract_v2",
            record_id: `browser-${artifactToken}`,
            record_type: "browser",
            run_id: snapshot.run_id,
            case_id: snapshot.case_id,
            check_id: browserCase.id,
            snapshot_id: snapshot.snapshot_id,
            lane: "ui",
            stage: "executing",
            timestamp_utc: new Date().toISOString(),
            source_fingerprint: snapshot.source_fingerprint,
            package_fingerprint: snapshot.package.package_fingerprint,
            lane_required: ui.required,
            check_required: browserCase.required,
            previous_record_sha256: "0".repeat(64),
            payload_sha256: sha256CanonicalJson(payload),
            payload,
            adapter: {
              name: ui.deterministic_adapter,
              version: ui.deterministic_adapter_version,
            },
            model: null,
            artifact_references: [
              evidenceReference,
              traceReference,
              ...combinedReferences,
            ],
          });

          if (!normalized.passed) {
            return {
              ok: false,
              code: "BROWSER_CONTRACT_MISMATCH",
              message:
                normalized.message ||
                "browser result does not match the snapshot",
            };
          }
          return {
            ok: true,
            value: {
              evidence: normalized.evidence,
              evidence_artifact: evidenceReference,
              trace_artifact: traceReference,
            },
          };
        } catch (error) {
          if (error instanceof VerificationBrowserContractError) {
            return {
              ok: false,
              code: error.code,
              message: error.message,
            };
          }
          throw error;
        }
      },
    });
  }

  async runScreenshots(
    runId: string,
    input: RunVerificationScreenshotInput,
  ): Promise<VerificationActionResult<VerificationScreenshotValue>> {
    const parsedInput = parseVisualCaseInput(input, "screenshot");
    const current = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(current);
    const ui = requireEnabledUiContract(snapshot);
    const browserCase = requireUiBrowserCase(snapshot, parsedInput.case_id);
    requireSucceededCheckAction(current, "browser", browserCase.id);
    const runtime = this.requireLocalRuntime();

    return this.runAction(runId, {
      action_id: parsedInput.action_id,
      kind: "screenshot",
      lane: "ui",
      check_id: browserCase.id,
      input: { case_id: browserCase.id },
      adapter: async (context) => {
        const registeredBrowser = runtime.capability_adapters.browser;
        const registeredScreenshot = runtime.capability_adapters.screenshot;
        if (
          registeredBrowser.name !== ui.deterministic_adapter ||
          registeredBrowser.version !==
            ui.deterministic_adapter_version ||
          registeredScreenshot.name !== registeredBrowser.name ||
          registeredScreenshot.version !== registeredBrowser.version ||
          (runtime.browser_contract !== "v2-combined" &&
            runtime.execute_screenshots === undefined)
        ) {
          return {
            ok: false,
            code: "CAPABILITY_UNAVAILABLE",
            capability: "screenshot",
            message: "registered screenshot runtime does not match the snapshot",
          };
        }
        try {
          const artifactToken = sha256CanonicalJson({
            action_id: parsedInput.action_id,
            attempt: this.attemptNumber(context),
            case_id: browserCase.id,
          }).slice(0, 24);
          if (runtime.browser_contract === "v2-combined") {
            const browserRecord = requireCombinedBrowserRecord(
              current,
              browserCase.id,
            );
            const browserArtifactToken =
              browserRecord.record_id.slice("browser-".length);
            const evidenceReference = requireOwnedArtifactReference(
              browserRecord,
              `combined-screenshot-evidence-${browserArtifactToken}`,
            );
            const evidenceRegistration = requireArtifactRegistration(
              current,
              evidenceReference,
              "application/json",
            );
            const evidenceFile =
              await this.store.readVerificationArtifact(runId, {
                reference: evidenceReference,
                media_type: "application/json",
                byte_length: evidenceRegistration.byte_length,
              });
            const stagedEvidence = parseCombinedScreenshotEvidence(
              evidenceFile.bytes,
            );
            const request = createVerificationBrowserDriverV2Request({
              snapshot,
              case_id: browserCase.id,
              attempt_id: stagedEvidence.attempt_id,
            });
            const expectation =
              createVerificationScreenshotRuntimeV2Expectation({
                plan: request.screenshot,
                final_url: stagedEvidence.url,
              });
            const rawImages: VerificationScreenshotRuntimeV2Result["screenshots"][number][] =
              [];
            for (const [index, capture] of expectation.captures.entries()) {
              const reference = requireOwnedArtifactReference(
                browserRecord,
                `combined-screenshot-${browserArtifactToken}-${capture.viewport}`,
              );
              const registration = requireArtifactRegistration(
                current,
                reference,
                "image/png",
              );
              const file = await this.store.readVerificationArtifact(
                runId,
                {
                  reference,
                  media_type: "image/png",
                  byte_length: registration.byte_length,
                },
              );
              const image = stagedEvidence.screenshots[index];
              if (image === undefined) {
                throw new ArkTeamError(
                  "INVALID_RECORD",
                  "combined screenshot evidence omits a fixed viewport",
                );
              }
              rawImages.push({
                sequence: image.sequence,
                viewport: image.viewport,
                width: image.width,
                height: image.height,
                device_scale_factor: image.device_scale_factor,
                url: image.url,
                relative_path: image.relative_path,
                media_type: image.media_type,
                captured_at_utc: image.captured_at_utc,
                byte_length: image.byte_length,
                sha256: image.sha256,
                capture: { ...image.capture },
                bytes: file.bytes,
              });
            }
            const normalized =
              normalizeVerificationScreenshotRuntimeV2Result(
                expectation,
                {
                  schema_version: 2,
                  contract_id:
                    "verification_screenshot_runtime_result_v2",
                  run_id: stagedEvidence.run_id,
                  snapshot_id: stagedEvidence.snapshot_id,
                  case_id: stagedEvidence.case_id,
                  attempt_id: stagedEvidence.attempt_id,
                  case_sha256: stagedEvidence.case_sha256,
                  package_fingerprint:
                    stagedEvidence.package_fingerprint,
                  source_fingerprint: stagedEvidence.source_fingerprint,
                  adapter: { ...stagedEvidence.adapter },
                  browser_build: stagedEvidence.browser_build,
                  origin: stagedEvidence.origin,
                  url: stagedEvidence.url,
                  screenshots: rawImages,
                },
              );
            this.completeTimedEffect(context);
            const imageArtifacts: VerificationScreenshotValue["images"] =
              [];
            for (const [index, image] of normalized.images.entries()) {
              const artifact = requireOwnedArtifactReference(
                browserRecord,
                `combined-screenshot-${browserArtifactToken}-${image.evidence.viewport}`,
              );
              imageArtifacts.push({
                evidence: image.evidence,
                artifact,
                png_bytes: Uint8Array.from(image.png_bytes),
              });
              const payload = {
                kind: "screenshot" as const,
                viewport: image.evidence.viewport,
                width: image.evidence.width,
                height: image.evidence.height,
                image_sha256: image.evidence.sha256,
              };
              await context.submit({
                schema_version: 2,
                contract_id: "verification_contract_v2",
                record_id:
                  `screenshot-${artifactToken}-${image.evidence.viewport}`,
                record_type: "screenshot",
                run_id: snapshot.run_id,
                case_id: snapshot.case_id,
                check_id: browserCase.id,
                snapshot_id: snapshot.snapshot_id,
                lane: "ui",
                stage: "collecting",
                timestamp_utc: image.evidence.captured_at_utc,
                source_fingerprint: snapshot.source_fingerprint,
                package_fingerprint:
                  snapshot.package.package_fingerprint,
                lane_required: ui.required,
                check_required: browserCase.required,
                previous_record_sha256: "0".repeat(64),
                payload_sha256: sha256CanonicalJson(payload),
                payload,
                adapter: { ...expectation.adapter },
                model: null,
                artifact_references: [
                  imageArtifacts[index]!.artifact,
                  evidenceReference,
                ],
              });
            }
            return {
              ok: true,
              value: {
                evidence: normalized.evidence,
                evidence_artifact: evidenceReference,
                images: imageArtifacts,
              },
            };
          }
          const request = createVerificationScreenshotRequest({
            snapshot,
            case_id: browserCase.id,
            attempt_id: `screenshot-${artifactToken}`,
          });
          const rawResult = await runtime.execute_screenshots!(
            request,
            context.signal,
          );
          this.completeTimedEffect(context);
          const normalized = normalizeVerificationScreenshotResult(
            request,
            rawResult,
          );
          const imageArtifacts: VerificationScreenshotValue["images"] = [];
          for (const image of normalized.images) {
            const persisted = await this.writeArtifact(runId, {
              artifact_id:
                `screenshot-${artifactToken}-${image.evidence.viewport}`,
              relative_path: image.evidence.relative_path,
              media_type: "image/png",
              bytes: image.png_bytes,
              sha256: image.evidence.sha256,
              lane: "ui",
            });
            imageArtifacts.push({
              evidence: image.evidence,
              artifact: verificationArtifactReference(persisted),
              png_bytes: Uint8Array.from(image.png_bytes),
            });
          }
          const evidenceBytes = canonicalJsonBytes(normalized.evidence);
          const evidenceArtifact = verificationArtifactReference(
            await this.writeArtifact(runId, {
              artifact_id: `screenshot-evidence-${artifactToken}`,
              relative_path:
                `screenshots/${browserCase.id}/${artifactToken}.json`,
              media_type: "application/json",
              bytes: evidenceBytes,
              sha256: sha256Bytes(evidenceBytes),
              lane: "ui",
            }),
          );
          for (const image of imageArtifacts) {
            const payload = {
              kind: "screenshot" as const,
              viewport: image.evidence.viewport,
              width: image.evidence.width,
              height: image.evidence.height,
              image_sha256: image.evidence.sha256,
            };
            await context.submit({
              schema_version: 2,
              contract_id: "verification_contract_v2",
              record_id:
                `screenshot-${artifactToken}-${image.evidence.viewport}`,
              record_type: "screenshot",
              run_id: snapshot.run_id,
              case_id: snapshot.case_id,
              check_id: browserCase.id,
              snapshot_id: snapshot.snapshot_id,
              lane: "ui",
              stage: "collecting",
              timestamp_utc: image.evidence.captured_at_utc,
              source_fingerprint: snapshot.source_fingerprint,
              package_fingerprint: snapshot.package.package_fingerprint,
              lane_required: ui.required,
              check_required: browserCase.required,
              previous_record_sha256: "0".repeat(64),
              payload_sha256: sha256CanonicalJson(payload),
              payload,
              adapter: { ...request.adapter },
              model: null,
              artifact_references: [image.artifact, evidenceArtifact],
            });
          }
          return {
            ok: true,
            value: {
              evidence: normalized.evidence,
              evidence_artifact: evidenceArtifact,
              images: imageArtifacts,
            },
          };
        } catch (error) {
          if (error instanceof VerificationVisualContractError) {
            return {
              ok: false,
              code: error.code,
              message: error.message,
            };
          }
          throw error;
        }
      },
    });
  }

  async runSemanticReview(
    runId: string,
    input: RunVerificationSemanticReviewInput,
  ): Promise<VerificationActionResult<VerificationSemanticReviewValue>> {
    const parsedInput = parseSemanticReviewInput(input);
    const current = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(current);
    const ui = requireEnabledUiContract(snapshot);
    const browserCase = requireUiBrowserCase(snapshot, parsedInput.case_id);
    requireSucceededCheckAction(current, "screenshot", browserCase.id);
    const runtime = this.requireLocalRuntime();
    const screenshotPaths = [...parsedInput.screenshot_paths];
    const checklist = structuredClone(parsedInput.checklist);

    return this.runAction(runId, {
      action_id: parsedInput.action_id,
      kind: "semantic_review",
      lane: "ui",
      check_id: browserCase.id,
      input: {
        case_id: browserCase.id,
        screenshot_paths: screenshotPaths,
        checklist,
      },
      adapter: async (context) => {
        const activeTurnSignal = runtime.semantic_review_active_turn?.() ?? null;
        const registered = runtime.capability_adapters.semantic_review;
        if (
          runtime.execute_semantic_review === undefined ||
          activeTurnSignal === null ||
          activeTurnSignal.adapter.name !== registered.name ||
          activeTurnSignal.adapter.version !== registered.version
        ) {
          return {
            ok: false,
            code: "CAPABILITY_UNAVAILABLE",
            capability: "semantic_review",
            message: "active-turn localImage runtime signal is unavailable",
          };
        }
        try {
          const request = await createVerificationSemanticReviewRequest({
            snapshot,
            screenshot_paths: screenshotPaths,
            checklist,
            active_turn_signal: activeTurnSignal,
          });
          assertReviewImagesArePersisted(current, snapshot, request);
          const rawResult = await runtime.execute_semantic_review(
            request,
            context.signal,
          );
          this.completeTimedEffect(context);
          const normalized = normalizeVerificationSemanticReviewResult(
            request,
            rawResult,
          );
          const artifactToken = sha256CanonicalJson({
            action_id: parsedInput.action_id,
            attempt: this.attemptNumber(context),
            case_id: browserCase.id,
          }).slice(0, 24);
          const evidenceBytes = canonicalJsonBytes(normalized.evidence);
          const evidenceArtifact = verificationArtifactReference(
            await this.writeArtifact(runId, {
              artifact_id: `semantic-review-${artifactToken}`,
              relative_path:
                `screenshots/${browserCase.id}/${artifactToken}.review.json`,
              media_type: "application/json",
              bytes: evidenceBytes,
              sha256: sha256Bytes(evidenceBytes),
              lane: "ui",
            }),
          );
          for (const image of request.images) {
            const payload = {
              kind: "review" as const,
              outcome:
                normalized.evidence.outcome === "approved"
                  ? ("passed" as const)
                  : normalized.evidence.outcome === "rejected"
                    ? ("failed" as const)
                    : ("error" as const),
              image_sha256: image.sha256,
            };
            await context.submit({
              schema_version: 2,
              contract_id: "verification_contract_v2",
              record_id:
                `review-${artifactToken}-${image.sha256.slice(0, 12)}`,
              record_type: "review",
              run_id: snapshot.run_id,
              case_id: snapshot.case_id,
              check_id: browserCase.id,
              snapshot_id: snapshot.snapshot_id,
              lane: "ui",
              stage: "collecting",
              timestamp_utc: normalized.evidence.reviewed_at_utc,
              source_fingerprint: snapshot.source_fingerprint,
              package_fingerprint: snapshot.package.package_fingerprint,
              lane_required: ui.required,
              check_required: browserCase.required,
              previous_record_sha256: "0".repeat(64),
              payload_sha256: sha256CanonicalJson(payload),
              payload,
              adapter: { ...request.identity.adapter },
              model: null,
              artifact_references: [evidenceArtifact],
            });
          }
          if (!normalized.approved) {
            return {
              ok: false,
              code: normalized.error_code ?? "IMAGE_REVIEW_REJECTED",
              message: normalized.message ?? "semantic review was not approved",
            };
          }
          return {
            ok: true,
            value: {
              evidence: normalized.evidence,
              evidence_artifact: evidenceArtifact,
              outcome: normalized.evidence.outcome,
            },
          };
        } catch (error) {
          if (error instanceof VerificationSemanticReviewUnavailableError) {
            return {
              ok: false,
              code: error.code,
              capability: "semantic_review",
              message: error.message,
            };
          }
          if (error instanceof VerificationSemanticReviewContractError) {
            return {
              ok: false,
              code: error.code,
              message: error.message,
            };
          }
          throw error;
        }
      },
    });
  }

  async runComparison(
    runId: string,
    input: RunVerificationComparisonInput,
  ): Promise<VerificationActionResult<VerificationComparisonValue>> {
    const parsedInput = parseComparisonInput(input);
    const current = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(current);
    const ui = requireEnabledUiContract(snapshot);
    const browserCase = requireUiBrowserCase(snapshot, parsedInput.case_id);
    requireSucceededCheckAction(current, "screenshot", browserCase.id);
    const actuals = parsedInput.actuals.map((actual) => ({
      evidence: structuredClone(actual.evidence),
      png_bytes: Uint8Array.from(actual.png_bytes),
      artifact: requirePersistedArtifact(
        current,
        actual.evidence.relative_path,
        actual.evidence.sha256,
        "image/png",
      ),
    }));
    if (
      actuals
        .map((actual) => actual.evidence.viewport)
        .sort()
        .join("\0") !==
      ["1440x900", "375x812", "768x1024"].join("\0")
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "comparison requires the exact three screenshot viewports",
      );
    }
    const semanticReviewOutcome = resolveSemanticReviewOutcome(
      current,
      browserCase.id,
      actuals.map((actual) => actual.evidence.sha256),
      parsedInput.semantic_review_outcome,
      ui.semantic_review_required,
    );
    const baselineBytes = {
      "375x812": Uint8Array.from(
        parsedInput.baseline_png_bytes["375x812"],
      ),
      "768x1024": Uint8Array.from(
        parsedInput.baseline_png_bytes["768x1024"],
      ),
      "1440x900": Uint8Array.from(
        parsedInput.baseline_png_bytes["1440x900"],
      ),
    };
    const runtime = this.requireLocalRuntime();

    return this.runAction(runId, {
      action_id: parsedInput.action_id,
      kind: "comparison",
      lane: "ui",
      check_id: browserCase.id,
      input: {
        case_id: browserCase.id,
        actual_sha256: Object.fromEntries(
          actuals.map((actual) => [
            actual.evidence.viewport,
            sha256Bytes(actual.png_bytes),
          ]),
        ),
        baseline_sha256: Object.fromEntries(
          Object.entries(baselineBytes).map(([viewport, bytes]) => [
            viewport,
            sha256Bytes(bytes),
          ]),
        ),
        semantic_review_outcome: semanticReviewOutcome,
      },
      adapter: async (context) => {
        const registered = runtime.capability_adapters.comparison;
        try {
          const baseline = await this.store.verifyApprovedBaseline(runId);
          const comparisons: VerificationComparisonValue["comparisons"] = [];
          const failures: string[] = [];
          for (const actual of actuals) {
            const viewport = actual.evidence.viewport;
            const compared = compareVerificationPngs({
              snapshot,
              case_id: browserCase.id,
              viewport,
              baseline: {
                manifest: baseline.manifest,
                manifest_sha256: baseline.manifest_sha256,
                baseline_set_sha256: baseline.baseline_set_sha256,
                png_bytes: baselineBytes[viewport],
              },
              actual: {
                evidence: actual.evidence,
                png_bytes: actual.png_bytes,
              },
              semantic_review_outcome: semanticReviewOutcome,
            });
            const artifactToken = sha256CanonicalJson({
              action_id: parsedInput.action_id,
              attempt: this.attemptNumber(context),
              case_id: browserCase.id,
              viewport,
            }).slice(0, 24);
            const diffArtifact = verificationArtifactReference(
              await this.writeArtifact(runId, {
                artifact_id: `comparison-diff-${artifactToken}`,
                relative_path: compared.evidence.diff_path,
                media_type: "image/png",
                bytes: compared.diff_png_bytes,
                sha256: compared.evidence.diff_sha256,
                lane: "ui",
              }),
            );
            const evidenceBytes = canonicalJsonBytes(compared.evidence);
            const evidenceArtifact = verificationArtifactReference(
              await this.writeArtifact(runId, {
                artifact_id: `comparison-evidence-${artifactToken}`,
                relative_path:
                  `diffs/${browserCase.id}/${viewport}.${artifactToken}.json`,
                media_type: "application/json",
                bytes: evidenceBytes,
                sha256: sha256Bytes(evidenceBytes),
                lane: "ui",
              }),
            );
            const payload = {
              kind: "comparison" as const,
              outcome: compared.passed
                ? ("passed" as const)
                : ("failed" as const),
              baseline_sha256: compared.evidence.baseline_sha256,
              actual_sha256: compared.evidence.actual_sha256,
              diff_sha256: compared.evidence.diff_sha256,
            };
            await context.submit({
              schema_version: 2,
              contract_id: "verification_contract_v2",
              record_id: `comparison-${artifactToken}`,
              record_type: "comparison",
              run_id: snapshot.run_id,
              case_id: snapshot.case_id,
              check_id: browserCase.id,
              snapshot_id: snapshot.snapshot_id,
              lane: "ui",
              stage: "collecting",
              timestamp_utc: new Date().toISOString(),
              source_fingerprint: snapshot.source_fingerprint,
              package_fingerprint: snapshot.package.package_fingerprint,
              lane_required: ui.required,
              check_required: browserCase.required,
              previous_record_sha256: "0".repeat(64),
              payload_sha256: sha256CanonicalJson(payload),
              payload,
              adapter: { ...registered },
              model: null,
              artifact_references: [
                actual.artifact,
                diffArtifact,
                evidenceArtifact,
              ],
            });
            comparisons.push({
              evidence: compared.evidence,
              evidence_artifact: evidenceArtifact,
              diff_artifact: diffArtifact,
            });
            if (!compared.passed) {
              failures.push(`${viewport}: ${compared.message}`);
            }
          }
          if (failures.length > 0) {
            return {
              ok: false,
              code: "COMPARISON_THRESHOLD_FAILED",
              message: failures.join("; "),
            };
          }
          return {
            ok: true,
            value: { comparisons },
          };
        } catch (error) {
          if (error instanceof VerificationVisualContractError) {
            return {
              ok: false,
              code: error.code,
              message: error.message,
            };
          }
          throw error;
        }
      },
    });
  }

  async runAgenticBrowser(
    runId: string,
    input: RunVerificationAgenticBrowserInput,
  ): Promise<VerificationActionResult<VerificationAgenticBrowserValue>> {
    const parsedInput = parseAgenticBrowserInput(input);
    const current = await this.store.getRun(runId);
    const snapshot = requireV2Snapshot(current);
    const ui = requireEnabledUiContract(snapshot);
    const task = requireUiAgenticTask(snapshot, parsedInput.task_id);
    const recheckCase = requireAgenticRecheckCase(snapshot, task);
    requireSucceededCheckAction(current, "browser", recheckCase.id);
    const runtime = this.requireLocalRuntime();

    return this.runAction(runId, {
      action_id: parsedInput.action_id,
      kind: "agentic_browser",
      lane: "ui",
      check_id: task.id,
      input: { task_id: task.id, recheck_case_id: recheckCase.id },
      adapter: async (context) => {
        const registeredAgentic =
          runtime.capability_adapters.agentic_browser;
        const registeredBrowser = runtime.capability_adapters.browser;
        if (
          runtime.execute_agentic_browser === undefined ||
          registeredAgentic.name !== task.adapter ||
          registeredAgentic.version !== task.adapter_version
        ) {
          return {
            ok: false,
            code: "CAPABILITY_UNAVAILABLE",
            capability: "agentic_browser",
            message: "registered agentic runtime does not match the snapshot",
          };
        }
        if (
          runtime.execute_browser === undefined ||
          registeredBrowser.name !== ui.deterministic_adapter ||
          registeredBrowser.version !== ui.deterministic_adapter_version
        ) {
          return {
            ok: false,
            code: "CAPABILITY_UNAVAILABLE",
            capability: "browser",
            message:
              "registered deterministic browser recheck does not match the snapshot",
          };
        }
        try {
          const artifactToken = sha256CanonicalJson({
            action_id: parsedInput.action_id,
            attempt: this.attemptNumber(context),
            task_id: task.id,
          }).slice(0, 24);
          const request = createVerificationAgenticBrowserRequest({
            snapshot,
            task_id: task.id,
            attempt_id: `agentic-${artifactToken}`,
          });
          const rawResult = await runtime.execute_agentic_browser(
            request,
            context.signal,
          );
          const normalized = normalizeVerificationAgenticBrowserResult(
            request,
            rawResult,
          );
          assertAgenticLedgerArtifactsPersisted(
            current,
            normalized.evidence,
          );
          const recheckRequest = createVerificationBrowserDriverRequest({
            snapshot,
            case_id: recheckCase.id,
            attempt_id: `recheck-${artifactToken}`,
          });
          const rawRecheck = await runtime.execute_browser(
            recheckRequest,
            context.signal,
          );
          this.completeTimedEffect(context);
          const recheck = normalizeVerificationBrowserDriverResult(
            recheckRequest,
            rawRecheck,
          );
          const ledgerArtifact = verificationArtifactReference(
            await this.writeArtifact(runId, {
              artifact_id: `agentic-ledger-${artifactToken}`,
              relative_path: `agentic/${task.id}/actions.jsonl`,
              media_type: "application/x-ndjson",
              bytes: normalized.ledger_bytes,
              sha256: normalized.evidence.ledger_sha256,
              lane: "ui",
            }),
          );
          const recheckTraceArtifact = verificationArtifactReference(
            await this.writeArtifact(runId, {
              artifact_id: `agentic-recheck-trace-${artifactToken}`,
              relative_path: recheckRequest.trace.relative_path,
              media_type: recheckRequest.trace.media_type,
              bytes: recheck.trace_bytes,
              sha256: sha256Bytes(recheck.trace_bytes),
              lane: "ui",
            }),
          );
          const recheckEvidenceBytes = canonicalJsonBytes(
            recheck.evidence,
          );
          const recheckEvidenceArtifact = verificationArtifactReference(
            await this.writeArtifact(runId, {
              artifact_id: `agentic-recheck-evidence-${artifactToken}`,
              relative_path:
                `agentic/${task.id}/deterministic-recheck.json`,
              media_type: "application/json",
              bytes: recheckEvidenceBytes,
              sha256: sha256Bytes(recheckEvidenceBytes),
              lane: "ui",
            }),
          );
          const authoritativeEvidence: VerificationAgenticBrowserEvidence = {
            ...normalized.evidence,
            deterministic_recheck: {
              required: true,
              status: recheck.passed ? "passed" : "failed",
              evidence_sha256: recheckEvidenceArtifact.sha256,
              trace_sha256: recheckTraceArtifact.sha256,
            },
          };
          const resultBytes = canonicalJsonBytes(authoritativeEvidence);
          const resultArtifact = verificationArtifactReference(
            await this.writeArtifact(runId, {
              artifact_id: `agentic-result-${artifactToken}`,
              relative_path: `agentic/${task.id}/result.json`,
              media_type: "application/json",
              bytes: resultBytes,
              sha256: sha256Bytes(resultBytes),
              lane: "ui",
            }),
          );
          const payload = {
            kind: "agentic_browser" as const,
            execution_status: authoritativeEvidence.execution_status,
            finding_status: authoritativeEvidence.finding_status,
            ...(authoritativeEvidence.self_verdict === undefined
              ? {}
              : { self_verdict: authoritativeEvidence.self_verdict }),
            ...(authoritativeEvidence.judge_verdict === undefined
              ? {}
              : { judge_verdict: authoritativeEvidence.judge_verdict }),
            findings: [...authoritativeEvidence.findings],
            input_sha256: authoritativeEvidence.input_sha256,
            ledger_sha256: authoritativeEvidence.ledger_sha256,
            step_count: authoritativeEvidence.step_count,
          };
          await context.submit({
            schema_version: 2,
            contract_id: "verification_contract_v2",
            record_id: `agentic-${artifactToken}`,
            record_type: "agentic_browser",
            run_id: snapshot.run_id,
            case_id: snapshot.case_id,
            check_id: task.id,
            snapshot_id: snapshot.snapshot_id,
            lane: "ui",
            stage: "collecting",
            timestamp_utc: authoritativeEvidence.finished_at_utc,
            source_fingerprint: snapshot.source_fingerprint,
            package_fingerprint: snapshot.package.package_fingerprint,
            lane_required: ui.required,
            check_required: false,
            previous_record_sha256: "0".repeat(64),
            payload_sha256: sha256CanonicalJson(payload),
            payload,
            adapter: {
              name: task.adapter,
              version: task.adapter_version,
            },
            model: { identity: task.model_identity },
            artifact_references: [
              ledgerArtifact,
              resultArtifact,
              recheckEvidenceArtifact,
              recheckTraceArtifact,
            ],
          });
          if (!recheck.passed) {
            return {
              ok: false,
              code: "BROWSER_CONTRACT_MISMATCH",
              message:
                recheck.message ||
                "agentic postconditions failed deterministic recheck",
            };
          }
          return {
            ok: true,
            value: {
              evidence: authoritativeEvidence,
              ledger_artifact: ledgerArtifact,
              result_artifact: resultArtifact,
            },
          };
        } catch (error) {
          if (
            error instanceof VerificationAgenticBrowserContractError ||
            error instanceof VerificationBrowserContractError
          ) {
            return {
              ok: false,
              code: error.code,
              message: error.message,
            };
          }
          throw error;
        }
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
      const durableAttemptNumber =
        reservation.run.verification_state?.attempts.find(
          (candidate) => candidate.action_id === options.action_id,
        )?.attempt_count;
      if (
        durableAttemptNumber === undefined ||
        !Number.isInteger(durableAttemptNumber) ||
        durableAttemptNumber < 1 ||
        durableAttemptNumber > attemptLimit
      ) {
        throw new ArkTeamError(
          "CORRUPT_STATE",
          "reserved verification attempt has no durable attempt number",
        );
      }

      const attemptEvidenceIds: string[] = [];
      const controller = new AbortController();
      const deadline = new VerificationActionDeadline(controller);
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
      this.attemptNumbers.set(context, durableAttemptNumber);
      this.attemptDeadlines.set(context, deadline);

      let attemptResult: VerificationAdapterAttemptResult<TValue>;
      try {
        attemptResult = await raceAction(
          () => actionAdapter(context),
          timeoutMs,
          deadline,
        );
      } catch (error) {
        attemptResult = normalizeActionFailure(error);
      } finally {
        active = false;
        controller.abort();
        this.attemptNumbers.delete(context);
        this.attemptDeadlines.delete(context);
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

  private attemptNumber<TInput>(
    context: VerificationAdapterContext<TInput>,
  ): number {
    const attemptNumber = this.attemptNumbers.get(context);
    if (
      attemptNumber === undefined ||
      !Number.isInteger(attemptNumber) ||
      attemptNumber < 1
    ) {
      throw new ArkTeamError(
        "CORRUPT_STATE",
        "verification adapter has no durable attempt number",
      );
    }
    return attemptNumber;
  }

  private completeTimedEffect<TInput>(
    context: VerificationAdapterContext<TInput>,
  ): void {
    const deadline = this.attemptDeadlines.get(context);
    if (deadline === undefined) {
      throw new ArkTeamError(
        "CORRUPT_STATE",
        "verification adapter has no active deadline",
      );
    }
    deadline.completeTimedEffect();
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

export class VerificationBootstrapPmGate {
  constructor(
    private readonly coordinator: VerificationCoordinator,
    private readonly inputResolver: (
      runId: string,
    ) => Promise<RunVerificationBootstrapInput>,
  ) {}

  async prepareOriginalPmReview(runId: string): Promise<RunRecord> {
    const current = await this.coordinator.getCurrentRun(runId);
    if (
      current.verification_state?.current_state === "original_pm_review" &&
      current.verification_state.terminal_outcome === "passed"
    ) {
      return current;
    }
    if (
      current.verification_state?.terminal_outcome !== null &&
      (current.verification_state?.current_state !== "pm_review_pending" ||
        current.verification_state.terminal_outcome !== "passed")
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "terminal local verification non-pass cannot be retried by the PM gate",
      );
    }
    if (current.verification_state?.current_state !== "pm_review_pending") {
      const input = await this.inputResolver(runId);
      if (
        current.verification_snapshot?.schema_version === 2 &&
        current.verification_state?.terminal_outcome === null &&
        ["executing", "collecting"].includes(
          current.verification_state.current_state,
        )
      ) {
        const resumed = await this.coordinator.resumeCombinedBootstrap(
          runId,
          input,
        );
        if (
          resumed.verification_state?.current_state !==
            "pm_review_pending" ||
          resumed.verification_state.terminal_outcome !== "passed"
        ) {
          throw new ArkTeamError(
            "INVALID_TRANSITION",
            "resumed local verification did not produce a passed PM handoff",
          );
        }
      } else {
        const result = await this.coordinator.runBootstrap(runId, input);
        if (
          result.status !== "completed" ||
          result.run.verification_state?.current_state !==
            "pm_review_pending"
        ) {
          throw new ArkTeamError(
            "INVALID_TRANSITION",
            "local verification did not produce a passed PM handoff",
          );
        }
      }
    }
    return this.coordinator.beginOriginalPmReview(runId);
  }
}

function verificationBootstrapInputProblem(
  run: RunRecord,
  input: RunVerificationBootstrapInput,
): RecordVerificationSpecDeltaInput | null {
  const affectedIds = [
    "OBJ-1709",
    "REQ-1719",
    "AC-1719",
    "TEST-1719",
    "IS-1707",
  ];
  const problem = (
    classification: RecordVerificationSpecDeltaInput["classification"],
    value: string,
    impact: string,
    resolution: string,
  ): RecordVerificationSpecDeltaInput => ({
    affected_ids: affectedIds,
    classification,
    evidence: [{ kind: "bootstrap_input", value }],
    impact,
    proposed_resolution: resolution,
    blocking_stage: "IS-1707",
  });
  if (
    run.verification_snapshot !== null ||
    run.verification_state?.current_state !== "integrated"
  ) {
    return problem(
      "contradiction",
      "BOOTSTRAP-1701 was requested for an already-started verification run",
      "a second bootstrap could reinterpret or repeat immutable work",
      "use exact recovery for a nonterminal snapshot or create a new run",
    );
  }
  const config = run.project_config.verification.coordinator;
  if (
    config === null ||
    config.schema_version !== 2 ||
    !config.enabled
  ) {
    return problem(
      "omission",
      "enabled verification_contract_v2 configuration is missing",
      "the bootstrap snapshot cannot resolve its QA lanes",
      "supply one approved enabled contract-v2 project configuration",
    );
  }
  try {
    parseReadinessInput({
      action_id: "bootstrap-readiness-input",
      server: input.server,
    });
  } catch {
    return problem(
      "unsafe_input",
      "registered local server declaration is invalid",
      "the local server cannot start within the approved host boundary",
      "supply one registered server declaration that satisfies the local contract",
    );
  }
  if (config.backend.enabled) {
    const bodyProbeIds = config.backend.api_probes
      .filter((probe) => probe.body_digest !== "none")
      .map((probe) => probe.id)
      .sort();
    const suppliedBodyIds = Object.keys(
      input.api_body_base64_by_probe ?? {},
    ).sort();
    if (
      bodyProbeIds.length !== suppliedBodyIds.length ||
      bodyProbeIds.some(
        (probeId, index) => probeId !== suppliedBodyIds[index],
      )
    ) {
      return problem(
        "omission",
        "API request bodies do not match the exact snapshotted probes",
        "declared Backend probes cannot reproduce their request bytes",
        "supply base64 bytes for exactly the probes with a non-empty body digest",
      );
    }
  } else if (
    Object.keys(input.api_body_base64_by_probe ?? {}).length !== 0
  ) {
    return problem(
      "contradiction",
      "Backend request bodies were supplied for a disabled lane",
      "disabled-lane work would be synthesized",
      "remove all Backend inputs for the disabled lane",
    );
  }
  if (config.ui.enabled) {
    const caseIds = config.ui.browser_cases.map((browserCase) =>
      browserCase.id,
    ).sort();
    const checklistIds = Object.keys(
      input.semantic_checklist_by_case ?? {},
    ).sort();
    const baselineIds = Object.keys(
      input.baseline_png_bytes_by_case ?? {},
    ).sort();
    if (
      caseIds.length !== checklistIds.length ||
      caseIds.some((caseId, index) => caseId !== checklistIds[index])
    ) {
      return problem(
        "omission",
        "UI checklist does not cover the exact browser cases",
        "semantic verification cannot reproduce every enabled case",
        "supply one checklist for each UI case",
      );
    }
    if (input.ui_evidence_source === "approved_store") {
      if (baselineIds.length !== 0) {
        return problem(
          "unsafe_input",
          "production UI bootstrap received injected baseline bytes",
          "caller-controlled bytes could replace the approved baseline",
          "remove injected baseline bytes and use only the approved store",
        );
      }
      return null;
    }
    if (
      input.ui_evidence_source !== undefined ||
      caseIds.length !== baselineIds.length ||
      caseIds.some((caseId, index) => caseId !== baselineIds[index])
    ) {
      return problem(
        "omission",
        "UI baseline bytes do not cover the exact browser cases",
        "deterministic visual verification cannot reproduce every enabled case",
        "supply the approved three baseline PNGs for each UI case",
      );
    }
    for (const caseId of caseIds) {
      const baselines = input.baseline_png_bytes_by_case?.[caseId];
      if (
        baselines === undefined ||
        !["375x812", "768x1024", "1440x900"].every(
          (viewport) =>
            baselines[viewport as VerificationBootstrapViewport] instanceof
              Uint8Array &&
            baselines[viewport as VerificationBootstrapViewport].byteLength >
              0,
        )
      ) {
        return problem(
          "omission",
          "UI baseline bytes omit an exact required viewport",
          "the three-viewport comparison matrix is incomplete",
          "supply non-empty approved PNG bytes for all three fixed viewports",
        );
      }
    }
  } else if (
    input.ui_evidence_source !== undefined ||
    Object.keys(input.semantic_checklist_by_case ?? {}).length !== 0 ||
    Object.keys(input.baseline_png_bytes_by_case ?? {}).length !== 0
  ) {
    return problem(
      "contradiction",
      "UI evidence inputs were supplied for a disabled lane",
      "disabled-lane work would be synthesized",
      "remove all UI inputs for the disabled lane",
    );
  }
  return null;
}

function bootstrapActionId(kind: string, identifier: string): string {
  return `bootstrap-${kind}-${sha256CanonicalJson({
    kind,
    identifier,
  }).slice(0, 24)}`;
}

function requireAcceptedVerificationTransition(
  transition: VerificationStateTransitionResult,
  expectedStage: VerificationStage,
): void {
  if (
    !transition.accepted ||
    transition.run.verification_state?.current_state !== expectedStage
  ) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      `BOOTSTRAP-1701 could not enter ${expectedStage}`,
    );
  }
}

function deriveBootstrapLaneDecisions(
  run: RunRecord,
): VerificationLaneDecisionInput[] {
  const snapshot = requireV2Snapshot(run);
  const attempts = run.verification_state?.attempts ?? [];
  const superseded = new Set(
    attempts.flatMap((attempt) =>
      attempt.evidence_record_ids.filter(
        (recordId) =>
          !attempt.decisive_evidence_record_ids.includes(recordId),
      ),
    ),
  );
  const lanes: Array<{
    lane: "backend" | "ui";
    checks: Array<{ id: string; required: boolean }>;
  }> = [
    ...(snapshot.backend_contract.enabled
      ? [
          {
            lane: "backend" as const,
            checks: snapshot.backend_contract.api_probes.map((probe) => ({
              id: probe.id,
              required: probe.required,
            })),
          },
        ]
      : []),
    ...(snapshot.ui_contract.enabled
      ? [
          {
            lane: "ui" as const,
            checks: [
              ...snapshot.ui_contract.browser_cases.map((browserCase) => ({
                id: browserCase.id,
                required: browserCase.required,
              })),
              ...snapshot.ui_contract.agentic_tasks.map((task) => ({
                id: task.id,
                required: task.required,
              })),
            ],
          },
        ]
      : []),
  ];
  return lanes.map((lane) => ({
    lane: lane.lane,
    checks: lane.checks.map((check) => {
      const matching = run.verification_records.filter(
        (
          record,
        ): record is Extract<
          VerificationLinkedRecord,
          { schema_version: 2 }
        > =>
          record.schema_version === 2 &&
          record.lane === lane.lane &&
          record.check_id === check.id &&
          !superseded.has(record.record_id) &&
          verificationEvidenceDisposition(record) !== null,
      );
      if (matching.length === 0) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          `BOOTSTRAP-1701 has no evidence for ${lane.lane}/${check.id}`,
        );
      }
      const dispositions = matching.flatMap((record) => {
        const disposition = verificationEvidenceDisposition(record);
        if (disposition === null) {
          return [];
        }
        const semanticActionId =
          record.payload.kind === "error"
            ? record.payload.action_id
            : undefined;
        const optionalSemantic =
          lane.lane === "ui" &&
          snapshot.ui_contract.enabled &&
          !snapshot.ui_contract.semantic_review_required &&
          (record.payload.kind === "review" ||
            (semanticActionId !== undefined &&
              attempts.some(
                (attempt) =>
                  attempt.action_id === semanticActionId &&
                  attempt.kind === "semantic_review",
              )));
        return optionalSemantic && !disposition.integrity_failure
          ? []
          : [disposition];
      });
      if (dispositions.length === 0) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          `BOOTSTRAP-1701 has no authoritative evidence for ${lane.lane}/${check.id}`,
        );
      }
      const integrityFailure = dispositions.some(
        (disposition) => disposition.integrity_failure,
      );
      return {
        check_id: check.id,
        required: check.required,
        outcome: integrityFailure
          ? ("error" as const)
          : aggregateBootstrapOutcomes(
              dispositions.map((disposition) => disposition.outcome),
            ),
        evidence_record_ids: matching
          .map((record) => record.record_id)
          .sort(),
        integrity_failure: integrityFailure,
      };
    }),
  }));
}

function aggregateBootstrapOutcomes(
  outcomes: readonly VerificationOutcome[],
): VerificationOutcome {
  for (const outcome of [
    "error",
    "unavailable",
    "failed",
    "skipped",
  ] as const) {
    if (outcomes.includes(outcome)) {
      return outcome;
    }
  }
  return "passed";
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
    !input.server.allowed_dev_origins.includes("devbox")
  ) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "Next.js local verification requires allowedDevOrigins to include devbox",
    );
  }
  return deepFreeze(structuredClone(input)) as RunVerificationReadinessInput;
}

function parseApiProbeInput(
  input: RunVerificationApiProbeInput,
): RunVerificationApiProbeInput {
  const expectedKeys =
    input?.body_base64 === undefined
      ? ["action_id", "probe_id"]
      : ["action_id", "probe_id", "body_base64"];
  if (
    !hasExactKeys(input, expectedKeys) ||
    typeof input.action_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.action_id) ||
    typeof input.probe_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.probe_id) ||
    (input.body_base64 !== undefined &&
      (typeof input.body_base64 !== "string" ||
        input.body_base64.length > 70 * 1_024 * 1_024))
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "API probe input is not a strict bounded descriptor",
    );
  }
  return structuredClone(input);
}

function parseBrowserCaseInput(
  input: RunVerificationBrowserCaseInput,
): RunVerificationBrowserCaseInput {
  if (
    !hasExactKeys(input, ["action_id", "case_id"]) ||
    typeof input.action_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.action_id) ||
    typeof input.case_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.case_id)
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "browser case input is not a strict bounded descriptor",
    );
  }
  return structuredClone(input);
}

function parseVisualCaseInput(
  input: RunVerificationScreenshotInput,
  label: string,
): RunVerificationScreenshotInput {
  if (
    !hasExactKeys(input, ["action_id", "case_id"]) ||
    typeof input.action_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.action_id) ||
    typeof input.case_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.case_id)
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      `${label} input is not a strict bounded descriptor`,
    );
  }
  return structuredClone(input);
}

function parseSemanticReviewInput(
  input: RunVerificationSemanticReviewInput,
): RunVerificationSemanticReviewInput {
  if (
    !hasExactKeys(input, [
      "action_id",
      "case_id",
      "checklist",
      "screenshot_paths",
    ]) ||
    typeof input.action_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.action_id) ||
    typeof input.case_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.case_id) ||
    !Array.isArray(input.screenshot_paths) ||
    input.screenshot_paths.length < 1 ||
    input.screenshot_paths.length > 3 ||
    input.screenshot_paths.some(
      (candidate) =>
        typeof candidate !== "string" ||
        candidate.length < 1 ||
        candidate.length > 4_096,
    ) ||
    !hasExactKeys(input.checklist, ["identity", "version"]) ||
    typeof input.checklist.identity !== "string" ||
    !IDENTIFIER_PATTERN.test(input.checklist.identity) ||
    typeof input.checklist.version !== "string" ||
    input.checklist.version.length < 1 ||
    input.checklist.version.length > 128
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "semantic-review input is not a strict bounded descriptor",
    );
  }
  return structuredClone(input);
}

function parseComparisonInput(
  input: RunVerificationComparisonInput,
): RunVerificationComparisonInput {
  if (
    !hasExactKeys(input, [
      "action_id",
      "actuals",
      "baseline_png_bytes",
      "case_id",
      "semantic_review_outcome",
    ]) ||
    typeof input.action_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.action_id) ||
    typeof input.case_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.case_id) ||
    !Array.isArray(input.actuals) ||
    input.actuals.length !== 3 ||
    input.actuals.some(
      (actual) =>
        !hasExactKeys(actual, ["evidence", "png_bytes"]) ||
        !(actual.png_bytes instanceof Uint8Array) ||
        actual.png_bytes.byteLength < 1 ||
        actual.png_bytes.byteLength > 50 * 1_024 * 1_024,
    ) ||
    !hasExactKeys(input.baseline_png_bytes, [
      "1440x900",
      "375x812",
      "768x1024",
    ]) ||
    Object.values(input.baseline_png_bytes).some(
      (bytes) =>
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > 50 * 1_024 * 1_024,
    ) ||
    ![
      null,
      "approved",
      "rejected",
      "blocked",
      "unavailable",
      "skipped",
    ].includes(input.semantic_review_outcome)
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "comparison input is not a strict bounded descriptor",
    );
  }
  return {
    ...structuredClone(input),
    actuals: input.actuals.map((actual) => ({
      evidence: structuredClone(actual.evidence),
      png_bytes: Uint8Array.from(actual.png_bytes),
    })),
    baseline_png_bytes: {
      "375x812": Uint8Array.from(input.baseline_png_bytes["375x812"]),
      "768x1024": Uint8Array.from(input.baseline_png_bytes["768x1024"]),
      "1440x900": Uint8Array.from(input.baseline_png_bytes["1440x900"]),
    },
  };
}

function parseAgenticBrowserInput(
  input: RunVerificationAgenticBrowserInput,
): RunVerificationAgenticBrowserInput {
  if (
    !hasExactKeys(input, ["action_id", "task_id"]) ||
    typeof input.action_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.action_id) ||
    typeof input.task_id !== "string" ||
    !IDENTIFIER_PATTERN.test(input.task_id)
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "agentic-browser input is not a strict bounded descriptor",
    );
  }
  return structuredClone(input);
}

function requireUiBrowserCase(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  caseId: string,
) {
  const ui = requireEnabledUiContract(snapshot);
  const browserCase = ui.browser_cases.find(
    (candidate) => candidate.id === caseId,
  );
  if (browserCase === undefined) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "visual verification targets an undeclared browser case",
    );
  }
  return browserCase;
}

function requireEnabledUiContract(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
) {
  if (!snapshot.ui_contract.enabled) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "UI verification requires an enabled UI lane",
    );
  }
  return snapshot.ui_contract;
}

function requireUiAgenticTask(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  taskId: string,
) {
  if (!snapshot.ui_contract.enabled) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "agentic verification requires an enabled UI lane",
    );
  }
  const task = snapshot.ui_contract.agentic_tasks.find(
    (candidate) => candidate.id === taskId,
  );
  if (task === undefined) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "agentic verification targets an undeclared task",
    );
  }
  return task;
}

function requireSucceededCheckAction(
  run: RunRecord,
  kind: VerificationActionKind,
  checkId: string,
): void {
  if (
    !run.verification_state?.attempts.some(
      (attempt) =>
        attempt.kind === kind &&
        attempt.check_id === checkId &&
        attempt.status === "succeeded",
    )
  ) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      `${kind} prerequisite has not succeeded for ${checkId}`,
    );
  }
}

function requireCombinedBrowserRecord(
  run: RunRecord,
  checkId: string,
): VerificationLinkedRecord {
  const attempt = run.verification_state?.attempts.find(
    (candidate) =>
      candidate.kind === "browser" &&
      candidate.check_id === checkId &&
      candidate.status === "succeeded",
  );
  if (attempt === undefined) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      `browser prerequisite has not succeeded for ${checkId}`,
    );
  }
  const decisive = new Set(attempt.decisive_evidence_record_ids);
  const matches = run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.record_type === "browser" &&
      record.payload.kind === "browser" &&
      record.check_id === checkId &&
      decisive.has(record.record_id) &&
      record.record_id.startsWith("browser-"),
  );
  if (matches.length !== 1) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "combined screenshot materialization requires one decisive browser record",
    );
  }
  return matches[0]!;
}

function requireOwnedArtifactReference(
  owner: VerificationLinkedRecord,
  artifactId: string,
): VerificationArtifactReferenceValue {
  const matches = owner.artifact_references.filter(
    (reference) => reference.artifact_id === artifactId,
  );
  if (matches.length !== 1) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      `combined browser evidence does not own ${artifactId}`,
    );
  }
  return { ...matches[0]! };
}

function requireArtifactRegistration(
  run: RunRecord,
  reference: VerificationArtifactReferenceValue,
  mediaType: "application/json" | "image/png",
): { byte_length: number } {
  const matches = run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.record_type === "artifact" &&
      record.payload.kind === "artifact" &&
      record.payload.artifact_id === reference.artifact_id &&
      record.payload.relative_path === reference.relative_path &&
      record.payload.sha256 === reference.sha256 &&
      record.payload.media_type === mediaType,
  );
  if (
    matches.length !== 1 ||
    matches[0]?.payload.kind !== "artifact"
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "combined screenshot artifact registration is missing or ambiguous",
    );
  }
  return { byte_length: matches[0].payload.byte_length };
}

function parseCombinedScreenshotEvidence(
  bytes: Uint8Array,
): VerificationScreenshotEvidence {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "combined screenshot evidence is not canonical UTF-8 JSON",
      { cause: error },
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { schema_version?: unknown }).schema_version !== 1 ||
    (parsed as { contract_id?: unknown }).contract_id !==
      "verification_screenshot_evidence_v1" ||
    typeof (parsed as { attempt_id?: unknown }).attempt_id !== "string" ||
    typeof (parsed as { url?: unknown }).url !== "string" ||
    !Array.isArray(
      (parsed as { screenshots?: unknown }).screenshots,
    ) ||
    (parsed as { screenshots: unknown[] }).screenshots.length !== 3 ||
    canonicalJson(parsed) !== text
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "combined screenshot evidence does not match its durable contract",
    );
  }
  return parsed as VerificationScreenshotEvidence;
}

function requireAgenticRecheckCase(
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  task: ReturnType<typeof requireUiAgenticTask>,
) {
  const ui = requireEnabledUiContract(snapshot);
  const browserCase = ui.browser_cases.find(
    (candidate) =>
      candidate.path === task.start_path &&
      sha256CanonicalJson(candidate.assertions) ===
        sha256CanonicalJson(task.success_criteria),
  );
  if (browserCase === undefined) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "agentic success criteria have no exact deterministic browser recheck",
    );
  }
  return browserCase;
}

function requirePersistedArtifact(
  run: RunRecord,
  relativePath: string,
  sha256: string,
  mediaType:
    | "image/png"
    | "application/json"
    | "application/x-ndjson"
    | "application/zip"
    | "text/plain",
): VerificationArtifactReferenceValue {
  const artifact = run.verification_records.find(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "artifact" &&
      record.payload.relative_path === relativePath &&
      record.payload.sha256 === sha256 &&
      record.payload.media_type === mediaType,
  );
  if (
    artifact?.schema_version !== 2 ||
    artifact.payload.kind !== "artifact"
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "visual input is not a persisted verification artifact",
    );
  }
  return {
    artifact_id: artifact.payload.artifact_id,
    relative_path: artifact.payload.relative_path,
    sha256: artifact.payload.sha256,
  };
}

function assertReviewImagesArePersisted(
  run: RunRecord,
  snapshot: VerificationRunSnapshot & { schema_version: 2 },
  request: VerificationSemanticReviewRequest,
): void {
  for (const image of request.images) {
    const relativePath = path.relative(snapshot.artifact_root, image.path);
    requirePersistedArtifact(
      run,
      relativePath.split(path.sep).join("/"),
      image.sha256,
      "image/png",
    );
  }
}

function resolveSemanticReviewOutcome(
  run: RunRecord,
  checkId: string,
  imageSha256s: readonly string[],
  requestedOutcome: VerificationSemanticReviewOutcome | null,
  required: boolean,
): VerificationSemanticReviewOutcome | null {
  const persistedOutcomes: VerificationSemanticReviewOutcome[] = [];
  for (const [outcome, recordOutcome] of [
    ["approved", "passed"],
    ["rejected", "failed"],
    ["blocked", "error"],
  ] as const) {
    const reviewedImages = new Set(
      run.verification_records.flatMap((record) =>
        record.schema_version === 2 &&
        record.record_type === "review" &&
        record.lane === "ui" &&
        record.check_id === checkId &&
        record.payload.kind === "review" &&
        record.payload.outcome === recordOutcome
          ? [record.payload.image_sha256]
          : [],
      ),
    );
    if (
      imageSha256s.length > 0 &&
      imageSha256s.every((sha256) => reviewedImages.has(sha256))
    ) {
      persistedOutcomes.push(outcome);
    }
  }
  if (
    run.verification_records.some(
      (record) =>
        record.schema_version === 2 &&
        record.record_type === "error" &&
        record.lane === "ui" &&
        record.check_id === checkId &&
        record.payload.kind === "error" &&
        record.payload.code === "CAPABILITY_UNAVAILABLE" &&
        record.payload.capability === "semantic_review",
    )
  ) {
    persistedOutcomes.push(required ? "unavailable" : "skipped");
  }
  const uniqueOutcomes = [...new Set(persistedOutcomes)];
  if (uniqueOutcomes.length > 1) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "semantic-review evidence has conflicting persisted outcomes",
    );
  }
  const persistedOutcome = uniqueOutcomes[0] ?? null;
  if (
    requestedOutcome !== null &&
    requestedOutcome !== persistedOutcome
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "semantic-review outcome does not match persisted evidence",
    );
  }
  if (
    requestedOutcome === "unavailable" ||
    requestedOutcome === "skipped"
  ) {
    if (requestedOutcome !== (required ? "unavailable" : "skipped")) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "semantic-review availability outcome has wrong requiredness",
      );
    }
  }
  return persistedOutcome;
}

function assertAgenticLedgerArtifactsPersisted(
  run: RunRecord,
  evidence: VerificationAgenticBrowserEvidence,
): void {
  for (const reference of evidence.ledger.flatMap(
    (entry) => entry.artifact_references,
  )) {
    if (
      !run.verification_records.some(
        (record) =>
          record.schema_version === 2 &&
          record.payload.kind === "artifact" &&
          record.payload.artifact_id === reference.artifact_id &&
          record.payload.relative_path === reference.relative_path &&
          record.payload.sha256 === reference.sha256,
      )
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "agentic ledger references an unpersisted artifact",
      );
    }
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "API request body is not canonical base64",
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "API request body is not canonical base64",
    );
  }
  return bytes;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalJson(value), "utf8");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function verificationArtifactReference(
  result: WriteVerificationArtifactResult,
): {
  artifact_id: string;
  relative_path: string;
  sha256: string;
} {
  if (
    result.record.schema_version !== 2 ||
    result.record.payload.kind !== "artifact"
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "verification execution artifact was not persisted",
    );
  }
  return {
    artifact_id: result.record.payload.artifact_id,
    relative_path: result.record.payload.relative_path,
    sha256: result.record.payload.sha256,
  };
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
    !server.allowed_dev_origins.includes("devbox")
  ) {
    throw new ArkTeamError(
      "CONFIG_INVALID",
      "Next.js local verification requires allowedDevOrigins to include devbox",
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
      VERIFICATION_SECRET_TEXT_PATTERN.test(
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
        VERIFICATION_SECRET_TEXT_PATTERN.test(argument) ||
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
    const matchingRecords = readiness.decisive_evidence_record_ids
      .map((recordId) => records.get(recordId))
      .filter(
        (candidate) =>
          candidate?.schema_version === 2 &&
          candidate.lane === lane &&
          candidate.payload.kind === "capability" &&
          candidate.payload.capability === capability,
      );
    const record = matchingRecords.at(-1);
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
      return ["agentic_browser", "browser", "server"];
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
    recordType === "browser"
  ) {
    return "executing";
  }
  if (
    recordType === "agentic_browser" ||
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
    kind === "browser"
  ) {
    return "executing";
  }
  if (
    kind === "agentic_browser" ||
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
  if (options.timeout_ms !== undefined) {
    if (
      options.kind !== "browser" ||
      options.timeout_ms !== snapshot.timeouts_ms.case_ms
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "verification action timeout override is not approved",
      );
    }
    return options.timeout_ms;
  }
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
  deadline: VerificationActionDeadline,
): Promise<T> {
  const timeout = deadline.start(timeoutMs);
  try {
    return await Promise.race([Promise.resolve().then(execute), timeout]);
  } finally {
    deadline.clear();
  }
}

class VerificationActionDeadline {
  private timer: NodeJS.Timeout | undefined;
  private expiresAtNanoseconds: bigint | undefined;

  constructor(private readonly controller: AbortController) {}

  start(timeoutMs: number): Promise<never> {
    this.expiresAtNanoseconds =
      process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
    return new Promise<never>((_resolve, reject) => {
      this.timer = setTimeout(() => {
        this.controller.abort();
        reject(new VerificationTimeoutError());
      }, timeoutMs);
    });
  }

  completeTimedEffect(): void {
    if (
      this.controller.signal.aborted ||
      this.expiresAtNanoseconds === undefined ||
      process.hrtime.bigint() >= this.expiresAtNanoseconds
    ) {
      this.controller.abort();
      throw new VerificationTimeoutError();
    }
    this.expiresAtNanoseconds = undefined;
    this.clear();
  }

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
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

function verificationStageIndex(stage: string): number {
  const orderedStages: readonly VerificationStage[] = [
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
  ];
  const index = orderedStages.indexOf(stage as VerificationStage);
  if (index === -1) {
    throw new ArkTeamError(
      "CORRUPT_STATE",
      `unknown nonterminal verification stage: ${stage}`,
    );
  }
  return index;
}

function sanitizeDiagnostic(message: string): string {
  const normalized = message.trim() || "verification action failed";
  if (
    normalized.length > MAX_DIAGNOSTIC_CHARACTERS ||
    VERIFICATION_SECRET_TEXT_PATTERN.test(normalized)
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
