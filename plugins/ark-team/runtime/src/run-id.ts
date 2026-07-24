import { randomBytes } from "node:crypto";

import { RUN_ID_PATTERN } from "./domain.js";
import { ArkTeamError } from "./errors.js";

export function createRunId(now: Date, suffix = randomBytes(3).toString("hex")): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "z")
    .toLowerCase();
  const normalizedSuffix = suffix.toLowerCase();
  const runId = `ark-${timestamp}-${normalizedSuffix}`;

  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ArkTeamError("INVALID_INPUT", "Unable to generate a portable run identifier");
  }

  return runId;
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "run_id must match ark-YYYYMMDDtHHMMSSz-xxxxxx using lowercase ASCII",
    );
  }
}
