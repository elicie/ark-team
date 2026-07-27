import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import type { VerificationApiRuntimeRequest } from "../src/verification-api-adapter.js";
import type {
  VerificationAgenticBrowserRequest,
  VerificationAgenticBrowserRuntimeResult,
} from "../src/verification-agentic-browser-adapter.js";
import type {
  VerificationBrowserDriverRequest,
  VerificationBrowserDriverResult,
} from "../src/verification-browser-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  VERIFICATION_PM_HANDOFF_TRACEABILITY,
  canonicalJson,
  sha256CanonicalJson,
  verificationApprovedBaselineManifestSchema,
  verificationBaselineSetSha256,
  verificationSpecDeltaRecordSchema,
  type VerificationApprovedBaselineManifest,
  type VerificationSpecDeltaRecord,
} from "../src/verification-contract.js";
import {
  VERIFICATION_ROLLOUT_STAGES,
  VerificationBootstrapPmGate,
  VerificationCoordinator,
  type DeepReadonly,
} from "../src/verification-coordinator.js";
import {
  VERIFICATION_SEMANTIC_REVIEW_CHECKS,
  type VerificationSemanticReviewRequest,
  type VerificationSemanticReviewRuntimeResult,
} from "../src/verification-semantic-review-adapter.js";
import { encodeVerificationRgba8Png } from "../src/verification-png.js";
import type {
  VerificationScreenshotRuntimeRequest,
  VerificationScreenshotRuntimeResult,
} from "../src/verification-visual-adapter.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const CREATED_AT = "2026-07-27T21:00:00.000Z";
const TRACE_BYTES = Uint8Array.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);
const SPEC_DELTA_IDS = [
  "OBJ-1709",
  "REQ-1721",
  "AC-1721",
  "TEST-1721",
  "IS-1707",
] as const;

test("TEST-1717/1719/1720 backend-only bootstrap closes eleven ordered steps and enters PM review", async (t) => {
  const fixture = await createBackendFixture(t);

  const result = await fixture.coordinator.runBootstrap(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server: {
      framework: "other",
      allowed_dev_origins: [],
    },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") {
    assert.fail("BOOTSTRAP-1701 unexpectedly produced a spec delta");
  }
  assert.equal(result.case_id, "BOOTSTRAP-1701");
  assert.deepEqual(
    result.steps.map(({ sequence, name, status }) => ({
      sequence,
      name,
      status,
    })),
    [
      { sequence: 1, name: "identity", status: "completed" },
      { sequence: 2, name: "config", status: "completed" },
      { sequence: 3, name: "snapshot", status: "completed" },
      { sequence: 4, name: "capabilities", status: "completed" },
      { sequence: 5, name: "server", status: "completed" },
      { sequence: 6, name: "backend", status: "completed" },
      {
        sequence: 7,
        name: "deterministic_ui",
        status: "not_applicable",
      },
      { sequence: 8, name: "visual", status: "not_applicable" },
      {
        sequence: 9,
        name: "agentic_ui",
        status: "not_applicable",
      },
      {
        sequence: 10,
        name: "lane_summaries",
        status: "completed",
      },
      {
        sequence: 11,
        name: "terminal_handoff",
        status: "completed",
      },
    ],
  );
  assert.equal(
    result.steps.every(
      (step, index) =>
        step.sequence === index + 1 &&
        (step.status === "not_applicable" ||
          step.evidence_record_ids.length > 0),
    ),
    true,
  );
  assert.equal(
    result.run.verification_state?.terminal_outcome,
    "passed",
  );
  assert.equal(
    result.run.verification_state?.current_state,
    "pm_review_pending",
  );

  const snapshot = result.run.verification_snapshot;
  assert.ok(snapshot !== null && snapshot.schema_version === 2);
  if (snapshot === null || snapshot.schema_version !== 2) {
    assert.fail("backend bootstrap did not create a schema-2 snapshot");
  }
  const rollout = await fixture.coordinator.announceRollout(
    fixture.run_id,
  );
  assert.deepEqual(rollout, {
    contract_id: "verification_contract_v2",
    schema_version: 2,
    package_id: "verification-spec-v4",
    package_fingerprint: snapshot.package.package_fingerprint,
    source_fingerprint: snapshot.source_fingerprint,
    snapshot_id: snapshot.snapshot_id,
    stages: VERIFICATION_ROLLOUT_STAGES,
  });

  const reportRecords = result.run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "report",
  );
  assert.equal(reportRecords.length, 1);
  const report = reportRecords[0]!;
  assert.equal(report.payload.kind, "report");
  if (report.payload.kind !== "report") {
    assert.fail("terminal handoff report is missing");
  }
  assert.equal(report.payload.outcome, "passed");
  const traceability =
    "traceability" in report.payload
      ? report.payload.traceability
      : undefined;
  assert.deepEqual(
    traceability,
    VERIFICATION_PM_HANDOFF_TRACEABILITY,
  );
  assert.equal(
    traceability?.some(
      (entry) =>
        entry.requirement_id === "REQ-1720" &&
        entry.acceptance_id === "AC-1720" &&
        entry.test_id === "TEST-1720" &&
        entry.implementation_slice_id === "IS-1707",
    ),
    true,
  );

  const laneSummaries = result.run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "lane_summary",
  );
  assert.equal(laneSummaries.length, 1);
  assert.equal(
    laneSummaries[0]!.schema_version === 2
      ? laneSummaries[0]!.lane
      : null,
    "backend",
  );
  assert.equal(
    result.run.verification_records.some(
      (record) => record.schema_version === 2 && record.lane === "ui",
    ),
    false,
  );
  assert.equal(
    result.run.verification_state?.attempts.some((attempt) =>
      [
        "browser",
        "screenshot",
        "semantic_review",
        "comparison",
        "agentic_browser",
      ].includes(attempt.kind),
    ),
    false,
  );
  assert.deepEqual(fixture.effects.capability_probes, ["api", "server"]);
  assert.deepEqual(fixture.effects.readiness_events, [
    "probe:api",
    "probe:server",
    "start_server",
  ]);
  assert.equal(fixture.effects.start_server, 1);
  assert.equal(fixture.effects.api, 1);
  assert.equal(fixture.effects.local, 0);

  let unexpectedBootstrapResolution = 0;
  const gate = new VerificationBootstrapPmGate(
    fixture.coordinator,
    async () => {
      unexpectedBootstrapResolution += 1;
      return {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server: {
          framework: "other",
          allowed_dev_origins: [],
        },
      };
    },
  );
  const pmReview = await gate.prepareOriginalPmReview(fixture.run_id);
  assert.equal(
    pmReview.verification_state?.current_state,
    "original_pm_review",
  );
  assert.equal(pmReview.verification_state?.terminal_outcome, "passed");
  assert.equal(unexpectedBootstrapResolution, 0);

  const preservedSnapshotSha256 =
    pmReview.verification_snapshot_sha256;
  const preservedRecordCount = pmReview.verification_records.length;
  const rollback = await fixture.coordinator.disableLocalVerification(
    "TEST-1718 disables only future contract-v2 starts",
  );
  assert.deepEqual(rollback, {
    schema_version: 2,
    contract_id: "verification_contract_v2",
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    new_starts_enabled: false,
    preserves_existing_records: true,
    reason: "TEST-1718 disables only future contract-v2 starts",
    recorded_at_utc: CREATED_AT,
  });
  const reopened = await fixture.store.getRun(fixture.run_id);
  assert.equal(
    reopened.verification_snapshot_sha256,
    preservedSnapshotSha256,
  );
  assert.equal(
    reopened.verification_records.length,
    preservedRecordCount,
  );

  await assert.rejects(
    () => fixture.coordinator.recoverLocal(fixture.run_id),
    hasErrorCode("INVALID_TRANSITION"),
  );
});

