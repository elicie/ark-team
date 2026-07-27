import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  ManagedAssignmentScheduler,
  type ApprovalSessionHandle,
} from "../src/assignment-scheduler.js";
import type {
  ApprovalDecision,
  ApprovalSessionRequest,
  ApprovalSessionUpdate,
} from "../src/approval-session.js";
import { runEventSchema } from "../src/domain.js";
import { ArkTeamError } from "../src/errors.js";
import { NATIVE_WORKER_MODEL_BINDING } from "../src/provider-types.js";
import { RunStore } from "../src/state-store.js";
import { TeamCoordinator } from "../src/team-coordinator.js";

const execFileAsync = promisify(execFile);
const FIRST_INLINE_CANARY = "inline-canary-first";
const ROTATED_INLINE_CANARY = "inline-canary-rotated";
const usage = {
  input_tokens: 12,
  cached_input_tokens: 2,
  cache_write_input_tokens: 0,
  output_tokens: 4,
  reasoning_output_tokens: 1,
};

test("provider runtime preserves the exact native Luna run snapshot and restores a legacy worker binding", async () => {
  await withTemporaryRoot(async (root) => {
    const projectRoot = path.join(root, "project");
    const stateRoot = path.join(root, "state");
    await mkdir(projectRoot);
    const store = new RunStore({ root_path: stateRoot });
    const nativeRun = await store.createRun({
      objective: "Keep the native worker default",
      project_path: projectRoot,
    });

    assert.deepEqual(
      nativeRun.model_bindings.worker,
      NATIVE_WORKER_MODEL_BINDING,
    );
    assert.deepEqual(nativeRun.model_bindings.worker, {
      schema_version: 1,
      kind: "native",
      provider_id: "openai",
      model: "gpt-5.6-luna",
      requested_reasoning_effort: "xhigh",
      effective_reasoning_effort: "xhigh",
    });

    const legacyRunId = "ark-20260727t120000z-legacy";
    const legacyAssignmentId = "asg-000000000002";
    const legacyParentId = "asg-000000000001";
    const legacyRunDirectory = path.join(stateRoot, legacyRunId);
    await mkdir(legacyRunDirectory, { recursive: true });
    await writeFile(
      path.join(legacyRunDirectory, "run.json"),
      `${JSON.stringify(
        {
          run: {
            schema_version: 1,
            run_id: legacyRunId,
            objective: "Restore a legacy worker binding",
            project_path: projectRoot,
            state: "executing",
            resume_state: null,
            created_at: "2026-07-27T12:00:00.000Z",
            updated_at: "2026-07-27T12:00:00.000Z",
            revision: 1,
            event_count: 0,
            assignment_count: 1,
            team_count: 0,
          },
          events: [],
          assignments: [
            {
              schema_version: 1,
              assignment_id: legacyAssignmentId,
              run_id: legacyRunId,
              team_id: "team-a",
              role: "worker",
              parent_assignment_id: legacyParentId,
              report_target: {
                type: "assignment",
                assignment_id: legacyParentId,
              },
              assignment: "Legacy worker without model_binding",
              working_directory: projectRoot,
              state: "running",
              session_id: null,
              turn_id: null,
              pending_approval: null,
              final_report: null,
              usage: null,
              failure_message: null,
              report_routed_at: null,
              created_at: "2026-07-27T12:00:00.000Z",
              updated_at: "2026-07-27T12:00:00.000Z",
              revision: 1,
            },
          ],
          teams: [],
          plan: null,
          pm_session: null,
          integration: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const reopened = new RunStore({ root_path: stateRoot });
    assert.deepEqual(
      (await reopened.getRun(legacyRunId)).model_bindings.worker,
      NATIVE_WORKER_MODEL_BINDING,
    );
    assert.deepEqual(
      (
        await reopened.getAssignment(
          legacyRunId,
          legacyAssignmentId,
        )
      ).model_binding,
      NATIVE_WORKER_MODEL_BINDING,
    );
  });
});

test("provider runtime copies an explicit external snapshot to workers and audits only safe provider metadata", async () => {
  await withTemporaryRoot(async (root) => {
    const fixture = await createExternalStoreFixture(root);
    const run = await fixture.store.createRun({
      objective: "Persist one external worker selection",
      project_path: fixture.projectRoot,
      model_overrides: externalOverride(),
    });
    assert.equal(run.model_bindings.worker.kind, "external");

    const pl = await fixture.store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Own the external worker",
      working_directory: fixture.projectRoot,
    });
    const worker = await fixture.store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "worker",
      parent_assignment_id: pl.assignment_id,
      assignment: "Use the explicit external binding",
      working_directory: fixture.projectRoot,
    });

    assert.equal(pl.model_binding.kind, "native");
    assert.deepEqual(worker.model_binding, run.model_bindings.worker);
    const bridgeEvent =
      await fixture.store.recordProviderBridgeStarted(
        run.run_id,
        worker.assignment_id,
        10001,
      );
    assert.equal(bridgeEvent.bridge_port, 10001);
    assert.equal(
      bridgeEvent.event_type,
      "assignment.provider_bridge_started",
    );
    assert.equal(
      runEventSchema.safeParse({
        ...bridgeEvent,
        api_key: FIRST_INLINE_CANARY,
      }).success,
      false,
    );
    const logs = await fixture.store.getLogs(run.run_id, { limit: 100 });
    const selected = logs.events.find(
      (event) => event.event_type === "assignment.provider_selected",
    );
    assert.notEqual(selected, undefined);
    assert.equal(selected?.provider_id, "fake_provider");
    assert.equal(selected?.app_server_provider_id, "ark_fake_provider");
    assert.equal(selected?.model, "fake-model");
    assert.equal(selected?.effective_reasoning_effort, "high");
    assert.equal(
      logs.events.find(
        (event) =>
          event.event_type ===
          "assignment.provider_bridge_started",
      )?.bridge_port,
      10001,
    );

    const persistedText = await readFile(
      path.join(fixture.stateRoot, run.run_id, "run.json"),
      "utf8",
    );
    const observable = JSON.stringify({
      run,
      worker,
      logs,
      persistedText,
    });
    assert.doesNotMatch(observable, new RegExp(FIRST_INLINE_CANARY));
    assert.doesNotMatch(observable, /api_key/i);
  });
});

test("provider runtime accepts inline key rotation and pauses before session start on non-secret drift", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "worker");
    await createLinkedWorktree(repository, worktree);
    const fixture = await createExternalStoreFixture(root, repository);
    const run = await fixture.store.createRun({
      objective: "Check provider drift before launch",
      project_path: repository,
      model_overrides: externalOverride(),
    });
    const pl = await fixture.store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Own drift-check workers",
      working_directory: worktree,
    });

    await writeCatalog(
      fixture.catalogPath,
      ROTATED_INLINE_CANARY,
      "https://api.example.invalid/v1",
    );
    const requests: ApprovalSessionRequest[] = [];
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      provider_environment: fixture.environment,
      session_factory: () => new CompletedExternalSession(requests),
    });
    const completed = await scheduler.start({
      run_id: run.run_id,
      team_id: "team-a",
      role: "worker",
      parent_assignment_id: pl.assignment_id,
      assignment: "Start after a key-only rotation",
      working_directory: worktree,
    });
    assert.equal(completed.state, "completed");
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0]?.model_binding,
      run.model_bindings.worker,
    );

    await writeCatalog(
      fixture.catalogPath,
      ROTATED_INLINE_CANARY,
      "https://changed.example.invalid/v1",
    );
    await assert.rejects(
      scheduler.start({
        run_id: run.run_id,
        team_id: "team-a",
        role: "worker",
        parent_assignment_id: pl.assignment_id,
        assignment: "Do not start after non-secret drift",
        working_directory: worktree,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "PROVIDER_CONFIG_DRIFT",
    );
    assert.equal(requests.length, 1);
    assert.equal((await fixture.store.getRun(run.run_id)).state, "paused");

    const persisted = await readFile(
      path.join(fixture.stateRoot, run.run_id, "run.json"),
      "utf8",
    );
    assert.doesNotMatch(persisted, new RegExp(FIRST_INLINE_CANARY));
    assert.doesNotMatch(persisted, new RegExp(ROTATED_INLINE_CANARY));
  });
});

test("provider runtime applies three external retries without falling back to Luna", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "worker");
    await createLinkedWorktree(repository, worktree);
    const fixture = await createExternalStoreFixture(root, repository);
    const run = await fixture.store.createRun({
      objective: "Exhaust the external provider retry budget",
      project_path: repository,
      model_overrides: externalOverride(),
    });
    const pl = await fixture.store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Own one repeatedly failing worker",
      working_directory: worktree,
    });
    const requests: ApprovalSessionRequest[] = [];
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      provider_environment: fixture.environment,
      session_factory: () => new FailingExternalSession(requests),
    });

    await assert.rejects(
      scheduler.start({
        run_id: run.run_id,
        team_id: "team-a",
        role: "worker",
        parent_assignment_id: pl.assignment_id,
        assignment: "Fail through the external retry budget",
        working_directory: worktree,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "AGENT_SESSION_FAILED",
    );

    const result = await new TeamCoordinator(
      fixture.store,
      scheduler,
    ).advance(run.run_id);
    const worker = result.assignments.find(
      (assignment) => assignment.role === "worker",
    );
    assert.equal(requests.length, 4);
    assert.equal(worker?.session_attempt_count, 4);
    assert.equal(worker?.state, "waiting_user");
    assert.equal(worker?.pending_retry?.mode, "fresh_session");
    assert.match(
      worker?.pending_retry?.reason ?? "",
      /exhausted 3 automatic external provider retries/,
    );
    assert.equal(result.waiting_retries, 1);
    assert.equal(result.run.model_bindings.worker.kind, "external");
    for (const request of requests) {
      assert.equal(request.model_binding?.kind, "external");
      assert.equal(request.model_binding?.model, "fake-model");
      assert.notEqual(request.model_binding?.model, "gpt-5.6-luna");
    }
  });
});

test("provider runtime retries actual bridge transport and response failures with the same binding", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "worker");
    const executable = path.join(root, "fake-codex-bridge-failure.mjs");
    const observationsPath = path.join(root, "bridge-attempts.jsonl");
    await createLinkedWorktree(repository, worktree);
    await writeFile(
      executable,
      bridgeFailureCodexSource(observationsPath),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    const fixture = await createExternalStoreFixture(root, repository);
    const run = await fixture.store.createRun({
      objective: "Retry real provider bridge transport failures",
      project_path: repository,
      model_overrides: externalOverride(),
    });
    const pl = await fixture.store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Own one bridge-failing worker",
      working_directory: worktree,
    });
    let upstreamAttempt = 0;
    const providerFetch = (async () => {
      upstreamAttempt += 1;
      if (upstreamAttempt % 2 === 1) {
        throw new Error("simulated upstream transport failure");
      }
      return new Response("{invalid upstream response", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }) as typeof fetch;
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      codex_path: executable,
      provider_environment: fixture.environment,
      provider_fetch: providerFetch,
    });

    await assert.rejects(
      scheduler.start({
        run_id: run.run_id,
        team_id: "team-a",
        role: "worker",
        parent_assignment_id: pl.assignment_id,
        assignment: "Fail through the real bridge transport path",
        working_directory: worktree,
      }),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "PROVIDER_BRIDGE_UNAVAILABLE",
    );

    const result = await new TeamCoordinator(
      fixture.store,
      scheduler,
    ).advance(run.run_id);
    const worker = result.assignments.find(
      (assignment) => assignment.role === "worker",
    );
    assert.equal(worker?.session_attempt_count, 4);
    assert.equal(worker?.state, "waiting_user");
    assert.equal(worker?.pending_retry?.mode, "fresh_session");
    assert.deepEqual(worker?.model_binding, run.model_bindings.worker);
    assert.match(
      worker?.pending_retry?.reason ?? "",
      /exhausted 3 automatic external provider retries/,
    );

    const attempts = (await readFile(observationsPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            model: string;
            modelProvider: string;
            reasoningEffort: string;
          },
      );
    assert.equal(attempts.length, 4);
    for (const attempt of attempts) {
      assert.deepEqual(attempt, {
        model: "fake-model",
        modelProvider: "ark_fake_provider",
        reasoningEffort: "high",
      });
    }

    const events = (
      await fixture.store.getLogs(run.run_id, { limit: 200 })
    ).events;
    assert.equal(
      events.filter(
        (event) =>
          event.event_type === "assignment.failed" &&
          event.provider_error_code ===
            "PROVIDER_BRIDGE_UNAVAILABLE",
      ).length,
      2,
    );
    assert.equal(
      events.filter(
        (event) =>
          event.event_type === "assignment.failed" &&
          event.provider_error_code ===
            "PROVIDER_RESPONSE_INVALID",
      ).length,
      2,
    );
    assert.equal(
      events.filter(
        (event) => event.event_type === "assignment.retrying",
      ).length,
      3,
    );
  });
});

test("provider runtime closes and fails an external approval session after its persisted child exits", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "worker");
    const executable = path.join(root, "fake-codex-approval-exit.mjs");
    const exitTrigger = path.join(root, "exit-app-server");
    await createLinkedWorktree(repository, worktree);
    await writeFile(
      executable,
      approvalExitCodexSource(exitTrigger),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    const fixture = await createExternalStoreFixture(root, repository);
    const run = await fixture.store.createRun({
      objective: "Fail a persisted external approval when its child exits",
      project_path: repository,
      model_overrides: externalOverride(),
    });
    const pl = await fixture.store.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Own one external approval-gated worker",
      working_directory: worktree,
    });
    const scheduler = new ManagedAssignmentScheduler(fixture.store, {
      codex_path: executable,
      provider_environment: fixture.environment,
    });

    const waiting = await scheduler.start({
      run_id: run.run_id,
      team_id: "team-a",
      role: "worker",
      parent_assignment_id: pl.assignment_id,
      assignment: "Wait for one external approval",
      working_directory: worktree,
    });
    assert.equal(waiting.state, "waiting_user");
    assert.equal(scheduler.hasLiveSession(waiting.assignment_id), true);
    const startedEvents = (
      await fixture.store.getLogs(run.run_id, { limit: 200 })
    ).events;
    assert.equal(startedEvents.at(-1)?.event_type, "assignment.waiting_user");
    const bridgePort = startedEvents.find(
      (event) =>
        event.event_type === "assignment.provider_bridge_started",
    )?.bridge_port;
    assert.equal(typeof bridgePort, "number");

    await writeFile(exitTrigger, "exit\n", "utf8");
    const failed = await waitForFailedAssignment(
      fixture.store,
      run.run_id,
      waiting.assignment_id,
    );
    assert.match(failed.failure_message ?? "", /connection failed/i);
    assert.equal(scheduler.hasLiveSession(waiting.assignment_id), false);

    const finalEvents = (
      await fixture.store.getLogs(run.run_id, { limit: 200 })
    ).events;
    assert.deepEqual(
      finalEvents
        .filter((event) =>
          event.event_type === "assignment.waiting_user" ||
          event.event_type === "assignment.failed"
        )
        .map((event) => event.event_type),
      ["assignment.waiting_user", "assignment.failed"],
    );
    assert.equal(
      finalEvents.find(
        (event) => event.event_type === "assignment.failed",
      )?.provider_error_code,
      "AGENT_SESSION_FAILED",
    );
    if (typeof bridgePort === "number") {
      await assert.rejects(
        fetch(`http://127.0.0.1:${bridgePort}/responses`, {
          signal: AbortSignal.timeout(250),
        }),
      );
    }
  });
});

