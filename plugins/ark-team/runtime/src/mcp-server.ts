import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import { runStateSchema } from "./domain.js";
import { normalizeError } from "./errors.js";
import { RunStore } from "./state-store.js";

const SERVER_INSTRUCTIONS =
  "Use Ark Team tools only after explicit user invocation. Start with ark_team_start, retain the run_id, inspect state with status/list/logs, and use pause/resume/cancel for lifecycle control. These tools manage orchestration records only; they do not yet spawn agents or edit project files.";

export function createArkTeamMcpServer(store: RunStore): McpServer {
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

  registerTransitionTool(server, store, "pause");
  registerTransitionTool(server, store, "resume");
  registerTransitionTool(server, store, "cancel");

  return server;
}

function registerTransitionTool(
  server: McpServer,
  store: RunStore,
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
