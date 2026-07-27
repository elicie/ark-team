import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import { DEFAULT_PROJECT_CONFIG } from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  sha256CanonicalJson,
  verificationEvidenceDisposition,
  type VerificationActionKind,
  type VerificationCapability,
  type VerificationLinkedRecord,
} from "../src/verification-contract.js";
import {
  VerificationCoordinator,
  type VerificationApprovalRequiredOperation,
  type VerificationCoordinatorRuntime,
} from "../src/verification-coordinator.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const CREATED_AT = "2026-07-27T20:00:00.000Z";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LaneMode = "backend-only" | "ui-only" | "both";

interface ReadinessFixture {
  store: RunStore;
  coordinator: VerificationCoordinator;
  run_id: string;
  root: string;
  state_root: string;
  project_root: string;
  runtime: MutableRuntimeHandlers;
}

type MutableRuntimeHandlers = Omit<
  VerificationCoordinatorRuntime,
  "capability_adapters"
>;

interface CreateFixtureOptions {
  mode?: LaneMode;
  ui_required?: boolean;
  semantic_review_required?: boolean;
  configure?: boolean;
}

test("TEST-1714 preserves required, optional, and disabled capability gates without substitution", async (t) => {
  const cases: Array<{
    name: string;
    mode: LaneMode;
    ui_required?: boolean;
    semantic_review_required?: boolean;
    unavailable: VerificationCapability;
    lane: "backend" | "ui";
    expected_outcome: "unavailable" | "skipped";
    expected_lane_required: boolean;
    expected_capability_required: boolean;
    throws?: boolean;
    action: {
      kind: Extract<
        VerificationActionKind,
        | "api"
        | "browser"
        | "agentic_browser"
        | "screenshot"
        | "semantic_review"
        | "comparison"
      >;
      lane: "backend" | "ui";
      check_id: string;
    };
    discovered: VerificationCapability[];
  }> = [
    {
      name: "required backend API",
      mode: "backend-only",
      unavailable: "api",
      lane: "backend",
      expected_outcome: "unavailable",
      expected_lane_required: true,
      expected_capability_required: true,
      action: { kind: "api", lane: "backend", check_id: "home-api" },
      discovered: ["api", "server"],
    },
    {
      name: "required shared server",
      mode: "both",
      unavailable: "server",
      lane: "backend",
      expected_outcome: "unavailable",
      expected_lane_required: true,
      expected_capability_required: true,
      action: { kind: "api", lane: "backend", check_id: "home-api" },
      discovered: [
        "agentic_browser",
        "api",
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ],
    },
    {
      name: "optional UI agentic check",
      mode: "ui-only",
      unavailable: "agentic_browser",
      lane: "ui",
      expected_outcome: "skipped",
      expected_lane_required: true,
      expected_capability_required: false,
      throws: true,
      action: {
        kind: "agentic_browser",
        lane: "ui",
        check_id: "home-agentic",
      },
      discovered: [
        "agentic_browser",
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ],
    },
    {
      name: "optional UI lane",
      mode: "both",
      ui_required: false,
      unavailable: "browser",
      lane: "ui",
      expected_outcome: "skipped",
      expected_lane_required: false,
      expected_capability_required: true,
      action: { kind: "browser", lane: "ui", check_id: "home-browser" },
      discovered: [
        "agentic_browser",
        "api",
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ],
    },
    {
      name: "required deterministic browser despite agentic availability",
      mode: "ui-only",
      unavailable: "browser",
      lane: "ui",
      expected_outcome: "unavailable",
      expected_lane_required: true,
      expected_capability_required: true,
      action: { kind: "browser", lane: "ui", check_id: "home-browser" },
      discovered: [
        "agentic_browser",
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ],
    },
    ...(
      [
        ["screenshot", "screenshot"],
        ["semantic_review", "semantic_review"],
        ["comparison", "comparison"],
      ] as const
    ).map(([unavailable, kind]) => ({
      name: `required UI ${unavailable}`,
      mode: "ui-only" as const,
      unavailable,
      lane: "ui" as const,
      expected_outcome: "unavailable" as const,
      expected_lane_required: true,
      expected_capability_required: true,
      action: { kind, lane: "ui" as const, check_id: "home-browser" },
      discovered: [
        "agentic_browser",
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ] satisfies VerificationCapability[],
    })),
    {
      name: "optional semantic review on a required browser case",
      mode: "ui-only",
      semantic_review_required: false,
      unavailable: "semantic_review",
      lane: "ui",
      expected_outcome: "skipped",
      expected_lane_required: true,
      expected_capability_required: false,
      action: {
        kind: "semantic_review",
        lane: "ui",
        check_id: "home-browser",
      },
      discovered: [
        "agentic_browser",
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ],
    },
  ];

  for (const capabilityCase of cases) {
    const fixture = await createFixture(t, {
      mode: capabilityCase.mode,
      ...(capabilityCase.ui_required === undefined
        ? {}
        : { ui_required: capabilityCase.ui_required }),
      ...(capabilityCase.semantic_review_required === undefined
        ? {}
        : {
            semantic_review_required:
              capabilityCase.semantic_review_required,
          }),
    });
    assert.equal(
      (await fixture.coordinator.advance(fixture.run_id, "capabilities"))
        .accepted,
      true,
      capabilityCase.name,
    );

    const observed: VerificationCapability[] = [];
    fixture.runtime.capability_probe = async (capability) => {
      observed.push(capability);
      if (
        capabilityCase.throws &&
        capability === capabilityCase.unavailable
      ) {
        throw new Error(
          "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHI",
        );
      }
      const available = capability !== capabilityCase.unavailable;
      return {
        available,
        version: available ? "1.0.0" : null,
        diagnostic: available
          ? "capability detected"
          : `token ${"x".repeat(1_500)}`,
        adapter: {
          name: `probe-${capability}`,
          version: "1.0.0",
        },
      };
    };
    const readiness = await fixture.coordinator.runReadiness(fixture.run_id, {
      action_id: `readiness-${capabilityCase.unavailable}-${capabilityCase.mode}`,
      server: { framework: "nextjs", allowed_dev_origins: ["dev"] },
    });
    assert.equal(readiness.ok, true, capabilityCase.name);
    if (!readiness.ok) {
      assert.fail(`${capabilityCase.name} readiness did not settle`);
    }
    assert.deepEqual(
      [...new Set(observed)].sort(),
      capabilityCase.discovered,
      capabilityCase.name,
    );
    const unavailable = readiness.value.unavailable.find(
      (candidate) =>
        candidate.lane === capabilityCase.lane &&
        candidate.capability === capabilityCase.unavailable,
    );
    assert.deepEqual(
      unavailable,
      {
        lane: capabilityCase.lane,
        capability: capabilityCase.unavailable,
        outcome: capabilityCase.expected_outcome,
      },
      capabilityCase.name,
    );

    const settled = await fixture.store.getRun(fixture.run_id);
    const attempt = settled.verification_state?.attempts.find(
      (candidate) => candidate.kind === "readiness",
    );
    assert.equal(attempt?.status, "succeeded", capabilityCase.name);
    assert.equal(attempt?.attempt_count, 2, capabilityCase.name);
    const decisiveRecords = recordsById(
      settled.verification_records,
      attempt?.decisive_evidence_record_ids ?? [],
    );
    const missingRecord = decisiveRecords.find(
      (record) =>
        record.schema_version === 2 &&
        record.lane === capabilityCase.lane &&
        record.payload.kind === "capability" &&
        record.payload.capability === capabilityCase.unavailable,
    );
    assert.notEqual(missingRecord, undefined, capabilityCase.name);
    if (
      missingRecord === undefined ||
      missingRecord.schema_version !== 2 ||
      missingRecord.payload.kind !== "capability"
    ) {
      assert.fail(`${capabilityCase.name} missing capability record not found`);
    }
    assert.equal(
      missingRecord.lane_required,
      capabilityCase.expected_lane_required,
      capabilityCase.name,
    );
    assert.equal(
      missingRecord.check_required,
      capabilityCase.expected_capability_required,
      capabilityCase.name,
    );
    assert.equal(
      verificationEvidenceDisposition(missingRecord)?.outcome,
      capabilityCase.expected_outcome,
      capabilityCase.name,
    );
    assert.equal(missingRecord.payload.available, false, capabilityCase.name);
    assert.equal(missingRecord.payload.version, null, capabilityCase.name);
    assert.equal(
      missingRecord.payload.diagnostic,
      "verification action failed; diagnostic was redacted",
      capabilityCase.name,
    );
    assert.ok(
      (missingRecord.payload.diagnostic?.length ?? 0) <= 1_000,
      capabilityCase.name,
    );
    assert.equal(missingRecord.adapter?.version, "1.0.0", capabilityCase.name);
    assert.doesNotThrow(
      () => new Date(missingRecord.timestamp_utc).toISOString(),
      capabilityCase.name,
    );
    assert.equal(
      decisiveRecords.some(
        (record) =>
          record.schema_version === 2 &&
          record.lane !== null &&
          ((capabilityCase.mode === "backend-only" &&
            record.lane === "ui") ||
            (capabilityCase.mode === "ui-only" &&
              record.lane === "backend")),
      ),
      false,
      capabilityCase.name,
    );

    if (capabilityCase.unavailable === "browser") {
      const agentic = decisiveRecords.find(
        (record) =>
          record.schema_version === 2 &&
          record.lane === "ui" &&
          record.payload.kind === "capability" &&
          record.payload.capability === "agentic_browser",
      );
      assert.equal(
        agentic?.payload.kind === "capability" &&
          agentic.payload.available,
        true,
        capabilityCase.name,
      );
    }

    for (const stage of ["ready", "executing"] as const) {
      assert.equal(
        (await fixture.coordinator.advance(fixture.run_id, stage)).accepted,
        true,
        `${capabilityCase.name}:${stage}`,
      );
    }
    if (
      capabilityCase.action.kind === "agentic_browser" ||
      capabilityCase.action.kind === "screenshot" ||
      capabilityCase.action.kind === "semantic_review" ||
      capabilityCase.action.kind === "comparison"
    ) {
      assert.equal(
        (await fixture.coordinator.advance(fixture.run_id, "collecting"))
          .accepted,
        true,
        `${capabilityCase.name}:collecting`,
      );
    }
    let dependentEffects = 0;
    const dependent = await fixture.coordinator.runAction(fixture.run_id, {
      action_id: `dependent-${capabilityCase.unavailable}-${capabilityCase.mode}`,
      ...capabilityCase.action,
      input: { capability: capabilityCase.unavailable },
      adapter: async () => {
        dependentEffects += 1;
        return { ok: true, value: "must-not-run" };
      },
    });
    assert.equal(dependent.ok, false, capabilityCase.name);
    if (!dependent.ok) {
      assert.equal(
        dependent.code,
        "CAPABILITY_UNAVAILABLE",
        capabilityCase.name,
      );
      assert.equal(
        dependent.outcome,
        capabilityCase.expected_outcome,
        capabilityCase.name,
      );
    }
    assert.equal(dependentEffects, 0, capabilityCase.name);
  }
});

