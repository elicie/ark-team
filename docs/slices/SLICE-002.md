# Closed Contract — SLICE-002

- Spec identity: `ark-team` operating contract at Git revision
  `b23351819e75601fa49bb0f653e1863111aa3025` and the user-approved next-step
  roadmap.
- Slice approval: The user approved proceeding after SLICE-002 was identified
  as the next slice.
- Objective: Define project-scoped PM, PL, and worker custom agents with the
  approved model, reasoning, permission, delegation, and reporting contracts,
  then verify native two-level delegation or its approved PM-spawn fallback.
- Included requirements:
  - `REQ-201`: Define `ark_pm`, `ark_pl`, and `ark_worker` as project-scoped
    Codex custom agents.
  - `REQ-202`: Pin PM to Sol/xhigh/read-only, PL to Terra/xhigh, and worker to
    Luna/xhigh.
  - `REQ-203`: Encode PM → PL → worker delegation and worker → PL → PM
    reporting without allowing the PM to edit project files.
  - `REQ-204`: Teach the `ark-team` skill to select the named agents and handle
    native environments that cannot perform nested custom-agent spawning.
- Acceptance criteria:
  - `AC-201`: Each custom-agent TOML has the required identity fields and exact
    approved model and reasoning effort.
  - `AC-202`: PM is mechanically read-only and instructed never to request
    write escalation; PL and worker use guarded workspace-write permissions.
  - `AC-203`: PL is instructed to create only `ark_worker` children and
    consolidate their reports; worker is instructed not to delegate further.
  - `AC-204`: The skill requires named-role selection and forbids claims of
    model pinning when the runtime does not confirm the selected role.
  - `AC-205`: A fresh Codex process discovers all three project custom agents.
  - `AC-206`: A live capability probe demonstrates PL → worker nested
    delegation and hierarchical reporting. If the host cannot select a nested
    custom agent, the probe must identify that limitation and demonstrate the
    approved fallback in which PM spawns workers while preserving logical
    worker → PL → PM reporting.
  - `AC-207`: Existing runtime tests and official skill/plugin validators
    continue to pass.
- Verification cases:
  - `TEST-201`: Static custom-agent contract test.
  - `TEST-202`: Installed Codex model-catalog compatibility check.
  - `TEST-203`: Fresh-process custom-agent discovery check.
  - `TEST-204`: Live nested-delegation or PM-spawn-fallback probe.
  - `TEST-205`: Existing TypeScript, MCP, skill, and plugin regression checks.
- Required definitions and external contracts:
  - Codex project custom-agent files under `.codex/agents/`.
  - Custom-agent fields `name`, `description`, `developer_instructions`,
    `model`, `model_reasoning_effort`, `sandbox_mode`, and `approval_policy`.
  - Existing Ark Team operating and report contracts.
- Dependencies and preconditions:
  - Codex CLI with stable multi-agent support.
  - The authenticated local model catalog exposes `gpt-5.6-sol`,
    `gpt-5.6-terra`, and `gpt-5.6-luna` with `xhigh`.
  - A fresh Codex process can load project-scoped agent definitions.
- Explicit exclusions:
  - Persistent team and assignment scheduler.
  - Git worktree creation, integration, or cleanup.
  - Full four-team concurrency.
  - Retry and approval continuation engines.
  - External model providers.
  - Global marketplace installation.
- Reference boundary: Repository files at the baseline revision, the current
  Codex manual, installed CLI help, installed model catalog, and live local
  Codex capability probes.
- Unknowns that do not affect acceptance: The later scheduler's physical
  concurrency budget and final global installation mechanism.

# Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-24 UTC
- Method: `GIT`
- Revision or inventory identity:
  `b23351819e75601fa49bb0f653e1863111aa3025`
- Existing modified/untracked artifacts: none
- Existing validation failures: none
- Relevant commands confirmed: `node`, `npm`, `codex`, `jq`, Python skill
  validator, and Python plugin validator
- Environmental limits:
  - Codex CLI `0.145.0`
  - `multi_agent` is stable and enabled
  - User instructions prohibit Docker
  - No infrastructure or development server is required

# Evidence Matrix

| REQ | AC | TEST/check | Evidence | Result | Notes |
|---|---|---|---|---|---|
| REQ-201, REQ-202 | AC-201 | TEST-201 | `npm run test:unit` checks all three TOML role, model, effort, sandbox, approval, and instruction contracts | PASS | Python `tomllib` also parsed all three files |
| REQ-202 | AC-202 | TEST-203, TEST-204 | Live child turn contexts compared with custom-agent permissions | FAIL | Parent live overrides prevent simultaneous mechanically read-only PM and writable PL/worker native sessions |
| REQ-203 | AC-203 | TEST-201 | Static tests require PL-only `ark_worker` delegation and the worker no-delegation rule | PASS | |
| REQ-204 | AC-204 | TEST-201 | Static tests require all named roles, degraded-guarantee wording, and `WORKER_SPAWN_REQUEST` fallback | PASS | |
| REQ-202 | AC-201 | TEST-202 | `npm run verify:codex-models` reads the installed Codex catalog and verifies all three slugs advertise `xhigh` | PASS | |
| REQ-201 | AC-205 | TEST-203 | Fresh `codex exec` child session metadata records `agent_role` values `ark_pm`, `ark_pl`, and `ark_worker` | PASS | Turn contexts confirm Sol, Terra, and Luna respectively, all at `xhigh` |
| REQ-203, REQ-204 | AC-206 | TEST-204 | PL session made a real `spawn_agent` call with `agent_type:"ark_worker"` and received `WORKER_OK`; an independent live collaboration tree also contained `/root/ark_pl_probe/ark_worker_probe` | PASS | Native nested custom-agent spawning is supported; fallback was not needed |
| REQ-201–REQ-204 | AC-207 | TEST-205 | `npm test`, official skill/plugin validators, TOML parsing, and `npm audit` | PASS | 7 unit tests and 1 MCP smoke test passed; 0 vulnerabilities |

