import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ArkTeamError } from "./errors.js";
import type {
  ManagedOutput,
  ManagedOutputContract,
} from "./role-contracts.js";

export type ManagedModelReasoningEffort = "xhigh";
export type ManagedSandboxMode = "read-only" | "workspace-write";
export type ManagedApprovalMode = "never" | "on-request";

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export const managedRoleNames = ["pm", "pl", "worker"] as const;
export type ManagedRole = (typeof managedRoleNames)[number];

export interface ManagedRoleProfile {
  agent_name: "ark_pm" | "ark_pl" | "ark_worker";
  model: "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
  model_reasoning_effort: ManagedModelReasoningEffort;
  sandbox_mode: ManagedSandboxMode;
  approval_policy: ManagedApprovalMode;
  instructions: string;
}

export const managedRoleProfiles: Readonly<Record<ManagedRole, ManagedRoleProfile>> = {
  pm: {
    agent_name: "ark_pm",
    model: "gpt-5.6-sol",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "read-only",
    approval_policy: "never",
    instructions: [
      "Act only as the management-only Ark Team PM.",
      "Never edit, create, delete, merge, commit, or directly mutate project files.",
      "Inspect observable project evidence, define acceptance criteria, and manage work through reports.",
      "Do not spawn native subagents from this session.",
      "When another managed session is needed, return a bounded TEAM_SPAWN_REQUEST for the Ark Team controller.",
    ].join(" "),
  },
  pl: {
    agent_name: "ark_pl",
    model: "gpt-5.6-terra",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    instructions: [
      "Lead exactly one bounded Ark Team team inside the assigned linked Git worktree.",
      "Preserve unrelated user work and verify observable evidence.",
      "Do not spawn native subagents from this session.",
      "Return WORKER_SPAWN_REQUEST records for work that the Ark Team controller should assign to managed worker sessions.",
      "Consolidate worker outcomes into one PL report for the PM.",
    ].join(" "),
  },
  worker: {
    agent_name: "ark_worker",
    model: "gpt-5.6-luna",
    model_reasoning_effort: "xhigh",
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    instructions: [
      "Execute exactly one bounded assignment inside the assigned linked Git worktree.",
      "Do not spawn or delegate to other agents.",
      "Preserve unrelated user work, run focused verification, and report observable evidence to the owning PL.",
      "Create a local commit only when the assignment explicitly requests it.",
    ].join(" "),
  },
};

export const managedCodexConfig = {
  agents: {
    enabled: false,
  },
  apps: {
    _default: {
      enabled: false,
    },
  },
  features: {
    multi_agent: false,
  },
} as const;

export interface ManagedSessionRequest {
  role: ManagedRole;
  assignment: string;
  working_directory: string;
  resume_session_id?: string;
  output_contract?: ManagedOutputContract;
  timeout_ms?: number;
  provider_sensitive_env_names?: readonly string[];
  signal?: AbortSignal;
}

export interface ManagedSessionResult {
  session_id: string;
  role: ManagedRole;
  agent_name: ManagedRoleProfile["agent_name"];
  model: ManagedRoleProfile["model"];
  model_reasoning_effort: ManagedModelReasoningEffort;
  sandbox_mode: ManagedSandboxMode;
  requested_approval_policy: ManagedApprovalMode;
  final_report: string;
  structured_report?: ManagedOutput;
  usage: Usage;
}

const execFileAsync = promisify(execFile);

export function isManagedRole(value: string): value is ManagedRole {
  return managedRoleNames.some((role) => role === value);
}