test("TEST-1715 selects the next free port and retries one registered Next.js server readiness probe", async (t) => {
  const fixture = await createFixture(t, {
    mode: "both",
    configure: false,
  });
  const portChecks: Array<[number, string]> = [];
  fixture.runtime.port_available = async (port, bind) => {
    portChecks.push([port, bind]);
    return port === 10_002;
  };
  const snapshotted = await fixture.coordinator.configureLocal(fixture.run_id, {
    package_fingerprint:
      APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
  });
  assert.deepEqual(portChecks, [
    [10_001, "0.0.0.0"],
    [10_002, "0.0.0.0"],
  ]);
  assert.equal(snapshotted.verification_snapshot?.server.port, 10_002);
  assert.equal(
    snapshotted.verification_snapshot?.server.api_origin,
    "http://dev:10002",
  );
  assert.equal(
    (await fixture.coordinator.advance(fixture.run_id, "capabilities"))
      .accepted,
    true,
  );

  const starts: unknown[] = [];
  const probes: unknown[] = [];
  const statuses = [503, 200];
  fixture.runtime.start_server = async (request) => {
    starts.push(request);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.readiness), true);
    assert.deepEqual(request.argv, ["npm", "run", "dev"]);
    assert.equal(request.cwd, fixture.project_root);
    assert.equal(request.bind, "0.0.0.0");
    assert.equal(request.host, "dev");
    assert.equal(request.port, 10_002);
    assert.equal(request.origin, "http://dev:10002");
    assert.deepEqual(request.readiness, {
      url: "http://dev:10002/",
      expected_status: 200,
      timeout_ms: 30_000,
      redirect: "manual",
      max_redirects: 0,
    });
    assert.match(request.registration.registration_id, /^server-[a-f0-9]{24}$/);
  };
  fixture.runtime.probe_http = async (request) => {
    probes.push(request);
    assert.equal(Object.isFrozen(request), true);
    assert.match(request.registration.registration_id, /^server-[a-f0-9]{24}$/);
    return { status: statuses[probes.length - 1]! };
  };
  const readiness = await fixture.coordinator.runReadiness(fixture.run_id, {
    action_id: "registered-next-readiness",
    server: { framework: "nextjs", allowed_dev_origins: ["dev"] },
  });
  assert.equal(readiness.ok, true);
  if (!readiness.ok) {
    assert.fail("registered Next.js readiness did not converge");
  }
  assert.equal(readiness.value.server_ready, true);
  assert.deepEqual(readiness.value.unavailable, []);
  assert.equal(starts.length, 1);
  assert.equal(probes.length, 2);

  const persisted = await fixture.store.getRun(fixture.run_id);
  const attempt = persisted.verification_state?.attempts.find(
    (candidate) => candidate.action_id === "registered-next-readiness",
  );
  assert.equal(attempt?.attempt_count, 2);
  assert.equal(attempt?.max_attempts, 2);
  assert.equal(attempt?.status, "succeeded");
  assert.ok((attempt?.evidence_record_ids.length ?? 0) > 0);
  assert.ok((attempt?.decisive_evidence_record_ids.length ?? 0) > 0);
  assert.equal(
    attempt?.evidence_record_ids.some(
      (recordId) => !attempt.decisive_evidence_record_ids.includes(recordId),
    ),
    true,
  );
  const decisiveServerRecords = recordsById(
    persisted.verification_records,
    attempt?.decisive_evidence_record_ids ?? [],
  ).filter(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "capability" &&
      record.payload.capability === "server",
  );
  assert.equal(decisiveServerRecords.length, 4);
  assert.equal(
    decisiveServerRecords.every(
      (record) =>
        record.payload.kind === "capability" && record.payload.available,
    ),
    true,
  );
  assert.equal(
    decisiveServerRecords.slice(-2).every(
      (record) =>
        record.schema_version === 2 &&
        record.payload.kind === "capability" &&
        record.payload.diagnostic?.includes("HTTP 200"),
    ),
    true,
  );
});

