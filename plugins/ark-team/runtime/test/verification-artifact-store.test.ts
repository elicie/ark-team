import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { deflateSync } from "node:zlib";

import type { RunRecord } from "../src/domain.js";
import { ArkTeamError } from "../src/errors.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import { VerificationArtifactStore } from "../src/verification-artifact-store.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  canonicalJson,
  sha256CanonicalJson,
  type VerificationApprovedBaselineManifest,
  type VerificationLinkedRecord,
  verificationApprovedBaselineManifestSchema,
  verificationBaselineSetSha256,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const TERMINAL_REPORT_AT = Date.parse("2026-07-27T18:00:00.000Z");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FILE_BYTES = 50 * 1_024 * 1_024;

let testRoot: string;
let stateRoot: string;
let projectRoot: string;
let runSequence: number;

interface MutableClock {
  value: Date;
}

interface BaselineFixture {
  config: ReturnType<typeof validVerificationCoordinatorConfig>;
  manifest: VerificationApprovedBaselineManifest;
  manifestPath: string;
  objectBytes: Map<string, Buffer>;
  baselineSetSha256: string;
}

const loadApprovedVerificationPackage = () =>
  readFile(path.resolve("docs", "slices", "SLICE-017.md"));

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "ark-team-artifact-test-"));
  stateRoot = path.join(testRoot, "state");
  projectRoot = path.join(testRoot, "project");
  runSequence = 0;
  await mkdir(projectRoot);
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("TEST-1706 registers one exact root and rejects unsafe or invalid writes", async () => {
  const { store, run } = await createSnapshottedRun();
  const snapshot = requireV2Snapshot(run);
  const expectedRoot = path.join(stateRoot, run.run_id, "verification");
  assert.equal(snapshot.artifact_root, expectedRoot);
  assert.equal((await lstat(expectedRoot)).isDirectory(), true);
  assert.equal((await lstat(expectedRoot)).isSymbolicLink(), false);

  await assert.rejects(
    () =>
      new VerificationArtifactStore({
        state_root: stateRoot,
        project_root: projectRoot,
        snapshot: {
          ...snapshot,
          artifact_root: `${snapshot.artifact_root}/../verification`,
        } as never,
      }).registerRoot(),
    isArkError("ARTIFACT_ROOT_INVALID"),
  );

  const outside = path.join(testRoot, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(expectedRoot, "escape"));

  const smallBytes = Buffer.from("bounded evidence\n", "utf8");
  const invalidWrites: Array<{
    input: Parameters<RunStore["writeVerificationArtifact"]>[1];
    code: ArkTeamError["code"];
  }> = [
    {
      input: {
        artifact_id: "traversal",
        relative_path: "../escaped.txt",
        media_type: "text/plain",
        bytes: smallBytes,
        sha256: sha256Bytes(smallBytes),
        lane: null,
      },
      code: "ARTIFACT_ROOT_INVALID",
    },
    {
      input: {
        artifact_id: "noncanonical",
        relative_path: "notes/./result.txt",
        media_type: "text/plain",
        bytes: smallBytes,
        sha256: sha256Bytes(smallBytes),
        lane: null,
      },
      code: "ARTIFACT_ROOT_INVALID",
    },
    {
      input: {
        artifact_id: "symlink-escape",
        relative_path: "escape/result.txt",
        media_type: "text/plain",
        bytes: smallBytes,
        sha256: sha256Bytes(smallBytes),
        lane: null,
      },
      code: "ARTIFACT_ROOT_INVALID",
    },
    {
      input: {
        artifact_id: "empty",
        relative_path: "notes/empty.txt",
        media_type: "text/plain",
        bytes: Buffer.alloc(0),
        sha256: sha256Bytes(Buffer.alloc(0)),
        lane: null,
      },
      code: "INVALID_RECORD",
    },
    {
      input: {
        artifact_id: "missing-hash",
        relative_path: "notes/missing-hash.txt",
        media_type: "text/plain",
        bytes: smallBytes,
        sha256: undefined as never,
        lane: null,
      },
      code: "INVALID_RECORD",
    },
    {
      input: {
        artifact_id: "wrong-hash",
        relative_path: "notes/wrong-hash.txt",
        media_type: "text/plain",
        bytes: smallBytes,
        sha256: "0".repeat(64),
        lane: null,
      },
      code: "INVALID_RECORD",
    },
    {
      input: {
        artifact_id: "gif",
        relative_path: "screenshots/home-browser/375x812.actual.gif",
        media_type: "image/gif",
        bytes: smallBytes,
        sha256: sha256Bytes(smallBytes),
        lane: "ui",
      } as never,
      code: "INVALID_RECORD",
    },
    {
      input: {
        artifact_id: "general-zip",
        relative_path: "traces/home-browser/arbitrary.zip",
        media_type: "application/zip",
        bytes: zipWithEntry("trace.txt", smallBytes),
        sha256: sha256Bytes(zipWithEntry("trace.txt", smallBytes)),
        lane: "ui",
      },
      code: "INVALID_RECORD",
    },
    {
      input: {
        artifact_id: "malformed-png",
        relative_path: "screenshots/home-browser/malformed.actual.png",
        media_type: "image/png",
        bytes: Buffer.from("89504e470d0a1a0a", "hex"),
        sha256: sha256Bytes(Buffer.from("89504e470d0a1a0a", "hex")),
        lane: "ui",
      },
      code: "INVALID_RECORD",
    },
    {
      input: {
        artifact_id: "malformed-trace",
        relative_path:
          "traces/home-browser/malformed.playwright-trace.zip",
        media_type: "application/zip",
        bytes: Buffer.from("504b0304", "hex"),
        sha256: sha256Bytes(Buffer.from("504b0304", "hex")),
        lane: "ui",
      },
      code: "INVALID_RECORD",
    },
  ];
  for (const invalid of invalidWrites) {
    await assert.rejects(
      () => store.writeVerificationArtifact(run.run_id, invalid.input),
      (error: unknown) => {
        assert.ok(error instanceof ArkTeamError);
        assert.equal(
          error.code,
          invalid.code,
          `${invalid.input.artifact_id}: ${error.message}`,
        );
        return true;
      },
      invalid.input.artifact_id,
    );
  }
  await assert.rejects(
    () =>
      store.writeVerificationArtifact(run.run_id, {
        artifact_id: "blocked-by-unregistered-entry",
        relative_path: "notes/otherwise-valid.txt",
        media_type: "text/plain",
        bytes: smallBytes,
        sha256: sha256Bytes(smallBytes),
        lane: null,
      }),
    isArkError("ARTIFACT_ROOT_INVALID"),
  );
  await rm(path.join(expectedRoot, "escape"));

  const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
  await assert.rejects(
    () =>
      store.writeVerificationArtifact(run.run_id, {
        artifact_id: "oversized",
        relative_path: "notes/oversized.txt",
        media_type: "text/plain",
        bytes: oversized,
        sha256: sha256Bytes(oversized),
        lane: null,
      }),
    isArkError("INVALID_RECORD"),
  );
  assert.equal(await pathExists(path.join(testRoot, "escaped.txt")), false);
  assert.equal((await store.getRun(run.run_id)).verification_records.length, 3);

  const checkoutStateRoot = path.join(projectRoot, ".ark-team-state");
  const checkoutStore = makeStore(
    checkoutStateRoot,
    projectRoot,
    { value: new Date(TERMINAL_REPORT_AT) },
  );
  const checkoutRun = await checkoutStore.createRun({
    objective: "Reject output inside the selected checkout",
    project_path: projectRoot,
    project_config: verificationProjectConfig(
      validVerificationCoordinatorConfig(),
    ),
  });
  assert.equal(
    (
      await checkoutStore.advanceVerificationState(
        checkoutRun.run_id,
        "configured",
      )
    ).accepted,
    true,
  );
  await assert.rejects(
    () =>
      checkoutStore.recordVerificationSnapshot(checkoutRun.run_id, {
        package_fingerprint:
          APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        server_port: 10_001,
      }),
    isArkError("ARTIFACT_ROOT_INVALID"),
  );
});