test("TEST-1718 exact nonterminal recovery revalidates capabilities and server without rewriting the snapshot", async (t) => {
  const fixture = await createBackendFixture(t);
  const configured = await fixture.coordinator.advance(
    fixture.run_id,
    "configured",
  );
  assert.equal(configured.accepted, true);
  const snapshotted = await fixture.coordinator.configureLocal(
    fixture.run_id,
    {
      package_fingerprint:
        APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    },
  );
  assert.ok(
    snapshotted.verification_snapshot !== null &&
      snapshotted.verification_snapshot.schema_version === 2,
  );
  assert.equal(
    (
      await fixture.coordinator.advance(
        fixture.run_id,
        "capabilities",
      )
    ).accepted,
    true,
  );
  const readiness = await fixture.coordinator.runReadiness(
    fixture.run_id,
    {
      action_id: "bootstrap-recovery-readiness",
      server: {
        framework: "other",
        allowed_dev_origins: [],
      },
    },
  );
  assert.equal(readiness.ok, true);
  for (const stage of ["ready", "executing"] as const) {
    assert.equal(
      (await fixture.coordinator.advance(fixture.run_id, stage))
        .accepted,
      true,
    );
  }
  await assert.rejects(
    () => fixture.coordinator.beginOriginalPmReview(fixture.run_id),
    hasErrorCode("INVALID_TRANSITION"),
  );

  const before = await fixture.store.getRun(fixture.run_id);
  const beforeRecords = structuredClone(before.verification_records);
  const beforeAttempts = structuredClone(
    before.verification_state?.attempts ?? [],
  );
  const recovered = await fixture.coordinator.recoverLocal(
    fixture.run_id,
  );
  assert.equal(
    recovered.verification_state?.current_state,
    "executing",
  );
  assert.equal(
    recovered.verification_snapshot_sha256,
    before.verification_snapshot_sha256,
  );
  assert.deepEqual(recovered.verification_records, beforeRecords);
  assert.deepEqual(
    recovered.verification_state?.attempts,
    beforeAttempts,
  );

  fixture.controls.api_available = false;
  await assert.rejects(
    () => fixture.coordinator.recoverLocal(fixture.run_id),
    hasErrorCode("ENVIRONMENT_UNAVAILABLE"),
  );

  fixture.controls.api_available = true;
  fixture.controls.server_reachable = false;
  await assert.rejects(
    () => fixture.coordinator.recoverLocal(fixture.run_id),
    hasErrorCode("ENVIRONMENT_UNAVAILABLE"),
  );

  fixture.controls.server_reachable = true;
  fixture.controls.source_commit = "c".repeat(40);
  await assert.rejects(
    () => fixture.coordinator.recoverLocal(fixture.run_id),
    hasErrorCode("SOURCE_DRIFT"),
  );

  fixture.controls.source_commit = "a".repeat(40);
  fixture.controls.package_valid = false;
  await assert.rejects(
    () => fixture.coordinator.recoverLocal(fixture.run_id),
    hasErrorCode("PACKAGE_FINGERPRINT_MISMATCH"),
  );

  const afterFailures = await fixture.store.getRun(fixture.run_id);
  assert.equal(
    afterFailures.verification_snapshot_sha256,
    before.verification_snapshot_sha256,
  );
  assert.deepEqual(afterFailures.verification_records, beforeRecords);
  assert.deepEqual(
    afterFailures.verification_state?.attempts,
    beforeAttempts,
  );
});