test("TEST-1714 blocks later dependent work when a capability becomes unavailable", async (t) => {
  const fixture = await createFixture(t, { mode: "backend-only" });
  assert.equal(
    (await fixture.coordinator.advance(fixture.run_id, "capabilities"))
      .accepted,
    true,
  );
  assert.equal(
    (
      await fixture.coordinator.runReadiness(fixture.run_id, {
        action_id: "dynamic-readiness",
        server: { framework: "other", allowed_dev_origins: [] },
      })
    ).ok,
    true,
  );
  for (const stage of ["ready", "executing"] as const) {
    assert.equal(
      (await fixture.coordinator.advance(fixture.run_id, stage)).accepted,
      true,
    );
  }
  let firstEffects = 0;
  const first = await fixture.coordinator.runAction(fixture.run_id, {
    action_id: "dynamic-api-unavailable",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: {},
    adapter: async () => {
      firstEffects += 1;
      return {
        ok: false,
        code: "CAPABILITY_UNAVAILABLE",
        capability: "server",
        message: "server adapter disappeared",
      };
    },
  });
  assert.equal(first.ok, false);
  assert.equal(firstEffects, 2);
  const failedRun = await fixture.store.getRun(fixture.run_id);
  const dynamicError = failedRun.verification_records.find(
    (record) =>
      record.schema_version === 2 &&
      record.payload.kind === "error" &&
      record.payload.action_id === "dynamic-api-unavailable",
  );
  assert.equal(
    dynamicError?.schema_version === 2 &&
      dynamicError.payload.kind === "error"
      ? dynamicError.payload.capability
      : null,
    "server",
  );

  let laterEffects = 0;
  const later = await fixture.coordinator.runAction(fixture.run_id, {
    action_id: "dynamic-api-blocked",
    kind: "api",
    lane: "backend",
    check_id: "home-api",
    input: {},
    adapter: async () => {
      laterEffects += 1;
      return { ok: true, value: "must-not-run" };
    },
  });
  assert.equal(later.ok, false);
  assert.equal(laterEffects, 0);
});