test("TEST-1706 stores supported evidence as linked, hashed, opaque bytes", async () => {
  const { store, run } = await createSnapshottedRun();
  const snapshot = requireV2Snapshot(run);
  const png = pngWithIhdr(375, 812);
  const traceEscape = path.join(projectRoot, "trace-escape.txt");
  const trace = zipWithEntry("../../../../project/trace-escape.txt", "blocked\n");
  const artifacts = [
    {
      artifact_id: "actual-375",
      relative_path: "screenshots/home-browser/375x812.actual.png",
      media_type: "image/png" as const,
      bytes: png,
      lane: "ui" as const,
      image_metadata: { width: 375, height: 812 },
    },
    {
      artifact_id: "agentic-result",
      relative_path: "agentic/home-agentic/result.json",
      media_type: "application/json" as const,
      bytes: Buffer.from('{"status":"completed"}\n', "utf8"),
      lane: "ui" as const,
      image_metadata: null,
    },
    {
      artifact_id: "agentic-actions",
      relative_path: "agentic/home-agentic/actions.jsonl",
      media_type: "application/x-ndjson" as const,
      bytes: Buffer.from('{"action":"snapshot"}\n', "utf8"),
      lane: "ui" as const,
      image_metadata: null,
    },
    {
      artifact_id: "bounded-note",
      relative_path: "notes/result.txt",
      media_type: "text/plain" as const,
      bytes: Buffer.from("bounded result\n", "utf8"),
      lane: null,
      image_metadata: null,
    },
    {
      artifact_id: "playwright-trace",
      relative_path:
        "traces/home-browser/attempt-1.playwright-trace.zip",
      media_type: "application/zip" as const,
      bytes: trace,
      lane: "ui" as const,
      image_metadata: null,
    },
  ];

  for (const artifact of artifacts) {
    const result = await store.writeVerificationArtifact(run.run_id, {
      artifact_id: artifact.artifact_id,
      relative_path: artifact.relative_path,
      media_type: artifact.media_type,
      bytes: artifact.bytes,
      sha256: sha256Bytes(artifact.bytes),
      lane: artifact.lane,
    });
    assert.equal(result.record.payload.kind, "artifact");
    if (
      result.record.schema_version !== 2 ||
      result.record.payload.kind !== "artifact"
    ) {
      assert.fail("artifact writer returned a non-artifact record");
    }
    assert.equal(result.record.payload.sha256, sha256Bytes(artifact.bytes));
    assert.equal(result.record.payload.byte_length, artifact.bytes.byteLength);
    assert.deepEqual(
      "image_metadata" in result.record.payload
        ? result.record.payload.image_metadata
        : undefined,
      artifact.image_metadata,
    );
    assert.deepEqual(
      await readFile(path.join(snapshot.artifact_root, artifact.relative_path)),
      artifact.bytes,
    );
    assert.deepEqual(result.record.artifact_references, [
      {
        artifact_id: artifact.artifact_id,
        relative_path: artifact.relative_path,
        sha256: sha256Bytes(artifact.bytes),
      },
    ]);
  }

  const reopened = await store.getRun(run.run_id);
  const artifactRecords = reopened.verification_records.filter(
    (record) => record.payload.kind === "artifact",
  );
  assert.equal(artifactRecords.length, 5);
  assert.equal(
    artifactRecords.reduce(
      (total, record) =>
        total +
        (record.payload.kind === "artifact"
          ? record.payload.byte_length
          : 0),
      0,
    ),
    artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0),
  );
  assert.equal(await pathExists(traceEscape), false);
});

