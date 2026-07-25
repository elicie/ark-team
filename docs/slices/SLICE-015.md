# Closed Contract — SLICE-015

- Spec identity: Active completion goal and accepted SLICE-014 at Git revision
  `bd7a658`.
- Objective: Package, globally install, and independently verify the completed
  Ark Team plugin from its GitHub marketplace source, then close the active
  end-to-end implementation goal with reproducible evidence.
- Included requirements:
  - `REQ-1501`: Publish one valid personal marketplace entry that resolves the
    existing `plugins/ark-team` source without duplicating runtime code.
  - `REQ-1502`: Install `ark-team` globally from the repository's `main`
    marketplace and confirm Codex reports it installed and enabled.
  - `REQ-1503`: Confirm the installed cache is detached from the working tree,
    contains the skill, manifest, MCP registration, and built stdio server, and
    can list the complete Ark Team MCP tool surface.
  - `REQ-1504`: Keep project-specific behavior in each target project's
    `.codex/team-orchestrator.toml`; global installation must not copy or
    overwrite project settings.
  - `REQ-1505`: Run the complete deterministic test/build suite, app-server
    protocol check, exact model/effort check, skill/plugin/marketplace
    validation, dependency audit, diff check, and clean-tree/remote checks.
  - `REQ-1506`: Document invocation, global install/update verification,
    project overrides, remote limits, and explicit current exclusions.
- Acceptance criteria:
  - A new Codex session can discover `$ark-team` and the `ark-team` MCP server
    from the global installation without a repository-scoped symlink.
  - The installed server starts from its cached plugin directory and exposes
    the same tool names as the source build.
  - No test performs Docker/infrastructure work, a paid model call, push/PR
    side effects against a fixture, or destructive cleanup outside registered
    temporary worktrees.
  - Source `main`, `origin/main`, and the installed marketplace revision agree
    after the final Korean commit and push.
- Verification cases:
  - `TEST-1501`: Marketplace and plugin validators accept the package.
  - `TEST-1502`: `codex plugin list --available --json` reports
    `ark-team@ark-team-marketplace` installed and enabled from the Git source.
  - `TEST-1503`: A standalone MCP client starts the installed bundled server
    and obtains the expected complete tool list.
  - `TEST-1504`: Full repository validation and safety checks pass from a clean
    checkout state.
- Explicit exclusions:
  - Non-Git shadow repositories, external model provider adapters, direct
    PL-to-PL transport, dashboard, deployment, remote merge, and live paid
    multi-agent execution. These are follow-up capabilities, not claims of the
    active linked-worktree/Luna goal.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision: `bd7a658`
- Existing modified/untracked artifacts: None before this contract was added.
- Existing validation failures: None; 72 unit, 1 CLI, and 5 MCP tests passed.
- Environmental limits: no Docker, infrastructure, development port, real
  fixture remote mutation, or paid live model call.

# Evidence Matrix

| Requirement | Implementation evidence | Verification evidence |
|---|---|---|
| `REQ-1501` | `.agents/plugins/marketplace.json` publishes the single existing `./plugins/ark-team` package with complete policy and category metadata | Marketplace registration resolved `ark-team-marketplace`; plugin validator passed |
| `REQ-1502` | Git marketplace `elicie/ark-team@main` is registered globally and plugin manifest version is `0.1.1` | `codex plugin list --available --json` reports `ark-team@ark-team-marketplace` installed and enabled from `https://github.com/elicie/ark-team.git` |
| `REQ-1503` | `verify-installed-plugin.mjs` checks manifest, skill, MCP config, bundle, launches the cached server, and compares the exact sorted tool surface | `INSTALLED_PLUGIN_VERIFIED`, cache `/home/elicie/.codex/plugins/cache/ark-team-marketplace/ark-team/0.1.1`, 19 tools |
| `REQ-1504` | Plugin package contains no copied target-project TOML; runtime resolves configuration from each requested project at run creation | `TEST-1401`–`TEST-1406`; installed cache inspection |
| `REQ-1505` | Root scripts cover deterministic unit/E2E, bundles, CLI, MCP, protocol, models, validators, audit, and installed-cache verification | Final validation below |
| `REQ-1506` | README and skill references document explicit invocation, global marketplace install, project snapshots, approval/recovery rules, and exclusions | Skill and plugin validators passed |

Final validation on 2026-07-24 UTC:

- `npm test`: 72 unit tests, 1 built-CLI test, and 5 MCP tests passed;
  TypeScript typecheck and all three bundles succeeded.
- `npm run verify:app-server-schema`: `APP_SERVER_SCHEMA_COMPATIBLE`,
  Codex CLI `0.145.0`, 15 files and 61 protocol tokens checked.
- `npm run verify:codex-models`: `gpt-5.6-sol`,
  `gpt-5.6-terra`, and `gpt-5.6-luna` with `xhigh` verified.
- Skill quick validation, plugin validation, marketplace JSON validation,
  `git diff --check`, and dependency audit with zero vulnerabilities passed.
- Global Git marketplace registration, plugin `0.1.1` installation, enabled
  status, detached cache contents, and all 19 installed MCP tools passed.
- No Docker or infrastructure action, development port, paid model call,
  deployment, remote merge, or test-fixture push/PR mutation was performed.
