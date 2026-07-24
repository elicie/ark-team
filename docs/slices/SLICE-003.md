# Closed Contract — SLICE-003

- Spec identity: `ark-team` operating contract at Git revision
  `b23351819e75601fa49bb0f653e1863111aa3025`, the SLICE-002 permission delta,
  and the user's 2026-07-24 selection of the recommended separately permissioned
  session architecture.
- Slice approval: The user selected the recommended implementation after
  reviewing the native and managed-session tradeoffs.
- Objective: Add the smallest usable TypeScript execution primitive that starts
  PM, PL, and worker roles as independent Codex sessions with role-specific
  model, reasoning, and sandbox boundaries.
- Included requirements:
  - `REQ-301`: Use the official TypeScript Codex SDK instead of implementing a
    new coding-agent protocol.
  - `REQ-302`: Configure PM as Sol/xhigh/read-only and PL/worker as
    Terra-or-Luna/xhigh/workspace-write in independent new threads.
  - `REQ-303`: Refuse PL and worker execution outside the root of a linked Git
    worktree.
  - `REQ-304`: Return only the session ID, configured role metadata, final role
    report, and provider usage.
  - `REQ-305`: Fail closed on cancellation, timeout, execution failure, or
    missing session evidence.
  - `REQ-306`: Provide a built CLI entry point and an opt-in live verification
    that uses disposable workspaces.
- Acceptance criteria:
  - `AC-301`: All three role profiles exactly match the approved model, effort,
    sandbox, and requested approval settings.
  - `AC-302`: Every launcher call uses `startThread`; PM and writer calls receive
    different SDK thread options and session IDs.
  - `AC-303`: PM can start in any existing absolute directory, while PL and
    worker calls fail before model execution when `.git` is a directory,
    missing, malformed, or points to a missing Git directory.
  - `AC-304`: A successful result does not contain raw SDK items or reasoning and
    does contain non-null token usage.
  - `AC-305`: Missing IDs, reports, or usage produce a protocol error; timeout
    produces a closed session failure.
  - `AC-306`: The bundled CLI preserves the workspace guard.
  - `AC-307`: A live probe confirms distinct Sol PM and Luna worker sessions,
    a read-only PM checkout, and worker writes confined to a linked temporary
    worktree.
  - `AC-308`: Existing typecheck, unit, MCP, skill, and plugin validation
    continue to pass.
- Verification cases:
  - `TEST-301`: Managed role profile contract test.
  - `TEST-302`: Independent SDK thread and redacted-result test.
  - `TEST-303`: Primary-checkout writer refusal test.
  - `TEST-304`: Missing-evidence failure test.
  - `TEST-305`: Timeout and cancellation failure test.
  - `TEST-306`: Built CLI workspace-guard smoke test.
  - `TEST-307`: Opt-in real Codex PM and worker probe.
  - `TEST-308`: Repository regression and official validators.
- Required definitions and external contracts:
  - `@openai/codex-sdk` `0.145.0`.
  - Stable Codex non-interactive sessions and persisted thread IDs.
  - The existing Ark Team operating and reporting contracts.
- Dependencies and preconditions:
  - Node.js 18 or later.
  - An authenticated `codex` executable on `PATH`, or an explicit
    `ARK_TEAM_CODEX_PATH`.
  - Git linked worktrees for PL and worker execution.
- Explicit exclusions:
  - Persistent team and assignment scheduling.
  - Automatic worktree creation, integration, or cleanup.
  - PM-to-PL and PL-to-worker message routing.
  - Four-team concurrency and retry replacement.
  - Interactive app-server approval continuation.
  - External model providers.
  - MCP tools that directly start managed sessions.
- Reference boundary: Repository files at the baseline revision and preserved
  SLICE-002 worktree, the installed official SDK declarations and README, and
  the current Codex manual.
- Unknowns that do not affect acceptance: The scheduler's final queue format
  and the app-server approval request schema.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision or inventory identity:
  `b23351819e75601fa49bb0f653e1863111aa3025`
- Existing modified/untracked artifacts: The preserved, passing SLICE-002 custom
  agents, skill routing, model verifier, tests, README updates, and result
  record.
