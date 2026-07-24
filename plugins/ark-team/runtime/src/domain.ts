import { z } from "zod/v4";

export const RUN_ID_PATTERN = /^ark-\d{8}t\d{6}z-[a-z0-9]{6}$/;

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
});

export type RunRecord = z.infer<typeof runRecordSchema>;

export const runEventSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().positive(),
  event_id: z.string().min(1),
  event_type: z.enum(["run.created", "run.paused", "run.resumed", "run.cancelled"]),
  timestamp: z.string().min(1),
  state: runStateSchema,
  message: z.string().min(1).optional(),
});

export type RunEvent = z.infer<typeof runEventSchema>;

export const persistedRunSchema = z
  .object({
    run: runRecordSchema,
    events: z.array(runEventSchema),
  })
  .superRefine((value, context) => {
    if (value.run.event_count !== value.events.length) {
      context.addIssue({
        code: "custom",
        message: "run.event_count does not match the number of persisted events",
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