test("TEST-1720 PM gate never retries a terminal required non-pass", async (t) => {
  const fixture = await createBackendFixture(t, "172000");
  fixture.controls.api_available = false;
  const result = await fixture.coordinator.runBootstrap(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server: {
      framework: "other",
      allowed_dev_origins: [],
    },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") {
    assert.fail("required capability loss must remain a terminal non-pass");
  }
  assert.equal(
    result.run.verification_state?.terminal_outcome,
    "unavailable",
  );
  assert.equal(fixture.effects.api, 0);

  let resolutions = 0;
  const gate = new VerificationBootstrapPmGate(
    fixture.coordinator,
    async () => {
      resolutions += 1;
      return {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server: {
          framework: "other",
          allowed_dev_origins: [],
        },
      };
    },
  );
  const before = await fixture.store.getRun(fixture.run_id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => gate.prepareOriginalPmReview(fixture.run_id),
      hasErrorCode("INVALID_TRANSITION"),
    );
  }
  const after = await fixture.store.getRun(fixture.run_id);
  assert.equal(resolutions, 0);
  assert.equal(
    after.verification_snapshot_sha256,
    before.verification_snapshot_sha256,
  );
  assert.deepEqual(after.verification_records, before.verification_records);
  assert.equal(
    await fixture.coordinator.getSpecDelta(fixture.run_id),
    null,
  );
});

test("TEST-1718 required server loss closes unavailable without dependent effects", async (t) => {
  const fixture = await createBackendFixture(t, "171800");
  fixture.controls.server_reachable = false;
  const result = await fixture.coordinator.runBootstrap(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server: {
      framework: "other",
      allowed_dev_origins: [],
    },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") {
    assert.fail("required server loss must produce a closed non-pass");
  }
  assert.equal(
    result.run.verification_state?.terminal_outcome,
    "unavailable",
  );
  assert.equal(fixture.effects.start_server, 1);
  assert.equal(fixture.effects.api, 0);
  assert.equal(
    result.run.verification_records.filter(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "report",
    ).length,
    1,
  );
});

test("TEST-1719 UI-only bootstrap performs visual work before advisory agentic work with zero Backend effect", async (t) => {
  const fixture = await createUiFixture(t);

  const result = await fixture.coordinator.runBootstrap(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server: {
      framework: "other",
      allowed_dev_origins: [],
    },
    semantic_checklist_by_case: {
      "home-browser": {
        identity: "ui-visual-review",
        version: "1.0.0",
      },
    },
    baseline_png_bytes_by_case: {
      "home-browser": fixture.baseline_pngs,
    },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") {
    assert.fail("UI-only BOOTSTRAP-1701 unexpectedly produced a delta");
  }
  assert.equal(
    result.run.verification_state?.current_state,
    "pm_review_pending",
  );
  assert.equal(
    result.run.verification_state?.terminal_outcome,
    "passed",
  );
  assert.equal(result.steps.length, 11);
  assert.deepEqual(
    result.steps
      .filter((step) => step.status === "not_applicable")
      .map((step) => step.name),
    ["backend"],
  );
  assert.equal(
    result.steps.find((step) => step.name === "deterministic_ui")
      ?.status,
    "completed",
  );
  assert.equal(
    result.steps.find((step) => step.name === "visual")?.status,
    "completed",
  );
  assert.equal(
    result.steps.find((step) => step.name === "agentic_ui")?.status,
    "completed",
  );

  assert.equal(fixture.effects.api, 0);
  assert.equal(
    fixture.effects.capability_probes.includes("api"),
    false,
  );
  assert.equal(
    result.run.verification_records.some(
      (record) =>
        record.schema_version === 2 && record.lane === "backend",
    ),
    false,
  );
  assert.equal(
    result.run.verification_state?.attempts.some(
      (attempt) => attempt.kind === "api",
    ),
    false,
  );

  const firstBrowser = fixture.effects.adapter_calls.indexOf("browser");
  const screenshots =
    fixture.effects.adapter_calls.indexOf("screenshots");
  const semantic =
    fixture.effects.adapter_calls.indexOf("semantic_review");
  const agentic =
    fixture.effects.adapter_calls.indexOf("agentic_browser");
  const deterministicRecheck =
    fixture.effects.adapter_calls.lastIndexOf("browser");
  assert.ok(firstBrowser >= 0);
  assert.ok(screenshots > firstBrowser);
  assert.ok(semantic > screenshots);
  assert.ok(agentic > semantic);
  assert.ok(deterministicRecheck > agentic);

  const comparisonRecordIndex =
    result.run.verification_records.findIndex(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "comparison",
    );
  const agenticRecordIndex =
    result.run.verification_records.findIndex(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "agentic_browser",
    );
  assert.ok(comparisonRecordIndex >= 0);
  assert.ok(agenticRecordIndex > comparisonRecordIndex);
  const summaries = result.run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "lane_summary",
  );
  assert.equal(summaries.length, 1);
  assert.equal(
    summaries[0]!.schema_version === 2
      ? summaries[0]!.lane
      : null,
    "ui",
  );
});