test("TEST-1706 verifies but never mutates an approved baseline set", async () => {
  const baseline = await provisionBaseline();
  const { store, run } = await createSnapshottedRun({
    config: baseline.config,
  });
  const verified = await store.verifyApprovedBaseline(run.run_id);
  assert.deepEqual(verified.manifest, baseline.manifest);
  assert.equal(verified.baseline_set_sha256, baseline.baselineSetSha256);
  assert.equal(
    verified.manifest_sha256,
    sha256Bytes(Buffer.from(canonicalJson(baseline.manifest), "utf8")),
  );

  const firstEntry = baseline.manifest.entries[0]!;
  const firstObjectPath = path.join(
    projectRoot,
    ".ark-team",
    "baselines",
    firstEntry.path,
  );
  const firstObjectBytes = baseline.objectBytes.get(firstEntry.path)!;

  await chmod(firstObjectPath, 0o644);
  await writeFile(firstObjectPath, Buffer.from("tampered PNG", "utf8"));
  await chmod(firstObjectPath, 0o444);
  await assert.rejects(
    () => store.verifyApprovedBaseline(run.run_id),
    isArkError("BASELINE_NOT_APPROVED"),
  );
  await replaceReadOnlyFile(firstObjectPath, firstObjectBytes);

  for (const writablePath of [baseline.manifestPath, firstObjectPath]) {
    await chmod(writablePath, 0o644);
    await assert.rejects(
      () => store.verifyApprovedBaseline(run.run_id),
      isArkError("BASELINE_NOT_APPROVED"),
    );
    await chmod(writablePath, 0o444);
  }

  const objectBackup = `${firstObjectPath}.backup`;
  await rename(firstObjectPath, objectBackup);
  await symlink(objectBackup, firstObjectPath);
  await assert.rejects(
    () => store.verifyApprovedBaseline(run.run_id),
    isArkError("BASELINE_NOT_APPROVED"),
  );
  await rm(firstObjectPath);
  await rename(objectBackup, firstObjectPath);

  const manifestBackup = `${baseline.manifestPath}.backup`;
  await rename(baseline.manifestPath, manifestBackup);
  const replacement = {
    ...baseline.manifest,
    entries: baseline.manifest.entries.slice(1),
  };
  await writeFile(
    baseline.manifestPath,
    canonicalJson(replacement),
    { mode: 0o444 },
  );
  await assert.rejects(
    () => store.verifyApprovedBaseline(run.run_id),
    isArkError("BASELINE_NOT_APPROVED"),
  );
  await rm(baseline.manifestPath);
  await rename(manifestBackup, baseline.manifestPath);

  const driftConfig = structuredClone(baseline.config);
  assert.equal(driftConfig.ui.enabled, true);
  if (!driftConfig.ui.enabled) {
    assert.fail("fixture UI lane must be enabled");
  }
  driftConfig.ui.baseline_identity.sha256 = "0".repeat(64);
  const driftRun = await createSnapshottedRun({ config: driftConfig });
  await assert.rejects(
    () => driftRun.store.verifyApprovedBaseline(driftRun.run.run_id),
    isArkError("BASELINE_NOT_APPROVED"),
  );

  assert.deepEqual(
    await readFile(baseline.manifestPath),
    Buffer.from(canonicalJson(baseline.manifest), "utf8"),
  );
  assert.deepEqual(await readFile(firstObjectPath), firstObjectBytes);
  assert.equal((await stat(baseline.manifestPath)).mode & 0o222, 0);
  assert.equal((await stat(firstObjectPath)).mode & 0o222, 0);
});

