export type ArkTeamErrorCode =
  | "AGENT_SESSION_FAILED"
  | "AGENT_SESSION_PROTOCOL_ERROR"
  | "AGENT_SESSION_UNAVAILABLE"
  | "ASSIGNMENT_NOT_FOUND"
  | "CONFIG_INVALID"
  | "CONTRACT_VERSION_MISMATCH"
  | "CORRUPT_STATE"
  | "INVALID_INPUT"
  | "INVALID_PROJECT_CONFIG"
  | "INVALID_RECORD"
  | "INVALID_TRANSITION"
  | "PACKAGE_FINGERPRINT_MISMATCH"
  | "REMOTE_ACTION_FAILED"
  | "REMOTE_ACTION_UNAVAILABLE"
  | "RUN_NOT_FOUND"
  | "SCENARIO_SNAPSHOT_MISMATCH"
  | "SOURCE_DRIFT"
  | "STATE_ROOT_UNAVAILABLE"
  | "TEAM_NOT_FOUND"
  | "WORKSPACE_PREPARATION_FAILED"
  | "UNSAFE_AGENT_WORKSPACE";

export class ArkTeamError extends Error {
  readonly code: ArkTeamErrorCode;

  constructor(code: ArkTeamErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArkTeamError";
    this.code = code;
  }
}

export function normalizeError(error: unknown): ArkTeamError {
  if (error instanceof ArkTeamError) {
    return error;
  }

  if (error instanceof Error) {
    return new ArkTeamError("STATE_ROOT_UNAVAILABLE", error.message, { cause: error });
  }

  return new ArkTeamError("STATE_ROOT_UNAVAILABLE", "Unknown Ark Team runtime error");
}
