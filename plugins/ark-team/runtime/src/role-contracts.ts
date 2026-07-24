import { z } from "zod/v4";

import { ArkTeamError } from "./errors.js";
import type { ManagedRole } from "./managed-session.js";

const identifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const boundedTextSchema = z.string().trim().min(1).max(4000);
const boundedTextListSchema = z.array(boundedTextSchema).max(50);
const requiredTextListSchema = boundedTextListSchema.min(1);
const pathListSchema = z.array(z.string().trim().min(1).max(1024)).max(100);

const verificationSchema = z.strictObject({
  name: boundedTextSchema,
  status: z.enum(["passed", "failed", "not_run"]),
  evidence: boundedTextSchema,
});

const pmTeamSchema = z.strictObject({
  team_id: identifierSchema,
  mission: boundedTextSchema,
  owned_paths: pathListSchema,
  dependencies: z.array(identifierSchema).max(3),
  acceptance_criteria: requiredTextListSchema,
  verification: requiredTextListSchema,
  worker_count: z.number().int().min(1).max(5),
});

export const pmPlanSchema = z
  .strictObject({
    kind: z.literal("pm_plan"),
    objective: boundedTextSchema,
    teams: z.array(pmTeamSchema).min(1).max(4),
    integration: z.strictObject({
      strategy: z.enum(["local_merge", "pull_request", "no_git"]),
      acceptance_criteria: requiredTextListSchema,
      verification: requiredTextListSchema,
    }),
  })
  .superRefine((plan, context) => {
    validateDependencyGraph(
      plan.teams.map((team) => ({
        id: team.team_id,
        dependencies: team.dependencies,
      })),
      "teams",
      context,
    );
  });

const plWorkerSchema = z.strictObject({
  worker_key: identifierSchema,
  mission: boundedTextSchema,
  owned_paths: pathListSchema,
  dependencies: z.array(identifierSchema).max(4),
  acceptance_criteria: requiredTextListSchema,
  verification: requiredTextListSchema,
  commit_required: z.boolean(),
});

export const plWorkerPlanSchema = z
  .strictObject({
    kind: z.literal("pl_worker_plan"),
    team_id: identifierSchema,
    workers: z.array(plWorkerSchema).min(1).max(5),
  })
  .superRefine((plan, context) => {
    validateDependencyGraph(
      plan.workers.map((worker) => ({
        id: worker.worker_key,
        dependencies: worker.dependencies,
      })),
      "workers",
      context,
    );
  });

export const workerReportSchema = z.strictObject({
  kind: z.literal("worker_report"),
  team_id: identifierSchema,
  worker_key: identifierSchema,
  status: z.enum(["completed", "blocked"]),
  summary: boundedTextSchema,
  changed_files: pathListSchema,
  commit_sha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  verification: z.array(verificationSchema).min(1).max(50),
  blockers: boundedTextListSchema,
});

export const plReportSchema = z
  .strictObject({
    kind: z.literal("pl_report"),
    team_id: identifierSchema,
    status: z.enum(["completed", "blocked"]),
    summary: boundedTextSchema,
    worker_reports: z.array(workerReportSchema).min(1).max(5),
    integration_commit_sha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
    verification: z.array(verificationSchema).min(1).max(50),
    blockers: boundedTextListSchema,
  })
  .superRefine((report, context) => {
    const workerKeys = new Set<string>();
    for (const [index, worker] of report.worker_reports.entries()) {
      if (worker.team_id !== report.team_id) {
        context.addIssue({
          code: "custom",
          path: ["worker_reports", index, "team_id"],
          message: "worker report team_id must match the PL report team_id",
        });
      }
      if (workerKeys.has(worker.worker_key)) {
        context.addIssue({
          code: "custom",
          path: ["worker_reports", index, "worker_key"],
          message: `duplicate worker report: ${worker.worker_key}`,
        });
      }
      workerKeys.add(worker.worker_key);
    }
  });

export const integrationReportSchema = z
  .strictObject({
    kind: z.literal("integration_report"),
    status: z.enum(["completed", "blocked"]),
    summary: boundedTextSchema,
    team_ids: z.array(identifierSchema).min(1).max(4),
    integration_commit_sha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable(),
    verification: z.array(verificationSchema).min(1).max(50),
    blockers: boundedTextListSchema,
  })
  .superRefine((report, context) => {
    const seen = new Set<string>();
    for (const [index, teamId] of report.team_ids.entries()) {
      if (seen.has(teamId)) {
        context.addIssue({
          code: "custom",
          path: ["team_ids", index],
          message: `duplicate integrated team ID: ${teamId}`,
        });
      }
      seen.add(teamId);
    }
    if (
      report.status === "completed" &&
      report.integration_commit_sha === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["integration_commit_sha"],
        message: "completed integration reports require a commit SHA",
      });
    }
  });

const pmTeamResultSchema = z.strictObject({
  team_id: identifierSchema,
  status: z.enum(["completed", "blocked"]),
  summary: boundedTextSchema,
});

export const pmReportSchema = z
  .strictObject({
    kind: z.literal("pm_report"),
    status: z.enum(["completed", "blocked", "requires_user"]),
    summary: boundedTextSchema,
    teams: z.array(pmTeamResultSchema).min(1).max(4),
    integration_verification: z.array(verificationSchema).min(1).max(50),
    user_decisions: boundedTextListSchema,
  })
  .superRefine((report, context) => {
    const teamIds = new Set<string>();
    for (const [index, team] of report.teams.entries()) {
      if (teamIds.has(team.team_id)) {
        context.addIssue({
          code: "custom",
          path: ["teams", index, "team_id"],
          message: `duplicate team ID: ${team.team_id}`,
        });
      }
      teamIds.add(team.team_id);
    }
    if (report.status === "requires_user" && report.user_decisions.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["user_decisions"],
        message: "requires_user reports must include at least one user decision",
      });
    }
  });

