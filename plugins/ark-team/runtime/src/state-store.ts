import { constants } from "node:fs";
import {
  access,
  link,
  mkdir,
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
  type VerificationLinkedRecord,
  type VerificationRollbackRecord,
  type VerificationSourceIdentity,
  verificationRecordMatchesSnapshot,
  verificationRollbackRecordSchema,
  verificationRunSnapshotSha256,
} from "./verification-contract.js";
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
        model_bindings: {
          worker: workerBinding,
        },
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
  ): Promise<RunRecord> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      await this.assertApprovedVerificationPackage(
        persisted.run.project_path,
      );
      assertVerificationPackageFingerprint(input.package_fingerprint);
      if (persisted.run.verification_snapshot !== null) {
        if (persisted.run.verification_snapshot.schema_version !== 2) {
          throw new ArkTeamError(
            "CONTRACT_VERSION_MISMATCH",
            "contract-v1 verification evidence is read-only",
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
  ): Promise<RunRecord> {
    return this.withMutation(async () => {
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
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, finalPath);
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

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
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