test("provider runtime scrubs catalog credentials from a native PL child in an external-worker run", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "pl");
    const executable = path.join(root, "fake-codex-native-pl.mjs");
    const observationsPath = path.join(root, "native-pl-environment.json");
    const providerEnvironmentName =
      "ARK_TEAM_PROVIDER_RUNTIME_CATALOG_KEY";
    await createLinkedWorktree(repository, worktree);
    await writeFile(
      executable,
      approvalCaptureCodexSource(
        observationsPath,
        providerEnvironmentName,
      ),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    const fixture = await createExternalStoreFixture(root, repository);
    await writeCatalog(
      fixture.catalogPath,
      FIRST_INLINE_CANARY,
      "https://api.example.invalid/v1",
      providerEnvironmentName,
    );
    const previousEnvironment = {
      catalog: process.env.ARK_TEAM_PROVIDER_CONFIG,
      provider: process.env[providerEnvironmentName],
      zai: process.env.ZAI_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    };
    process.env.ARK_TEAM_PROVIDER_CONFIG = fixture.catalogPath;
    process.env[providerEnvironmentName] =
      "catalog-provider-key-canary";
    process.env.ZAI_API_KEY = "forwarded-zai-key-canary";
    process.env.OPENAI_API_KEY = "native-openai-key-canary";

    try {
      const run = await fixture.store.createRun({
        objective: "Keep external provider credentials out of native PL",
        project_path: repository,
        model_overrides: externalOverride(),
      });
      const scheduler = new ManagedAssignmentScheduler(fixture.store, {
        codex_path: executable,
        provider_environment: fixture.environment,
      });

      const waiting = await scheduler.start({
        run_id: run.run_id,
        team_id: "team-a",
        role: "pl",
        assignment: "Wait while the child environment is inspected",
        working_directory: worktree,
      });
      assert.equal(waiting.state, "waiting_user");
      assert.equal(waiting.model_binding.kind, "native");
      assert.deepEqual(
        JSON.parse(await readFile(observationsPath, "utf8")),
        {
          providerCatalog: null,
          catalogKey: null,
          zaiKey: null,
          nativeOpenAiKey: "native-openai-key-canary",
        },
      );

      await scheduler.cancel(
        run.run_id,
        waiting.assignment_id,
        "native PL environment verified",
      );
    } finally {
      restoreEnvironment(
        "ARK_TEAM_PROVIDER_CONFIG",
        previousEnvironment.catalog,
      );
      restoreEnvironment(
        providerEnvironmentName,
        previousEnvironment.provider,
      );
      restoreEnvironment("ZAI_API_KEY", previousEnvironment.zai);
      restoreEnvironment("OPENAI_API_KEY", previousEnvironment.openai);
    }
  });
});