test("TEST-1706 retains before the boundary and cleans only the registered root", async () => {
  const baseline = await provisionBaseline();
  const success = await createCleanupRun(baseline.config, "success");
  const successSnapshot = requireV2Snapshot(success.reported);
  const runDirectory = path.dirname(successSnapshot.artifact_root);
  const sentinel = path.join(runDirectory, "preserve.txt");
  await writeFile(sentinel, "preserve\n", "utf8");
  const baselineBefore = await readFile(baseline.manifestPath);
  const terminalBefore = terminalReport(success.reported);

  success.clock.value = new Date(
    TERMINAL_REPORT_AT + RETENTION_MS - 1,
  );
  const retained = await success.store.cleanupVerificationArtifacts(
    success.reported.run_id,
  );
  assert.equal(retained.record.payload.kind, "cleanup");
  assert.equal(
    retained.record.payload.kind === "cleanup"
      ? retained.record.payload.disposition
      : null,
    "retention_active",
  );
  assert.equal(retained.audit, null);
  assert.equal(await pathExists(successSnapshot.artifact_root), true);
  const retainedAgain = await success.store.cleanupVerificationArtifacts(
    success.reported.run_id,
  );
  assert.equal(retainedAgain.record.record_id, retained.record.record_id);
  assert.equal(retainedAgain.run.revision, retained.run.revision);
  assert.equal(
    retainedAgain.run.verification_records.filter(
      (record) =>
        record.payload.kind === "cleanup" &&
        record.payload.disposition === "retention_active",
    ).length,
    1,
  );

  success.clock.value = new Date(TERMINAL_REPORT_AT + RETENTION_MS);
  const cleaned = await success.store.cleanupVerificationArtifacts(
    success.reported.run_id,
  );
  assert.equal(cleaned.record.payload.kind, "cleanup");
  assert.equal(
    cleaned.record.payload.kind === "cleanup"
      ? cleaned.record.payload.disposition
      : null,
    "cleaned",
  );
  assert.equal(cleaned.audit?.status, "cleaned");
  assert.equal(cleaned.audit?.destructive_attempt, 1);
  assert.equal(cleaned.audit?.terminal_outcome, "passed");
  assert.equal(await pathExists(successSnapshot.artifact_root), false);
  assert.equal(
    await pathExists(`${successSnapshot.artifact_root}.cleanup-pending`),
    false,
  );
  assert.equal(await pathExists(sentinel), true);
  assert.deepEqual(await readFile(baseline.manifestPath), baselineBefore);
  assert.deepEqual(terminalReport(cleaned.run), terminalBefore);

  const persisted = JSON.parse(
    await readFile(path.join(runDirectory, "run.json"), "utf8"),
  ) as { run: RunRecord };
  assert.equal(persisted.run.verification_cleanup_audit?.status, "cleaned");
  assert.equal(
    pathIsInside(
      persisted.run.verification_snapshot?.artifact_root ?? "",
      path.join(runDirectory, "run.json"),
    ),
    false,
  );
  const cleanedAgain = await success.store.cleanupVerificationArtifacts(
    success.reported.run_id,
  );
  assert.equal(cleanedAgain.record.record_id, cleaned.record.record_id);
  assert.equal(cleanedAgain.audit?.destructive_attempt, 1);

  const pending = await createCleanupRun(baseline.config, "pending");
  const pendingSnapshot = requireV2Snapshot(pending.reported);
  pending.clock.value = new Date(TERMINAL_REPORT_AT + RETENTION_MS);
  const initiallyCleaned = await pending.store.cleanupVerificationArtifacts(
    pending.reported.run_id,
  );
  assert.notEqual(initiallyCleaned.audit, null);
  const pendingRunPath = path.join(
    path.dirname(pendingSnapshot.artifact_root),
    "run.json",
  );
  const pendingState = JSON.parse(
    await readFile(pendingRunPath, "utf8"),
  ) as { run: RunRecord };
  pendingState.run.verification_records =
    pendingState.run.verification_records.filter(
      (record) =>
        !(
          record.payload.kind === "cleanup" &&
          record.payload.disposition !== "retention_active"
        ),
    );
  pendingState.run.verification_cleanup_audit = {
    ...initiallyCleaned.audit!,
    status: "pending",
    completed_at_utc: null,
    error_code: null,
    error_message: null,
  };
  await writeFile(
    pendingRunPath,
    `${JSON.stringify(pendingState, null, 2)}\n`,
    "utf8",
  );
  const pendingBytes = Buffer.from("pending artifact\n", "utf8");
  const cleanupResidue = `${pendingSnapshot.artifact_root}.cleanup-pending`;
  await mkdir(path.join(cleanupResidue, "root", "notes"), {
    recursive: true,
  });
  await writeFile(
    path.join(cleanupResidue, "root", "notes", "pending.txt"),
    pendingBytes,
  );
  const pendingError = await pending.store.cleanupVerificationArtifacts(
    pending.reported.run_id,
  );
  assert.equal(
    pendingError.record.payload.kind === "cleanup"
      ? pendingError.record.payload.disposition
      : null,
    "cleanup_error",
  );
  assert.equal(pendingError.audit?.destructive_attempt, 1);
  assert.deepEqual(
    await readFile(
      path.join(cleanupResidue, "root", "notes", "pending.txt"),
    ),
    pendingBytes,
  );

  const moved = await createCleanupRun(baseline.config, "moved");
  const movedSnapshot = requireV2Snapshot(moved.reported);
  const movedRoot = `${movedSnapshot.artifact_root}-moved`;
  await rename(movedSnapshot.artifact_root, movedRoot);
  moved.clock.value = new Date(TERMINAL_REPORT_AT + RETENTION_MS);
  const movedError = await moved.store.cleanupVerificationArtifacts(
    moved.reported.run_id,
  );
  assert.equal(
    movedError.record.payload.kind === "cleanup"
      ? movedError.record.payload.disposition
      : null,
    "cleanup_error",
  );
  assert.equal(movedError.audit?.status, "cleanup_error");
  assert.equal(await pathExists(movedRoot), true);
  assert.deepEqual(
    terminalReport(movedError.run),
    terminalReport(moved.reported),
  );

  const linked = await createCleanupRun(baseline.config, "symlink");
  const linkedSnapshot = requireV2Snapshot(linked.reported);
  const linkedOutside = path.join(testRoot, "linked-artifacts");
  await rename(linkedSnapshot.artifact_root, linkedOutside);
  await writeFile(path.join(linkedOutside, "outside-sentinel.txt"), "safe\n");
  await symlink(linkedOutside, linkedSnapshot.artifact_root);
  linked.clock.value = new Date(TERMINAL_REPORT_AT + RETENTION_MS);
  const linkedError = await linked.store.cleanupVerificationArtifacts(
    linked.reported.run_id,
  );
  assert.equal(
    linkedError.record.payload.kind === "cleanup"
      ? linkedError.record.payload.disposition
      : null,
    "cleanup_error",
  );
  assert.equal(linkedError.audit?.status, "cleanup_error");
  assert.equal((await lstat(linkedSnapshot.artifact_root)).isSymbolicLink(), true);
  assert.equal(
    await readFile(path.join(linkedOutside, "outside-sentinel.txt"), "utf8"),
    "safe\n",
  );
  assert.deepEqual(await readFile(baseline.manifestPath), baselineBefore);
});

