# Closed Contract — SLICE-005

- Spec identity: `ark-team` operating contract and accepted SLICE-004 at Git
  revision `f22a5a2ae97b1412c688be0d588d58b9f2320b5c`, plus the user's
  2026-07-24 approval to continue with the recommended persistent scheduler
  connection.
- Slice approval: The user approved the recommended next step after the
  app-server approval gateway was delivered.
- Objective: Connect managed PL/worker approval sessions to persistent Ark Team
  assignment records and MCP operations for start, status, list, approval
  decision, cancellation, and final-report routing evidence.
- Included requirements:
  - `REQ-501`: Persist PL/worker assignment identity, hierarchy, workspace,
    state, session/turn IDs, one pending approval, final report, and usage in the
    existing atomic run record.
  - `REQ-502`: Enforce one PL assignment per team, at most four teams per run,
    worker ownership by a PL in the same team/workspace, and at most five
    workers per PL.
  - `REQ-503`: Start an `AppServerApprovalSession`, persist `waiting_user` or
    `completed`, and retain the live session only while a decision can continue
    the same turn.
  - `REQ-504`: Resolve a persisted pending approval only through its owning
    live session, reject stale/unknown decisions without modifying state, and
    persist the next waiting or completed update.
  - `REQ-505`: Expose assignment start, list, status, decision, and cancellation
    through the local stdio MCP server.
  - `REQ-506`: Stop active assignment sessions when their assignment or owning
    run is paused/cancelled, preserve their observable records, and never
    auto-restart them.
  - `REQ-507`: Record observable assignment events and usage without raw
    reasoning or raw app-server event history.
- Acceptance criteria:
  - `AC-501`: Existing schema-version-1 run files without assignments reopen as
    an empty assignment set, while new mutations atomically maintain matching
    assignment and event counts.
  - `AC-502`: Invalid hierarchy, fifth team, sixth worker, unsafe worktree,
    terminal/paused run, and duplicate PL attempts fail closed.
  - `AC-503`: Start persists a `running` record before model execution and then
    returns the persisted `waiting_user` or `completed` assignment.
  - `AC-504`: Approval decisions use the opaque pending approval ID; invalid,
    reused, or process-orphaned IDs leave the record unchanged.
  - `AC-505`: Completion stores report and usage, clears pending approval, and
    records a report route to the owning PL for workers or PM for PLs.
  - `AC-506`: Cancellation closes the live session, marks its record
    `cancelled`, and later decisions fail without reviving it.
  - `AC-507`: MCP schemas expose exactly the new bounded operations and return
    typed Ark Team errors.
  - `AC-508`: Existing lifecycle, SDK session, approval gateway, bundle, CLI,
    MCP, model, skill, and plugin checks continue to pass.
- Verification cases:
  - `TEST-501`: Backward-compatible assignment persistence and reopening.
  - `TEST-502`: Team/PL/worker hierarchy and count-boundary tests.
  - `TEST-503`: Start-to-waiting and decision-to-completion persistence test.
  - `TEST-504`: Invalid, replayed, and orphaned approval decision test.
  - `TEST-505`: PL/worker report-route and usage-only event test.
  - `TEST-506`: Assignment and run stop propagation test.
  - `TEST-507`: In-memory MCP assignment workflow test.
  - `TEST-508`: Repository regression and official validators.
- Required definitions and external contracts:
  - Existing run states, event ordering, and atomic JSON replacement.
  - Existing `AppServerApprovalSession` update and decision contracts.
  - Existing MCP stdio server and typed error envelope.
  - Team IDs match `[a-z0-9][a-z0-9-]{0,62}`; assignment IDs use
    `asg-` plus twelve lowercase hexadecimal characters.
- Dependencies and preconditions:
  - The owning run exists and is active.
  - PL/worker sessions use an existing linked Git worktree root.
  - The MCP process remains alive while an approval is pending.
- Explicit exclusions:
  - Automatic PM execution, objective decomposition, team formation, or parsing
    of `TEAM_SPAWN_REQUEST`/`WORKER_SPAWN_REQUEST`.
  - Automatic worktree creation, integration, cleanup, Git remote actions, or
    deployment.
  - Resuming a completed PL turn with accumulated worker reports.
  - Reattaching an in-flight or pending session after MCP process restart.
  - Automatic retries, four-team parallel dispatch, and concurrency queues.
  - External model providers and web dashboard.
