# Ark Team Configuration

## Contents

1. Configuration precedence
2. Project configuration
3. Execution backends
4. Model-provider rules
5. Logs and retention

## Configuration precedence

Apply settings in this order, from highest to lowest:

1. explicit instruction in the current user request;
2. applicable repository and system safety instructions;
3. `.codex/team-orchestrator.toml`;
4. Ark Team defaults.

Never store API keys or access tokens in project configuration. Resolve secrets from user-level provider configuration or environment variables.

## Project configuration

Use this schema:

```toml
version = 1

[organization]
max_teams = 4
min_workers_per_team = 1
max_workers_per_team = 5
allow_direct_pl_communication = true

[models]
pm = "gpt-5.6-sol"
pm_reasoning_effort = "xhigh"
pl = "gpt-5.6-terra"
pl_reasoning_effort = "xhigh"
worker = "gpt-5.6-luna"
worker_reasoning_effort = "xhigh"

[execution]
agent_timeout_minutes = 60
run_timeout_minutes = 360
worker_correction_rounds = 2
pl_correction_rounds = 2
internal_agent_retries = 2
external_provider_retries = 3
pause_when_host_stops = true

[git]
integration_branch_prefix = "orchestrator/"
preserve_local_branches = true
cleanup_verified_worktrees = true
require_approval_for_remote_actions = true

[logging]
root = "~/.codex/team-orchestrator/runs"
retention_days = 30
record_usage = true
record_private_reasoning = false

[external_models]
explicit_request_only = true
automatic_luna_fallback = false
```

Allow projects to add verification commands:

```toml
[[verification.commands]]
argv = ["npm", "test"]
cwd = "."

[[verification.commands]]
argv = ["npm", "run", "lint"]
cwd = "."
```

Interpret `argv` as an executable plus literal arguments without a shell. Resolve `cwd` relative to the project root. Inherit the guarded agent environment unless an explicitly supported environment map is added later.

Do not execute a command copied from project configuration when a higher-priority safety instruction prohibits it. Require a platform-specific command entry when the executable or arguments differ by operating system.

The managed runtime loads this file only when it creates a run and persists the
fully resolved snapshot. Later edits do not change that run. It currently
permits project overrides for organization bounds, agent timeout, internal
retry and correction budgets, the integration branch prefix, and literal
verification commands. Fields that protect the accepted operating contract
must retain the shown values: the three managed models and `xhigh`, direct PL
communication enabled, 360-minute run limit, three external-provider retries,
host-stop pausing, branch preservation and verified cleanup, remote approval,
30-day usage-only logging, and explicit-request-only external models without
automatic Luna fallback. Use `ARK_TEAM_STATE_ROOT` for the global server state
root; project configuration never relocates an already running MCP server or
stores credentials.

## Execution backends

### Native custom-agent roles

Codex project custom agents live under `.codex/agents/`. Ark Team uses these
names as a stable role contract:

| Role | Custom agent | Model | Effort | Sandbox |
|---|---|---|---|---|
| PM | `ark_pm` | `gpt-5.6-sol` | `xhigh` | `read-only` |
| PL | `ark_pl` | `gpt-5.6-terra` | `xhigh` | `workspace-write` |
| worker | `ark_worker` | `gpt-5.6-luna` | `xhigh` | `workspace-write` |

Select the named role instead of a generic agent. A config file alone is not
evidence that a particular spawned thread used it; require the host to confirm
named-role selection before reporting the model as pinned.

The parent turn's live sandbox and approval overrides are reapplied to native
children. Therefore native custom-agent files do not isolate a read-only PM
from writable PL and worker sessions. Allow the native hierarchy for read-only
runs only. Writing runs require a managed runtime that launches the PM and
writing roles in separately permissioned sessions.

### Managed runtime

Prefer a managed Ark Team runtime when it exposes:

- a dedicated PM session pinned to Sol/xhigh;
- read-only PM permissions;
- independently scheduled PL and worker sessions;
- persistent run identifiers and event logs;
- pause, resume, cancel, approval, and status operations; and
- guarded workspace creation, integration, and cleanup.

Use the runtime's actual tool schemas. Do not invent command names or fields.

The current bundled control-plane slice exposes these MCP tools:

- `ark_team_start`
- `ark_team_execute`
- `ark_team_advance`
- `ark_team_list`
- `ark_team_status`
- `ark_team_logs`
- `ark_team_pause`
- `ark_team_resume`
- `ark_team_cancel`
- `ark_team_plan_apply`
- `ark_team_remote_decide`
- `ark_team_team_list`
- `ark_team_assignment_start`
- `ark_team_assignment_list`
- `ark_team_assignment_status`
- `ark_team_assignment_decide`
- `ark_team_assignment_recover`
- `ark_team_assignment_retry_decide`
- `ark_team_assignment_cancel`

