import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type {
  ApprovalSessionOptions,
  ApprovalSessionRequest,
  ApprovalSessionUpdate,
} from "../src/approval-session.js";
import { ArkTeamError } from "../src/errors.js";
import {
  ManagedCodexSessionLauncher,
  managedCodexConfig,
  managedRoleProfiles,
  type ManagedAppServerSession,
  type Usage,
} from "../src/managed-session.js";

const usage: Usage = {
  input_tokens: 120,
  cached_input_tokens: 20,
  cache_write_input_tokens: 0,
  output_tokens: 12,
  reasoning_output_tokens: 4,
};
const execFileAsync = promisify(execFile);

test("TEST-301 managed role profiles enforce the approved model and permission split", () => {
  assert.deepEqual(managedCodexConfig, {
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
  });
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(managedRoleProfiles).map(([role, profile]) => [
        role,
        {
          agent_name: profile.agent_name,
          model: profile.model,
          effort: profile.model_reasoning_effort,
          sandbox: profile.sandbox_mode,
          approval: profile.approval_policy,
        },
      ]),
    ),
    {
      pm: {
        agent_name: "ark_pm",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        sandbox: "read-only",
        approval: "never",
      },
      pl: {
        agent_name: "ark_pl",
        model: "gpt-5.6-terra",
        effort: "xhigh",
        sandbox: "workspace-write",
        approval: "on-request",
      },
      worker: {
        agent_name: "ark_worker",
        model: "gpt-5.6-luna",
        effort: "xhigh",
        sandbox: "workspace-write",
        approval: "on-request",
      },
    },
  );
});

