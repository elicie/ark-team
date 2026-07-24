import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import {
  RUN_ID_PATTERN,
  persistedRunSchema,
  type PersistedRun,
  type RunEvent,
  type RunListResult,
  type RunLogsResult,
  type RunRecord,
  type RunState,
  type TransitionResult,
} from "./domain.js";
import { ArkTeamError } from "./errors.js";
import { assertRunId, createRunId } from "./run-id.js";

interface RunStoreOptions {
  root_path?: string;
  now?: () => Date;
  suffix?: () => string;
}

interface CreateRunInput {
  objective: string;
  project_path: string;
}

interface ListRunsInput {
  states?: RunState[];
  limit?: number;
}

interface LogsInput {
  after_sequence?: number;
  limit?: number;
}

const ACTIVE_STATES = new Set<RunState>([
  "planning",
  "staffing",
  "executing",
  "integrating",
  "verifying",
  "waiting_user",
]);

export function resolveStateRoot(environment = process.env): string {
  const configured = environment.ARK_TEAM_STATE_ROOT?.trim();
  if (!configured) {
    return path.join(homedir(), ".codex", "team-orchestrator", "runs");
  }

  if (configured === "~") {
    return homedir();
  }

  if (configured.startsWith(`~${path.sep}`) || configured.startsWith("~/")) {
    return path.join(homedir(), configured.slice(2));
  }

  if (!path.isAbsolute(configured)) {
    throw new ArkTeamError(
      "INVALID_INPUT",
      "ARK_TEAM_STATE_ROOT must be an absolute path or start with ~/",
    );
  }

  return path.normalize(configured);
}

export class RunStore {
  readonly root_path: string;