`ark_team_execute` is the managed one-call entry point: it creates the run,
launches the Sol/xhigh read-only PM for a strict `pm_plan`, records the PM
thread metadata and usage, materializes the plan, and advances every
dependency-ready team. The coordinator asks each Terra PL for a strict
`pl_worker_plan`, dispatches the selected Luna workers in dependency waves,
routes strict `worker_report` records to their owning PL, and resumes that same
PL session for its strict `pl_report`. Independent teams and workers are
started concurrently. After all teams complete, it creates a separate linked
worktree on `orchestrator/<run-id>`, starts a Terra/xhigh integration PL for
strict `integration_report`, verifies every team tip is an ancestor of the
clean reported commit, and applies the plan strategy. A clean `local_merge`
uses fast-forward only when the original branch and HEAD remain unchanged,
then the original Sol PM session resumes for strict `pm_report`. A
`pull_request` strategy stops at verified local state with
`remote_action_required` after read-only validation of a supported
`github.com` remote and authenticated GitHub CLI. The runtime persists the
exact remote/branch/target/commit tuple and pushes or creates/adopts the PR
only after `ark_team_remote_decide` receives the current request ID and
explicit `approve_once`. `cancel_run` preserves local artifacts. The run
lifecycle tools persist and control orchestration records. Resuming a
remote-cancelled run performs read-only inspection again and creates a fresh
request ID.
`ark_team_plan_apply` accepts one strict `pm_plan`, requires a clean Git
repository root, creates up to four linked team worktrees and preserved local
branches, and atomically records their base commit and contracts.
`ark_team_team_list` reads those records. The assignment tools start explicitly
defined PL/worker app-server sessions, persist approval and completion updates,
and stop active sessions on assignment cancel or owning-run pause/cancel.

Before `ark_team_assignment_start`, call `ark_team_plan_apply` and use only the
returned team worktree. Use one `team_id` per team, start its PL first, and pass that PL
`assignment_id` as each worker's `parent_assignment_id`. The scheduler enforces
one PL per team, four teams per run, five workers per PL, and a shared team
worktree.

If PM execution or protocol validation fails, the runtime leaves a durable
`failed` run. If PM succeeds but worktree materialization fails, it preserves
the structured plan, PM session, and usage in a `planning` run. Correct the
workspace condition and retry that exact plan through `ark_team_plan_apply`;
do not spend another PM turn to regenerate it.

The bundled runtime reads `ARK_TEAM_WORKTREE_ROOT` as an optional absolute
managed-worktree root (a leading `~/` is expanded). Without it, worktrees live
under `.worktrees` inside `ARK_TEAM_STATE_ROOT`. The worktree root must resolve
outside the project checkout. Plan application rejects dirty repositories,
non-Git projects, nested project paths, existing target paths, and existing
team branches.

Pull-request mode currently accepts only `github.com` remotes and uses the
authenticated GitHub CLI on `PATH`. Set `ARK_TEAM_GH_PATH` to an alternate
executable path. Remote inspection is read-only and occurs before the runtime
creates an approval request.

Retain every assignment ID. Read `ark_team_assignment_status` or
`ark_team_assignment_list` for stored reports and usage. When the state is
`waiting_user`, the controller has already rejected the bounded
routine-command policy; distinguish its request type. For `pending_approval`, call
`ark_team_assignment_decide` only with the exact opaque approval ID and the
user's explicit decision while its original app-server session is live. If a
controller restart orphaned that session, use
`ark_team_assignment_recover` with the exact old ID and the user's explicit
`resume_safely` or `cancel_run`. Recovery resumes the same thread in a new turn
without applying the old approval; any still-needed dangerous action must
surface a fresh approval. For `pending_retry`, report the reason,
`session_attempt_count`, and `correction_count`, then call
`ark_team_assignment_retry_decide` with its opaque ID and explicit
`retry_once` or `cancel_run` choice. Then call `ark_team_advance` to continue
dependency-ready work and same-thread PL reporting.
For a pending integration `remote_action`, report its repository, remote,
source branch, target branch, commit, and opaque request ID. Use
`ark_team_remote_decide` only with the user's explicit `approve_once` or
`cancel_run`. Approved execution receives three idempotent attempts for the
same tuple; exhaustion creates a fresh request and requires a new decision.

The scheduler records interim PL worker plans for the controller, worker
reports for the owning PL, and final PL reports for PM. A team is completed
only after the final report covers every assigned worker and reports passing
verification. Once all teams complete, the run enters `integrating`; merge,
cross-team verification, local fast-forward, and PM final review are handled by
the managed integration coordinator. The original checkout must still be
clean, attached to its recorded branch, and at the common base commit. Team
worktrees must be clean and every team branch must descend from that base.
After PM acceptance, the coordinator removes only clean registered worktrees
whose branches remain contained by the accepted integration. It preserves all
local branches, records each cleanup, safely resumes partial cleanup, and marks
the run completed only after the integration worktree is also removed.
Pending approvals remain persisted across an MCP process restart. Their dead
wire requests cannot be reattached or answered. Explicit safe recovery instead
clears the orphaned request atomically and resumes its persisted thread in a
new turn, or cancels the run while preserving artifacts.

