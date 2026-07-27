import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { RunRecord } from "../src/domain.js";
import { ArkTeamError } from "../src/errors.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  sha256CanonicalJson,
  type VerificationActionKind,
  type VerificationLaneDecisionInput,
  type VerificationLinkedRecord,
  type VerificationOutcome,
  type VerificationRunSnapshot,
} from "../src/verification-contract.js";
import { VerificationCoordinator } from "../src/verification-coordinator.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const CREATED_AT = "2026-07-27T19:00:00.000Z";
const REQUEST_SHA = "c".repeat(64);
const RESPONSE_SHA = "d".repeat(64);

type LaneMode = "backend-only" | "ui-only" | "both";

interface CoordinatorFixture {
  store: RunStore;
  coordinator: VerificationCoordinator;
  run_id: string;
  state_root: string;
  project_root: string;
}

test("TEST-1703 accepts only the closed lifecycle and persists one terminal report", async (t) => {
  const fixture = await createFixture(t, "both");

  const capabilities = await fixture.coordinator.advance(
    fixture.run_id,
    "capabilities",
  );
  assert.equal(capabilities.accepted, true);
  assert.equal(capabilities.run.verification_state?.current_state, "capabilities");

  const replay = await fixture.coordinator.advance(
    fixture.run_id,
    "capabilities",
  );
  assert.equal(replay.accepted, false);
  assert.equal(replay.run.verification_state?.current_state, "capabilities");
  assert.equal(replay.error_record?.payload.kind, "error");
  if (replay.error_record?.payload.kind === "error") {
    assert.equal(replay.error_record.payload.code, "INVALID_RECORD");
  }

  await completeReadiness(fixture);
  for (const stage of ["ready", "executing"] as const) {
    const transition = await fixture.coordinator.advance(fixture.run_id, stage);
    assert.equal(transition.accepted, true, stage);
    assert.equal(transition.run.verification_state?.current_state, stage);
  }

  const lanes = await submitLaneEvidence(fixture, {
    backend: "passed",
    ui: "passed",
  });
  for (const stage of ["collecting", "deciding"] as const) {
    const transition = await fixture.coordinator.advance(fixture.run_id, stage);
    assert.equal(transition.accepted, true, stage);
    assert.equal(transition.run.verification_state?.current_state, stage);
  }
  const forged = structuredClone(lanes);
  forged[0]!.checks[0]!.outcome = "failed";
  const rejectedDecision = await fixture.coordinator.finalize(
    fixture.run_id,
    forged,
  );
  assert.equal(
    rejectedDecision.verification_state?.current_state,
    "deciding",
  );
  assert.equal(terminalOutcome(rejectedDecision), undefined);
  assert.equal(
    rejectedDecision.verification_records.at(-1)?.payload.kind,
    "error",
  );
  const terminal = await fixture.coordinator.finalize(fixture.run_id, lanes);
  assert.equal(terminal.verification_state?.current_state, "passed");
  assert.equal(terminal.verification_state?.terminal_outcome, "passed");
  assert.equal(
    terminal.verification_records.filter(
      (record) => record.payload.kind === "report",
    ).length,
    1,
  );

  const duplicate = await fixture.coordinator.finalize(fixture.run_id, lanes);
  assert.equal(duplicate.verification_state?.terminal_outcome, "passed");
  assert.equal(
    duplicate.verification_records.filter(
      (record) => record.payload.kind === "report",
    ).length,
    1,
  );
  assert.equal(duplicate.verification_records.at(-1)?.payload.kind, "error");
});

test("TEST-1703 covers terminal branches and rejects incomplete PM handoff", async (t) => {
  for (const outcome of [
    "passed",
    "failed",
    "unavailable",
    "error",
  ] as const) {
    const fixture = await createFixture(t, "backend-only");
    const outOfOrder = await fixture.coordinator.advance(
      fixture.run_id,
      "ready",
    );
    assert.equal(outOfOrder.accepted, false, outcome);
    assert.equal(
      outOfOrder.run.verification_state?.current_state,
      "snapshotted",
    );
    await advanceToExecuting(fixture);
    const lanes = await submitLaneEvidence(fixture, { backend: outcome });
    await advanceToDeciding(fixture);
    const terminal = await fixture.coordinator.finalize(
      fixture.run_id,
      lanes,
    );
    assert.equal(terminalOutcome(terminal), outcome);
    assert.equal(terminal.verification_state?.terminal_outcome, outcome);
    if (outcome === "passed") {
      const pending = await fixture.coordinator.advance(
        fixture.run_id,
        "pm_review_pending",
      );
      assert.equal(pending.accepted, false);
      assert.equal(
        pending.run.verification_state?.current_state,
        "passed",
      );
      assert.equal(pending.error_record?.payload.kind, "error");
      if (pending.error_record?.payload.kind === "error") {
        assert.equal(pending.error_record.payload.code, "INVALID_RECORD");
      }
    }
  }
});

