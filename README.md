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
.codex/team-orchestrator.toml
plugins/ark-team/
  .mcp.json
  .codex-plugin/plugin.json
  runtime/
    dist/server.js
    src/
    test/
  skills/ark-team/
    SKILL.md
    agents/openai.yaml
    references/
```

The plugin copy under `plugins/ark-team` is the canonical source. The `.agents/skills` link makes the same skill discoverable while working in this repository.

## Requirements

- Use a Codex release that supports skills and subagents.
- Keep multi-agent support enabled.
- Use Node.js 18 or later to run the bundled local MCP server.
- Install Git with worktree support for isolated writing teams, or provide an equivalent managed-runtime isolation backend.
- Expect native fallback to obey the host's concurrency limit.
- The current MCP control plane persists run state but does not yet create model-pinned agent sessions.

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

Runs are stored as atomic JSON records under
`~/.codex/team-orchestrator/runs` by default. Set the absolute
`ARK_TEAM_STATE_ROOT` environment variable before starting Codex to use another
location.

Build and verify the bundled server from the repository root:

```sh
npm install
npm test
```

`npm test` type-checks the source, runs persistence tests, builds
`plugins/ark-team/runtime/dist/server.js`, and exercises the built server over
MCP stdio.

## Use in this repository

Invoke the skill explicitly:

```text
$ark-team implement this feature
```

The skill intentionally does not trigger for ordinary single-agent requests.

## Reference from another repository

Create a project-scoped symbolic link to the canonical skill:

```sh
mkdir -p /absolute/path/to/other-project/.agents/skills
ln -s /absolute/path/to/arc/plugins/ark-team/skills/ark-team \
  /absolute/path/to/other-project/.agents/skills/ark-team
```

Use an absolute path so the link remains unambiguous. Do not overwrite an existing `ark-team` directory or link.

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
defaults, plugin package, and the first managed-runtime slice: persistent run
records plus MCP lifecycle/status tools. Without the later scheduler, the skill
still uses native Codex subagents and schedules work within the host's
concurrency limit.

The next runtime slices are still required to create and pin a separate
Sol/xhigh PM session, independently schedule Terra PL and Luna worker sessions,
manage worktrees and integration, and continue approval-gated work. The current
control plane does not claim those guarantees.