An abnormally failed internal assignment receives at most two automatic fresh
sessions. A structurally valid but blocked, mismatched, uncommitted when
required, or insufficiently verified report receives at most two corrective
turns on the same session. PL plan corrections and final-report corrections
have separate two-turn budgets. Exhaustion creates one durable
`pending_retry`; it never silently resets a counter or continues without the
opaque user decision. Observable retry/correction events include counters and
usage, never raw reasoning.

The bundled managed-session CLI is:

```text
node plugins/ark-team/runtime/dist/session-cli.js
  --role <pm|pl|worker>
  --cwd <absolute-directory>
  (--assignment <text> | --assignment-file <absolute-file>)
```

It uses `codex app-server` over local stdio. Each invocation starts or resumes
one thread and returns the session ID, final role report, configured role
metadata, and token usage. It never returns raw reasoning items. PM accepts an
existing directory and verifies a read-only/never profile. PL and worker
invocations require a linked Git worktree root, verify
workspace-write/on-request, and are rejected in the primary checkout.

This CLI is an execution primitive, not the persistent team scheduler. Do not
manually claim that it has staffed teams, created worktrees, routed reports, or
persisted assignments.

The managed-session CLI cannot present an approval. If a writer returns
`waiting_user`, the CLI interrupts that turn and fails closed. Send work that
may need an interactive decision through the persistent assignment scheduler.

For low-level managed role sessions, use the bundled
`AppServerApprovalSession` library from
`plugins/ark-team/runtime/dist/approval-session.js`. It launches
`codex app-server` over local stdio and verifies the returned model, `xhigh`
effort, sandbox, approval policy, and user reviewer before beginning the turn.
PM uses read-only/never. PL and worker use workspace-write/on-request and
require a linked Git worktree.

The low-level gateway returns `waiting_user` for command, file-change, and
permission requests without answering them. The persistent scheduler may
deliver `approve_once` automatically only when its exact-worktree routine
classifier accepts `npm ci`, a bounded local test, team-owned staging, a local
commit, or an integration merge of a recorded team branch. It persists the
request and `routine_policy` decision before continuing the same turn. An exact
` && ` chain is eligible only when it has at most four components and every
component independently passes the same classifier.

Present every remaining redacted request to the user, then call `decide()` with
`approve_once`, `approve_session`, `decline`, or `cancel`. Never reuse an
approval ID, auto-approve a permission/file-change/remote/destructive request,
or create a replacement session to bypass a pending request.

On completion the gateway returns only role metadata, session and turn IDs,
the final report, and usage. A live approval channel is process-local and
cannot survive controller restart. The gateway remains the session primitive;
the MCP control plane can explicitly resume the persisted thread in a new safe
turn without applying the lost approval. It invokes the PM, materializes its
validated plan, persists and routes child updates, and resumes each PL with its
validated worker reports.

### Native fallback

Use native Codex subagents when no managed runtime exists.

- Respect the active session's concurrency ceiling.
- Count the PM, PLs, and workers against the surfaced limit as applicable.
- Schedule tasks in waves when the full organization cannot run concurrently.
- Preserve the reporting hierarchy even when execution is sequential.
- Do not promise that a custom model or effort was applied unless the spawned agent configuration confirms it.
- Keep the PM from editing even if the parent session technically has write access.

Native fallback provides the workflow contract, not guaranteed multi-session isolation.

## Model-provider rules

Use OpenAI models by default:

- PM: `gpt-5.6-sol`, `xhigh`
- PL and integration PL: `gpt-5.6-terra`, `xhigh`
- worker: `gpt-5.6-luna`, `xhigh`

Use an external provider only in a run where the user explicitly names it. Treat provider-specific reasoning controls as separate from Codex `model_reasoning_effort`; do not assume `xhigh` maps to another provider.

After three provider or tool-call failures:

1. preserve the provider error and attempt count;
2. pause the affected assignment;
3. report choices to the user; and
4. wait for an explicit retry, provider change, or Luna fallback decision.

## Logs and retention

Use `~/.codex/team-orchestrator/runs/<run-id>/` as the managed-runtime default.

Expand a leading `~` through the current user's platform home-directory API before creating paths. Do not pass it as a literal path segment or rely on shell expansion. Accept absolute configured paths on every platform; resolve relative configured paths from the project root.

Generate run identifiers using lowercase ASCII letters, digits, and hyphens only. A recommended form is `ark-<UTC basic timestamp>-<short random id>`.

Record:

- run and team state transitions;
- agent role, model, assignment, start time, and end time;
- observable tool and command outcomes;
- changed files, worktrees, branches, and commit identifiers;
- verification commands and results;
- retries, replacements, approvals, and blockers; and
- request and token usage when supplied by the provider.

Do not record credentials or private reasoning. Retain logs for 30 days by default.

The first version may expose status through logs and runtime status operations. Do not require a web dashboard.