async function createSnapshottedRun(options: {
  config?: ReturnType<typeof validVerificationCoordinatorConfig>;
  root?: string;
  project?: string;
  clock?: MutableClock;
} = {}) {
  const root = options.root ?? stateRoot;
  const project = options.project ?? projectRoot;
  const clock = options.clock ?? {
    value: new Date(TERMINAL_REPORT_AT),
  };
  const store = makeStore(root, project, clock);
  const config =
    options.config ?? validVerificationCoordinatorConfig();
  const created = await store.createRun({
    objective: "Verify artifact and baseline security",
    project_path: project,
    project_config: verificationProjectConfig(config),
  });
  assert.equal(
    (await store.advanceVerificationState(created.run_id, "configured"))
      .accepted,
    true,
  );
  const run = await store.recordVerificationSnapshot(created.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    server_port: 10_001,
  });
  return { store, run, clock };
}

function makeStore(
  root: string,
  project: string,
  clock: MutableClock,
): RunStore {
  return new RunStore({
    root_path: root,
    now: () => new Date(clock.value),
    suffix: () => `${runSequence++}`.padStart(6, "0"),
    verification_source_loader: async () =>
      validVerificationSourceIdentity(project),
    verification_package_loader: loadApprovedVerificationPackage,
  });
}

function verificationProjectConfig(
  coordinator: ReturnType<typeof validVerificationCoordinatorConfig>,
) {
  const config = structuredClone(DEFAULT_PROJECT_CONFIG);
  config.verification.coordinator = coordinator;
  return config;
}

