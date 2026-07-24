import { readFile } from "node:fs/promises";

import { ArkTeamError, normalizeError } from "./errors.js";
import {
  isManagedRole,
  ManagedCodexSessionLauncher,
  type ManagedRole,
} from "./managed-session.js";

interface CliInput {
  role: ManagedRole;
  working_directory: string;
  assignment: string;
}

async function main(): Promise<void> {
  const input = await parseArguments(process.argv.slice(2));
  const launcher = new ManagedCodexSessionLauncher({
    codex_path: process.env.ARK_TEAM_CODEX_PATH?.trim() || "codex",
  });
  const result = await launcher.run(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function parseArguments(argumentsList: string[]): Promise<CliInput> {
  let roleValue: string | undefined;
  let workingDirectory: string | undefined;
  let assignment: string | undefined;
  let assignmentFile: string | undefined;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      argument !== "--role" &&
      argument !== "--cwd" &&
      argument !== "--assignment" &&
      argument !== "--assignment-file"
    ) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        `Unknown or incomplete argument: ${argument ?? ""}`,
      );
    }
    if (value === undefined) {
      throw new ArkTeamError("INVALID_INPUT", `Missing value for ${argument}`);
    }

    if (argument === "--role") {
      roleValue = value;
    } else if (argument === "--cwd") {
      workingDirectory = value;
    } else if (argument === "--assignment") {
      assignment = value;
    } else {
      assignmentFile = value;
    }
    index += 1;
  }

  if (!roleValue || !isManagedRole(roleValue)) {
    throw new ArkTeamError("INVALID_INPUT", "--role must be pm, pl, or worker");
  }
  if (!workingDirectory) {
    throw new ArkTeamError("INVALID_INPUT", "--cwd is required");
  }
  if (assignment !== undefined && assignmentFile !== undefined) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "Use either --assignment or --assignment-file, not both",
    );
  }

  const resolvedAssignment =
    assignment ??
    (assignmentFile === undefined
      ? await readStandardInput()
      : await readFile(assignmentFile, "utf8"));
  if (!resolvedAssignment.trim()) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "Provide an assignment argument, file, or stdin",
    );
  }

  return {
    role: roleValue,
    working_directory: workingDirectory,
    assignment: resolvedAssignment,
  };
}

async function readStandardInput(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
        },
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});
