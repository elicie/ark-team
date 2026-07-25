# Closed Contract — SLICE-012

- Spec identity: Active completion goal and accepted SLICE-011 at Git revision
  `9e930b9`.
- Objective: Finish successful Git runs through an explicit one-shot remote
  push/PR approval when requested, same-session PM acceptance, and idempotent
  removal of verified linked worktrees while preserving every local branch.
- Included requirements:
  - `REQ-1201`: Persist one strict remote-action record containing an opaque
    request ID, exact repository/remote/branch/base/commit tuple, approval and
    attempt state, redacted failure, and eventual pull-request URL.
  - `REQ-1202`: Inspect the configured GitHub remote and authenticated CLI
    read-only before requesting approval; never offer a PR action when the
    repository has no supported remote.
  - `REQ-1203`: Expose `ark_team_remote_decide` and accept only the current
    request ID with `approve_once` or `cancel_run`; stale/replayed IDs fail
    closed and cancellation preserves local artifacts.
  - `REQ-1204`: After approval, revalidate the exact verified integration ref,
    push only that branch, adopt an existing matching open PR or create one,
    and persist completion. No remote mutation may occur before approval.
  - `REQ-1205`: Make approved remote execution restart-idempotent and bounded:
    record each attempt, retry the same approved tuple at most three times, and
    issue a fresh approval request after exhaustion.
  - `REQ-1206`: Resume the original Sol/xhigh read-only PM session after either
    local fast-forward or successful PR creation, then enter a durable cleanup
    phase instead of reporting completion early.
  - `REQ-1207`: Remove every clean, registered team and integration worktree
    only after PM acceptance and ancestry verification; preserve and verify
    all local team and integration branches.
  - `REQ-1208`: Make cleanup idempotent across a process crash between physical
    removal and state persistence, record every removal, and mark the run
    complete only when all worktrees are gone and branches remain.
- Acceptance criteria:
  - `ark_team_execute` and `ark_team_advance` stop at `waiting_user` for an
    unapproved remote action and expose its exact persisted request.
  - No test or implementation path invokes a shell; Git and GitHub commands use
    literal argv.
  - A failed or unavailable remote never causes local branches or worktrees to
    be deleted.
  - A local-merge run needs no new user approval and automatically cleans up
    after PM acceptance.
  - A PR run preserves the original checkout at its recorded base while the
    integration branch and PR contain every accepted team tip.
  - Dirty, moved, unregistered, non-ancestral, or branch-deleted worktrees fail
    closed during cleanup.
- Verification cases:
  - `TEST-1201`: Remote-action persistence, one-shot decision, stale/replay
    rejection, and cancellation.
  - `TEST-1202`: No remote or unsupported/unavailable GitHub tooling fails
    before an approval request exists.
  - `TEST-1203`: Approved exact tuple pushes and creates/adopts one PR; no
    executor mutation occurs before approval.
  - `TEST-1204`: Three remote failures create a fresh pending request; a
    simulated post-side-effect crash is safely adopted on retry.
  - `TEST-1205`: Local and remote PM-accepted runs remove all registered
    worktrees and preserve all local branches.
  - `TEST-1206`: Partial cleanup resumes idempotently and dirty cleanup refuses
    removal without reporting completion.
  - `TEST-1207`: MCP exposes and enforces `ark_team_remote_decide`.
- Explicit exclusions:
  - Remote merge, deployment, issue publication, non-Git shadow repositories,
    external-model adapters, project-TOML parsing, and dashboard work.
  - Reattachment/recovery of an assignment turn that was live and waiting on
    app-server approval when the controller process exited; that is SLICE-013.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `9e930b9`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; 54 unit, 1 CLI, and 4 MCP tests passed.
- Environmental limits: no Docker, infrastructure, development port, real
  remote mutation, or paid live model call.

# Evidence Matrix

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| `REQ-1201` | `RemoteActionRecord` persists one exact tuple, opaque request, status, attempts, timestamps, redacted error, and PR URL inside the atomic run record | `TEST-1201`, `TEST-1204`; legacy schema defaults remain green |
| `REQ-1202` | `GitHubRemoteActionExecutor.inspect` checks the exact repository root, verified local ref, `origin`, GitHub repository identity, and CLI authentication before state requests approval | `TEST-1202` fake-unavailable path and real temporary no-remote Git path; no `gh` or network mutation invoked |
| `REQ-1203` | `ark_team_remote_decide`, `approveRemoteAction`, and `cancelRemoteAction` accept only the current UUID with `approve_once` or `cancel_run` | `TEST-1201` cancellation and replay rejection; `TEST-1207` MCP routing/schema |
| `REQ-1204` | Executor revalidates the approved tuple, pushes the full commit SHA via literal argv, finds an exact open PR or creates one, and state independently validates its GitHub URL | `TEST-1203`; executor is never called before approval |
| `REQ-1205` | Attempt state is written before execution; the same approved tuple receives three attempts, exhaustion rotates the request ID, and an interrupted `executing` state resumes idempotently | `TEST-1204` three-failure/fresh-request and simulated post-side-effect controller restart |
| `REQ-1206` | PM accepts `local_merged` or `remote_completed` in the original Sol session and transitions to durable `cleaning` rather than early completion | Local and approved-PR end-to-end cases assert PM turn/session evidence |
| `REQ-1207` | `GitFinalWorktreeManager` rechecks cleanliness, registered location, branch ancestry, exact integration HEAD, and preserved refs before cleanup | `TEST-1205`, dirty/moved worktree tests |
| `REQ-1208` | Per-team cleanup events and state make removal idempotent; final pass revalidates every preserved branch and only `completeCleanup` writes `run.completed` | `TEST-1206` crash between removal/persistence, dirty refusal, durable cleanup failure, and recovery |

Final validation on 2026-07-24 UTC:

- `npm test`: 62 unit tests, 1 built-CLI test, and 4 MCP tests passed; TypeScript typecheck and all three bundles succeeded.
- `npm run verify:app-server-schema`: `APP_SERVER_SCHEMA_COMPATIBLE`, Codex CLI `0.145.0`, 15 files and 61 protocol tokens checked.
- `npm run verify:codex-models`: Sol, Terra, and Luna with `xhigh` verified.
- Skill quick validation and plugin manifest validation passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --check`: passed.
- No Docker, infrastructure operation, development port, paid model call, push,
  pull-request creation, or other real remote mutation was performed.