# Result Record

- Terminal status: `SPEC_DELTA_REQUIRED`
- Completed at: 2026-07-24 UTC
- Implementation:
  - Added project-scoped `ark_pm`, `ark_pl`, and `ark_worker` custom agents.
  - Pinned the approved Sol/Terra/Luna models and `xhigh` effort.
  - Declared a read-only, no-escalation PM and guarded writing PL/worker roles,
    then added an unsafe-permission refusal gate after live validation exposed
    the parent-override limitation.
  - Updated the skill to select named roles and preserve a PM-spawn fallback.
  - Added automated role-contract and installed-model-catalog checks.
- Live verification:
  - `ark_pm`: `agent_role=ark_pm`, `model=gpt-5.6-sol`,
    `effort=xhigh`, `sandbox=read-only`, `approval=never`, result `PM_OK`.
  - `ark_pl`: `agent_role=ark_pl`, `model=gpt-5.6-terra`,
    `effort=xhigh`.
  - `ark_worker`: `agent_role=ark_worker`, `model=gpt-5.6-luna`,
    `effort=xhigh`, result `WORKER_OK`.
  - The PL's persisted tool event selected `agent_type=ark_worker` with
    `fork_turns=none`; the child completion was delivered to the PL.
  - The direct collaboration probe independently exposed the completed tree
    `/root/ark_pl_probe/ark_worker_probe` and the consolidated `PL_OK` report.
- Verification:
  - `npm test`: passed.
  - `npm run verify:codex-models`: passed.
  - Official skill validator: passed.
  - Official plugin validator: passed.
  - Python TOML parse check: passed.
  - `npm audit --audit-level=moderate`: 0 vulnerabilities.
- Verification correction:
  - The first live probe returned a success-shaped final message even though
    its parent event stream showed no receiver thread. That message was
    rejected as insufficient evidence.
  - The validated role and delegation results use persisted child-session
    metadata, the PL's actual `spawn_agent` event, the worker completion event,
    and an independently surfaced collaboration tree.
- Independent review:
  - Confirmed that native children inherit the parent's live sandbox and
    approval overrides.
  - Confirmed that the original evidence record did not include durable probe
    commands or session identifiers. The local session evidence used here is:
    - PM: `019f95ef-c790-7e82-8fd5-7f9f3d53f71d`
    - PL: `019f95ed-6d37-7ef3-ae29-aa656c7fbfc2`
    - worker: `019f95ed-87ec-79c1-963e-805b265f0401`
- Residual boundaries:
  - The live probe forced the parent to read-only/never, and Codex correctly
    reapplied that stricter live override to PL and worker. Their normal
    workspace-write/on-request defaults are statically validated but were not
    exercised by this read-only probe.
  - Custom agents are project-scoped in this slice. Global marketplace
    installation remains excluded.
  - Team persistence, scheduling, worktrees, integration, retries, and approval
    continuation remain later slices.

# SPEC_DELTA

- Spec identity: `ark-team` operating contract at baseline revision
  `b23351819e75601fa49bb0f653e1863111aa3025`.
- Slice: `SLICE-002`
- Raised at: 2026-07-24 UTC
- Classification: `ENVIRONMENT_MISMATCH`
- Affected IDs: `REQ-202`, `AC-202`
- Observed evidence:
  - A fresh read-only parent spawned `ark_pl` and `ark_worker`; both child turn
    contexts were forced to `sandbox=read-only` and `approval=never` despite
    their TOML `workspace-write` and `on-request` settings.
  - Current Codex behavior reapplies parent live sandbox and approval choices
    to spawned children.
  - The inverse case means a writable parent can override the PM's configured
    read-only layer.
- Current contract: PM must be mechanically read-only and must never directly
  mutate project files, while PL and worker roles require guarded write access.
- Why implementation cannot safely continue: One native parent/child hierarchy
  cannot simultaneously enforce those two permission boundaries. Instructions
  can make an agent refuse work but are not a mechanical isolation boundary.
- Minimal decision needed: Choose whether Ark Team must launch roles as
  separately permissioned Codex sessions, or whether native fallback may weaken
  the PM isolation guarantee.
- Candidate options and observable tradeoffs:
  - Build the managed session launcher next: preserves the absolute PM
    read-only guarantee and writable PL/worker roles, but expands the next slice
    into process/session scheduling.
  - Accept native best-effort permissions: keeps implementation smaller, but
    violates the previously stated absolute PM restriction.
- Work preserved: All custom-agent definitions, skill routing, static tests,
  model-catalog verification, and live nested-spawn evidence remain uncommitted
  in the worktree.
- Tests blocked: A live writing hierarchy with a mechanically read-only PM and
  writable PL/worker children.
- Recommended owner: User/product owner.
