# Ark Team

`ark-team` is a repository-scoped Codex skill and plugin source for explicit PM-led, multi-team work.

The skill implements the operating contract agreed for:

- a management-only PM;
- dynamically created PL-led teams;
- isolated Git worktrees;
- staged local integration;
- guarded remote actions;
- observable status and reports; and
- resumable failure and cancellation handling.

## Repository layout

```text
.agents/skills/ark-team
  -> ../../plugins/ark-team/skills/ark-team
.codex/agents/
  ark_pm.toml
  ark_pl.toml
  ark_worker.toml
.codex/team-orchestrator.toml
plugins/ark-team/
  .mcp.json
  .codex-plugin/plugin.json
  runtime/
    dist/
      approval-session.js
      server.js
      session-cli.js
    src/
    test/
  skills/ark-team/
    SKILL.md
    agents/openai.yaml
    references/
```

The plugin copy under `plugins/ark-team` is the canonical skill and runtime
source. The `.agents/skills` link makes the same skill discoverable while
working in this repository. Project-scoped custom-agent definitions live under
`.codex/agents`.

## Requirements

- Use a Codex release that supports skills and subagents.
- Keep multi-agent support enabled.
- Use Node.js 18 or later to run the bundled local MCP server.
- Install Git with worktree support for isolated writing teams, or provide an equivalent managed-runtime isolation backend.
- Expect native fallback to obey the host's concurrency limit.
- Native custom agents pin PM to Sol/xhigh, PL to Terra/xhigh, and workers to
  Luna/xhigh.
- The managed session launcher uses the official TypeScript Codex SDK and
  requires an authenticated `codex` executable on `PATH`.
- The approval-gated writer backend uses `codex app-server` over local stdio
  and requires a compatible generated stable protocol schema.
- Pull-request mode supports `github.com` remotes and requires an authenticated
  GitHub CLI (`gh`) on `PATH`; set `ARK_TEAM_GH_PATH` to override its path.
- The MCP control plane persists run and assignment state and can schedule
  a managed PM → PL → worker hierarchy, materialize the PM plan into linked
  team worktrees, and resume each PL with its workers' validated reports.

## Runtime control plane

The plugin bundles a local stdio MCP server and registers it through `.mcp.json`.
It currently exposes:

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

Runs are stored as atomic JSON records under
`~/.codex/team-orchestrator/runs` by default. Set the absolute
`ARK_TEAM_STATE_ROOT` environment variable before starting Codex to use another
location.

At run creation the runtime strictly loads
`.codex/team-orchestrator.toml` from the selected project, applies documented
defaults, and stores the complete resolved snapshot in the run. Project
overrides can narrow team and worker counts, tune managed session, retry, and
correction limits, set a safe integration branch prefix, and add literal
verification commands. Fixed Sol/Terra/Luna `xhigh` roles, PM/writer
permissions, remote approval, branch preservation, usage-only logging, and
private-reasoning exclusion cannot be weakened. Unknown keys, credentials,
unsafe paths, and invalid values fail before a run is created. Later edits to
the TOML do not alter an existing run.

`ark_team_plan_apply` accepts one validated `pm_plan`. For a clean Git
repository root it creates one linked worktree and
`ark-team/<run-id>/<team-id>` branch per team from the same base commit, then
atomically stores the plan and team records. `ark_team_team_list` returns their
mission, dependencies, branch, worktree, base commit, worker count, and state.
Set `ARK_TEAM_WORKTREE_ROOT` to an absolute path or `~/...` to override the
default `<state-root>/.worktrees` location. The resolved location must be
outside the project checkout.

`ark_team_execute` combines run creation, a Sol/xhigh read-only PM turn, strict
plan validation, PM session/usage persistence, and plan application. A PM
failure leaves a durable failed run. A later worktree failure leaves the
validated PM plan in a planning run so `ark_team_plan_apply` can retry it
without consuming another PM turn.

After plan materialization, the coordinator starts independent Terra PLs in
parallel, validates their exact worker counts, runs dependency-ready Luna
workers in waves, and resumes each original PL session with the consolidated
worker reports. `ark_team_advance` continues that process after an approval
decision. When all PL reports cover their workers with passing verification,
the run enters `integrating`. The top-level coordinator then creates
`orchestrator/<run-id>` in a separate linked worktree and assigns a Terra/xhigh
integration PL. It independently verifies a clean reported commit containing
every team branch tip.

For `local_merge`, the runtime fast-forwards the original branch only when its
branch, HEAD, and cleanliness still match the recorded start boundary. It then
resumes the original Sol/xhigh read-only PM session for a strict final
`pm_report`. For `pull_request`, it first verifies the local GitHub remote and
CLI authentication read-only, then returns `remote_action_required` with one
opaque request containing the exact remote, branch, target, and commit tuple.
Only `ark_team_remote_decide` with the current request ID and the user's
explicit `approve_once` may push that commit and create or adopt its PR.
`cancel_run` preserves every local artifact; explicitly resuming that run
creates a fresh request rather than reusing the cancelled approval. Approved
execution is idempotent across restarts and receives at most three attempts
before a fresh approval is required.

