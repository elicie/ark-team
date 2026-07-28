import path from "node:path";

import { z } from "zod/v4";

import {
  managedOutputContracts,
  managedOutputSchema,
  pmPlanSchema,
  pmReportSchema,
} from "./role-contracts.js";
import {
  DEFAULT_PROJECT_CONFIG,
  projectConfigSha256,
  projectConfigSchema,
} from "./project-config.js";
import {
  createNativeModelBinding,
  NATIVE_WORKER_MODEL_BINDING,
  resolvedModelBindingV1Schema,
} from "./provider-types.js";
import {
  sha256CanonicalJson,
  verificationCleanupAuditSchema,
  verificationCoordinatorStateSchema,
  verificationEvidenceDisposition,
  verificationLinkedRecordSchema,
  verificationRecordMatchesSnapshot,
  verificationResolvedConfigMatchesProjectConfig,
  verificationRunSnapshotSchema,
  verificationRunSnapshotSha256,
  type VerificationActionKind,
  type VerificationLinkedRecord,
  type VerificationOutcome,
} from "./verification-contract.js";

export const RUN_ID_PATTERN = /^ark-\d{8}t\d{6}z-[a-z0-9]{6}$/;
export const ASSIGNMENT_ID_PATTERN = /^asg-[a-f0-9]{12}$/;
export const TEAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const runStateSchema = z.enum([
  "planning",
  "staffing",
  "executing",
  "integrating",
  "verifying",
  "cleaning",
  "waiting_user",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);

export type RunState = z.infer<typeof runStateSchema>;

export const assignmentStateSchema = z.enum([
  "running",
  "waiting_user",
  "completed",
  "failed",
  "paused",
  "cancelled",
]);

export type AssignmentState = z.infer<typeof assignmentStateSchema>;

export const teamStateSchema = z.enum([
  "ready",
  "active",
  "completed",
  "integrated",
  "cleaned",
  "failed",
]);

export type TeamState = z.infer<typeof teamStateSchema>;

export const assignmentRoleSchema = z.enum(["pl", "worker", "integration_pl"]);
export type AssignmentRole = z.infer<typeof assignmentRoleSchema>;

function legacyNativeAssignmentBinding(role: AssignmentRole) {
  return role === "worker"
    ? NATIVE_WORKER_MODEL_BINDING
    : createNativeModelBinding("gpt-5.6-terra", "xhigh");
}

export const eventAgentRoleSchema = z.enum([
  "pm",
  "pl",
  "worker",
  "integration_pl",
]);

export const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  cache_write_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative(),
});

export const pendingApprovalSchema = z.object({
  approval_id: z.string().uuid(),
  kind: z.enum(["command", "file_change", "permissions"]),
  reason: z.string().nullable(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  grant_root: z.string().optional(),
  requested_permissions: z.unknown().optional(),
  resolution: z
    .object({
      decision: z.enum([
        "approve_once",
        "approve_session",
        "decline",
        "cancel",
      ]),
      source: z.enum(["user", "routine_policy"]),
      recorded_at: z.string().min(1),
    })
    .nullable()
    .default(null),
});

export const retryRequestKindSchema = z.enum([
  "internal_failure_exhausted",
  "correction_exhausted",
]);

export type RetryRequestKind = z.infer<typeof retryRequestKindSchema>;

export const retryModeSchema = z.enum(["fresh_session", "resume_session"]);
export type RetryMode = z.infer<typeof retryModeSchema>;

export const pendingRetryRequestSchema = z
  .object({
    retry_request_id: z.string().uuid(),
    kind: retryRequestKindSchema,
    mode: retryModeSchema,
    reason: z.string().min(1).max(1000),
  })
  .superRefine((request, context) => {
    if (
      (request.kind === "internal_failure_exhausted" &&
        request.mode !== "fresh_session") ||
      (request.kind === "correction_exhausted" &&
        request.mode !== "resume_session")
    ) {
      context.addIssue({
        code: "custom",
        message: "retry request kind and mode do not match",
      });
    }
  });

export type PendingRetryRequest = z.infer<typeof pendingRetryRequestSchema>;

export const reportTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("controller"),
  }),
  z.object({
    type: z.literal("pm"),
  }),
  z.object({
    type: z.literal("assignment"),
    assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN),
  }),
]);

export type ReportTarget = z.infer<typeof reportTargetSchema>;