test("TEST-1719 both-enabled bootstrap preserves Backend-before-UI order and writes two lane summaries", async (t) => {
  const fixture = await createUiFixture(t, true);

  const result = await fixture.coordinator.runBootstrap(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server: {
      framework: "other",
      allowed_dev_origins: [],
    },
    semantic_checklist_by_case: {
      "home-browser": {
        identity: "ui-visual-review",
        version: "1.0.0",
      },
    },
    baseline_png_bytes_by_case: {
      "home-browser": fixture.baseline_pngs,
    },
  });

  assert.equal(result.status, "completed");
  if (result.status !== "completed") {
    assert.fail("both-enabled BOOTSTRAP-1701 produced a delta");
  }
  assert.equal(
    result.run.verification_state?.current_state,
    "pm_review_pending",
  );
  assert.equal(
    result.steps.every((step) => step.status === "completed"),
    true,
  );
  assert.equal(fixture.effects.api, 1);
  assert.equal(
    fixture.effects.capability_probes.includes("api"),
    true,
  );
  const firstUiEffect =
    fixture.effects.adapter_calls.indexOf("browser");
  assert.ok(firstUiEffect >= 0);
  assert.equal(
    fixture.effects.adapter_calls.slice(0, firstUiEffect).includes("api"),
    true,
  );
  const summaries = result.run.verification_records
    .filter(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "lane_summary",
    )
    .flatMap((record) =>
      record.schema_version === 2 ? [record.lane] : [],
    )
    .sort();
  assert.deepEqual(summaries, ["backend", "ui"]);
  assert.equal(
    result.run.verification_records.filter(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "report",
    ).length,
    1,
  );
});

test("TEST-1719 optional agentic capability absence stays visible without blocking deterministic UI", async (t) => {
  const fixture = await createUiFixture(t, false, false);
  const result = await fixture.coordinator.runBootstrap(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server: {
      framework: "other",
      allowed_dev_origins: [],
    },
    semantic_checklist_by_case: {
      "home-browser": {
        identity: "ui-visual-review",
        version: "1.0.0",
      },
    },
    baseline_png_bytes_by_case: {
      "home-browser": fixture.baseline_pngs,
    },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") {
    assert.fail("optional agentic loss must not block deterministic UI");
  }
  assert.equal(result.run.verification_state?.terminal_outcome, "passed");
  assert.equal(
    result.run.verification_state?.current_state,
    "pm_review_pending",
  );
  assert.equal(
    fixture.effects.adapter_calls.includes("agentic_browser"),
    false,
  );
  assert.equal(fixture.effects.adapter_calls.includes("browser"), true);
  const uiSummary = result.run.verification_records.find(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "lane_summary" &&
      record.lane === "ui",
  );
  assert.equal(uiSummary?.payload.kind, "lane_summary");
  if (
    uiSummary?.schema_version !== 2 ||
    uiSummary.payload.kind !== "lane_summary"
  ) {
    assert.fail("UI lane summary is missing");
  }
  assert.equal(
    uiSummary.payload.checks?.find(
      (check) => check.check_id === "home-agentic",
    )?.outcome,
    "skipped",
  );
});

test("TEST-1721 persists one bounded SPEC_DELTA_REQUIRED record for every classification and blocks dependent work", async (t) => {
  const classifications = [
    "omission",
    "contradiction",
    "unsafe_input",
    "environment_mismatch",
    "unverifiable",
  ] as const;

  for (const [index, classification] of classifications.entries()) {
    const fixture = await createBackendFixture(t, `${index}72100`);
    const recorded = await fixture.coordinator.recordSpecDelta(
      fixture.run_id,
      specDeltaInput(classification),
    );

    assert.equal(
      verificationSpecDeltaRecordSchema.safeParse(recorded).success,
      true,
    );
    assert.deepEqual(Object.keys(recorded).sort(), [
      "affected_ids",
      "blocking_stage",
      "classification",
      "created_at_utc",
      "evidence",
      "impact",
      "proposed_resolution",
      "runtime_status",
      "source_snapshot",
      "status",
    ]);
    assert.deepEqual(Object.keys(recorded.source_snapshot).sort(), [
      "commit",
      "package_fingerprint",
      "tree",
      "worktree_root",
    ]);
    assert.equal(recorded.status, "SPEC_DELTA_REQUIRED");
    assert.equal(recorded.runtime_status, "not_started");
    assert.equal(recorded.classification, classification);
    assert.deepEqual(recorded.affected_ids, SPEC_DELTA_IDS);
    assert.equal(recorded.blocking_stage, "IS-1707");
    assert.equal(recorded.created_at_utc, CREATED_AT);
    assert.equal(recorded.created_at_utc.endsWith("Z"), true);

    const repeated = await fixture.coordinator.recordSpecDelta(
      fixture.run_id,
      specDeltaInput(
        classification === "omission"
          ? "contradiction"
          : "omission",
      ),
    );
    assert.deepEqual(repeated, recorded);
    assert.deepEqual(
      await fixture.coordinator.getSpecDelta(fixture.run_id),
      recorded,
    );
    assert.deepEqual(
      (
        await readdir(path.join(fixture.state_root, fixture.run_id))
      ).filter((name) => name === "verification-spec-delta.json"),
      ["verification-spec-delta.json"],
    );

    await assert.rejects(
      () =>
        fixture.coordinator.advance(fixture.run_id, "configured"),
      hasErrorCode("INVALID_TRANSITION"),
    );
    assert.deepEqual(fixture.effects.capability_probes, []);
    assert.equal(fixture.effects.start_server, 0);
    assert.equal(fixture.effects.api, 0);
  }
});

