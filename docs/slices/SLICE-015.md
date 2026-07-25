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

To be completed after final installation and verification.
