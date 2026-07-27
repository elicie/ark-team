import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  APPROVED_VERIFICATION_SPEC_SHA256,
  appendVerificationLinkedRecord,
  assertVerificationPackageBytes,
  assertVerificationPackageFingerprint,
  assertVerificationSourceIdentity,
  buildVerificationRunSnapshot,
  canonicalJson,
  captureVerificationSource,
  sha256CanonicalJson,
  verificationCoordinatorConfigSchema,
  verificationLinkedRecordSchema,
  verificationRunSnapshotSchema,
  verificationRunSnapshotSha256,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const execFileAsync = promisify(execFile);

test("TEST-1701 captures and verifies an exact clean Git source identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-source-"));
  const repository = path.join(root, "repository");
  const otherRepository = path.join(root, "other-repository");
  await mkdir(repository);
  await mkdir(otherRepository);
  try {
    for (const candidate of [repository, otherRepository]) {
      await execFileAsync("git", ["init", "-b", "main", candidate]);
      await execFileAsync("git", [
        "-C",
        candidate,
        "config",
        "user.name",
        "Ark Team Test",
      ]);
      await execFileAsync("git", [
        "-C",
        candidate,
        "config",
        "user.email",
        "ark-team@example.invalid",
      ]);
    }
    await writeFile(path.join(repository, "tracked.txt"), "clean\n", "utf8");
    await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "-m",
      "clean source",
    ]);
    await writeFile(path.join(otherRepository, "tracked.txt"), "other\n", "utf8");
    await execFileAsync("git", ["-C", otherRepository, "add", "tracked.txt"]);
    await execFileAsync("git", [
      "-C",
      otherRepository,
      "commit",
      "-m",
      "other source",
    ]);

    const captured = await captureVerificationSource(
      repository,
      () => new Date("2026-07-26T18:00:00.000Z"),
    );
    const other = await captureVerificationSource(
      otherRepository,
      () => new Date("2026-07-26T18:00:01.000Z"),
    );
    assert.equal(captured.worktree_root, repository);
    assert.equal(captured.source_ref, "refs/heads/main");
    assert.equal(captured.worktree_state, "GIT_CLEAN");
    assert.deepEqual(captured.porcelain_status, []);
    assert.equal(captured.capture_method, "git-literal-argv-v1");
    assert.equal(captured.captured_at_utc, "2026-07-26T18:00:00.000Z");
    assert.doesNotThrow(() =>
      assertVerificationSourceIdentity(captured, captured),
    );
    assert.match(captured.source_commit, /^[a-f0-9]{40,64}$/);
    assert.match(captured.source_tree, /^[a-f0-9]{40,64}$/);
    assert.notEqual(other.worktree_root, captured.worktree_root);
    assert.notEqual(other.source_commit, captured.source_commit);
    const untrackedPaths = Array.from({ length: 101 }, (_, index) =>
      path.join(repository, `untracked-${index}.txt`),
    );
    await Promise.all(
      untrackedPaths.map((filePath) => writeFile(filePath, "untracked\n")),
    );
    const manyChanges = await captureVerificationSource(repository);
    assert.equal(manyChanges.porcelain_status.length, 101);
    await Promise.all(
      untrackedPaths.map((filePath) => rm(filePath, { force: true })),
    );
    await execFileAsync("git", ["-C", repository, "checkout", "--detach"]);
    const detached = await captureVerificationSource(repository);
    assert.equal(detached.source_ref, null);
    assert.equal(detached.source_label, `detached@${captured.source_commit}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-1702 rejects source, package, and strict configuration drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-drift-"));
  const repository = path.join(root, "repository");
  await mkdir(repository);
  try {
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
      "ark-team@example.invalid",
    ]);
    await writeFile(path.join(repository, "tracked.txt"), "clean\n", "utf8");
    await execFileAsync("git", ["-C", repository, "add", "tracked.txt"]);
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "-m",
      "clean source",
    ]);
    const expected = await captureVerificationSource(repository);

    await writeFile(path.join(repository, "tracked.txt"), "dirty\n", "utf8");
    const dirty = await captureVerificationSource(repository);
    assert.throws(
      () => assertVerificationSourceIdentity(dirty, expected),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
    );
    assert.throws(
      () =>
        assertVerificationSourceIdentity(
          {
            ...expected,
            source_commit: "f".repeat(40),
          },
          expected,
        ),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
    );
    for (const changedIdentity of [
      { ...expected, source_ref: "refs/heads/other" },
      { ...expected, source_label: "changed label" },
      { ...expected, source_tree: "e".repeat(40) },
    ]) {
      assert.throws(
        () => assertVerificationSourceIdentity(changedIdentity, expected),
        (error: unknown) =>
          error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
      );
    }
    assert.throws(
      () => assertVerificationPackageFingerprint("f".repeat(64)),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "PACKAGE_FINGERPRINT_MISMATCH",
    );
    const baselineDrift = validVerificationCoordinatorConfig();
    baselineDrift.baseline_identity.source_commit = expected.source_commit;
    baselineDrift.baseline_identity.source_tree = "f".repeat(40);
    assert.throws(
      () =>
        buildVerificationRunSnapshot({
          run_id: "ark-20260726t180000z-abc123",
          project_path: repository,
          artifact_root: path.join(root, "artifacts"),
          server_port: 10_001,
          created_at_utc: "2026-07-26T18:00:00.000Z",
          package_fingerprint:
            APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
          source: expected,
          config: baselineDrift,
        }),
      (error: unknown) =>
        error instanceof ArkTeamError && error.code === "SOURCE_DRIFT",
    );
    const approvedPackageBytes = await readFile(
      path.resolve("docs", "slices", "SLICE-017.md"),
    );
    assert.doesNotThrow(() =>
      assertVerificationPackageBytes(approvedPackageBytes),
    );
    assert.throws(
      () =>
        assertVerificationPackageBytes(
          Buffer.concat([approvedPackageBytes, Buffer.from("\n")]),
        ),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "PACKAGE_FINGERPRINT_MISMATCH",
    );

    const duplicateCapability = validVerificationCoordinatorConfig();
    duplicateCapability.required_capabilities = ["api", "api"];
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(duplicateCapability).success,
      false,
    );
    const shellCommand = validVerificationCoordinatorConfig();
    shellCommand.server_argv = ["bash", "-c", "npm run dev"];
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(shellCommand).success,
      false,
    );
    const blankCommand = validVerificationCoordinatorConfig();
    blankCommand.server_argv = ["   "];
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(blankCommand).success,
      false,
    );
    const encodedTraversal = validVerificationCoordinatorConfig();
    encodedTraversal.api_probes[0]!.path = "/%2e%2e/admin";
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(encodedTraversal).success,
      false,
    );
    const inlineQuery = validVerificationCoordinatorConfig();
    inlineQuery.browser_cases[0]!.path = "/ok?token=hunter2";
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(inlineQuery).success,
      false,
    );
    const encodedControl = validVerificationCoordinatorConfig();
    encodedControl.server_readiness_path = "/%00";
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(encodedControl).success,
      false,
    );
    const credentialArgument = validVerificationCoordinatorConfig();
    credentialArgument.server_argv = ["server", "--token", "hunter2"];
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(credentialArgument).success,
      false,
    );
    const missingRequiredCapabilities = validVerificationCoordinatorConfig();
    missingRequiredCapabilities.required_capabilities = ["semantic_review"];
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(
        missingRequiredCapabilities,
      ).success,
      false,
    );
    const outOfBoundsRegion = validVerificationCoordinatorConfig();
    outOfBoundsRegion.critical_regions = [
      {
        id: "outside",
        x: 374,
        y: 0,
        width: 2,
        height: 1,
      },
    ];
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(outOfBoundsRegion).success,
      false,
    );
    const unknownField = {
      ...validVerificationCoordinatorConfig(),
      unknown: true,
    };
    assert.equal(
      verificationCoordinatorConfigSchema.safeParse(unknownField).success,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-1704 validates linked v1 records and deterministic snapshot hashes", () => {
  assert.equal(APPROVED_VERIFICATION_PACKAGE.package_id, "verification-spec-v2");
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] }),
    '{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
  );
  assert.equal(
    canonicalJson({ "ä": 1, a: 2, Z: 3 }),
    '{"Z":3,"a":2,"ä":1}',
  );
  assert.deepEqual(
    Object.keys(
      JSON.parse(
        canonicalJson({ "\u{10000}": 1, "\uE000": 2 }),
      ) as Record<string, unknown>,
    ),
    ["\uE000", "\u{10000}"],
  );
  assert.equal(
    sha256CanonicalJson({ b: 2, a: 1 }),
    sha256CanonicalJson({ a: 1, b: 2 }),
  );
  assert.notEqual(
    APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    APPROVED_VERIFICATION_SPEC_SHA256,
  );

  const snapshot = buildVerificationRunSnapshot({
    run_id: "ark-20260726t180000z-abc123",
    project_path: "/tmp/ark-team-project",
    artifact_root:
      "/tmp/ark-team-state/ark-20260726t180000z-abc123/verification",
    server_port: 10_001,
    created_at_utc: "2026-07-26T18:00:00.000Z",
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    source: validVerificationSourceIdentity(),
    config: validVerificationCoordinatorConfig(),
  });
  assert.equal(snapshot.schema_version, 1);
  assert.equal(snapshot.stage, "snapshotted");
  assert.equal(snapshot.server.api_origin, "http://dev:10001");
  assert.deepEqual(snapshot.artifact_references, []);
  assert.match(verificationRunSnapshotSha256(snapshot), /^[a-f0-9]{64}$/);

  const snapshotPayload = {
    kind: "snapshot" as const,
    snapshot_sha256: verificationRunSnapshotSha256(snapshot),
  };
  const linkedRecord = {
    schema_version: 1 as const,
    record_id: "record-1704",
    record_type: "snapshot" as const,
    run_id: snapshot.run_id,
    case_id: snapshot.case_id,
    snapshot_id: snapshot.snapshot_id,
    stage: "snapshotted" as const,
    timestamp_utc: snapshot.created_at_utc,
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    required: true,
    previous_record_sha256: null,
    payload_sha256: sha256CanonicalJson(snapshotPayload),
    payload: snapshotPayload,
    adapter: null,
    artifact_references: [],
  };
  assert.equal(
    verificationLinkedRecordSchema.safeParse(linkedRecord).success,
    true,
  );
  assert.equal(
    verificationLinkedRecordSchema.safeParse({
      ...linkedRecord,
      case_id: "",
      stage: "unknown",
    }).success,
    false,
  );
  const appended = appendVerificationLinkedRecord([], linkedRecord);
  const nextRecord = {
    ...linkedRecord,
    record_id: "record-1704-next",
    previous_record_sha256: sha256CanonicalJson(linkedRecord),
  };
  assert.equal(
    appendVerificationLinkedRecord(appended, nextRecord).length,
    2,
  );
  assert.throws(
    () =>
      appendVerificationLinkedRecord(appended, {
        ...nextRecord,
        previous_record_sha256: null,
      }),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_RECORD",
  );

  const unlinked = structuredClone(snapshot);
  unlinked.baseline_identity.id = "different-baseline";
  assert.equal(verificationRunSnapshotSchema.safeParse(unlinked).success, false);

  const stalePackage = structuredClone(snapshot);
  stalePackage.package.package_fingerprint = "f".repeat(64);
  assert.equal(
    verificationRunSnapshotSchema.safeParse(stalePackage).success,
    false,
  );
});

test("TEST-1704 validates every closed linked-record payload", () => {
  const sha = "c".repeat(64);
  const artifactReference = {
    artifact_id: "artifact-1704",
    relative_path: "screenshots/home/375x812.actual.png",
    sha256: sha,
  };
  const cases = [
    {
      record_type: "source",
      payload: { kind: "source", source_sha256: sha },
      adapter: null,
      artifact_references: [],
    },
    {
      record_type: "config",
      payload: { kind: "config", config_sha256: sha },
      adapter: null,
      artifact_references: [],
    },
    {
      record_type: "snapshot",
      payload: { kind: "snapshot", snapshot_sha256: sha },
      adapter: null,
      artifact_references: [],
    },
    {
      record_type: "capability",
      payload: {
        kind: "capability",
        capability: "browser",
        available: true,
        version: "1.0.0",
      },
      adapter: { name: "playwright-cli", version: "1.0.0" },
      artifact_references: [],
    },
    {
      record_type: "request",
      payload: {
        kind: "request",
        method: "GET",
        path: "/",
        expected_status: 200,
        actual_status: 200,
        request_sha256: sha,
        response_sha256: sha,
      },
      adapter: { name: "curl", version: "8.0.0" },
      artifact_references: [],
    },
    {
      record_type: "browser",
      payload: { kind: "browser", case_sha256: sha, action_count: 0 },
      adapter: { name: "playwright-cli", version: "1.0.0" },
      artifact_references: [],
    },
    {
      record_type: "screenshot",
      payload: {
        kind: "screenshot",
        viewport: "375x812",
        width: 375,
        height: 812,
        image_sha256: sha,
      },
      adapter: { name: "playwright-cli", version: "1.0.0" },
      artifact_references: [artifactReference],
    },
    {
      record_type: "review",
      payload: { kind: "review", outcome: "passed", image_sha256: sha },
      adapter: { name: "local-image", version: "active-turn" },
      artifact_references: [artifactReference],
    },
    {
      record_type: "comparison",
      payload: {
        kind: "comparison",
        outcome: "passed",
        baseline_sha256: sha,
        actual_sha256: sha,
        diff_sha256: sha,
      },
      adapter: { name: "pixel-compare", version: "1" },
      artifact_references: [artifactReference],
    },
    {
      record_type: "artifact",
      payload: {
        kind: "artifact",
        artifact_id: artifactReference.artifact_id,
        relative_path: artifactReference.relative_path,
        media_type: "image/png",
        byte_length: 1,
        sha256: sha,
      },
      adapter: null,
      artifact_references: [artifactReference],
    },
    {
      record_type: "error",
      payload: {
        kind: "error",
        code: "SOURCE_DRIFT",
        message: "source changed",
      },
      adapter: null,
      artifact_references: [],
    },
    {
      record_type: "report",
      payload: {
        kind: "report",
        outcome: "error",
        evidence_record_ids: ["record-source"],
      },
      adapter: null,
      artifact_references: [],
    },
    {
      record_type: "rollback",
      payload: {
        kind: "rollback",
        contract_id: "verification_contract_v1",
        new_starts_enabled: false,
        preserves_existing_records: true,
        reason: "operator rollback",
      },
      adapter: null,
      artifact_references: [],
    },
    {
      record_type: "spec_delta",
      payload: {
        kind: "spec_delta",
        status: "SPEC_DELTA_REQUIRED",
        runtime_status: "not_started",
        affected_ids: ["REQ-1701"],
        classification: "omission",
        source_snapshot: {
          worktree_root: "/tmp/project",
          commit: "a".repeat(40),
          tree: "b".repeat(40),
          package_fingerprint: sha,
        },
        evidence: [
          { kind: "bounded-observation", value: "required field missing" },
        ],
        impact: "verification cannot start",
        proposed_resolution: "approve a complete field contract",
        blocking_stage: "IS-1701",
        created_at_utc: "2026-07-26T18:00:00.000Z",
      },
      adapter: null,
      artifact_references: [],
    },
  ] as const;

  cases.forEach((recordCase, index) => {
    assert.equal(
      verificationLinkedRecordSchema.safeParse({
        schema_version: 1,
        record_id: `record-${index}`,
        record_type: recordCase.record_type,
        run_id: "ark-20260726t180000z-abc123",
        case_id: "BOOTSTRAP-1701",
        snapshot_id: "snapshot-1701",
        stage: "snapshotted",
        timestamp_utc: "2026-07-26T18:00:00.000Z",
        source_fingerprint: sha,
        package_fingerprint: sha,
        required: true,
        previous_record_sha256: null,
        payload_sha256: sha256CanonicalJson(recordCase.payload),
        payload: recordCase.payload,
        adapter: recordCase.adapter,
        artifact_references: recordCase.artifact_references,
      }).success,
      true,
      recordCase.record_type,
    );
  });
  const capabilityCase = cases.find(
    (recordCase) => recordCase.record_type === "capability",
  );
  assert.notEqual(capabilityCase, undefined);
  if (capabilityCase !== undefined) {
    assert.equal(
      verificationLinkedRecordSchema.safeParse({
        schema_version: 1,
        record_id: "record-blank-adapter",
        record_type: capabilityCase.record_type,
        run_id: "ark-20260726t180000z-abc123",
        case_id: "BOOTSTRAP-1701",
        snapshot_id: "snapshot-1701",
        stage: "snapshotted",
        timestamp_utc: "2026-07-26T18:00:00.000Z",
        source_fingerprint: sha,
        package_fingerprint: sha,
        required: true,
        previous_record_sha256: null,
        payload_sha256: sha256CanonicalJson(capabilityCase.payload),
        payload: capabilityCase.payload,
        adapter: { name: "playwright-cli", version: "   " },
        artifact_references: [],
      }).success,
      false,
    );
  }
});
