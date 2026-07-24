# Closed Contract — SLICE-008

- Spec identity: Active Ark Team completion goal and accepted SLICE-007 at Git
  revision `88f3861a7e9e21d627af6660c9070c0c5cc79dba`.
- Slice approval: The user requested a one-call managed PM workflow and keeps
  the goal active through completion.
- Objective: Add one orchestration entry point that creates a run, invokes the
  management-only Sol/xhigh PM for a strict plan, records only its session
  metadata and usage, and materializes that plan into team worktrees.
- Included requirements:
  - `REQ-801`: Expose `ark_team_execute` with the same objective/project inputs
    as run creation.
  - `REQ-802`: Launch PM through `ManagedCodexSessionLauncher` with role `pm`,
    `pm_plan` output, the run project cwd, Sol/xhigh, read-only sandbox, never
    approval, disabled network/search/apps/native subagents.
  - `REQ-803`: Require a parsed `pm_plan`; never infer or recover a plan from
    unstructured text.
  - `REQ-804`: Persist PM thread ID, exact role metadata, planned timestamp,
    structured plan, and token usage; do not persist raw reasoning or raw event
    history.
  - `REQ-805`: Emit a usage-bearing `pm.planned` event, then apply the stored
    plan through the SLICE-007 materializer.
  - `REQ-806`: Mark the run failed when PM execution/protocol validation fails.
  - `REQ-807`: When worktree materialization fails after PM success, keep the
    run in planning with the PM plan/session evidence so the existing
    `ark_team_plan_apply` operation can retry without another model call.
- Acceptance criteria:
  - `AC-801`: One successful execute call returns a staffing run, PM session
    metadata, and one to four ready team records.
  - `AC-802`: The PM request uses no writer or approval-capable backend and
    includes the exact run objective plus bounded team-planning constraints.
  - `AC-803`: Stored events contain PM usage but no final report or reasoning.
  - `AC-804`: PM failure produces a durable failed run and a typed session
    error; no plan or teams exist.
  - `AC-805`: Materialization failure preserves the plan and PM evidence in a
    planning run with zero teams.
  - `AC-806`: Legacy/manual `ark_team_start` plus `ark_team_plan_apply` remains
    supported.
- Verification cases:
  - `TEST-801`: Successful automatic PM execution and materialization.
  - `TEST-802`: Exact PM request and usage-only persistence.
  - `TEST-803`: PM failure state and invalid structured result.
  - `TEST-804`: Recoverable post-PM materialization failure.
  - `TEST-805`: MCP execute registration and injected workflow.
  - `TEST-806`: Full regression and official validators.
- Explicit exclusions:
  - Starting PL/worker turns, dependency queues, report delivery, retries,
    integration, merging, remote actions, cleanup, and restart recovery.
  - Real paid PM calls in tests.
  - Non-Git shadow workspaces.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `88f3861a7e9e21d627af6660c9070c0c5cc79dba`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; `npm test` passed with thirty-seven unit,
  one CLI, and two MCP tests.
- Environmental limits: No Docker, infrastructure change, server port, remote
  Git operation, or real model usage.

# Evidence Matrix

| REQ | AC | TEST/check | Evidence | Result | Notes |
|---|---|---|---|---|---|
| REQ-801–REQ-805 | AC-801–AC-803 | TEST-801, TEST-802 | Injected PM launcher receives `pm`, `pm_plan`, exact project cwd, and the management-only bounded prompt; execution returns staffing with ready teams and persists the exact session profile plus usage | PASS | Raw PM final text and reasoning markers are absent from the run file and logs. |
| REQ-806 | AC-804 | TEST-803 | Session failure and wrong-role structured output both reject with typed agent errors and leave separate durable failed runs with zero teams | PASS | No worktree manager call can occur after a rejected PM result. |
| REQ-807 | AC-805, AC-806 | TEST-804 | Simulated worktree failure leaves a planning run containing `pm_plan`, PM session, and usage with zero teams; applying the same plan through a new materializer reaches staffing without a second PM call | PASS | This is the manual/recovery path. |
| REQ-801 | AC-801 | TEST-805 | In-memory MCP invokes `ark_team_execute` end to end with injected PM/workspace backends and returns run, PM session, and team records | PASS | Built stdio smoke exposes fifteen total tools. |
| REQ-801–REQ-807 | AC-801–AC-806 | TEST-806 | `npm test`: 41 unit + 1 CLI + 3 MCP tests; model/schema checks; skill/plugin validators; moderate npm audit; `git diff --check` | PASS | No Docker, infrastructure mutation, development port, remote, or paid model call used. |

# Result Record

- Terminal status: `SLICE_ACCEPTED_WITH_WARNINGS`
- Implementation:
  - Added `ArkTeamOrchestrator.execute` and the `ark_team_execute` MCP entry
    point.
  - Persisted PM session identity/profile, strict plan, timestamp, and usage;
    added usage-bearing `pm.planned` and durable `run.failed` events.
  - Exposed PM plan/session context through run status while excluding raw PM
    output.
  - Preserved the manual start/apply flow as a no-extra-usage recovery path.
  - Updated the canonical skill to prefer one-call managed PM planning.
- Acceptance summary: All SLICE-008 acceptance criteria passed.
- Warnings:
  - `ark_team_execute` currently stops at staffed worktrees; it does not yet
    launch Terra PL turns or Luna workers.
  - Internal agent retry policy is not part of this slice.
  - The production PM path consumes Sol usage; all automated tests use injected
    deterministic clients.
- Rollback/recovery: Reverting this slice requires materialized run records to
  omit `pm_session`; archive or migrate newer records before using an older
  bundle.
- Recommended next action: Start dependency-ready PLs in parallel, parse each
  `pl_worker_plan`, and create the requested Luna worker assignments.