test("TEST-1715 rejects unregistered and misconfigured Next.js children before HTTP probing", async (t) => {
  const cases: Array<{
    name: string;
    server: unknown;
  }> = [
    {
      name: "unregistered child",
      server: {
        registered: false,
        framework: "other",
        allowed_dev_origins: [],
      },
    },
    {
      name: "Next.js without dev allowedDevOrigins",
      server: {
        framework: "nextjs",
        allowed_dev_origins: ["localhost"],
      },
    },
  ];

  for (const invalidCase of cases) {
    const fixture = await createFixture(t, { mode: "backend-only" });
    assert.equal(
      (await fixture.coordinator.advance(fixture.run_id, "capabilities"))
        .accepted,
      true,
      invalidCase.name,
    );
    let startCalls = 0;
    let probeCalls = 0;
    fixture.runtime.start_server = async () => {
      startCalls += 1;
    };
    fixture.runtime.probe_http = async () => {
      probeCalls += 1;
      return { status: 200 };
    };
    await assert.rejects(
      () =>
        fixture.coordinator.runReadiness(fixture.run_id, {
          action_id: `invalid-child-${invalidCase.name.replaceAll(" ", "-")}`,
          server: invalidCase.server as never,
        }),
      isArkError("CONFIG_INVALID"),
      invalidCase.name,
    );
    assert.equal(startCalls, 0, invalidCase.name);
    assert.equal(probeCalls, 0, invalidCase.name);
  }
});

