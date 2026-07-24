# Closed Contract — SLICE-010

- Spec identity: Active completion goal and accepted SLICE-009 at Git revision
  `41001a7`.
- Objective: Recover managed PL and worker execution from bounded internal
  session failures and semantically deficient reports without bypassing
  approvals or silently retrying forever.
- Included requirements:
  - `REQ-1001`: Persist backward-compatible fresh-session attempt counts,
    correction counts, and one opaque controller retry request.
  - `REQ-1002`: Retry an abnormally failed internal PL or worker in a fresh
    managed session at most twice automatically.
  - `REQ-1003`: Return a valid but deficient worker report to the same Luna
    session at most twice with explicit observable deficiencies.
  - `REQ-1004`: Return a semantically invalid PL worker plan or deficient final
    PL report to the same Terra session at most twice.
  - `REQ-1005`: After a budget is exhausted, persist `waiting_user` with an
    opaque retry request and permit only an explicit `retry_once` or
    `cancel_run` decision.
  - `REQ-1006`: Continue independent operations when one parallel operation
    fails retryably, while propagating unsafe workspace, invalid input, and
    other controller defects.
  - `REQ-1007`: Record attempt/correction transitions and usage, but not raw
    reasoning or hidden model event streams.
- Acceptance criteria:
  - Initial attempt plus two automatic fresh attempts is the hard internal
    abnormal-failure limit.
  - Initial report plus two same-session corrective turns is the hard
    semantic-correction limit.
  - Approval waiting and retry-exhaustion waiting are distinct, mutually
    exclusive persisted request types.
  - A stale or replayed retry request ID is rejected.
  - A user-authorized extra retry consumes exactly one new attempt or
    correction and does not reset the configured counters.
  - `ark_team_execute` and `ark_team_advance` return both approval and retry
    waiting counts.
- Verification cases:
  - `TEST-1001`: Old assignment records receive safe counter/request defaults.
  - `TEST-1002`: Retryable session failures receive exactly two fresh retries.
  - `TEST-1003`: Deficient worker reports receive two same-thread corrections.
  - `TEST-1004`: PL planning and final-report defects receive bounded
    same-thread corrections.
  - `TEST-1005`: Exhaustion persists one request; stale/replayed decisions fail;
    explicit retry and cancellation are enforced.
  - `TEST-1006`: Independent work survives one retryable parallel failure while
    non-retryable controller errors still fail closed.
  - `TEST-1007`: MCP retry-decision flow and regression validators.
- Explicit exclusions:
  - External model adapters and their three-provider-failure budget.
  - PM plan correction, integration PL, merging/PR, cross-team verification,
    worktree cleanup, and process-restart live-session reattachment.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `41001a7`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; 43 unit, 1 CLI, and 3 MCP tests passed.
- Environmental limits: no Docker, infrastructure, port, remote, or real paid
  model call.

# Evidence Matrix

| Requirement | Verification evidence | Result |
|---|---|---|
| REQ-1001 | `TEST-1001` assertions added to the legacy `TEST-901` fixture | Passed |
| REQ-1002 | `TEST-1002`; two failed Terra starts followed by one successful fresh session | Passed |
| REQ-1003 | `TEST-1003`; blocked Luna report, two same-session corrections, then passing evidence | Passed |
| REQ-1004 | `TEST-1004`; PL worker-plan and final-report stages each consume two same-session corrections | Passed |
| REQ-1005 | `TEST-1005`; opaque exhaustion request, stale/replay rejection, one extra retry, and cancel-run path | Passed |
| REQ-1006 | `TEST-1002` and `TEST-1006`; independent team evidence survives transient failure and invalid workspace propagates | Passed |
| REQ-1007 | Retry/correction event assertions and MCP `TEST-1007` | Passed |

# Verification

- `npm test`: passed; 48 unit tests, 1 built-CLI test, and 4 MCP tests.
- `npm run verify:app-server-schema`: passed; Codex CLI `0.145.0`,
  15 protocol files and 61 tokens checked.
- `npm run verify:codex-models`: passed for `gpt-5.6-sol`,
  `gpt-5.6-terra`, and `gpt-5.6-luna` with `xhigh`.
- Skill quick validation: passed.
- Plugin validation: passed.
- `npm audit --omit=dev`: passed with 0 vulnerabilities.
- `git diff --check`: passed.
- No Docker, infrastructure operation, port, remote mutation, or paid live
  model turn was used by this slice.

# Residual Warnings

- Retry defaults are enforced by the coordinator and exposed as constructor
  options; parsing project TOML overrides into the runtime remains a later
  configuration slice.
- Explicit external-provider adapters and their three-failure budget remain
  excluded.
- A pending live command/file approval still cannot be reattached after the
  MCP controller process exits.
- Integration, merge selection, verification, and worktree cleanup remain
  outside this slice.
