import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createVerificationAgenticBrowserRequest,
  normalizeVerificationAgenticBrowserResult,
  VerificationAgenticBrowserContractError,
  type VerificationAgenticBrowserRequest,
  type VerificationAgenticBrowserRuntimeResult,
} from "../src/verification-agentic-browser-adapter.js";
import {
  APPROVED_VERIFICATION_PACKAGE,
  buildVerificationRunSnapshot,
  sha256CanonicalJson,
} from "../src/verification-contract.js";
import {
  validVerificationCoordinatorConfig,
  validVerificationSourceIdentity,
} from "./verification-fixture.js";

const ADAPTERS = [
  {
    name: "browser-use",
    version: "0.13.6",
    api_major: "1",
  },
  {
    name: "playwright-agent",
    version: "1.62.0",
    api_major: "1",
  },
  {
    name: "stagehand",
    version: "3.0.0",
    api_major: "3",
  },
] as const;

test("TEST-1723: 세 계열 fake를 같은 로컬·보조형 계약으로 고정한다", () => {
  for (const adapter of ADAPTERS) {
    const request = createRequest(adapter);
    const normalized = normalizeVerificationAgenticBrowserResult(
      request,
      validResult(request),
    );

    assert.deepEqual(request.adapter, adapter);
    assert.deepEqual(request.origin_allowlist, [request.origin]);
    assert.equal(request.execution.profile, "fresh_ephemeral");
    assert.equal(request.execution.persistent_profile, "disabled");
    assert.equal(request.execution.cloud_browser, "disabled");
    assert.equal(request.execution.remote_browser, "disabled");
    assert.equal(request.execution.tunnel, "disabled");
    assert.equal(request.execution.proxy, "disabled");
    assert.equal(request.execution.separate_remote_model, "disabled");
    assert.equal(request.max_steps, 20);
    assert.equal(request.timeout_ms, 120_000);
    assert.equal(request.policy.advisory_only, true);
    assert.equal(request.policy.deterministic_recheck_required, true);
    assert.equal(
      request.deterministic_postconditions_sha256,
      sha256CanonicalJson(request.success_criteria),
    );

    assert.equal(normalized.evidence.execution_status, "completed");
    assert.equal(normalized.evidence.finding_status, "no_finding");
    assert.equal(normalized.evidence.can_pass_ui_lane, false);
    assert.deepEqual(normalized.evidence.deterministic_recheck, {
      required: true,
      status: "pending",
    });
    assert.equal(normalized.evidence.step_count, 1);
    assert.equal(
      normalized.evidence.ledger_sha256,
      createHash("sha256").update(normalized.ledger_bytes).digest("hex"),
    );
    assert.equal(normalized.evidence.candidates[0]?.applied, false);
  }
});

test("TEST-1723: 입력 바이트·버전·모델·출처 드리프트를 거부한다", () => {
  const request = createRequest(ADAPTERS[0]);
  for (const mutate of [
    (result: MutableResult) => {
      result.task_sha256 = "f".repeat(64);
    },
    (result: MutableResult) => {
      result.input_sha256 = "f".repeat(64);
    },
    (result: MutableResult) => {
      result.adapter.version = "0.14.0";
    },
    (result: MutableResult) => {
      result.adapter.api_major = "2";
    },
    (result: MutableResult) => {
      result.model_identity = "another-model";
    },
    (result: MutableResult) => {
      result.browser_build = "another-browser";
    },
  ]) {
    const result = validResult(request) as MutableResult;
    mutate(result);
    assert.throws(
      () => normalizeVerificationAgenticBrowserResult(request, result),
      isContractError,
    );
  }
});

test("TEST-1723: 미선언 행동·외부 출처·초과 단계·원격 환경을 거부한다", () => {
  const request = createRequest(ADAPTERS[0]);

  const undeclared = validResult(request) as MutableResult;
  (undeclared.ledger[0]! as unknown as { action: string }).action = "evaluate";
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, undeclared),
    isContractError,
  );

  const external = validResult(request) as MutableResult;
  external.ledger[0]!.url = "https://example.com/";
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, external),
    isContractError,
  );

  const excessive = validResult(request) as MutableResult;
  excessive.ledger = Array.from({ length: 21 }, (_, sequence) => ({
    ...structuredClone(excessive.ledger[0]!),
    sequence,
  }));
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, excessive),
    isContractError,
  );

  const remote = {
    ...validResult(request),
    execution: { cloud_browser: true },
  };
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, remote),
    isContractError,
  );
});

