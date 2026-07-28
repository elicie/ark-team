import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import { stringify } from "smol-toml";

import {
  createVerificationBrowserDriverV2Request,
} from "../src/verification-browser-adapter.js";
import {
  DEFAULT_PROJECT_CONFIG,
  loadProjectConfig,
  type ProjectConfig,
} from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  buildVerificationRunSnapshot,
  canonicalJson,
  captureVerificationSource,
  verificationApprovedBaselineManifestSchema,
  verificationBaselineSetSha256,
  verificationCoordinatorConfigV2Schema,
  type VerificationApprovedBaselineManifest,
  type VerificationCoordinatorConfigV2,
  type VerificationProjectCoordinatorConfigV2,
  type VerificationSourceIdentity,
} from "../src/verification-contract.js";
import { VerificationCoordinator } from "../src/verification-coordinator.js";
import {
  createLocalBackendVerificationRuntime,
} from "../src/verification-local-runtime.js";
import {
  executeVerificationPlaywrightBrowserDriverV2,
  VERIFICATION_PLAYWRIGHT_ADAPTER,
  VERIFICATION_PLAYWRIGHT_BROWSER_BUILD,
} from "../src/verification-playwright-runtime.js";
import { inspectVerificationPng } from "../src/verification-png.js";
import type { VerificationScreenshotRuntimeImage } from "../src/verification-visual-adapter.js";
import { validVerificationCoordinatorConfig } from "./verification-fixture.js";

const execFileAsync = promisify(execFile);
const viewports = ["375x812", "768x1024", "1440x900"] as const;

test(
  "UIR-TEST-006/008 qa-smoke resolves a tracked selector and runs a real both-lane gate",
  { concurrency: false, timeout: 180_000 },
  async (t) => {
    const initialRuntime = createLocalBackendVerificationRuntime();
    if (initialRuntime.curl_version === null) {
      t.skip("curl is unavailable");
      return;
    }
    const curlVersion = initialRuntime.curl_version;
    try {
      const probe = await initialRuntime.playwright_probe();
      assert.equal(probe.available, true, probe.reason ?? undefined);
    } finally {
      await initialRuntime.stop();
    }

    const projectVerification = createSmokeVerification(curlVersion);
    const fixture = await createSmokeProject(t, projectVerification);
    const resolvedVerification = resolveSmokeVerification(
      projectVerification,
      fixture.source,
    );
    const baseline = await provisionApprovedBaseline(
      fixture,
      resolvedVerification,
    );

    const passed = await runSmokeGate(
      fixture,
      "qa-smoke-pass",
    );
    assert.equal(
      passed.verification_state?.terminal_outcome,
      "passed",
      JSON.stringify(
        {
          state: passed.verification_state,
          errors: passed.verification_records.filter(
            (record) =>
              record.schema_version === 2 &&
              record.payload.kind === "error",
          ),
        },
        null,
        2,
      ),
    );
    assert.equal(passed.verification_state?.current_state, "pm_review_pending");
    assert.equal(passed.verification_snapshot?.schema_version, 2);
    assert.equal(passed.verification_snapshot?.server.host, "devbox");
    assert.equal(passed.verification_snapshot?.server.bind, "0.0.0.0");
    assert.ok((passed.verification_snapshot?.server.port ?? 0) >= 10_001);
    const passedCoordinator =
      passed.project_config.verification.coordinator;
    if (
      passedCoordinator === null ||
      passedCoordinator.schema_version !== 2 ||
      !passedCoordinator.enabled ||
      !passedCoordinator.ui.enabled ||
      !("baseline_selector" in passedCoordinator.ui)
    ) {
      assert.fail("qa-smoke project config did not retain its selector");
    }
    assert.equal(passedCoordinator.ui.baseline_selector.id, "qa-smoke-v1");
    assert.equal(
      "source_commit" in passedCoordinator.ui.baseline_selector,
      false,
    );
    assert.equal(
      passed.verification_snapshot?.baseline_identity?.sha256,
      resolvedVerification.ui.enabled
        ? resolvedVerification.ui.baseline_identity.sha256
        : null,
    );
    assert.equal(
      passed.verification_snapshot?.resolved_config.ui.enabled &&
        "baseline_selector" in passed.verification_snapshot.resolved_config.ui,
      false,
    );
    assert.equal(recordCount(passed, "request"), 1);
    assert.equal(recordCount(passed, "browser"), 1);
    assert.equal(recordCount(passed, "screenshot"), 3);
    assert.equal(recordCount(passed, "comparison"), 3);
    assert.equal(recordCount(passed, "lane_summary"), 2);
    assert.equal(recordCount(passed, "report"), 1);
    assert.deepEqual(
      passed.verification_records
        .filter(
          (record) =>
            record.schema_version === 2 &&
            record.payload.kind === "screenshot",
        )
        .map((record) =>
          record.schema_version === 2 &&
          record.payload.kind === "screenshot"
            ? record.payload.viewport
            : "",
        )
        .sort(),
      [...viewports].sort(),
    );
    await assertBaselineUnchanged(baseline);
    await assertPortCanBind(passed.verification_snapshot?.server.port ?? 0);

    const failingVerification = structuredClone(resolvedVerification);
    if (!failingVerification.ui.enabled) {
      assert.fail("qa-smoke UI lane is disabled");
    }
    failingVerification.ui.browser_cases[0]!.assertions = [
      {
        kind: "accessibility_snapshot",
        sha256: "0".repeat(64),
      },
    ];
    const failed = await runSmokeGate(
      fixture,
      "qa-smoke-fail",
      failingVerification,
    );
    assert.equal(failed.verification_state?.terminal_outcome, "failed");
    assert.equal(recordCount(failed, "request"), 1);
    assert.equal(recordCount(failed, "screenshot"), 0);
    assert.equal(recordCount(failed, "comparison"), 0);
    const browserAttempt = failed.verification_state?.attempts.find(
      (attempt) =>
        attempt.kind === "browser" &&
        attempt.check_id === "qa-home",
    );
    assert.equal(browserAttempt?.attempt_count, 2);
    assert.equal(browserAttempt?.status, "exhausted");
    await assertBaselineUnchanged(baseline);
    await assertPortCanBind(failed.verification_snapshot?.server.port ?? 0);
  },
);

