# Ark Team Operating Contract

## Contents

1. Role boundaries
2. Run lifecycle
3. Communication rules
4. Workspace and integration rules
5. Approval boundary
6. Failure, timeout, and cancellation policy

## Role boundaries

### PM

Use `gpt-5.6-sol` with `xhigh` reasoning in the managed runtime. Give the PM read-only project access and orchestration tools.

Permit the PM to:

- translate the user's request into acceptance criteria;
- choose one to four teams dynamically;
- assign scope, dependencies, priorities, and verification;
- inspect code, diffs, logs, reports, and test evidence;
- reject deficient results;
- decide whether a clean local integration is appropriate;
- request guarded worktree cleanup;
- ask the user for dangerous-action approvals; and
- issue the final report.

Prohibit the PM from:

- editing or creating project files;
- applying patches;
- making commits;
- merging branches itself;
- resolving code conflicts;
- running unguarded destructive commands; or
- silently broadening the user's scope.

Calling a guarded runtime operation does not make the PM the file editor. The runtime or assigned PL owns and records the mutation.

### PL

Use `gpt-5.6-terra` with `xhigh` reasoning.

Require each PL to:

- divide its mission into one to five bounded worker tasks;
- assign non-overlapping ownership where possible;
- coordinate dependencies;
- inspect worker evidence;
- request up to two correction rounds;
- stage only team-owned worker changes and create the team's local commit; and
- return one consolidated report to PM.

Do not let a PL declare success solely from worker statements. Require observable evidence.

### Worker

Use `gpt-5.6-luna` with `xhigh` reasoning by default.

Require each worker to:

- stay within assigned scope;
- preserve unrelated user changes;
- perform the requested implementation, research, review, or verification;
- run focused checks;
- leave staging and commit to the owning PL; and
- report result, evidence, risks, and blockers to the PL.

Use Z.AI, Kimi, or another external provider only after an explicit user request.

### Integration PL

Use `gpt-5.6-terra` with `xhigh` reasoning after team work completes.

Require the integration PL to:

- integrate team commits on `orchestrator/<run-id>`;
- resolve conflicts without changing approved behavior;
- return work to the responsible team when conflict resolution requires a product decision;
- run cross-team verification; and
- report the integrated commit and evidence to PM.

## Run lifecycle

Use these states:

1. `planning` — capture requested outcome and acceptance criteria.
2. `staffing` — choose teams, PLs, workers, ownership, and dependencies.
3. `executing` — run team work, in parallel where independent.
4. `integrating` — combine team results in an integration workspace.
5. `verifying` — run cross-team checks and review acceptance evidence.
6. `waiting_user` — pause for a dangerous action, unresolved decision, or exhausted retry.
7. `completed` — report the accepted result and perform authorized cleanup.
8. `cancelled` — stop agents and preserve resumable state.
9. `failed` — preserve evidence and report why the run cannot continue.

Do not skip `verifying` for writing tasks.

## Communication rules

- Route worker completion reports to the owning PL.
- Route team completion reports to PM.
- Permit PL-to-PL messages for dependency questions and interface coordination.
- Mirror direct PL decisions to PM and the event log.
- Prohibit PLs from directly assigning work to another team's workers.
- Require PM arbitration when PLs disagree or a decision changes scope, schedule, or acceptance criteria.
- Keep routine progress out of the user-facing chat when it is available in status logs.

## Workspace and integration rules

Before a writing run, verify that Git is installed and that worktree operations are supported, or verify that the managed runtime provides equivalent isolated workspaces. Permit read-only team work without Git. If safe write isolation is unavailable, enter `failed` with an unsupported-environment report instead of letting teams write concurrently in the original directory.

### Git with no remote

- Create team worktrees and local branches.
- Integrate on `orchestrator/<run-id>`.
- Let PM direct a clean local merge through the integration PL.
- Never claim to have created a pull request.

### Git with a remote

- Work locally until verification passes.
- Require user approval before push, pull-request creation, or remote merge.
- Preserve local commits when approval is withheld.

### Non-Git source

- Create a baseline snapshot and file-hash manifest outside the original directory.
- Initialize shadow Git only inside the temporary workspace.
- Give each writing team an isolated worktree from that baseline.
- Integrate and verify in the shadow repository.
- Before applying results, verify that the original files have not drifted.
- Stop and report conflicts instead of overwriting concurrent user changes.

### Cleanup

Remove a team worktree only when:

- its changes are committed;
- the integration contains its accepted result;
- verification has passed;
- no untracked or uncommitted data remains in the worktree; and
- the run is not cancelled or waiting for user review.

Preserve local branches. Report every removed worktree.

## Approval boundary

Require explicit user approval for:

- remote push, pull-request creation, or remote merge;
- deployment or production-environment changes;
- database migration;
- deletion that could lose files, branches, data, or history;
- external messages, issues, tickets, or publications;
- secrets, permissions, authentication, or security-policy changes;
- infrastructure or system-package changes; and
- unexpectedly large paid API use.

Allow without additional approval:

- read-only inspection;
- native agent creation within the configured limits;
- local edits by assigned implementation agents;
- focused tests;
- local commits;
- clean local integration directed by PM; and
- guarded removal of verified, clean worktrees after successful integration.

Follow any stricter repository, system, or user instruction.

For an interactive managed writer session, the controller may automatically
deliver one-time approval only for a command it independently validates as a
routine operation in the exact registered worktree: lockfile-pinned `npm ci`,
bounded local test scripts, a PL's `git add` limited to recorded team-owned paths,
an inert-message PL or integration-PL local `git commit`, or an integration-PL merge of an exact
recorded team branch. Up to four commands may be joined by exact ` && `
separators only when every component independently passes those checks.
Persist the request and its `routine_policy` decision before delivery. Never
grant session-wide approval through this policy.

Treat every other surfaced approval as one unresolved `waiting_user` state.
Resume the same turn only after the user selects one-time approval, session
approval, decline, or cancel. Push, reset, clean, broad staging, arbitrary
or partially validated shell composition, wrong-worktree commands, file
changes, and permission
expansion must never match the routine policy. Treat an expired, unknown, or
already resolved approval ID as an error instead of replaying the decision.

If a controller restart destroys the live approval channel, never treat the
persisted ID as an approvable wire request. Recover only through the explicit
orphan-recovery operation and the user's `resume_safely` or `cancel_run`
choice. Safe recovery starts a new turn on the same thread, records that the
old approval was not applied, and requires a fresh request and decision for any
still-dangerous action. Cancellation preserves local artifacts.

Treat retry exhaustion as a separate `waiting_user` decision, not a dangerous
action approval. Show its counters and redacted failure reason, then accept
only `retry_once` or `cancel_run` through the opaque retry request. Never route
a retry request through the command/file approval channel.

## Failure, timeout, and cancellation policy

- Permit two worker correction rounds.
- Permit two PL correction rounds.
- Retry an abnormally terminated internal agent twice, then replace it.
- Retry an explicitly requested external provider three times, then enter `waiting_user`.
- Limit one agent assignment to 60 minutes by default.
- Limit one run to 360 minutes by default.
- On timeout, persist state and report instead of discarding work.
- On cancellation, stop all active agents, block new spawns, preserve artifacts, and make the run resumable.
- On user requirement changes, pause and replan only affected teams.