test("TEST-1721 aborts coordinator action effects and artifact writes after the delta is recorded", async (t) => {
  const fixture = await createBackendFixture(t, "170722");
  assert.equal(
    (
      await fixture.coordinator.advance(
        fixture.run_id,
        "configured",
      )
    ).accepted,
    true,
  );
  await fixture.coordinator.configureLocal(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
  });
  assert.equal(
    (
      await fixture.coordinator.advance(
        fixture.run_id,
        "capabilities",
      )
    ).accepted,
    true,
  );
  assert.equal(
    (
      await fixture.coordinator.runReadiness(fixture.run_id, {
        action_id: "delta-guard-readiness",
        server: {
          framework: "other",
          allowed_dev_origins: [],
        },
      })
    ).ok,
    true,
  );
  for (const stage of ["ready", "executing"] as const) {
    assert.equal(
      (await fixture.coordinator.advance(fixture.run_id, stage))
        .accepted,
      true,
    );
  }
  await fixture.coordinator.recordSpecDelta(
    fixture.run_id,
    specDeltaInput("unverifiable"),
  );

  let adapterEffects = 0;
  const action = await fixture.coordinator.runAction(
    fixture.run_id,
    {
      action_id: "delta-blocked-api-action",
      kind: "api",
      lane: "backend",
      check_id: "home-api",
      input: { probe_id: "home-api" },
      adapter: async () => {
        adapterEffects += 1;
        return { ok: true, value: "must-not-run" };
      },
    },
  );
  assert.equal(action.ok, false);
  if (!action.ok) {
    assert.equal(action.code, "INVALID_RECORD");
  }
  assert.equal(adapterEffects, 0);

  const artifactBytes = new TextEncoder().encode(
    "must not be persisted after a delta",
  );
  await assert.rejects(
    () =>
      fixture.coordinator.writeArtifact(fixture.run_id, {
        artifact_id: "delta-blocked-artifact",
        relative_path: "delta/blocked.txt",
        media_type: "text/plain",
        bytes: artifactBytes,
        sha256: sha256Bytes(artifactBytes),
        lane: null,
      }),
    hasErrorCode("INVALID_TRANSITION"),
  );
  await assert.rejects(
    () => fixture.coordinator.cleanupArtifacts(fixture.run_id),
    hasErrorCode("INVALID_TRANSITION"),
  );
});