test("TEST-1716 stops every dangerous local request before effect and persists one non-resumable approval terminal", async (t) => {
  const allowedFixture = await createFixture(t, { mode: "backend-only" });
  let allowedEffects = 0;
  allowedFixture.runtime.execute_local = async () => {
    allowedEffects += 1;
    return "allowed";
  };
  for (const request of [
    {
      kind: "command" as const,
      argv: ["npm", "run", "dev"],
      cwd: allowedFixture.project_root,
    },
    {
      kind: "network" as const,
      url: "http://dev:10001/health",
    },
  ]) {
    const allowed = await allowedFixture.coordinator.runGuardedLocalEffect(
      allowedFixture.run_id,
      request,
    );
    assert.deepEqual(allowed, { ok: true, value: "allowed" });
  }
  assert.equal(allowedEffects, 2);

  const agenticFixture = await createFixture(t, { mode: "ui-only" });
  let agenticEffects = 0;
  agenticFixture.runtime.execute_local = async () => {
    agenticEffects += 1;
    return "agentic-ready";
  };
  const agentic = await agenticFixture.coordinator.runGuardedLocalEffect(
    agenticFixture.run_id,
    {
      kind: "agentic_session",
      task_id: "home-agentic",
      profile: "fresh_ephemeral",
      origin_allowlist: ["http://dev:10001"],
      allowed_actions: [
        "navigate",
        "snapshot",
        "click",
        "type",
        "screenshot",
      ],
      model_identity: "gpt-5.6-mini",
    },
  );
  assert.deepEqual(agentic, { ok: true, value: "agentic-ready" });
  assert.equal(agenticEffects, 1);

  const approvalOperations = [
    "arbitrary_code",
    "auto_heal",
    "baseline_update",
    "broad_tool",
    "cloud_browser",
    "credential",
    "deployment",
    "destructive",
    "docker",
    "download",
    "extension",
    "external_navigation",
    "file_access",
    "infrastructure",
    "permission",
    "persistent_profile",
    "product_file_change",
    "proxy",
    "raw_reasoning",
    "remote",
    "remote_browser",
    "remote_model",
    "transcript",
    "tunnel",
    "upload",
  ] as const satisfies readonly VerificationApprovalRequiredOperation[];
  const cases: Array<{
    name: string;
    request: (fixture: ReadinessFixture) => unknown;
  }> = [
    ...approvalOperations.map((operation) => ({
      name: operation,
      request: () => ({ kind: "approval_required" as const, operation }),
    })),
    {
      name: "Docker command",
      request: (fixture) => ({
        kind: "command",
        argv: ["docker", "run", "image"],
        cwd: fixture.project_root,
      }),
    },
    ...[
      ["rm", "-rf", "src"],
      ["node", "-e", "process.exit(0)"],
      ["python", "-c", "print('unsafe')"],
      ["/usr/bin/env", "docker", "ps"],
      ["npm", "exec", "docker", "ps"],
      ["cat", "/etc/passwd"],
      ["touch", "src/product-change.ts"],
    ].map((argv) => ({
      name: `unregistered command ${argv.join(" ")}`,
      request: (fixture: ReadinessFixture) => ({
        kind: "command" as const,
        argv,
        cwd: fixture.project_root,
      }),
    })),
    {
      name: "out-of-root command",
      request: (fixture) => ({
        kind: "command",
        argv: ["npm", "run", "dev"],
        cwd: path.join(fixture.root, "outside"),
      }),
    },
    {
      name: "remote network",
      request: () => ({
        kind: "network",
        url: "https://example.invalid/",
      }),
    },
    {
      name: "credential-bearing network",
      request: () => ({
        kind: "network",
        url: "http://user:password@dev:10001/",
      }),
    },
    {
      name: "network unknown headers and proxy",
      request: () => ({
        kind: "network",
        url: "http://dev:10001/",
        headers: { authorization: "Bearer hidden" },
        proxy: "https://example.invalid/",
      }),
    },
    {
      name: "command unknown environment and stdin",
      request: (fixture) => ({
        kind: "command",
        argv: ["npm", "run", "dev"],
        cwd: fixture.project_root,
        env: { TOKEN: "hidden" },
        stdin: "hidden",
      }),
    },
    {
      name: "unsafe agentic descriptor",
      request: () => ({
        kind: "agentic_session",
        task_id: "home-agentic",
        profile: "persistent",
        origin_allowlist: ["https://example.invalid"],
        allowed_actions: ["evaluate"],
        model_identity: "remote-model",
      }),
    },
  ];

  for (const dangerousCase of cases) {
    const fixture = await createFixture(t, { mode: "backend-only" });
    const request = dangerousCase.request(fixture);
    let effects = 0;
    fixture.runtime.execute_local = async () => {
      effects += 1;
      return "must-not-run";
    };
    const denied = await fixture.coordinator.runGuardedLocalEffect(
      fixture.run_id,
      request,
    );
    assert.equal(denied.ok, false, dangerousCase.name);
    if (denied.ok) {
      assert.fail(`${dangerousCase.name} unexpectedly ran`);
    }
    assert.equal(denied.code, "APPROVAL_REQUIRED", dangerousCase.name);
    assert.match(denied.approval_id, UUID_PATTERN, dangerousCase.name);
    assert.equal(
      denied.request_sha256,
      sha256CanonicalJson(request),
      dangerousCase.name,
    );
    assert.equal(effects, 0, dangerousCase.name);

    let terminalPortEffects = 0;
    fixture.runtime.port_available = async () => {
      terminalPortEffects += 1;
      return true;
    };
    await assert.rejects(
      () =>
        fixture.coordinator.configureLocal(fixture.run_id, {
          package_fingerprint:
            APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
        }),
      isArkError("INVALID_TRANSITION"),
      dangerousCase.name,
    );
    assert.equal(terminalPortEffects, 0, dangerousCase.name);

    const persisted = await fixture.store.getRun(fixture.run_id);
    assert.equal(
      persisted.verification_state?.current_state,
      "error",
      dangerousCase.name,
    );
    assert.equal(
      persisted.verification_state?.terminal_outcome,
      "error",
      dangerousCase.name,
    );
    const errors = persisted.verification_records.filter(
      (record) => record.payload.kind === "error",
    );
    const reports = persisted.verification_records.filter(
      (record) => record.payload.kind === "report",
    );
    assert.equal(errors.length, 1, dangerousCase.name);
    assert.equal(reports.length, 1, dangerousCase.name);
    const error = errors[0]!;
    const report = reports[0]!;
    assert.equal(error.schema_version, 2, dangerousCase.name);
    assert.equal(error.payload.kind, "error", dangerousCase.name);
    if (error.schema_version !== 2 || error.payload.kind !== "error") {
      assert.fail(`${dangerousCase.name} approval error is malformed`);
    }
    assert.equal(error.payload.code, "APPROVAL_REQUIRED", dangerousCase.name);
    assert.equal(error.payload.outcome, "error", dangerousCase.name);
    assert.equal(
      error.payload.approval_id,
      denied.approval_id,
      dangerousCase.name,
    );
    assert.equal(
      error.payload.request_sha256,
      denied.request_sha256,
      dangerousCase.name,
    );
    assert.equal(
      error.payload_sha256,
      sha256CanonicalJson(error.payload),
      dangerousCase.name,
    );
    assert.equal(report.payload.kind, "report", dangerousCase.name);
    if (report.payload.kind !== "report") {
      assert.fail(`${dangerousCase.name} terminal report is malformed`);
    }
    assert.equal(report.payload.outcome, "error", dangerousCase.name);
    assert.deepEqual(
      report.payload.evidence_record_ids,
      [error.record_id],
      dangerousCase.name,
    );
    assert.equal(
      report.payload_sha256,
      sha256CanonicalJson(report.payload),
      dangerousCase.name,
    );

    const reopened = new VerificationCoordinator(
      createReopenedStore(fixture),
    );
    let resumeEffects = 0;
    await assert.rejects(
      () =>
        reopened.runGuardedLocalEffect(
          fixture.run_id,
          {
            kind: "network",
            url: "http://dev:10001/",
          },
        ),
      isArkError("INVALID_TRANSITION"),
      dangerousCase.name,
    );
    assert.equal(resumeEffects, 0, dangerousCase.name);
    const reopenedRun = await createReopenedStore(fixture).getRun(
      fixture.run_id,
    );
    assert.equal(
      reopenedRun.verification_records.filter(
        (record) => record.payload.kind === "report",
      ).length,
      1,
      dangerousCase.name,
    );
  }
});