class CompletedExternalSession implements ApprovalSessionHandle {
  constructor(private readonly requests: ApprovalSessionRequest[]) {}

  async start(
    request: ApprovalSessionRequest,
  ): Promise<ApprovalSessionUpdate> {
    this.requests.push(request);
    return {
      status: "completed",
      session_id: "external-session",
      turn_id: "external-turn",
      role: "worker",
      agent_name: "ark_worker",
      model: request.model_binding?.model ?? "unexpected-native-model",
      model_reasoning_effort:
        request.model_binding?.effective_reasoning_effort ??
        "unexpected-native-effort",
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
      final_report: "EXTERNAL_SESSION_COMPLETE",
      usage,
    };
  }

  async decide(
    _approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    throw new Error("No approval is expected");
  }

  async close(): Promise<void> {}
}

class FailingExternalSession implements ApprovalSessionHandle {
  constructor(private readonly requests: ApprovalSessionRequest[]) {}

  async start(
    request: ApprovalSessionRequest,
  ): Promise<ApprovalSessionUpdate> {
    this.requests.push(request);
    throw new ArkTeamError(
      "AGENT_SESSION_FAILED",
      "simulated external provider failure",
    );
  }

  async decide(
    _approvalId: string,
    _decision: ApprovalDecision,
  ): Promise<ApprovalSessionUpdate> {
    throw new Error("No approval is expected");
  }