  private readonly now: () => Date;
  private readonly suffix: () => string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: RunStoreOptions = {}) {
    this.root_path = path.resolve(options.root_path ?? resolveStateRoot());
    this.now = options.now ?? (() => new Date());
    this.suffix = options.suffix ?? (() => randomBytes(3).toString("hex"));
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    return this.withMutation(async () => {
      const objective = input.objective.trim();
      if (!objective) {
        throw new ArkTeamError("INVALID_INPUT", "objective must not be empty");
      }

      if (!path.isAbsolute(input.project_path)) {
        throw new ArkTeamError("INVALID_INPUT", "project_path must be absolute");
      }

      const projectPath = path.normalize(input.project_path);
      let projectStats;
      try {
        projectStats = await stat(projectPath);
      } catch (error) {
        throw new ArkTeamError("INVALID_INPUT", `project_path does not exist: ${projectPath}`, {
          cause: error,
        });
      }
      if (!projectStats.isDirectory()) {
        throw new ArkTeamError("INVALID_INPUT", "project_path must point to a directory");
      }

      await this.ensureRoot();
      const timestamp = this.now();
      const timestampText = timestamp.toISOString();
      const runId = await this.reserveRunDirectory(timestamp);
      const run: RunRecord = {
        schema_version: 1,
        run_id: runId,
        objective,
        project_path: projectPath,
        state: "planning",
        resume_state: null,
        created_at: timestampText,
        updated_at: timestampText,
        revision: 1,
        event_count: 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: 1,
        event_id: randomUUID(),
        event_type: "run.created",
        timestamp: timestampText,
        state: "planning",
        message: "Ark Team run created",
      };

      try {
        await this.writePersistedRun({ run, events: [event] });
      } catch (error) {
        await rm(this.runDirectory(runId), { recursive: true, force: true });
        throw error;
      }

      return run;
    });
  }

  async getRun(runId: string): Promise<RunRecord> {
    return (await this.readPersistedRun(runId)).run;
  }

  async listRuns(input: ListRunsInput = {}): Promise<RunListResult> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ArkTeamError("INVALID_INPUT", "limit must be an integer between 1 and 100");
    }

    const requestedStates = input.states ? new Set(input.states) : null;
    let entries;
    try {
      entries = await readdir(this.root_path, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { runs: [], total: 0 };
      }
      throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", "Unable to list Ark Team runs", {
        cause: error,
      });
    }

    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!RUN_ID_PATTERN.test(entry.name)) {
        continue;
      }

      const persisted = await this.readPersistedRun(entry.name);
      if (requestedStates && !requestedStates.has(persisted.run.state)) {
        continue;
      }
      runs.push(persisted.run);
    }

    runs.sort((left, right) => right.created_at.localeCompare(left.created_at));
    return {
      runs: runs.slice(0, limit),
      total: runs.length,
    };
  }

  async getLogs(runId: string, input: LogsInput = {}): Promise<RunLogsResult> {
    const afterSequence = input.after_sequence ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new ArkTeamError("INVALID_INPUT", "after_sequence must be a nonnegative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ArkTeamError("INVALID_INPUT", "limit must be an integer between 1 and 200");
    }

    const persisted = await this.readPersistedRun(runId);
    const remaining = persisted.events.filter((event) => event.sequence > afterSequence);
    const events = remaining.slice(0, limit);
    const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence;

    return {
      run_id: runId,
      events,
      next_after_sequence: nextAfterSequence,
      has_more: remaining.length > events.length,
    };
  }

  async pauseRun(runId: string, reason?: string): Promise<TransitionResult> {
    return this.transition(runId, "pause", reason);
  }

  async resumeRun(runId: string, reason?: string): Promise<TransitionResult> {
    return this.transition(runId, "resume", reason);
  }

  async cancelRun(runId: string, reason?: string): Promise<TransitionResult> {
    return this.transition(runId, "cancel", reason);
  }

  private async transition(
    runId: string,
    operation: "pause" | "resume" | "cancel",
    rawReason?: string,
  ): Promise<TransitionResult> {
    return this.withMutation(async () => {
      const persisted = await this.readPersistedRun(runId);
      const current = persisted.run;
      const reason = normalizeReason(rawReason);

      if (operation === "pause" && current.state === "paused") {
        return { run: current, changed: false };
      }
      if (operation === "cancel" && current.state === "cancelled") {
        return { run: current, changed: false };
      }

      let nextState: RunState;
      let resumeState: RunState | null;
      let eventType: RunEvent["event_type"];
      let defaultMessage: string;

      if (operation === "pause") {
        if (!ACTIVE_STATES.has(current.state)) {
          throw invalidTransition(operation, current.state);
        }
        nextState = "paused";
        resumeState = current.state;
        eventType = "run.paused";
        defaultMessage = "Ark Team run paused";
      } else if (operation === "resume") {
        if (
          (current.state !== "paused" && current.state !== "cancelled") ||
          current.resume_state === null
        ) {
          throw invalidTransition(operation, current.state);
        }
        nextState = current.resume_state;
        resumeState = null;
        eventType = "run.resumed";
        defaultMessage = "Ark Team run resumed";
      } else {
        if (current.state === "completed" || current.state === "failed") {
          throw invalidTransition(operation, current.state);
        }
        nextState = "cancelled";
        resumeState = current.state === "paused" ? current.resume_state : current.state;
        eventType = "run.cancelled";
        defaultMessage = "Ark Team run cancelled";
      }

      const timestamp = this.now().toISOString();
      const updatedRun: RunRecord = {
        ...current,
        state: nextState,
        resume_state: resumeState,
        updated_at: timestamp,
        revision: current.revision + 1,
        event_count: current.event_count + 1,
      };
      const event: RunEvent = {
        schema_version: 1,
        sequence: updatedRun.event_count,
        event_id: randomUUID(),
        event_type: eventType,
        timestamp,
        state: nextState,
        message: reason ?? defaultMessage,
      };

      await this.writePersistedRun({
        run: updatedRun,
        events: [...persisted.events, event],
      });
      return { run: updatedRun, changed: true };
    });
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root_path, { recursive: true, mode: 0o700 });
      await access(this.root_path, constants.R_OK | constants.W_OK);
    } catch (error) {
      throw new ArkTeamError(
        "STATE_ROOT_UNAVAILABLE",
        `Unable to access state root: ${this.root_path}`,
        { cause: error },
      );
    }
  }

  private async reserveRunDirectory(now: Date): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const runId = createRunId(now, this.suffix());
      try {
        await mkdir(this.runDirectory(runId), { recursive: false, mode: 0o700 });
        return runId;
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          continue;
        }
        throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", "Unable to create run directory", {
          cause: error,
        });
      }
    }

    throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", "Unable to allocate a unique run ID");
  }

  private async readPersistedRun(runId: string): Promise<PersistedRun> {
    assertRunId(runId);
    let raw: string;
    try {
      raw = await readFile(this.recordPath(runId), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ArkTeamError("RUN_NOT_FOUND", `Run not found: ${runId}`, { cause: error });
      }
      throw new ArkTeamError("STATE_ROOT_UNAVAILABLE", `Unable to read run: ${runId}`, {
        cause: error,
      });
    }

    try {
      return persistedRunSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new ArkTeamError("CORRUPT_STATE", `Persisted run is invalid: ${runId}`, {
        cause: error,
      });
    }
  }

  private async writePersistedRun(persisted: PersistedRun): Promise<void> {
    const validated = persistedRunSchema.parse(persisted);
    const runDirectory = this.runDirectory(validated.run.run_id);
    const finalPath = this.recordPath(validated.run.run_id);
    const temporaryPath = path.join(
      runDirectory,
      `.run-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );

    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw new ArkTeamError(
        "STATE_ROOT_UNAVAILABLE",
        `Unable to persist run: ${validated.run.run_id}`,
        { cause: error },
      );
    }
  }

  private runDirectory(runId: string): string {
    assertRunId(runId);
    return path.join(this.root_path, runId);
  }

  private recordPath(runId: string): string {
    return path.join(this.runDirectory(runId), "run.json");
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function invalidTransition(operation: string, state: RunState): ArkTeamError {
  return new ArkTeamError(
    "INVALID_TRANSITION",
    `Cannot ${operation} a run while it is ${state}`,
  );
}

function normalizeReason(reason?: string): string | undefined {
  const normalized = reason?.trim();
  return normalized ? normalized.slice(0, 1000) : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
