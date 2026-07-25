# Closed Contract — SLICE-014

- Spec identity: Active completion goal and accepted SLICE-013 at Git revision
  `8bcd09c`.
- Objective: Load, validate, snapshot, and enforce each project's
  `.codex/team-orchestrator.toml` so a globally installed Ark Team runtime
  follows durable project-specific limits without weakening the fixed managed
  role or safety contract.
- Included requirements:
  - `REQ-1401`: Parse the documented version-1 TOML schema strictly, apply
    documented defaults when the file is absent, and reject unknown,
    malformed, secret-bearing, or safety-weakening settings before a run is
    created.
  - `REQ-1402`: Persist the fully resolved configuration and source path in
    each run so later `advance` calls and restarts do not drift when the project
    file changes.
  - `REQ-1403`: Keep Sol/Terra/Luna and `xhigh`, read-only PM, user-reviewed
    writers, remote approval, branch preservation, usage-only logging, and no
    private reasoning immutable.
  - `REQ-1404`: Enforce configured team/worker bounds on the PM plan and include
    the resolved organization limits and literal verification commands in the
    PM contract.
  - `REQ-1405`: Apply the snapshotted internal retry and correction budgets
    during team and integration coordination, including after controller
    restart.
  - `REQ-1406`: Apply the configured agent timeout to PM and writer sessions and
    the configured safe integration-branch prefix to integration branches.
  - `REQ-1407`: Resolve verification command working directories beneath the
    project root without shell interpretation, traversal, or secret material.
- Acceptance criteria:
  - Missing configuration yields the documented defaults; malformed or unknown
    keys produce a redacted `INVALID_PROJECT_CONFIG` and no run record.
  - A valid override affects the plan prompt, plan validation, branch names,
    session timeout, and retry/correction policies while fixed role/safety
    values cannot be changed.
  - Editing or deleting TOML after run creation does not change the persisted
    run behavior.
  - Existing schema-version-1 run records reopen with default configuration.
- Verification cases:
  - `TEST-1401`: Missing and valid configuration resolve to an immutable
    normalized snapshot.
  - `TEST-1402`: Unknown, malformed, unsafe, secret-like, and traversal values
    fail before run creation without leaking file contents.
  - `TEST-1403`: PM planning receives configured limits and commands and rejects
    an out-of-bounds otherwise-valid plan.
  - `TEST-1404`: Team and integration policies use the persisted snapshot
    across a reopened store.
  - `TEST-1405`: Integration branches use a validated configured prefix.
  - `TEST-1406`: MCP start/execute loads project configuration and reports its
    source through the persisted run.
- Explicit exclusions:
  - API keys, provider credentials, arbitrary environment maps, shell command
    strings, external model execution, non-Git shadow repositories, dashboard,
    and live paid model calls.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `8bcd09c`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; 67 unit, 1 CLI, and 5 MCP tests passed.
- Environmental limits: no Docker, infrastructure, development port, real
  remote mutation, or paid live model call.

# Evidence Matrix

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| `REQ-1401` | `projectConfigSchema` and `loadProjectConfig` strictly merge documented defaults, fix safety values with literals, and redact parser/schema failures | `TEST-1401`, `TEST-1402` |
| `REQ-1402` | `RunRecord.project_config` and `project_config_source` are written with run creation and default when legacy schema-v1 records reopen | `TEST-1401`, `TEST-1404`, existing legacy-state tests |
| `REQ-1403` | Fixed-model literals plus fixed permission, remote approval, preservation, logging, and external-fallback values reject weakening overrides | `TEST-1402`; existing managed-role and approval suites remain green |
| `REQ-1404` | PM assignment includes resolved bounds and absolute literal-argv verification records; orchestrator and manual materializer reject plans outside the snapshot | `TEST-1403` |
| `REQ-1405` | Team and integration coordinators use constructor overrides only for tests and otherwise read each persisted run's retry/correction budgets | `TEST-1404` reopens the store and proves zero retries prevents relaunch |
| `REQ-1406` | PM requests carry the snapshotted timeout, scheduler constructs app-server sessions with the same timeout, and integration manager reads the persisted prefix | `TEST-1403`, `TEST-1405` |
| `REQ-1407` | Verification command schema requires literal argv and relative cwd; resolver proves the normalized path remains beneath the project root | `TEST-1401`, `TEST-1402` |

Validation evidence before final repository completion:

- 72 unit tests and 5 MCP tests passed; TypeScript typecheck and all bundles
  succeeded.
- `TEST-1406` starts a run through the built stdio MCP server and observes its
  exact source path and resolved project bounds.
- No shell interpretation, Docker, infrastructure operation, development port,
  real remote mutation, or paid model call was used.
