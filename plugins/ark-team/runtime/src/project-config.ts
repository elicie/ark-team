import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";
import { z } from "zod/v4";

import { ArkTeamError } from "./errors.js";
import {
  sha256CanonicalJson,
  verificationCoordinatorConfigSchema,
} from "./verification-contract.js";

const fixedModelsSchema = z
  .object({
    pm: z.literal("gpt-5.6-sol"),
    pm_reasoning_effort: z.literal("xhigh"),
    pl: z.literal("gpt-5.6-terra"),
    pl_reasoning_effort: z.literal("xhigh"),
    worker: z.literal("gpt-5.6-luna"),
    worker_reasoning_effort: z.literal("xhigh"),
  })
  .strict();

const verificationCommandSchema = z
  .object({
    argv: z
      .array(z.string().min(1).max(1_000).refine((value) => !value.includes("\0")))
      .min(1)
      .max(100),
    cwd: z.string().min(1).max(1_000).default("."),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      path.isAbsolute(command.cwd) ||
      path.normalize(command.cwd) === ".." ||
      path.normalize(command.cwd).startsWith(`..${path.sep}`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["cwd"],
        message: "verification cwd must stay beneath the project root",
      });
    }
  });

export const projectConfigSchema = z
  .object({
    version: z.literal(1),
    organization: z
      .object({
        max_teams: z.number().int().min(1).max(4),
        min_workers_per_team: z.number().int().min(1).max(5),
        max_workers_per_team: z.number().int().min(1).max(5),
        allow_direct_pl_communication: z.literal(true),
      })
      .strict(),
    models: fixedModelsSchema,
    execution: z
      .object({
        agent_timeout_minutes: z.number().int().min(1).max(1_440),
        run_timeout_minutes: z.literal(360),
        worker_correction_rounds: z.number().int().min(0).max(10),
        pl_correction_rounds: z.number().int().min(0).max(10),
        internal_agent_retries: z.number().int().min(0).max(10),
        external_provider_retries: z.literal(3),
        pause_when_host_stops: z.literal(true),
      })
      .strict(),
    git: z
      .object({
        integration_branch_prefix: z
          .string()
          .min(2)
          .max(80)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/)
          .refine(
            (value) => !value.includes("..") && !value.includes("//"),
            "integration branch prefix contains an unsafe segment",
          ),
        preserve_local_branches: z.literal(true),
        cleanup_verified_worktrees: z.literal(true),
        require_approval_for_remote_actions: z.literal(true),
      })
      .strict(),
    logging: z
      .object({
        root: z.literal("~/.ark-team/runs"),
        retention_days: z.literal(30),
        record_usage: z.literal(true),
        record_private_reasoning: z.literal(false),
      })
      .strict(),
    external_models: z
      .object({
        explicit_request_only: z.literal(true),
        automatic_luna_fallback: z.literal(false),
      })
      .strict(),
    verification: z
      .object({
        commands: z.array(verificationCommandSchema).max(50),
        coordinator: verificationCoordinatorConfigSchema.nullable().default(null),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.organization.min_workers_per_team >
      config.organization.max_workers_per_team
    ) {
      context.addIssue({
        code: "custom",
        path: ["organization", "min_workers_per_team"],
        message: "minimum worker count exceeds maximum worker count",
      });
    }
  });

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = Object.freeze({
  version: 1,
  organization: Object.freeze({
    max_teams: 4,
    min_workers_per_team: 1,
    max_workers_per_team: 5,
    allow_direct_pl_communication: true,
  }),
  models: Object.freeze({
    pm: "gpt-5.6-sol",
    pm_reasoning_effort: "xhigh",
    pl: "gpt-5.6-terra",
    pl_reasoning_effort: "xhigh",
    worker: "gpt-5.6-luna",
    worker_reasoning_effort: "xhigh",
  }),
  execution: Object.freeze({
    agent_timeout_minutes: 60,
    run_timeout_minutes: 360,
    worker_correction_rounds: 2,
    pl_correction_rounds: 2,
    internal_agent_retries: 2,
    external_provider_retries: 3,
    pause_when_host_stops: true,
  }),
  git: Object.freeze({
    integration_branch_prefix: "orchestrator/",
    preserve_local_branches: true,
    cleanup_verified_worktrees: true,
    require_approval_for_remote_actions: true,
  }),
  logging: Object.freeze({
    root: "~/.ark-team/runs",
    retention_days: 30,
    record_usage: true,
    record_private_reasoning: false,
  }),
  external_models: Object.freeze({
    explicit_request_only: true,
    automatic_luna_fallback: false,
  }),
  verification: Object.freeze({
    commands: Object.freeze([]),
    coordinator: null,
  }),
}) as unknown as ProjectConfig;