After either local fast-forward or an approved PR succeeds, the original PM
session performs final read-only acceptance. The runtime then removes only
clean registered team and integration worktrees whose branches are contained
by the accepted integration. Every local team and integration branch is
preserved and checked; the run becomes `completed` only after cleanup. Partial
cleanup is idempotent when resumed.

Internal PL/worker session failures receive at most two automatic fresh-session
retries. Valid but deficient plans and reports receive at most two
same-session correction turns. Assignment records retain attempt and
correction counters. Exhaustion creates a distinct opaque `pending_retry`;
`ark_team_assignment_retry_decide` accepts only an explicit `retry_once` or
`cancel_run` choice, and stale or replayed request IDs fail closed.

Managed assignment records live in the same atomic run record. Each record
retains its team and parent PL, linked worktree, state, session and turn IDs,
task key and output contract, one pending approval or retry request, routed
structured report, attempt/correction/turn counts, and token usage. Logs record
observable state changes and usage, not raw model reasoning or event history.

The scheduler enforces one PL per team, at most four teams per run, and at most
five workers per PL. Workers use the same team worktree and identify their
owning PL assignment. Interim PL plans route to the controller, completed
worker reports route to the owning PL, and the PL's same-session final report
routes to PM.

If the MCP process restarts while an approval is pending, the record remains
visible but its old app-server request channel is gone. Use
`ark_team_assignment_recover` with that exact run, assignment, and approval ID.
`resume_safely` resumes the persisted Codex thread in a new turn that explicitly
treats the old approval as not applied; if the action is still needed, the
agent must surface a fresh approval ID. `cancel_run` stops the run while
preserving worktrees, branches, commits, reports, and logs. Ordinary
`ark_team_assignment_decide` remains valid only while the original live
session exists, and stale or replayed recovery requests fail closed.

Build and verify the bundled server from the repository root:

```sh
npm install
npm test
```

`npm test` type-checks the source, runs persistence, scheduler, and
approval-gateway tests, builds the MCP server, managed-session CLI, and
approval-session library, and exercises the CLI and MCP entry points.

## Managed role sessions

The managed launcher starts every role as a separate Codex thread with explicit
model, reasoning, sandbox, and approval configuration. It returns only the
thread ID, final role report, configuration metadata, and token usage; raw
reasoning and event items are not returned.

Controller code can select a strict `output_contract` for machine-readable
turns:

- `pm_plan` and `pm_report` for PM;
- `pl_worker_plan`, `pl_report`, and `integration_report` for PL; and
- `worker_report` for workers.

Structured calls pass the matching JSON Schema to Codex and return the parsed
`structured_report` only after a second strict runtime validation. Plans reject
unknown fields, more than four teams, more than five workers, duplicate IDs,
unknown dependencies, and dependency cycles.

Pass the prior `session_id` as `resume_session_id` to continue a completed
role thread. PM continuation uses the SDK's persisted thread; PL/worker
continuation uses app-server `thread/resume`. Both paths reapply the exact
managed role profile and reject a different thread ID. The writer path also
rechecks the worktree cwd, workspace-write roots, disabled network, user
approval routing, model, and xhigh effort before starting the new turn.

Run a read-only PM session:

```sh
node plugins/ark-team/runtime/dist/session-cli.js \
  --role pm \
  --cwd /absolute/path/to/project \
  --assignment "Inspect the project and return a bounded team plan."
```

PL and worker sessions accept only the root of a linked Git worktree. The
launcher refuses the primary checkout and directories without a valid `.git`
pointer file:

```sh
node plugins/ark-team/runtime/dist/session-cli.js \
  --role worker \
  --cwd /absolute/path/to/linked-worktree \
  --assignment-file /absolute/path/to/assignment.txt
```

Use `ARK_TEAM_CODEX_PATH` when `codex` is installed at a non-default path. The
optional live verification starts real Sol and Luna sessions in a disposable
temporary repository and therefore consumes model usage:

```sh
npm run verify:managed-sessions
```

The official TypeScript SDK backend still uses non-interactive `codex exec`. In
the locally verified Codex release, a requested `on-request` writer policy
appeared as `never` in that turn context because no interactive approval
channel was available. Continue to use it for the read-only PM and for writer
assignments that cannot require interactive approval.

For PL and worker assignments that may need approval, import
`AppServerApprovalSession` from
`plugins/ark-team/runtime/dist/approval-session.js`. It starts
`codex app-server` over stdio, verifies the selected writer profile, and returns
either:

