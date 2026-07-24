# Closed Contract — SLICE-009

- Spec identity: Active completion goal and accepted SLICE-008 at Git revision
  `df310f3`.
- Objective: Advance staffed runs through dependency-ready Terra PL planning,
  Luna worker execution, worker-to-PL report delivery, and same-thread PL final
  reporting until work is blocked, waiting for approval, or ready to integrate.
- Included requirements:
  - `REQ-901`: Persist assignment task keys, selected output contract,
    structured report, and turn count with backward-compatible defaults.
  - `REQ-902`: Start dependency-ready team PLs in parallel with
    `pl_worker_plan` and the exact materialized team contract.
  - `REQ-903`: Validate PL team identity and requested worker count; create one
    worker assignment per unique worker key and start dependency-ready workers
    in parallel with `worker_report`.
  - `REQ-904`: Route worker structured reports to the owning PL, then resume
    the same Terra thread with `pl_report`.
  - `REQ-905`: Mark a team completed only after a valid same-team PL report;
    unlock dependent teams and transition all-complete runs to integrating.
  - `REQ-906`: Preserve approval waiting states and expose
    `ark_team_advance` to continue scheduling after user decisions.
  - `REQ-907`: Keep interim PL plans routed to the controller, worker reports
    routed to their PL, and final PL reports routed to PM.
- Acceptance criteria:
  - Independent ready teams and workers start concurrently; dependencies do not
    start early.
  - Every writing turn uses its materialized linked worktree and exact role
    output contract.
  - PL continuation uses its original session ID and a new turn.
  - Duplicate task keys, wrong team IDs, count mismatch, or wrong output kinds
    fail closed.
  - `ark_team_execute` invokes the coordinator after plan materialization and
    returns assignment/team progress without exposing reasoning.
  - Existing manual assignment and approval operations remain compatible.
- Verification cases:
  - `TEST-901`: Assignment schema migration, output contract, task key, and
    structured report persistence.
  - `TEST-902`: Independent PL parallel dispatch and dependency gating.
  - `TEST-903`: Worker dependency waves and exact Luna assignments.
  - `TEST-904`: Same-thread PL resume with consolidated worker reports.
  - `TEST-905`: Team completion, dependent-team unlock, and integrating state.
  - `TEST-906`: Approval waiting and subsequent advance.
  - `TEST-907`: MCP advance workflow and regression validators.
- Explicit exclusions:
  - Correction/abnormal retry budgets, PL-to-PL messaging, integration PL,
    merging/PR, verification commands, cleanup, restart reattachment, and
    external providers.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `df310f3`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; 41 unit, 1 CLI, and 3 MCP tests passed.
- Environmental limits: no Docker, infrastructure, port, remote, or real paid
  model call.

# Evidence Matrix

| Requirement | Verification evidence | Result |
|---|---|---|
| REQ-901 | `TEST-901`; assignment schema and state-store round trip | Passed |
| REQ-902 | `TEST-902–TEST-906`; two independent PL starts held behind a concurrency barrier | Passed |
| REQ-903 | `TEST-902–TEST-906`; exact four-worker materialization and dependency order assertion | Passed |
| REQ-904 | `TEST-902–TEST-906`; three original PL session IDs resumed with turn count `2` | Passed |
| REQ-905 | `TEST-902–TEST-906`; dependency unlock, three team completion events, and `integrating` transition | Passed |
| REQ-906 | `TEST-902–TEST-906`, `TEST-006`, and `TEST-805`; durable approval decision followed by MCP advance | Passed |
| REQ-907 | Routed target and strict output-kind assertions in coordinator and persistence tests | Passed |

# Verification

- `npm test`: passed; 43 unit tests, 1 built-CLI test, and 3 MCP tests.
- `npm run verify:app-server-schema`: passed; Codex CLI `0.145.0`,
  15 protocol files and 61 tokens checked.
- `npm run verify:codex-models`: passed for `gpt-5.6-sol`,
  `gpt-5.6-terra`, and `gpt-5.6-luna` with `xhigh`.
- Skill quick validation: passed.
- Plugin validation: passed.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.
- `git diff --check`: passed.
- No Docker, infrastructure operation, remote mutation, or paid live model turn
  was used by this slice.

# Residual Warnings

- Managed child retries and correction budgets are intentionally deferred.
  Invalid or blocked final reports currently fail closed for the caller.
- Pending approvals are durable records but their live app-server connection
  cannot yet be reattached after controller restart.
- The `integrating` state is a handoff boundary; integration, verification,
  merge selection, and worktree cleanup are not implemented in this slice.