export const assignmentRecordSchema = z
  .object({
    schema_version: z.literal(1),
    assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN),
    run_id: z.string().regex(RUN_ID_PATTERN),
    team_id: z.string().regex(TEAM_ID_PATTERN),
    role: assignmentRoleSchema,
    parent_assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN).nullable(),
    report_target: reportTargetSchema,
    assignment: z.string().min(1),
    task_key: z.string().regex(TEAM_ID_PATTERN).nullable().default(null),
    working_directory: z.string().min(1),
    output_contract: z.enum(managedOutputContracts).nullable().default(null),
    state: assignmentStateSchema,
    session_id: z.string().min(1).nullable(),
    turn_id: z.string().min(1).nullable(),
    pending_approval: pendingApprovalSchema.nullable(),
    pending_retry: pendingRetryRequestSchema.nullable().default(null),
    final_report: z.string().min(1).nullable(),
    structured_report: managedOutputSchema.nullable().default(null),
    usage: usageSchema.nullable(),
    failure_message: z.string().min(1).nullable(),
    report_routed_at: z.string().min(1).nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    revision: z.number().int().positive(),
    turn_count: z.number().int().positive().default(1),
    session_attempt_count: z.number().int().positive().default(1),
    correction_count: z.number().int().nonnegative().default(0),
    model_binding: resolvedModelBindingV1Schema.optional(),
  })
  .strict()
  .transform((assignment) => ({
    ...assignment,
    model_binding:
      assignment.model_binding ??
      legacyNativeAssignmentBinding(assignment.role),
  }))
  .superRefine((assignment, context) => {
    if (
      assignment.role === "pl" &&
      (assignment.parent_assignment_id !== null ||
        (assignment.report_target.type !== "pm" &&
          assignment.report_target.type !== "controller"))
    ) {
      context.addIssue({
        code: "custom",
        message: "PL assignments must report to PM or the controller",
      });
    }
    if (
      assignment.role === "pl" &&
      assignment.output_contract !== null &&
      assignment.output_contract !== "pl_worker_plan" &&
      assignment.output_contract !== "pl_report"
    ) {
      context.addIssue({
        code: "custom",
        message: "PL assignments require a PL output contract",
      });
    }
    if (
      assignment.role === "integration_pl" &&
      (assignment.team_id !== "integration" ||
        assignment.parent_assignment_id !== null ||
        assignment.report_target.type !== "pm" ||
        assignment.task_key !== null ||
        assignment.output_contract !== "integration_report")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "integration PL assignments require the integration identity and report contract",
      });
    }
    if (
      assignment.role === "worker" &&
      assignment.output_contract !== null &&
      assignment.output_contract !== "worker_report"
    ) {
      context.addIssue({
        code: "custom",
        message: "worker assignments require worker_report",
      });
    }
    if (
      assignment.role === "pl" &&
      assignment.output_contract === "pl_worker_plan" &&
      assignment.report_target.type !== "controller"
    ) {
      context.addIssue({
        code: "custom",
        message: "PL worker plans must route to the controller",
      });
    }
    if (
      assignment.role === "pl" &&
      assignment.output_contract === "pl_report" &&
      assignment.report_target.type !== "pm"
    ) {
      context.addIssue({
        code: "custom",
        message: "final PL reports must route to PM",
      });
    }
    if (
      assignment.role === "worker" &&
      (assignment.task_key !== null || assignment.output_contract !== null) &&
      (assignment.task_key === null || assignment.output_contract === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "managed workers require task_key and output_contract",
      });
    }
    if (
      assignment.role === "worker" &&
      (assignment.parent_assignment_id === null ||
        assignment.report_target.type !== "assignment" ||
        assignment.report_target.assignment_id !== assignment.parent_assignment_id)
    ) {
      context.addIssue({
        code: "custom",
        message: "worker assignments must report to their owning PL assignment",
      });
    }
    if (
      assignment.state === "waiting_user" &&
      ((assignment.pending_approval === null) ===
        (assignment.pending_retry === null))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "waiting assignments require exactly one approval or retry request",
      });
    }
    if (
      assignment.state === "waiting_user" &&
      assignment.pending_approval !== null &&
      (!assignment.session_id || !assignment.turn_id)
    ) {
      context.addIssue({
        code: "custom",
        message: "approval waiting requires session and turn data",
      });
    }
    if (
      assignment.state === "completed" &&
      (!assignment.session_id ||
        !assignment.turn_id ||
        !assignment.final_report ||
        assignment.usage === null ||
        !assignment.report_routed_at ||
        (assignment.output_contract !== null &&
          assignment.structured_report === null))
    ) {
      context.addIssue({
        code: "custom",
        message: "completed assignments require report-routing evidence and usage",
      });
    }
    if (
      assignment.structured_report !== null &&
      assignment.output_contract !== assignment.structured_report.kind
    ) {
      context.addIssue({
        code: "custom",
        message: "structured report kind must match output_contract",
      });
    }
    if (
      assignment.state !== "waiting_user" &&
      (assignment.pending_approval !== null ||
        assignment.pending_retry !== null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "only waiting assignments may retain a pending approval or retry request",
      });
    }
  });

export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;

export const teamRecordSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().regex(RUN_ID_PATTERN),
  team_id: z.string().regex(TEAM_ID_PATTERN),
  mission: z.string().min(1),
  worker_count: z.number().int().min(1).max(5),
  dependencies: z.array(z.string().regex(TEAM_ID_PATTERN)).max(3),
  owned_paths: z.array(z.string().min(1)).max(100),
  acceptance_criteria: z.array(z.string().min(1)).min(1).max(50),
  verification: z.array(z.string().min(1)).min(1).max(50),
  isolation_mode: z.literal("git_worktree"),
  working_directory: z.string().min(1),
  branch: z.string().min(1),
  target_branch: z.string().min(1).nullable().default(null),
  base_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  state: teamStateSchema,
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  revision: z.number().int().positive(),
});

export type TeamRecord = z.infer<typeof teamRecordSchema>;

export const integrationStateSchema = z.enum([
  "ready",
  "active",
  "verified",
  "local_merged",
  "awaiting_remote",
  "remote_executing",
  "remote_completed",
  "cleaning",
  "cleaned",
  "failed",
]);

export const remoteActionRecordSchema = z.object({
  schema_version: z.literal(1),
  request_id: z.string().uuid(),
  action: z.literal("push_and_create_pull_request"),
  remote_name: z.string().min(1).max(100),
  repository: z.string().min(3).max(300),
  branch: z.string().min(1),
  target_branch: z.string().min(1),
  commit_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  status: z.enum([
    "pending",
    "approved",
    "executing",
    "completed",
    "cancelled",
  ]),
  attempt_count: z.number().int().min(0).max(3),
  requested_at: z.string().min(1),
  approved_at: z.string().min(1).nullable(),
  completed_at: z.string().min(1).nullable(),
  pull_request_url: z.string().url().nullable(),
  last_error: z.string().min(1).max(1000).nullable(),
});

export type RemoteActionRecord = z.infer<typeof remoteActionRecordSchema>;

export const integrationRecordSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().regex(RUN_ID_PATTERN),
    strategy: z.enum(["local_merge", "pull_request"]),
    team_ids: z.array(z.string().regex(TEAM_ID_PATTERN)).min(1).max(4),
    working_directory: z.string().min(1),
    branch: z.string().min(1),
    target_branch: z.string().min(1),
    base_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    state: integrationStateSchema,
    assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN).nullable(),
    integration_commit_sha: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    verified_at: z.string().min(1).nullable(),
    merged_at: z.string().min(1).nullable(),
    remote_action: remoteActionRecordSchema.nullable().default(null),
    cleanup_error: z.string().min(1).max(1000).nullable().default(null),
    cleaned_at: z.string().min(1).nullable().default(null),
    revision: z.number().int().positive(),
  })
  .superRefine((integration, context) => {
    if (
      integration.strategy === "local_merge" &&
      integration.remote_action !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "local integration cannot retain a remote action",
      });
    }
    const remoteStatus = integration.remote_action?.status ?? null;
    if (
      (integration.state === "awaiting_remote" &&
        remoteStatus !== "pending" &&
        remoteStatus !== "cancelled") ||
      (integration.state === "remote_executing" &&
        remoteStatus !== "approved" &&
        remoteStatus !== "executing") ||
      (integration.state === "remote_completed" &&
        remoteStatus !== "completed")
    ) {
      context.addIssue({
        code: "custom",
        message: "remote integration state does not match its action record",
      });
    }
    if (
      integration.cleaned_at !== null &&
      integration.state !== "cleaned"
    ) {
      context.addIssue({
        code: "custom",
        message: "only a cleaned integration may have cleaned_at",
      });
    }
    if (integration.state === "cleaned" && integration.cleaned_at === null) {
      context.addIssue({
        code: "custom",
        message: "cleaned integration requires cleaned_at",
      });
    }
    if (
      integration.strategy === "pull_request" &&
      (integration.state === "cleaning" || integration.state === "cleaned") &&
      remoteStatus !== "completed"
    ) {
      context.addIssue({
        code: "custom",
        message: "pull-request cleanup requires a completed remote action",
      });
    }
  });