interface SmokeFixture {
  readonly root: string;
  readonly project_root: string;
  readonly source: VerificationSourceIdentity;
}

interface BaselineSnapshot {
  readonly paths: readonly string[];
  readonly sha256: readonly string[];
}

async function createSmokeProject(
  t: TestContext,
  verification: VerificationProjectCoordinatorConfigV2,
): Promise<SmokeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-qa-smoke-"));
  const projectRoot = path.join(root, "project");
  await cp(path.resolve("examples", "qa-smoke"), projectRoot, {
    recursive: true,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const projectConfig = structuredClone(DEFAULT_PROJECT_CONFIG);
  projectConfig.verification.coordinator = verification;
  await writeProjectConfig(projectRoot, projectConfig);
  await execFileAsync("git", ["init", "-b", "main"], {
    cwd: projectRoot,
  });
  await execFileAsync("git", ["config", "user.name", "Ark QA"], {
    cwd: projectRoot,
  });
  await execFileAsync("git", ["config", "user.email", "qa@example.invalid"], {
    cwd: projectRoot,
  });
  await execFileAsync("git", ["add", "."], { cwd: projectRoot });
  await execFileAsync("git", ["commit", "-m", "QA smoke fixture"], {
    cwd: projectRoot,
  });
  await execFileAsync(
    "git",
    ["ls-files", "--error-unmatch", ".codex/team-orchestrator.toml"],
    { cwd: projectRoot },
  );

  const source = await captureVerificationSource(projectRoot);
  assert.equal(source.worktree_state, "GIT_CLEAN");
  await mkdir(path.join(projectRoot, "docs", "slices"), {
    recursive: true,
  });
  await copyFile(
    path.resolve("docs", "slices", "SLICE-017.md"),
    path.join(projectRoot, "docs", "slices", "SLICE-017.md"),
  );
  return { root, project_root: projectRoot, source };
}

function createSmokeVerification(
  curlVersion: string,
): VerificationProjectCoordinatorConfigV2 {
  const verification = validVerificationCoordinatorConfig();
  verification.server_argv = ["npm", "run", "dev"];
  verification.server_readiness_path = "/health";
  if (!verification.backend.enabled || !verification.ui.enabled) {
    throw new Error("qa-smoke requires both verification lanes");
  }
  verification.backend.api_adapter_version = curlVersion;
  verification.backend.api_probes = [
    {
      id: "qa-health",
      method: "GET",
      path: "/health",
      query: {},
      headers: { accept: "application/json" },
      body_digest: "none",
      expected_status: 200,
      expected_content_type: "application/json",
      required: true,
    },
  ];
  verification.ui.deterministic_adapter_version =
    VERIFICATION_PLAYWRIGHT_ADAPTER.version;
  verification.ui.browser_build = VERIFICATION_PLAYWRIGHT_BROWSER_BUILD;
  verification.ui.browser_cases = [
    {
      id: "qa-home",
      path: "/",
      readiness: "body",
      actions: [],
      assertions: [
        {
          kind: "visible",
          role: "heading",
          name: "QA Smoke",
        },
      ],
      required: true,
    },
  ];
  verification.ui.semantic_review_required = false;
  verification.ui.agentic_tasks = [];
  verification.ui.required_capabilities = [
    "browser",
    "comparison",
    "screenshot",
    "server",
  ];
  verification.ui.optional_capabilities = ["semantic_review"];
  const { baseline_identity: baselineIdentity, ...ui } = verification.ui;
  return {
    ...verification,
    ui: {
      ...ui,
      baseline_selector: {
        id: "qa-smoke-v1",
        environment: baselineIdentity.environment,
      },
    },
  };
}

function resolveSmokeVerification(
  verification: VerificationProjectCoordinatorConfigV2,
  source: VerificationSourceIdentity,
): VerificationCoordinatorConfigV2 {
  if (
    !verification.ui.enabled ||
    !("baseline_selector" in verification.ui)
  ) {
    throw new Error("qa-smoke requires an enabled baseline selector");
  }
  const { baseline_selector: selector, ...ui } = verification.ui;
  return verificationCoordinatorConfigV2Schema.parse({
    ...verification,
    ui: {
      ...ui,
      baseline_identity: {
        id: selector.id,
        sha256: "0".repeat(64),
        source_commit: source.source_commit,
        source_tree: source.source_tree,
        environment: selector.environment,
      },
    },
  });
}

async function provisionApprovedBaseline(
  fixture: SmokeFixture,
  verification: VerificationCoordinatorConfigV2,
): Promise<BaselineSnapshot> {
  if (!verification.ui.enabled) {
    throw new Error("qa-smoke baseline requires an enabled UI lane");
  }
  const port = await firstFreePort();
  const server = await startFixtureServer(fixture.project_root, port);
  let screenshots: readonly VerificationScreenshotRuntimeImage[] = [];
  try {
    const snapshot = buildVerificationRunSnapshot({
      run_id: "ark-20260728t000000z-qasmok",
      project_path: fixture.project_root,
      artifact_root: path.join(fixture.root, "capture-artifacts"),
      server_port: port,
      created_at_utc: "2026-07-28T00:00:00.000Z",
      package_fingerprint:
        APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
      source: fixture.source,
      config: verification,
    });
    const request = createVerificationBrowserDriverV2Request({
      snapshot,
      case_id: "qa-home",
      attempt_id: "qa-baseline-capture",
    });
    const result = await executeVerificationPlaywrightBrowserDriverV2(
      request,
    );
    screenshots = result.screenshot.screenshots;
  } finally {
    await stopFixtureServer(server);
  }

  const entries = screenshots.map((screenshot) => {
    const dimensions = inspectVerificationPng(screenshot.bytes);
    assert.equal(dimensions.bit_depth, 8);
    assert.equal(
      dimensions.color_type,
      2,
      `Playwright emitted PNG color type ${dimensions.color_type}`,
    );
    assert.equal(dimensions.interlace, 0);
    const sha256 = sha256Bytes(screenshot.bytes);
    return {
      case_id: "qa-home",
      viewport: screenshot.viewport,
      width: dimensions.width,
      height: dimensions.height,
      path: `objects/sha256/${sha256}.png`,
      sha256,
    };
  });
  const manifest: VerificationApprovedBaselineManifest =
    verificationApprovedBaselineManifestSchema.parse({
      schema_version: 1,
      baseline_id: verification.ui.baseline_identity.id,
      approval_id: "qa-smoke-approval",
      approver: "ark-team-test",
      approved_at_utc: "2026-07-28T00:01:00.000Z",
      source_commit: fixture.source.source_commit,
      source_tree: fixture.source.source_tree,
      environment: verification.ui.baseline_identity.environment,
      adapter: {
        name: verification.ui.deterministic_adapter,
        version: verification.ui.deterministic_adapter_version,
      },
      browser_build: verification.ui.browser_build,
      entries,
    });
  const baselineSetSha256 = verificationBaselineSetSha256(manifest);
  verification.ui.baseline_identity.sha256 = baselineSetSha256;
  const baselineRoot = path.join(
    fixture.project_root,
    verification.ui.baseline_root,
  );
  const paths: string[] = [];
  for (const [index, entry] of manifest.entries.entries()) {
    const target = path.join(baselineRoot, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, screenshots[index]!.bytes, {
      flag: "wx",
      mode: 0o444,
    });
    paths.push(target);
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
  paths.push(manifestPath);
  return {
    paths,
    sha256: await Promise.all(
      paths.map(async (filePath) => sha256Bytes(await readFile(filePath))),
    ),
  };
}

async function runSmokeGate(
  fixture: SmokeFixture,
  stateName: string,
  verificationOverride?: VerificationCoordinatorConfigV2,
) {
  const resolved = await loadProjectConfig(fixture.project_root);
  const source = await captureVerificationSource(fixture.project_root);
  assert.equal(source.worktree_state, "GIT_CLEAN");
  assert.equal(source.source_commit, fixture.source.source_commit);
  assert.equal(source.source_tree, fixture.source.source_tree);

  const store = new RunStore({
    root_path: path.join(fixture.root, stateName),
  });
  const projectConfig = structuredClone(resolved.config);
  if (verificationOverride !== undefined) {
    projectConfig.verification.coordinator = verificationOverride;
  }
  const run = await store.createRun({
    objective: stateName,
    project_path: fixture.project_root,
    project_config: projectConfig,
  });
  const runtime = createLocalBackendVerificationRuntime();
  const coordinator = new VerificationCoordinator(store);
  coordinator.registerLocalRuntime(runtime.runtime);
  try {
    const result = await coordinator.runBootstrap(run.run_id, {
      package_fingerprint:
        APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
      server: {
        framework: "other",
        allowed_dev_origins: [],
      },
      ui_evidence_source: "approved_store",
      semantic_checklist_by_case: {
        "qa-home": {
          identity: "ark-ui-semantic-checklist",
          version: "1.0.0",
        },
      },
    });
    if (result.status !== "completed") {
      assert.fail(`qa-smoke produced SPEC_DELTA: ${JSON.stringify(result.delta)}`);
    }
    assert.equal(result.status, "completed");
    return result.run;
  } finally {
    await runtime.stop();
  }
}

async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const target = path.join(
    projectRoot,
    ".codex",
    "team-orchestrator.toml",
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, stringify(config), "utf8");
}

function recordCount(
  run: Awaited<ReturnType<typeof runSmokeGate>>,
  kind: string,
): number {
  return run.verification_records.filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === kind,
  ).length;
}

