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
  .codex-plugin/plugin.json
  skills/ark-team/
    SKILL.md
    agents/openai.yaml
    references/
```

The plugin copy under `plugins/ark-team` is the canonical source. The `.agents/skills` link makes the same skill discoverable while working in this repository.

## Requirements

- Use a Codex release that supports skills and subagents.
- Keep multi-agent support enabled.
- Install Git with worktree support for isolated writing teams, or provide an equivalent managed-runtime isolation backend.
- Expect native fallback to obey the host's concurrency limit.
- Install the planned managed runtime later if dedicated model-pinned sessions and persistent orchestration are required.

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

Before distributing this repository through Git, track the skill files and publish a reviewed commit or tag. Add an explicit license, canonical repository URL, and durable publisher metadata before public distribution.

## Current implementation boundary

This repository currently provides the validated skill contract, project defaults, and plugin scaffold. Without a managed Ark Team runtime, the skill uses native Codex subagents and schedules work within the host's concurrency limit.

The planned TypeScript Codex SDK/MCP runtime is required to guarantee a separate Sol/xhigh PM session, independent team sessions, persistent execution, and runtime status controls.