export type IntegrationRecord = z.infer<typeof integrationRecordSchema>;

export const pmSessionRecordSchema = z.object({
  session_id: z.string().min(1),
  agent_name: z.literal("ark_pm"),
  model: z.literal("gpt-5.6-sol"),
  model_reasoning_effort: z.literal("xhigh"),
  sandbox_mode: z.literal("read-only"),
  approval_policy: z.literal("never"),
  usage: usageSchema,
  planned_at: z.string().min(1),
  turn_count: z.number().int().positive().default(1),
  final_report: pmReportSchema.nullable().default(null),
  final_usage: usageSchema.nullable().default(null),
  completed_at: z.string().min(1).nullable().default(null),
});

export type PmSessionRecord = z.infer<typeof pmSessionRecordSchema>;

function aggregatePersistedVerificationOutcomes(
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

type VerificationRecordV2 = Extract<
  VerificationLinkedRecord,
  { schema_version: 2 }
>;
type VerificationRecordPayloadV2 = VerificationRecordV2["payload"];
type VerificationRecordPayloadKind = VerificationRecordPayloadV2["kind"];
type VerificationRunSnapshotV2 = Extract<
  z.infer<typeof verificationRunSnapshotSchema>,
  { schema_version: 2 }
>;

function isVerificationRecordV2Kind<
  Kind extends VerificationRecordPayloadKind,
>(
  record: VerificationLinkedRecord,
  kind: Kind,
): record is VerificationRecordV2 & {
  payload: Extract<VerificationRecordPayloadV2, { kind: Kind }>;
} {
  return record.schema_version === 2 && record.payload.kind === kind;
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

function isOptionalSemanticEvidence(
  snapshot: VerificationRunSnapshotV2,
  record: VerificationRecordV2,
  attempts: readonly {
    readonly action_id: string;
    readonly kind: VerificationActionKind;
  }[],
): boolean {
  if (
    record.lane !== "ui" ||
    !snapshot.ui_contract.enabled ||
    snapshot.ui_contract.semantic_review_required
  ) {
    return false;
  }
  if (record.payload.kind === "review") {
    return true;
  }
  const actionId =
    record.payload.kind === "error"
      ? record.payload.action_id
      : undefined;
  return (
    actionId !== undefined &&
    attempts.some(
      (attempt) =>
        attempt.action_id === actionId &&
        attempt.kind === "semantic_review",
    )
  );
}

function verificationRecordMatchesAttempt(
  kind: VerificationActionKind,
  lane: "backend" | "ui" | null,
  checkId: string | null,
  record: VerificationRecordV2,
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

function coordinatorErrorRecordMatchesSnapshot(
  snapshot: VerificationRunSnapshotV2,
  record: VerificationRecordV2 & {
    payload: Extract<VerificationRecordPayloadV2, { kind: "error" }>;
  },
): boolean {
  if (record.payload.capability !== undefined) {
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
  if (record.lane === null) {
    return (
      record.lane_required === null &&
      record.check_id === null &&
      !record.check_required
    );
  }
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
  if (record.check_id === null) {
    return !record.check_required;
  }
  const required = expectedVerificationCheckRequired(
    snapshot,
    record.lane,
    record.check_id,
  );
  return required !== null && record.check_required === required;
}

export const runRecordSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().regex(RUN_ID_PATTERN),
    objective: z.string().min(1),
    project_path: z.string().min(1),
    state: runStateSchema,
    resume_state: runStateSchema.nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    revision: z.number().int().positive(),
    event_count: z.number().int().nonnegative(),
    assignment_count: z.number().int().nonnegative().default(0),
    team_count: z.number().int().min(0).max(4).default(0),
    project_config: projectConfigSchema.default(DEFAULT_PROJECT_CONFIG),
    project_config_source: z.string().min(1).nullable().default(null),
    project_config_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    verification_snapshot: verificationRunSnapshotSchema.nullable().default(null),
    verification_snapshot_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    verification_records: z
      .array(verificationLinkedRecordSchema)
      .max(10_000)
      .default([]),
    verification_state: verificationCoordinatorStateSchema
      .nullable()
      .default(null),
    model_bindings: z
      .object({
        worker: resolvedModelBindingV1Schema,
      })
      .strict()
      .default({
        worker: NATIVE_WORKER_MODEL_BINDING,
      }),
    verification_cleanup_audit: verificationCleanupAuditSchema
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.project_config_sha256 !== null &&
      run.project_config_sha256 !== projectConfigSha256(run.project_config)
    ) {
      context.addIssue({
        code: "custom",
        path: ["project_config_sha256"],
        message: "project configuration hash does not match the persisted snapshot",
      });
    }
    if (
      (run.verification_snapshot === null) !==
      (run.verification_snapshot_sha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification_snapshot"],
        message: "verification snapshot and hash must be present together",
      });
    }
    if (run.verification_snapshot !== null) {
      if (run.project_config_sha256 === null) {
        context.addIssue({
          code: "custom",
          path: ["project_config_sha256"],
          message: "verification snapshot requires a project configuration hash",
        });
      }
      if (run.verification_snapshot.run_id !== run.run_id) {
        context.addIssue({
          code: "custom",
          path: ["verification_snapshot", "run_id"],
          message: "verification snapshot belongs to another run",
        });
      }
      const expectedBaselineRoot =
        run.verification_snapshot.schema_version === 1
          ? path.resolve(
              run.project_path,
              run.verification_snapshot.resolved_config.baseline_root,
            )
          : run.verification_snapshot.resolved_config.ui.enabled
            ? path.resolve(
                run.project_path,
                run.verification_snapshot.resolved_config.ui.baseline_root,
              )
            : null;
      if (run.verification_snapshot.baseline_root !== expectedBaselineRoot) {
        context.addIssue({
          code: "custom",
          path: ["verification_snapshot", "baseline_root"],
          message: "verification baseline root does not match the run project",
        });
      }
      if (
        run.verification_snapshot_sha256 !==
        verificationRunSnapshotSha256(run.verification_snapshot)
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification_snapshot_sha256"],
          message: "verification snapshot hash does not match the persisted snapshot",
        });
      }
      const coordinator = run.project_config.verification.coordinator;
      if (coordinator === null) {
        context.addIssue({
          code: "custom",
          path: ["verification_snapshot"],
          message: "verification snapshot requires coordinator configuration",
        });
      } else if (
        !verificationResolvedConfigMatchesProjectConfig(
          coordinator,
          run.verification_snapshot.resolved_config,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification_snapshot", "resolved_config"],
          message: "verification snapshot configuration does not match the run",
        });
      }
      const snapshot = run.verification_snapshot;
      const reports = run.verification_records.filter(
        (record) => record.payload.kind === "report",
      );
      const usesCoordinatorStateContract = run.verification_state !== null;
      if (usesCoordinatorStateContract && reports.length > 1) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message: "verification runs allow at most one terminal report",
        });
      }
      if (run.verification_state !== null) {
        const terminalOutcome = run.verification_state.terminal_outcome;
        if (terminalOutcome === null) {
          if (reports.length !== 0) {
            context.addIssue({
              code: "custom",
              path: ["verification_records"],
              message: "a terminal report requires terminal coordinator state",
            });
          }
        } else if (
          reports.length !== 1 ||
          reports[0]?.payload.kind !== "report" ||
          reports[0].payload.outcome !== terminalOutcome
        ) {
          context.addIssue({
            code: "custom",
            path: ["verification_records"],
            message:
              "terminal coordinator state requires exactly one matching report",
          });
        }
      }
      if (
        usesCoordinatorStateContract &&
        snapshot.schema_version === 2 &&
        reports.length === 1 &&
        reports[0] !== undefined &&
        isVerificationRecordV2Kind(reports[0], "report")
      ) {
        const report = reports[0];
        const reportPayload = report.payload;
        const laneSummaries = run.verification_records.filter(
          (record) => isVerificationRecordV2Kind(record, "lane_summary"),
        );
        const approvalTerminalError =
          reportPayload.outcome === "error" &&
          reportPayload.evidence_record_ids.length === 1
            ? run.verification_records.find(
                (record) =>
                  isVerificationRecordV2Kind(record, "error") &&
                  record.record_id ===
                    reportPayload.evidence_record_ids[0] &&
                  record.payload.code === "APPROVAL_REQUIRED" &&
                  record.payload.approval_id !== undefined,
              )
            : undefined;
        if (approvalTerminalError !== undefined) {
          if (laneSummaries.length !== 0) {
            context.addIssue({
              code: "custom",
              path: ["verification_records"],
              message:
                "approval-terminal verification cannot contain lane summaries",
            });
          }
        } else {
        const enabledLanes: Array<"backend" | "ui"> = [];
        if (snapshot.backend_contract.enabled) {
          enabledLanes.push("backend");
        }
        if (snapshot.ui_contract.enabled) {
          enabledLanes.push("ui");
        }
        for (const lane of ["backend", "ui"] as const) {
          const expectedCount = enabledLanes.includes(lane) ? 1 : 0;
          const actualCount = laneSummaries.filter(
            (record) => record.payload.lane === lane,
          ).length;
          if (actualCount !== expectedCount) {
            context.addIssue({
              code: "custom",
              path: ["verification_records"],
              message: `verification report requires ${expectedCount} ${lane} lane summaries`,
            });
          }
        }
        const summaryRecordIds = laneSummaries.map(
          (record) => record.record_id,
        );
        const reportEvidenceIds = reportPayload.evidence_record_ids;
        if (
          reportEvidenceIds.length !== summaryRecordIds.length ||
          new Set(reportEvidenceIds).size !== reportEvidenceIds.length ||
          summaryRecordIds.some(
            (recordId) => !reportEvidenceIds.includes(recordId),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "verification_records",
              run.verification_records.indexOf(report),
              "payload",
              "evidence_record_ids",
            ],
            message:
              "terminal report evidence must contain exactly the enabled lane summaries",
          });
        }
        let integrityFailure = run.verification_records.some(
          (record) =>
            isVerificationRecordV2Kind(record, "error") &&
            record.payload.integrity_failure === true,
        );
        const requiredLaneOutcomes: VerificationOutcome[] = [];
        for (const summary of laneSummaries) {
          const checks = summary.payload.checks;
          if (checks === undefined) {
            context.addIssue({
              code: "custom",
              path: [
                "verification_records",
                run.verification_records.indexOf(summary),
                "payload",
                "checks",
              ],
              message:
                "coordinator lane summaries require complete check decisions",
            });
            continue;
          }
          const laneRequired =
            summary.payload.lane === "backend"
              ? snapshot.backend_contract.enabled &&
                snapshot.backend_contract.required
              : snapshot.ui_contract.enabled &&
                snapshot.ui_contract.required;
          const expectedChecks =
            summary.payload.lane === "backend" &&
            snapshot.backend_contract.enabled
              ? snapshot.backend_contract.api_probes.map((probe) => ({
                  id: probe.id,
                  required: probe.required,
                }))
              : summary.payload.lane === "ui" &&
                  snapshot.ui_contract.enabled
                ? [
                    ...snapshot.ui_contract.browser_cases.map(
                      (browserCase) => ({
                        id: browserCase.id,
                        required: browserCase.required,
                      }),
                    ),
                    ...snapshot.ui_contract.agentic_tasks.map((task) => ({
                      id: task.id,
                      required: task.required,
                    })),
                  ]
                : [];
          if (
            expectedChecks.length !== checks.length ||
            expectedChecks.some(
              (expected) =>
                !checks.some(
                  (check) =>
                    check.check_id === expected.id &&
                    check.required === expected.required,
                ),
            )
          ) {
            context.addIssue({
              code: "custom",
              path: ["verification_records"],
              message:
                "lane summary checks do not match the snapshotted lane contract",
            });
          }
          const laneIntegrityFailure = checks.some(
            (check) => check.integrity_failure,
          );
          integrityFailure ||= laneIntegrityFailure;
          const expectedOutcome = laneIntegrityFailure
            ? "error"
            : aggregatePersistedVerificationOutcomes(
                checks.flatMap((check) =>
                  check.required ? [check.outcome] : [],
                ),
              );
          if (summary.payload.outcome !== expectedOutcome) {
            context.addIssue({
              code: "custom",
              path: ["verification_records"],
              message:
                "lane summary outcome does not match its required checks",
            });
          }
          if (laneRequired) {
            requiredLaneOutcomes.push(summary.payload.outcome);
          }
        }
        const expectedReportOutcome = integrityFailure
          ? "error"
          : aggregatePersistedVerificationOutcomes(
              requiredLaneOutcomes,
            );
        if (reportPayload.outcome !== expectedReportOutcome) {
          context.addIssue({
            code: "custom",
            path: ["verification_records"],
            message:
              "terminal report outcome does not match required lane summaries",
          });
        }
        }
      }
      if (
        run.verification_records.length < 3 ||
        run.verification_records[0]?.record_type !== "source" ||
        run.verification_records[1]?.record_type !== "config" ||
        run.verification_records[2]?.record_type !== "snapshot"
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message: "verification snapshot requires source, config, and snapshot records",
        });
      }
      if (
        run.verification_records[0]?.payload.kind !== "source" ||
        run.verification_records[0].payload.source_sha256 !==
          snapshot.source_fingerprint ||
        run.verification_records[1]?.payload.kind !== "config" ||
        run.verification_records[1].payload.config_sha256 !==
          snapshot.resolved_config_sha256 ||
        run.verification_records[2]?.payload.kind !== "snapshot" ||
        run.verification_records[2].payload.snapshot_sha256 !==
          run.verification_snapshot_sha256
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message: "initial verification records do not link to persisted snapshot data",
        });
      }
      const recordIds = new Set(
        run.verification_records.map((record) => record.record_id),
      );
      const recordById = new Map(
        run.verification_records.map((record) => [
          record.record_id,
          record,
        ]),
      );
      const supersededEvidenceRecordIds = new Set(
        run.verification_state?.attempts.flatMap((attempt) =>
          attempt.evidence_record_ids.filter(
            (recordId) =>
              !attempt.decisive_evidence_record_ids.includes(recordId),
          ),
        ) ?? [],
      );
      if (recordIds.size !== run.verification_records.length) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message: "verification record IDs must be unique",
        });
      }
      const artifactRecords = run.verification_records.filter(
        (record) => record.payload.kind === "artifact",
      );
      const artifactIds = artifactRecords
        .map((record) =>
          record.payload.kind === "artifact"
            ? record.payload.artifact_id
            : "",
        );
      if (new Set(artifactIds).size !== artifactIds.length) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message: "verification artifact IDs must be unique",
        });
      }
      const artifactPaths = artifactRecords.flatMap((record) =>
        record.payload.kind === "artifact"
          ? [record.payload.relative_path]
          : [],
      );
      if (new Set(artifactPaths).size !== artifactPaths.length) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message: "verification artifact paths must be unique",
        });
      }
      const artifacts = new Map(
        artifactRecords.map((record) => [
            record.payload.kind === "artifact"
              ? record.payload.artifact_id
              : "",
            record.payload,
          ]),
      );
      let previousRecordHash: string | null = null;
      run.verification_records.forEach((record, index) => {
        if (usesCoordinatorStateContract) {
          if (record.schema_version !== 2) {
            context.addIssue({
              code: "custom",
              path: ["verification_records", index, "schema_version"],
              message: "coordinator state requires schema-2 verification records",
            });
          } else if (
            record.payload.kind === "lane_summary" &&
            record.payload.checks === undefined
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "verification_records",
                index,
                "payload",
                "checks",
              ],
              message:
                "coordinator lane summaries require complete check decisions",
            });
          } else if (record.payload.kind === "error") {
            const payload = record.payload;
            if (
              payload.attempt_count === undefined ||
              payload.evidence_record_ids === undefined ||
              payload.outcome === undefined ||
              payload.integrity_failure === undefined
            ) {
              context.addIssue({
                code: "custom",
                path: ["verification_records", index, "payload"],
                message:
                  "coordinator errors require attempt, evidence, outcome, and integrity disposition",
              });
            } else {
              const expectedDisposition =
                verificationEvidenceDisposition(record);
              if (
                expectedDisposition === null ||
                payload.outcome !== expectedDisposition.outcome ||
                payload.integrity_failure !==
                  expectedDisposition.integrity_failure
              ) {
                context.addIssue({
                  code: "custom",
                  path: ["verification_records", index, "payload"],
                  message:
                    "verification error disposition does not match its closed error code",
                });
              }
              if (payload.action_id !== undefined) {
                const attempt = run.verification_state?.attempts.find(
                  (candidate) =>
                    candidate.action_id === payload.action_id,
                );
                if (
                  attempt === undefined ||
                  attempt.lane !== record.lane ||
                  attempt.check_id !== record.check_id ||
                  attempt.attempt_count !== payload.attempt_count ||
                  attempt.last_error_code !== payload.code ||
                  attempt.evidence_record_ids.length !==
                    payload.evidence_record_ids.length ||
                  attempt.evidence_record_ids.some(
                    (recordId) =>
                      !payload.evidence_record_ids?.includes(recordId),
                  )
                ) {
                  context.addIssue({
                    code: "custom",
                    path: ["verification_records", index, "payload"],
                    message:
                      "verification action error does not match its durable attempt",
                  });
                }
              } else if (record.check_id !== null) {
                context.addIssue({
                  code: "custom",
                  path: ["verification_records", index, "payload", "action_id"],
                  message:
                    "check-scoped verification errors require an action ID",
                });
              }
            }
          }
        }
        if (
          record.schema_version !== snapshot.schema_version ||
          record.run_id !== run.run_id ||
          record.case_id !== snapshot.case_id ||
          record.snapshot_id !== snapshot.snapshot_id ||
          record.source_fingerprint !== snapshot.source_fingerprint ||
          record.package_fingerprint !== snapshot.package.package_fingerprint
        ) {
          context.addIssue({
            code: "custom",
            path: ["verification_records", index],
            message: "verification record linkage does not match the run snapshot",
          });
        }
        const recordMatchesSnapshot =
          usesCoordinatorStateContract &&
          snapshot.schema_version === 2 &&
          isVerificationRecordV2Kind(record, "error")
            ? coordinatorErrorRecordMatchesSnapshot(snapshot, record)
            : verificationRecordMatchesSnapshot(snapshot, record);
        if (!recordMatchesSnapshot) {
          context.addIssue({
            code: "custom",
            path: ["verification_records", index],
            message:
              "verification record check provenance does not match the run snapshot",
          });
        }
        if (record.previous_record_sha256 !== previousRecordHash) {
          context.addIssue({
            code: "custom",
            path: ["verification_records", index, "previous_record_sha256"],
            message: "verification record hash chain is not append-only",
          });
        }
        previousRecordHash = sha256CanonicalJson(record);
        for (const reference of record.artifact_references) {
          const artifact = artifacts.get(reference.artifact_id);
          if (
            artifact?.kind !== "artifact" ||
            artifact.relative_path !== reference.relative_path ||
            artifact.sha256 !== reference.sha256
          ) {
            context.addIssue({
              code: "custom",
              path: ["verification_records", index, "artifact_references"],
              message: "verification artifact reference is broken",
            });
          }
        }
        let payloadEvidenceRecordIds: readonly string[] = [];
        if (record.payload.kind === "report") {
          payloadEvidenceRecordIds = record.payload.evidence_record_ids;
        } else if (isVerificationRecordV2Kind(record, "lane_summary")) {
          payloadEvidenceRecordIds = record.payload.evidence_record_ids;
        } else if (isVerificationRecordV2Kind(record, "error")) {
          payloadEvidenceRecordIds =
            record.payload.evidence_record_ids ?? [];
        }
        if (
          payloadEvidenceRecordIds.some(
            (recordId) =>
              recordId === record.record_id || !recordIds.has(recordId),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "verification_records",
              index,
              "payload",
              "evidence_record_ids",
            ],
            message: "verification report contains a broken evidence link",
          });
        }
        if (isVerificationRecordV2Kind(record, "lane_summary")) {
          const checks = record.payload.checks;
          if (checks === undefined) {
            return;
          }
          const checkEvidenceIds = [
            ...new Set(
              checks.flatMap((check) => check.evidence_record_ids),
            ),
          ];
          if (
            checkEvidenceIds.length !==
              record.payload.evidence_record_ids.length ||
            checkEvidenceIds.some(
              (recordId) =>
                !record.payload.evidence_record_ids.includes(recordId),
            )
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "verification_records",
                index,
                "payload",
                "checks",
              ],
              message:
                "lane summary checks must link exactly the summary evidence",
            });
          }
          for (const check of checks) {
            const evidence = check.evidence_record_ids.map((recordId) =>
              recordById.get(recordId),
            );
            const allEvidenceRecordIds = run.verification_records
              .filter(
                (candidate) =>
                  candidate.schema_version === 2 &&
                  candidate.lane === record.payload.lane &&
                  candidate.check_id === check.check_id &&
                  !supersededEvidenceRecordIds.has(candidate.record_id) &&
                  verificationEvidenceDisposition(candidate) !== null,
              )
              .map((candidate) => candidate.record_id);
            const evidenceDispositions = evidence.flatMap((candidate) => {
              if (
                candidate === undefined ||
                candidate.schema_version !== 2
              ) {
                return [];
              }
              const disposition = verificationEvidenceDisposition(candidate);
              return disposition === null
                ? []
                : [{ candidate, disposition }];
            });
            const authoritativeDispositions =
              evidenceDispositions.filter(
                ({ candidate, disposition }) =>
                  disposition.integrity_failure ||
                  snapshot.schema_version !== 2 ||
                  !isOptionalSemanticEvidence(
                    snapshot,
                    candidate,
                    run.verification_state?.attempts ?? [],
                  ),
              );
            const expectedIntegrityFailure =
              authoritativeDispositions.some(
                ({ disposition }) => disposition.integrity_failure,
              );
            const expectedCheckOutcome = expectedIntegrityFailure
              ? "error"
              : aggregatePersistedVerificationOutcomes(
                  authoritativeDispositions.map(
                    ({ disposition }) => disposition.outcome,
                  ),
                );
            if (
              authoritativeDispositions.length === 0 ||
              evidence.some(
                (candidate) =>
                  candidate === undefined ||
                  candidate.schema_version !== 2 ||
                  candidate.lane !== record.payload.lane ||
                  candidate.check_id !== check.check_id ||
                  candidate.check_required !== check.required ||
                  verificationEvidenceDisposition(candidate) === null,
              ) ||
              evidenceDispositions.length !== evidence.length ||
              allEvidenceRecordIds.length !==
                check.evidence_record_ids.length ||
              allEvidenceRecordIds.some(
                (recordId) =>
                  !check.evidence_record_ids.includes(recordId),
              ) ||
              check.integrity_failure !== expectedIntegrityFailure ||
              check.outcome !== expectedCheckOutcome
            ) {
              context.addIssue({
                code: "custom",
                path: [
                  "verification_records",
                  index,
                  "payload",
                  "checks",
                ],
                message:
                  "lane summary check evidence has invalid provenance",
              });
            }
          }
        }
      });
      if (run.verification_state !== null) {
        const attempts = run.verification_state.attempts;
        const attemptScopes = attempts.map((attempt) =>
          [
            attempt.kind,
            attempt.lane ?? "",
            attempt.check_id ?? "",
            attempt.kind === "artifact_write"
              ? attempt.input_sha256
              : "",
          ].join("\0"),
        );
        if (new Set(attemptScopes).size !== attemptScopes.length) {
          context.addIssue({
            code: "custom",
            path: ["verification_state", "attempts"],
            message:
              "verification attempts must have unique immutable action scopes",
          });
        }
        attempts.forEach((attempt, attemptIndex) => {
          const evidence = attempt.evidence_record_ids.map((recordId) =>
            recordById.get(recordId),
          );
          const decisiveEvidence =
            attempt.decisive_evidence_record_ids.map((recordId) =>
              recordById.get(recordId),
            );
          if (
            evidence.some(
              (record) =>
                record === undefined ||
                record.schema_version !== 2 ||
                !verificationRecordMatchesAttempt(
                  attempt.kind,
                  attempt.lane,
                  attempt.check_id,
                  record,
                ),
            )
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "verification_state",
                "attempts",
                attemptIndex,
                "evidence_record_ids",
              ],
              message:
                "verification attempt contains broken or mismatched evidence links",
            });
          }
          if (
            decisiveEvidence.some(
              (record) =>
                record === undefined ||
                record.schema_version !== 2 ||
                !verificationRecordMatchesAttempt(
                  attempt.kind,
                  attempt.lane,
                  attempt.check_id,
                  record,
                ),
            )
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "verification_state",
                "attempts",
                attemptIndex,
                "decisive_evidence_record_ids",
              ],
              message:
                "verification attempt contains broken or mismatched decisive evidence links",
            });
          }
          if (
            (attempt.status === "in_progress" &&
              attempt.decisive_evidence_record_ids.length !== 0) ||
            (attempt.status === "failed" &&
              attempt.attempt_count >= attempt.max_attempts) ||
            (run.verification_state?.terminal_outcome !== null &&
              attempt.status === "in_progress")
          ) {
            context.addIssue({
              code: "custom",
              path: [
                "verification_state",
                "attempts",
                attemptIndex,
                "status",
              ],
              message:
                "verification attempt status does not match its count, evidence, or run state",
            });
          }
          const actionErrorCount = run.verification_records.filter(
            (record) =>
              isVerificationRecordV2Kind(record, "error") &&
              record.payload.action_id === attempt.action_id,
          ).length;
          const requiresActionError =
            attempt.status === "aborted" ||
            attempt.status === "exhausted";
          if (actionErrorCount !== (requiresActionError ? 1 : 0)) {
            context.addIssue({
              code: "custom",
              path: [
                "verification_state",
                "attempts",
                attemptIndex,
                "status",
              ],
              message:
                "terminal failed attempts require exactly one linked action error",
            });
          }
        });

        run.verification_records.forEach((record, recordIndex) => {
          if (
            !isVerificationRecordV2Kind(record, "error") ||
            record.check_id === null ||
            record.payload.attempt_count === undefined ||
            record.payload.evidence_record_ids === undefined
          ) {
            return;
          }
          const errorEvidenceIds = record.payload.evidence_record_ids;
          const errorAttemptCount = record.payload.attempt_count;
          const matchingAttempt = attempts.find(
            (attempt) =>
              attempt.lane === record.lane &&
              attempt.check_id === record.check_id &&
              attempt.attempt_count >= errorAttemptCount &&
              errorEvidenceIds.every((recordId) =>
                attempt.evidence_record_ids.includes(recordId),
              ),
          );
          if (matchingAttempt === undefined) {
            context.addIssue({
              code: "custom",
              path: ["verification_records", recordIndex],
              message:
                "check-scoped verification error does not match its durable attempt",
            });
          }
        });
      }
      const cleanupRecords = run.verification_records.filter(
        (record) => record.payload.kind === "cleanup",
      );
      const retentionRecords = cleanupRecords.filter(
        (record) =>
          record.payload.kind === "cleanup" &&
          record.payload.disposition === "retention_active",
      );
      const terminalCleanupRecords = cleanupRecords.filter(
        (record) =>
          record.payload.kind === "cleanup" &&
          record.payload.disposition !== "retention_active",
      );
      if (
        retentionRecords.length > 1 ||
        terminalCleanupRecords.length > 1 ||
        (retentionRecords.length === 1 &&
          terminalCleanupRecords.length === 1 &&
          run.verification_records.indexOf(retentionRecords[0]!) >
            run.verification_records.indexOf(terminalCleanupRecords[0]!))
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message:
            "verification cleanup allows at most one retention record before one terminal disposition",
        });
      }
      const expectedCleanupArtifactReferences = artifactRecords.flatMap(
        (record) =>
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
      cleanupRecords.forEach((record) => {
        if (
          sha256CanonicalJson(record.artifact_references) !==
          sha256CanonicalJson(expectedCleanupArtifactReferences)
        ) {
          context.addIssue({
            code: "custom",
            path: ["verification_records"],
            message:
              "verification cleanup must reference the exact artifact manifest",
          });
        }
      });

      const cleanupAudit = run.verification_cleanup_audit;
      if (cleanupAudit === null) {
        if (terminalCleanupRecords.length !== 0) {
          context.addIssue({
            code: "custom",
            path: ["verification_cleanup_audit"],
            message: "terminal cleanup requires a durable pre-cleanup audit",
          });
        }
      } else {
        const terminalReport = run.verification_records.find(
          (record) =>
            record.record_id === cleanupAudit.terminal_report_record_id &&
            record.payload.kind === "report",
        );
        const artifactManifest = artifactRecords.map((record) => record.payload);
        const artifactRecordIds = artifactRecords.map(
          (record) => record.record_id,
        );
        const artifactTotalBytes = artifactManifest.reduce(
          (total, payload) =>
            payload.kind === "artifact"
              ? total + payload.byte_length
              : total,
          0,
        );
        if (
          snapshot.schema_version !== 2 ||
          cleanupAudit.run_id !== run.run_id ||
          cleanupAudit.snapshot_id !== snapshot.snapshot_id ||
          cleanupAudit.artifact_root !== snapshot.artifact_root ||
          terminalReport === undefined ||
          terminalReport.payload.kind !== "report" ||
          cleanupAudit.terminal_report_at !== terminalReport.timestamp_utc ||
          cleanupAudit.terminal_outcome !== terminalReport.payload.outcome ||
          cleanupAudit.terminal_report_sha256 !==
            sha256CanonicalJson(terminalReport) ||
          cleanupAudit.artifact_manifest_sha256 !==
            sha256CanonicalJson(artifactManifest) ||
          cleanupAudit.artifact_count !== artifactRecords.length ||
          cleanupAudit.total_bytes !== artifactTotalBytes ||
          cleanupAudit.artifact_record_ids.join("\0") !==
            artifactRecordIds.join("\0") ||
          (snapshot.ui_contract.enabled
            ? cleanupAudit.baseline_manifest_sha256 === null
            : cleanupAudit.baseline_manifest_sha256 !== null)
        ) {
          context.addIssue({
            code: "custom",
            path: ["verification_cleanup_audit"],
            message:
              "verification cleanup audit does not match durable report and artifact records",
          });
        }
        const terminalCleanup = terminalCleanupRecords[0];
        if (
          (cleanupAudit.status === "pending" &&
            terminalCleanup !== undefined) ||
          (cleanupAudit.status !== "pending" &&
            (terminalCleanup === undefined ||
              terminalCleanup.payload.kind !== "cleanup" ||
              terminalCleanup.payload.disposition !== cleanupAudit.status))
        ) {
          context.addIssue({
            code: "custom",
            path: ["verification_cleanup_audit", "status"],
            message:
              "verification cleanup audit status does not match its terminal disposition",
          });
        }
      }
    } else {
      if (
        run.verification_records.length !== 0 ||
        run.verification_cleanup_audit !== null
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification_records"],
          message: "verification records and cleanup audit require a run snapshot",
        });
      }
      if (
        run.verification_state !== null &&
        ((run.verification_state.current_state !== "integrated" &&
          run.verification_state.current_state !== "configured") ||
          run.verification_state.terminal_outcome !== null ||
          run.verification_state.attempts.length !== 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["verification_state"],
          message:
            "coordinator state without a snapshot must be integrated or configured with no terminal outcome or attempts",
        });
      }
    }
  });

