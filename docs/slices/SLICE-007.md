# Closed Contract — SLICE-007

- Spec identity: Active Ark Team completion goal and accepted SLICE-006 at Git
  revision `f381d0576ac5a20628d897e60c689aaf933cfe1b`.
- Slice approval: The active goal requires PM-directed linked worktrees and the
  user previously selected worktree isolation and branch preservation.
- Objective: Materialize one validated `pm_plan` into durable team records and
  isolated linked Git worktrees without starting model sessions.
- Included requirements:
  - `REQ-701`: Require the run project path to be the root of a clean Git
    working tree before materialization.
  - `REQ-702`: Create one linked worktree and unique
    `ark-team/<run-id>/<team-id>` branch per planned team from the same observed
    base commit.
  - `REQ-703`: Place managed worktrees under a configurable absolute root that
    is outside the project checkout and reject pre-existing target paths or
    branches.
  - `REQ-704`: Persist the validated team mission, worker count, dependency
    list, owned paths, acceptance/verification criteria, worktree path, branch,
    and base commit in the atomic run record.
  - `REQ-705`: Transition a planning run to staffing, maintain team/event
    counts, and expose plan application plus team listing through MCP.
  - `REQ-706`: If any worktree creation or persistence step fails, remove only
    worktrees created by that attempt while preserving any branches already
    created, and leave the run plan unapplied.
  - `REQ-707`: Provide an explicit cleanup primitive that removes a linked
    worktree but preserves its branch for later inspection.
- Acceptance criteria:
  - `AC-701`: One to four planned teams produce matching durable `ready` team
    records whose paths are valid linked-worktree roots.
  - `AC-702`: Every team uses the same recorded base commit and a distinct
    preserved branch.
  - `AC-703`: Dirty, non-Git, nested-project, existing-path, duplicate-plan, and
    branch-collision cases fail closed.
  - `AC-704`: Schema-version-1 records from earlier slices reopen with zero
    teams and `team_count: 0`.
  - `AC-705`: MCP returns typed errors and never starts a Sol, Terra, or Luna
    session during plan application.
  - `AC-706`: Cleanup removes only the registered worktree; the branch and
    commit remain addressable.
- Verification cases:
  - `TEST-701`: Git worktree preparation and branch/base evidence.
  - `TEST-702`: Dirty/non-Git/nested/path/branch rejection.
  - `TEST-703`: Partial preparation rollback and branch preservation.
  - `TEST-704`: Atomic plan persistence, transition, listing, and legacy
    defaults.
  - `TEST-705`: Worktree cleanup preserves branch.
  - `TEST-706`: MCP apply/list workflow.
  - `TEST-707`: Full regression and official validators.
- Required definitions and external contracts:
  - SLICE-006 `pmPlanSchema`.
  - Existing run IDs, atomic record replacement, run lifecycle states, and
    generated assignment IDs.
  - Git linked-worktree behavior; no Git remote is required.
- Explicit exclusions:
  - Invoking the PM, starting PL/worker assignments, report routing, retry
    lineage, integration, merge/PR selection, and automatic final cleanup.
  - Non-Git directory-copy isolation; this slice returns a clear unsupported
    project error and does not mutate the source directory.
  - External providers, web dashboard, infrastructure, and paid model calls.
- Reference boundary: Repository content at the baseline revision and the
  locally installed Git executable.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `f381d0576ac5a20628d897e60c689aaf933cfe1b`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; `npm test` passed with thirty-one unit,
  one CLI, and two MCP tests.
- Environmental limits:
  - Docker and infrastructure mutation are prohibited and unnecessary.
  - No development server or network remote is used.
  - Destructive cleanup is limited to exact worktrees created and registered by
    this runtime.

# Evidence Matrix

| REQ | AC | TEST/check | Evidence | Result | Notes |
|---|---|---|---|---|---|
| REQ-701–REQ-703 | AC-701–AC-703 | TEST-701, TEST-702 | Real temporary Git repositories verify a common base commit, distinct linked worktrees/branches, clean-root enforcement, and rejection of non-Git, nested, inside-project, existing-path, and existing-branch cases | PASS | No remote is configured or required. |
| REQ-706 | AC-703 | TEST-703 | A collision on the second team removes the first linked worktree but preserves both branches; an injected persistence failure cleans prepared worktrees in reverse order and leaves the run planning with zero teams | PASS | Rollback targets only paths returned by the current preparation attempt. |
| REQ-704, REQ-705 | AC-701, AC-702, AC-704 | TEST-704 | Atomic state tests persist the plan and two team records, transition planning → staffing, maintain contiguous event/team counts, enforce the planned worktree on assignment start, and reopen legacy v1 records with zero teams | PASS | Starting the planned PL transitions its team from ready to active. |
| REQ-707 | AC-706 | TEST-705 | Explicit manager cleanup removes each clean registered worktree and confirms its local branch and base commit remain addressable | PASS | Branch deletion is not part of cleanup. |
| REQ-705 | AC-705 | TEST-706 | Built stdio MCP smoke exposes fourteen tools, applies a one-team plan in a real Git fixture, validates the resulting `.git` pointer, and lists the durable team | PASS | No agent/model session starts during plan application. |
| REQ-701–REQ-707 | AC-701–AC-706 | TEST-707 | `npm test`: 37 unit + 1 CLI + 2 MCP tests; model/schema checks; skill/plugin validators; moderate npm audit; `git diff --check` | PASS | No Docker, infrastructure mutation, development port, network remote, or paid model call used. |

# Result Record

- Terminal status: `SLICE_ACCEPTED_WITH_WARNINGS`
- Implementation:
  - Added a canonical-path-aware worktree manager with clean repository checks,
    bounded branch/path derivation, partial rollback, and branch-preserving
    cleanup.
  - Persisted strict PM plans and durable team workspace records with
    backward-compatible v1 defaults and observable events.
  - Added serialized plan materialization and `ark_team_plan_apply` /
    `ark_team_team_list` MCP tools.
  - Restricted assignments in a materialized run to the planned team
    worktree, exposed `ARK_TEAM_WORKTREE_ROOT`, and updated the canonical skill
    workflow and plugin documentation.
- Acceptance summary: All SLICE-007 acceptance criteria passed.
- Warnings:
  - The PM still is not invoked automatically; a controller must provide the
    validated `pm_plan`.
  - This slice deliberately rejects non-Git projects. Shadow-Git isolation and
    drift-safe result application remain required for the user's non-Git case.
  - Worktree preparation is serialized inside one MCP process; durable
    cross-process locks and crash recovery are still pending.
- Rollback/recovery: Reverting this slice leaves older records readable only
  when they do not yet contain `plan` or `teams`; archive or migrate
  materialized records before running the older bundle. Created local branches
  intentionally survive worktree cleanup.
- Recommended next action: Invoke the Sol PM automatically, persist its thread
  and usage, apply the returned plan, then dispatch dependency-ready PL turns.