test("TEST-302 starts independent app-server PM and worker sessions", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-managed-test-"));
  try {
    const workerDirectory = await createLinkedWorktreeFixture(temporaryRoot);
    const factory = new ScriptedSessionFactory([
      (request, sequence) => completedUpdate(request, sequence),
      (request, sequence) => completedUpdate(request, sequence),
    ]);
    const launcher = new ManagedCodexSessionLauncher({
      session_factory: factory.create,
    });

    const pm = await launcher.run({
      role: "pm",
      assignment: "Plan a bounded change.",
      working_directory: temporaryRoot,
    });
    const worker = await launcher.run({
      role: "worker",
      assignment: "Implement the bounded change.",
      working_directory: workerDirectory,
    });

    assert.notEqual(pm.session_id, worker.session_id);
    assert.deepEqual(
      factory.requests.map((request) => ({
        role: request.role,
        assignment: request.assignment,
        working_directory: request.working_directory,
      })),
      [
        {
          role: "pm",
          assignment: "Plan a bounded change.",
          working_directory: temporaryRoot,
        },
        {
          role: "worker",
          assignment: "Implement the bounded change.",
          working_directory: workerDirectory,
        },
      ],
    );
    assert.deepEqual(pm.usage, usage);
    assert.equal(pm.sandbox_mode, "read-only");
    assert.equal(pm.requested_approval_policy, "never");
    assert.equal(worker.sandbox_mode, "workspace-write");
    assert.equal(worker.requested_approval_policy, "on-request");
    assert.deepEqual(
      Object.keys(pm).sort(),
      [
        "agent_name",
        "final_report",
        "model",
        "model_reasoning_effort",
        "requested_approval_policy",
        "role",
        "sandbox_mode",
        "session_id",
        "usage",
      ].sort(),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-303 refuses to launch a writing role in a primary checkout", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-primary-test-"));
  try {
    await mkdir(path.join(temporaryRoot, ".git"));
    const factory = new ScriptedSessionFactory([]);
    const launcher = new ManagedCodexSessionLauncher({
      session_factory: factory.create,
    });

    await assert.rejects(
      launcher.run({
        role: "pl",
        assignment: "Do not run this assignment.",
        working_directory: temporaryRoot,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "UNSAFE_AGENT_WORKSPACE",
    );

    const missingPointer = path.join(temporaryRoot, "missing-pointer");
    const malformedPointer = path.join(temporaryRoot, "malformed-pointer");
    const missingGitDirectory = path.join(temporaryRoot, "missing-git-directory");
    await mkdir(missingPointer);
    await mkdir(malformedPointer);
    await mkdir(missingGitDirectory);
    await writeFile(path.join(malformedPointer, ".git"), "not-a-git-pointer\n", "utf8");
    await writeFile(
      path.join(missingGitDirectory, ".git"),
      "gitdir: ../does-not-exist\n",
      "utf8",
    );

    for (const workingDirectory of [
      missingPointer,
      malformedPointer,
      missingGitDirectory,
    ]) {
      await assert.rejects(
        launcher.run({
          role: "worker",
          assignment: "Do not run this assignment.",
          working_directory: workingDirectory,
        }),
        (error: unknown) =>
          error instanceof ArkTeamError && error.code === "UNSAFE_AGENT_WORKSPACE",
      );
    }
    assert.equal(factory.sessions.length, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-304 fails closed on malformed app-server evidence and unexpected approval", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-protocol-test-"));
  try {
    const malformedFactory = new ScriptedSessionFactory([
      (request, sequence) => ({
        ...completedUpdate(request, sequence),
        sandbox_mode: "workspace-write",
      }),
    ]);
    const malformedLauncher = new ManagedCodexSessionLauncher({
      session_factory: malformedFactory.create,
    });
    await assert.rejects(
      malformedLauncher.run({
        role: "pm",
        assignment: "Return a report.",
        working_directory: temporaryRoot,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "AGENT_SESSION_PROTOCOL_ERROR",
    );

    const workerDirectory = await createLinkedWorktreeFixture(temporaryRoot);
    const approvalFactory = new ScriptedSessionFactory([
      () => ({
        status: "waiting_user",
        session_id: "worker-thread",
        turn_id: "worker-turn",
        role: "worker",
        approval: {
          approval_id: "approval-1",
          kind: "command",
          reason: "interactive approval required",
        },
      }),
    ]);
    const approvalLauncher = new ManagedCodexSessionLauncher({
      session_factory: approvalFactory.create,
    });
    await assert.rejects(
      approvalLauncher.run({
        role: "worker",
        assignment: "Request an interactive action.",
        working_directory: workerDirectory,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "AGENT_SESSION_FAILED",
    );
    assert.equal(approvalFactory.sessions[0]?.closed, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-305 forwards timeout and cancellation to the app-server session", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-timeout-test-"));
  try {
    const timeoutFactory = new ScriptedSessionFactory([
      async () => {
        throw new ArkTeamError(
          "AGENT_SESSION_FAILED",
          "Managed Codex app-server session timed out",
        );
      },
    ]);
    const timeoutLauncher = new ManagedCodexSessionLauncher({
      session_factory: timeoutFactory.create,
      timeout_ms: 5,
    });
    await assert.rejects(
      timeoutLauncher.run({
        role: "pm",
        assignment: "This fake session times out.",
        working_directory: temporaryRoot,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "AGENT_SESSION_FAILED",
    );
    assert.equal(timeoutFactory.options[0]?.timeout_ms, 5);

    const callerAbort = new AbortController();
    const cancellationFactory = new ScriptedSessionFactory([
      async (request) =>
        await new Promise<ApprovalSessionUpdate>((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new ArkTeamError(
                  "AGENT_SESSION_FAILED",
                  "Managed Codex app-server session was cancelled",
                ),
              ),
            { once: true },
          );
        }),
    ]);
    const cancellableLauncher = new ManagedCodexSessionLauncher({
      session_factory: cancellationFactory.create,
    });
    const cancellation = cancellableLauncher.run({
      role: "pm",
      assignment: "This fake session is cancelled by its caller.",
      working_directory: temporaryRoot,
      signal: callerAbort.signal,
    });
    setTimeout(() => callerAbort.abort(new Error("cancel test")), 5);
    await assert.rejects(
      cancellation,
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "AGENT_SESSION_FAILED",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-603 starts and resumes structured PM turns on the same app-server thread", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-resume-test-"));
  try {
    const factory = new ScriptedSessionFactory([
      (request) =>
        completedUpdate(
          request,
          1,
          JSON.stringify(validPmPlan()),
          "pm-thread-1",
        ),
      (request) =>
        completedUpdate(
          request,
          2,
          JSON.stringify(validPmReport()),
          "pm-thread-1",
        ),
    ]);
    const launcher = new ManagedCodexSessionLauncher({
      session_factory: factory.create,
    });

    const planned = await launcher.run({
      role: "pm",
      assignment: "Create a bounded team plan.",
      working_directory: temporaryRoot,
      output_contract: "pm_plan",
    });
    const reported = await launcher.run({
      role: "pm",
      assignment: "Review the completed PL reports.",
      working_directory: temporaryRoot,
      resume_session_id: planned.session_id,
      output_contract: "pm_report",
    });

    assert.equal(planned.structured_report?.kind, "pm_plan");
    assert.equal(reported.structured_report?.kind, "pm_report");
    assert.equal(reported.session_id, planned.session_id);
    assert.equal(factory.requests[0]?.resume_session_id, undefined);
    assert.equal(factory.requests[1]?.resume_session_id, planned.session_id);
    assert.equal(factory.requests[0]?.output_contract, "pm_plan");
    assert.equal(factory.requests[1]?.output_contract, "pm_report");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-604 fails closed on invalid structured or mismatched resumed app-server output", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-structured-fail-"));
  try {
    const unusedFactory = new ScriptedSessionFactory([]);
    const wrongRoleLauncher = new ManagedCodexSessionLauncher({
      session_factory: unusedFactory.create,
    });
    await assert.rejects(
      wrongRoleLauncher.run({
        role: "pm",
        assignment: "Use the wrong contract.",
        working_directory: temporaryRoot,
        output_contract: "worker_report",
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "INVALID_INPUT",
    );
    assert.equal(unusedFactory.sessions.length, 0);

    const malformedFactory = new ScriptedSessionFactory([
      (request, sequence) => completedUpdate(request, sequence, "not-json"),
    ]);
    const malformedLauncher = new ManagedCodexSessionLauncher({
      session_factory: malformedFactory.create,
    });
    await assert.rejects(
      malformedLauncher.run({
        role: "pm",
        assignment: "Return invalid JSON.",
        working_directory: temporaryRoot,
        output_contract: "pm_plan",
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "AGENT_SESSION_PROTOCOL_ERROR",
    );

    const mismatchedFactory = new ScriptedSessionFactory([
      (request, sequence) =>
        completedUpdate(
          request,
          sequence,
          JSON.stringify(validPmReport()),
          "different-thread",
        ),
    ]);
    const mismatchedLauncher = new ManagedCodexSessionLauncher({
      session_factory: mismatchedFactory.create,
    });
    await assert.rejects(
      mismatchedLauncher.run({
        role: "pm",
        assignment: "Resume with mismatched evidence.",
        working_directory: temporaryRoot,
        resume_session_id: "expected-thread",
        output_contract: "pm_report",
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "AGENT_SESSION_PROTOCOL_ERROR",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

type SessionScript = (
  request: ApprovalSessionRequest,
  sequence: number,
) => ApprovalSessionUpdate | Promise<ApprovalSessionUpdate>;

class ScriptedSessionFactory {
  readonly options: ApprovalSessionOptions[] = [];
  readonly requests: ApprovalSessionRequest[] = [];
  readonly sessions: ScriptedSession[] = [];
  private sequence = 0;

  constructor(private readonly scripts: SessionScript[]) {}

  readonly create = (options: ApprovalSessionOptions): ManagedAppServerSession => {
    const script = this.scripts[this.sequence];
    if (!script) {
      throw new Error("No scripted app-server session");
    }
    const session = new ScriptedSession(
      options,
      ++this.sequence,
      script,
      this.requests,
    );
    this.options.push(options);
    this.sessions.push(session);
    return session;
  };
}

class ScriptedSession implements ManagedAppServerSession {
  closed = 0;

  constructor(
    readonly options: ApprovalSessionOptions,
    private readonly sequence: number,
    private readonly script: SessionScript,
    private readonly requests: ApprovalSessionRequest[],
  ) {}

  async start(request: ApprovalSessionRequest): Promise<ApprovalSessionUpdate> {
    this.requests.push(request);
    return await this.script(request, this.sequence);
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function completedUpdate(
  request: ApprovalSessionRequest,
  sequence: number,
  finalReport = `REPORT_session-${sequence}`,
  sessionId = request.resume_session_id ?? `session-${sequence}`,
): ApprovalSessionUpdate {
  const profile = managedRoleProfiles[request.role];
  return {
    status: "completed",
    session_id: sessionId,
    turn_id: `turn-${sequence}`,
    role: request.role,
    agent_name: profile.agent_name,
    model: profile.model,
    model_reasoning_effort: profile.model_reasoning_effort,
    sandbox_mode: profile.sandbox_mode,
    approval_policy: profile.approval_policy,
    final_report: finalReport,
    usage,
  };
}

async function createLinkedWorktreeFixture(root: string): Promise<string> {
  const repository = path.join(root, `repository-${Date.now()}`);
  const worktree = path.join(root, `worker-${Date.now()}`);
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Ark Team Test"]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "ark-team-test@example.invalid",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "commit",
    "--allow-empty",
    "-m",
    "test baseline",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "worktree",
    "add",
    "-b",
    "test/worker",
    worktree,
  ]);
  return worktree;
}

function validPmPlan() {
  return {
    kind: "pm_plan",
    objective: "Deliver one bounded feature.",
    teams: [
      {
        team_id: "team-a",
        mission: "Implement the feature.",
        owned_paths: ["src/feature.ts"],
        dependencies: [],
        acceptance_criteria: ["The requested behavior is implemented."],
        verification: ["Run focused tests."],
        worker_count: 1,
      },
    ],
    integration: {
      strategy: "local_merge",
      acceptance_criteria: ["The integrated branch remains buildable."],
      verification: ["Run the repository tests."],
    },
  };
}

function validPmReport() {
  return {
    kind: "pm_report",
    status: "completed",
    summary: "The bounded feature is complete.",
    teams: [
      {
        team_id: "team-a",
        status: "completed",
        summary: "Team A completed its mission.",
      },
    ],
    integration_verification: [
      {
        name: "repository tests",
        status: "passed",
        evidence: "All focused tests passed.",
      },
    ],
    user_decisions: [],
  };
}
