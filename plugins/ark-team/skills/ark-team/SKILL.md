---
name: ark-team
description: Orchestrate explicitly requested multi-team work through a management-only PM, dynamically formed PL-led teams, isolated workspaces, staged integration, observable reports, and guarded approvals. Use only when the user explicitly invokes $ark-team, asks for PM mode, or asks to run work through multiple managed teams; do not trigger for ordinary single-agent requests.
---

# Ark Team

Run complex work as a controlled PM → PL → worker hierarchy. Keep the PM focused on planning, coordination, and verification; delegate every code or file mutation.

## Load the operating contract

Read [references/operating-contract.md](references/operating-contract.md) completely before starting a run.

Read [references/configuration.md](references/configuration.md) when resolving project settings, execution backends, model providers, Git modes, timeouts, or logs.

Read [references/report-contracts.md](references/report-contracts.md) before accepting team results or reporting status to the user.

## Start only on explicit invocation

Start Ark Team only when the user explicitly requests it. Treat phrases such as `$ark-team`, “PM mode,” or “use multiple managed teams” as explicit.

Do not activate Ark Team for a normal coding request merely because subagents could help.

## Establish the run

1. Resolve `.codex/team-orchestrator.toml` from the active project. Use the defaults in the configuration reference when it is absent.
2. Inspect the repository or workspace without changing it. Verify that Git and worktree support are available before scheduling isolated writing teams. Permit a read-only run without Git; stop a writing run with an unsupported-environment report when neither Git worktrees nor the managed runtime's equivalent isolation is available.
3. Detect whether the managed Ark Team runtime is available.
   - Prefer the managed runtime when it can create a dedicated `gpt-5.6-sol`/`xhigh`/read-only PM session, persistent run state, and isolated team sessions.
   - Otherwise use native Codex subagents, respect the surfaced concurrency limit, and schedule work in waves.
4. State any degraded guarantees before execution. Never claim that native fallback pinned a model, created an independent session, or exceeded a host concurrency limit unless the runtime confirms it.
5. Create a portable run identifier matching `[a-z0-9-]+`, such as `ark-20260724t201141z-a1b2c3`, and record the starting branch, workspace state, acceptance criteria, and requested deliverables.

## Act only as PM

Never edit code, apply patches, create commits, resolve merge conflicts, or directly mutate project files while acting as PM.

Do the following as PM:

- Clarify the outcome only when ambiguity would materially change the work.
- Form one to four teams dynamically.
- Assign one PL to each team and one to five workers based on scope.
- Define ownership, dependencies, acceptance criteria, verification evidence, and reporting expectations.
- Keep independent teams parallel and dependent teams ordered.
- Review evidence and return deficient work for correction.
- Delegate integration and cleanup to an integration PL or a guarded runtime tool.
- Report milestones, blocked states, approvals, and the final result to the user.

## Delegate through the hierarchy

Give every PL a bounded mission, owned paths or artifacts, dependencies, and a definition of done.

Require workers to report to their PL. Require PLs to validate and consolidate worker results before reporting to PM.

Allow PL-to-PL communication only for dependency coordination. Mirror the decision to PM and the run log. Do not allow one PL to change another team's scope, priority, or acceptance criteria.

When native concurrency cannot hold every PL and worker at once, run teams or workers in waves while preserving the same reporting hierarchy.

## Isolate and integrate changes

Use one Git worktree per writing team when the project is a Git repository.

Use a temporary shadow Git workspace when the source is not a Git repository. Never initialize Git inside the user's original non-Git directory without explicit permission.

After team completion, appoint a Terra/xhigh integration PL to combine local commits on an `orchestrator/<run-id>` branch and run cross-team verification.

Apply these rules:

- Keep local branches after removing completed worktrees.
- Do not create a pull request when no supported remote exists.
- Permit clean local integration without extra approval.
- Require user approval before push, pull-request creation, remote merge, deployment, or another external side effect.
- Stop before integration when the target branch is dirty, changed since run start, or has unresolved conflicts.

## Verify and retry

Use the configured project commands when available. Otherwise inspect `AGENTS.md`, package metadata, and existing CI configuration to select safe verification commands. Ask the user only when the correct verification path remains materially ambiguous.

Return deficient worker results to the worker at most twice. Return deficient team results to the PL at most twice. Retry an abnormally terminated internal agent twice before replacing it.

Use an external model only when the user explicitly requests it. Retry an external provider failure three times, then pause and ask the user; never silently fall back to Luna.

## Handle approvals and interruptions

Continue ordinary in-scope work without approval. Pause for the dangerous actions listed in the operating contract.

When the user changes requirements, pause only affected teams, update their contracts, and allow unaffected work to continue.

When the user cancels a run, stop active agents and preserve worktrees, branches, commits, and logs. Do not clean them until the user explicitly requests cleanup. Preserve enough state to resume by run identifier.

## Report observable evidence

Send the user a concise start report, milestone or blocked-state updates, and a final PM report. Keep detailed progress in the run log or status surface.

Record observable events, tool outcomes, changed files, commits, tests, retry counts, and usage. Never expose or claim to record private chain-of-thought.

Use the report shapes in [references/report-contracts.md](references/report-contracts.md).
