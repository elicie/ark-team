import type {
  VerificationCoordinatorConfig,
  VerificationSourceIdentity,
} from "../src/verification-contract.js";

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

export function validVerificationCoordinatorConfig(): VerificationCoordinatorConfig {
  return {
    schema_version: 1,
    enabled: true,
    required_capabilities: [
      "server",
      "api",
      "browser",
      "screenshot",
      "semantic_review",
      "comparison",
    ],
    server_argv: ["npm", "run", "dev"],
    server_bind: "0.0.0.0",
    server_host: "dev",
    server_port_floor: 10_001,
    server_readiness_path: "/",
    server_readiness_status: 200,
    server_readiness_timeout_ms: 30_000,
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
    api_adapter: "curl",
    browser_adapter: "playwright-cli",
    browser_cases: [
      {
        id: "home-browser",
        path: "/",
        readiness: "body",
        actions: [],
        required: true,
      },
    ],
    viewports: ["375x812", "768x1024", "1440x900"],
    baseline_root: ".ark-team/baselines",
    baseline_identity: {
      id: "baseline-home-v1",
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
    semantic_review_required: true,
    retention_days: 30,
    server_timeout_ms: 30_000,
    api_timeout_ms: 30_000,
    browser_timeout_ms: 60_000,
    case_timeout_ms: 120_000,
    attempts: {
      readiness: 2,
      api: 2,
      browser: 2,
      screenshot: 1,
      comparison: 1,
      semantic_review: 1,
      artifact_write: 1,
      cleanup: 1,
    },
    approval_policy: "explicit-one-time-user-decision",
  };
}