async function assertBaselineUnchanged(
  baseline: BaselineSnapshot,
): Promise<void> {
  assert.deepEqual(
    await Promise.all(
      baseline.paths.map(async (filePath) =>
        sha256Bytes(await readFile(filePath)),
      ),
    ),
    baseline.sha256,
  );
  for (const filePath of baseline.paths) {
    const metadata = await stat(filePath);
    assert.equal(metadata.mode & 0o222, 0);
  }
}

async function firstFreePort(): Promise<number> {
  for (let port = 10_001; port <= 10_100; port += 1) {
    const available = await new Promise<boolean>((resolve, reject) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          resolve(false);
        } else {
          reject(error);
        }
      });
      server.listen(port, "0.0.0.0", () => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve(true);
          }
        });
      });
    });
    if (available) {
      return port;
    }
  }
  throw new Error("no qa-smoke port is available at 10001-10100");
}

async function startFixtureServer(
  projectRoot: string,
  port: number,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectRoot,
    env: {
      HOST: "0.0.0.0",
      PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errors: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(Buffer.from(chunk)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `qa-smoke server exited early: ${Buffer.concat(errors).toString("utf8")}`,
      );
    }
    try {
      if ((await probeFixtureServer(port)) === 200) {
        return child;
      }
    } catch {
      // The bounded readiness loop retries until the child listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stopFixtureServer(child);
  throw new Error("qa-smoke server readiness timed out");
}

async function probeFixtureServer(port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        headers: { host: `devbox:${port}` },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function stopFixtureServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  let timeout: NodeJS.Timeout | undefined;
  const exited = await Promise.race([
    new Promise<boolean>((resolve) =>
      child.once("exit", () => resolve(true)),
    ),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 2_000);
      timeout.unref();
    }),
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
  }
}

async function assertPortCanBind(port: number): Promise<void> {
  assert.ok(port >= 10_001);
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
