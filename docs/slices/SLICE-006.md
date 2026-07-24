# Closed Contract — SLICE-006

- Spec identity: `ark-team` operating contract and accepted SLICE-005 at Git
  revision `ec5e58435579c411d3369641cfb48c94d5e26fb4`, plus the user's active
  goal to complete the end-to-end TypeScript orchestrator.
- Slice approval: The user explicitly requested continued implementation with
  the product goal feature.
- Objective: Define machine-validated PM/PL/worker output contracts and allow
  the controller to continue a completed PM or writer thread with the next
  hierarchical report turn while preserving the exact role profile.
- Included requirements:
  - `REQ-601`: Define strict JSON contracts for a PM team plan, PL worker plan,
    worker report, PL report, and PM report.
  - `REQ-602`: Bound a PM plan to one through four unique teams and each PL plan
    to one through five unique workers.
  - `REQ-603`: Reject unknown fields, malformed JSON, invalid dependency
    references, empty evidence, and a contract used by the wrong role.
  - `REQ-604`: Pass the selected contract as the Codex turn output schema and
    parse the final response before returning it to the controller.
  - `REQ-605`: Resume an existing PM SDK thread by ID with the same Sol/xhigh,
    read-only, never-approval profile.
  - `REQ-606`: Resume an existing PL/worker app-server thread by ID with the
    same model, xhigh effort, linked-worktree cwd, workspace-write sandbox, and
    user-reviewed on-request approvals.
  - `REQ-607`: Fail closed when a resumed backend returns another thread ID,
    reroutes the model, weakens a permission setting, or emits an invalid
    structured report.
- Acceptance criteria:
  - `AC-601`: Every structured result includes both the original final JSON text
    and a parsed `structured_report`; unstructured legacy calls remain
    backward-compatible.
  - `AC-602`: PM team dependencies and PL worker dependencies refer only to
    unique IDs in the same plan and cannot self-reference.
  - `AC-603`: SDK resume calls `resumeThread` rather than `startThread`, supplies
    the exact PM profile and schema, and returns the requested thread ID.
  - `AC-604`: App-server resume performs initialize → `thread/resume` →
    `turn/start`, verifies the returned effective profile, supplies the output
    schema, and keeps approval routing unchanged.
  - `AC-605`: Existing session, scheduler, MCP, bundle, CLI, model, skill, and
    plugin behavior continues to pass.
- Verification cases:
  - `TEST-601`: Strict role-contract parsing and role compatibility.
  - `TEST-602`: Team and worker count, uniqueness, dependency, and evidence
    boundaries.
  - `TEST-603`: PM SDK structured start and same-thread resume.
  - `TEST-604`: SDK invalid JSON, wrong contract, and mismatched resumed thread
    fail closed.
  - `TEST-605`: Writer app-server structured start and same-thread resume
    handshake.
  - `TEST-606`: Writer resume profile mismatch and invalid structured output
    fail closed.
  - `TEST-607`: Generated app-server schema contains `thread/resume` and
    `outputSchema`.
  - `TEST-608`: Full repository regression and official validators.
- Required definitions and external contracts:
  - Installed `@openai/codex-sdk` `resumeThread(id, options)` and turn
    `outputSchema`.
  - Installed Codex app-server `thread/resume` and turn `outputSchema`.
  - Existing exact managed role profiles and linked-worktree guard.
- Explicit exclusions:
  - Automatically invoking the PM, creating teams or worktrees, dispatching
    workers, or routing persisted reports.
  - Scheduling, retry lineage, integration, merging, pull requests, worktree
    cleanup, cross-process locking, and restart recovery.
  - External provider execution, dashboard, infrastructure, and real paid model
    calls.
- Reference boundary: Repository files at the baseline revision, the installed
  Codex SDK type declarations, and generated app-server protocol types.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision or inventory identity:
  `ec5e58435579c411d3369641cfb48c94d5e26fb4`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; `npm test` passed with twenty-five unit
  tests, one built-CLI test, and two MCP tests.
- External contract evidence:
  - `@openai/codex-sdk` 0.145.0 declares `resumeThread` and `outputSchema`.
  - The installed Codex app-server generated schema declares
    `ThreadResumeParams`, `ThreadResumeResponse`, and
    `TurnStartParams.outputSchema`.
- Environmental limits:
  - Docker is prohibited and not required.
  - No infrastructure mutation or development server is required.
  - No real model call is required; protocol clients are injected in tests.

# Evidence Matrix

| REQ | AC | TEST/check | Evidence | Result | Notes |
|---|---|---|---|---|---|
| REQ-601–REQ-603 | AC-601, AC-602 | TEST-601, TEST-602 | `role-contracts.test.ts` accepts all role-compatible contracts and rejects malformed JSON, unknown fields, wrong-role contracts, fifth-team overflow, sixth-worker overflow, duplicates, missing dependencies, and cycles | PASS | Zod JSON Schemas constrain model output; the same schemas perform strict runtime parsing. |
| REQ-604, REQ-605 | AC-601, AC-603 | TEST-603, TEST-604 | Managed SDK tests pass `pm_plan`/`pm_report` schemas, parse structured results, call `resumeThread` with the original ID and exact PM options, and reject invalid JSON or a mismatched resumed ID | PASS | Legacy calls without `output_contract` retain the prior result shape. |
| REQ-604, REQ-606, REQ-607 | AC-604 | TEST-605, TEST-606 | App-server tests perform initialize → resume → turn, assert exact Terra/xhigh writer params and JSON Schema, preserve the ID, parse a PL report, and reject changed IDs, enabled network, and invalid JSON | PASS | Writer responses must report the assigned cwd and include it in writable roots. |
| REQ-606 | AC-604 | TEST-607 | Codex 0.145.0 generated schema check covers 15 files and 61 tokens including `thread/resume`, its profile overrides/responses, and `TurnStartParams.outputSchema` | PASS | This is a no-usage protocol compatibility check. |
| REQ-601–REQ-607 | AC-605 | TEST-608 | `npm test`: 31 unit + 1 CLI + 2 MCP tests; model verifier; skill/plugin validators; `npm audit --audit-level=moderate`; `git diff --check` | PASS | No Docker, infrastructure mutation, server port, or real paid model call used. |

# Result Record

- Terminal status: `SLICE_ACCEPTED_WITH_WARNINGS`
- Implementation:
  - Added five strict, role-compatible planning/report contracts with bounded
    team and worker counts plus dependency-graph validation.
  - Added SDK structured turns and same-thread PM continuation using
    `resumeThread`.
  - Added app-server structured turns and same-thread PL/worker continuation
    using `thread/resume`, with effective profile verification.
  - Extended the generated-schema compatibility check and rebuilt distributable
    runtime bundles.
- Acceptance summary: All SLICE-006 acceptance criteria passed.
- Warnings:
  - These are controller primitives; the scheduler does not yet automatically
    invoke the PM or route stored child reports into resumed parent turns.
  - Cross-plan semantic checks, such as matching a final PM report to the exact
    earlier team plan, belong to the future orchestration state machine.
  - Live model execution was intentionally not repeated because protocol and
    behavior are covered by generated schemas and injected-client tests.
- Rollback/recovery: Reverting this slice removes structured/resume controller
  APIs without changing persisted run or assignment schema.
- Recommended next action: Add managed worktree lifecycle and PM-plan materialization
  so a validated `pm_plan` can create isolated PL team assignments.