- Existing validation failures: None; the pre-change `npm test` completed with
  seven unit tests and one MCP smoke test passing.
- Relevant commands confirmed: `node`, `npm`, `git`, authenticated `codex`,
  TypeScript compiler, esbuild, and the official skill/plugin validators.
- Environmental limits:
  - Docker is prohibited and is not required.
  - No infrastructure or development server is required.
  - The current TypeScript SDK uses non-interactive `codex exec`.

# Evidence Matrix

| REQ | AC | TEST/check | Evidence | Result | Notes |
|---|---|---|---|---|---|
| REQ-301, REQ-302 | AC-301, AC-302 | TEST-301, TEST-302 | `npm test` validates the three profiles, separate `startThread` calls, exact thread options, and distinct session IDs | PASS | Native subagents and apps are disabled in managed sessions |
| REQ-303 | AC-303 | TEST-303 | Unit test rejects a primary checkout before the fake SDK client is called | PASS | Valid linked-worktree pointer and target directory are required |
| REQ-304 | AC-304 | TEST-302 | Result-key assertion contains final report and usage but no raw SDK item list | PASS | |
| REQ-305 | AC-305 | TEST-304, TEST-305 | Missing evidence and a five-millisecond fake timeout both return typed closed failures | PASS | |
| REQ-306 | AC-306 | TEST-306 | Built `dist/session-cli.js` rejects this repository's primary checkout for a worker role | PASS | |
| REQ-306 | AC-307 | TEST-307 | `npm run verify:managed-sessions` started Sol PM `019f9608-e338-7f73-ab2d-cfad6cbaeeff` and Luna worker `019f9609-00b2-7153-b85f-a77d1ab3e4d2` | PASS | PM left the repository clean; worker created the expected file only in a disposable linked worktree |
| REQ-301–REQ-306 | AC-308 | TEST-308 | `npm test`, model verifier, skill validator, plugin validator, JSON/TOML parsing, and `npm audit --audit-level=moderate` | PASS | 12 unit tests, 1 CLI smoke test, 1 MCP smoke test; 0 vulnerabilities |

# Result Record

- Terminal status: `SLICE_ACCEPTED_WITH_WARNINGS`
- Completed at: 2026-07-24 UTC
- Implementation:
  - Added an official-SDK `ManagedCodexSessionLauncher` with exact role
    profiles and a 60-minute closed timeout.
  - Disabled native subagents, apps, network access, and web search in managed
    role sessions.
  - Added a linked-worktree guard for every writing role.
  - Added a built CLI that accepts assignment text, a file, or stdin and emits
    only the final report, configuration metadata, thread ID, and usage.
  - Added an opt-in disposable live probe plus unit and bundle-level tests.
- Verification:
  - `npm test`: 12 unit tests, one built-CLI test, and one MCP smoke test
    passed; typecheck and both bundles passed.
  - `npm run verify:managed-sessions`: real Sol PM and Luna worker sessions
    passed with distinct IDs and expected filesystem boundaries.
  - Persisted live turn contexts confirmed Sol/xhigh/read-only/never and
    Luna/xhigh/workspace-write/no-network.
  - `npm run verify:codex-models`: all three approved model slugs advertise
    `xhigh`.
  - Official skill and plugin validators, JSON/TOML parsing, and npm audit
    passed.
- Warning:
  - The TypeScript SDK uses non-interactive `codex exec`. Although the worker
    profile requested `on-request`, the persisted live turn context reported
    `approval_policy=never`. Dangerous tasks must remain blocked before launch
    until the later interactive app-server approval gateway is implemented.
  - The returned field is therefore named `requested_approval_policy`; the
    launcher does not falsely report that an interactive policy was active.
- Rollback/recovery:
  - Remove the managed-session source, CLI, tests, SDK dependency, and second
    bundle while preserving the existing MCP state store and native role files.
  - The live probe removed its disposable repository and worktree. Codex thread
    records remain in the authenticated user's normal local session history.
- Recommended next action:
  - Implement the persistent team/assignment scheduler and app-server approval
    gateway before routing dangerous or multi-team writing runs through this
    launcher.
