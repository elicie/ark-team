export type ArkTeamErrorCode =
  | "AGENT_SESSION_FAILED"
  | "AGENT_SESSION_PROTOCOL_ERROR"
  | "AGENT_SESSION_UNAVAILABLE"
  | "ASSIGNMENT_NOT_FOUND"
  | "CORRUPT_STATE"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "RUN_NOT_FOUND"
  | "STATE_ROOT_UNAVAILABLE"
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
