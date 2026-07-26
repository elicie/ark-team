import path from "node:path";

import type {
  AssignmentRecord,
  TeamRecord,
} from "./domain.js";

export interface RoutineApprovalCandidate {
  approval_id: string;
  kind: "command" | "file_change" | "permissions";
  reason: string | null;
  command?: string | undefined;
  cwd?: string | undefined;
  grant_root?: string | undefined;
  requested_permissions?: unknown;
}

export interface RoutineApprovalContext {
  assignment: Pick<
    AssignmentRecord,
    "role" | "team_id" | "working_directory"
  >;
  approval: RoutineApprovalCandidate;
  teams: Array<
    Pick<TeamRecord, "team_id" | "owned_paths" | "branch">
  >;
}

export function isRoutineCommandApproval(
  context: RoutineApprovalContext,
): boolean {
  const { approval, assignment } = context;
  if (
    approval.kind !== "command" ||
    approval.cwd !== assignment.working_directory ||
    approval.command === undefined
  ) {
    return false;
  }
  const command = unwrapCommand(approval.command);
  if (command === null || /[;|`<>$\\\r\n]/.test(command)) {
    return false;
  }
  const commands = command.split(" && ");
  if (
    commands.length > 4 ||
    commands.some((candidate) => !candidate || candidate.includes("&"))
  ) {
    return false;
  }
  return commands.every((candidate) =>
    isRoutineSingleCommand(candidate, assignment, context.teams),
  );
}

function isRoutineSingleCommand(
  command: string,
  assignment: RoutineApprovalContext["assignment"],
  teams: RoutineApprovalContext["teams"],
): boolean {
  if (
    command === "npm ci" ||
    command === "npm test" ||
    /^npm run test(?::[A-Za-z0-9_-]+)?$/.test(command)
  ) {
    return true;
  }
  if (isRoutineCommit(command, assignment.role)) {
    return true;
  }
  if (isRoutineAdd(command, assignment, teams)) {
    return true;
  }
  return isRoutineIntegrationMerge(command, assignment, teams);
}

function unwrapCommand(command: string): string | null {
  const singleQuoted = command.match(
    /^\/(?:usr\/)?bin\/(?:zsh|bash|sh) -lc '([^'\r\n]*)'$/,
  );
  if (singleQuoted?.[1] !== undefined) {
    return singleQuoted[1];
  }
  const doubleQuoted = command.match(
    /^\/(?:usr\/)?bin\/(?:zsh|bash|sh) -lc "([^"\\\r\n]*)"$/,
  );
  if (doubleQuoted?.[1] !== undefined) {
    return doubleQuoted[1];
  }
  return /^[^'"\r\n]+$/.test(command) ? command : null;
}

function isRoutineCommit(
  command: string,
  role: AssignmentRecord["role"],
): boolean {
  if (role !== "pl" && role !== "worker" && role !== "integration_pl") {
    return false;
  }
  return /^git commit -m (?:"[^"]{1,200}"|'[^']{1,200}')$/.test(command);
}

function isRoutineAdd(
  command: string,
  assignment: RoutineApprovalContext["assignment"],
  teams: RoutineApprovalContext["teams"],
): boolean {
  if (assignment.role !== "pl" && assignment.role !== "worker") {
    return false;
  }
  const match = command.match(
    /^git add (?:-- )?([A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*)$/,
  );
  if (!match?.[1]) {
    return false;
  }
  const team = teams.find((candidate) => candidate.team_id === assignment.team_id);
  if (!team) {
    return false;
  }
  const owned = new Set(team.owned_paths.map(normalizeRelativePath));
  const requested = match[1].split(" ");
  return (
    requested.length > 0 &&
    new Set(requested).size === requested.length &&
    requested.every((candidate) => {
      const normalized = normalizeRelativePath(candidate);
      return normalized !== null && owned.has(normalized);
    })
  );
}

function isRoutineIntegrationMerge(
  command: string,
  assignment: RoutineApprovalContext["assignment"],
  teams: RoutineApprovalContext["teams"],
): boolean {
  if (assignment.role !== "integration_pl") {
    return false;
  }
  const match = command.match(
    /^git merge (?:(?:--no-ff|--ff-only|--no-edit) )*([A-Za-z0-9._/-]+)(?: -m (?:"[^"]{1,200}"|'[^']{1,200}'))?$/,
  );
  return (
    match?.[1] !== undefined &&
    teams.some((team) => team.branch === match[1])
  );
}

function normalizeRelativePath(candidate: string): string | null {
  if (
    !candidate ||
    path.posix.isAbsolute(candidate) ||
    candidate.includes("\\")
  ) {
    return null;
  }
  const normalized = path.posix.normalize(candidate);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }
  return normalized.replace(/^\.\//, "");
}
