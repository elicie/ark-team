import { z } from "zod/v4";

export const RUN_ID_PATTERN = /^ark-\d{8}t\d{6}z-[a-z0-9]{6}$/;
export const ASSIGNMENT_ID_PATTERN = /^asg-[a-f0-9]{12}$/;
export const TEAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const runStateSchema = z.enum([
  "planning",
  "staffing",
  "executing",
  "integrating",
  "verifying",
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

export const assignmentRoleSchema = z.enum(["pl", "worker"]);
export type AssignmentRole = z.infer<typeof assignmentRoleSchema>;

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
});

export const reportTargetSchema = z.discriminatedUnion("type", [
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
    working_directory: z.string().min(1),
    state: assignmentStateSchema,
    session_id: z.string().min(1).nullable(),
    turn_id: z.string().min(1).nullable(),
    pending_approval: pendingApprovalSchema.nullable(),
    final_report: z.string().min(1).nullable(),
    usage: usageSchema.nullable(),
    failure_message: z.string().min(1).nullable(),
    report_routed_at: z.string().min(1).nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .superRefine((assignment, context) => {
    if (
      assignment.role === "pl" &&
      (assignment.parent_assignment_id !== null ||
        assignment.report_target.type !== "pm")
    ) {
      context.addIssue({
        code: "custom",
        message: "PL assignments must report directly to PM",
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
      (!assignment.session_id ||
        !assignment.turn_id ||
        assignment.pending_approval === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "waiting assignments require session, turn, and approval data",
      });
    }
    if (
      assignment.state === "completed" &&
      (!assignment.session_id ||
        !assignment.turn_id ||
        !assignment.final_report ||
        assignment.usage === null ||
        !assignment.report_routed_at)
    ) {
      context.addIssue({
        code: "custom",
        message: "completed assignments require report-routing evidence and usage",
      });
    }
    if (
      assignment.state !== "waiting_user" &&
      assignment.pending_approval !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "only waiting assignments may retain a pending approval",
      });
    }
  });

export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;

export const runRecordSchema = z.object({
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
});

export type RunRecord = z.infer<typeof runRecordSchema>;

export const runEventSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().positive(),
  event_id: z.string().min(1),
  event_type: z.enum([
    "run.created",
    "run.paused",
    "run.resumed",
    "run.cancelled",
    "assignment.started",
    "assignment.waiting_user",
    "assignment.approval_resolved",
    "assignment.completed",
    "assignment.report_routed",
    "assignment.failed",
    "assignment.paused",
    "assignment.cancelled",
  ]),
  timestamp: z.string().min(1),
  state: runStateSchema,
  message: z.string().min(1).optional(),
  assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN).optional(),
  team_id: z.string().regex(TEAM_ID_PATTERN).optional(),
  agent_role: assignmentRoleSchema.optional(),
  approval_id: z.string().uuid().optional(),
  report_target: reportTargetSchema.optional(),
  approval_decision: z
    .enum(["approve_once", "approve_session", "decline", "cancel"])
    .optional(),
  usage: usageSchema.optional(),
});

export type RunEvent = z.infer<typeof runEventSchema>;

export const persistedRunSchema = z
  .object({
    run: runRecordSchema,
    events: z.array(runEventSchema),
    assignments: z.array(assignmentRecordSchema).default([]),
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