  async close(): Promise<void> {}
}

function bridgeFailureCodexSource(
  observationsPath: string,
): string {
  return `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

function configValue(field) {
  const prefix = "." + field + "=";
  const entry = process.argv.find((value) => value.includes(prefix));
  if (!entry) {
    throw new Error("missing external provider " + field);
  }
  return JSON.parse(entry.slice(entry.indexOf(prefix) + prefix.length));
}

const bridgeBaseUrl = configValue("base_url");
const bridgeTokenEnvironment = configValue("env_key");
const bridgeToken = process.env[bridgeTokenEnvironment];
const observationsPath = ${JSON.stringify(observationsPath)};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {});
    return;
  }
  if (request.method === "initialized") {
    return;
  }
  if (request.method === "thread/start") {
    const params = request.params;
    appendFileSync(
      observationsPath,
      JSON.stringify({
        model: params.model,
        modelProvider: params.modelProvider,
        reasoningEffort: params.config.model_reasoning_effort,
      }) + "\\n",
    );
    respond(request.id, {
      thread: { id: "bridge-failure-thread" },
      model: params.model,
      modelProvider: params.modelProvider,
      cwd: params.cwd,
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [params.cwd],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
      },
      reasoningEffort: params.config.model_reasoning_effort,
    });
    return;
  }
  if (request.method === "turn/start") {
    respond(request.id, { turn: { id: "bridge-failure-turn" } });
    void fetch(bridgeBaseUrl + "/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + bridgeToken,
      },
      body: JSON.stringify({
        model: request.params.model,
        input: "Trigger the deterministic transport failure.",
        stream: false,
        reasoning: { effort: request.params.effort },
      }),
    }).then(async (response) => {
      await response.text();
      process.exit(31);
    }).catch(() => process.exit(32));
  }
});
`;
}