export const managedOutputContracts = [
  "pm_plan",
  "pl_worker_plan",
  "worker_report",
  "pl_report",
  "integration_report",
  "pm_report",
] as const;
export type ManagedOutputContract = (typeof managedOutputContracts)[number];

export type PmPlan = z.infer<typeof pmPlanSchema>;
export type PlWorkerPlan = z.infer<typeof plWorkerPlanSchema>;
export type WorkerReport = z.infer<typeof workerReportSchema>;
export type PlReport = z.infer<typeof plReportSchema>;
export type IntegrationReport = z.infer<typeof integrationReportSchema>;
export type PmReport = z.infer<typeof pmReportSchema>;
export type ManagedOutput =
  | PmPlan
  | PlWorkerPlan
  | WorkerReport
  | PlReport
  | IntegrationReport
  | PmReport;

const contractSchemas = {
  pm_plan: pmPlanSchema,
  pl_worker_plan: plWorkerPlanSchema,
  worker_report: workerReportSchema,
  pl_report: plReportSchema,
  integration_report: integrationReportSchema,
  pm_report: pmReportSchema,
} as const;

export const managedOutputSchema = z.union([
  pmPlanSchema,
  plWorkerPlanSchema,
  workerReportSchema,
  plReportSchema,
  integrationReportSchema,
  pmReportSchema,
]);

const allowedContractsByRole = {
  pm: new Set<ManagedOutputContract>(["pm_plan", "pm_report"]),
  pl: new Set<ManagedOutputContract>([
    "pl_worker_plan",
    "pl_report",
    "integration_report",
  ]),
  worker: new Set<ManagedOutputContract>(["worker_report"]),
} satisfies Record<ManagedRole, ReadonlySet<ManagedOutputContract>>;

export const managedOutputJsonSchemas = Object.fromEntries(
  managedOutputContracts.map((contract) => [
    contract,
    z.toJSONSchema(contractSchemas[contract]),
  ]),
) as unknown as Record<ManagedOutputContract, Record<string, unknown>>;

export function assertManagedOutputContractRole(
  role: ManagedRole,
  contract: ManagedOutputContract,
): void {
  if (!managedOutputContracts.some((candidate) => candidate === contract)) {
    throw new ArkTeamError("INVALID_INPUT", "unknown output_contract");
  }
  if (!allowedContractsByRole[role].has(contract)) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      `output_contract ${contract} is not valid for role ${role}`,
    );
  }
}

export function parseManagedOutput(
  contract: ManagedOutputContract,
  response: string,
): ManagedOutput {
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch (error) {
    throw new ArkTeamError(
      "AGENT_SESSION_PROTOCOL_ERROR",
      `Managed ${contract} response is not valid JSON`,
      { cause: error },
    );
  }

  const parsed = contractSchemas[contract].safeParse(value);
  if (!parsed.success) {
    throw new ArkTeamError(
      "AGENT_SESSION_PROTOCOL_ERROR",
      `Managed ${contract} response does not match its output contract`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function validateDependencyGraph(
  nodes: ReadonlyArray<{
    id: string;
    dependencies: readonly string[];
  }>,
  collectionPath: "teams" | "workers",
  context: z.RefinementCtx,
): void {
  const indexes = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    if (indexes.has(node.id)) {
      context.addIssue({
        code: "custom",
        path: [collectionPath, index, collectionPath === "teams" ? "team_id" : "worker_key"],
        message: `duplicate ID: ${node.id}`,
      });
      continue;
    }
    indexes.set(node.id, index);
  }

  for (const [index, node] of nodes.entries()) {
    const seenDependencies = new Set<string>();
    for (const [dependencyIndex, dependency] of node.dependencies.entries()) {
      const path = [collectionPath, index, "dependencies", dependencyIndex];
      if (dependency === node.id) {
        context.addIssue({
          code: "custom",
          path,
          message: `${node.id} cannot depend on itself`,
        });
      } else if (!indexes.has(dependency)) {
        context.addIssue({
          code: "custom",
          path,
          message: `unknown dependency: ${dependency}`,
        });
      } else if (seenDependencies.has(dependency)) {
        context.addIssue({
          code: "custom",
          path,
          message: `duplicate dependency: ${dependency}`,
        });
      }
      seenDependencies.add(dependency);
    }
  }

  const graph = new Map(nodes.map((node) => [node.id, node.dependencies]));
  const states = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycleMembers = new Set<string>();
  const visit = (id: string): void => {
    if (states.get(id) === "visiting") {
      const cycleStart = stack.indexOf(id);
      for (const member of stack.slice(cycleStart)) {
        cycleMembers.add(member);
      }
      return;
    }
    if (states.get(id) === "visited") {
      return;
    }
    states.set(id, "visiting");
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    states.set(id, "visited");
  };
  for (const id of graph.keys()) {
    visit(id);
  }
  for (const id of cycleMembers) {
    const index = indexes.get(id);
    if (index !== undefined) {
      context.addIssue({
        code: "custom",
        path: [collectionPath, index, "dependencies"],
        message: `cyclic dependency involving ${id}`,
      });
    }
  }
}