- `waiting_user`, with one opaque command, file-change, or permission approval;
  or
- `completed`, with the final role report and token usage.

Call `decide()` with `approve_once`, `approve_session`, `decline`, or `cancel`
only after obtaining the required user decision. The object continues waiting
on the same thread and turn. It rejects PM sessions and writer directories that
are not linked Git worktree roots. It does not persist a pending approval after
the controller process exits.

Check protocol compatibility without consuming model usage:

```sh
npm run verify:app-server-schema
```

The optional live verification consumes Luna usage. It creates a disposable
repository, surfaces and declines one outside-worktree command approval,
confirms that the file was not created, and removes the fixture:

```sh
npm run verify:approval-gateway
```

## Use in this repository

Invoke the skill explicitly:

```text
$ark-team implement this feature
```

The skill intentionally does not trigger for ordinary single-agent requests.
Start a new Codex conversation after adding or changing project custom-agent
files so the process reloads their definitions.

## Install globally from this repository

This repository is also a Codex plugin marketplace. Install the source once,
then install the plugin:

```sh
codex plugin marketplace add elicie/ark-team --ref main
codex plugin add ark-team@ark-team-marketplace
```

Confirm the globally installed and enabled plugin:

```sh
codex plugin list --available --json
```

After publishing an update, refresh the marketplace and reinstall or update
the plugin using the Codex plugin commands shown by the current CLI. Start a
new Codex session so it reloads the skill and MCP server. Global installation
provides the runtime and `$ark-team`; each target project continues to control
its own safe overrides through `.codex/team-orchestrator.toml`.

## Reference from another repository

Create a project-scoped symbolic link to the canonical skill:

```sh
mkdir -p /absolute/path/to/other-project/.agents/skills
ln -s /absolute/path/to/arc/plugins/ark-team/skills/ark-team \
  /absolute/path/to/other-project/.agents/skills/ark-team
```

Use an absolute path so the link remains unambiguous. Do not overwrite an existing `ark-team` directory or link.

Copy the project custom agents when the target repository should use the pinned
native PM/PL/worker roles:

```sh
mkdir -p /absolute/path/to/other-project/.codex/agents
cp .codex/agents/ark_*.toml \
  /absolute/path/to/other-project/.codex/agents/
```

To make the skill available to all local projects, link it into the user skill directory instead:

```sh
mkdir -p ~/.agents/skills
ln -s /absolute/path/to/arc/plugins/ark-team/skills/ark-team \
  ~/.agents/skills/ark-team
```

When symbolic links are unavailable or undesirable, copy the skill instead:

```sh
cp -R /absolute/path/to/arc/plugins/ark-team/skills/ark-team \
  /absolute/path/to/other-project/.agents/skills/ark-team
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force C:\path\to\other-project\.agents\skills
Copy-Item -Recurse C:\path\to\arc\plugins\ark-team\skills\ark-team `
  C:\path\to\other-project\.agents\skills\ark-team
New-Item -ItemType Directory -Force C:\path\to\other-project\.codex\agents
Copy-Item C:\path\to\arc\.codex\agents\ark_*.toml `
  C:\path\to\other-project\.codex\agents
```

Copied skills do not receive updates from this repository. Use a link or repeat the copy after source changes.

To create a separate customized skill rather than sharing this source, ask Codex:

```text
Use $skill-creator. Read /absolute/path/to/arc/plugins/ark-team/skills/ark-team/SKILL.md
and its references, then create a project-specific variant without modifying the source.
```

Before public distribution, publish a reviewed commit or tag and add an
explicit license plus durable publisher metadata.

## Current implementation boundary

This repository currently provides the validated skill contract, project
defaults, plugin package, persistent run records, MCP lifecycle/status tools,
project-scoped native custom agents, an official-SDK role launcher, a tested
app-server approval gateway, and a persistent MCP scheduler for explicitly
defined PL and worker assignments. Role sessions now expose strict planning and
report JSON contracts and can continue completed PM, PL, and worker threads.
The control plane can also materialize a validated PM plan into durable linked
team worktrees and preserved local branches, and `ark_team_execute` now drives
that PM-planning path from one MCP call.

The runtime now dispatches independent teams and workers concurrently, gates
dependencies, routes stored worker reports into same-session PL continuations,
applies bounded internal failure retries and report corrections, and stops with
durable approval or retry-choice state. It also runs a distinct integration PL,
checks Git ancestry and cleanliness, performs guarded local fast-forward, and
resumes the PM for final acceptance. It now also gates an exact GitHub push/PR
tuple behind one explicit approval and cleans verified linked worktrees while
preserving branches. Persisted approval waits can be explicitly recovered after
a controller restart on the same thread without carrying the lost approval into
the new turn. The next runtime slices are still required to add explicit
external-provider and non-Git adapters. The current control plane does not
claim those remaining guarantees.