function approvalExitCodexSource(exitTrigger: string): string {
  return `#!${process.execPath}
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const exitTrigger = ${JSON.stringify(exitTrigger)};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {});
    return;
  }
  if (request.method === "initialized") {
    return;
  }
  if (request.method === "thread/start") {
    const params = request.params;
    respond(request.id, {
      thread: { id: "approval-exit-thread" },
      model: params.model,
      modelProvider: params.modelProvider,
      cwd: params.cwd,
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [params.cwd],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false,
      },
      reasoningEffort: params.config.model_reasoning_effort,
    });
    return;
  }
  if (request.method === "turn/start") {
    const params = request.params;
    respond(request.id, { turn: { id: "approval-exit-turn" } });
    process.stdout.write(JSON.stringify({
      id: 71,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "approval-exit-thread",
        turnId: "approval-exit-turn",
        itemId: "approval-exit-command",
        reason: "wait for a user decision",
        command: "touch outside",
        cwd: params.cwd,
      },
    }) + "\\n");
  }
});

setInterval(() => {
  if (existsSync(exitTrigger)) {
    process.exit(37);
  }
}, 5);
`;
}

function approvalCaptureCodexSource(
  observationsPath: string,
  providerEnvironmentName: string,
): string {
  return `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const observationsPath = ${JSON.stringify(observationsPath)};
const providerEnvironmentName = ${JSON.stringify(providerEnvironmentName)};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {});
    return;
  }
  if (request.method === "initialized") {
    return;
  }
  if (request.method === "thread/start") {
    const params = request.params;
    writeFileSync(
      observationsPath,
      JSON.stringify({
        providerCatalog: process.env.ARK_TEAM_PROVIDER_CONFIG ?? null,
        catalogKey: process.env[providerEnvironmentName] ?? null,
        zaiKey: process.env.ZAI_API_KEY ?? null,
        nativeOpenAiKey: process.env.OPENAI_API_KEY ?? null,
      }),
    );
    respond(request.id, {
      thread: { id: "native-pl-environment-thread" },
      model: params.model,
      modelProvider: params.modelProvider ?? "openai",
      cwd: params.cwd,
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [params.cwd],
        networkAccess: false,
      },
      reasoningEffort: params.config.model_reasoning_effort,
    });
    return;
  }
  if (request.method === "turn/start") {
    const params = request.params;
    respond(request.id, { turn: { id: "native-pl-environment-turn" } });
    process.stdout.write(JSON.stringify({
      id: 72,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "native-pl-environment-thread",
        turnId: "native-pl-environment-turn",
        itemId: "native-pl-environment-command",
        reason: "wait for environment verification",
        command: "touch outside",
        cwd: params.cwd,
      },
    }) + "\\n");
  }
});
`;
}