function requireV2Snapshot(run: RunRecord) {
  const snapshot = run.verification_snapshot;
  if (snapshot === null || snapshot.schema_version !== 2) {
    throw new Error("test fixture requires a contract-v2 snapshot");
  }
  return snapshot;
}

async function provisionBaseline(): Promise<BaselineFixture> {
  const config = validVerificationCoordinatorConfig();
  assert.equal(config.ui.enabled, true);
  if (!config.ui.enabled) {
    assert.fail("fixture UI lane must be enabled");
  }
  const objectBytes = new Map<string, Buffer>();
  const entries = config.ui.viewports.map((viewport) => {
    const [width, height] = viewport.split("x").map(Number) as [
      number,
      number,
    ];
    const bytes = pngWithIhdr(width, height);
    const sha256 = sha256Bytes(bytes);
    const objectPath = `objects/sha256/${sha256}.png`;
    objectBytes.set(objectPath, bytes);
    return {
      case_id: "home-browser",
      viewport,
      width,
      height,
      path: objectPath,
      sha256,
    };
  });
  const manifest = verificationApprovedBaselineManifestSchema.parse({
    schema_version: 1,
    baseline_id: config.ui.baseline_identity.id,
    approval_id: "11111111-1111-4111-8111-111111111111",
    approver: "local-user",
    approved_at_utc: "2026-07-27T17:00:00.000Z",
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
  const baselineRoot = path.join(projectRoot, ".ark-team", "baselines");
  for (const [relativePath, bytes] of objectBytes) {
    const target = path.join(baselineRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o444 });
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
  return {
    config,
    manifest,
    manifestPath,
    objectBytes,
    baselineSetSha256,
  };
}

async function createCleanupRun(
  config: ReturnType<typeof validVerificationCoordinatorConfig>,
  label: string,
) {
  const clock = { value: new Date(TERMINAL_REPORT_AT) };
  const cleanupConfig = structuredClone(config);
  if (cleanupConfig.ui.enabled) {
    cleanupConfig.ui.agentic_tasks = [];
    cleanupConfig.ui.optional_capabilities = [];
  }
  const fixture = await createSnapshottedRun({
    config: cleanupConfig,
    clock,
  });
  const artifactBytes = Buffer.from(`${label} artifact\n`, "utf8");
  const written = await fixture.store.writeVerificationArtifact(
    fixture.run.run_id,
    {
      artifact_id: `${label}-artifact`,
      relative_path: `notes/${label}.txt`,
      media_type: "text/plain",
      bytes: artifactBytes,
      sha256: sha256Bytes(artifactBytes),
      lane: null,
    },
  );
  const snapshot = requireV2Snapshot(written.run);
  if (!snapshot.backend_contract.enabled || !snapshot.ui_contract.enabled) {
    assert.fail("cleanup fixture requires both verification lanes");
  }
  const backendContract = snapshot.backend_contract;
  const uiContract = snapshot.ui_contract;
  assert.equal(
    (
      await fixture.store.advanceVerificationState(
        written.run.run_id,
        "capabilities",
      )
    ).accepted,
    true,
  );
  await fixture.store.recordVerificationAttempt(written.run.run_id, {
    action_id: `${label}-readiness`,
    kind: "readiness",
    lane: null,
    check_id: null,
    input_sha256: sha256CanonicalJson({ contract: "fixture-readiness" }),
    evidence_record_ids: [],
  });
  const capabilityRecordIds: string[] = [];
  const demands = [
    ...backendContract.required_capabilities.map((capability) => ({
          lane: "backend" as const,
          laneRequired: backendContract.required,
          capability,
          capabilityRequired: true,
        })),
    ...uiContract.required_capabilities.map((capability) => ({
            lane: "ui" as const,
            laneRequired: uiContract.required,
            capability,
            capabilityRequired: true,
          })),
    ...uiContract.optional_capabilities.map((capability) => ({
            lane: "ui" as const,
            laneRequired: uiContract.required,
            capability,
            capabilityRequired: false,
          })),
  ];
  let readinessRun = written.run;
  for (const [index, demand] of demands.entries()) {
    const payload = {
      kind: "capability" as const,
      capability: demand.capability,
      available: true,
      version: "1.0.0",
      diagnostic: "fixture capability available",
    };
    const record = await fixture.store.appendVerificationRecord(
      written.run.run_id,
      {
        schema_version: 2,
        contract_id: "verification_contract_v2",
        record_id: `${label}-capability-${index}`,
        record_type: "capability",
        run_id: written.run.run_id,
        case_id: snapshot.case_id,
        check_id: null,
        snapshot_id: snapshot.snapshot_id,
        lane: demand.lane,
        stage: "capabilities",
        timestamp_utc: new Date(TERMINAL_REPORT_AT).toISOString(),
        source_fingerprint: snapshot.source_fingerprint,
        package_fingerprint: snapshot.package.package_fingerprint,
        lane_required: demand.laneRequired,
        check_required: demand.capabilityRequired,
        previous_record_sha256: sha256CanonicalJson(
          readinessRun.verification_records.at(-1),
        ),
        payload_sha256: sha256CanonicalJson(payload),
        payload,
        adapter: { name: "fixture-probe", version: "1.0.0" },
        model: null,
        artifact_references: [],
      },
    );
    readinessRun = record;
    capabilityRecordIds.push(record.verification_records.at(-1)!.record_id);
  }
  await fixture.store.completeVerificationAttempt(written.run.run_id, {
    action_id: `${label}-readiness`,
    evidence_record_ids: capabilityRecordIds,
    error_code: null,
    message: null,
  });
  for (const stage of ["ready", "executing"] as const) {
    assert.equal(
      (
        await fixture.store.advanceVerificationState(
          written.run.run_id,
          stage,
        )
      ).accepted,
      true,
    );
  }
  const backendProbe = snapshot.backend_contract.api_probes[0];
  const browserCase = snapshot.ui_contract.browser_cases[0];
  if (backendProbe === undefined || browserCase === undefined) {
    assert.fail("cleanup fixture requires one check per lane");
  }
  const backendPayload = {
    kind: "request" as const,
    method: backendProbe.method,
    path: backendProbe.path,
    expected_status: backendProbe.expected_status,
    actual_status: backendProbe.expected_status,
    request_sha256: "c".repeat(64),
    response_sha256: "d".repeat(64),
  };
  const readyRun = await fixture.store.getRun(written.run.run_id);
  const backendRecord: VerificationLinkedRecord = {
    schema_version: 2,
    contract_id: "verification_contract_v2",
    record_id: `${label}-backend-request`,
    record_type: "request",
    run_id: written.run.run_id,
    case_id: snapshot.case_id,
    check_id: backendProbe.id,
    snapshot_id: snapshot.snapshot_id,
    lane: "backend",
    stage: "executing",
    timestamp_utc: new Date(TERMINAL_REPORT_AT).toISOString(),
    source_fingerprint: snapshot.source_fingerprint,
    package_fingerprint: snapshot.package.package_fingerprint,
    lane_required: snapshot.backend_contract.required,
    check_required: backendProbe.required,
    previous_record_sha256: sha256CanonicalJson(
      readyRun.verification_records.at(-1),
    ),
    payload_sha256: sha256CanonicalJson(backendPayload),
    payload: backendPayload,
    adapter: {
      name: snapshot.backend_contract.api_adapter,
      version: snapshot.backend_contract.api_adapter_version,
    },
    model: null,
    artifact_references: [],
  };
  const withBackend = await fixture.store.appendVerificationRecord(
    written.run.run_id,
    backendRecord,
  );
  const uiPayload = {
    kind: "browser" as const,
    case_sha256: sha256CanonicalJson(browserCase),
    action_count: browserCase.actions.length,
    assertion_count: browserCase.assertions.length,
  };
  const uiRecord: VerificationLinkedRecord = {
    ...backendRecord,
    record_id: `${label}-ui-browser`,
    record_type: "browser",
    lane: "ui",
    check_id: browserCase.id,
    lane_required: snapshot.ui_contract.required,
    check_required: browserCase.required,
    previous_record_sha256: sha256CanonicalJson(
      withBackend.verification_records.at(-1),
    ),
    payload_sha256: sha256CanonicalJson(uiPayload),
    payload: uiPayload,
    adapter: {
      name: snapshot.ui_contract.deterministic_adapter,
      version: snapshot.ui_contract.deterministic_adapter_version,
    },
  };
  const withEvidence = await fixture.store.appendVerificationRecord(
    written.run.run_id,
    uiRecord,
  );
  for (const stage of ["collecting", "deciding"] as const) {
    const advanced = await fixture.store.advanceVerificationState(
      written.run.run_id,
      stage,
    );
    assert.equal(advanced.accepted, true);
  }
  const reported = await fixture.store.finalizeVerification(
    written.run.run_id,
    {
      lanes: [
        {
          lane: "backend",
          checks: snapshot.backend_contract.enabled
            ? snapshot.backend_contract.api_probes.map((probe) => ({
                check_id: probe.id,
                required: probe.required,
                outcome: "passed" as const,
                evidence_record_ids: [backendRecord.record_id],
                integrity_failure: false,
              }))
            : [],
        },
        {
          lane: "ui",
          checks: snapshot.ui_contract.enabled
            ? [
                ...snapshot.ui_contract.browser_cases.map((browserCase) => ({
                  check_id: browserCase.id,
                  required: browserCase.required,
                  outcome: "passed" as const,
                  evidence_record_ids: [uiRecord.record_id],
                  integrity_failure: false,
                })),
              ]
            : [],
        },
      ],
    },
  );
  assert.equal(withEvidence.verification_state?.current_state, "executing");
  return { ...fixture, reported };
}

function terminalReport(run: RunRecord): VerificationLinkedRecord {
  const reports = run.verification_records.filter(
    (record) => record.payload.kind === "report",
  );
  assert.equal(reports.length, 1);
  return reports[0]!;
}

function pngWithIhdr(width: number, height: number): Buffer {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.byteLength,
  );
  return chunk;
}

function zipWithEntry(
  rawName: string,
  rawBytes: Uint8Array | string,
): Buffer {
  const name = Buffer.from(rawName, "utf8");
  const bytes =
    typeof rawBytes === "string"
      ? Buffer.from(rawBytes, "utf8")
      : Buffer.from(rawBytes);
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.byteLength, 18);
  local.writeUInt32LE(bytes.byteLength, 22);
  local.writeUInt16LE(name.byteLength, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.byteLength, 20);
  central.writeUInt32LE(bytes.byteLength, 24);
  central.writeUInt16LE(name.byteLength, 28);
  const centralOffset =
    local.byteLength + name.byteLength + bytes.byteLength;
  const centralSize = central.byteLength + name.byteLength;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, bytes, central, name, end]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function replaceReadOnlyFile(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  await chmod(target, 0o644);
  await writeFile(target, bytes);
  await chmod(target, 0o444);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isArkError(code: ArkTeamError["code"]) {
  return (error: unknown) =>
    error instanceof ArkTeamError && error.code === code;
}