- Reference boundary: Repository files at the baseline revision and the
  accepted app-server gateway contract.
- Unknowns that do not affect acceptance: The later PM planner output schema,
  assignment retry lineage, and whether durable live-session recovery will use
  app-server thread resume or a separate daemon.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision or inventory identity:
  `f22a5a2ae97b1412c688be0d588d58b9f2320b5c`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; `npm test` passed with eighteen unit
  tests, one built-CLI smoke test, and one MCP smoke test.
- Relevant commands confirmed: `node`, `npm`, `git`, TypeScript, esbuild, Codex
  model and app-server schema verification, skill validator, plugin validator.
- Environmental limits:
  - Docker is prohibited and not required.
  - Use stdio only; no development server or port is required.
  - Real model usage is not required for this slice because SLICE-004 already
    validated the live gateway and scheduler tests inject its public contract.

# Evidence Matrix

| REQ | AC | TEST/check | Evidence | Result | Notes |
|---|---|---|---|---|---|
| REQ-501 | AC-501 | TEST-501 | `state-store.test.ts` reopens a hand-written v1 record without assignment fields as zero assignments; all new records assert matching contiguous event/assignment counts | PASS | Additive v1 defaults preserve old files. |
| REQ-502 | AC-502 | TEST-502 | Store tests reject duplicate PL, wrong team/parent/worktree, fifth team, sixth worker, and paused run; scheduler rejects a primary checkout before persistence | PASS | Writing-role worktree verification reuses SLICE-003. |
| REQ-503, REQ-504 | AC-503, AC-504 | TEST-503, TEST-504 | Scripted gateway start persists waiting; exact decision completes; wrong, replayed, and process-orphaned approvals leave the record unchanged | PASS | The live map retains only assignments that can continue the same turn. |
| REQ-507 | AC-505 | TEST-505 | PL report target is PM; worker target is its parent PL; completion event stores usage but no final report or reasoning | PASS | Final report remains in the permission-protected assignment record. |
| REQ-506 | AC-506 | TEST-506 | Assignment cancel and run pause mark active records, clear approvals, close blocking sessions, and reject later continuation | PASS | Resume does not auto-restart stopped assignments. |
| REQ-505 | AC-507 | TEST-507 | In-memory MCP start → waiting → decline → completed flow passes; built stdio smoke exposes all twelve run and assignment tools | PASS | Invalid operations use the existing typed error envelope. |
| REQ-501–REQ-507 | AC-508 | TEST-508 | `npm test`: 25 unit + 1 CLI + 2 MCP pass; model and 13-file/47-token schema checks pass; skill/plugin validators and `npm audit` pass | PASS | No Docker, port, infrastructure mutation, or real model call used. |

# Result Record

- Terminal status: `SLICE_ACCEPTED_WITH_WARNINGS`
- Implementation:
  - Extended the atomic v1 run record with backward-compatible assignment
    defaults, hierarchy, approval, report-route, and usage schemas.
  - Added a managed assignment scheduler that owns live app-server sessions,
    persists every public update, refuses orphaned approvals, and propagates
    assignment/run stop operations.
  - Added five bounded MCP assignment tools and passed the configured Codex
    executable path into scheduled sessions.
  - Updated runtime documentation and the skill's managed-runtime selection and
    approval instructions.
- Acceptance summary: All slice acceptance criteria passed.
- Warnings:
  - A persisted report target is durable routing evidence; this slice does not
    yet resume the owning PL or PM with that report.
  - An MCP restart intentionally leaves a pending approval visible but
    unattached to a live process. It must be cancelled or handled by future
    recovery tooling.
  - Store mutations remain serialized only inside one MCP process; cross-process
    locking is unchanged from SLICE-001.
- Rollback/recovery: Reverting this slice leaves old records readable because
  assignment fields are additive, but records that already contain assignments
  must be archived or migrated before running the older bundle.
- Recommended next action: Add PM planner/spawn-request parsing and managed
  worktree creation as a separately approved slice.