export type RunRecord = z.infer<typeof runRecordSchema>;

export const runEventSchema = z
  .object({
    schema_version: z.literal(1),
    sequence: z.number().int().positive(),
    event_id: z.string().min(1),
    event_type: z.enum([
    "run.created",
    "run.paused",
    "run.resumed",
    "run.cancelled",
    "run.failed",
    "pm.planned",
    "plan.materialized",
    "team.prepared",
    "team.completed",
    "team.cleaned",
    "integration.prepared",
    "integration.verified",
    "integration.local_merged",
    "integration.awaiting_remote",
    "integration.remote_approved",
    "integration.remote_cancelled",
    "integration.remote_attempt",
    "integration.remote_failed",
    "integration.remote_completed",
    "integration.cleanup_started",
    "integration.cleanup_failed",
    "integration.cleaned",
    "pm.completed",
    "run.completed",
    "assignment.started",
    "assignment.resumed",
    "assignment.waiting_user",
    "assignment.approval_resolved",
    "assignment.recovering",
    "assignment.retrying",
    "assignment.correction",
    "assignment.retry_exhausted",
    "assignment.retry_resolved",
    "assignment.completed",
    "assignment.report_routed",
    "assignment.failed",
    "assignment.paused",
    "assignment.cancelled",
    "assignment.provider_selected",
    "assignment.provider_bridge_started",
    ]),
    timestamp: z.string().min(1),
    state: runStateSchema,
    message: z.string().min(1).optional(),
    assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN).optional(),
    team_id: z.string().regex(TEAM_ID_PATTERN).optional(),
    agent_role: eventAgentRoleSchema.optional(),
    approval_id: z.string().uuid().optional(),
    retry_request_id: z.string().uuid().optional(),
    retry_kind: retryRequestKindSchema.optional(),
    retry_decision: z.enum(["retry_once", "cancel_run"]).optional(),
    remote_request_id: z.string().uuid().optional(),
    remote_decision: z.enum(["approve_once", "cancel_run"]).optional(),
    recovery_decision: z.enum(["resume_safely", "cancel_run"]).optional(),
    session_attempt_count: z.number().int().positive().optional(),
    correction_count: z.number().int().nonnegative().optional(),
    report_target: reportTargetSchema.optional(),
    approval_decision: z
      .enum(["approve_once", "approve_session", "decline", "cancel"])
      .optional(),
    approval_source: z.enum(["user", "routine_policy"]).optional(),
    usage: usageSchema.optional(),
    provider_id: z.string().min(1).max(80).optional(),
    app_server_provider_id: z.string().min(1).max(80).optional(),
    adapter_id: z.string().min(1).max(80).optional(),
    adapter_api_version: z.literal(1).optional(),
    adapter_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    provider_config_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    model: z.string().min(1).max(256).optional(),
    requested_reasoning_effort: z.string().min(1).max(64).optional(),
    effective_reasoning_effort: z.string().min(1).max(64).optional(),
    structured_output_mode: z
      .enum(["native_json_schema", "validated_json"])
      .optional(),
    bridge_port: z.number().int().min(10001).max(65535).optional(),
    provider_error_code: z.string().min(1).max(80).optional(),
  })
  .strict();