test("TEST-1707 gives adapters frozen inputs and rejects coordinator-owned records", async (t) => {
  const fixture = await createFixture(t, "both");
  assert.equal(
    (await fixture.coordinator.advance(fixture.run_id, "capabilities"))
      .accepted,
    true,
  );
  const undeclaredCapability = adapterRecord(
    await fixture.store.getRun(fixture.run_id),
    "backend-ui-capability",
    "capability",
    {
      kind: "capability",
      capability: "browser",
      available: true,
      version: "1.0.0",
      diagnostic: "browser available",
    },
    "backend",
    null,
    { name: "capability-probe", version: "1.0.0" },
  );
  await assert.rejects(
    () =>
      fixture.coordinator.submitAdapterRecord(
        fixture.run_id,
        undeclaredCapability,
      ),
    isArkError("INVALID_RECORD"),
  );
  await completeReadiness(fixture);
  for (const stage of ["ready", "executing"] as const) {
    assert.equal(
      (await fixture.coordinator.advance(fixture.run_id, stage)).accepted,
      true,
    );
  }
  const before = await fixture.store.getRun(fixture.run_id);
  const snapshotBefore = sha256CanonicalJson(before.verification_snapshot);

  const mutatedSnapshot = await fixture.coordinator.runAction(fixture.run_id, {
    action_id: "mutate-snapshot-root",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: { path: "/" },
    adapter: async (context) => {
      assert.deepEqual(Object.keys(context).sort(), [
        "input",
        "signal",
        "snapshot",
        "submit",
      ]);
      for (const coordinatorApi of [
        "advance",
        "configure",
        "finalize",
        "recordVerificationSnapshot",
        "finalizeVerification",
        "writeArtifact",
        "store",
      ]) {
        assert.equal(coordinatorApi in context, false, coordinatorApi);
      }
      await assert.rejects(
        () =>
          fixture.store.advanceVerificationState(
            fixture.run_id,
            "collecting",
          ),
        isArkError("INVALID_TRANSITION"),
      );
      await assert.rejects(
        () =>
          fixture.store.writeVerificationArtifact(fixture.run_id, {
            artifact_id: "captured-store-write",
            relative_path: "evidence/captured-store.json",
            media_type: "application/json",
            bytes: new TextEncoder().encode("{}"),
            sha256: "0".repeat(64),
            lane: null,
          }),
        isArkError("INVALID_TRANSITION"),
      );
      const { snapshot } = context;
      const mutable = snapshot as unknown as { artifact_root: string };
      mutable.artifact_root = "/tmp/adapter-owned-root";
      return { ok: true, value: "unreachable" };
    },
  });
  assert.equal(mutatedSnapshot.ok, false);
  if (!mutatedSnapshot.ok) {
    assert.equal(mutatedSnapshot.code, "INVALID_RECORD");
  }

  const mutatedInput = await fixture.coordinator.runAction(fixture.run_id, {
    action_id: "mutate-action-input",
    kind: "browser",
    lane: "ui",
    check_id: "home-browser",
    input: { request: { path: "/" } },
    adapter: async ({ input }) => {
      const mutable = input as unknown as { request: { path: string } };
      mutable.request.path = "/changed";
      return { ok: true, value: "unreachable" };
    },
  });
  assert.equal(mutatedInput.ok, false);
  if (!mutatedInput.ok) {
    assert.equal(mutatedInput.code, "INVALID_RECORD");
  }

  const after = await fixture.store.getRun(fixture.run_id);
  assert.equal(sha256CanonicalJson(after.verification_snapshot), snapshotBefore);
  assert.equal(
    after.verification_snapshot?.artifact_root,
    before.verification_snapshot?.artifact_root,
  );
  const forgedEnvelope = {
    ...requestRecord(after, "adapter-forged-envelope"),
    run_id: "ark-20260727t000000z-999999",
    case_id: "forged-case",
    snapshot_id: "forged-snapshot",
    stage: "deciding" as const,
    source_fingerprint: "0".repeat(64),
    package_fingerprint: "0".repeat(64),
    lane_required: false,
    check_required: false,
    previous_record_sha256: "0".repeat(64),
    payload_sha256: "0".repeat(64),
  } as VerificationLinkedRecord;
  assert.equal(
    await fixture.coordinator.submitAdapterRecord(
      fixture.run_id,
      forgedEnvelope,
    ),
    forgedEnvelope.record_id,
  );
  const normalized = (
    await fixture.store.getRun(fixture.run_id)
  ).verification_records.at(-1);
  assert.equal(normalized?.run_id, fixture.run_id);
  assert.equal(normalized?.stage, "executing");
  if (normalized?.schema_version === 2) {
    assert.equal(normalized.lane_required, true);
    assert.equal(normalized.check_required, true);
    assert.notEqual(normalized.previous_record_sha256, "0".repeat(64));
    assert.notEqual(normalized.payload_sha256, "0".repeat(64));
  }

  const reportPayload = {
    kind: "report" as const,
    outcome: "passed" as const,
    evidence_record_ids: [],
  };
  const report = adapterRecord(
    await fixture.store.getRun(fixture.run_id),
    "adapter-forged-report",
    "report",
    reportPayload,
    null,
    null,
  );
  await assert.rejects(
    () => fixture.coordinator.submitAdapterRecord(fixture.run_id, report),
    isArkError("INVALID_RECORD"),
  );
  const persisted = await fixture.store.getRun(fixture.run_id);
  assert.equal(
    persisted.verification_records.some(
      (record) => record.record_id === "adapter-forged-report",
    ),
    false,
  );
});

test("TEST-1708 enforces every exact action-attempt ceiling", async (t) => {
  const cases: Array<{
    kind: Exclude<VerificationActionKind, "cleanup">;
    max_attempts: 1 | 2;
    lane: "backend" | "ui" | null;
    check_id: string | null;
    include_agentic?: boolean;
  }> = [
    {
      kind: "readiness",
      max_attempts: 2,
      lane: null,
      check_id: null,
    },
    {
      kind: "api",
      max_attempts: 2,
      lane: "backend",
      check_id: "home-api",
    },
    {
      kind: "browser",
      max_attempts: 2,
      lane: "ui",
      check_id: "home-browser",
    },
    {
      kind: "agentic_browser",
      max_attempts: 1,
      lane: "ui",
      check_id: "home-agentic",
      include_agentic: true,
    },
    {
      kind: "screenshot",
      max_attempts: 1,
      lane: "ui",
      check_id: "home-browser",
    },
    {
      kind: "semantic_review",
      max_attempts: 1,
      lane: "ui",
      check_id: "home-browser",
    },
    {
      kind: "comparison",
      max_attempts: 1,
      lane: "ui",
      check_id: "home-browser",
    },
    {
      kind: "artifact_write",
      max_attempts: 1,
      lane: null,
      check_id: null,
    },
  ];

  for (const actionCase of cases) {
    const fixture = await createFixture(
      t,
      "both",
      true,
      actionCase.include_agentic ?? false,
    );
    await advanceToActionStage(fixture, actionCase.kind);
    let calls = 0;
    const actionId = `ceiling-${actionCase.kind}`;
    const result = await fixture.coordinator.runAction(fixture.run_id, {
      action_id: actionId,
      kind: actionCase.kind,
      lane: actionCase.lane,
      check_id: actionCase.check_id,
      input: { kind: actionCase.kind },
      adapter: async () => {
        calls += 1;
        return {
          ok: false,
          code:
            actionCase.kind === "artifact_write"
              ? "ARTIFACT_ROOT_INVALID"
              : "TIMEOUT",
          message:
            actionCase.kind === "artifact_write"
              ? `authorization token ${"x".repeat(1_200)}`
              : `bounded ${actionCase.kind} timeout`,
        };
      },
    });

    assert.equal(calls, actionCase.max_attempts, actionCase.kind);
    assert.equal(result.ok, false, actionCase.kind);
    if (
      !result.ok &&
      actionCase.kind === "artifact_write"
    ) {
      assert.equal(result.code, "ARTIFACT_ROOT_INVALID");
      assert.equal(
        result.message,
        "verification action failed; diagnostic was redacted",
      );
    }
    const run = await fixture.store.getRun(fixture.run_id);
    const attempt = run.verification_state?.attempts.find(
      (candidate) => candidate.action_id === actionId,
    );
    assert.equal(
      attempt?.attempt_count,
      actionCase.max_attempts,
      actionCase.kind,
    );
    assert.equal(
      attempt?.max_attempts,
      actionCase.max_attempts,
      actionCase.kind,
    );
    assert.equal(attempt?.status, "exhausted", actionCase.kind);
    const error = run.verification_records.find(
      (record) =>
        record.payload.kind === "error" &&
        record.record_id === result.evidence_record_ids.at(-1),
    );
    assert.equal(error?.payload.kind, "error", actionCase.kind);
    if (
      error?.schema_version === 2 &&
      error.payload.kind === "error"
    ) {
      assert.equal(
        error.payload.attempt_count,
        actionCase.max_attempts,
        actionCase.kind,
      );
      assert.deepEqual(error.payload.evidence_record_ids, []);
    }
  }
});