export interface ResolvedProjectConfig {
  config: ProjectConfig;
  source_path: string | null;
}

export interface ResolvedVerificationCommand {
  argv: string[];
  cwd: string;
}

export function projectConfigSha256(config: ProjectConfig): string {
  return sha256CanonicalJson(projectConfigSchema.parse(config));
}

export async function loadProjectConfig(
  projectPath: string,
): Promise<ResolvedProjectConfig> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectPath);
  } catch (error) {
    throw invalidConfig("Unable to resolve the project configuration root", error);
  }
  const sourcePath = path.join(
    projectRoot,
    ".codex",
    "team-orchestrator.toml",
  );
  let text: string;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        config: structuredClone(DEFAULT_PROJECT_CONFIG),
        source_path: null,
      };
    }
    throw invalidConfig("Unable to read the project configuration", error);
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw invalidConfig("Project configuration is not valid TOML", error);
  }
  const merged = mergeWithDefaults(parsed);
  const validated = projectConfigSchema.safeParse(merged);
  if (!validated.success) {
    if (
      validated.error.issues.some(
        (issue) =>
          issue.path[0] === "verification" &&
          issue.path[1] === "coordinator",
      )
    ) {
      throw new ArkTeamError(
        "CONFIG_INVALID",
        "Verification coordinator configuration does not match the approved schema",
        { cause: validated.error },
      );
    }
    throw invalidConfig("Project configuration does not match the safe schema");
  }
  return {
    config: validated.data,
    source_path: sourcePath,
  };
}

export function resolveVerificationCommands(
  config: ProjectConfig,
  projectPath: string,
): ResolvedVerificationCommand[] {
  const projectRoot = path.resolve(projectPath);
  return config.verification.commands.map((command) => {
    const cwd = path.resolve(projectRoot, command.cwd);
    if (cwd !== projectRoot && !cwd.startsWith(`${projectRoot}${path.sep}`)) {
      throw invalidConfig("Verification command cwd escapes the project root");
    }
    return {
      argv: [...command.argv],
      cwd,
    };
  });
}

function mergeWithDefaults(input: unknown): unknown {
  if (!isPlainObject(input)) {
    return input;
  }
  return {
    ...structuredClone(DEFAULT_PROJECT_CONFIG),
    ...input,
    organization: mergeTable(DEFAULT_PROJECT_CONFIG.organization, input.organization),
    models: mergeTable(DEFAULT_PROJECT_CONFIG.models, input.models),
    execution: mergeTable(DEFAULT_PROJECT_CONFIG.execution, input.execution),
    git: mergeTable(DEFAULT_PROJECT_CONFIG.git, input.git),
    logging: mergeTable(DEFAULT_PROJECT_CONFIG.logging, input.logging),
    external_models: mergeTable(
      DEFAULT_PROJECT_CONFIG.external_models,
      input.external_models,
    ),
    verification: mergeTable(
      DEFAULT_PROJECT_CONFIG.verification,
      input.verification,
    ),
  };
}

function mergeTable(
  defaults: Readonly<Record<string, unknown>>,
  input: unknown,
): unknown {
  return isPlainObject(input) ? { ...defaults, ...input } : input ?? defaults;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function invalidConfig(message: string, cause?: unknown): ArkTeamError {
  return new ArkTeamError("INVALID_PROJECT_CONFIG", message, { cause });
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
