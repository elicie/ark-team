import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import {
  ASSIGNMENT_ID_PATTERN,
  RUN_ID_PATTERN,
  TEAM_ID_PATTERN,
  type AssignmentListResult,
  type AssignmentRecord,
  type AssignmentRole,
  type AssignmentState,
  type IntegrationRecord,
  persistedRunSchema,
  type PersistedRun,
  type PmSessionRecord,
  type RemoteActionRecord,
  type RunEvent,
  type RunListResult,
  type RunLogsResult,
  type RunRecord,
  type RunState,
  type RetryMode,
  type RetryRequestKind,
  type TeamListResult,
  type TeamRecord,
  type TransitionResult,
} from "./domain.js";
import type {
  ApprovalDecision,
  ApprovalSessionUpdate,
} from "./approval-session.js";
import { ArkTeamError } from "./errors.js";
import {
  assertManagedOutputContractRole,
  parseManagedOutput,
  pmPlanSchema,
  type ManagedOutputContract,
  type PmPlan,
  type PmReport,
} from "./role-contracts.js";
import {
  DEFAULT_PROJECT_CONFIG,
  projectConfigSha256,
  projectConfigSchema,
  type ProjectConfig,
} from "./project-config.js";
import {
  resolveProviderSensitiveEnvironmentNames,
  resolveRunWorkerBinding,
} from "./provider-config.js";
import {
  createNativeModelBinding,
  type ModelOverrides,
  type ResolvedModelBindingV1,
} from "./provider-types.js";
import { assertRunId, createRunId } from "./run-id.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  appendVerificationLinkedRecord,
  assertVerificationPackageBytes,
  assertVerificationPackageFingerprint,
  assertVerificationSourceIdentity,
  buildVerificationRunSnapshot,
  captureVerificationSource,
  sha256CanonicalJson,
  type VerificationApprovedBaselineManifest,
  type VerificationActionKind,
  type VerificationCapability,
  type VerificationCleanupAudit,
  type VerificationErrorCode,
  type VerificationLaneDecisionInput,
  type VerificationLinkedRecord,
  type VerificationOutcome,
  type VerificationRollbackRecord,
  type VerificationRunSnapshot,
  type VerificationSourceIdentity,
  type VerificationStage,
  verificationLaneDecisionInputSchema,
  verificationEvidenceDisposition,
  verificationErrorCodeSchema,
  verificationErrorDisposition,
  verificationRecordMatchesSnapshot,
  verificationRollbackRecordSchema,
  verificationRunSnapshotSha256,
} from "./verification-contract.js";
import { VerificationArtifactStore } from "./verification-artifact-store.js";
import type { PreparedTeamWorkspace } from "./worktree-manager.js";

export interface RunStoreOptions {
  root_path?: string;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  suffix?: () => string;
  assignment_suffix?: () => string;
  verification_source_loader?: (
    projectPath: string,
  ) => Promise<VerificationSourceIdentity>;
  verification_package_loader?: (
    projectPath: string,
  ) => Promise<string | Uint8Array>;
}

export interface CreateRunInput {
  objective: string;
  project_path: string;
  project_config?: ProjectConfig;
  project_config_source?: string | null;
  model_overrides?: ModelOverrides;
}

export interface RecordVerificationSnapshotInput {
  package_fingerprint: string;
  server_port: number;
}

export interface RecordVerificationRollbackInput {
  reason: string;
}

export interface WriteVerificationArtifactInput {
  artifact_id: string;
  relative_path: string;
  media_type:
    | "image/png"
    | "application/json"
    | "application/x-ndjson"
    | "application/zip"
    | "text/plain";
  bytes: Uint8Array;
  sha256: string;
  lane: "backend" | "ui" | null;
}

export interface WriteVerificationArtifactResult {
  run: RunRecord;
  record: VerificationLinkedRecord;
}

export interface VerificationApprovedBaselineResult {
  manifest: VerificationApprovedBaselineManifest;
  manifest_sha256: string;
  baseline_set_sha256: string;
}

export interface CleanupVerificationArtifactsResult {
  run: RunRecord;
  record: VerificationLinkedRecord;
  audit: VerificationCleanupAudit | null;
}

export interface VerificationStateTransitionResult {
  run: RunRecord;
  accepted: boolean;
  error_record: VerificationLinkedRecord | null;
}

export interface RecordVerificationAttemptInput {
  action_id: string;
  kind: VerificationActionKind;
  lane: "backend" | "ui" | null;
  check_id: string | null;
  input_sha256: string;
  evidence_record_ids: string[];
}

export interface RecordVerificationAttemptResult {
  run: RunRecord;
  reserved: boolean;
  error_record: VerificationLinkedRecord | null;
}

export interface CompleteVerificationAttemptInput {
  action_id: string;
  evidence_record_ids: string[];
  error_code: VerificationErrorCode | null;
  message: string | null;
  capability?: VerificationCapability;
}

export interface CompleteVerificationAttemptResult {
  run: RunRecord;
  error_code: VerificationErrorCode | null;
  error_record: VerificationLinkedRecord | null;
}

export interface RecordVerificationActionErrorInput {
  action_id: string;
  code: VerificationErrorCode;
  message: string;
  capability?: VerificationCapability;
}

export interface RecordVerificationActionErrorResult {
  run: RunRecord;
  record: VerificationLinkedRecord;
}

export interface TerminateVerificationForApprovalInput {
  request_sha256: string;
  message: string;
}

export interface TerminateVerificationForApprovalResult {
  run: RunRecord;
  error_record: VerificationLinkedRecord;
  report_record: VerificationLinkedRecord;
}

export interface FinalizeVerificationInput {
  lanes: VerificationLaneDecisionInput[];
}

export interface ListRunsInput {
  states?: RunState[];
  limit?: number;
}

export interface LogsInput {
  after_sequence?: number;
  limit?: number;
}

export interface CreateAssignmentInput {
  run_id: string;
  team_id: string;
  role: AssignmentRole;
  parent_assignment_id?: string;
  task_key?: string;
  output_contract?: ManagedOutputContract;
  assignment: string;
  working_directory: string;
}

export interface ResumeAssignmentInput {
  run_id: string;
  assignment_id: string;
  assignment: string;
  output_contract: "pl_report";
}

export interface CorrectAssignmentInput {
  run_id: string;
  assignment_id: string;
  assignment: string;
  retry_request_id?: string;
}

export interface RetryAssignmentInput {
  run_id: string;
  assignment_id: string;
  retry_request_id?: string;
}

export interface RecoverAssignmentInput {
  run_id: string;
  assignment_id: string;
  approval_id: string;
  assignment: string;
}

export interface RequestAssignmentRetryInput {
  run_id: string;
  assignment_id: string;
  kind: RetryRequestKind;
  mode: RetryMode;
  reason: string;
  assignment?: string;
}

export interface ListAssignmentsInput {
  states?: AssignmentState[];
  team_id?: string;
  parent_assignment_id?: string;
}

export interface ResolvedApproval {
  approval_id: string;
  decision: ApprovalDecision;
  source: "user" | "routine_policy";
}

export interface MaterializePlanInput {
  run_id: string;
  plan: PmPlan;
  workspaces: PreparedTeamWorkspace[];
}

export interface MaterializePlanResult {
  run: RunRecord;
  teams: TeamRecord[];
}

export interface CompleteTeamResult {
  run: RunRecord;
  team: TeamRecord;
}

export interface MaterializeIntegrationInput {
  run_id: string;
  strategy: "local_merge" | "pull_request";
  team_ids: string[];
  working_directory: string;
  branch: string;
  target_branch: string;
  base_commit: string;
}

export interface CompletePmReviewInput {
  run_id: string;
  session_id: string;
  report: PmReport;
  usage: PmSessionRecord["usage"];
}

export interface RequestRemoteActionInput {
  run_id: string;
  remote_name: string;
  repository: string;
}

export interface CompleteRemoteActionInput {
  run_id: string;
  request_id: string;
  pull_request_url: string;
}

export interface PmPlanEvidence {
  session_id: string;
  agent_name: "ark_pm";
  model: "gpt-5.6-sol";
  model_reasoning_effort: "xhigh";
  sandbox_mode: "read-only";
  approval_policy: "never";
  usage: PmSessionRecord["usage"];
}

export interface RecordPmPlanResult {
  run: RunRecord;
  plan: PmPlan;
  pm_session: PmSessionRecord;
}

export interface RunContextResult {
  run: RunRecord;
  plan: PmPlan | null;
  pm_session: PmSessionRecord | null;
  integration: IntegrationRecord | null;
}

const ACTIVE_STATES = new Set<RunState>([
  "planning",
  "staffing",
  "executing",
  "integrating",
  "verifying",
  "cleaning",
  "waiting_user",
]);

export function resolveStateRoot(environment = process.env): string {
  const configured = environment.ARK_TEAM_STATE_ROOT?.trim();
  if (!configured) {
    return path.join(homedir(), ".ark-team", "runs");
  }

  if (configured === "~") {
    return homedir();
  }

  if (configured.startsWith(`~${path.sep}`) || configured.startsWith("~/")) {
    return path.join(homedir(), configured.slice(2));
  }

  if (!path.isAbsolute(configured)) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "ARK_TEAM_STATE_ROOT must be an absolute path or start with ~/",
    );
  }

  return path.normalize(configured);
}

export class RunStore {
  readonly root_path: string;

