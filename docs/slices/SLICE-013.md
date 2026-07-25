# Closed Contract — SLICE-013

- Spec identity: Active completion goal and accepted SLICE-012 at Git revision
  `53f32e0`.
- Objective: Recover a persisted PL/worker/integration-PL assignment whose
  app-server approval turn became unreachable after controller restart,
  without replaying or silently carrying the old dangerous-action approval.
- Included requirements:
  - `REQ-1301`: Add an explicit `ark_team_assignment_recover` operation keyed
    by the exact persisted approval and assignment IDs with only
    `resume_safely` or `cancel_run`.
  - `REQ-1302`: Permit recovery only when the assignment is `waiting_user`,
    still owns that pending approval, has a persisted resumable thread, and has
    no live session in the current controller.
  - `REQ-1303`: On `resume_safely`, atomically clear the orphaned approval,
    increment the turn count, retain role/model/worktree/output contract and
    counters, and resume the same thread with an explicit statement that the
    old approval was not applied.
  - `REQ-1304`: If the recovered turn still needs a dangerous action, persist
    its newly surfaced approval as a new request; never compare-and-auto-approve
    it and never treat the old user decision as authority for a new wire turn.
  - `REQ-1305`: On `cancel_run`, stop the orphaned assignment, cancel the run,
    and preserve worktrees, branches, commits, reports, and logs.
  - `REQ-1306`: Keep ordinary `ark_team_assignment_decide` strict: a missing
    live session remains an error that points callers to explicit recovery
    rather than silently changing semantics.
  - `REQ-1307`: After safe recovery completes, existing hierarchy/integration
    coordinators continue from persisted state without respawning completed
    independent work.
- Acceptance criteria:
  - A recovery request against a currently live approval, stale approval ID,
    completed assignment, or sessionless assignment fails without state change.
  - The recovered app-server request uses the same thread ID and a new turn;
    role profile, linked worktree, output contract, and approval policy remain
    unchanged.
  - The old approval ID appears only in the recovery audit event and cannot be
    delivered, replayed, or used to approve a new request.
  - Recovery is available after constructing a brand-new scheduler/controller
    instance over the same state root.
- Verification cases:
  - `TEST-1301`: New scheduler safely resumes the same persisted thread and
    completes the assignment.
  - `TEST-1302`: Recovered turn surfaces a new approval ID and requires a new
    ordinary decision.
  - `TEST-1303`: Live, stale, replayed, invalid-state, and sessionless recovery
    requests fail closed.
  - `TEST-1304`: `cancel_run` preserves artifacts and records cancellation.
  - `TEST-1305`: Recovered assignment rejoins PL/worker or integration
    coordination without redoing accepted work.
  - `TEST-1306`: MCP exposes and validates the recovery operation.
- Explicit exclusions:
  - Reattaching to the original dead JSON-RPC process or responding to its old
    wire request; this is technically impossible after process loss.
  - Automatic recovery without a user/controller call, remote merge,
    non-Git shadow repositories, external model providers, and dashboard work.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `53f32e0`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; 62 unit, 1 CLI, and 4 MCP tests passed.
- Environmental limits: no Docker, infrastructure, development port, real
  remote mutation, or paid live model call.

# Evidence Matrix

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| `REQ-1301` | `ark_team_assignment_recover` accepts only exact run, assignment, approval UUID, and `resume_safely` or `cancel_run` | `TEST-1306` exercises the MCP schema, successful routing, and replay rejection |
| `REQ-1302` | `ManagedAssignmentScheduler.recoverApproval` checks current persisted ownership and refuses recovery when its scheduler still owns a live session | `TEST-1303` verifies live and stale requests fail without mutation |
| `REQ-1303` | `RunStore.recoverOrphanedApproval` atomically clears the old request, increments `turn_count`, retains the managed profile and counters, and records `assignment.recovering` | `TEST-1301` reopens the state root and asserts same thread, new turn, worktree, role, audit, and completion |
| `REQ-1304` | The recovery prompt states the old approval was not applied and requires a newly surfaced request; no decision is sent to the lost session | `TEST-1302` surfaces a different approval ID and proves only that fresh ID reaches `decide` |
| `REQ-1305` | `cancelOrphanedApproval` and scheduler run cancellation preserve the registered filesystem and Git artifacts | `TEST-1304` asserts cancelled run/assignment, retained worktree and branch, audit, and replay rejection |
| `REQ-1306` | Ordinary `decide` still requires the live in-memory session and retains its previous failure semantics | Existing `TEST-504` plus `TEST-1301`–`TEST-1303` |
| `REQ-1307` | Recovery returns through normal assignment persistence and coordination; no new hierarchy records are synthesized | `TEST-1305` recovers the integration PL, verifies/merges/reviews/cleans, and completes with the original assignment count |

Final validation on 2026-07-24 UTC:

- `npm test`: 67 unit tests, 1 built-CLI test, and 5 MCP tests passed;
  TypeScript typecheck and all three bundles succeeded.
- App-server protocol schema compatibility and Sol/Terra/Luna `xhigh` model
  availability checks passed.
- Skill quick validation, plugin manifest validation, dependency audit with
  zero vulnerabilities, and `git diff --check` passed.
- No Docker, infrastructure operation, development port, paid model call, or
  real remote mutation was performed.
