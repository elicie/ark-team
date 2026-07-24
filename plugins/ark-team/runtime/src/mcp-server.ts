import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import {
  ASSIGNMENT_ID_PATTERN,
  TEAM_ID_PATTERN,
  assignmentRoleSchema,
  assignmentStateSchema,
  runStateSchema,
} from "./domain.js";
import { ManagedAssignmentScheduler } from "./assignment-scheduler.js";
import { normalizeError } from "./errors.js";
import { RunStore } from "./state-store.js";

const SERVER_INSTRUCTIONS =
  "Use Ark Team tools only after explicit user invocation. Start with ark_team_start and retain the run_id. Managed PL/worker assignments require an existing linked Git worktree. Keep every returned assignment_id. When an assignment returns waiting_user, present its pending approval and call ark_team_assignment_decide only after the user's decision. Use assignment status/list for stored reports and usage. Run pause/cancel stops active managed assignments.";

export function createArkTeamMcpServer(
  store: RunStore,
  scheduler = new ManagedAssignmentScheduler(store),
): McpServer {
  const server = new McpServer(
    {
      name: "ark-team",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "ark_team_start",
    {
      title: "Start Ark Team run",
      description: "Create and persist a new Ark Team orchestration run.",
      inputSchema: {
        objective: z.string().min(1).max(20_000),
        project_path: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ objective, project_path }) =>
      handleTool(async () => ({
        run: await store.createRun({ objective, project_path }),
      })),
  );

  server.registerTool(
    "ark_team_list",
    {
      title: "List Ark Team runs",
      description: "List persisted Ark Team runs, optionally filtered by state.",
      inputSchema: {
        states: z.array(runStateSchema).max(10).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ states, limit }) =>
      handleTool(async () => ({
        ...(await store.listRuns({
          ...(states ? { states } : {}),
          ...(limit === undefined ? {} : { limit }),
        })),
      })),
  );

  server.registerTool(
    "ark_team_status",
    {
      title: "Get Ark Team run status",
      description: "Read the current persisted record for one Ark Team run.",
      inputSchema: {
        run_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id }) =>
      handleTool(async () => ({
        run: await store.getRun(run_id),
      })),
  );

  server.registerTool(
    "ark_team_logs",
    {
      title: "Read Ark Team run logs",
      description: "Read ordered observable lifecycle events for one Ark Team run.",
      inputSchema: {
        run_id: z.string().min(1),
        after_sequence: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id, after_sequence, limit }) =>
      handleTool(async () => ({
        ...(await store.getLogs(run_id, {
          ...(after_sequence === undefined ? {} : { after_sequence }),
          ...(limit === undefined ? {} : { limit }),
        })),
      })),
  );

  server.registerTool(
    "ark_team_assignment_start",
    {
      title: "Start managed Ark Team assignment",
      description:
        "Persist and start one PL or worker assignment in an existing linked Git worktree.",
      inputSchema: {
        run_id: z.string().min(1),
        team_id: z.string().regex(TEAM_ID_PATTERN),
        role: assignmentRoleSchema,
        parent_assignment_id: z
          .string()
          .regex(ASSIGNMENT_ID_PATTERN)
          .optional(),
        assignment: z.string().min(1).max(20_000),
        working_directory: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      run_id,
      team_id,
      role,
      parent_assignment_id,
      assignment,
      working_directory,
    }) =>
      handleTool(async () => ({
        assignment: await scheduler.start({
          run_id,
          team_id,
          role,
          ...(parent_assignment_id === undefined
            ? {}
            : { parent_assignment_id }),
          assignment,
          working_directory,
        }),
      })),
  );

  server.registerTool(
    "ark_team_assignment_list",
    {
      title: "List managed Ark Team assignments",
      description:
        "List persisted PL and worker assignments for one run with optional bounded filters.",
      inputSchema: {
        run_id: z.string().min(1),
        states: z.array(assignmentStateSchema).max(6).optional(),
        team_id: z.string().regex(TEAM_ID_PATTERN).optional(),
        parent_assignment_id: z
          .string()
          .regex(ASSIGNMENT_ID_PATTERN)
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id, states, team_id, parent_assignment_id }) =>
      handleTool(async () => ({
        ...(await scheduler.list(run_id, {
          ...(states === undefined ? {} : { states }),
          ...(team_id === undefined ? {} : { team_id }),
          ...(parent_assignment_id === undefined
            ? {}
            : { parent_assignment_id }),
        })),
      })),
  );

  server.registerTool(
    "ark_team_assignment_status",
    {
      title: "Get managed Ark Team assignment",
      description:
        "Read one persisted assignment, including pending approval or routed final report and usage.",
      inputSchema: {
        run_id: z.string().min(1),
        assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id, assignment_id }) =>
      handleTool(async () => ({
        assignment: await scheduler.get(run_id, assignment_id),
      })),
  );

  server.registerTool(
    "ark_team_assignment_decide",
    {
      title: "Resolve managed assignment approval",
      description:
        "Deliver one explicit user decision to the live session that owns a persisted pending approval.",
      inputSchema: {
        run_id: z.string().min(1),
        assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN),
        approval_id: z.string().uuid(),
        decision: z.enum([
          "approve_once",
          "approve_session",
          "decline",
          "cancel",
        ]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ run_id, assignment_id, approval_id, decision }) =>
      handleTool(async () => ({
        assignment: await scheduler.decide(
          run_id,
          assignment_id,
          approval_id,
          decision,
        ),
      })),
  );

  server.registerTool(
    "ark_team_assignment_cancel",
    {
      title: "Cancel managed Ark Team assignment",
      description:
        "Stop one active managed assignment and persist its cancelled state.",
      inputSchema: {
        run_id: z.string().min(1),
        assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN),
        reason: z.string().max(1000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ run_id, assignment_id, reason }) =>
      handleTool(async () => ({
        assignment: await scheduler.cancel(run_id, assignment_id, reason),
      })),
  );

  registerTransitionTool(server, store, scheduler, "pause");
  registerTransitionTool(server, store, scheduler, "resume");
  registerTransitionTool(server, store, scheduler, "cancel");

  return server;
}

function registerTransitionTool(
  server: McpServer,
  store: RunStore,
  scheduler: ManagedAssignmentScheduler,
  operation: "pause" | "resume" | "cancel",
): void {
  const names = {
    pause: "ark_team_pause",
    resume: "ark_team_resume",
    cancel: "ark_team_cancel",
  } as const;
  const descriptions = {
    pause: "Pause an active Ark Team run while preserving resumable state.",
    resume: "Resume a paused or cancelled Ark Team run from its preserved state.",
    cancel: "Cancel an Ark Team run while preserving artifacts and resumable state.",
  } as const;

  server.registerTool(
    names[operation],
    {
      title: `${operation[0]?.toUpperCase()}${operation.slice(1)} Ark Team run`,
      description: descriptions[operation],
      inputSchema: {
        run_id: z.string().min(1),
        reason: z.string().max(1000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: operation === "cancel",
        idempotentHint: operation !== "resume",
        openWorldHint: false,
      },
    },
    async ({ run_id, reason }) =>
      handleTool(async () => {
        if (operation === "pause" || operation === "cancel") {
          await scheduler.stopRun(run_id, operation === "pause" ? "paused" : "cancelled", reason);
        }
        const result =
          operation === "pause"
            ? await store.pauseRun(run_id, reason)
            : operation === "resume"
              ? await store.resumeRun(run_id, reason)
              : await store.cancelRun(run_id, reason);
        return result;
      }),
  );
}

async function handleTool<T extends object>(
  operation: () => Promise<T>,
): Promise<{
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}> {
  try {
    const payload: Record<string, unknown> = {
      ok: true,
      ...(await operation()),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    const payload = {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