test("TEST-1708 times out a never-resolving adapter at the durable ceiling", async (t) => {
  const fixture = await createFixture(t, "both");
  await advanceToActionStage(fixture, "readiness");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let calls = 0;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstStart = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const secondStart = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  try {
    const resultPromise = fixture.coordinator.runAction(fixture.run_id, {
      action_id: "never-resolving-readiness",
      kind: "readiness",
      lane: null,
      check_id: null,
      input: { path: "/" },
      adapter: async () => {
        calls += 1;
        (calls === 1 ? firstStarted : secondStarted)();
        return new Promise<never>(() => {});
      },
    });
    await firstStart;
    t.mock.timers.tick(30_000);
    await secondStart;
    t.mock.timers.tick(30_000);
    const result = await resultPromise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "TIMEOUT");
      assert.equal(result.outcome, "error");
      assert.equal(result.integrity_failure, false);
    }
    assert.equal(calls, 2);
    const run = await fixture.store.getRun(fixture.run_id);
    const attempt = run.verification_state?.attempts.find(
      (candidate) =>
        candidate.action_id === "never-resolving-readiness",
    );
    assert.equal(attempt?.attempt_count, 2);
    assert.equal(attempt?.status, "exhausted");
  } finally {
    t.mock.timers.reset();
  }
});

