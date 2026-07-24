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
- `ark_team_list`
- `ark_team_status`
- `ark_team_logs`
- `ark_team_pause`
- `ark_team_resume`
- `ark_team_cancel`

These tools persist and control orchestration records only. Until later runtime
slices add session scheduling and Git isolation, continue to use the native
fallback for actual team execution.

The bundled managed-session CLI is:

```text
node plugins/ark-team/runtime/dist/session-cli.js
  --role <pm|pl|worker>
  --cwd <absolute-directory>
  (--assignment <text> | --assignment-file <absolute-file>)
```

It uses the official TypeScript Codex SDK. Each invocation starts a new thread
and returns the session ID, final role report, configured role metadata, and
token usage. It never returns raw reasoning items. PM accepts an existing
directory and is launched read-only. PL and worker invocations require a linked
Git worktree root and are rejected in the primary checkout.

This CLI is an execution primitive, not the persistent team scheduler. Do not
manually claim that it has staffed teams, created worktrees, routed reports, or
persisted assignments.

The SDK currently uses non-interactive `codex exec`. Local live verification
showed that a requested `on-request` writer policy became `never` in the actual
turn context. Until an interactive app-server approval gateway is implemented,
never send dangerous work to the managed-session CLI. Pause the run and obtain
the user's decision first.

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