test("TEST-1721 schema rejects invalid traceability, non-UTC time, and private transcript content", () => {
  const valid = validSpecDeltaRecord();
  for (const key of Object.keys(valid)) {
    const missing = structuredClone(valid) as unknown as Record<
      string,
      unknown
    >;
    delete missing[key];
    assert.equal(
      verificationSpecDeltaRecordSchema.safeParse(missing).success,
      false,
      `missing ${key}`,
    );
  }
  for (const key of Object.keys(valid.source_snapshot)) {
    const missing = structuredClone(valid) as unknown as {
      source_snapshot: Record<string, unknown>;
    };
    delete missing.source_snapshot[key];
    assert.equal(
      verificationSpecDeltaRecordSchema.safeParse(missing).success,
      false,
      `missing source_snapshot.${key}`,
    );
  }
  const invalidAffectedIds = structuredClone(valid);
  invalidAffectedIds.affected_ids = [
    "OBJ-1709",
    "REQ-1721",
    "AC-1721",
    "IS-1707",
    "BAD-1721",
  ];
  assert.equal(
    verificationSpecDeltaRecordSchema.safeParse(invalidAffectedIds)
      .success,
    false,
  );

  const nonUtc = structuredClone(valid);
  nonUtc.created_at_utc = "2026-07-27T23:00:00.000+02:00";
  assert.equal(
    verificationSpecDeltaRecordSchema.safeParse(nonUtc).success,
    false,
  );

  for (const mutation of [
    (record: VerificationSpecDeltaRecord) => {
      record.evidence[0]!.kind = "private_reasoning";
    },
    (record: VerificationSpecDeltaRecord) => {
      record.evidence[0]!.kind =
        "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    },
    (record: VerificationSpecDeltaRecord) => {
      record.evidence[0]!.value = "conversation transcript";
    },
    (record: VerificationSpecDeltaRecord) => {
      record.impact = "private reasoning must be persisted";
    },
    (record: VerificationSpecDeltaRecord) => {
      record.evidence[0]!.value =
        "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    },
    (record: VerificationSpecDeltaRecord) => {
      record.impact =
        "Bearer eyJabcdefghij.abcdefghijk.abcdefghijkl";
    },
    (record: VerificationSpecDeltaRecord) => {
      record.proposed_resolution =
        "-----BEGIN PRIVATE KEY-----";
    },
  ]) {
    const privateContent = structuredClone(valid);
    mutation(privateContent);
    assert.equal(
      verificationSpecDeltaRecordSchema.safeParse(privateContent)
        .success,
      false,
    );
  }
});

interface BackendFixture {
  store: RunStore;
  coordinator: VerificationCoordinator;
  run_id: string;
  state_root: string;
  effects: {
    capability_probes: string[];
    readiness_events: string[];
    start_server: number;
    probe_http: number;
    api: number;
    local: number;
  };
  controls: {
    api_available: boolean;
    server_available: boolean;
    server_reachable: boolean;
    source_commit: string;
    package_valid: boolean;
  };
}

interface UiFixture {
  coordinator: VerificationCoordinator;
  run_id: string;
  baseline_pngs: {
    "375x812": Uint8Array;
    "768x1024": Uint8Array;
    "1440x900": Uint8Array;
  };
  effects: {
    capability_probes: string[];
    adapter_calls: string[];
    api: number;
  };
}

async function createBackendFixture(
  t: TestContext,
  suffix = "170700",
): Promise<BackendFixture> {
  const root = await mkdtemp(
    path.join(tmpdir(), "ark-team-bootstrap-1707-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  const controls: BackendFixture["controls"] = {
    api_available: true,
    server_available: true,
    server_reachable: true,
    source_commit: "a".repeat(40),
    package_valid: true,
  };

  const verification = validVerificationCoordinatorConfig();
  verification.ui = { enabled: false };
  const projectConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  projectConfig.verification.coordinator = verification;

  const store = new RunStore({
    root_path: stateRoot,
    now: () => new Date(CREATED_AT),
    suffix: () => suffix,
    verification_source_loader: async () => ({
      ...validVerificationSourceIdentity(projectRoot),
      source_commit: controls.source_commit,
    }),
    verification_package_loader: () =>
      controls.package_valid
        ? readFile(path.resolve("docs", "slices", "SLICE-017.md"))
        : Promise.resolve(
            new TextEncoder().encode("invalid package bytes"),
          ),
  });
  const created = await store.createRun({
    objective: "IS-1707 bootstrap contract verification",
    project_path: projectRoot,
    project_config: projectConfig,
  });
  const coordinator = new VerificationCoordinator(store);
  const capabilityAdapters = {
    agentic_browser: { name: "browser-use", version: "0.13.6" },
    api: {
      name: verification.backend.enabled
        ? verification.backend.api_adapter
        : "curl",
      version: verification.backend.enabled
        ? verification.backend.api_adapter_version
        : "8.14.1",
    },
    browser: { name: "playwright-cli", version: "1.62.0" },
    comparison: { name: "fixture-comparison", version: "1.0.0" },
    screenshot: { name: "playwright-cli", version: "1.62.0" },
    semantic_review: {
      name: "fixture-image-review",
      version: "1.0.0",
    },
    server: { name: "fixture-server", version: "1.0.0" },
  } as const;
  const effects: BackendFixture["effects"] = {
    capability_probes: [],
    readiness_events: [],
    start_server: 0,
    probe_http: 0,
    api: 0,
    local: 0,
  };
  coordinator.registerLocalRuntime({
    port_available: async () => true,
    capability_adapters: capabilityAdapters,
    capability_probe: async (capability) => {
      effects.capability_probes.push(capability);
      effects.readiness_events.push(`probe:${capability}`);
      const available =
        capability === "api"
          ? controls.api_available
          : capability === "server"
            ? controls.server_available
            : true;
      return {
        available,
        version: available
          ? capabilityAdapters[capability].version
          : null,
        diagnostic: available
          ? `${capability} available`
          : `${capability} unavailable`,
        adapter: capabilityAdapters[capability],
      };
    },
    start_server: async () => {
      effects.start_server += 1;
      effects.readiness_events.push("start_server");
    },
    probe_http: async () => {
      effects.probe_http += 1;
      if (!controls.server_reachable) {
        throw new Error("registered local server is unreachable");
      }
      return { status: 200 };
    },
    execute_local: async () => {
      effects.local += 1;
      return undefined;
    },
    execute_api: async (request) => {
      effects.api += 1;
      return validApiResult(request);
    },
  });
  return {
    store,
    coordinator,
    run_id: created.run_id,
    state_root: stateRoot,
    effects,
    controls,
  };
}

async function createUiFixture(
  t: TestContext,
  includeBackend = false,
  agenticAvailable = true,
): Promise<UiFixture> {
  const root = await mkdtemp(
    path.join(tmpdir(), "ark-team-bootstrap-ui-1707-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);

  const verification = validVerificationCoordinatorConfig();
  if (!includeBackend) {
    verification.backend = { enabled: false };
  }
  if (!verification.ui.enabled) {
    assert.fail("UI bootstrap fixture requires the UI lane");
  }
  const baselinePngs = await provisionUiBaseline(
    projectRoot,
    verification,
  );
  const projectConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  projectConfig.verification.coordinator = verification;
  const store = new RunStore({
    root_path: stateRoot,
    now: () => new Date(CREATED_AT),
    suffix: () => (includeBackend ? "170720" : "170719"),
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
  const created = await store.createRun({
    objective: includeBackend
      ? "IS-1707 both-enabled bootstrap contract verification"
      : "IS-1707 UI-only bootstrap contract verification",
    project_path: projectRoot,
    project_config: projectConfig,
  });
  const coordinator = new VerificationCoordinator(store);
  const capabilityAdapters = {
    agentic_browser: { name: "browser-use", version: "0.13.6" },
    api: { name: "curl", version: "8.14.1" },
    browser: {
      name: verification.ui.deterministic_adapter,
      version: verification.ui.deterministic_adapter_version,
    },
    comparison: {
      name: "fixture-comparison",
      version: "1.0.0",
    },
    screenshot: {
      name: verification.ui.deterministic_adapter,
      version: verification.ui.deterministic_adapter_version,
    },
    semantic_review: {
      name: "fixture-image-review",
      version: "1.0.0",
    },
    server: { name: "fixture-server", version: "1.0.0" },
  } as const;
  const effects: UiFixture["effects"] = {
    capability_probes: [],
    adapter_calls: [],
    api: 0,
  };
  coordinator.registerLocalRuntime({
    port_available: async () => true,
    capability_adapters: capabilityAdapters,
    capability_probe: async (capability) => {
      effects.capability_probes.push(capability);
      const available =
        capability !== "agentic_browser" || agenticAvailable;
      return {
        available,
        version: available
          ? capabilityAdapters[capability].version
          : null,
        diagnostic: `${capability} ${available ? "available" : "unavailable"}`,
        adapter: capabilityAdapters[capability],
      };
    },
    start_server: async () => undefined,
    probe_http: async () => ({ status: 200 }),
    execute_local: async () => undefined,
    execute_api: async (request) => {
      effects.api += 1;
      effects.adapter_calls.push("api");
      return validApiResult(request);
    },
    execute_browser: async (request) => {
      effects.adapter_calls.push("browser");
      return validBrowserResult(request);
    },
    execute_screenshots: async (request) => {
      effects.adapter_calls.push("screenshots");
      return validScreenshotResult(request, baselinePngs);
    },
    semantic_review_active_turn: () => ({
      capability: "localImage",
      adapter: {
        name: "fixture-image-review",
        version: "1.0.0",
      },
    }),
    execute_semantic_review: async (request) => {
      effects.adapter_calls.push("semantic_review");
      return validSemanticReviewResult(request);
    },
    execute_agentic_browser: async (request) => {
      effects.adapter_calls.push("agentic_browser");
      return validAgenticResult(request);
    },
  });
  return {
    coordinator,
    run_id: created.run_id,
    baseline_pngs: baselinePngs,
    effects,
  };
}

async function provisionUiBaseline(
  projectRoot: string,
  config: ReturnType<typeof validVerificationCoordinatorConfig>,
): Promise<UiFixture["baseline_pngs"]> {
  if (!config.ui.enabled) {
    assert.fail("approved baseline requires an enabled UI lane");
  }
  const baselinePngs = {
    "375x812": whiteRgbaPng(375, 812),
    "768x1024": whiteRgbaPng(768, 1_024),
    "1440x900": whiteRgbaPng(1_440, 900),
  };
  const entries = config.ui.viewports.map((viewport) => {
    const [width, height] = viewport.split("x").map(Number) as [
      number,
      number,
    ];
    const bytes = baselinePngs[viewport];
    const sha256 = sha256Bytes(bytes);
    return {
      case_id: "home-browser",
      viewport,
      width,
      height,
      path: `objects/sha256/${sha256}.png`,
      sha256,
    };
  });
  const manifest: VerificationApprovedBaselineManifest =
    verificationApprovedBaselineManifestSchema.parse({
      schema_version: 1,
      baseline_id: config.ui.baseline_identity.id,
      approval_id: "baseline-approval-1707",
      approver: "local-user",
      approved_at_utc: "2026-07-27T20:59:00.000Z",
      source_commit: config.ui.baseline_identity.source_commit,
      source_tree: config.ui.baseline_identity.source_tree,
      environment: config.ui.baseline_identity.environment,
      adapter: {
        name: config.ui.deterministic_adapter,
        version: config.ui.deterministic_adapter_version,
      },
      browser_build: config.ui.browser_build,
      entries,
    });
  const baselineSetSha256 = verificationBaselineSetSha256(manifest);
  config.ui.baseline_identity.sha256 = baselineSetSha256;
  const baselineRoot = path.join(
    projectRoot,
    ".ark-team",
    "baselines",
  );
  for (const entry of manifest.entries) {
    const target = path.join(baselineRoot, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, baselinePngs[entry.viewport], {
      flag: "wx",
      mode: 0o444,
    });
  }
  const manifestPath = path.join(
    baselineRoot,
    "manifests",
    manifest.baseline_id,
    `${baselineSetSha256}.json`,
  );
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, canonicalJson(manifest), {
    flag: "wx",
    mode: 0o444,
  });
  return baselinePngs;
}

function validApiResult(
  request: DeepReadonly<VerificationApiRuntimeRequest>,
) {
  return {
    request_sha256: request.request_sha256,
    url: request.request.url,
    status: request.request.expected_status,
    headers: {
      "content-type": request.request.expected_content_type,
    },
    body: new TextEncoder().encode("<h1>Home</h1>"),
    elapsed_ms: 12,
  };
}

function validBrowserResult(
  request: DeepReadonly<VerificationBrowserDriverRequest>,
): VerificationBrowserDriverResult {
  return {
    schema_version: 1,
    contract_id: "verification_browser_driver_result_v1",
    case_id: request.case_id,
    case_sha256: request.case_sha256,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    origin: request.origin,
    final_url: request.url,
    context: structuredClone(
      request.context,
    ) as VerificationBrowserDriverRequest["context"],
    elapsed_ms: 25,
    readiness: {
      passed: true,
      elapsed_ms: 5,
      message: null,
    },
    actions: request.actions.map(({ sequence, action }) => ({
      sequence,
      input_sha256: sha256CanonicalJson(action),
      passed: true,
      elapsed_ms: 1,
      message: null,
    })),
    assertions: request.assertions.map(
      ({ sequence, assertion }) => ({
        sequence,
        input_sha256: sha256CanonicalJson(assertion),
        passed: true,
        elapsed_ms: 2,
        message: null,
      }),
    ),
    navigation: [
      {
        sequence: 0,
        url: request.url,
        status: 200,
        elapsed_ms: 4,
      },
    ],
    console: [],
    page_errors: [],
    dialogs: [],
    trace: {
      relative_path: request.trace.relative_path,
      media_type: request.trace.media_type,
      sha256: sha256Bytes(TRACE_BYTES),
      bytes: TRACE_BYTES,
    },
    passed: true,
    message: "declared deterministic assertions passed",
  };
}

function validScreenshotResult(
  request: DeepReadonly<VerificationScreenshotRuntimeRequest>,
  baselinePngs: UiFixture["baseline_pngs"],
): VerificationScreenshotRuntimeResult {
  return {
    schema_version: 1,
    contract_id: "verification_screenshot_runtime_result_v1",
    run_id: request.run_id,
    snapshot_id: request.snapshot_id,
    case_id: request.case_id,
    attempt_id: request.attempt_id,
    case_sha256: request.case_sha256,
    package_fingerprint: request.package_fingerprint,
    source_fingerprint: request.source_fingerprint,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    origin: request.origin,
    url: request.url,
    screenshots: request.captures.map((capture) => {
      const bytes = baselinePngs[capture.viewport];
      return {
        sequence: capture.sequence,
        viewport: capture.viewport,
        width: capture.width,
        height: capture.height,
        device_scale_factor: 1 as const,
        url: capture.url,
        relative_path: capture.relative_path,
        media_type: "image/png" as const,
        captured_at_utc: "2026-07-27T21:00:01.000Z",
        byte_length: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        capture: {
          browser_chrome: "excluded" as const,
          full_page: false,
          resized: false,
          cropped: false,
          converted: false,
          color_space_converted: false,
          alpha_normalized: false,
          post_processed: false,
        },
        bytes,
      };
    }),
  };
}

function validSemanticReviewResult(
  request: DeepReadonly<VerificationSemanticReviewRequest>,
): VerificationSemanticReviewRuntimeResult {
  return {
    schema_version: 1,
    contract_id: "verification_semantic_review_result_v1",
    input_sha256: request.input_sha256,
    adapter: { ...request.identity.adapter },
    checklist: {
      identity: request.checklist.identity,
      version: request.checklist.version,
      sha256: request.checklist.sha256,
    },
    reviewed_at_utc: "2026-07-27T21:00:02.000Z",
    outcome: "approved",
    observations: VERIFICATION_SEMANTIC_REVIEW_CHECKS.map((check) => ({
      check,
      observation: `${check} 이상 없음`,
    })),
  };
}

function validAgenticResult(
  request: DeepReadonly<VerificationAgenticBrowserRequest>,
): VerificationAgenticBrowserRuntimeResult {
  return {
    schema_version: 1,
    contract_id: "verification_agentic_browser_result_v1",
    task_id: request.task_id,
    task_sha256: request.task_sha256,
    input_sha256: request.input_sha256,
    adapter: { ...request.adapter },
    browser_build: request.browser_build,
    model_identity: request.model_identity,
    origin: request.origin,
    execution_status: "completed",
    finding_status: "no_finding",
    self_verdict: "achieved",
    judge_verdict: "unknown",
    findings: [],
    ledger: [
      {
        sequence: 0,
        action: request.allowed_actions[0]!,
        url: request.start_url,
        parameters: { path: "/" },
        result: "completed",
        error_code: null,
        artifact_references: [],
        timestamp_utc: "2026-07-27T21:00:03.500Z",
      },
    ],
    candidates: [
      {
        kind: "test",
        relative_path:
          `agentic/${request.task_id}/candidates/test.json`,
        sha256: "d".repeat(64),
        applied: false,
      },
    ],
    started_at_utc: "2026-07-27T21:00:03.000Z",
    finished_at_utc: "2026-07-27T21:00:04.000Z",
    elapsed_ms: 1_000,
  };
}

function whiteRgbaPng(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  rgba.fill(255);
  return encodeVerificationRgba8Png({ width, height, rgba });
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function specDeltaInput(
  classification:
    | "omission"
    | "contradiction"
    | "unsafe_input"
    | "environment_mismatch"
    | "unverifiable",
) {
  return {
    affected_ids: [...SPEC_DELTA_IDS],
    classification,
    evidence: [
      {
        kind: "contract_fact",
        value: `${classification} observed before execution`,
      },
    ],
    impact: "dependent bootstrap behavior cannot start",
    proposed_resolution:
      "resolve the contract fact and create a new immutable snapshot",
    blocking_stage: "IS-1707",
  };
}

function validSpecDeltaRecord(): VerificationSpecDeltaRecord {
  return {
    status: "SPEC_DELTA_REQUIRED",
    runtime_status: "not_started",
    affected_ids: [...SPEC_DELTA_IDS],
    classification: "omission",
    source_snapshot: {
      worktree_root: "/tmp/ark-team-project",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      package_fingerprint:
        APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    },
    evidence: [
      {
        kind: "contract_fact",
        value: "required route is missing",
      },
    ],
    impact: "dependent behavior cannot start",
    proposed_resolution: "supply the approved route",
    blocking_stage: "IS-1707",
    created_at_utc: CREATED_AT,
  };
}

function hasErrorCode(
  expected: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    error.code === expected;
}
