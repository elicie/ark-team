# Closed Contract — SLICE-011

- Spec identity: Active completion goal and accepted SLICE-010 at Git revision
  `2bc4c01`.
- Objective: Complete the safe local-Git integration path through a dedicated
  Terra integration PL, independent integration worktree, observable Git
  verification, same Sol PM final review, and guarded fast-forward of the
  unchanged original branch.
- Included requirements:
  - `REQ-1101`: Add a strict `integration_report` contract and a persisted
    integration-PL assignment that uses Terra/xhigh while remaining distinct
    from team PL ownership and team limits.
  - `REQ-1102`: From an all-team-complete Git run, create exactly one linked
    worktree on `orchestrator/<run-id>` at the common recorded base commit.
  - `REQ-1103`: Require the integration PL to combine every preserved team
    branch, run plan-level verification, avoid remote actions, and return the
    integrated commit plus evidence.
  - `REQ-1104`: Independently verify that the integration worktree is clean,
    its HEAD matches the reported commit, and every recorded team-branch tip is
    an ancestor of that HEAD.
  - `REQ-1105`: Apply the existing two-attempt/two-correction policy to the
    integration PL and preserve approval/retry waiting.
  - `REQ-1106`: For `local_merge`, update the original checked-out branch only
    by `--ff-only` after proving its branch, HEAD, and cleanliness still match
    the recorded start boundary.
  - `REQ-1107`: Resume the original Sol/xhigh read-only PM session with all
    team and integration evidence, require one strict `pm_report`, and mark the
    run completed only after a passing PM conclusion.
  - `REQ-1108`: Make the top-level execute/advance path continue automatically
    from team execution through local integration and PM review.
- Acceptance criteria:
  - PM never receives write access and never executes Git mutations.
  - Integration PL cannot count as a fifth team or own workers.
  - A dirty, detached, moved, or advanced original checkout blocks local merge
    without changing it.
  - Missing team ancestry, dirty integration output, mismatched commit, failed
    verification, or blocked reports enter bounded correction/retry flow.
  - `pull_request` remains a verified-local handoff and does not push or create
    a PR in this slice.
  - Integration worktree and team branches remain present after completion;
    cleanup is a later slice.
- Verification cases:
  - `TEST-1101`: Strict integration output and role compatibility.
  - `TEST-1102`: One isolated integration branch/worktree from the common base.
  - `TEST-1103`: Two team tips merged and independently proven as ancestors.
  - `TEST-1104`: Dirty/mismatched integration output fails closed.
  - `TEST-1105`: Integration PL approval, retry, and correction policies.
  - `TEST-1106`: Unchanged original branch fast-forwards; drift and dirtiness
    leave it byte-for-byte/ref-for-ref unchanged.
  - `TEST-1107`: Original PM session resumes with `pm_report` and completes.
  - `TEST-1108`: MCP/top-level coordinator regression.
- Explicit exclusions:
  - Push, pull-request creation, remote merge, deployment, and their approval
    decision.
  - Worktree cleanup, branch deletion, non-Git shadow repositories,
    external-model adapters, direct PL-to-PL message transport, and live
    approval reattachment after process restart.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `2bc4c01`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; 48 unit, 1 CLI, and 4 MCP tests passed.
- Environmental limits: no Docker, infrastructure, port, remote mutation, or
  real paid model call.

# Evidence Matrix

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| `REQ-1101` | `integrationReportSchema`, `integration_pl`, role/profile checks, and durable assignment routing in `role-contracts.ts`, `domain.ts`, `state-store.ts`, and `assignment-scheduler.ts` | `TEST-1101`; all role-contract and scheduler tests pass |
| `REQ-1102` | `IntegrationWorktreeManager.prepare` records the team-start target branch and creates exactly one `orchestrator/<run-id>` linked worktree from the common base | `TEST-1102`; `TEST-1106` also rejects a different original branch at the same HEAD |
| `REQ-1103` | `buildIntegrationAssignment` passes all team branches and plan verification while explicitly prohibiting original-checkout and remote mutations | `TEST-1103`; real temporary Git repositories contain both team commits |
| `REQ-1104` | `IntegrationWorktreeManager.verify` checks registered path, clean state, branch, full reported HEAD, and every team-tip ancestor | `TEST-1103`, `TEST-1104` |
| `REQ-1105` | `IntegrationCoordinator` reuses scheduler approval, fresh-session retry, same-session correction, and durable retry-choice policies | `TEST-1105` approval, correction, and transient-session cases |
| `REQ-1106` | `mergeLocal` rechecks recorded branch, base HEAD, cleanliness, verified integration ref, and uses `git merge --ff-only` | `TEST-1106` fast-forward, dirty checkout, and same-HEAD branch drift cases |
| `REQ-1107` | Integration completion resumes the persisted PM planning session with Sol/xhigh/read-only/never and stores a strict final `pm_report` | `TEST-1107`; PM session ID is unchanged and turn count becomes 2 |
| `REQ-1108` | `ArkTeamRunCoordinator`, `ArkTeamOrchestrator`, and the MCP default wiring automatically cross from team execution into integration and expose final/remote state | `TEST-1108`; CLI and MCP regression suites pass |

Final validation on 2026-07-24 UTC:

- `npm test`: 54 unit tests, 1 built-CLI test, and 4 MCP tests passed; TypeScript typecheck and all three bundles succeeded.
- `npm run verify:app-server-schema`: `APP_SERVER_SCHEMA_COMPATIBLE`, Codex CLI `0.145.0`, 15 files and 61 protocol tokens checked.
- `npm run verify:codex-models`: Sol, Terra, and Luna with `xhigh` verified.
- Skill quick validation and plugin manifest validation passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check`: passed.