test("TEST-1708 uses only the settled retry evidence for the final decision", async (t) => {
  const fixture = await createFixture(t, "backend-only");
  await advanceToExecuting(fixture);
  let calls = 0;
  const result = await fixture.coordinator.runAction(fixture.run_id, {
    action_id: "api-retry-evidence",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: { path: "/" },
    adapter: async (context) => {
      calls += 1;
      const run = await fixture.store.getRun(fixture.run_id);
      const record = requestRecord(
        run,
        `api-retry-evidence-${calls}`,
        calls === 1 ? 503 : undefined,
      );
      await context.submit(record);
      return calls === 1
        ? {
            ok: false,
            code: "API_CONTRACT_MISMATCH",
            message: "first probe mismatched",
          }
        : { ok: true, value: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(result.evidence_record_ids, ["api-retry-evidence-2"]);

  const settled = await fixture.store.getRun(fixture.run_id);
  const attempt = settled.verification_state?.attempts.find(
    (candidate) => candidate.action_id === "api-retry-evidence",
  );
  assert.deepEqual(attempt?.evidence_record_ids, [
    "api-retry-evidence-1",
    "api-retry-evidence-2",
  ]);
  assert.deepEqual(attempt?.decisive_evidence_record_ids, [
    "api-retry-evidence-2",
  ]);
  assert.equal(
    settled.verification_records.some(
      (record) => record.record_id === "api-retry-evidence-1",
    ),
    true,
  );

  await advanceToDeciding(fixture);
  const terminal = await fixture.coordinator.finalize(fixture.run_id, [
    {
      lane: "backend",
      checks: [
        {
          check_id: "home-api",
          required: true,
          outcome: "passed",
          evidence_record_ids: ["api-retry-evidence-2"],
          integrity_failure: false,
        },
      ],
    },
  ]);
  assert.equal(terminalOutcome(terminal), "passed");
});

test("TEST-1708 settles terminal failure state and its error atomically", async (t) => {
  const fixture = await createFixture(t, "both");
  await advanceToActionStage(fixture, "artifact_write");
  const originalRecordActionError =
    fixture.store.recordVerificationActionError.bind(fixture.store);
  let notifyFollowup!: () => void;
  let releaseFollowup!: () => void;
  const followupStarted = new Promise<void>((resolve) => {
    notifyFollowup = resolve;
  });
  const followupReleased = new Promise<void>((resolve) => {
    releaseFollowup = resolve;
  });
  fixture.store.recordVerificationActionError = async (...args) => {
    notifyFollowup();
    await followupReleased;
    return originalRecordActionError(...args);
  };

  const action = fixture.coordinator.runAction(fixture.run_id, {
    action_id: "atomic-terminal-failure",
    kind: "artifact_write",
    lane: null,
    check_id: null,
    input: { relative_path: "evidence/atomic.json" },
    adapter: async () => ({
      ok: false,
      code: "ARTIFACT_ROOT_INVALID",
      message: "artifact root failed closed",
    }),
  });
  await followupStarted;
  const settled = await fixture.store.getRun(fixture.run_id);
  const attempt = settled.verification_state?.attempts.find(
    (candidate) =>
      candidate.action_id === "atomic-terminal-failure",
  );
  assert.equal(attempt?.status, "exhausted");
  const actionErrors = settled.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "error" &&
      record.payload.action_id === "atomic-terminal-failure",
  );
  assert.equal(actionErrors.length, 1);
  releaseFollowup();
  const result = await action;
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(
      result.evidence_record_ids.at(-1),
      actionErrors[0]?.record_id,
    );
  }
});

test("TEST-1707 binds submitted evidence to the reserved action kind", async (t) => {
  const fixture = await createFixture(t, "both");
  await advanceToExecuting(fixture);
  const result = await fixture.coordinator.runAction(fixture.run_id, {
    action_id: "api-wrong-record-kind",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: { path: "/" },
    adapter: async (context) => {
      await context.submit(
        browserRecord(
          await fixture.store.getRun(fixture.run_id),
          "wrong-kind-browser-evidence",
        ),
      );
      return { ok: true, value: 200 };
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "INVALID_RECORD");
  }
  const run = await fixture.store.getRun(fixture.run_id);
  assert.equal(
    run.verification_records.some(
      (record) => record.record_id === "wrong-kind-browser-evidence",
    ),
    false,
  );
  const attempt = run.verification_state?.attempts.find(
    (candidate) => candidate.action_id === "api-wrong-record-kind",
  );
  assert.equal(attempt?.status, "aborted");
  assert.deepEqual(attempt?.decisive_evidence_record_ids, []);
});

test("TEST-1703 rejects finalization while an attempt is in progress", async (t) => {
  const fixture = await createFixture(t, "backend-only");
  await advanceToExecuting(fixture);
  let submittedRecordId = "";
  let notifyStarted!: () => void;
  let releaseAttempt!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseAttempt = resolve;
  });
  const action = fixture.coordinator.runAction(fixture.run_id, {
    action_id: "finalize-in-progress",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: { path: "/" },
    adapter: async (context) => {
      const record = requestRecord(
        await fixture.store.getRun(fixture.run_id),
        "finalize-in-progress-evidence",
      );
      submittedRecordId = await context.submit(record);
      notifyStarted();
      await released;
      return { ok: true, value: 200 };
    },
  });
  await started;
  await advanceToDeciding(fixture);
  const lanes: VerificationLaneDecisionInput[] = [
    {
      lane: "backend",
      checks: [
        {
          check_id: "home-api",
          required: true,
          outcome: "passed",
          evidence_record_ids: [submittedRecordId],
          integrity_failure: false,
        },
      ],
    },
  ];
  const rejected = await fixture.coordinator.finalize(
    fixture.run_id,
    lanes,
  );
  assert.equal(rejected.verification_state?.current_state, "deciding");
  assert.equal(terminalOutcome(rejected), undefined);
  assert.equal(rejected.verification_records.at(-1)?.payload.kind, "error");
  releaseAttempt();
  assert.equal((await action).ok, true);

  const terminal = await fixture.coordinator.finalize(
    fixture.run_id,
    lanes,
  );
  assert.equal(terminalOutcome(terminal), "passed");
  assert.equal(
    terminal.verification_records.filter(
      (record) => record.payload.kind === "report",
    ).length,
    1,
  );
});

test("TEST-1708 reserves a single-attempt action before concurrent execution", async (t) => {
  const fixture = await createFixture(t, "both");
  await advanceToActionStage(fixture, "artifact_write");
  let firstStarted!: () => void;
  let releaseFirst!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const options = {
    action_id: "concurrent-artifact",
    kind: "artifact_write" as const,
    lane: null,
    check_id: null,
    input: { relative_path: "evidence/concurrent.json" },
  };
  const first = fixture.coordinator.runAction(fixture.run_id, {
    ...options,
    adapter: async () => {
      calls += 1;
      firstStarted();
      await released;
      return { ok: true, value: "persisted" };
    },
  });
  await started;
  const contender = await fixture.coordinator.runAction(fixture.run_id, {
    ...options,
    adapter: async () => {
      calls += 1;
      return { ok: true, value: "must-not-run" };
    },
  });
  assert.equal(contender.ok, false);
  if (!contender.ok) {
    assert.equal(contender.code, "INVALID_RECORD");
    assert.equal(contender.evidence_record_ids.length, 1);
    const rejectedRun = await fixture.store.getRun(fixture.run_id);
    assert.equal(
      rejectedRun.verification_records.some(
        (record) =>
          record.record_id === contender.evidence_record_ids[0] &&
          record.payload.kind === "error",
      ),
      true,
    );
  }
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal((await first).ok, true);
  const run = await fixture.store.getRun(fixture.run_id);
  const attempt = run.verification_state?.attempts.find(
    (candidate) => candidate.action_id === options.action_id,
  );
  assert.equal(attempt?.attempt_count, 1);
  assert.equal(attempt?.status, "succeeded");
});

test("TEST-1708 rejects action-id budget bypass, success replay, and reopened replay", async (t) => {
  const exhausted = await createFixture(t, "both");
  await advanceToActionStage(exhausted, "artifact_write");
  const input = { relative_path: "evidence/budget.json" };
  const firstFailure = await exhausted.coordinator.runAction(
    exhausted.run_id,
    {
      action_id: "artifact-budget",
      kind: "artifact_write",
      lane: null,
      check_id: null,
      input,
      adapter: async () => ({
        ok: false,
        code: "TIMEOUT",
        message: "single attempt consumed",
      }),
    },
  );
  assert.equal(firstFailure.ok, false);
  let bypassCalls = 0;
  const bypass = await exhausted.coordinator.runAction(exhausted.run_id, {
    action_id: "artifact-budget-renamed",
    kind: "artifact_write",
    lane: null,
    check_id: null,
    input,
    adapter: async () => {
      bypassCalls += 1;
      return { ok: true, value: "must-not-run" };
    },
  });
  assert.equal(bypass.ok, false);
  if (!bypass.ok) {
    assert.equal(bypass.code, "INVALID_RECORD");
  }
  assert.equal(bypassCalls, 0);
  assert.equal(
    (await exhausted.store.getRun(exhausted.run_id)).verification_state
      ?.attempts.filter((attempt) => attempt.kind === "artifact_write").length,
    1,
  );

  const immutableCheck = await createFixture(t, "backend-only");
  await advanceToExecuting(immutableCheck);
  await immutableCheck.coordinator.runAction(immutableCheck.run_id, {
    action_id: "api-immutable-budget",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: { path: "/" },
    adapter: async () => ({
      ok: false,
      code: "TIMEOUT",
      message: "consume the immutable API action budget",
    }),
  });
  let changedInputCalls = 0;
  const changedInput = await immutableCheck.coordinator.runAction(
    immutableCheck.run_id,
    {
      action_id: "api-immutable-budget-renamed",
      kind: "api",
      lane: "backend",
      check_id: "home-api",
      input: { path: "/changed" },
      adapter: async () => {
        changedInputCalls += 1;
        return { ok: true, value: 200 };
      },
    },
  );
  assert.equal(changedInput.ok, false);
  if (!changedInput.ok) {
    assert.equal(changedInput.code, "INVALID_RECORD");
  }
  assert.equal(changedInputCalls, 0);
  assert.equal(
    (await immutableCheck.store.getRun(immutableCheck.run_id))
      .verification_state?.attempts.filter(
        (attempt) => attempt.kind === "api",
      ).length,
    1,
  );

  const succeeded = await createFixture(t, "both");
  await advanceToActionStage(succeeded, "artifact_write");
  const successOptions = {
    action_id: "successful-artifact",
    kind: "artifact_write" as const,
    lane: null,
    check_id: null,
    input: { relative_path: "evidence/success.json" },
  };
  assert.equal(
    (
      await succeeded.coordinator.runAction(succeeded.run_id, {
        ...successOptions,
        adapter: async () => ({ ok: true, value: "persisted" }),
      })
    ).ok,
    true,
  );
  let replayCalls = 0;
  const replay = await succeeded.coordinator.runAction(succeeded.run_id, {
    ...successOptions,
    adapter: async () => {
      replayCalls += 1;
      return { ok: true, value: "must-not-run" };
    },
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.code, "INVALID_RECORD");
  }
  assert.equal(replayCalls, 0);

  const reopened = new VerificationCoordinator(
    createReopenedStore(succeeded),
  );
  let reopenedCalls = 0;
  const reopenedReplay = await reopened.runAction(succeeded.run_id, {
    ...successOptions,
    adapter: async () => {
      reopenedCalls += 1;
      return { ok: true, value: "must-not-run" };
    },
  });
  assert.equal(reopenedReplay.ok, false);
  if (!reopenedReplay.ok) {
    assert.equal(reopenedReplay.code, "INVALID_RECORD");
  }
  assert.equal(reopenedCalls, 0);
  const reopenedRun = await createReopenedStore(succeeded).getRun(
    succeeded.run_id,
  );
  const durableAttempt = reopenedRun.verification_state?.attempts.find(
    (attempt) => attempt.action_id === successOptions.action_id,
  );
  assert.equal(durableAttempt?.attempt_count, 1);
  assert.equal(durableAttempt?.status, "succeeded");
});

test("TEST-1708 records source drift before dependent adapter execution", async (t) => {
  const fixture = await createFixture(t, "backend-only");
  await advanceToExecuting(fixture);
  const driftStore = new RunStore({
    root_path: fixture.state_root,
    now: () => new Date(CREATED_AT),
    verification_source_loader: async () => ({
      ...validVerificationSourceIdentity(fixture.project_root),
      source_commit: "f".repeat(40),
    }),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
  let calls = 0;
  const result = await new VerificationCoordinator(driftStore).runAction(
    fixture.run_id,
    {
      action_id: "source-drift-preflight",
      kind: "api",
      lane: "backend",
      check_id: "home-api",
      input: { path: "/" },
      adapter: async () => {
        calls += 1;
        return { ok: true, value: 200 };
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SOURCE_DRIFT");
    assert.equal(result.outcome, "error");
    assert.equal(result.integrity_failure, true);
  }
  const run = await driftStore.getRun(fixture.run_id);
  const attempt = run.verification_state?.attempts.find(
    (candidate) => candidate.action_id === "source-drift-preflight",
  );
  assert.equal(attempt?.attempt_count, 1);
  assert.equal(attempt?.status, "aborted");
  const error = run.verification_records.at(-1);
  assert.equal(error?.payload.kind, "error");
  if (error?.schema_version === 2 && error.payload.kind === "error") {
    assert.equal(error.payload.code, "SOURCE_DRIFT");
    assert.equal(error.check_id, "home-api");
    assert.equal(error.payload.attempt_count, 1);
  }

  const reopenedDriftStore = new RunStore({
    root_path: fixture.state_root,
    now: () => new Date(CREATED_AT),
    verification_source_loader: async () => ({
      ...validVerificationSourceIdentity(fixture.project_root),
      source_commit: "f".repeat(40),
    }),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
  let replayCalls = 0;
  const replay = await new VerificationCoordinator(
    reopenedDriftStore,
  ).runAction(fixture.run_id, {
    action_id: "source-drift-preflight",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: { path: "/" },
    adapter: async () => {
      replayCalls += 1;
      return { ok: true, value: 200 };
    },
  });
  assert.equal(replay.ok, false);
  if (!replay.ok) {
    assert.equal(replay.code, "INVALID_RECORD");
    assert.equal(replay.evidence_record_ids.length, 1);
  }
  assert.equal(replayCalls, 0);
  const reopened = await reopenedDriftStore.getRun(fixture.run_id);
  assert.equal(
    reopened.verification_state?.attempts.find(
      (candidate) =>
        candidate.action_id === "source-drift-preflight",
    )?.attempt_count,
    1,
  );
});

test("TEST-1722 records only enabled lanes and optional UI failure does not block Backend", async (t) => {
  const backend = await createFixture(t, "backend-only");
  await advanceToExecuting(backend);
  const backendLanes = await submitLaneEvidence(backend, {
    backend: "passed",
  });
  await advanceToDeciding(backend);
  const backendRun = await backend.coordinator.finalize(
    backend.run_id,
    backendLanes,
  );
  assert.deepEqual(summaryLanes(backendRun), ["backend"]);
  assert.equal(terminalOutcome(backendRun), "passed");

  const ui = await createFixture(t, "ui-only");
  await advanceToExecuting(ui);
  const uiLanes = await submitLaneEvidence(ui, { ui: "passed" });
  await advanceToDeciding(ui);
  const uiRun = await ui.coordinator.finalize(ui.run_id, uiLanes);
  assert.deepEqual(summaryLanes(uiRun), ["ui"]);
  assert.equal(terminalOutcome(uiRun), "passed");

  const both = await createFixture(t, "both", false);
  await advanceToExecuting(both);
  const bothLanes = await submitLaneEvidence(both, {
    backend: "passed",
    ui: "failed",
  });
  await advanceToDeciding(both);
  const bothRun = await both.coordinator.finalize(both.run_id, bothLanes);
  assert.deepEqual(summaryLanes(bothRun), ["backend", "ui"]);
  assert.equal(terminalOutcome(bothRun), "passed");
  const uiSummary = bothRun.verification_records.find(
    (record) =>
      record.payload.kind === "lane_summary" &&
      record.payload.lane === "ui",
  );
  assert.equal(uiSummary?.payload.kind, "lane_summary");
  if (uiSummary?.payload.kind === "lane_summary") {
    assert.equal(uiSummary.payload.outcome, "failed");
    assert.equal(uiSummary.payload.checks?.[0]?.outcome, "failed");
  }
});

test("TEST-1722 applies required precedence, optional-check visibility, and integrity override", async (t) => {
  for (const scenario of [
    { backend: "passed", ui: "failed", expected: "failed" },
    { backend: "failed", ui: "unavailable", expected: "unavailable" },
    { backend: "unavailable", ui: "error", expected: "error" },
  ] as const) {
    const fixture = await createFixture(t, "both");
    await advanceToExecuting(fixture);
    const lanes = await submitLaneEvidence(fixture, scenario);
    await advanceToDeciding(fixture);
    const run = await fixture.coordinator.finalize(fixture.run_id, lanes);
    assert.equal(terminalOutcome(run), scenario.expected);
  }

  const optionalCheck = await createFixture(t, "both", true, true);
  await advanceToExecuting(optionalCheck);
  const optionalLanes = await submitLaneEvidence(optionalCheck, {
    backend: "passed",
    ui: "passed",
  });
  assert.equal(
    (
      await optionalCheck.coordinator.advance(
        optionalCheck.run_id,
        "collecting",
      )
    ).accepted,
    true,
  );
  const optionalTask = requireV2Snapshot(
    await optionalCheck.store.getRun(optionalCheck.run_id),
  ).ui_contract;
  if (!optionalTask.enabled || optionalTask.agentic_tasks[0] === undefined) {
    throw new Error("optional agentic fixture is missing");
  }
  const task = optionalTask.agentic_tasks[0];
  const optionalFailure = await optionalCheck.coordinator.runAction(
    optionalCheck.run_id,
    {
      action_id: "optional-agentic-failure",
      kind: "agentic_browser",
      lane: "ui",
      check_id: task.id,
      input: { goal: task.goal },
      adapter: async () => ({
        ok: false,
        code: "ENVIRONMENT_UNAVAILABLE",
        message: "optional agentic adapter unavailable",
      }),
    },
  );
  assert.equal(optionalFailure.ok, false);
  const optionalRun = await optionalCheck.store.getRun(optionalCheck.run_id);
  const optionalError = optionalRun.verification_records.find(
    (record) =>
      record.payload.kind === "error" &&
      record.payload.code === "ENVIRONMENT_UNAVAILABLE",
  );
  assert.notEqual(optionalError, undefined);
  const optionalUi = optionalLanes.find((lane) => lane.lane === "ui");
  optionalUi?.checks.push({
    check_id: task.id,
    required: false,
    outcome: "unavailable",
    evidence_record_ids: [optionalError!.record_id],
    integrity_failure: false,
  });
  assert.equal(
    (
      await optionalCheck.coordinator.advance(
        optionalCheck.run_id,
        "deciding",
      )
    ).accepted,
    true,
  );
  const optionalTerminal = await optionalCheck.coordinator.finalize(
    optionalCheck.run_id,
    optionalLanes,
  );
  assert.equal(terminalOutcome(optionalTerminal), "passed");
  const optionalSummary = optionalTerminal.verification_records.find(
    (record) =>
      record.payload.kind === "lane_summary" &&
      record.payload.lane === "ui",
  );
  assert.equal(
    optionalSummary?.payload.kind === "lane_summary"
      ? optionalSummary.payload.checks?.find(
          (check) => check.check_id === task.id,
        )?.outcome
      : undefined,
    "unavailable",
  );

  const integrity = await createFixture(t, "both", false);
  await advanceToExecuting(integrity);
  const integrityFailure = await integrity.coordinator.runAction(
    integrity.run_id,
    {
      action_id: "optional-source-integrity",
      kind: "browser",
      lane: "ui",
      check_id: "home-browser",
      input: { source: "snapshotted" },
      adapter: async () => ({
        ok: false,
        code: "SOURCE_DRIFT",
        message: "captured source no longer matches",
      }),
    },
  );
  assert.equal(integrityFailure.ok, false);
  const integrityRun = await integrity.store.getRun(integrity.run_id);
  const integrityError = integrityRun.verification_records.find(
    (record) =>
      record.payload.kind === "error" &&
      record.payload.code === "SOURCE_DRIFT",
  );
  assert.notEqual(integrityError, undefined);
  const integrityLanes = await submitLaneEvidence(integrity, {
    backend: "passed",
    ui: "passed",
  });
  const integrityUi = integrityLanes.find((lane) => lane.lane === "ui");
  if (integrityUi === undefined) {
    throw new Error("UI lane decision is missing");
  }
  integrityUi.checks[0] = {
    ...integrityUi.checks[0]!,
    outcome: "error",
    evidence_record_ids: [
      ...integrityUi.checks[0]!.evidence_record_ids,
      integrityError!.record_id,
    ],
    integrity_failure: true,
  };
  await advanceToDeciding(integrity);
  const integrityTerminal = await integrity.coordinator.finalize(
    integrity.run_id,
    integrityLanes,
  );
  assert.equal(terminalOutcome(integrityTerminal), "error");
});

async function createFixture(
  t: TestContext,
  mode: LaneMode,
  uiRequired = true,
  includeAgentic = false,
): Promise<CoordinatorFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-verification-1703-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);

  const coordinatorConfig = validVerificationCoordinatorConfig();
  if (!coordinatorConfig.backend.enabled || !coordinatorConfig.ui.enabled) {
    throw new Error("verification fixture lanes must begin enabled");
  }
  if (!includeAgentic) {
    coordinatorConfig.ui.agentic_tasks = [];
    coordinatorConfig.ui.optional_capabilities = [];
  }
  coordinatorConfig.ui.required = uiRequired;
  if (mode === "backend-only") {
    coordinatorConfig.ui = { enabled: false };
  } else if (mode === "ui-only") {
    coordinatorConfig.backend = { enabled: false };
  }

  const projectConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  projectConfig.verification.coordinator = coordinatorConfig;
  const store = new RunStore({
    root_path: stateRoot,
    now: () => new Date(CREATED_AT),
    suffix: () => "170300",
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
  const created = await store.createRun({
    objective: "IS-1703 verification coordinator",
    project_path: projectRoot,
    project_config: projectConfig,
  });
  const coordinator = new VerificationCoordinator(store);
  coordinator.registerLocalRuntime({
    capability_adapters: Object.fromEntries(
      [
        "agentic_browser",
        "api",
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ].map((capability) => [
        capability,
        { name: "fixture-capability-probe", version: "1.0.0" },
      ]),
    ) as never,
    capability_probe: async (capability) => ({
      available: true,
      version: "1.0.0",
      diagnostic: `${capability} available`,
      adapter: {
        name: "fixture-capability-probe",
        version: "1.0.0",
      },
    }),
    start_server: async () => undefined,
    probe_http: async () => ({ status: 200 }),
    execute_local: async () => undefined,
  });
  const configured = await coordinator.advance(created.run_id, "configured");
  assert.equal(configured.accepted, true);
  const snapshotted = await coordinator.configure(created.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: 10_001,
  });
  assert.equal(
    snapshotted.verification_state?.current_state,
    "snapshotted",
  );
  return {
    store,
    coordinator,
    run_id: created.run_id,
    state_root: stateRoot,
    project_root: projectRoot,
  };
}

async function advanceToExecuting(fixture: CoordinatorFixture): Promise<void> {
  const capabilities = await fixture.coordinator.advance(
    fixture.run_id,
    "capabilities",
  );
  assert.equal(capabilities.accepted, true, "capabilities");
  await completeReadiness(fixture);
  for (const stage of ["ready", "executing"] as const) {
    const result = await fixture.coordinator.advance(fixture.run_id, stage);
    assert.equal(result.accepted, true, stage);
  }
}

async function completeReadiness(
  fixture: CoordinatorFixture,
): Promise<void> {
  const result = await fixture.coordinator.runReadiness(fixture.run_id, {
    action_id: "fixture-readiness",
    server: { framework: "other", allowed_dev_origins: [] },
  });
  assert.equal(result.ok, true, "readiness");
}

async function advanceToDeciding(fixture: CoordinatorFixture): Promise<void> {
  for (const stage of ["collecting", "deciding"] as const) {
    const result = await fixture.coordinator.advance(fixture.run_id, stage);
    assert.equal(result.accepted, true, stage);
  }
}

async function advanceToActionStage(
  fixture: CoordinatorFixture,
  kind: Exclude<VerificationActionKind, "cleanup">,
): Promise<void> {
  if (kind === "readiness") {
    const result = await fixture.coordinator.advance(
      fixture.run_id,
      "capabilities",
    );
    assert.equal(result.accepted, true);
    return;
  }
  await advanceToExecuting(fixture);
  if (
    kind === "agentic_browser" ||
    kind === "screenshot" ||
    kind === "semantic_review" ||
    kind === "comparison" ||
    kind === "artifact_write"
  ) {
    const result = await fixture.coordinator.advance(
      fixture.run_id,
      "collecting",
    );
    assert.equal(result.accepted, true);
  }
}

async function submitLaneEvidence(
  fixture: CoordinatorFixture,
  outcomes: {
    backend?: "passed" | "failed" | "unavailable" | "skipped" | "error";
    ui?: "passed" | "failed" | "unavailable" | "skipped" | "error";
  },
): Promise<VerificationLaneDecisionInput[]> {
  const lanes: VerificationLaneDecisionInput[] = [];
  let run = await fixture.store.getRun(fixture.run_id);
  const snapshot = requireV2Snapshot(run);

  if (snapshot.backend_contract.enabled) {
    const outcome = outcomes.backend ?? "passed";
    const evidence = await submitCheckOutcomeEvidence(
      fixture,
      "backend",
      snapshot.backend_contract.api_probes[0]!.id,
      outcome,
    );
    lanes.push({
      lane: "backend",
      checks: [
        {
          check_id: snapshot.backend_contract.api_probes[0]!.id,
          required: snapshot.backend_contract.api_probes[0]!.required,
          outcome,
          evidence_record_ids: evidence.record_ids,
          integrity_failure: evidence.integrity_failure,
        },
      ],
    });
    run = await fixture.store.getRun(fixture.run_id);
  }
  if (snapshot.ui_contract.enabled) {
    const outcome = outcomes.ui ?? "passed";
    const evidence = await submitCheckOutcomeEvidence(
      fixture,
      "ui",
      snapshot.ui_contract.browser_cases[0]!.id,
      outcome,
    );
    lanes.push({
      lane: "ui",
      checks: [
        {
          check_id: snapshot.ui_contract.browser_cases[0]!.id,
          required: snapshot.ui_contract.browser_cases[0]!.required,
          outcome,
          evidence_record_ids: evidence.record_ids,
          integrity_failure: evidence.integrity_failure,
        },
      ],
    });
  }
  return lanes;
}

async function submitCheckOutcomeEvidence(
  fixture: CoordinatorFixture,
  lane: "backend" | "ui",
  checkId: string,
  outcome: VerificationOutcome,
): Promise<{ record_ids: string[]; integrity_failure: boolean }> {
  const run = await fixture.store.getRun(fixture.run_id);
  if (lane === "backend" && (outcome === "passed" || outcome === "failed")) {
    const snapshot = requireV2Snapshot(run);
    if (!snapshot.backend_contract.enabled) {
      throw new Error("backend lane is disabled");
    }
    const expectedStatus =
      snapshot.backend_contract.api_probes[0]!.expected_status;
    const record = requestRecord(
      run,
      `${fixture.run_id}-${lane}-${outcome}-evidence`,
      outcome === "passed" ? expectedStatus : expectedStatus + 1,
    );
    await fixture.coordinator.submitAdapterRecord(fixture.run_id, record);
    return { record_ids: [record.record_id], integrity_failure: false };
  }
  if (lane === "ui" && outcome === "passed") {
    const record = browserRecord(
      run,
      `${fixture.run_id}-${lane}-${outcome}-evidence`,
    );
    await fixture.coordinator.submitAdapterRecord(fixture.run_id, record);
    return { record_ids: [record.record_id], integrity_failure: false };
  }

  const code =
    outcome === "failed"
      ? lane === "backend"
        ? ("API_CONTRACT_MISMATCH" as const)
        : ("BROWSER_CONTRACT_MISMATCH" as const)
      : outcome === "unavailable"
        ? ("CAPABILITY_UNAVAILABLE" as const)
        : outcome === "skipped"
          ? ("APPROVAL_REQUIRED" as const)
          : ("TIMEOUT" as const);
  const result = await fixture.coordinator.runAction(fixture.run_id, {
    action_id: `${fixture.run_id}-${lane}-${outcome}-action`,
    kind: lane === "backend" ? "api" : "browser",
    lane,
    check_id: checkId,
    input: { outcome },
    adapter: async () => ({
      ok: false,
      code,
      ...(code === "CAPABILITY_UNAVAILABLE"
        ? { capability: lane === "backend" ? ("api" as const) : ("browser" as const) }
        : {}),
      message: `${lane} evidence resolved to ${outcome}`,
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("closed failure evidence unexpectedly passed");
  }
  assert.equal(result.outcome, outcome);
  assert.equal(result.integrity_failure, false);
  return {
    record_ids: result.evidence_record_ids,
    integrity_failure: result.integrity_failure,
  };
}

function requestRecord(
  run: RunRecord,
  recordId: string,
  actualStatus?: number,
): VerificationLinkedRecord {
  const snapshot = requireV2Snapshot(run);
  if (!snapshot.backend_contract.enabled) {
    throw new Error("backend lane is disabled");
  }
  const probe = snapshot.backend_contract.api_probes[0]!;
  const payload = {
    kind: "request" as const,
    method: probe.method,
    path: probe.path,
    expected_status: probe.expected_status,
    actual_status: actualStatus ?? probe.expected_status,
    request_sha256: REQUEST_SHA,
    response_sha256: RESPONSE_SHA,
  };
  return adapterRecord(
    run,
    recordId,
    "request",
    payload,
    "backend",
    probe.id,
    {
      name: snapshot.backend_contract.api_adapter,
      version: snapshot.backend_contract.api_adapter_version,
    },
  );
}

function createReopenedStore(fixture: CoordinatorFixture): RunStore {
  return new RunStore({
    root_path: fixture.state_root,
    now: () => new Date(CREATED_AT),
    suffix: () => "170301",
    verification_source_loader: async () =>
      validVerificationSourceIdentity(fixture.project_root),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
}

function browserRecord(run: RunRecord, recordId: string): VerificationLinkedRecord {
  const snapshot = requireV2Snapshot(run);
  if (!snapshot.ui_contract.enabled) {
    throw new Error("UI lane is disabled");
  }
  const browserCase = snapshot.ui_contract.browser_cases[0]!;
  const payload = {
    kind: "browser" as const,
    case_sha256: sha256CanonicalJson(browserCase),
    action_count: browserCase.actions.length,
    assertion_count: browserCase.assertions.length,
  };
  return adapterRecord(
    run,
    recordId,
    "browser",
    payload,
    "ui",
    browserCase.id,
    {
      name: snapshot.ui_contract.deterministic_adapter,
      version: snapshot.ui_contract.deterministic_adapter_version,
    },
  );
}

function adapterRecord(
  run: RunRecord,
  recordId: string,
  recordType: VerificationLinkedRecord["record_type"],
  payload: VerificationLinkedRecord["payload"],
  lane: "backend" | "ui" | null,
  checkId: string | null,
  adapter: { name: string; version: string } | null = null,
): VerificationLinkedRecord {
  const snapshot = requireV2Snapshot(run);
  const laneContract =
    lane === "backend"
      ? snapshot.backend_contract
      : lane === "ui"
        ? snapshot.ui_contract
        : null;
  const checkRequired =
    checkId === null
      ? false
      : lane === "backend" && snapshot.backend_contract.enabled
        ? (snapshot.backend_contract.api_probes.find(
            (probe) => probe.id === checkId,
          )?.required ?? false)
        : lane === "ui" && snapshot.ui_contract.enabled
          ? (snapshot.ui_contract.browser_cases.find(
              (browserCase) => browserCase.id === checkId,
            )?.required ?? false)
          : false;
  return {
    schema_version: 2,
    contract_id: "verification_contract_v2",
    record_id: recordId,
    record_type: recordType,
    run_id: run.run_id,
    case_id: snapshot.case_id,
    check_id: checkId,
    snapshot_id: snapshot.snapshot_id,
    lane,
    stage: "executing",
    timestamp_utc: CREATED_AT,
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    lane_required:
      laneContract !== null && laneContract.enabled
        ? laneContract.required
        : null,
    check_required: checkRequired,
    previous_record_sha256: sha256CanonicalJson(
      run.verification_records.at(-1)!,
    ),
    payload_sha256: sha256CanonicalJson(payload),
    payload,
    adapter,
    model: null,
    artifact_references: [],
  } as VerificationLinkedRecord;
}

function requireV2Snapshot(
  run: RunRecord,
): VerificationRunSnapshot & { schema_version: 2 } {
  if (
    run.verification_snapshot === null ||
    run.verification_snapshot.schema_version !== 2
  ) {
    throw new Error("contract-v2 verification snapshot is required");
  }
  return run.verification_snapshot;
}

function summaryLanes(run: RunRecord): Array<"backend" | "ui"> {
  return run.verification_records.flatMap((record) =>
    record.payload.kind === "lane_summary" ? [record.payload.lane] : [],
  );
}

function terminalOutcome(run: RunRecord): string | undefined {
  const report = run.verification_records.find(
    (record) => record.payload.kind === "report",
  );
  return report?.payload.kind === "report"
    ? report.payload.outcome
    : undefined;
}

function isArkError(code: string) {
  return (error: unknown): boolean =>
    error instanceof ArkTeamError && error.code === code;
}