export type RunEvent = z.infer<typeof runEventSchema>;

export const persistedRunSchema = z
  .object({
    run: runRecordSchema,
    events: z.array(runEventSchema),
    assignments: z.array(assignmentRecordSchema).default([]),
    teams: z.array(teamRecordSchema).default([]),
    plan: pmPlanSchema.nullable().default(null),
    pm_session: pmSessionRecordSchema.nullable().default(null),
    integration: integrationRecordSchema.nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.run.event_count !== value.events.length) {
      context.addIssue({
        code: "custom",
        message: "run.event_count does not match the number of persisted events",
      });
    }
    if (value.run.assignment_count !== value.assignments.length) {
      context.addIssue({
        code: "custom",
        message: "run.assignment_count does not match persisted assignments",
      });
    }
    if (value.run.team_count !== value.teams.length) {
      context.addIssue({
        code: "custom",
        message: "run.team_count does not match persisted teams",
      });
    }

    const assignmentIds = new Set<string>();
    for (const assignment of value.assignments) {
      if (assignment.run_id !== value.run.run_id) {
        context.addIssue({
          code: "custom",
          message: `assignment ${assignment.assignment_id} belongs to another run`,
        });
      }
      if (assignmentIds.has(assignment.assignment_id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate assignment ID: ${assignment.assignment_id}`,
        });
      }
      assignmentIds.add(assignment.assignment_id);
      if (
        assignment.role === "worker" &&
        sha256CanonicalJson(assignment.model_binding) !==
          sha256CanonicalJson(value.run.model_bindings.worker)
      ) {
        context.addIssue({
          code: "custom",
          message: `worker assignment ${assignment.assignment_id} model binding does not match the run snapshot`,
        });
      }
    }

    const teamIds = new Set<string>();
    for (const team of value.teams) {
      if (team.run_id !== value.run.run_id) {
        context.addIssue({
          code: "custom",
          message: `team ${team.team_id} belongs to another run`,
        });
      }
      if (teamIds.has(team.team_id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate team ID: ${team.team_id}`,
        });
      }
      teamIds.add(team.team_id);
    }
    for (const team of value.teams) {
      for (const dependency of team.dependencies) {
        if (dependency === team.team_id || !teamIds.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `team ${team.team_id} has invalid dependency ${dependency}`,
          });
        }
      }
    }
    if (value.plan === null && value.teams.length > 0) {
      context.addIssue({
        code: "custom",
        message: "persisted teams require a PM plan",
      });
    }
    if (value.pm_session !== null && value.plan === null) {
      context.addIssue({
        code: "custom",
        message: "persisted PM session requires its structured plan",
      });
    }
    if (
      value.integration !== null &&
      value.integration.run_id !== value.run.run_id
    ) {
      context.addIssue({
        code: "custom",
        message: "integration record belongs to another run",
      });
    }
    if (value.plan !== null && value.teams.length > 0) {
      const plannedTeamIds = value.plan.teams.map((team) => team.team_id);
      if (
        plannedTeamIds.length !== value.teams.length ||
        plannedTeamIds.some(
          (teamId, index) => value.teams[index]?.team_id !== teamId,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "persisted teams do not match the PM plan",
        });
      }
    }
    if (
      value.plan !== null &&
      value.teams.length === 0 &&
      value.run.state !== "planning"
    ) {
      context.addIssue({
        code: "custom",
        message: "an unapplied PM plan requires a planning run",
      });
    }

    value.events.forEach((event, index) => {
      if (event.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          message: `event sequence is not contiguous at index ${index}`,
        });
      }
    });
  });

export type PersistedRun = z.infer<typeof persistedRunSchema>;

export interface RunListResult {
  runs: RunRecord[];
  total: number;
}

export interface RunLogsResult {
  run_id: string;
  events: RunEvent[];
  next_after_sequence: number;
  has_more: boolean;
}

export interface TransitionResult {
  run: RunRecord;
  changed: boolean;
}

export interface AssignmentListResult {
  run_id: string;
  assignments: AssignmentRecord[];
  total: number;
}

export interface TeamListResult {
  run_id: string;
  teams: TeamRecord[];
  total: number;
}