  private readonly now: () => Date;
  private readonly suffix: () => string;
  private readonly assignmentSuffix: () => string;
  private readonly verificationSourceLoader: (
    projectPath: string,
  ) => Promise<VerificationSourceIdentity>;
  private readonly verificationPackageLoader: (
    projectPath: string,
  ) => Promise<string | Uint8Array>;
  private readonly providerEnvironment: NodeJS.ProcessEnv;
  #verificationCoordinatorAuthority: symbol | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: RunStoreOptions = {}) {
    this.root_path = path.resolve(options.root_path ?? resolveStateRoot());
    this.providerEnvironment = options.environment ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.suffix = options.suffix ?? (() => randomBytes(3).toString("hex"));
    this.assignmentSuffix =
      options.assignment_suffix ?? (() => randomBytes(6).toString("hex"));
    this.verificationSourceLoader =
      options.verification_source_loader ??
      ((projectPath) => captureVerificationSource(projectPath, this.now));
    this.verificationPackageLoader =
      options.verification_package_loader ??
      ((projectPath) =>
        readFile(path.join(projectPath, "docs", "slices", "SLICE-017.md")));
  }

  claimVerificationCoordinatorAuthority(): symbol {
    if (this.#verificationCoordinatorAuthority !== null) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "verification coordinator authority is already claimed",
      );
    }
    const authority = Symbol("verification-coordinator-authority");
    this.#verificationCoordinatorAuthority = authority;
    return authority;
  }

  async providerSensitiveEnvironmentNames(
    binding: ResolvedModelBindingV1,
  ): Promise<string[]> {
    return resolveProviderSensitiveEnvironmentNames(binding, {
      environment: this.providerEnvironment,
    });
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    return this.withMutation(async () => {
      const objective = input.objective.trim();
      if (!objective) {
        throw new ArkTeamError("INVALID_INPUT", "objective must not be empty");
      }

      if (!path.isAbsolute(input.project_path)) {
        throw new ArkTeamError("INVALID_INPUT", "project_path must be absolute");
      }

      const projectPath = path.normalize(input.project_path);
      let projectStats;
      try {
        projectStats = await stat(projectPath);
      } catch (error) {
        throw new ArkTeamError("INVALID_INPUT", `project_path does not exist: ${projectPath}`, {
          cause: error,
        });
      }
      if (!projectStats.isDirectory()) {
        throw new ArkTeamError("INVALID_INPUT", "project_path must point to a directory");
      }
      const parsedConfig = projectConfigSchema.safeParse(
        input.project_config ?? DEFAULT_PROJECT_CONFIG,
      );
      if (!parsedConfig.success) {
        if (
          parsedConfig.error.issues.some(
            (issue) =>
              issue.path[0] === "verification" &&
              issue.path[1] === "coordinator",
          )
        ) {
          throw new ArkTeamError(
            "CONFIG_INVALID",
            "verification coordinator configuration does not match the approved schema",
            { cause: parsedConfig.error },
          );
        }
        throw new ArkTeamError(
          "INVALID_PROJECT_CONFIG",
          "project configuration does not match the safe schema",
          { cause: parsedConfig.error },
        );
      }
      const configSource = input.project_config_source ?? null;
      if (configSource !== null && !path.isAbsolute(configSource)) {
        throw new ArkTeamError(
          "INVALID_PROJECT_CONFIG",
          "project configuration source must be absolute",
        );
      }
      const workerBinding = await resolveRunWorkerBinding(
        input.model_overrides,
        { environment: this.providerEnvironment },
      );

      await this.ensureRoot();
      const timestamp = this.now();
      const timestampText = timestamp.toISOString();
      const runId = await this.reserveRunDirectory(timestamp);
      const run: RunRecord = {
        schema_version: 1,
        run_id: runId,
        objective,
        project_path: projectPath,
        state: "planning",
        resume_state: null,
        created_at: timestampText,
        updated_at: timestampText,
        revision: 1,
        event_count: 1,
        assignment_count: 0,
        team_count: 0,
        project_config: parsedConfig.data,
        project_config_source:
          configSource === null ? null : path.normalize(configSource),
        project_config_sha256: projectConfigSha256(parsedConfig.data),
        verification_snapshot: null,
        verification_snapshot_sha256: null,
        verification_records: [],
        verification_state:
          parsedConfig.data.verification.coordinator?.schema_version === 2 &&
          parsedConfig.data.verification.coordinator.enabled
            ? {
                schema_version: 1,
                current_state: "integrated",
                terminal_outcome: null,
                attempts: [],
              }
            : null,
        model_bindings: {
          worker: workerBinding,
        },
        verification_cleanup_audit: null,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: 1,
        event_id: randomUUID(),
        event_type: "run.created",
        timestamp: timestampText,
        state: "planning",
        message: "Ark Team run created",
      };

      try {
        await this.writePersistedRun({
          run,
          events: [event],
          assignments: [],
          teams: [],
          plan: null,
          pm_session: null,
          integration: null,
        });
      } catch (error) {
        await rm(this.runDirectory(runId), { recursive: true, force: true });
        throw error;
      }

      return run;
    });
  }

  async recordVerificationSnapshot(
    runId: string,
    input: RecordVerificationSnapshotInput,
    authority?: symbol,
  ): Promise<RunRecord> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      await this.assertApprovedVerificationPackage(
        persisted.run.project_path,
      );
      assertVerificationPackageFingerprint(input.package_fingerprint);
      if (persisted.run.verification_snapshot !== null) {
        if (
          persisted.run.verification_snapshot.schema_version !== 2 ||
          persisted.run.verification_snapshot.package.package_fingerprint !==
            APPROVED_VERIFICATION_PACKAGE.package_fingerprint
        ) {
          throw new ArkTeamError(
            "CONTRACT_VERSION_MISMATCH",
            "earlier verification contracts are read-only",
          );
        }
        if (
          persisted.run.verification_snapshot.server.port !== input.server_port
        ) {
          throw new ArkTeamError(
            "SOURCE_DRIFT",
            "verification snapshot already records a different server port",
          );
        }
        const currentSource = await this.verificationSourceLoader(
          persisted.run.project_path,
        );
        assertVerificationSourceIdentity(
          currentSource,
          persisted.run.verification_snapshot.source,
        );
        return persisted.run;
      }
      if (!(await this.verificationStartsEnabled())) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification contract rollback disables new starts",
        );
      }

      const coordinator =
        persisted.run.project_config.verification.coordinator;
      if (coordinator === null) {
        throw new ArkTeamError(
          "CONFIG_INVALID",
          "verification coordinator configuration is required for a new snapshot",
        );
      }
      if (coordinator.schema_version !== 2) {
        throw new ArkTeamError(
          "CONTRACT_VERSION_MISMATCH",
          "contract-v1 verification configuration is read-only",
        );
      }
      if (!coordinator.enabled) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification coordinator is not enabled for this run",
        );
      }
      const verificationState = persisted.run.verification_state;
      if (
        verificationState === null ||
        verificationState.current_state !== "configured"
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification snapshot can only follow configured state",
        );
      }

      const source = await this.verificationSourceLoader(
        persisted.run.project_path,
      );
      const timestamp = this.now().toISOString();
      const snapshot = buildVerificationRunSnapshot({
        run_id: persisted.run.run_id,
        project_path: persisted.run.project_path,
        artifact_root: path.join(
          this.runDirectory(persisted.run.run_id),
          "verification",
        ),
        server_port: input.server_port,
        created_at_utc: timestamp,
        package_fingerprint: input.package_fingerprint,
        source,
        config: coordinator,
      });
      const artifactStore = new VerificationArtifactStore({
        state_root: this.root_path,
        project_root: persisted.run.project_path,
        snapshot,
      });
      await artifactStore.registerRoot();
      const snapshotSha256 = verificationRunSnapshotSha256(snapshot);
      const commonRecord = {
        schema_version: 2 as const,
        contract_id: "verification_contract_v2" as const,
        run_id: snapshot.run_id,
        case_id: snapshot.case_id,
        check_id: null,
        snapshot_id: snapshot.snapshot_id,
        lane: null,
        timestamp_utc: timestamp,
        source_fingerprint: snapshot.source_fingerprint,
        package_fingerprint: snapshot.package.package_fingerprint,
        lane_required: null,
        check_required: true,
        adapter: null,
        model: null,
        artifact_references: [],
      };
      const sourcePayload = {
        kind: "source" as const,
        source_sha256: snapshot.source_fingerprint,
      };
      const sourceRecord: VerificationLinkedRecord = {
        ...commonRecord,
        record_id: `${snapshot.run_id}-source`,
        record_type: "source",
        stage: "configured",
        previous_record_sha256: null,
        payload_sha256: sha256CanonicalJson(sourcePayload),
        payload: sourcePayload,
      };
      let verificationRecords = appendVerificationLinkedRecord(
        [],
        sourceRecord,
      );
      const configPayload = {
        kind: "config" as const,
        config_sha256: snapshot.resolved_config_sha256,
      };
      const configRecord: VerificationLinkedRecord = {
        ...commonRecord,
        record_id: `${snapshot.run_id}-config`,
        record_type: "config",
        stage: "configured",
        previous_record_sha256: sha256CanonicalJson(sourceRecord),
        payload_sha256: sha256CanonicalJson(configPayload),
        payload: configPayload,
      };
      verificationRecords = appendVerificationLinkedRecord(
        verificationRecords,
        configRecord,
      );
      const snapshotPayload = {
        kind: "snapshot" as const,
        snapshot_sha256: snapshotSha256,
      };
      const snapshotRecord: VerificationLinkedRecord = {
        ...commonRecord,
        record_id: `${snapshot.run_id}-snapshot`,
        record_type: "snapshot",
        stage: "snapshotted",
        previous_record_sha256: sha256CanonicalJson(configRecord),
        payload_sha256: sha256CanonicalJson(snapshotPayload),
        payload: snapshotPayload,
      };
      verificationRecords = appendVerificationLinkedRecord(
        verificationRecords,
        snapshotRecord,
      );
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_snapshot: snapshot,
        verification_snapshot_sha256: snapshotSha256,
        verification_records: [...verificationRecords],
        verification_state: {
          ...verificationState,
          current_state: "snapshotted",
        },
      };
      await this.writePersistedRun({
        run,
        events: persisted.events,
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return run;
    });
  }

  async appendVerificationRecord(
    runId: string,
    input: VerificationLinkedRecord,
    authority?: symbol,
  ): Promise<RunRecord> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const snapshot = persisted.run.verification_snapshot;
      if (snapshot === null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification evidence requires an immutable run snapshot",
        );
      }
      if (snapshot.schema_version !== 2 || input.schema_version !== 2) {
        throw new ArkTeamError(
          "CONTRACT_VERSION_MISMATCH",
          "contract-v1 verification evidence is read-only",
        );
      }
      if (
        ![
          "capability",
          "request",
          "browser",
          "agentic_browser",
          "screenshot",
          "review",
          "comparison",
        ].includes(input.record_type)
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "this verification record type is coordinator-owned",
        );
      }
      if (
        persisted.run.verification_state !== null &&
        persisted.run.verification_state.terminal_outcome !== null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "adapter evidence cannot be appended after the terminal outcome",
        );
      }
      const expectedStage = verificationAdapterRecordStage(input.record_type);
      if (
        persisted.run.verification_state?.current_state !== expectedStage ||
        input.stage !== expectedStage
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          `adapter ${input.record_type} evidence requires ${expectedStage} state`,
        );
      }
      await this.assertApprovedVerificationPackage(
        persisted.run.project_path,
      );
      const currentSource = await this.verificationSourceLoader(
        persisted.run.project_path,
      );
      assertVerificationSourceIdentity(currentSource, snapshot.source);
      if (
        input.run_id !== persisted.run.run_id ||
        input.case_id !== snapshot.case_id ||
        input.snapshot_id !== snapshot.snapshot_id ||
        input.source_fingerprint !== snapshot.source_fingerprint ||
        input.package_fingerprint !== snapshot.package.package_fingerprint
      ) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "verification evidence does not link to the immutable run snapshot",
        );
      }
      if (!verificationRecordMatchesSnapshot(snapshot, input)) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "verification evidence changes or cannot resolve immutable check provenance",
        );
      }
      const verificationRecords = appendVerificationLinkedRecord(
        persisted.run.verification_records,
        input,
      );
      const timestamp = this.now().toISOString();
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_records: [...verificationRecords],
      };
      await this.writePersistedRun({
        run,
        events: persisted.events,
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return run;
    });
  }

  async advanceVerificationState(
    runId: string,
    nextState: VerificationStage,
    authority?: symbol,
  ): Promise<VerificationStateTransitionResult> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const snapshot = persisted.run.verification_snapshot;
      if (snapshot?.schema_version === 1) {
        throw new ArkTeamError(
          "CONTRACT_VERSION_MISMATCH",
          "contract-v1 verification lifecycle is read-only",
        );
      }
      if (snapshot !== null) {
        await this.assertCurrentVerificationSnapshot(persisted.run);
      }
      const verificationState = persisted.run.verification_state;
      if (verificationState === null) {
        throw new ArkTeamError(
          snapshot === null
            ? "INVALID_TRANSITION"
            : "CONTRACT_VERSION_MISMATCH",
          snapshot === null
            ? "verification lifecycle is not enabled for this run"
            : "earlier verification runs are read-only",
        );
      }
      if (
        !isVerificationTransitionAllowed(
          verificationState.current_state,
          nextState,
        ) ||
        ["passed", "failed", "unavailable", "skipped", "error"].includes(
          nextState,
        )
      ) {
        if (snapshot === null) {
          throw new ArkTeamError(
            "INVALID_TRANSITION",
            "invalid pre-snapshot verification transition",
          );
        }
        const timestamp = this.now().toISOString();
        const errorRecord = createVerificationCoordinatorErrorRecord({
          run: { ...persisted.run, verification_state: verificationState },
          timestamp,
          code: "INVALID_RECORD",
          message: `invalid verification transition from ${verificationState.current_state} to ${nextState}`,
          attempt_count: 1,
          evidence_record_ids: [],
        });
        const verificationRecords = appendVerificationLinkedRecord(
          persisted.run.verification_records,
          errorRecord,
        );
        const run: RunRecord = {
          ...persisted.run,
          updated_at: timestamp,
          revision: persisted.run.revision + 1,
          verification_state: verificationState,
          verification_records: [...verificationRecords],
        };
        await this.writePersistedRun({ ...persisted, run });
        return { run, accepted: false, error_record: errorRecord };
      }
      if (
        verificationState.current_state === "capabilities" &&
        nextState === "ready"
      ) {
        try {
          assertCompleteVerificationCapabilityMatrix(persisted.run);
        } catch (error) {
          const timestamp = this.now().toISOString();
          const errorRecord = createVerificationCoordinatorErrorRecord({
            run: persisted.run,
            timestamp,
            code: "INVALID_RECORD",
            message:
              error instanceof Error
                ? error.message
                : "verification capability discovery is incomplete",
            attempt_count: 1,
            evidence_record_ids: [],
          });
          const verificationRecords = appendVerificationLinkedRecord(
            persisted.run.verification_records,
            errorRecord,
          );
          const run: RunRecord = {
            ...persisted.run,
            updated_at: timestamp,
            revision: persisted.run.revision + 1,
            verification_records: [...verificationRecords],
          };
          await this.writePersistedRun({ ...persisted, run });
          return { run, accepted: false, error_record: errorRecord };
        }
      }

      const timestamp = this.now().toISOString();
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_state: {
          ...verificationState,
          current_state: nextState,
        },
      };
      await this.writePersistedRun({ ...persisted, run });
      return { run, accepted: true, error_record: null };
    });
  }

  async recordVerificationAttempt(
    runId: string,
    input: RecordVerificationAttemptInput,
    authority?: symbol,
  ): Promise<RecordVerificationAttemptResult> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const snapshot = persisted.run.verification_snapshot;
      if (snapshot === null || snapshot.schema_version !== 2) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification attempts require a contract-v2 snapshot",
        );
      }
      const verificationState = persisted.run.verification_state;
      if (verificationState === null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "earlier verification runs are read-only",
        );
      }
      if (verificationState.terminal_outcome !== null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification attempts cannot follow a terminal outcome",
        );
      }
      assertVerificationAttemptScope(snapshot, input);
      if (
        verificationState.current_state !==
        verificationActionStage(input.kind)
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          `${input.kind} action requires ${verificationActionStage(input.kind)} state`,
        );
      }
      if (!/^[a-f0-9]{64}$/.test(input.input_sha256)) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "verification attempt input hash is invalid",
        );
      }
      if (input.evidence_record_ids.length !== 0) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "attempt reservation cannot claim evidence before execution",
        );
      }
      const maxAttempts = snapshot.attempt_policy[input.kind];
      const existingIndex = verificationState.attempts.findIndex(
        (attempt) =>
          verificationAttemptBudgetScopeKey(attempt) ===
          verificationAttemptBudgetScopeKey(input),
      );
      const existing =
        existingIndex === -1
          ? null
          : verificationState.attempts[existingIndex]!;
      const rejectAttempt = async (
        message: string,
      ): Promise<RecordVerificationAttemptResult> => {
        const timestamp = this.now().toISOString();
        const errorRecord = createVerificationCoordinatorErrorRecord({
          run: persisted.run,
          timestamp,
          code: "INVALID_RECORD",
          message,
          attempt_count: Math.max(existing?.attempt_count ?? 1, 1),
          evidence_record_ids: [],
        });
        const verificationRecords = appendVerificationLinkedRecord(
          persisted.run.verification_records,
          errorRecord,
        );
        const run: RunRecord = {
          ...persisted.run,
          updated_at: timestamp,
          revision: persisted.run.revision + 1,
          verification_records: [...verificationRecords],
        };
        await this.writePersistedRun({ ...persisted, run });
        return { run, reserved: false, error_record: errorRecord };
      };
      const actionIdAttempt = verificationState.attempts.find(
        (attempt) => attempt.action_id === input.action_id,
      );
      if (
        actionIdAttempt !== undefined &&
        actionIdAttempt !== existing
      ) {
        return rejectAttempt(
          "verification action ID is already bound to another durable scope",
        );
      }
      if (
        existing !== null &&
        (existing.action_id !== input.action_id ||
          existing.input_sha256 !== input.input_sha256 ||
          existing.max_attempts !== maxAttempts)
      ) {
        return rejectAttempt(
          "verification retry changed its durable action identity",
        );
      }
      if (
        existing !== null &&
        (existing.status === "in_progress" ||
          existing.status === "succeeded" ||
          existing.status === "exhausted" ||
          existing.status === "aborted" ||
          existing.attempt_count >= maxAttempts)
      ) {
        return rejectAttempt(
          "verification action is already active, complete, or exhausted",
        );
      }

      try {
        await this.assertCurrentVerificationSnapshot(persisted.run);
      } catch (error) {
        const code = verificationCoordinatorErrorCode(error);
        const attemptCount = (existing?.attempt_count ?? 0) + 1;
        const attempt = {
          action_id: input.action_id,
          kind: input.kind,
          lane: input.lane,
          check_id: input.check_id,
          input_sha256: input.input_sha256,
          attempt_count: attemptCount,
          max_attempts: maxAttempts,
          evidence_record_ids: existing?.evidence_record_ids ?? [],
          decisive_evidence_record_ids: [],
          status:
            attemptCount >= maxAttempts
              ? ("exhausted" as const)
              : isTerminalVerificationActionError(code)
                ? ("aborted" as const)
                : ("failed" as const),
          last_error_code: code,
        };
        const attempts = [...verificationState.attempts];
        if (existingIndex === -1) {
          attempts.push(attempt);
        } else {
          attempts[existingIndex] = attempt;
        }
        const stateRun: RunRecord = {
          ...persisted.run,
          verification_state: {
            ...verificationState,
            attempts,
          },
        };
        const timestamp = this.now().toISOString();
        const errorRecord = createVerificationCoordinatorErrorRecord({
          run: stateRun,
          timestamp,
          action_id: input.action_id,
          code,
          message:
            error instanceof Error
              ? error.message
              : "verification preflight failed",
          attempt_count: attemptCount,
          evidence_record_ids: attempt.evidence_record_ids,
          lane: input.lane,
          check_id: input.check_id,
        });
        const verificationRecords = appendVerificationLinkedRecord(
          persisted.run.verification_records,
          errorRecord,
        );
        const run: RunRecord = {
          ...stateRun,
          updated_at: timestamp,
          revision: persisted.run.revision + 1,
          verification_records: [...verificationRecords],
        };
        await this.writePersistedRun({ ...persisted, run });
        return { run, reserved: false, error_record: errorRecord };
      }

      const nextAttempt = {
        action_id: input.action_id,
        kind: input.kind,
        lane: input.lane,
        check_id: input.check_id,
        input_sha256: input.input_sha256,
        attempt_count: (existing?.attempt_count ?? 0) + 1,
        max_attempts: maxAttempts,
        evidence_record_ids: [...(existing?.evidence_record_ids ?? [])],
        decisive_evidence_record_ids: [],
        status: "in_progress" as const,
        last_error_code: null,
      };
      const attempts = [...verificationState.attempts];
      if (existingIndex === -1) {
        attempts.push(nextAttempt);
      } else {
        attempts[existingIndex] = nextAttempt;
      }
      const timestamp = this.now().toISOString();
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_state: {
          ...verificationState,
          attempts,
        },
      };
      await this.writePersistedRun({ ...persisted, run });
      return { run, reserved: true, error_record: null };
    });
  }

  async completeVerificationAttempt(
    runId: string,
    input: CompleteVerificationAttemptInput,
    authority?: symbol,
  ): Promise<CompleteVerificationAttemptResult> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const verificationState = persisted.run.verification_state;
      if (
        persisted.run.verification_snapshot?.schema_version !== 2 ||
        verificationState === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification attempt completion requires coordinator state",
        );
      }
      const attemptIndex = verificationState.attempts.findIndex(
        (attempt) => attempt.action_id === input.action_id,
      );
      const attempt = verificationState.attempts[attemptIndex];
      if (
        attempt !== undefined &&
        attempt.last_error_code === "APPROVAL_REQUIRED" &&
        (attempt.status === "aborted" || attempt.status === "exhausted") &&
        verificationState.current_state === "error" &&
        verificationState.terminal_outcome === "error"
      ) {
        const existingError = persisted.run.verification_records.find(
          (record) =>
            record.schema_version === 2 &&
            record.payload.kind === "error" &&
            record.payload.action_id === input.action_id &&
            record.payload.code === "APPROVAL_REQUIRED",
        );
        if (existingError === undefined) {
          throw new ArkTeamError(
            "CORRUPT_STATE",
            "approval-settled verification attempt is missing its action error",
          );
        }
        return {
          run: persisted.run,
          error_code: "APPROVAL_REQUIRED",
          error_record: existingError,
        };
      }
      if (attempt === undefined || attempt.status !== "in_progress") {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification attempt is not reserved",
        );
      }
      const recordById = new Map(
        persisted.run.verification_records.map((record) => [
          record.record_id,
          record,
        ]),
      );
      if (
        new Set(input.evidence_record_ids).size !==
          input.evidence_record_ids.length ||
        input.evidence_record_ids.some((recordId) => {
          const record = recordById.get(recordId);
          return (
            record === undefined ||
            record.schema_version !== 2 ||
            !verificationRecordMatchesAttempt(
              attempt.kind,
              attempt.lane,
              attempt.check_id,
              record,
            )
          );
        })
      ) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "verification attempt contains missing or mismatched evidence links",
        );
      }
      let errorCode = input.error_code;
      try {
        await this.assertCurrentVerificationSnapshot(persisted.run);
      } catch (error) {
        errorCode = verificationCoordinatorErrorCode(error);
      }
      const completedAttempt = {
        ...attempt,
        evidence_record_ids: [
          ...new Set([
            ...attempt.evidence_record_ids,
            ...input.evidence_record_ids,
          ]),
        ],
        decisive_evidence_record_ids: [...input.evidence_record_ids],
        status:
          errorCode === null
            ? ("succeeded" as const)
            : attempt.attempt_count >= attempt.max_attempts
              ? ("exhausted" as const)
              : isTerminalVerificationActionError(errorCode)
                ? ("aborted" as const)
                : ("failed" as const),
        last_error_code: errorCode,
      };
      const attempts =
        errorCode === "APPROVAL_REQUIRED"
          ? verificationState.attempts.map((candidate) => {
              if (candidate.status !== "in_progress") {
                return candidate;
              }
              if (candidate.action_id === input.action_id) {
                return completedAttempt;
              }
              return {
                ...candidate,
                status:
                  candidate.attempt_count >= candidate.max_attempts
                    ? ("exhausted" as const)
                    : ("aborted" as const),
                last_error_code: "APPROVAL_REQUIRED" as const,
              };
            })
          : verificationState.attempts.map((candidate, index) =>
              index === attemptIndex ? completedAttempt : candidate,
            );
      const timestamp = this.now().toISOString();
      const stateRun: RunRecord = {
        ...persisted.run,
        verification_state: {
          ...verificationState,
          attempts,
        },
      };
      let errorRecord: VerificationLinkedRecord | null = null;
      let verificationRecords: readonly VerificationLinkedRecord[] =
        persisted.run.verification_records;
      const attemptsNeedingError =
        errorCode === "APPROVAL_REQUIRED"
          ? attempts.filter(
              (candidate) =>
                candidate.last_error_code === "APPROVAL_REQUIRED" &&
                (candidate.status === "aborted" ||
                  candidate.status === "exhausted") &&
                verificationState.attempts.find(
                  (previous) =>
                    previous.action_id === candidate.action_id &&
                    previous.status === "in_progress",
                ) !== undefined,
            )
          : completedAttempt.status === "aborted" ||
              completedAttempt.status === "exhausted"
            ? [completedAttempt]
            : [];
      for (const failedAttempt of attemptsNeedingError) {
        const record = createVerificationCoordinatorErrorRecord({
          run: {
            ...stateRun,
            verification_records: [...verificationRecords],
          },
          timestamp,
          action_id: failedAttempt.action_id,
          code: failedAttempt.last_error_code!,
          message:
            input.message ??
            `verification action failed closed with ${failedAttempt.last_error_code}`,
          attempt_count: failedAttempt.attempt_count,
          evidence_record_ids: failedAttempt.evidence_record_ids,
          lane: failedAttempt.lane,
          check_id: failedAttempt.check_id,
          ...(input.capability === undefined
            ? {}
            : { capability: input.capability }),
        });
        const actionError = {
          ...record,
          record_id: verificationActionErrorRecordId(
            failedAttempt.action_id,
          ),
        };
        verificationRecords = appendVerificationLinkedRecord(
          verificationRecords,
          actionError,
        );
        if (failedAttempt.action_id === input.action_id) {
          errorRecord = actionError;
        }
      }
      let terminalVerificationState = stateRun.verification_state;
      if (
        errorRecord !== null &&
        errorRecord.payload.kind === "error" &&
        errorRecord.payload.code === "APPROVAL_REQUIRED"
      ) {
        const reportRecord = createApprovalTerminalReportRecord({
          run: {
            ...stateRun,
            verification_records: [...verificationRecords],
          },
          snapshot: persisted.run.verification_snapshot,
          timestamp,
          error_record: errorRecord,
          previous_record: verificationRecords.at(-1)!,
        });
        verificationRecords = appendVerificationLinkedRecord(
          verificationRecords,
          reportRecord,
        );
        terminalVerificationState = {
          ...stateRun.verification_state!,
          current_state: "error",
          terminal_outcome: "error",
        };
      }
      const run: RunRecord = {
        ...stateRun,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_records: [...verificationRecords],
        verification_state: terminalVerificationState,
      };
      await this.writePersistedRun({ ...persisted, run });
      return { run, error_code: errorCode, error_record: errorRecord };
    });
  }

  async recordVerificationActionError(
    runId: string,
    input: RecordVerificationActionErrorInput,
    authority?: symbol,
  ): Promise<RecordVerificationActionErrorResult> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const snapshot = persisted.run.verification_snapshot;
      const verificationState = persisted.run.verification_state;
      if (
        snapshot === null ||
        snapshot.schema_version !== 2 ||
        verificationState === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification action errors require persisted attempt state",
        );
      }
      const attempt = verificationState.attempts.find(
        (candidate) => candidate.action_id === input.action_id,
      );
      if (
        attempt === undefined ||
        (attempt.status !== "aborted" &&
          attempt.status !== "exhausted") ||
        attempt.last_error_code !== input.code
      ) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "verification action error does not match a completed failed attempt",
        );
      }
      const recordId = verificationActionErrorRecordId(input.action_id);
      const existing = persisted.run.verification_records.find(
        (record) => record.record_id === recordId,
      );
      if (existing !== undefined) {
        if (existing.payload.kind !== "error") {
          throw new ArkTeamError(
            "CORRUPT_STATE",
            "verification action error record ID is already occupied",
          );
        }
        return { run: persisted.run, record: existing };
      }
      const timestamp = this.now().toISOString();
      const record = createVerificationCoordinatorErrorRecord({
        run: persisted.run,
        timestamp,
        action_id: input.action_id,
        code: input.code,
        message: input.message,
        attempt_count: attempt.attempt_count,
        evidence_record_ids: attempt.evidence_record_ids,
        lane: attempt.lane,
        check_id: attempt.check_id,
        ...(input.capability === undefined
          ? {}
          : { capability: input.capability }),
      });
      const errorRecord = { ...record, record_id: recordId };
      const verificationRecords = appendVerificationLinkedRecord(
        persisted.run.verification_records,
        errorRecord,
      );
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_records: [...verificationRecords],
      };
      await this.writePersistedRun({ ...persisted, run });
      return { run, record: errorRecord };
    });
  }

  async terminateVerificationForApproval(
    runId: string,
    input: TerminateVerificationForApprovalInput,
    authority?: symbol,
  ): Promise<TerminateVerificationForApprovalResult> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const snapshot = persisted.run.verification_snapshot;
      const verificationState = persisted.run.verification_state;
      if (
        snapshot === null ||
        snapshot.schema_version !== 2 ||
        verificationState === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "approval denial requires a contract-v2 verification snapshot",
        );
      }
      if (verificationState.terminal_outcome !== null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "approval denial cannot replace a terminal verification outcome",
        );
      }
      await this.assertCurrentVerificationSnapshot(persisted.run);
      if (!/^[a-f0-9]{64}$/.test(input.request_sha256)) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "approval request hash is invalid",
        );
      }
      const timestamp = this.now().toISOString();
      const attempts = verificationState.attempts.map((attempt) =>
        attempt.status === "in_progress"
          ? {
              ...attempt,
              status:
                attempt.attempt_count >= attempt.max_attempts
                  ? ("exhausted" as const)
                  : ("aborted" as const),
              last_error_code: "APPROVAL_REQUIRED" as const,
            }
          : attempt,
      );
      const stateRun: RunRecord = {
        ...persisted.run,
        verification_state: {
          ...verificationState,
          attempts,
        },
      };
      let records: readonly VerificationLinkedRecord[] =
        persisted.run.verification_records;
      for (const attempt of attempts) {
        const wasInProgress = verificationState.attempts.find(
          (candidate) =>
            candidate.action_id === attempt.action_id &&
            candidate.status === "in_progress",
        );
        if (wasInProgress === undefined) {
          continue;
        }
        const actionError = {
          ...createVerificationCoordinatorErrorRecord({
            run: { ...stateRun, verification_records: [...records] },
            timestamp,
            action_id: attempt.action_id,
            code: "APPROVAL_REQUIRED",
            message: input.message,
            attempt_count: attempt.attempt_count,
            evidence_record_ids: attempt.evidence_record_ids,
            lane: attempt.lane,
            check_id: attempt.check_id,
            request_sha256: input.request_sha256,
          }),
          record_id: verificationActionErrorRecordId(attempt.action_id),
        };
        records = appendVerificationLinkedRecord(records, actionError);
      }
      const errorRecord = createVerificationCoordinatorErrorRecord({
        run: { ...stateRun, verification_records: [...records] },
        timestamp,
        code: "APPROVAL_REQUIRED",
        message: input.message,
        attempt_count: 1,
        evidence_record_ids: [],
        request_sha256: input.request_sha256,
      });
      records = appendVerificationLinkedRecord(records, errorRecord);
      const reportRecord = createApprovalTerminalReportRecord({
        run: { ...stateRun, verification_records: [...records] },
        snapshot,
        timestamp,
        error_record: errorRecord,
        previous_record: records.at(-1)!,
      });
      records = appendVerificationLinkedRecord(records, reportRecord);
      const run: RunRecord = {
        ...stateRun,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_records: [...records],
        verification_state: {
          ...verificationState,
          attempts,
          current_state: "error",
          terminal_outcome: "error",
        },
      };
      await this.writePersistedRun({ ...persisted, run });
      return { run, error_record: errorRecord, report_record: reportRecord };
    });
  }

  async finalizeVerification(
    runId: string,
    input: FinalizeVerificationInput,
    authority?: symbol,
  ): Promise<RunRecord> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const snapshot = persisted.run.verification_snapshot;
      const verificationState = persisted.run.verification_state;
      if (
        snapshot === null ||
        snapshot.schema_version !== 2 ||
        verificationState === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification decision requires contract-v2 lifecycle state",
        );
      }
      await this.assertCurrentVerificationSnapshot(persisted.run);
      if (
        verificationState.current_state !== "deciding" ||
        verificationState.terminal_outcome !== null ||
        verificationState.attempts.some(
          (attempt) =>
            attempt.status === "in_progress" ||
            attempt.status === "failed",
        )
      ) {
        const timestamp = this.now().toISOString();
        const errorRecord = createVerificationCoordinatorErrorRecord({
          run: persisted.run,
          timestamp,
          code: "INVALID_RECORD",
          message:
            "duplicate, out-of-order, or active-attempt terminal verification decision",
          attempt_count: 1,
          evidence_record_ids: [],
        });
        const verificationRecords = appendVerificationLinkedRecord(
          persisted.run.verification_records,
          errorRecord,
        );
        const run: RunRecord = {
          ...persisted.run,
          updated_at: timestamp,
          revision: persisted.run.revision + 1,
          verification_records: [...verificationRecords],
        };
        await this.writePersistedRun({ ...persisted, run });
        return run;
      }

      const enabledLanes = [
        ...(snapshot.backend_contract.enabled ? ["backend" as const] : []),
        ...(snapshot.ui_contract.enabled ? ["ui" as const] : []),
      ];
      const recordById = new Map(
        persisted.run.verification_records.map((record) => [
          record.record_id,
          record,
        ]),
      );
      const supersededEvidenceIds =
        supersededVerificationEvidenceRecordIds(
          verificationState.attempts,
        );
      let lanes: VerificationLaneDecisionInput[];
      try {
        const parsedLanes = input.lanes
          .map((lane) => verificationLaneDecisionInputSchema.parse(lane))
          .map((lane) => ({
            ...lane,
            checks: [...lane.checks].sort((left, right) =>
              left.check_id < right.check_id
                ? -1
                : left.check_id > right.check_id
                  ? 1
                  : 0,
            ),
          }))
          .sort((left, right) =>
            left.lane === right.lane
              ? 0
              : left.lane === "backend"
                ? -1
                : 1,
          );
        if (
          parsedLanes.length !== enabledLanes.length ||
          new Set(parsedLanes.map((lane) => lane.lane)).size !==
            parsedLanes.length ||
          enabledLanes.some(
            (lane) =>
              !parsedLanes.some((candidate) => candidate.lane === lane),
          )
        ) {
          throw new ArkTeamError(
            "INVALID_RECORD",
            "verification decision must contain exactly one enabled-lane result",
          );
        }
        lanes = parsedLanes.map((lane) =>
          deriveVerificationLaneDecision(
            snapshot,
            lane,
            recordById,
            supersededEvidenceIds,
          ),
        );
      } catch (error) {
        const timestamp = this.now().toISOString();
        const errorRecord = createVerificationCoordinatorErrorRecord({
          run: persisted.run,
          timestamp,
          code: "INVALID_RECORD",
          message:
            error instanceof Error
              ? error.message
              : "verification decision is invalid",
          attempt_count: 1,
          evidence_record_ids: [],
        });
        const verificationRecords = appendVerificationLinkedRecord(
          persisted.run.verification_records,
          errorRecord,
        );
        const run: RunRecord = {
          ...persisted.run,
          updated_at: timestamp,
          revision: persisted.run.revision + 1,
          verification_records: [...verificationRecords],
        };
        await this.writePersistedRun({ ...persisted, run });
        return run;
      }

      const timestamp = this.now().toISOString();
      let records: readonly VerificationLinkedRecord[] = [
        ...persisted.run.verification_records,
      ];
      const summaryRecords: VerificationLinkedRecord[] = [];
      const laneOutcomes = new Map<"backend" | "ui", VerificationOutcome>();
      for (const lane of lanes) {
        const laneRequired =
          lane.lane === "backend"
            ? snapshot.backend_contract.enabled &&
              snapshot.backend_contract.required
            : snapshot.ui_contract.enabled && snapshot.ui_contract.required;
        const outcome = aggregateVerificationChecks(lane.checks);
        laneOutcomes.set(lane.lane, outcome);
        const evidenceRecordIds = [
          ...new Set(
            lane.checks.flatMap((check) => check.evidence_record_ids),
          ),
        ];
        const payload = {
          kind: "lane_summary" as const,
          lane: lane.lane,
          outcome,
          evidence_record_ids: evidenceRecordIds,
          checks: lane.checks,
        };
        const summaryRecord: VerificationLinkedRecord = {
          schema_version: 2,
          contract_id: "verification_contract_v2",
          record_id: `${runId}-${lane.lane}-summary`,
          record_type: "lane_summary",
          run_id: runId,
          case_id: snapshot.case_id,
          check_id: null,
          snapshot_id: snapshot.snapshot_id,
          lane: lane.lane,
          stage: "deciding",
          timestamp_utc: timestamp,
          source_fingerprint: snapshot.source_fingerprint,
          package_fingerprint: snapshot.package.package_fingerprint,
          lane_required: laneRequired,
          check_required: false,
          previous_record_sha256: sha256CanonicalJson(records.at(-1)!),
          payload_sha256: sha256CanonicalJson(payload),
          payload,
          adapter: null,
          model: null,
          artifact_references: [],
        };
        records = appendVerificationLinkedRecord(records, summaryRecord);
        summaryRecords.push(summaryRecord);
      }
      const integrityFailure =
        lanes.some((lane) =>
          lane.checks.some((check) => check.integrity_failure),
        ) ||
        persisted.run.verification_records.some((record) => {
          if (record.payload.kind !== "error") {
            return false;
          }
          return verificationErrorDisposition(record.payload.code)
            .integrity_failure;
        });
      const requiredLaneOutcomes = enabledLanes.flatMap((lane) => {
        const required =
          lane === "backend"
            ? snapshot.backend_contract.enabled &&
              snapshot.backend_contract.required
            : snapshot.ui_contract.enabled && snapshot.ui_contract.required;
        const outcome = laneOutcomes.get(lane);
        return required && outcome !== undefined ? [outcome] : [];
      });
      const outcome = integrityFailure
        ? "error"
        : aggregateVerificationOutcomes(requiredLaneOutcomes);
      const reportPayload = {
        kind: "report" as const,
        outcome,
        evidence_record_ids: summaryRecords.map(
          (record) => record.record_id,
        ),
      };
      const reportRecord: VerificationLinkedRecord = {
        schema_version: 2,
        contract_id: "verification_contract_v2",
        record_id: `${runId}-terminal-report`,
        record_type: "report",
        run_id: runId,
        case_id: snapshot.case_id,
        check_id: null,
        snapshot_id: snapshot.snapshot_id,
        lane: null,
        stage: "deciding",
        timestamp_utc: timestamp,
        source_fingerprint: snapshot.source_fingerprint,
        package_fingerprint: snapshot.package.package_fingerprint,
        lane_required: null,
        check_required: true,
        previous_record_sha256: sha256CanonicalJson(records.at(-1)!),
        payload_sha256: sha256CanonicalJson(reportPayload),
        payload: reportPayload,
        adapter: null,
        model: null,
        artifact_references: [],
      };
      records = appendVerificationLinkedRecord(records, reportRecord);
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        verification_records: [...records],
        verification_state: {
          ...verificationState,
          current_state: outcome,
          terminal_outcome: outcome,
        },
      };
      await this.writePersistedRun({ ...persisted, run });
      return run;
    });
  }

  async writeVerificationArtifact(
    runId: string,
    input: WriteVerificationArtifactInput,
    authority?: symbol,
  ): Promise<WriteVerificationArtifactResult> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      const snapshot = persisted.run.verification_snapshot;
      if (snapshot === null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification artifacts require an immutable run snapshot",
        );
      }
      if (snapshot.schema_version !== 2) {
        throw new ArkTeamError(
          "CONTRACT_VERSION_MISMATCH",
          "contract-v1 verification artifacts are read-only",
        );
      }
      if (
        persisted.run.verification_state !== null &&
        persisted.run.verification_state.terminal_outcome !== null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "verification artifacts cannot be written after the terminal outcome",
        );
      }
      await this.assertApprovedVerificationPackage(
        persisted.run.project_path,
      );
      const currentSource = await this.verificationSourceLoader(
        persisted.run.project_path,
      );
      assertVerificationSourceIdentity(currentSource, snapshot.source);
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
          "verification artifact cannot target a disabled QA lane",
        );
      }

      const artifactStore = new VerificationArtifactStore({
        state_root: this.root_path,
        project_root: persisted.run.project_path,
        snapshot,
      });
      const existingArtifacts = persisted.run.verification_records.flatMap(
        (record) =>
          record.payload.kind === "artifact" ? [record.payload] : [],
      );
      const payload = await artifactStore.write(
        {
          artifact_id: input.artifact_id,
          relative_path: input.relative_path,
          media_type: input.media_type,
          bytes: input.bytes,
          sha256: input.sha256,
        },
        existingArtifacts,
      );
      const reference = {
        artifact_id: payload.artifact_id,
        relative_path: payload.relative_path,
        sha256: payload.sha256,
      };
      const timestamp = this.now().toISOString();
      const record: VerificationLinkedRecord = {
        schema_version: 2,
        contract_id: "verification_contract_v2",
        record_id: `artifact-${sha256CanonicalJson(reference).slice(0, 24)}`,
        record_type: "artifact",
        run_id: persisted.run.run_id,
        case_id: snapshot.case_id,
        check_id: null,
        snapshot_id: snapshot.snapshot_id,
        lane: input.lane,
        stage: "collecting",
        timestamp_utc: timestamp,
        source_fingerprint: snapshot.source_fingerprint,
        package_fingerprint: snapshot.package.package_fingerprint,
        lane_required: laneRequired,
        check_required: false,
        previous_record_sha256: sha256CanonicalJson(
          persisted.run.verification_records.at(-1)!,
        ),
        payload_sha256: sha256CanonicalJson(payload),
        payload,
        adapter: null,
        model: null,
        artifact_references: [reference],
      };
      try {
        const verificationRecords = appendVerificationLinkedRecord(
          persisted.run.verification_records,
          record,
        );
        const run: RunRecord = {
          ...persisted.run,
          updated_at: timestamp,
          revision: persisted.run.revision + 1,
          verification_records: [...verificationRecords],
        };
        await this.writePersistedRun({
          ...persisted,
          run,
        });
        return { run, record };
      } catch (error) {
        try {
          await artifactStore.removeWrittenArtifact(payload);
        } catch (rollbackError) {
          throw new ArkTeamError(
            "ARTIFACT_ROOT_INVALID",
            "artifact state persistence failed and physical rollback was incomplete",
            { cause: new AggregateError([error, rollbackError]) },
          );
        }
        throw error;
      }
    });
  }

  async verifyApprovedBaseline(
    runId: string,
  ): Promise<VerificationApprovedBaselineResult> {
    const persisted = await this.readPersistedRun(runId);
    const snapshot = persisted.run.verification_snapshot;
    if (
      snapshot === null ||
      snapshot.schema_version !== 2 ||
      !snapshot.ui_contract.enabled
    ) {
      throw new ArkTeamError(
        "BASELINE_NOT_APPROVED",
        "an enabled UI snapshot is required to verify an approved baseline",
      );
    }
    await this.assertApprovedVerificationPackage(persisted.run.project_path);
    const currentSource = await this.verificationSourceLoader(
      persisted.run.project_path,
    );
    assertVerificationSourceIdentity(currentSource, snapshot.source);
    return new VerificationArtifactStore({
      state_root: this.root_path,
      project_root: persisted.run.project_path,
      snapshot,
    }).verifyApprovedBaseline();
  }

  async cleanupVerificationArtifacts(
    runId: string,
    authority?: symbol,
  ): Promise<CleanupVerificationArtifactsResult> {
    return this.withMutation(async () => {
      this.assertVerificationCoordinatorAuthority(authority);
      const persisted = await this.readPersistedRun(runId);
      let run = persisted.run;
      const snapshot = run.verification_snapshot;
      if (snapshot === null) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "artifact cleanup requires an immutable run snapshot",
        );
      }
      if (snapshot.schema_version !== 2) {
        throw new ArkTeamError(
          "CONTRACT_VERSION_MISMATCH",
          "contract-v1 verification cleanup is read-only",
        );
      }
      const reports = run.verification_records.filter(
        (record) => record.payload.kind === "report",
      );
      if (reports.length !== 1 || reports[0]?.payload.kind !== "report") {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "artifact cleanup requires exactly one persisted terminal report",
        );
      }
      const report = reports[0];
      if (report.payload.kind !== "report") {
        throw new ArkTeamError(
          "CORRUPT_STATE",
          "terminal report record payload is invalid",
        );
      }
      const reportPayload = report.payload;
      const artifactRecords = run.verification_records.filter(
        (record) => record.payload.kind === "artifact",
      );
      const artifactPayloads = artifactRecords.flatMap((record) =>
        record.payload.kind === "artifact" ? [record.payload] : [],
      );
      if (artifactPayloads.length === 0) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "artifact cleanup requires persisted artifact hashes",
        );
      }
      const existingTerminalRecord = run.verification_records.find(
        (record) =>
          record.payload.kind === "cleanup" &&
          record.payload.disposition !== "retention_active",
      );
      if (existingTerminalRecord !== undefined) {
        if (run.verification_cleanup_audit === null) {
          throw new ArkTeamError(
            "CORRUPT_STATE",
            "terminal cleanup record is missing its durable audit",
          );
        }
        return {
          run,
          record: existingTerminalRecord,
          audit: run.verification_cleanup_audit,
        };
      }

      const now = this.now();
      const retentionBoundary =
        Date.parse(report.timestamp_utc) +
        snapshot.evidence_policy.retention_days * 24 * 60 * 60 * 1_000;
      if (!Number.isFinite(retentionBoundary)) {
        throw new ArkTeamError(
          "CORRUPT_STATE",
          "terminal report timestamp is invalid",
        );
      }
      if (now.getTime() < retentionBoundary) {
        const existingRetentionRecord = run.verification_records.find(
          (record) =>
            record.payload.kind === "cleanup" &&
            record.payload.disposition === "retention_active",
        );
        if (existingRetentionRecord !== undefined) {
          return {
            run,
            record: existingRetentionRecord,
            audit: run.verification_cleanup_audit,
          };
        }
        const timestamp = now.toISOString();
        const record = createVerificationCleanupRecord(
          run,
          "retention_active",
          timestamp,
        );
        const verificationRecords = appendVerificationLinkedRecord(
          run.verification_records,
          record,
        );
        run = {
          ...run,
          updated_at: timestamp,
          revision: run.revision + 1,
          verification_records: [...verificationRecords],
        };
        await this.writePersistedRun({
          ...persisted,
          run,
        });
        return { run, record, audit: run.verification_cleanup_audit };
      }

      const artifactStore = new VerificationArtifactStore({
        state_root: this.root_path,
        project_root: run.project_path,
        snapshot,
      });
      let audit = run.verification_cleanup_audit;
      const resumingPendingAudit = audit?.status === "pending";
      if (audit === null) {
        const baselineManifestSha256 = snapshot.ui_contract.enabled
          ? (await artifactStore.verifyApprovedBaseline()).manifest_sha256
          : null;
        const requestedAt = now.toISOString();
        audit = {
          schema_version: 1,
          run_id: run.run_id,
          snapshot_id: snapshot.snapshot_id,
          artifact_root: snapshot.artifact_root,
          terminal_report_record_id: report.record_id,
          terminal_report_at: report.timestamp_utc,
          terminal_outcome: reportPayload.outcome,
          terminal_report_sha256: sha256CanonicalJson(report),
          artifact_record_ids: artifactRecords.map(
            (record) => record.record_id,
          ),
          artifact_manifest_sha256:
            sha256CanonicalJson(artifactPayloads),
          artifact_count: artifactPayloads.length,
          total_bytes: artifactPayloads.reduce(
            (total, artifact) => total + artifact.byte_length,
            0,
          ),
          baseline_manifest_sha256: baselineManifestSha256,
          requested_at_utc: requestedAt,
          destructive_attempt: 1,
          status: "pending",
          completed_at_utc: null,
          error_code: null,
          error_message: null,
        };
        run = {
          ...run,
          updated_at: requestedAt,
          revision: run.revision + 1,
          verification_cleanup_audit: audit,
        };
        await this.writePersistedRun({
          ...persisted,
          run,
        });
      }

      let disposition: "cleaned" | "cleanup_error" = "cleaned";
      let cleanupMessage: string | null = null;
      try {
        if (resumingPendingAudit) {
          throw new ArkTeamError(
            "ARTIFACT_ROOT_INVALID",
            "a prior destructive cleanup attempt has an indeterminate result",
          );
        }
        const rootExists = await artifactStore.artifactRootExists();
        const cleanupResidueExists =
          await artifactStore.cleanupResidueExists();
        if (!rootExists || cleanupResidueExists) {
          throw new ArkTeamError(
            "ARTIFACT_ROOT_INVALID",
            "registered artifact root is missing or has cleanup residue",
          );
        }
        if (rootExists) {
          await artifactStore.cleanupRegisteredRoot(artifactPayloads);
        }
      } catch {
        disposition = "cleanup_error";
        cleanupMessage = "registered artifact cleanup failed closed";
      }

      const completedAt = this.now().toISOString();
      const completedAudit: VerificationCleanupAudit = {
        ...audit,
        status: disposition,
        completed_at_utc: completedAt,
        error_code:
          disposition === "cleanup_error" ? "ARTIFACT_ROOT_INVALID" : null,
        error_message: cleanupMessage,
      };
      const record = createVerificationCleanupRecord(
        run,
        disposition,
        completedAt,
        cleanupMessage,
      );
      const verificationRecords = appendVerificationLinkedRecord(
        run.verification_records,
        record,
      );
      run = {
        ...run,
        updated_at: completedAt,
        revision: run.revision + 1,
        verification_records: [...verificationRecords],
        verification_cleanup_audit: completedAudit,
      };
      await this.writePersistedRun({
        ...persisted,
        run,
      });
      return { run, record, audit: completedAudit };
    });
  }

  async recordVerificationRollback(
    input: RecordVerificationRollbackInput,
  ): Promise<VerificationRollbackRecord> {
    return this.withMutation(async () => {
      await this.ensureRoot();
      const existing = await this.readVerificationRollback();
      if (existing !== null) {
        return existing;
      }
      const parsed = verificationRollbackRecordSchema.safeParse({
        schema_version: 2,
        contract_id: "verification_contract_v2",
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        new_starts_enabled: false,
        preserves_existing_records: true,
        reason: input.reason.trim(),
        recorded_at_utc: this.now().toISOString(),
      });
      if (!parsed.success) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "verification rollback record is invalid",
          { cause: parsed.error },
        );
      }
      const finalPath = this.verificationRollbackPath();
      const temporaryPath = path.join(
        this.root_path,
        `.verification-rollback-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
      );
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify(parsed.data, null, 2)}\n`,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        await link(temporaryPath, finalPath);
        await rm(temporaryPath, { force: true });
      } catch (error) {
        await rm(temporaryPath, { force: true });
        if (isNodeError(error, "EEXIST")) {
          const concurrent = await this.readVerificationRollback();
          if (concurrent !== null) {
            return concurrent;
          }
        }
        throw new ArkTeamError(
          "STATE_ROOT_UNAVAILABLE",
          "unable to persist verification rollback",
          { cause: error },
        );
      }
      return parsed.data;
    });
  }

  async getVerificationRollback(): Promise<VerificationRollbackRecord | null> {
    await this.ensureRoot();
    return this.readVerificationRollback();
  }

  async getRun(runId: string): Promise<RunRecord> {
    return (await this.readPersistedRun(runId)).run;
  }

  async assertCurrentVerification(
    runId: string,
    authority?: symbol,
  ): Promise<RunRecord> {
    this.assertVerificationCoordinatorAuthority(authority);
    const run = (await this.readPersistedRun(runId)).run;
    await this.assertCurrentVerificationSnapshot(run);
    return run;
  }

  async getRunContext(runId: string): Promise<RunContextResult> {
    const persisted = await this.readPersistedRun(runId);
    return {
      run: persisted.run,
      plan: persisted.plan,
      pm_session: persisted.pm_session,
      integration: persisted.integration,
    };
  }

  async listRuns(input: ListRunsInput = {}): Promise<RunListResult> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ArkTeamError("INVALID_INPUT", "limit must be an integer between 1 and 100");
    }

    const requestedStates = input.states ? new Set(input.states) : null;
    let entries;
    try {
      entries = await readdir(this.root_path, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { runs: [], total: 0 };
      }
      throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", "Unable to list Ark Team runs", {
        cause: error,
      });
    }

    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!RUN_ID_PATTERN.test(entry.name)) {
        continue;
      }

      const persisted = await this.readPersistedRun(entry.name);
      if (requestedStates && !requestedStates.has(persisted.run.state)) {
        continue;
      }
      runs.push(persisted.run);
    }

    runs.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return {
      runs: runs.slice(0, limit),
      total: runs.length,
    };
  }

  async getLogs(runId: string, input: LogsInput = {}): Promise<RunLogsResult> {
    const afterSequence = input.after_sequence ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new ArkTeamError("INVALID_INPUT", "after_sequence must be a nonnegative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ArkTeamError("INVALID_INPUT", "limit must be an integer between 1 and 200");
    }

    const persisted = await this.readPersistedRun(runId);
    const remaining = persisted.events.filter((event) => event.sequence > afterSequence);
    const events = remaining.slice(0, limit);
    const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence;

    return {
      run_id: runId,
      events,
      next_after_sequence: nextAfterSequence,
      has_more: remaining.length > events.length,
    };
  }

  async recordPmPlan(
    runId: string,
    planInput: PmPlan,
    evidence: PmPlanEvidence,
  ): Promise<RecordPmPlanResult> {
    return this.withMutation(async () => {
      const parsedPlan = pmPlanSchema.safeParse(planInput);
      if (!parsedPlan.success) {
        throw new ArkTeamError("AGENT_SESSION_PROTOCOL_ERROR", "PM plan is invalid", {
          cause: parsedPlan.error,
        });
      }
      const persisted = await this.readPersistedRun(runId);
      if (
        persisted.run.state !== "planning" ||
        persisted.plan !== null ||
        persisted.pm_session !== null ||
        persisted.teams.length > 0 ||
        persisted.assignments.length > 0
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "PM planning evidence can only be recorded once before staffing",
        );
      }
      if (
        evidence.agent_name !== "ark_pm" ||
        evidence.model !== "gpt-5.6-sol" ||
        evidence.model_reasoning_effort !== "xhigh" ||
        evidence.sandbox_mode !== "read-only" ||
        evidence.approval_policy !== "never" ||
        !evidence.session_id.trim()
      ) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          "PM session evidence does not match the managed role profile",
        );
      }

      const timestamp = this.now().toISOString();
      const pmSession: PmSessionRecord = {
        session_id: evidence.session_id.trim(),
        agent_name: evidence.agent_name,
        model: evidence.model,
        model_reasoning_effort: evidence.model_reasoning_effort,
        sandbox_mode: evidence.sandbox_mode,
        approval_policy: evidence.approval_policy,
        usage: evidence.usage,
        planned_at: timestamp,
        turn_count: 1,
        final_report: null,
        final_usage: null,
        completed_at: null,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "pm.planned",
        timestamp,
        state: "planning",
        agent_role: "pm",
        usage: evidence.usage,
        message: `PM produced a validated ${parsedPlan.data.teams.length}-team plan`,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: parsedPlan.data,
        pm_session: pmSession,
        integration: persisted.integration,
      });
      return {
        run,
        plan: parsedPlan.data,
        pm_session: pmSession,
      };
    });
  }

  async failRun(runId: string, rawMessage: string): Promise<RunRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      if (persisted.run.state === "failed") {
        return persisted.run;
      }
      if (
        persisted.run.state === "completed" ||
        persisted.run.state === "cancelled" ||
        persisted.plan !== null ||
        persisted.teams.length > 0 ||
        persisted.assignments.length > 0
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          `Cannot fail run from ${persisted.run.state}`,
        );
      }
      const message = rawMessage.trim().slice(0, 1000) || "PM planning failed";
      const timestamp = this.now().toISOString();
      const run: RunRecord = {
        ...persisted.run,
        state: "failed",
        resume_state: null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: run.event_count,
        event_id: randomUUID(),
        event_type: "run.failed",
        timestamp,
        state: "failed",
        message,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return run;
    });
  }

  async materializePlan(input: MaterializePlanInput): Promise<MaterializePlanResult> {
    return this.withMutation(async () => {
      const parsedPlan = pmPlanSchema.safeParse(input.plan);
      if (!parsedPlan.success) {
        throw new ArkTeamError("INVALID_INPUT", "plan does not match pm_plan", {
          cause: parsedPlan.error,
        });
      }
      const persisted = await this.readPersistedRun(input.run_id);
      if (persisted.run.state !== "planning") {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          `Cannot materialize a PM plan while the run is ${persisted.run.state}`,
        );
      }
      if (
        persisted.plan !== null &&
        JSON.stringify(persisted.plan) !== JSON.stringify(parsedPlan.data)
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "materialized plan must match the stored PM plan",
        );
      }
      if (persisted.teams.length > 0 || persisted.assignments.length > 0) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Cannot materialize a PM plan after teams or assignments exist",
        );
      }
      if (input.workspaces.length !== parsedPlan.data.teams.length) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "prepared workspaces do not match the PM plan",
        );
      }

      const baseCommits = new Set<string>();
      const timestamp = this.now().toISOString();
      const teams: TeamRecord[] = parsedPlan.data.teams.map((plannedTeam, index) => {
        const workspace = input.workspaces[index];
        if (
          workspace === undefined ||
          workspace.run_id !== persisted.run.run_id ||
          workspace.team_id !== plannedTeam.team_id ||
          workspace.isolation_mode !== "git_worktree" ||
          !path.isAbsolute(workspace.working_directory) ||
          workspace.branch !==
            `ark-team/${persisted.run.run_id}/${plannedTeam.team_id}`
        ) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            `prepared workspace does not match team ${plannedTeam.team_id}`,
          );
        }
        baseCommits.add(workspace.base_commit);
        return {
          schema_version: 1,
          run_id: persisted.run.run_id,
          team_id: plannedTeam.team_id,
          mission: plannedTeam.mission,
          worker_count: plannedTeam.worker_count,
          dependencies: plannedTeam.dependencies,
          owned_paths: plannedTeam.owned_paths,
          acceptance_criteria: plannedTeam.acceptance_criteria,
          verification: plannedTeam.verification,
          isolation_mode: workspace.isolation_mode,
          working_directory: path.normalize(workspace.working_directory),
          branch: workspace.branch,
          target_branch: workspace.target_branch,
          base_commit: workspace.base_commit,
          state: "ready",
          created_at: timestamp,
          updated_at: timestamp,
          revision: 1,
        };
      });
      if (baseCommits.size !== 1) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "all team worktrees must share one base commit",
        );
      }

      const events: RunEvent[] = [
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 1,
          event_id: randomUUID(),
          event_type: "plan.materialized",
          timestamp,
          state: "staffing",
          message: `PM plan materialized with ${teams.length} team(s)`,
        },
        ...teams.map((team, index) => ({
          schema_version: 1 as const,
          sequence: persisted.run.event_count + index + 2,
          event_id: randomUUID(),
          event_type: "team.prepared" as const,
          timestamp,
          state: "staffing" as const,
          team_id: team.team_id,
          message: `Linked worktree prepared for ${team.team_id}`,
        })),
      ];
      const run: RunRecord = {
        ...persisted.run,
        state: "staffing",
        resume_state: null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + events.length,
        team_count: teams.length,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, ...events],
        assignments: persisted.assignments,
        teams,
        plan: parsedPlan.data,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return { run, teams };
    });
  }

  async listTeams(runId: string): Promise<TeamListResult> {
    const persisted = await this.readPersistedRun(runId);
    return {
      run_id: persisted.run.run_id,
      teams: persisted.teams,
      total: persisted.teams.length,
    };
  }

  async getIntegration(runId: string): Promise<IntegrationRecord | null> {
    return (await this.readPersistedRun(runId)).integration;
  }

  async materializeIntegration(
    input: MaterializeIntegrationInput,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      if (
        persisted.run.state !== "integrating" ||
        persisted.plan === null ||
        persisted.integration !== null ||
        persisted.teams.length === 0 ||
        persisted.teams.some((team) => team.state !== "completed")
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Integration workspace requires one all-team-complete integrating run",
        );
      }
      if (!path.isAbsolute(input.working_directory)) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "integration working_directory must be absolute",
        );
      }
      const expectedTeamIds = persisted.teams.map((team) => team.team_id);
      if (
        JSON.stringify(input.team_ids) !== JSON.stringify(expectedTeamIds)
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "integration team IDs must match the materialized PM plan",
        );
      }
      const baseCommits = new Set(
        persisted.teams.map((team) => team.base_commit),
      );
      if (
        baseCommits.size !== 1 ||
        !baseCommits.has(input.base_commit) ||
        !/^[0-9a-f]{40,64}$/.test(input.base_commit)
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "integration base commit must match every team",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        schema_version: 1,
        run_id: persisted.run.run_id,
        strategy: input.strategy,
        team_ids: expectedTeamIds,
        working_directory: path.normalize(input.working_directory),
        branch: input.branch.trim(),
        target_branch: input.target_branch.trim(),
        base_commit: input.base_commit,
        state: "ready",
        assignment_id: null,
        integration_commit_sha: null,
        created_at: timestamp,
        updated_at: timestamp,
        verified_at: null,
        merged_at: null,
        remote_action: null,
        cleanup_error: null,
        cleaned_at: null,
        revision: 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.prepared",
        timestamp,
        state: "integrating",
        message: `Integration worktree prepared on ${integration.branch}`,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async completeTeam(
    runId: string,
    teamId: string,
    plAssignmentId: string,
  ): Promise<CompleteTeamResult> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.teams.find((team) => team.team_id === teamId);
      if (!current) {
        throw new ArkTeamError("TEAM_NOT_FOUND", `Team not found: ${teamId}`);
      }
      if (current.state === "completed") {
        return { run: persisted.run, team: current };
      }
      const pl = findAssignment(persisted, plAssignmentId);
      if (
        current.state !== "active" ||
        pl.role !== "pl" ||
        pl.team_id !== teamId ||
        pl.state !== "completed" ||
        pl.output_contract !== "pl_report" ||
        pl.structured_report?.kind !== "pl_report" ||
        pl.structured_report.team_id !== teamId
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Team completion requires its valid completed PL report",
        );
      }
      const timestamp = this.now().toISOString();
      const team: TeamRecord = {
        ...current,
        state: "completed",
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const teams = persisted.teams.map((candidate) =>
        candidate.team_id === teamId ? team : candidate,
      );
      const allCompleted = teams.every(
        (candidate) => candidate.state === "completed",
      );
      const hasWaiting = persisted.assignments.some(
        (assignment) => assignment.state === "waiting_user",
      );
      const nextState = allCompleted
        ? "integrating"
        : hasWaiting
          ? "waiting_user"
          : "executing";
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "team.completed",
        timestamp,
        state: nextState,
        team_id: teamId,
        agent_role: "pl",
        assignment_id: plAssignmentId,
        message: `Team ${teamId} completed with a validated PL report`,
      };
      const run: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state:
          nextState === "waiting_user"
            ? persisted.run.resume_state ?? "executing"
            : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return { run, team };
    });
  }

  async createAssignment(input: CreateAssignmentInput): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      assertRunAcceptsAssignments(persisted.run.state);
      if (!TEAM_ID_PATTERN.test(input.team_id)) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "team_id must contain lowercase letters, digits, or hyphens",
        );
      }
      if (
        input.role !== "pl" &&
        input.role !== "worker" &&
        input.role !== "integration_pl"
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "assignment role must be pl, worker, or integration_pl",
        );
      }
      if (input.output_contract !== undefined) {
        assertManagedOutputContractRole(
          input.role === "integration_pl" ? "pl" : input.role,
          input.output_contract,
        );
      }
      const taskKey = input.task_key?.trim() ?? null;
      if (
        taskKey !== null &&
        !TEAM_ID_PATTERN.test(taskKey)
      ) {
        throw new ArkTeamError("INVALID_INPUT", "task_key is invalid");
      }
      if (
        input.role === "worker" &&
        ((taskKey === null) !== (input.output_contract === undefined))
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "managed worker task_key and output_contract must be provided together",
        );
      }
      if (input.role !== "worker" && taskKey !== null) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "PL assignments cannot have task_key",
        );
      }
      const assignmentText = input.assignment.trim();
      if (!assignmentText) {
        throw new ArkTeamError("INVALID_INPUT", "assignment must not be empty");
      }
      if (!path.isAbsolute(input.working_directory)) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "working_directory must be absolute",
        );
      }
      const workingDirectory = path.normalize(input.working_directory);
      const plannedTeam = persisted.teams.find(
        (team) => team.team_id === input.team_id,
      );
      if (
        input.role !== "integration_pl" &&
        persisted.plan !== null &&
        (!plannedTeam ||
          plannedTeam.working_directory !== workingDirectory ||
          plannedTeam.state === "cleaned" ||
          plannedTeam.state === "failed")
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "assignment team and worktree must match an available materialized PM team",
        );
      }

      let parentAssignmentId: string | null = null;
      if (input.role === "pl") {
        if (input.parent_assignment_id !== undefined) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            "PL assignments cannot have parent_assignment_id",
          );
        }
        if (
          persisted.assignments.some(
            (assignment) =>
              assignment.role === "pl" && assignment.team_id === input.team_id,
          )
        ) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            `team ${input.team_id} already has a PL assignment`,
          );
        }
        if (plannedTeam && plannedTeam.state !== "ready") {
          throw new ArkTeamError(
            "INVALID_TRANSITION",
            `team ${input.team_id} is ${plannedTeam.state}, not ready`,
          );
        }
        const teamCount = new Set(
          persisted.assignments
            .filter((assignment) => assignment.role === "pl")
            .map((assignment) => assignment.team_id),
        ).size;
        if (
          teamCount >= persisted.run.project_config.organization.max_teams
        ) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            "assignment exceeds the persisted maximum team count",
          );
        }
      } else if (input.role === "worker") {
        if (
          !input.parent_assignment_id ||
          !ASSIGNMENT_ID_PATTERN.test(input.parent_assignment_id)
        ) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            "worker assignments require a valid parent_assignment_id",
          );
        }
        const parent = persisted.assignments.find(
          (assignment) =>
            assignment.assignment_id === input.parent_assignment_id,
        );
        if (!parent || parent.role !== "pl") {
          throw new ArkTeamError(
            "INVALID_INPUT",
            "worker parent_assignment_id must identify a PL in the same run",
          );
        }
        if (
          parent.team_id !== input.team_id ||
          parent.working_directory !== workingDirectory
        ) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            "worker team and worktree must match the owning PL",
          );
        }
        const workerCount = persisted.assignments.filter(
          (assignment) =>
            assignment.role === "worker" &&
            assignment.parent_assignment_id === parent.assignment_id,
        ).length;
        if (
          workerCount >=
          persisted.run.project_config.organization.max_workers_per_team
        ) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            "assignment exceeds the persisted maximum worker count",
          );
        }
        if (
          taskKey !== null &&
          persisted.assignments.some(
            (assignment) =>
              assignment.parent_assignment_id === parent.assignment_id &&
              assignment.task_key === taskKey,
          )
        ) {
          throw new ArkTeamError(
            "INVALID_INPUT",
            `worker task_key already exists: ${taskKey}`,
          );
        }
        parentAssignmentId = parent.assignment_id;
      } else {
        if (
          input.team_id !== "integration" ||
          input.parent_assignment_id !== undefined ||
          input.output_contract !== "integration_report" ||
          persisted.run.state !== "integrating" ||
          persisted.integration?.state !== "ready" ||
          persisted.integration.working_directory !== workingDirectory ||
          persisted.assignments.some(
            (assignment) => assignment.role === "integration_pl",
          )
        ) {
          throw new ArkTeamError(
            "INVALID_TRANSITION",
            "Integration PL requires the one prepared integration worktree",
          );
        }
      }

      const timestamp = this.now().toISOString();
      const assignmentId = this.allocateAssignmentId(persisted);
      const modelBinding =
        input.role === "worker"
          ? persisted.run.model_bindings.worker
          : createNativeModelBinding("gpt-5.6-terra", "xhigh");
      const assignment: AssignmentRecord = {
        schema_version: 1,
        assignment_id: assignmentId,
        run_id: persisted.run.run_id,
        team_id: input.team_id,
        role: input.role,
        parent_assignment_id: parentAssignmentId,
        report_target:
          input.role === "pl"
            ? input.output_contract === "pl_worker_plan"
              ? { type: "controller" }
              : { type: "pm" }
            : input.role === "integration_pl"
              ? { type: "pm" }
              : { type: "assignment", assignment_id: parentAssignmentId ?? "" },
        assignment: assignmentText,
        task_key: taskKey,
        working_directory: workingDirectory,
        output_contract: input.output_contract ?? null,
        state: "running",
        session_id: null,
        turn_id: null,
        pending_approval: null,
        pending_retry: null,
        final_report: null,
        structured_report: null,
        usage: null,
        failure_message: null,
        report_routed_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        revision: 1,
        turn_count: 1,
        session_attempt_count: 1,
        correction_count: 0,
        model_binding: modelBinding,
      };
      const nextState =
        persisted.run.state === "waiting_user"
          ? "waiting_user"
          : input.role === "integration_pl"
            ? "integrating"
            : "executing";
      const providerSelectedEvent: RunEvent | null =
        modelBinding.kind === "external"
          ? {
              schema_version: 1,
              sequence: persisted.run.event_count + 1,
              event_id: randomUUID(),
              event_type: "assignment.provider_selected",
              timestamp,
              state: nextState,
              assignment_id: assignmentId,
              team_id: assignment.team_id,
              agent_role: assignment.role,
              message: "external worker provider selected",
              provider_id: modelBinding.provider_id,
              app_server_provider_id:
                modelBinding.app_server_provider_id,
              adapter_id: modelBinding.adapter_id,
              adapter_api_version: modelBinding.adapter_api_version,
              adapter_sha256: modelBinding.adapter_sha256,
              provider_config_sha256:
                modelBinding.provider_config_sha256,
              model: modelBinding.model,
              requested_reasoning_effort:
                modelBinding.requested_reasoning_effort,
              effective_reasoning_effort:
                modelBinding.effective_reasoning_effort,
              structured_output_mode:
                modelBinding.structured_output_mode,
            }
          : null;
      const event: RunEvent = {
        schema_version: 1,
        sequence:
          persisted.run.event_count +
          (providerSelectedEvent === null ? 1 : 2),
        event_id: randomUUID(),
        event_type: "assignment.started",
        timestamp,
        state: nextState,
        assignment_id: assignmentId,
        team_id: assignment.team_id,
        agent_role: assignment.role,
        message: `${assignment.role} assignment started`,
      };
      const updatedRun: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state:
          nextState === "waiting_user" ? persisted.run.resume_state : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count:
          persisted.run.event_count +
          (providerSelectedEvent === null ? 1 : 2),
        assignment_count: persisted.run.assignment_count + 1,
      };
      const teams =
        input.role === "pl" && plannedTeam
          ? persisted.teams.map((team) =>
              team.team_id === plannedTeam.team_id
                ? {
                    ...team,
                    state: "active" as const,
                    updated_at: timestamp,
                    revision: team.revision + 1,
                  }
                : team,
            )
          : persisted.teams;
      const integration =
        input.role === "integration_pl" && persisted.integration !== null
          ? {
              ...persisted.integration,
              state: "active" as const,
              assignment_id: assignmentId,
              updated_at: timestamp,
              revision: persisted.integration.revision + 1,
            }
          : persisted.integration;

      await this.writePersistedRun({
        run: updatedRun,
        events: [
          ...persisted.events,
          ...(providerSelectedEvent === null
            ? []
            : [providerSelectedEvent]),
          event,
        ],
        assignments: [...persisted.assignments, assignment],
        teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return assignment;
    });
  }

  async getAssignment(
    runId: string,
    assignmentId: string,
  ): Promise<AssignmentRecord> {
    const persisted = await this.readPersistedRun(runId);
    return findAssignment(persisted, assignmentId);
  }

  async recoverOrphanedApproval(
    input: RecoverAssignmentInput,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      const current = findAssignment(persisted, input.assignment_id);
      if (
        persisted.run.state !== "waiting_user" ||
        current.state !== "waiting_user" ||
        current.pending_approval?.approval_id !== input.approval_id ||
        current.session_id === null ||
        current.turn_id === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "safe recovery requires the current orphaned approval and resumable thread",
        );
      }
      const assignmentText = input.assignment.trim();
      if (!assignmentText) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "recovery assignment must not be empty",
        );
      }
      const timestamp = this.now().toISOString();
      const assignment: AssignmentRecord = {
        ...current,
        assignment: assignmentText,
        state: "running",
        turn_id: null,
        pending_approval: null,
        pending_retry: null,
        final_report: null,
        structured_report: null,
        usage: null,
        failure_message: null,
        report_routed_at: null,
        updated_at: timestamp,
        revision: current.revision + 1,
        turn_count: current.turn_count + 1,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignment.assignment_id
          ? assignment
          : candidate,
      );
      const anotherWaiting = assignments.some(
        (candidate) => candidate.state === "waiting_user",
      );
      const nextState = anotherWaiting
        ? "waiting_user"
        : persisted.run.resume_state ??
          (assignment.role === "integration_pl" ? "integrating" : "executing");
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "assignment.recovering",
        timestamp,
        state: nextState,
        assignment_id: assignment.assignment_id,
        team_id: assignment.team_id,
        agent_role: assignment.role,
        approval_id: input.approval_id,
        recovery_decision: "resume_safely",
        message:
          "Orphaned approval was not applied; the persisted thread is starting a new turn",
      };
      const run: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state:
          nextState === "waiting_user" ? persisted.run.resume_state : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async cancelOrphanedApproval(
    runId: string,
    assignmentId: string,
    approvalId: string,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = findAssignment(persisted, assignmentId);
      if (
        persisted.run.state !== "waiting_user" ||
        current.state !== "waiting_user" ||
        current.pending_approval?.approval_id !== approvalId
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "recovery cancellation requires the current orphaned approval",
        );
      }
      const timestamp = this.now().toISOString();
      const assignment: AssignmentRecord = {
        ...current,
        state: "cancelled",
        pending_approval: null,
        pending_retry: null,
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignmentId ? assignment : candidate,
      );
      const nextState = assignments.some(
        (candidate) => candidate.state === "waiting_user",
      )
        ? "waiting_user"
        : persisted.run.resume_state ??
          (assignment.role === "integration_pl" ? "integrating" : "executing");
      const events: RunEvent[] = [
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 1,
          event_id: randomUUID(),
          event_type: "assignment.recovering",
          timestamp,
          state: nextState,
          assignment_id: assignment.assignment_id,
          team_id: assignment.team_id,
          agent_role: assignment.role,
          approval_id: approvalId,
          recovery_decision: "cancel_run",
          message: "Orphaned approval recovery cancelled the run",
        },
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 2,
          event_id: randomUUID(),
          event_type: "assignment.cancelled",
          timestamp,
          state: nextState,
          assignment_id: assignment.assignment_id,
          team_id: assignment.team_id,
          agent_role: assignment.role,
          message: "Assignment cancelled during orphaned approval recovery",
        },
      ];
      const run: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state:
          nextState === "waiting_user" ? persisted.run.resume_state : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + events.length,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, ...events],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async resumeAssignment(input: ResumeAssignmentInput): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      assertRunAcceptsAssignments(persisted.run.state);
      const current = findAssignment(persisted, input.assignment_id);
      if (
        current.role !== "pl" ||
        current.state !== "completed" ||
        current.output_contract !== "pl_worker_plan" ||
        current.structured_report?.kind !== "pl_worker_plan" ||
        current.session_id === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Only a completed PL worker-plan turn can resume for its final report",
        );
      }
      const assignmentText = input.assignment.trim();
      if (!assignmentText) {
        throw new ArkTeamError("INVALID_INPUT", "assignment must not be empty");
      }
      if (input.output_contract !== "pl_report") {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "PL continuation requires pl_report",
        );
      }

      const timestamp = this.now().toISOString();
      const assignment: AssignmentRecord = {
        ...current,
        report_target: { type: "pm" },
        assignment: assignmentText,
        output_contract: "pl_report",
        state: "running",
        turn_id: null,
        pending_approval: null,
        pending_retry: null,
        final_report: null,
        structured_report: null,
        usage: null,
        failure_message: null,
        report_routed_at: null,
        updated_at: timestamp,
        revision: current.revision + 1,
        turn_count: current.turn_count + 1,
        correction_count: 0,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignment.assignment_id
          ? assignment
          : candidate,
      );
      const nextState = assignments.some(
        (candidate) => candidate.state === "waiting_user",
      )
        ? "waiting_user"
        : "executing";
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "assignment.resumed",
        timestamp,
        state: nextState,
        assignment_id: assignment.assignment_id,
        team_id: assignment.team_id,
        agent_role: "pl",
        message: "PL session resumed with consolidated worker reports",
      };
      const run: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state:
          nextState === "waiting_user"
            ? persisted.run.resume_state ?? "executing"
            : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async correctAssignment(
    input: CorrectAssignmentInput,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      assertRunAcceptsAssignments(persisted.run.state);
      const current = findAssignment(persisted, input.assignment_id);
      const retryRequest = current.pending_retry;
      const explicitRetry = input.retry_request_id !== undefined;
      if (
        explicitRetry
          ? current.state !== "waiting_user" ||
            retryRequest?.retry_request_id !== input.retry_request_id ||
            retryRequest?.mode !== "resume_session"
          : current.state !== "completed"
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Correction requires a completed report or its current resume retry request",
        );
      }
      if (
        current.output_contract === null ||
        current.structured_report === null ||
        current.session_id === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Correction requires a structured report and resumable session",
        );
      }
      const assignmentText = input.assignment.trim();
      if (!assignmentText) {
        throw new ArkTeamError("INVALID_INPUT", "assignment must not be empty");
      }

      const timestamp = this.now().toISOString();
      const assignment: AssignmentRecord = {
        ...current,
        assignment: assignmentText,
        state: "running",
        turn_id: null,
        pending_approval: null,
        pending_retry: null,
        final_report: null,
        structured_report: null,
        usage: null,
        failure_message: null,
        report_routed_at: null,
        updated_at: timestamp,
        revision: current.revision + 1,
        turn_count: current.turn_count + 1,
        correction_count: current.correction_count + 1,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignment.assignment_id
          ? assignment
          : candidate,
      );
      const nextState = assignments.some(
        (candidate) => candidate.state === "waiting_user",
      )
        ? "waiting_user"
        : persisted.run.state === "waiting_user"
          ? persisted.run.resume_state ?? "executing"
          : assignment.role === "integration_pl"
            ? "integrating"
            : "executing";
      const events = retryAttemptEvents({
        persisted,
        assignment,
        timestamp,
        next_state: nextState,
        event_type: "assignment.correction",
        message: `${assignment.role} assignment resumed for correction`,
        ...(explicitRetry
          ? { retry_request_id: input.retry_request_id }
          : {}),
        ...(retryRequest === null ? {} : { retry_kind: retryRequest.kind }),
      });
      const run: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state:
          nextState === "waiting_user"
            ? persisted.run.resume_state ?? "executing"
            : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + events.length,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, ...events],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async retryAssignment(
    input: RetryAssignmentInput,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      assertRunAcceptsAssignments(persisted.run.state);
      const current = findAssignment(persisted, input.assignment_id);
      const retryRequest = current.pending_retry;
      const explicitRetry = input.retry_request_id !== undefined;
      if (
        explicitRetry
          ? current.state !== "waiting_user" ||
            retryRequest?.retry_request_id !== input.retry_request_id ||
            retryRequest?.mode !== "fresh_session"
          : current.state !== "failed"
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Fresh retry requires a failed assignment or its current retry request",
        );
      }

      const timestamp = this.now().toISOString();
      const assignment: AssignmentRecord = {
        ...current,
        state: "running",
        session_id: null,
        turn_id: null,
        pending_approval: null,
        pending_retry: null,
        final_report: null,
        structured_report: null,
        usage: null,
        failure_message: null,
        report_routed_at: null,
        updated_at: timestamp,
        revision: current.revision + 1,
        turn_count: current.turn_count + 1,
        session_attempt_count: current.session_attempt_count + 1,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignment.assignment_id
          ? assignment
          : candidate,
      );
      const nextState = assignments.some(
        (candidate) => candidate.state === "waiting_user",
      )
        ? "waiting_user"
        : persisted.run.state === "waiting_user"
          ? persisted.run.resume_state ?? "executing"
          : assignment.role === "integration_pl"
            ? "integrating"
            : "executing";
      const events = retryAttemptEvents({
        persisted,
        assignment,
        timestamp,
        next_state: nextState,
        event_type: "assignment.retrying",
        message: `${assignment.role} assignment started in a fresh retry session`,
        ...(explicitRetry
          ? { retry_request_id: input.retry_request_id }
          : {}),
        ...(retryRequest === null ? {} : { retry_kind: retryRequest.kind }),
      });
      const run: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state:
          nextState === "waiting_user"
            ? persisted.run.resume_state ?? "executing"
            : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + events.length,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, ...events],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async requestAssignmentRetry(
    input: RequestAssignmentRetryInput,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      if (
        (input.kind === "internal_failure_exhausted" &&
          input.mode !== "fresh_session") ||
        (input.kind === "correction_exhausted" &&
          input.mode !== "resume_session")
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "retry request kind and mode do not match",
        );
      }
      const persisted = await this.readPersistedRun(input.run_id);
      const current = findAssignment(persisted, input.assignment_id);
      if (
        current.state === "waiting_user" &&
        current.pending_retry !== null
      ) {
        return current;
      }
      if (
        (input.mode === "fresh_session" && current.state !== "failed") ||
        (input.mode === "resume_session" &&
          (current.state !== "completed" ||
            current.session_id === null ||
            current.structured_report === null))
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Retry exhaustion does not match the assignment state",
        );
      }
      const reason = input.reason.trim().slice(0, 1000);
      if (!reason) {
        throw new ArkTeamError("INVALID_INPUT", "retry reason must not be empty");
      }
      const assignmentText = input.assignment?.trim();
      if (input.assignment !== undefined && !assignmentText) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "retry assignment must not be empty",
        );
      }
      const timestamp = this.now().toISOString();
      const retryRequestId = randomUUID();
      const assignment: AssignmentRecord = {
        ...current,
        ...(assignmentText ? { assignment: assignmentText } : {}),
        state: "waiting_user",
        pending_approval: null,
        pending_retry: {
          retry_request_id: retryRequestId,
          kind: input.kind,
          mode: input.mode,
          reason,
        },
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignment.assignment_id
          ? assignment
          : candidate,
      );
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "assignment.retry_exhausted",
        timestamp,
        state: "waiting_user",
        assignment_id: assignment.assignment_id,
        team_id: assignment.team_id,
        agent_role: assignment.role,
        retry_request_id: retryRequestId,
        retry_kind: input.kind,
        session_attempt_count: assignment.session_attempt_count,
        correction_count: assignment.correction_count,
        message: reason,
      };
      const run: RunRecord = {
        ...persisted.run,
        state: "waiting_user",
        resume_state:
          persisted.run.state === "waiting_user"
            ? persisted.run.resume_state ?? "executing"
            : persisted.run.state,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async recordProviderBridgeStarted(
    runId: string,
    assignmentId: string,
    port: number,
  ): Promise<RunEvent> {
    return this.withMutation(async () => {
      if (!Number.isInteger(port) || port < 10001 || port > 65535) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "provider bridge port must be between 10001 and 65535",
        );
      }
      const persisted = await this.readPersistedRun(runId);
      const assignment = findAssignment(persisted, assignmentId);
      const binding = assignment.model_binding;
      if (
        assignment.role !== "worker" ||
        assignment.state !== "running" ||
        binding.kind !== "external"
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "provider bridge diagnostics require a running external worker",
        );
      }
      const timestamp = this.now().toISOString();
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "assignment.provider_bridge_started",
        timestamp,
        state: persisted.run.state,
        assignment_id: assignment.assignment_id,
        team_id: assignment.team_id,
        agent_role: assignment.role,
        message: "external worker provider bridge started",
        provider_id: binding.provider_id,
        app_server_provider_id: binding.app_server_provider_id,
        adapter_id: binding.adapter_id,
        adapter_api_version: binding.adapter_api_version,
        adapter_sha256: binding.adapter_sha256,
        provider_config_sha256: binding.provider_config_sha256,
        model: binding.model,
        requested_reasoning_effort:
          binding.requested_reasoning_effort,
        effective_reasoning_effort:
          binding.effective_reasoning_effort,
        structured_output_mode: binding.structured_output_mode,
        bridge_port: port,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        ...persisted,
        run,
        events: [...persisted.events, event],
      });
      return event;
    });
  }

  async listAssignments(
    runId: string,
    input: ListAssignmentsInput = {},
  ): Promise<AssignmentListResult> {
    if (input.team_id !== undefined && !TEAM_ID_PATTERN.test(input.team_id)) {
      throw new ArkTeamError("INVALID_INPUT", "team_id is invalid");
    }
    if (
      input.parent_assignment_id !== undefined &&
      !ASSIGNMENT_ID_PATTERN.test(input.parent_assignment_id)
    ) {
      throw new ArkTeamError("INVALID_INPUT", "parent_assignment_id is invalid");
    }
    const persisted = await this.readPersistedRun(runId);
    const requestedStates = input.states ? new Set(input.states) : null;
    const assignments = persisted.assignments.filter(
      (assignment) =>
        (!requestedStates || requestedStates.has(assignment.state)) &&
        (input.team_id === undefined || assignment.team_id === input.team_id) &&
        (input.parent_assignment_id === undefined ||
          assignment.parent_assignment_id === input.parent_assignment_id),
    );
    return {
      run_id: persisted.run.run_id,
      assignments,
      total: assignments.length,
    };
  }

  async recordAssignmentApprovalResolution(
    runId: string,
    assignmentId: string,
    resolution: ResolvedApproval,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = findAssignment(persisted, assignmentId);
      if (
        persisted.run.state !== "waiting_user" ||
        current.state !== "waiting_user" ||
        current.pending_approval?.approval_id !== resolution.approval_id ||
        current.pending_approval.resolution !== null
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "approval_id is unknown or already resolved",
        );
      }

      const timestamp = this.now().toISOString();
      const assignment: AssignmentRecord = {
        ...current,
        pending_approval: {
          ...current.pending_approval,
          resolution: {
            decision: resolution.decision,
            source: resolution.source,
            recorded_at: timestamp,
          },
        },
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignmentId ? assignment : candidate,
      );
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "assignment.approval_resolved",
        timestamp,
        state: "waiting_user",
        assignment_id: assignment.assignment_id,
        team_id: assignment.team_id,
        agent_role: assignment.role,
        approval_id: resolution.approval_id,
        approval_decision: resolution.decision,
        approval_source: resolution.source,
        message:
          resolution.source === "routine_policy"
            ? "Routine assignment approval recorded before delivery"
            : "User assignment approval decision recorded before delivery",
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async recordAssignmentUpdate(
    runId: string,
    assignmentId: string,
    update: ApprovalSessionUpdate,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = findAssignment(persisted, assignmentId);
      if (current.state !== "running" && current.state !== "waiting_user") {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          `Cannot update an assignment while it is ${current.state}`,
        );
      }
      if (
        update.role !==
        (current.role === "integration_pl" ? "pl" : current.role)
      ) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          "session update role does not match the persisted assignment",
        );
      }
      if (
        (current.session_id !== null &&
          current.session_id !== update.session_id) ||
        (current.turn_id !== null && current.turn_id !== update.turn_id)
      ) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          "session update does not match the persisted assignment session and turn",
        );
      }
      if (
        current.state === "waiting_user" &&
        (current.pending_approval === null ||
          current.pending_approval.resolution === null)
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "a waiting assignment requires its current approval decision",
        );
      }

      const timestamp = this.now().toISOString();
      const structuredReport =
        update.status === "completed" && current.output_contract !== null
          ? parseManagedOutput(current.output_contract, update.final_report)
          : null;
      const assignment: AssignmentRecord =
        update.status === "waiting_user"
          ? {
              ...current,
              state: "waiting_user",
              session_id: update.session_id,
              turn_id: update.turn_id,
              pending_approval: {
                ...update.approval,
                resolution: null,
              },
              pending_retry: null,
              updated_at: timestamp,
              revision: current.revision + 1,
            }
          : {
              ...current,
              state: "completed",
              session_id: update.session_id,
              turn_id: update.turn_id,
              pending_approval: null,
              pending_retry: null,
              final_report: update.final_report.trim(),
              structured_report: structuredReport,
              usage: update.usage,
              failure_message: null,
              report_routed_at: timestamp,
              updated_at: timestamp,
              revision: current.revision + 1,
            };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignmentId ? assignment : candidate,
      );

      const events: RunEvent[] = [];
      if (update.status === "waiting_user") {
        events.push({
          schema_version: 1,
          sequence: 0,
          event_id: randomUUID(),
          event_type: "assignment.waiting_user",
          timestamp,
          state: "waiting_user",
          assignment_id: assignment.assignment_id,
          team_id: assignment.team_id,
          agent_role: assignment.role,
          approval_id: update.approval.approval_id,
          message: `Assignment is waiting for ${update.approval.kind} approval`,
        });
      } else {
        events.push(
          {
            schema_version: 1,
            sequence: 0,
            event_id: randomUUID(),
            event_type: "assignment.completed",
            timestamp,
            state: persisted.run.state,
            assignment_id: assignment.assignment_id,
            team_id: assignment.team_id,
            agent_role: assignment.role,
            usage: update.usage,
            message: `${assignment.role} assignment completed`,
            ...providerAuditFields(assignment),
          },
          {
            schema_version: 1,
            sequence: 0,
            event_id: randomUUID(),
            event_type: "assignment.report_routed",
            timestamp,
            state: persisted.run.state,
            assignment_id: assignment.assignment_id,
            team_id: assignment.team_id,
            agent_role: assignment.role,
            report_target: assignment.report_target,
            message:
              assignment.report_target.type === "pm"
                ? "PL report routed to PM inbox"
                : assignment.report_target.type === "controller"
                  ? "PL worker plan routed to orchestration controller"
                  : "Worker report routed to owning PL inbox",
          },
        );
      }

      const nextState =
        update.status === "waiting_user" ||
        assignments.some((candidate) => candidate.state === "waiting_user")
          ? "waiting_user"
          : persisted.run.state === "waiting_user"
            ? persisted.run.resume_state ?? "executing"
            : persisted.run.state;
      const resumeState =
        nextState === "waiting_user"
          ? persisted.run.state === "waiting_user"
            ? persisted.run.resume_state ?? "executing"
            : persisted.run.state
          : null;
      const sequencedEvents = events.map((event, index) => ({
        ...event,
        sequence: persisted.run.event_count + index + 1,
        state:
          event.event_type === "assignment.waiting_user"
            ? "waiting_user" as const
            : nextState,
      }));
      const updatedRun: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state: resumeState,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + sequencedEvents.length,
      };

      await this.writePersistedRun({
        run: updatedRun,
        events: [...persisted.events, ...sequencedEvents],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  async verifyIntegration(
    runId: string,
    assignmentId: string,
    integrationCommitSha: string,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      const assignment = findAssignment(persisted, assignmentId);
      const report =
        assignment.structured_report?.kind === "integration_report"
          ? assignment.structured_report
          : null;
      if (
        persisted.run.state !== "integrating" ||
        current?.state !== "active" ||
        current.assignment_id !== assignmentId ||
        assignment.role !== "integration_pl" ||
        assignment.state !== "completed" ||
        assignment.output_contract !== "integration_report" ||
        report === null ||
        report.status !== "completed" ||
        report.integration_commit_sha !== integrationCommitSha ||
        JSON.stringify(report.team_ids) !==
          JSON.stringify(current.team_ids) ||
        report.verification.some(
          (verification) => verification.status !== "passed",
        ) ||
        report.blockers.length > 0
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Integration verification requires one passing integration PL report",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        ...current,
        state: "verified",
        integration_commit_sha: integrationCommitSha,
        updated_at: timestamp,
        verified_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.verified",
        timestamp,
        state: "verifying",
        assignment_id: assignmentId,
        agent_role: "integration_pl",
        message: `Integration commit ${integrationCommitSha} verified`,
      };
      const run: RunRecord = {
        ...persisted.run,
        state: "verifying",
        resume_state: null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async recordLocalMerge(
    runId: string,
    integrationCommitSha: string,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      if (
        persisted.run.state !== "verifying" ||
        current?.state !== "verified" ||
        current.strategy !== "local_merge" ||
        current.integration_commit_sha !== integrationCommitSha
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Local merge requires the verified integration commit",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        ...current,
        state: "local_merged",
        updated_at: timestamp,
        merged_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.local_merged",
        timestamp,
        state: "verifying",
        message: `Original branch fast-forwarded to ${integrationCommitSha}`,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async requestRemoteAction(
    input: RequestRemoteActionInput,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      const current = persisted.integration;
      if (
        persisted.run.state === "waiting_user" &&
        current?.state === "awaiting_remote" &&
        current.remote_action?.status === "pending"
      ) {
        return current;
      }
      if (
        persisted.run.state !== "verifying" ||
        (current?.state !== "verified" &&
          !(
            current?.state === "awaiting_remote" &&
            current.remote_action?.status === "cancelled"
          )) ||
        current.strategy !== "pull_request" ||
        current.integration_commit_sha === null
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "Remote handoff requires a verified pull-request integration",
        );
      }
      const remoteName = input.remote_name.trim();
      const repository = input.repository.trim();
      if (
        !/^[A-Za-z0-9._-]{1,100}$/.test(remoteName) ||
        !/^[^\s/]+\/[^\s/]+$/.test(repository)
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "remote action requires a safe remote name and owner/repository",
        );
      }
      const timestamp = this.now().toISOString();
      const remoteAction: RemoteActionRecord = {
        schema_version: 1,
        request_id: randomUUID(),
        action: "push_and_create_pull_request",
        remote_name: remoteName,
        repository,
        branch: current.branch,
        target_branch: current.target_branch,
        commit_sha: current.integration_commit_sha,
        status: "pending",
        attempt_count: 0,
        requested_at: timestamp,
        approved_at: null,
        completed_at: null,
        pull_request_url: null,
        last_error: null,
      };
      const integration: IntegrationRecord = {
        ...current,
        state: "awaiting_remote",
        remote_action: remoteAction,
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.awaiting_remote",
        timestamp,
        state: "waiting_user",
        remote_request_id: remoteAction.request_id,
        message: "Verified integration is waiting for remote-action approval",
      };
      const run: RunRecord = {
        ...persisted.run,
        state: "waiting_user",
        resume_state: "verifying",
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async approveRemoteAction(
    runId: string,
    requestId: string,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      const remote = current?.remote_action;
      if (
        persisted.run.state !== "waiting_user" ||
        current?.state !== "awaiting_remote" ||
        remote?.status !== "pending" ||
        remote.request_id !== requestId
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "remote request ID is unknown or already resolved",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        ...current,
        state: "remote_executing",
        remote_action: {
          ...remote,
          status: "approved",
          approved_at: timestamp,
          last_error: null,
        },
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.remote_approved",
        timestamp,
        state: "verifying",
        remote_request_id: requestId,
        remote_decision: "approve_once",
        message: "One exact push and pull-request action approved",
      };
      const run: RunRecord = {
        ...persisted.run,
        state: "verifying",
        resume_state: null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async cancelRemoteAction(
    runId: string,
    requestId: string,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      const remote = current?.remote_action;
      if (
        persisted.run.state !== "waiting_user" ||
        current?.state !== "awaiting_remote" ||
        remote?.status !== "pending" ||
        remote.request_id !== requestId
      ) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "remote request ID is unknown or already resolved",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        ...current,
        remote_action: {
          ...remote,
          status: "cancelled",
          completed_at: timestamp,
          last_error: "User cancelled the remote action",
        },
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const events: RunEvent[] = [
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 1,
          event_id: randomUUID(),
          event_type: "integration.remote_cancelled",
          timestamp,
          state: "cancelled",
          remote_request_id: requestId,
          remote_decision: "cancel_run",
          message: "User cancelled the remote action; local artifacts preserved",
        },
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 2,
          event_id: randomUUID(),
          event_type: "run.cancelled",
          timestamp,
          state: "cancelled",
          message: "Ark Team run cancelled before remote mutation",
        },
      ];
      const run: RunRecord = {
        ...persisted.run,
        state: "cancelled",
        resume_state: "verifying",
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + events.length,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, ...events],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async beginRemoteAttempt(
    runId: string,
    requestId: string,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      const remote = current?.remote_action;
      if (
        persisted.run.state !== "verifying" ||
        current?.state !== "remote_executing" ||
        (remote?.status !== "approved" && remote?.status !== "executing") ||
        remote.request_id !== requestId ||
        remote.attempt_count >= 3
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "remote execution is not approved for another attempt",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        ...current,
        remote_action: {
          ...remote,
          status: "executing",
          attempt_count: remote.attempt_count + 1,
          last_error: null,
        },
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.remote_attempt",
        timestamp,
        state: "verifying",
        remote_request_id: requestId,
        message: `Remote action attempt ${integration.remote_action?.attempt_count ?? 0} started`,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async failRemoteAttempt(
    runId: string,
    requestId: string,
    rawError: string,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      const remote = current?.remote_action;
      if (
        persisted.run.state !== "verifying" ||
        current?.state !== "remote_executing" ||
        remote?.status !== "executing" ||
        remote.request_id !== requestId
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "remote attempt failure does not match the active request",
        );
      }
      const timestamp = this.now().toISOString();
      const message =
        rawError.trim().slice(0, 1000) || "Remote action failed";
      const exhausted = remote.attempt_count >= 3;
      const nextRemote: RemoteActionRecord = exhausted
        ? {
            ...remote,
            request_id: randomUUID(),
            status: "pending",
            attempt_count: 0,
            requested_at: timestamp,
            approved_at: null,
            completed_at: null,
            pull_request_url: null,
            last_error: message,
          }
        : {
            ...remote,
            status: "approved",
            last_error: message,
          };
      const integration: IntegrationRecord = {
        ...current,
        state: exhausted ? "awaiting_remote" : "remote_executing",
        remote_action: nextRemote,
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.remote_failed",
        timestamp,
        state: exhausted ? "waiting_user" : "verifying",
        remote_request_id: nextRemote.request_id,
        message: exhausted
          ? `Remote action exhausted three attempts; fresh approval required: ${message}`
          : `Remote action attempt failed and remains approved for retry: ${message}`,
      };
      const run: RunRecord = {
        ...persisted.run,
        state: exhausted ? "waiting_user" : "verifying",
        resume_state: exhausted ? "verifying" : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async completeRemoteAction(
    input: CompleteRemoteActionInput,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      const current = persisted.integration;
      const remote = current?.remote_action;
      let pullRequestUrl: URL;
      try {
        pullRequestUrl = new URL(input.pull_request_url);
      } catch (error) {
        throw new ArkTeamError(
          "INVALID_INPUT",
          "remote result requires a valid pull-request URL",
          { cause: error },
        );
      }
      if (
        pullRequestUrl.protocol !== "https:" ||
        pullRequestUrl.hostname.toLowerCase() !== "github.com" ||
        persisted.run.state !== "verifying" ||
        current?.state !== "remote_executing" ||
        remote?.status !== "executing" ||
        remote.request_id !== input.request_id ||
        !pullRequestMatchesRepository(
          pullRequestUrl,
          remote.repository,
        )
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "remote completion does not match the executing approved request",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        ...current,
        state: "remote_completed",
        remote_action: {
          ...remote,
          status: "completed",
          completed_at: timestamp,
          pull_request_url: pullRequestUrl.toString(),
          last_error: null,
        },
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.remote_completed",
        timestamp,
        state: "verifying",
        remote_request_id: input.request_id,
        message: `Pull request created or adopted: ${pullRequestUrl.toString()}`,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async completePmReview(input: CompletePmReviewInput): Promise<RunRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(input.run_id);
      const integration = persisted.integration;
      const pmSession = persisted.pm_session;
      const expectedTeamIds = persisted.teams.map((team) => team.team_id);
      if (
        persisted.run.state !== "verifying" ||
        (integration?.state !== "local_merged" &&
          integration?.state !== "remote_completed") ||
        pmSession === null ||
        pmSession.session_id !== input.session_id ||
        input.report.status !== "completed" ||
        input.report.user_decisions.length > 0 ||
        input.report.integration_verification.some(
          (verification) => verification.status !== "passed",
        ) ||
        input.report.teams.some((team) => team.status !== "completed") ||
        JSON.stringify(input.report.teams.map((team) => team.team_id)) !==
          JSON.stringify(expectedTeamIds)
      ) {
        throw new ArkTeamError(
          "AGENT_SESSION_PROTOCOL_ERROR",
          "PM final report does not accept the verified integration",
        );
      }
      const timestamp = this.now().toISOString();
      const completedPm: PmSessionRecord = {
        ...pmSession,
        turn_count: pmSession.turn_count + 1,
        final_report: input.report,
        final_usage: input.usage,
        completed_at: timestamp,
      };
      const cleaningIntegration: IntegrationRecord = {
        ...integration,
        state: "cleaning",
        cleanup_error: null,
        updated_at: timestamp,
        revision: integration.revision + 1,
      };
      const events: RunEvent[] = [
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 1,
          event_id: randomUUID(),
          event_type: "pm.completed",
          timestamp,
          state: "cleaning",
          agent_role: "pm",
          usage: input.usage,
          message: "PM accepted the integrated result",
        },
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 2,
          event_id: randomUUID(),
          event_type: "integration.cleanup_started",
          timestamp,
          state: "cleaning",
          message: "Verified worktree cleanup started",
        },
      ];
      const run: RunRecord = {
        ...persisted.run,
        state: "cleaning",
        resume_state: null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + events.length,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, ...events],
        assignments: persisted.assignments,
        teams: persisted.teams.map((team) => ({
          ...team,
          state: "integrated",
          updated_at: timestamp,
          revision: team.revision + 1,
        })),
        plan: persisted.plan,
        pm_session: completedPm,
        integration: cleaningIntegration,
      });
      return run;
    });
  }

  async recordTeamCleaned(
    runId: string,
    teamId: string,
  ): Promise<TeamRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const integration = persisted.integration;
      const current = persisted.teams.find((team) => team.team_id === teamId);
      if (
        persisted.run.state !== "cleaning" ||
        integration?.state !== "cleaning" ||
        current === undefined ||
        (current.state !== "integrated" && current.state !== "cleaned")
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "team cleanup does not match a PM-accepted integration",
        );
      }
      if (current.state === "cleaned") {
        return current;
      }
      const timestamp = this.now().toISOString();
      const team: TeamRecord = {
        ...current,
        state: "cleaned",
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const teams = persisted.teams.map((candidate) =>
        candidate.team_id === teamId ? team : candidate,
      );
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "team.cleaned",
        timestamp,
        state: "cleaning",
        team_id: teamId,
        message: `Removed verified team worktree and preserved ${team.branch}`,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return team;
    });
  }

  async recordCleanupFailure(
    runId: string,
    rawError: string,
  ): Promise<IntegrationRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      if (
        persisted.run.state !== "cleaning" ||
        current?.state !== "cleaning"
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "cleanup failure does not match an active cleanup phase",
        );
      }
      const timestamp = this.now().toISOString();
      const message =
        rawError.trim().slice(0, 1000) || "Verified worktree cleanup failed";
      const integration: IntegrationRecord = {
        ...current,
        cleanup_error: message,
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: persisted.run.event_count + 1,
        event_id: randomUUID(),
        event_type: "integration.cleanup_failed",
        timestamp,
        state: "cleaning",
        message,
      };
      const run: RunRecord = {
        ...persisted.run,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + 1,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return integration;
    });
  }

  async completeCleanup(runId: string): Promise<RunRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.integration;
      if (
        persisted.run.state !== "cleaning" ||
        current?.state !== "cleaning" ||
        persisted.teams.some((team) => team.state !== "cleaned")
      ) {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          "cleanup completion requires every registered team worktree",
        );
      }
      const timestamp = this.now().toISOString();
      const integration: IntegrationRecord = {
        ...current,
        state: "cleaned",
        cleanup_error: null,
        cleaned_at: timestamp,
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const events: RunEvent[] = [
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 1,
          event_id: randomUUID(),
          event_type: "integration.cleaned",
          timestamp,
          state: "cleaning",
          message: `Removed integration worktree and preserved ${integration.branch}`,
        },
        {
          schema_version: 1,
          sequence: persisted.run.event_count + 2,
          event_id: randomUUID(),
          event_type: "run.completed",
          timestamp,
          state: "completed",
          message: "Ark Team run completed after verified cleanup",
        },
      ];
      const run: RunRecord = {
        ...persisted.run,
        state: "completed",
        resume_state: null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + events.length,
      };
      await this.writePersistedRun({
        run,
        events: [...persisted.events, ...events],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration,
      });
      return run;
    });
  }

  async failAssignment(
    runId: string,
    assignmentId: string,
    failureMessage: string,
    failureCode?: string,
  ): Promise<AssignmentRecord> {
    return this.finishAssignmentAbnormally(
      runId,
      assignmentId,
      "failed",
      failureMessage,
      failureCode,
    );
  }

  async stopAssignment(
    runId: string,
    assignmentId: string,
    state: "paused" | "cancelled",
    message?: string,
  ): Promise<AssignmentRecord> {
    return this.finishAssignmentAbnormally(
      runId,
      assignmentId,
      state,
      message ?? `Assignment ${state}`,
    );
  }

  async stopActiveAssignments(
    runId: string,
    state: "paused" | "cancelled",
    message?: string,
  ): Promise<AssignmentRecord[]> {
    const active = (
      await this.listAssignments(runId, {
        states: ["running", "waiting_user"],
      })
    ).assignments;
    const stopped: AssignmentRecord[] = [];
    for (const assignment of active) {
      stopped.push(
        await this.stopAssignment(
          runId,
          assignment.assignment_id,
          state,
          message,
        ),
      );
    }
    return stopped;
  }

  async pauseRun(runId: string, reason?: string): Promise<TransitionResult> {
    return this.transition(runId, "pause", reason);
  }

  async resumeRun(runId: string, reason?: string): Promise<TransitionResult> {
    return this.transition(runId, "resume", reason);
  }

  async cancelRun(runId: string, reason?: string): Promise<TransitionResult> {
    return this.transition(runId, "cancel", reason);
  }

  private async transition(
    runId: string,
    operation: "pause" | "resume" | "cancel",
    rawReason?: string,
  ): Promise<TransitionResult> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.run;
      const reason = normalizeReason(rawReason);

      if (operation === "pause" && current.state === "paused") {
        return { run: current, changed: false };
      }
      if (operation === "cancel" && current.state === "cancelled") {
        return { run: current, changed: false };
      }

      let nextState: RunState;
      let resumeState: RunState | null;
      let eventType: RunEvent["event_type"];
      let defaultMessage: string;

      if (operation === "pause") {
        if (!ACTIVE_STATES.has(current.state)) {
          throw invalidTransition(operation, current.state);
        }
        nextState = "paused";
        resumeState = current.state;
        eventType = "run.paused";
        defaultMessage = "Ark Team run paused";
      } else if (operation === "resume") {
        if (
          (current.state !== "paused" && current.state !== "cancelled") ||
          current.resume_state === null
        ) {
          throw invalidTransition(operation, current.state);
        }
        nextState = current.resume_state;
        resumeState = null;
        eventType = "run.resumed";
        defaultMessage = "Ark Team run resumed";
      } else {
        if (current.state === "completed" || current.state === "failed") {
          throw invalidTransition(operation, current.state);
        }
        nextState = "cancelled";
        resumeState = current.state === "paused" ? current.resume_state : current.state;
        eventType = "run.cancelled";
        defaultMessage = "Ark Team run cancelled";
      }

      const timestamp = this.now().toISOString();
      const updatedRun: RunRecord = {
        ...current,
        state: nextState,
        resume_state: resumeState,
        updated_at: timestamp,
        revision: current.revision + 1,
        event_count: current.event_count + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: updatedRun.event_count,
        event_id: randomUUID(),
        event_type: eventType,
        timestamp,
        state: nextState,
        message: reason ?? defaultMessage,
      };

      await this.writePersistedRun({
        run: updatedRun,
        events: [...persisted.events, event],
        assignments: persisted.assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return { run: updatedRun, changed: true };
    });
  }

  private async finishAssignmentAbnormally(
    runId: string,
    assignmentId: string,
    state: "failed" | "paused" | "cancelled",
    rawMessage: string,
    failureCode?: string,
  ): Promise<AssignmentRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = findAssignment(persisted, assignmentId);
      if (current.state === state) {
        return current;
      }
      if (current.state !== "running" && current.state !== "waiting_user") {
        throw new ArkTeamError(
          "INVALID_TRANSITION",
          `Cannot mark an assignment ${state} while it is ${current.state}`,
        );
      }
      const timestamp = this.now().toISOString();
      const message =
        rawMessage.trim().slice(0, 1000) || `Assignment ${state}`;
      const assignment: AssignmentRecord = {
        ...current,
        state,
        pending_approval: null,
        pending_retry: null,
        failure_message: state === "failed" ? message : null,
        updated_at: timestamp,
        revision: current.revision + 1,
      };
      const assignments = persisted.assignments.map((candidate) =>
        candidate.assignment_id === assignmentId ? assignment : candidate,
      );
      const nextState =
        persisted.run.state === "waiting_user" &&
        !assignments.some((candidate) => candidate.state === "waiting_user")
          ? persisted.run.resume_state ?? "executing"
          : persisted.run.state;
      const events: RunEvent[] = [];
      if (state === "cancelled" && current.pending_retry !== null) {
        events.push({
          schema_version: 1,
          sequence: 0,
          event_id: randomUUID(),
          event_type: "assignment.retry_resolved",
          timestamp,
          state: nextState,
          assignment_id: assignment.assignment_id,
          team_id: assignment.team_id,
          agent_role: assignment.role,
          retry_request_id: current.pending_retry.retry_request_id,
          retry_kind: current.pending_retry.kind,
          retry_decision: "cancel_run",
          message: "User cancelled the run after retry exhaustion",
        });
      }
      events.push({
        schema_version: 1,
        sequence: 0,
        event_id: randomUUID(),
        event_type: `assignment.${state}`,
        timestamp,
        state: nextState,
        assignment_id: assignment.assignment_id,
        team_id: assignment.team_id,
        agent_role: assignment.role,
        message,
        ...providerAuditFields(assignment),
        ...(state === "failed" &&
        failureCode !== undefined &&
        assignment.model_binding.kind === "external"
          ? { provider_error_code: failureCode.slice(0, 80) }
          : {}),
      });
      const sequencedEvents = events.map((event, index) => ({
        ...event,
        sequence: persisted.run.event_count + index + 1,
      }));
      const updatedRun: RunRecord = {
        ...persisted.run,
        state: nextState,
        resume_state: nextState === "waiting_user" ? persisted.run.resume_state : null,
        updated_at: timestamp,
        revision: persisted.run.revision + 1,
        event_count: persisted.run.event_count + sequencedEvents.length,
      };
      await this.writePersistedRun({
        run: updatedRun,
        events: [...persisted.events, ...sequencedEvents],
        assignments,
        teams: persisted.teams,
        plan: persisted.plan,
        pm_session: persisted.pm_session,
        integration: persisted.integration,
      });
      return assignment;
    });
  }

  private allocateAssignmentId(persisted: PersistedRun): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const assignmentId = `asg-${this.assignmentSuffix().toLowerCase()}`;
      if (
        ASSIGNMENT_ID_PATTERN.test(assignmentId) &&
        !persisted.assignments.some(
          (assignment) => assignment.assignment_id === assignmentId,
        )
      ) {
        return assignmentId;
      }
    }
    throw new ArkTeamError(
      "STATE_ROOT_UNAVAILABLE",
      "Unable to allocate a unique assignment ID",
    );
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root_path, { recursive: true, mode: 0o700 });
      await access(this.root_path, constants.R_OK | constants.W_OK);
    } catch (error) {
      throw new ArkTeamError(
        "STATE_ROOT_UNAVAILABLE",
        `Unable to access state root: ${this.root_path}`,
        { cause: error },
      );
    }
  }

  private async verificationStartsEnabled(): Promise<boolean> {
    return (await this.readVerificationRollback()) === null;
  }

  private async assertApprovedVerificationPackage(
    projectPath: string,
  ): Promise<void> {
    let packageBytes: string | Uint8Array;
    try {
      packageBytes = await this.verificationPackageLoader(projectPath);
    } catch (error) {
      throw new ArkTeamError(
        "PACKAGE_FINGERPRINT_MISMATCH",
        "unable to read the approved verification package bytes",
        { cause: error },
      );
    }
    assertVerificationPackageBytes(packageBytes);
  }

  private async assertCurrentVerificationSnapshot(
    run: RunRecord,
  ): Promise<void> {
    const snapshot = run.verification_snapshot;
    if (snapshot === null || snapshot.schema_version !== 2) {
      throw new ArkTeamError(
        "CONTRACT_VERSION_MISMATCH",
        "a current contract-v2 verification snapshot is required",
      );
    }
    if (
      snapshot.package.package_fingerprint !==
        APPROVED_VERIFICATION_PACKAGE.package_fingerprint ||
      snapshot.package.package_id !==
        APPROVED_VERIFICATION_PACKAGE.package_id
    ) {
      throw new ArkTeamError(
        "CONTRACT_VERSION_MISMATCH",
        "earlier verification package snapshots are read-only",
      );
    }
    const coordinator = run.project_config.verification.coordinator;
    if (
      coordinator === null ||
      run.project_config_sha256 !== projectConfigSha256(run.project_config) ||
      snapshot.resolved_config_sha256 !==
        sha256CanonicalJson(coordinator) ||
      snapshot.resolved_config_sha256 !==
        sha256CanonicalJson(snapshot.resolved_config)
    ) {
      throw new ArkTeamError(
        "CONFIG_INVALID",
        "verification configuration no longer matches the immutable snapshot",
      );
    }
    await this.assertApprovedVerificationPackage(run.project_path);
    const currentSource = await this.verificationSourceLoader(
      run.project_path,
    );
    assertVerificationSourceIdentity(currentSource, snapshot.source);
  }

  private async readVerificationRollback(): Promise<VerificationRollbackRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.verificationRollbackPath(), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return null;
      }
      throw new ArkTeamError(
        "STATE_ROOT_UNAVAILABLE",
        "unable to read verification rollback state",
        { cause: error },
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new ArkTeamError(
        "CORRUPT_STATE",
        "persisted verification rollback is not valid JSON",
        { cause: error },
      );
    }
    const parsed = verificationRollbackRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.schema_version !== 2) {
      throw new ArkTeamError(
        "CORRUPT_STATE",
        "persisted contract-v2 verification rollback is invalid",
        { cause: parsed.success ? undefined : parsed.error },
      );
    }
    return parsed.data;
  }

  private verificationRollbackPath(): string {
    return path.join(
      this.root_path,
      "verification-contract-v2.rollback.json",
    );
  }

  private async reserveRunDirectory(now: Date): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const runId = createRunId(now, this.suffix());
      try {
        await mkdir(this.runDirectory(runId), { recursive: false, mode: 0o700 });
        return runId;
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          continue;
        }
        throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", "Unable to create run directory", {
          cause: error,
        });
      }
    }

    throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", "Unable to allocate a unique run ID");
  }

  private async readPersistedRun(runId: string): Promise<PersistedRun> {
    assertRunId(runId);
    let raw: string;
    try {
      raw = await readFile(this.recordPath(runId), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ArkTeamError("RUN_NOT_FOUND", `Run not found: ${runId}`, { cause: error });
      }
      throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", `Unable to read run: ${runId}`, {
        cause: error,
      });
    }

    try {
      return persistedRunSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new ArkTeamError("CORRUPT_STATE", `Persisted run is invalid: ${runId}`, {
        cause: error,
      });
    }
  }

  private async writePersistedRun(persisted: PersistedRun): Promise<void> {
    const validated = persistedRunSchema.parse(persisted);
    const runDirectory = this.runDirectory(validated.run.run_id);
    const finalPath = this.recordPath(validated.run.run_id);
    const temporaryPath = path.join(
      runDirectory,
      `.run-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );

    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify(validated, null, 2)}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, finalPath);
      const directory = await open(
        runDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new ArkTeamError(
        "STATE_ROOT_UNAVAILABLE",
        `Unable to persist run: ${validated.run.run_id}`,
        { cause: error },
      );
    }
  }

  private runDirectory(runId: string): string {
    assertRunId(runId);
    return path.join(this.root_path, runId);
  }

  private recordPath(runId: string): string {
    return path.join(this.runDirectory(runId), "run.json");
  }

  private assertVerificationCoordinatorAuthority(
    authority: symbol | undefined,
  ): void {
    if (
      this.#verificationCoordinatorAuthority !== null &&
      authority !== this.#verificationCoordinatorAuthority
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "verification mutation requires coordinator authority",
      );
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

type VerificationStateValue = VerificationStage | VerificationOutcome;
type VerificationRunSnapshotV2 = Extract<
  VerificationRunSnapshot,
  { schema_version: 2 }
>;
type VerificationLinkedRecordV2 = Extract<
  VerificationLinkedRecord,
  { schema_version: 2 }
>;

function isVerificationTransitionAllowed(
  current: VerificationStateValue,
  next: VerificationStateValue,
): boolean {
  const transitions: Partial<
    Record<VerificationStateValue, readonly VerificationStateValue[]>
  > = {
    integrated: ["configured"],
    configured: ["snapshotted"],
    snapshotted: ["capabilities"],
    capabilities: ["ready"],
    ready: ["executing"],
    executing: ["collecting"],
    collecting: ["deciding"],
    deciding: ["passed", "failed", "unavailable", "skipped", "error"],
    passed: ["pm_review_pending"],
    pm_review_pending: ["original_pm_review"],
  };
  return transitions[current]?.includes(next) ?? false;
}

function verificationAdapterRecordStage(
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

function verificationActionStage(
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
    "cleanup attempts are post-terminal operational work",
  );
}

function verificationRecordMatchesAttempt(
  kind: VerificationActionKind,
  lane: "backend" | "ui" | null,
  checkId: string | null,
  record: Extract<VerificationLinkedRecord, { schema_version: 2 }>,
): boolean {
  if (kind === "readiness") {
    return (
      record.record_type === "capability" &&
      record.lane !== null &&
      record.check_id === null
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
  return (
    expectedRecordType !== null &&
    record.record_type === expectedRecordType &&
    record.lane === lane &&
    record.check_id === checkId
  );
}

function verificationCoordinatorErrorCode(
  error: unknown,
): VerificationErrorCode {
  if (
    error instanceof ArkTeamError &&
    verificationErrorCodeSchema.safeParse(error.code).success
  ) {
    return error.code as VerificationErrorCode;
  }
  return "INVALID_RECORD";
}

function isTerminalVerificationActionError(
  code: VerificationErrorCode,
): boolean {
  return (
    code === "INVALID_RECORD" ||
    code === "APPROVAL_REQUIRED" ||
    verificationErrorDisposition(code).integrity_failure
  );
}

function verificationAttemptBudgetScopeKey(input: {
  kind: VerificationActionKind;
  lane: "backend" | "ui" | null;
  check_id: string | null;
  input_sha256: string;
}): string {
  return [
    input.kind,
    input.lane ?? "",
    input.check_id ?? "",
    input.kind === "artifact_write" ? input.input_sha256 : "",
  ].join("\0");
}

function assertVerificationAttemptScope(
  snapshot: VerificationRunSnapshotV2,
  input: RecordVerificationAttemptInput,
): void {
  const mustBeBackend = input.kind === "api";
  const mustBeUi = [
    "browser",
    "agentic_browser",
    "screenshot",
    "semantic_review",
    "comparison",
  ].includes(input.kind);
  const mustBeCommon = input.kind === "readiness" || input.kind === "cleanup";
  if (
    (mustBeBackend && input.lane !== "backend") ||
    (mustBeUi && input.lane !== "ui") ||
    ((mustBeBackend || mustBeUi) && input.check_id === null) ||
    (mustBeCommon && (input.lane !== null || input.check_id !== null))
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "verification action does not match its immutable lane scope",
    );
  }
  if (
    input.lane === "backend" &&
    !snapshot.backend_contract.enabled
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "backend verification action targets a disabled lane",
    );
  }
  if (input.lane === "ui" && !snapshot.ui_contract.enabled) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "UI verification action targets a disabled lane",
    );
  }
  if (
    input.check_id !== null &&
    expectedVerificationCheckRequired(
      snapshot,
      input.lane,
      input.check_id,
    ) === null
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "verification action targets an unknown snapshotted check",
    );
  }
}

function assertCompleteVerificationCapabilityMatrix(run: RunRecord): void {
  const snapshot = run.verification_snapshot;
  const state = run.verification_state;
  if (snapshot?.schema_version !== 2 || state === null) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "capability discovery requires a contract-v2 coordinator state",
    );
  }
  const readinessAttempt = state.attempts.find(
    (attempt) => attempt.kind === "readiness",
  );
  if (
    readinessAttempt === undefined ||
    readinessAttempt.status !== "succeeded"
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "capability discovery must finish one durable readiness action",
    );
  }
  const recordById = new Map(
    run.verification_records.map((record) => [record.record_id, record]),
  );
  const evidence = readinessAttempt.decisive_evidence_record_ids.map(
    (recordId) => recordById.get(recordId),
  );
  const demands = [
    ...(snapshot.backend_contract.enabled
      ? [
          ...snapshot.backend_contract.required_capabilities.map(
            (capability) => `backend\0${capability}`,
          ),
        ]
      : []),
    ...(snapshot.ui_contract.enabled
      ? [
          ...snapshot.ui_contract.required_capabilities.map(
            (capability) => `ui\0${capability}`,
          ),
          ...snapshot.ui_contract.optional_capabilities.map(
            (capability) => `ui\0${capability}`,
          ),
        ]
      : []),
  ].sort();
  const discovered = evidence.flatMap((record) =>
    record?.schema_version === 2 &&
    record.payload.kind === "capability" &&
    record.lane !== null &&
    record.payload.diagnostic !== undefined
      ? [`${record.lane}\0${record.payload.capability}`]
      : [],
  ).sort();
  if (
    evidence.length !== demands.length ||
    discovered.length !== demands.length ||
    new Set(discovered).size !== discovered.length ||
    demands.some((demand, index) => demand !== discovered[index])
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "capability discovery must persist the exact immutable lane matrix once",
    );
  }
}

function expectedVerificationCheckRequired(
  snapshot: VerificationRunSnapshotV2,
  lane: "backend" | "ui" | null,
  checkId: string,
): boolean | null {
  if (lane === "backend" && snapshot.backend_contract.enabled) {
    return (
      snapshot.backend_contract.api_probes.find(
        (probe) => probe.id === checkId,
      )?.required ?? null
    );
  }
  if (lane === "ui" && snapshot.ui_contract.enabled) {
    return (
      snapshot.ui_contract.browser_cases.find(
        (browserCase) => browserCase.id === checkId,
      )?.required ??
      snapshot.ui_contract.agentic_tasks.find(
        (task) => task.id === checkId,
      )?.required ??
      null
    );
  }
  return null;
}

function deriveVerificationLaneDecision(
  snapshot: VerificationRunSnapshotV2,
  lane: VerificationLaneDecisionInput,
  records: Map<string, VerificationLinkedRecord>,
  supersededEvidenceIds: ReadonlySet<string>,
): VerificationLaneDecisionInput {
  const expectedChecks =
    lane.lane === "backend"
      ? snapshot.backend_contract.enabled
        ? snapshot.backend_contract.api_probes.map((probe) => ({
            id: probe.id,
            required: probe.required,
          }))
        : []
      : snapshot.ui_contract.enabled
        ? [
            ...snapshot.ui_contract.browser_cases.map((browserCase) => ({
              id: browserCase.id,
              required: browserCase.required,
            })),
            ...snapshot.ui_contract.agentic_tasks.map((task) => ({
              id: task.id,
              required: task.required,
            })),
          ]
        : [];
  if (
    lane.checks.length !== expectedChecks.length ||
    new Set(lane.checks.map((check) => check.check_id)).size !==
      lane.checks.length ||
    expectedChecks.some(
      (expected) =>
        !lane.checks.some(
          (check) =>
            check.check_id === expected.id &&
            check.required === expected.required,
        ),
    )
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "lane decision does not match the exact snapshotted check set",
    );
  }
  const checks = lane.checks.map((check) => {
    const matchingEvidence = [...records.values()].filter(
      (record): record is VerificationLinkedRecordV2 =>
        record.schema_version === 2 &&
        record.lane === lane.lane &&
        record.check_id === check.check_id &&
        !supersededEvidenceIds.has(record.record_id) &&
        verificationEvidenceDisposition(record) !== null,
    );
    if (matchingEvidence.length === 0) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "lane decision requires check-scoped persisted evidence",
      );
    }
    const evidenceRecordIds = matchingEvidence
      .map((record) => record.record_id)
      .sort();
    const submittedRecordIds = [...check.evidence_record_ids].sort();
    if (
      evidenceRecordIds.length !== submittedRecordIds.length ||
      evidenceRecordIds.some(
        (recordId, index) => recordId !== submittedRecordIds[index],
      )
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "lane decision must link every persisted record for its check",
      );
    }
    const dispositions = matchingEvidence.map((record) => {
      const disposition = verificationEvidenceDisposition(record);
      if (disposition === null) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "lane decision linked non-outcome evidence",
        );
      }
      if (
        record.payload.kind === "error" &&
        (record.payload.outcome !== disposition.outcome ||
          record.payload.integrity_failure !==
            disposition.integrity_failure)
      ) {
        throw new ArkTeamError(
          "INVALID_RECORD",
          "verification error disposition does not match its closed code",
        );
      }
      return disposition;
    });
    const integrityFailure = dispositions.some(
      (disposition) => disposition.integrity_failure,
    );
    const outcome = integrityFailure
      ? "error"
      : aggregateVerificationOutcomes(
          dispositions.map((disposition) => disposition.outcome),
        );
    if (
      check.outcome !== outcome ||
      check.integrity_failure !== integrityFailure
    ) {
      throw new ArkTeamError(
        "INVALID_RECORD",
        "lane decision outcome does not match persisted evidence",
      );
    }
    return {
      ...check,
      outcome,
      integrity_failure: integrityFailure,
      evidence_record_ids: evidenceRecordIds,
    };
  });
  return { lane: lane.lane, checks };
}

function supersededVerificationEvidenceRecordIds(
  attempts: NonNullable<RunRecord["verification_state"]>["attempts"],
): ReadonlySet<string> {
  return new Set(
    attempts.flatMap((attempt) =>
      attempt.evidence_record_ids.filter(
        (recordId) =>
          !attempt.decisive_evidence_record_ids.includes(recordId),
      ),
    ),
  );
}

function aggregateVerificationChecks(
  checks: VerificationLaneDecisionInput["checks"],
): VerificationOutcome {
  if (checks.some((check) => check.integrity_failure)) {
    return "error";
  }
  const requiredOutcomes = checks.flatMap((check) =>
    check.required ? [check.outcome] : [],
  );
  return aggregateVerificationOutcomes(requiredOutcomes);
}

function aggregateVerificationOutcomes(
  outcomes: VerificationOutcome[],
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

function createVerificationCoordinatorErrorRecord(input: {
  run: RunRecord;
  timestamp: string;
  action_id?: string;
  code: VerificationErrorCode;
  message: string;
  attempt_count: number;
  evidence_record_ids: string[];
  lane?: "backend" | "ui" | null;
  check_id?: string | null;
  request_sha256?: string;
  capability?: VerificationCapability;
}): VerificationLinkedRecord {
  const snapshot = input.run.verification_snapshot;
  if (snapshot === null || snapshot.schema_version !== 2) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "verification error records require a contract-v2 snapshot",
    );
  }
  const lane = input.lane ?? null;
  const checkId = input.check_id ?? null;
  const checkRequired =
    checkId === null
      ? false
      : (expectedVerificationCheckRequired(snapshot, lane, checkId) ?? false);
  const laneRequired =
    lane === null
      ? null
      : lane === "backend"
        ? snapshot.backend_contract.enabled
          ? snapshot.backend_contract.required
          : null
        : snapshot.ui_contract.enabled
          ? snapshot.ui_contract.required
          : null;
  const approvalRequestSha256 =
    input.code === "APPROVAL_REQUIRED"
      ? (input.request_sha256 ??
        input.run.verification_state?.attempts.find(
          (attempt) => attempt.action_id === input.action_id,
        )?.input_sha256 ??
        sha256CanonicalJson({
          action_id: input.action_id ?? null,
          code: input.code,
          message: input.message.trim().slice(0, 1_000),
        }))
      : undefined;
  const capabilityRequired =
    input.capability === undefined
      ? true
      : lane === "backend" && snapshot.backend_contract.enabled
        ? snapshot.backend_contract.required_capabilities.includes(
            input.capability as "api" | "server",
          )
        : lane === "ui" && snapshot.ui_contract.enabled
          ? snapshot.ui_contract.required_capabilities.includes(
              input.capability,
            )
          : false;
  const disposition =
    input.code === "APPROVAL_REQUIRED"
      ? { outcome: "error" as const, integrity_failure: false }
      : (input.code === "CAPABILITY_UNAVAILABLE" ||
            input.code === "SERVER_NOT_READY") &&
          !(
            laneRequired === true &&
            checkRequired &&
            capabilityRequired
          )
        ? { outcome: "skipped" as const, integrity_failure: false }
        : verificationErrorDisposition(input.code);
  const payload = {
    kind: "error" as const,
    code: input.code,
    message: input.message.trim().slice(0, 1_000),
    ...(input.action_id === undefined
      ? {}
      : { action_id: input.action_id }),
    attempt_count: input.attempt_count,
    evidence_record_ids: input.evidence_record_ids,
    outcome: disposition.outcome,
    integrity_failure: disposition.integrity_failure,
    ...(input.code === "APPROVAL_REQUIRED"
      ? {
          approval_id: randomUUID(),
          request_sha256: approvalRequestSha256!,
        }
      : {}),
    ...((input.code === "CAPABILITY_UNAVAILABLE" ||
      input.code === "SERVER_NOT_READY") &&
    input.capability !== undefined
      ? {
          capability: input.capability,
          capability_required: capabilityRequired,
        }
      : {}),
  };
  const current = input.run.verification_state?.current_state;
  const stage: VerificationStage =
    current !== undefined &&
    !["passed", "failed", "unavailable", "skipped", "error"].includes(
      current,
    )
      ? (current as VerificationStage)
      : "deciding";
  return {
    schema_version: 2,
    contract_id: "verification_contract_v2",
    record_id: `verification-error-${randomUUID()}`,
    record_type: "error",
    run_id: input.run.run_id,
    case_id: snapshot.case_id,
    check_id: checkId,
    snapshot_id: snapshot.snapshot_id,
    lane,
    stage,
    timestamp_utc: input.timestamp,
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    lane_required: laneRequired,
    check_required: checkRequired,
    previous_record_sha256: sha256CanonicalJson(
      input.run.verification_records.at(-1)!,
    ),
    payload_sha256: sha256CanonicalJson(payload),
    payload,
    adapter: null,
    model: null,
    artifact_references: [],
  };
}

function createApprovalTerminalReportRecord(input: {
  run: RunRecord;
  snapshot: VerificationRunSnapshotV2;
  timestamp: string;
  error_record: VerificationLinkedRecord;
  previous_record: VerificationLinkedRecord;
}): VerificationLinkedRecord {
  if (
    input.error_record.schema_version !== 2 ||
    input.error_record.payload.kind !== "error" ||
    input.error_record.payload.code !== "APPROVAL_REQUIRED" ||
    input.error_record.payload.approval_id === undefined
  ) {
    throw new ArkTeamError(
      "INVALID_RECORD",
      "approval terminal report requires one opaque approval error",
    );
  }
  const payload = {
    kind: "report" as const,
    outcome: "error" as const,
    evidence_record_ids: [input.error_record.record_id],
  };
  return {
    schema_version: 2,
    contract_id: "verification_contract_v2",
    record_id: `${input.run.run_id}-terminal-report`,
    record_type: "report",
    run_id: input.run.run_id,
    case_id: input.snapshot.case_id,
    check_id: null,
    snapshot_id: input.snapshot.snapshot_id,
    lane: null,
    stage: "deciding",
    timestamp_utc: input.timestamp,
    source_fingerprint: input.snapshot.source_fingerprint,
    package_fingerprint: input.snapshot.package.package_fingerprint,
    lane_required: null,
    check_required: true,
    previous_record_sha256: sha256CanonicalJson(input.previous_record),
    payload_sha256: sha256CanonicalJson(payload),
    payload,
    adapter: null,
    model: null,
    artifact_references: [],
  };
}

function verificationActionErrorRecordId(actionId: string): string {
  return `error-${sha256CanonicalJson(actionId).slice(0, 24)}`;
}

function createVerificationCleanupRecord(
  run: RunRecord,
  disposition: "retention_active" | "cleaned" | "cleanup_error",
  timestamp: string,
  message: string | null = null,
): VerificationLinkedRecord {
  const snapshot = run.verification_snapshot;
  if (snapshot === null || snapshot.schema_version !== 2) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      "cleanup records require a contract-v2 run snapshot",
    );
  }
  const payload =
    disposition === "cleanup_error"
      ? {
          kind: "cleanup" as const,
          disposition,
          code: "ARTIFACT_ROOT_INVALID" as const,
          message:
            message?.trim().slice(0, 1_000) ||
            "registered artifact cleanup failed closed",
        }
      : {
          kind: "cleanup" as const,
          disposition,
          code: null,
          message: null,
        };
  const artifactReferences = run.verification_records.flatMap((record) =>
    record.payload.kind === "artifact"
      ? [
          {
            artifact_id: record.payload.artifact_id,
            relative_path: record.payload.relative_path,
            sha256: record.payload.sha256,
          },
        ]
      : [],
  );
  return {
    schema_version: 2,
    contract_id: "verification_contract_v2",
    record_id:
      disposition === "retention_active"
        ? "cleanup-retention"
        : "cleanup-terminal",
    record_type: "cleanup",
    run_id: run.run_id,
    case_id: snapshot.case_id,
    check_id: null,
    snapshot_id: snapshot.snapshot_id,
    lane: null,
    stage: "deciding",
    timestamp_utc: timestamp,
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    lane_required: null,
    check_required: false,
    previous_record_sha256: sha256CanonicalJson(
      run.verification_records.at(-1)!,
    ),
    payload_sha256: sha256CanonicalJson(payload),
    payload,
    adapter: null,
    model: null,
    artifact_references: artifactReferences,
  };
}

function retryAttemptEvents(input: {
  persisted: PersistedRun;
  assignment: AssignmentRecord;
  timestamp: string;
  next_state: RunState;
  event_type: "assignment.retrying" | "assignment.correction";
  message: string;
  retry_request_id?: string;
  retry_kind?: RetryRequestKind;
}): RunEvent[] {
  const events: RunEvent[] = [];
  if (input.retry_request_id !== undefined) {
    events.push({
      schema_version: 1,
      sequence: 0,
      event_id: randomUUID(),
      event_type: "assignment.retry_resolved",
      timestamp: input.timestamp,
      state: input.next_state,
      assignment_id: input.assignment.assignment_id,
      team_id: input.assignment.team_id,
      agent_role: input.assignment.role,
      retry_request_id: input.retry_request_id,
      ...(input.retry_kind === undefined
        ? {}
        : { retry_kind: input.retry_kind }),
      retry_decision: "retry_once",
      message: "User authorized one additional assignment retry",
    });
  }
  events.push({
    schema_version: 1,
    sequence: 0,
    event_id: randomUUID(),
    event_type: input.event_type,
    timestamp: input.timestamp,
    state: input.next_state,
    assignment_id: input.assignment.assignment_id,
    team_id: input.assignment.team_id,
    agent_role: input.assignment.role,
    session_attempt_count: input.assignment.session_attempt_count,
    correction_count: input.assignment.correction_count,
    message: input.message,
    ...providerAuditFields(input.assignment),
  });
  return events.map((event, index) => ({
    ...event,
    sequence: input.persisted.run.event_count + index + 1,
  }));
}

function providerAuditFields(assignment: AssignmentRecord) {
  const binding = assignment.model_binding;
  if (binding.kind === "native") {
    return {};
  }
  return {
    provider_id: binding.provider_id,
    app_server_provider_id: binding.app_server_provider_id,
    adapter_id: binding.adapter_id,
    adapter_api_version: binding.adapter_api_version,
    adapter_sha256: binding.adapter_sha256,
    provider_config_sha256: binding.provider_config_sha256,
    model: binding.model,
    requested_reasoning_effort:
      binding.requested_reasoning_effort,
    effective_reasoning_effort:
      binding.effective_reasoning_effort,
    structured_output_mode: binding.structured_output_mode,
  };
}

function invalidTransition(operation: string, state: RunState): ArkTeamError {
  return new ArkTeamError(
    "INVALID_TRANSITION",
    `Cannot ${operation} a run while it is ${state}`,
  );
}

function assertRunAcceptsAssignments(state: RunState): void {
  if (
    state === "cleaning" ||
    state === "paused" ||
    state === "cancelled" ||
    state === "completed" ||
    state === "failed"
  ) {
    throw new ArkTeamError(
      "INVALID_TRANSITION",
      `Cannot start an assignment while the run is ${state}`,
    );
  }
}

function pullRequestMatchesRepository(
  url: URL,
  repository: string,
): boolean {
  const [owner, name] = repository.split("/");
  const parts = url.pathname.split("/").filter(Boolean);
  return (
    owner !== undefined &&
    name !== undefined &&
    parts.length === 4 &&
    parts[0]?.toLowerCase() === owner.toLowerCase() &&
    parts[1]?.toLowerCase() === name.toLowerCase() &&
    parts[2] === "pull" &&
    /^[1-9]\d*$/.test(parts[3] ?? "")
  );
}

function findAssignment(
  persisted: PersistedRun,
  assignmentId: string,
): AssignmentRecord {
  if (!ASSIGNMENT_ID_PATTERN.test(assignmentId)) {
    throw new ArkTeamError("INVALID_INPUT", "assignment_id is invalid");
  }
  const assignment = persisted.assignments.find(
    (candidate) => candidate.assignment_id === assignmentId,
  );
  if (!assignment) {
    throw new ArkTeamError(
      "ASSIGNMENT_NOT_FOUND",
      `Assignment not found: ${assignmentId}`,
    );
  }
  return assignment;
}

function normalizeReason(reason?: string): string | undefined {
  const normalized = reason?.trim();
  return normalized ? normalized.slice(0, 1000) : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