export async function assertManagedWorkspace(
  role: ManagedRole,
  rawWorkingDirectory: string,
): Promise<string> {
  if (!path.isAbsolute(rawWorkingDirectory)) {
    throw new ArkTeamError("INVALID_INPUT", "working_directory must be absolute");
  }

  const workingDirectory = path.normalize(rawWorkingDirectory);
  let directoryStats;
  try {
    directoryStats = await stat(workingDirectory);
  } catch (error) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      `working_directory does not exist: ${workingDirectory}`,
      { cause: error },
    );
  }
  if (!directoryStats.isDirectory()) {
    throw new ArkTeamError("INVALID_INPUT", "working_directory must point to a directory");
  }

  if (role === "pm") {
    return workingDirectory;
  }

  const gitPointerPath = path.join(workingDirectory, ".git");
  let pointerStats;
  try {
    pointerStats = await stat(gitPointerPath);
  } catch (error) {
    throw unsafeWriterWorkspace(workingDirectory, error);
  }
  if (!pointerStats.isFile()) {
    throw unsafeWriterWorkspace(workingDirectory);
  }

  let pointer;
  try {
    pointer = await readFile(gitPointerPath, "utf8");
  } catch (error) {
    throw unsafeWriterWorkspace(workingDirectory, error);
  }
  const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match?.[1]) {
    throw unsafeWriterWorkspace(workingDirectory);
  }

  const gitDirectory = path.resolve(workingDirectory, match[1]);
  try {
    const gitDirectoryStats = await stat(gitDirectory);
    if (!gitDirectoryStats.isDirectory()) {
      throw unsafeWriterWorkspace(workingDirectory);
    }
  } catch (error) {
    if (error instanceof ArkTeamError) {
      throw error;
    }
    throw unsafeWriterWorkspace(workingDirectory, error);
  }

  try {
    const [topLevelResult, absoluteGitDirectoryResult, commonGitDirectoryResult] =
      await Promise.all([
        execFileAsync("git", ["-C", workingDirectory, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
        }),
        execFileAsync("git", ["-C", workingDirectory, "rev-parse", "--absolute-git-dir"], {
          encoding: "utf8",
        }),
        execFileAsync(
          "git",
          [
            "-C",
            workingDirectory,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          { encoding: "utf8" },
        ),
      ]);
    const [actualWorkingDirectory, actualTopLevel, actualGitDirectory, actualCommonDirectory] =
      await Promise.all([
        realpath(workingDirectory),
        realpath(topLevelResult.stdout.trim()),
        realpath(absoluteGitDirectoryResult.stdout.trim()),
        realpath(commonGitDirectoryResult.stdout.trim()),
      ]);
    if (
      actualWorkingDirectory !== actualTopLevel ||
      actualGitDirectory === actualCommonDirectory
    ) {
      throw unsafeWriterWorkspace(workingDirectory);
    }
  } catch (error) {
    if (error instanceof ArkTeamError) {
      throw error;
    }
    throw unsafeWriterWorkspace(workingDirectory, error);
  }

  return workingDirectory;
}

export function buildManagedPrompt(
  role: ManagedRole,
  assignment: string,
  outputContract?: ManagedOutputContract,
  modelContract: {
    model: string;
    reasoning_effort: string;
  } = {
    model: managedRoleProfiles[role].model,
    reasoning_effort: managedRoleProfiles[role].model_reasoning_effort,
  },
): string {
  const profile = managedRoleProfiles[role];
  return [
    "<ark_team_managed_role>",
    `Role: ${profile.agent_name}`,
    `Model contract: ${modelContract.model} / ${modelContract.reasoning_effort}`,
    `Permission contract: ${profile.sandbox_mode} / ${profile.approval_policy}`,
    profile.instructions,
    outputContract === undefined
      ? "Return only the observable role report. Never expose private chain-of-thought."
      : `Return only JSON matching the ${outputContract} output contract. Never expose private chain-of-thought.`,
    "</ark_team_managed_role>",
    "<ark_team_assignment>",
    assignment,
    "</ark_team_assignment>",
  ].join("\n");
}

function unsafeWriterWorkspace(workingDirectory: string, cause?: unknown): ArkTeamError {
  return new ArkTeamError(
    "UNSAFE_AGENT_WORKSPACE",
    `PL and worker sessions require a linked Git worktree root: ${workingDirectory}`,
    cause === undefined ? undefined : { cause },
  );
}