test("TEST-1723: 누락·무제한·미지 상태·사고과정 저장을 닫힌 계약으로 거부한다", () => {
  const request = createRequest(ADAPTERS[0]);

  const missing = validResult(request) as MutableResult;
  missing.ledger = [];
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, missing),
    isContractError,
  );

  const unknownStatus = {
    ...validResult(request),
    execution_status: "successful",
  };
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, unknownStatus),
    isContractError,
  );

  const reasoning = {
    ...validResult(request),
    thought: "private chain of thought",
    transcript: ["unbounded conversation"],
  };
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, reasoning),
    isContractError,
  );

  const nestedReasoning = validResult(request) as MutableResult;
  nestedReasoning.ledger[0]!.parameters = {
    thought: "private reasoning",
  };
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, nestedReasoning),
    isContractError,
  );

  const invalidUtc = validResult(request) as MutableResult;
  invalidUtc.ledger[0]!.timestamp_utc = "2026-99-99T99:99:99.000Z";
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, invalidUtc),
    isContractError,
  );

  const findings = validResult(request) as MutableResult;
  findings.finding_status = "finding";
  findings.findings = Array.from({ length: 50 }, () => "가".repeat(400));
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, findings),
    isContractError,
  );
});

test("TEST-1723: 생성 산출물은 적용되지 않은 후보만 허용하고 민감값을 제거한다", () => {
  const request = createRequest(ADAPTERS[2]);
  const result = validResult(request) as MutableResult;
  result.ledger[0]!.parameters = {
    selector: "#login",
    token: "Bearer super-secret-value",
  };
  result.finding_status = "finding";
  result.findings = ["authorization: Bearer super-secret-value"];
  const normalized = normalizeVerificationAgenticBrowserResult(request, result);

  assert.match(
    JSON.stringify(normalized.evidence.ledger[0]?.parameters),
    /REDACTED/,
  );
  assert.match(normalized.evidence.findings[0]!, /REDACTED/);
  assert.equal(normalized.evidence.candidates[0]?.applied, false);

  const applied = validResult(request) as MutableResult;
  (
    applied.candidates[0]! as unknown as { applied: boolean }
  ).applied = true;
  assert.throws(
    () => normalizeVerificationAgenticBrowserResult(request, applied),
    isContractError,
  );
});

function createRequest(adapter: (typeof ADAPTERS)[number]) {
  const config = validVerificationCoordinatorConfig();
  if (!config.ui.enabled) {
    throw new Error("agentic fixture requires an enabled UI lane");
  }
  const task = config.ui.agentic_tasks[0]!;
  task.adapter = adapter.name;
  task.adapter_version = adapter.version;
  task.api_major = adapter.api_major;
  return createVerificationAgenticBrowserRequest({
    snapshot: buildVerificationRunSnapshot({
      run_id: "ark-20260727t120000z-170623",
      project_path: "/tmp/ark-team-project",
      artifact_root:
        "/tmp/ark-team-state/ark-20260727t120000z-170623/verification",
      server_port: 10_001,
      created_at_utc: "2026-07-27T12:00:00.000Z",
      package_fingerprint: APPROVED_VERIFICATION_PACKAGE.package_fingerprint,
      source: validVerificationSourceIdentity(),
      config,
    }),
    task_id: task.id,
    attempt_id: "agentic-attempt-1",
  });
}

function validResult(
  request: VerificationAgenticBrowserRequest,
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
    judge_verdict: "achieved",
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
        timestamp_utc: "2026-07-27T12:00:00.500Z",
      },
    ],
    candidates: [
      {
        kind: "test",
        relative_path: `agentic/${request.task_id}/candidates/test.json`,
        sha256: "c".repeat(64),
        applied: false,
      },
    ],
    started_at_utc: "2026-07-27T12:00:00.000Z",
    finished_at_utc: "2026-07-27T12:00:01.000Z",
    elapsed_ms: 1_000,
  };
}

type MutableResult = {
  -readonly [Key in keyof VerificationAgenticBrowserRuntimeResult]:
    VerificationAgenticBrowserRuntimeResult[Key] extends readonly (infer Item)[]
      ? Array<Item extends object ? { -readonly [K in keyof Item]: Item[K] } : Item>
      : VerificationAgenticBrowserRuntimeResult[Key] extends object
        ? {
            -readonly [K in keyof VerificationAgenticBrowserRuntimeResult[Key]]:
              VerificationAgenticBrowserRuntimeResult[Key][K];
          }
        : VerificationAgenticBrowserRuntimeResult[Key];
} & {
  ledger: Array<{
    sequence: number;
    action: string;
    url: string;
    parameters: Record<string, string | number | boolean | null>;
    result: "completed" | "blocked" | "error";
    error_code: string | null;
    artifact_references: Array<{
      artifact_id: string;
      relative_path: string;
      sha256: string;
    }>;
    timestamp_utc: string;
  }>;
  candidates: Array<{
    kind: "plan" | "locator" | "script" | "test" | "healer_patch" | "baseline";
    relative_path: string;
    sha256: string;
    applied: boolean;
  }>;
  findings: string[];
};

function isContractError(error: unknown): boolean {
  return error instanceof VerificationAgenticBrowserContractError;
}
