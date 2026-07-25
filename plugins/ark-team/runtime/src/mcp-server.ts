import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import {
  ASSIGNMENT_ID_PATTERN,
  TEAM_ID_PATTERN,
  assignmentStateSchema,
  runStateSchema,
} from "./domain.js";
import { ManagedAssignmentScheduler } from "./assignment-scheduler.js";
import { ArkTeamError, normalizeError } from "./errors.js";
import type { RunCoordinatorResult } from "./integration-coordinator.js";
import {
  ArkTeamOrchestrator,
  type ExecuteArkTeamInput,
  type ExecuteArkTeamResult,
  type TeamExecutionCoordinator,
} from "./orchestrator.js";
import { PlanMaterializer } from "./plan-materializer.js";
import { loadProjectConfig } from "./project-config.js";
import { pmPlanSchema } from "./role-contracts.js";
import { RunStore } from "./state-store.js";
import { TeamCoordinator } from "./team-coordinator.js";
import {
  ArkTeamRunCoordinator,
  IntegrationCoordinator,
} from "./integration-coordinator.js";

const SERVER_INSTRUCTIONS =
  "Use Ark Team tools only after explicit user invocation. Prefer ark_team_execute to create a run, invoke the managed read-only PM, execute dependency-ready teams, and continue through guarded integration, PM review, and worktree cleanup. Use ark_team_start plus ark_team_plan_apply only for manual or recovery flows. Inspect team worktrees with ark_team_team_list and the integration record with ark_team_status. Keep every returned assignment_id. For waiting_user, distinguish pending_approval, pending_retry, and remote_action. Deliver live agent approvals only through ark_team_assignment_decide, exhausted-retry choices only through ark_team_assignment_retry_decide, and the exact persisted push/PR request only through ark_team_remote_decide. If a persisted agent approval lost its live session after controller restart, use ark_team_assignment_recover with resume_safely or cancel_run; recovery never carries the old approval into the new turn. Never approve a remote action without the user's explicit choice. Then call ark_team_advance to continue the hierarchy. Use assignment status/list for stored reports, counters, and usage. Run pause/cancel stops active managed assignments.";

export interface ArkTeamExecutionController {
  execute(input: ExecuteArkTeamInput): Promise<ExecuteArkTeamResult>;
}

interface RemoteDecisionCoordinator {
  decideRemote(
    runId: string,
    requestId: string,
    decision: "approve_once" | "cancel_run",
  ): Promise<RunCoordinatorResult>;
}

export function createArkTeamMcpServer(
  store: RunStore,
  scheduler = new ManagedAssignmentScheduler(store),
  materializer = new PlanMaterializer(store),
  coordinator: TeamExecutionCoordinator = new ArkTeamRunCoordinator(
    store,
    new TeamCoordinator(store, scheduler),
    new IntegrationCoordinator(store, scheduler),
  ),
  orchestrator: ArkTeamExecutionController = new ArkTeamOrchestrator(store, {
    materializer,
    coordinator,
  }),
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
      handleTool(async () => {
        const resolved = await loadProjectConfig(project_path);
        return {
          run: await store.createRun({
            objective,
            project_path,
            project_config: resolved.config,
            project_config_source: resolved.source_path,
          }),
        };
      }),
  );

  server.registerTool(
    "ark_team_execute",
    {
      title: "Execute Ark Team PM planning",
      description:
        "Create a run and advance managed PM, teams, integration, guarded remote handoff, final review, and cleanup until blocked or complete.",
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
        ...(await orchestrator.execute({ objective, project_path })),
      })),
  );

  server.registerTool(
    "ark_team_advance",
    {
      title: "Advance Ark Team hierarchy",
      description:
        "Continue dependency-ready teams, guarded integration, approved remote work, PM review, and cleanup until completed, blocked, or waiting.",
      inputSchema: {
        run_id: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ run_id }) =>
      handleTool(async () => ({
        ...(await coordinator.advance(run_id)),
      })),
  );

  server.registerTool(
    "ark_team_remote_decide",
    {
      title: "Decide one Ark Team remote action",
      description:
        "Approve one exact persisted integration push/PR tuple or cancel the run while preserving local artifacts.",
      inputSchema: {
        run_id: z.string().min(1),
        request_id: z.string().uuid(),
        decision: z.enum(["approve_once", "cancel_run"]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ run_id, request_id, decision }) =>
      handleTool(async () => {
        if (!supportsRemoteDecision(coordinator)) {
          throw new ArkTeamError(
            "REMOTE_ACTION_UNAVAILABLE",
            "configured coordinator does not support remote actions",
          );
        }
        return {
          ...(await coordinator.decideRemote(
            run_id,
            request_id,
            decision,
          )),
        };
      }),
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
        ...(await store.getRunContext(run_id)),
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
    "ark_team_plan_apply",
    {
      title: "Apply Ark Team PM plan",
      description:
        "Validate and persist one PM plan while creating an isolated linked Git worktree for each team.",
      inputSchema: {
        run_id: z.string().min(1),
        plan: pmPlanSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ run_id, plan }) =>
      handleTool(async () => ({
        ...(await materializer.apply(run_id, plan)),
      })),
  );

  server.registerTool(
    "ark_team_team_list",
    {
      title: "List Ark Team team workspaces",
      description:
        "List durable PM-planned teams and their linked worktree, branch, base commit, dependencies, and state.",
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
        ...(await materializer.list(run_id)),
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
        role: z.enum(["pl", "worker"]),
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

  server.registerTool(
    "ark_team_assignment_recover",
    {
      title: "Recover orphaned assignment approval",
      description:
        "Safely resume the same persisted thread without applying its lost approval, or cancel the run while preserving artifacts.",
      inputSchema: {
        run_id: z.string().min(1),
        assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN),
        approval_id: z.string().uuid(),
        decision: z.enum(["resume_safely", "cancel_run"]),
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
        assignment: await scheduler.recoverApproval(
          run_id,
          assignment_id,
          approval_id,
          decision,
        ),
      })),
  );

  server.registerTool(
    "ark_team_assignment_retry_decide",
    {
      title: "Resolve exhausted assignment retry",
      description:
        "Apply an explicit user choice to one opaque exhausted-retry request: run one additional bounded attempt or cancel the run.",
      inputSchema: {
        run_id: z.string().min(1),
        assignment_id: z.string().regex(ASSIGNMENT_ID_PATTERN),
        retry_request_id: z.string().uuid(),
        decision: z.enum(["retry_once", "cancel_run"]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      run_id,
      assignment_id,
      retry_request_id,
      decision,
    }) =>
      handleTool(async () => ({
        assignment: await scheduler.decideRetry(
          run_id,
          assignment_id,
          retry_request_id,
          decision,
        ),
      })),
  );

  registerTransitionTool(server, store, scheduler, "pause");
  registerTransitionTool(server, store, scheduler, "resume");
  registerTransitionTool(server, store, scheduler, "cancel");

  return server;
}

function supportsRemoteDecision(
  coordinator: TeamExecutionCoordinator,
): coordinator is TeamExecutionCoordinator & RemoteDecisionCoordinator {
  return (
    "decideRemote" in coordinator &&
    typeof coordinator.decideRemote === "function"
  );
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
