import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type { ThreadOptions, Usage } from "@openai/codex-sdk";

import { ArkTeamError } from "../src/errors.js";
import {
  ManagedCodexSessionLauncher,
  managedCodexConfig,
  managedRoleProfiles,
  type CodexSessionClient,
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

test("TEST-302 starts independent PM and worker threads and returns report plus usage only", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-managed-test-"));
  try {
    const workerDirectory = await createLinkedWorktreeFixture(temporaryRoot);
    const client = new FakeCodexClient();
    const launcher = new ManagedCodexSessionLauncher({ client });

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
    assert.deepEqual(client.options, [
      {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "xhigh",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        workingDirectory: temporaryRoot,
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      },
      {
        model: "gpt-5.6-luna",
        modelReasoningEffort: "xhigh",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        workingDirectory: workerDirectory,
        skipGitRepoCheck: false,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      },
    ]);
    assert.match(client.prompts[0] ?? "", /Role: ark_pm/);
    assert.match(client.prompts[0] ?? "", /Do not spawn native subagents/);
    assert.match(client.prompts[1] ?? "", /Role: ark_worker/);
    assert.deepEqual(pm.usage, usage);
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
    const client = new FakeCodexClient();
    const launcher = new ManagedCodexSessionLauncher({ client });

    await assert.rejects(
      launcher.run({
        role: "pl",
        assignment: "Do not run this assignment.",
        working_directory: temporaryRoot,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "UNSAFE_AGENT_WORKSPACE",
    );
    assert.equal(client.options.length, 0);

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
    assert.equal(client.options.length, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-304 fails closed when the SDK omits required session evidence", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-protocol-test-"));
  try {
    const client: CodexSessionClient = {
      startThread: () => ({
        id: null,
        async run() {
          return {
            finalResponse: "",
            usage: null,
          };
        },
      }),
    };
    const launcher = new ManagedCodexSessionLauncher({ client });

    await assert.rejects(
      launcher.run({
        role: "pm",
        assignment: "Return a report.",
        working_directory: temporaryRoot,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "AGENT_SESSION_PROTOCOL_ERROR",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("TEST-305 aborts an over-time session and reports a closed failure", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-timeout-test-"));
  try {
    const client: CodexSessionClient = {
      startThread: () => ({
        id: "session-timeout",
        run: async (_prompt, options) =>
          await new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            );
          }),
      }),
    };
    const launcher = new ManagedCodexSessionLauncher({
      client,
      timeout_ms: 5,
    });

    await assert.rejects(
      launcher.run({
        role: "pm",
        assignment: "This fake session never completes.",
        working_directory: temporaryRoot,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "AGENT_SESSION_FAILED",
    );

    const callerAbort = new AbortController();
    const cancellableLauncher = new ManagedCodexSessionLauncher({
      client,
      timeout_ms: 1000,
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

async function createLinkedWorktreeFixture(root: string): Promise<string> {
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worker");
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

class FakeCodexClient implements CodexSessionClient {
  readonly options: ThreadOptions[] = [];
  readonly prompts: string[] = [];
  private sequence = 0;

  startThread(options: ThreadOptions) {
    this.options.push(options);
    const sessionId = `session-${++this.sequence}`;
    return {
      id: sessionId,
      run: async (prompt: string) => {
        this.prompts.push(prompt);
        return {
          finalResponse: `REPORT_${sessionId}`,
          usage,
          items: [{ type: "reasoning", text: "must not escape" }],
        };
      },
    };
  }
}