async function createFixture(
  t: TestContext,
  options: CreateFixtureOptions = {},
): Promise<ReadinessFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);

  const coordinatorConfig = validVerificationCoordinatorConfig();
  if (!coordinatorConfig.backend.enabled || !coordinatorConfig.ui.enabled) {
    throw new Error("verification fixture lanes must begin enabled");
  }
  if (options.ui_required !== undefined) {
    coordinatorConfig.ui.required = options.ui_required;
  }
  if (options.semantic_review_required === false) {
    coordinatorConfig.ui.semantic_review_required = false;
    coordinatorConfig.ui.required_capabilities =
      coordinatorConfig.ui.required_capabilities.filter(
        (capability) => capability !== "semantic_review",
      );
    coordinatorConfig.ui.optional_capabilities.push("semantic_review");
  }
  const mode = options.mode ?? "both";
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
    suffix: () => "170400",
    verification_source_loader: async () =>
      validVerificationSourceIdentity(projectRoot),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
  const created = await store.createRun({
    objective: "IS-1704 local verification readiness",
    project_path: projectRoot,
    project_config: projectConfig,
  });
  const coordinator = new VerificationCoordinator(store);
  const runtime: MutableRuntimeHandlers = {
    port_available: async () => true,
    capability_probe: availableCapability,
    start_server: async () => undefined,
    probe_http: async () => ({ status: 200 }),
    execute_local: async () => "allowed",
  };
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
        { name: `probe-${capability}`, version: "1.0.0" },
      ]),
    ) as VerificationCoordinatorRuntime["capability_adapters"],
    port_available: (...args) => runtime.port_available!(...args),
    capability_probe: (...args) => runtime.capability_probe(...args),
    start_server: (...args) => runtime.start_server(...args),
    probe_http: (...args) => runtime.probe_http(...args),
    execute_local: (...args) => runtime.execute_local(...args),
  });
  assert.equal(
    (await coordinator.advance(created.run_id, "configured")).accepted,
    true,
  );
  if (options.configure !== false) {
    await coordinator.configureLocal(created.run_id, {
      package_fingerprint:
        APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
    });
  }
  return {
    store,
    coordinator,
    run_id: created.run_id,
    root,
    state_root: stateRoot,
    project_root: projectRoot,
    runtime,
  };
}

function createReopenedStore(fixture: ReadinessFixture): RunStore {
  return new RunStore({
    root_path: fixture.state_root,
    now: () => new Date(CREATED_AT),
    verification_source_loader: async () =>
      validVerificationSourceIdentity(fixture.project_root),
    verification_package_loader: () =>
      readFile(path.resolve("docs", "slices", "SLICE-017.md")),
  });
}

async function availableCapability(
  capability: VerificationCapability,
): Promise<{
  available: true;
  version: string;
  diagnostic: string;
  adapter: { name: string; version: string };
}> {
  return {
    available: true,
    version: "1.0.0",
    diagnostic: "capability detected",
    adapter: {
      name: `probe-${capability}`,
      version: "1.0.0",
    },
  };
}

function recordsById(
  records: readonly VerificationLinkedRecord[],
  recordIds: readonly string[],
): VerificationLinkedRecord[] {
  const ids = new Set(recordIds);
  return records.filter((record) => ids.has(record.record_id));
}

function isArkError(code: string) {
  return (error: unknown): boolean =>
    error instanceof ArkTeamError && error.code === code;
}
