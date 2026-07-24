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
- The MCP control plane persists run and assignment state and can schedule
  explicitly defined PL/worker sessions. It does not yet run the PM planner or
  create worktrees.

## Runtime control plane

The plugin bundles a local stdio MCP server and registers it through `.mcp.json`.
It currently exposes:

- `ark_team_start`
- `ark_team_list`
- `ark_team_status`
- `ark_team_logs`
- `ark_team_pause`
- `ark_team_resume`
- `ark_team_cancel`
- `ark_team_assignment_start`
- `ark_team_assignment_list`
- `ark_team_assignment_status`
- `ark_team_assignment_decide`
- `ark_team_assignment_cancel`

Runs are stored as atomic JSON records under
`~/.codex/team-orchestrator/runs` by default. Set the absolute
`ARK_TEAM_STATE_ROOT` environment variable before starting Codex to use another
location.

Managed assignment records live in the same atomic run record. Each record
retains its team and parent PL, linked worktree, state, session and turn IDs,
one pending approval, routed final report, and token usage. Logs record
observable state changes and usage, not raw model reasoning or event history.

The scheduler enforces one PL per team, at most four teams per run, and at most
five workers per PL. Workers must use the same team worktree and identify their
owning PL assignment. A completed worker report is routed to that PL record; a
completed PL report is routed to PM.

If the MCP process restarts while approval is pending, the record remains
visible but its live app-server session is intentionally unavailable. Cancel
the orphaned assignment or preserve it for later recovery tooling; never start
a replacement session to bypass its unanswered approval.

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
defined PL and worker assignments.

The next runtime slices are still required to run the PM planner, parse spawn
requests, create and manage worktrees, dispatch independent teams in parallel,
resume PL sessions with worker reports, apply retries, and integrate verified
commits. The current control plane does not claim those guarantees.
