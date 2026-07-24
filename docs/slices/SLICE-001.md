# Closed Contract — SLICE-001

- Spec identity: `ark-team` operating contract at Git revision `73686591395f8f5a143eaec1152e6ce01fb8ee69`, approved interview decisions, and the user-approved TypeScript implementation order.
- Slice approval: The user approved implementation after the proposed order placed the MCP server and state persistence first.
- Objective: Deliver a local stdio MCP control plane that persists Ark Team run state and exposes safe lifecycle and log tools.
- Included requirements:
  - `REQ-001`: Expose `start`, `list`, `status`, `logs`, `pause`, `resume`, and `cancel` MCP tools.
  - `REQ-002`: Persist run records and observable lifecycle events under a configurable state root using portable run identifiers and atomic record replacement.
  - `REQ-003`: Register the built MCP server in the `ark-team` plugin through `.mcp.json`.
  - `REQ-004`: Provide reproducible typecheck, build, test, and plugin-validation commands.
- Acceptance criteria:
  - `AC-001`: Starting a run with an absolute project path creates a valid portable run ID, a persisted run record, and a `run.created` event.
  - `AC-002`: Listing and status lookup return persisted data after a new store instance opens the same state root.
  - `AC-003`: Pause, resume, and cancel enforce the approved state transitions; invalid transitions fail without modifying the record.
  - `AC-004`: Logs return ordered observable events without private reasoning fields.
  - `AC-005`: The MCP server exposes the included tools over stdio and the plugin manifest references a valid `.mcp.json`.
  - `AC-006`: Typecheck, unit tests, bundle build, skill validation, and plugin validation pass.
- Verification cases:
  - `TEST-001`: Start and reopen persistence test.
  - `TEST-002`: Lifecycle happy-path test.
  - `TEST-003`: Invalid transition and no-corruption test.
  - `TEST-004`: Event ordering and pagination-boundary test.
  - `TEST-005`: Input validation and path-safety test.
  - `TEST-006`: MCP protocol smoke test.
  - `TEST-007`: Build and official validators.
- Required definitions and external contracts:
  - MCP stdio transport from `@modelcontextprotocol/sdk`.
  - Plugin companion manifest shape `{ "mcpServers": { ... } }`.
  - State names and cancellation semantics from the Ark Team operating contract.
- Dependencies and preconditions:
  - Node.js 18 or later.
  - A writable state root supplied through `ARK_TEAM_STATE_ROOT` or resolved from the platform home directory.
  - The existing plugin and skill remain valid.
- Explicit exclusions:
  - Codex SDK session creation.
  - PM, PL, and worker scheduling.
  - Git worktree or shadow-repository execution.
  - Approval continuation.
  - External model providers.
  - Always-on daemon and web dashboard.
- Reference boundary: Repository files at the baseline revision, current official Codex/plugin documentation, MCP SDK package metadata and installed type definitions.
- Unknowns that do not affect acceptance: A later SQLite migration, scheduler concurrency policy, and future agent-session identifiers.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision or inventory identity: `73686591395f8f5a143eaec1152e6ce01fb8ee69`
- Existing modified/untracked artifacts: none
- Existing validation failures: none; skill and plugin validators passed before this slice
- Relevant commands confirmed: `node`, `npm`, `codex`, Python skill validator, Python plugin validator
- Environmental limits:
  - Node `22.22.1`
  - npm `9.2.0`
  - Codex CLI `0.145.0`
  - Do not invoke Docker
  - No development server or network port is required for stdio MCP

# Evidence Matrix

| REQ | AC | TEST/check | Evidence | Result | Notes |
|---|---|---|---|---|---|
| REQ-001 | AC-001 | TEST-001 | `npm run test:unit` creates a planning run and checks its ID and first event count | PASS | |
| REQ-001 | AC-002 | TEST-001 | A new `RunStore` reopens the same record and lists it | PASS | |
| REQ-001 | AC-003 | TEST-002, TEST-003 | Lifecycle happy path passes; invalid resume leaves `run.json` byte-for-byte unchanged | PASS | |
| REQ-002 | AC-004 | TEST-004 | Two ordered log pages use a stable sequence cursor and expose no `private_reasoning` field | PASS | |
| REQ-002 | AC-001 | TEST-005 | Relative project paths and traversal-shaped run IDs are rejected | PASS | |
| REQ-003 | AC-005 | TEST-006, plugin validator | Smoke test launches the server from `.mcp.json`; official plugin validation passes | PASS | |
| REQ-004 | AC-006 | TEST-007 | `npm test`, skill validator, plugin validator, JSON/TOML parsing, and `npm audit` pass | PASS | |

# Completion Record

- Terminal status: `SLICE_ACCEPTED`
- Completed at: 2026-07-24 UTC
- Implementation:
  - Added a strict TypeScript run domain and portable run identifiers.
  - Added atomic JSON persistence with lifecycle transitions and observable event pagination.
  - Added seven stdio MCP lifecycle/status tools.
  - Bundled the server and registered it in the plugin through `.mcp.json`.
  - Added unit and protocol-level smoke tests.
- Verification:
  - `npm test`: 5 unit tests and 1 MCP smoke test passed; typecheck and bundle build passed.
  - `python3 /home/elicie/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/ark-team/skills/ark-team`: passed.
  - `python3 /home/elicie/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/ark-team`: passed.
  - JSON/TOML parse check: passed.
  - `npm audit --json`: 0 vulnerabilities.
- Dependency note:
  - The runtime pins `@modelcontextprotocol/sdk` 1.29.0.
  - `@hono/node-server` is overridden to 2.0.11 to avoid the vulnerable 1.x
    transitive dependency. The accepted stdio path is covered by the MCP smoke
    test; HTTP transports remain outside this slice and must re-evaluate this
    override before use.
- Residual boundaries:
  - Mutations are serialized within one MCP process. Cross-process record
    locking is not provided in this slice.
  - Agent-session scheduling, model pinning, worktrees, approvals, remote
    providers, daemonization, and dashboard work remain explicitly excluded.