interface ExternalStoreFixture {
  store: RunStore;
  stateRoot: string;
  projectRoot: string;
  catalogPath: string;
  environment: NodeJS.ProcessEnv;
}

async function createExternalStoreFixture(
  root: string,
  existingProjectRoot?: string,
): Promise<ExternalStoreFixture> {
  const stateRoot = path.join(root, "state");
  const projectRoot = existingProjectRoot ?? path.join(root, "project");
  if (existingProjectRoot === undefined) {
    await mkdir(projectRoot);
  }
  const catalogPath = path.join(root, "providers.toml");
  await writeCatalog(
    catalogPath,
    FIRST_INLINE_CANARY,
    "https://api.example.invalid/v1",
  );
  const environment: NodeJS.ProcessEnv = {
    ARK_TEAM_PROVIDER_CONFIG: catalogPath,
  };
  return {
    store: new RunStore({
      root_path: stateRoot,
      environment,
    }),
    stateRoot,
    projectRoot,
    catalogPath,
    environment,
  };
}

function externalOverride() {
  return {
    worker: {
      provider: "fake_provider",
      model: "fake-model",
      reasoning_effort: "xhigh" as const,
    },
  };
}

async function writeCatalog(
  catalogPath: string,
  apiKey: string,
  baseUrl: string,
  additionalEnvironmentName?: string,
): Promise<void> {
  await writeFile(
    catalogPath,
    [
      "version = 1",
      "",
      "[providers.fake_provider]",
      'adapter = "builtin:openai-chat"',
      `base_url = ${JSON.stringify(baseUrl)}`,
      'auth_kind = "inline_key"',
      `api_key = ${JSON.stringify(apiKey)}`,
      'structured_output_mode = "validated_json"',
      'policy = "standard"',
      'allowed_models = ["fake-model"]',
      "",
      "[providers.fake_provider.reasoning_effort_map]",
      'xhigh = "high"',
      "",
      ...(additionalEnvironmentName === undefined
        ? []
        : [
            "[providers.environment_provider]",
            'adapter = "builtin:openai-chat"',
            'base_url = "https://env.example.invalid/v1"',
            'auth_kind = "env_key"',
            `api_key_env = ${JSON.stringify(additionalEnvironmentName)}`,
            'structured_output_mode = "validated_json"',
            'policy = "standard"',
            'allowed_models = ["environment-model"]',
            "",
            "[providers.environment_provider.reasoning_effort_map]",
            'xhigh = "high"',
            "",
          ]),
    ].join("\n"),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

function restoreEnvironment(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function createLinkedWorktree(
  repository: string,
  worktree: string,
): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.name",
    "Ark Team Test",
  ]);
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
    "baseline",
  ]);
  await execFileAsync("git", [
    "-C",
    repository,
    "worktree",
    "add",
    "-b",
    "test/provider-runtime",
    worktree,
  ]);
}

async function waitForFailedAssignment(
  store: RunStore,
  runId: string,
  assignmentId: string,
) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const assignment = await store.getAssignment(runId, assignmentId);
    if (assignment.state === "failed") {
      return assignment;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for the external assignment to fail");
}

async function withTemporaryRoot(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-provider-runtime-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
