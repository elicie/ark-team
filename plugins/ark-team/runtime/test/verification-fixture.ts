import { createHash } from "node:crypto";

import type {
  VerificationCoordinatorConfigV2,
  VerificationSourceIdentity,
} from "../src/verification-contract.js";
import { sha256CanonicalJson } from "../src/verification-contract.js";

export const FIXTURE_SOURCE_COMMIT = "a".repeat(40);
export const FIXTURE_SOURCE_TREE = "b".repeat(40);

export function validVerificationSourceIdentity(
  worktreeRoot = "/tmp/ark-team-project",
): VerificationSourceIdentity {
  return {
    worktree_root: worktreeRoot,
    source_label: "refs/heads/main",
    source_ref: "refs/heads/main",
    source_commit: FIXTURE_SOURCE_COMMIT,
    source_tree: FIXTURE_SOURCE_TREE,
    worktree_state: "GIT_CLEAN",
    porcelain_status: [],
    capture_method: "git-literal-argv-v1",
    captured_at_utc: "2026-07-26T18:00:00.000Z",
  };
}

export function validVerificationCoordinatorConfig(): VerificationCoordinatorConfigV2 {
  const systemPrompt = "로컬 UI를 탐색하고 선언된 성공 조건만 확인한다.";
  const checklist = ["선언된 로컬 경로만 사용한다.", "민감정보를 입력하지 않는다."];
  return {
    schema_version: 2,
    contract_id: "verification_contract_v2",
    enabled: true,
    server_argv: ["npm", "run", "dev"],
    server_bind: "0.0.0.0",
    server_host: "dev",
    server_port_floor: 10_001,
    server_readiness_path: "/",
    server_readiness_status: 200,
    server_readiness_timeout_ms: 30_000,
    evidence_limits: {
      console_events: 100,
      network_events: 100,
      metadata_bytes: 64 * 1_024,
      api_preview_bytes: 64 * 1_024,
      file_bytes: 50 * 1_024 * 1_024,
      total_bytes: 500 * 1_024 * 1_024,
      file_count: 500,
    },
    console_bytes: 32 * 1_024,
    network_bytes: 32 * 1_024,
    retention_days: 30,
    retention_anchor: "terminal-report-created-at",
    server_timeout_ms: 30_000,
    api_timeout_ms: 30_000,
    browser_timeout_ms: 60_000,
    case_timeout_ms: 120_000,
    attempts: {
      readiness: 2,
      api: 2,
      browser: 2,
      agentic_browser: 1,
      screenshot: 1,
      comparison: 1,
      semantic_review: 1,
      artifact_write: 1,
      cleanup: 1,
    },
    approval_policy: "explicit-one-time-user-decision",
    backend: {
      enabled: true,
      required: true,
      required_capabilities: ["api", "server"],
      api_adapter: "curl",
      api_adapter_version: "8.14.1",
      api_probes: [
        {
          id: "home-api",
          method: "GET",
          path: "/",
          query: {},
          headers: { accept: "text/html" },
          body_digest: "none",
          expected_status: 200,
          expected_content_type: "text/html",
          required: true,
        },
      ],
    },
    ui: {
      enabled: true,
      required: true,
      required_capabilities: [
        "browser",
        "comparison",
        "screenshot",
        "semantic_review",
        "server",
      ],
      optional_capabilities: ["agentic_browser"],
      deterministic_adapter: "playwright-cli",
      deterministic_adapter_version: "1.62.0",
      browser_build: "chromium-139.0.0",
      browser_cases: [
        {
          id: "home-browser",
          path: "/",
          readiness: "body",
          actions: [],
          assertions: [
            {
              kind: "visible",
              role: "heading",
              name: "Home",
            },
          ],
          required: true,
        },
      ],
      viewports: ["375x812", "768x1024", "1440x900"],
      baseline_root: ".ark-team/baselines",
      baseline_identity: {
        id: "baseline-home-v2",
        sha256: "a".repeat(64),
        source_commit: FIXTURE_SOURCE_COMMIT,
        source_tree: FIXTURE_SOURCE_TREE,
        environment: {
          viewports: ["375x812", "768x1024", "1440x900"],
          device_scale_factor: 1,
          locale: "en-US",
          timezone: "UTC",
          color_scheme: "light",
          reduced_motion: "no-preference",
        },
      },
      pixel_diff_fraction_max: 0.005,
      max_channel_delta: 8,
      critical_regions: [],
      semantic_review_required: true,
      agentic_tasks: [
        {
          id: "home-agentic",
          required: false,
          adapter: "browser-use",
          adapter_version: "0.13.6",
          api_major: "1",
          model_identity: "gpt-5.6-mini",
          browser_build: "chromium-139.0.0",
          start_path: "/",
          goal: "홈 화면의 주요 탐색 경로를 확인한다.",
          success_criteria: [
            {
              kind: "visible",
              role: "heading",
              name: "Home",
            },
          ],
          allowed_actions: [
            "navigate",
            "snapshot",
            "click",
            "type",
            "screenshot",
          ],
          max_steps: 20,
          timeout_ms: 120_000,
          system_prompt_template: systemPrompt,
          checklist,
          prompt_sha256: createHash("sha256")
            .update(systemPrompt, "utf8")
            .digest("hex"),
          checklist_sha256: sha256CanonicalJson(checklist),
        },
      ],
    },
  };
}
