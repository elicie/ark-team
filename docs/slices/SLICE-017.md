# Closed Contract — SLICE-017 — verification-spec-v3

- Package identity: `verification-spec-v3`.
- Package status: `SPEC_APPROVED`.
- Authority date: 2026-07-27 UTC.
- Supersedes: `verification-spec-v2`.
- Authority: the user-approved assignment, the authority/evidence review, the
  inspected repository source and configuration conventions, the role and
  approval contracts, the user-requested Backend/UI QA separation, and the
  adjacent Closed Contract slice documents.
- Reference boundary: `NONE`. Official third-party documentation is recorded
  only as capability and constraint evidence; it is not authority for Ark Team
  product behavior and does not authorize installation or remote execution.
- Deliverable: this documentation file only. It defines a future local
  verification coordinator and does not implement or execute that coordinator.

## Authority and evidence boundary

The following inventory records what informed this contract. It distinguishes
normative authority from observations and from checks that have not been run.

| Evidence ID | Class | Observed or supplied item | Use | Boundary |
| --- | --- | --- | --- | --- |
| `EVID-1701` | `USER_REQUIREMENT` | Assignment scope, acceptance criteria, dependency, and handoff obligations | Normative authority for this slice | Does not prove implementation or runtime behavior |
| `EVID-1702` | `DOCUMENT_CONVENTION` | Adjacent Closed Contract slices, especially the objective/requirement/acceptance/test/slice convention | Defines document structure and traceability form | Convention is not product evidence |
| `EVID-1703` | `SOURCE_OBSERVATION` | Controller/integration flow places coordinator verification after integration and before the original Sol/xhigh read-only PM final review | Fixes the PM gate and coordinator boundary | No live controller run was performed |
| `EVID-1704` | `SOURCE_OBSERVATION` | Existing TOML configuration and persisted run-record mechanisms are the extension points for resolved verification configuration and snapshots | Fixes the first-slice integration boundary | The required extension is not implemented by this document |
| `EVID-1705` | `CONSTRAINT` | Role hierarchy, literal-argv execution, approval routing, local-only scope, and artifact-safety constraints | Fixes safety, ownership, and reporting controls | No dangerous, remote, or product action is authorized here |
| `EVID-1706` | `PARTIAL_PROTOCOL_OBSERVATION` | The app-server/local-image protocol is usable only when an active-turn runtime signal advertises `localImage`; model or package presence is not sufficient | Defines semantic-review capability detection | No active runtime signal was observed |
| `EVID-1707` | `NOT_EXECUTED` | Browser, API, server, screenshot, image review, comparison, build, product tests, and bootstrap behavior | Makes the future verification boundary explicit | Every `TEST-17xx` below remains `NOT_RUN` |
| `EVID-1708` | `USER_REQUIREMENT` | Backend QA and UI QA must be independently selectable rather than one mandatory full-stack pipeline | Normative authority for lane separation and aggregate gating | Does not select a third-party adapter |
| `EVID-1709` | `REFERENCE_OBSERVATION` | Browser Use official repository and documentation describe QA automation, bounded agent execution, structured output/history, domain restrictions, and local or cloud browser modes | Supports an allowlisted agentic-browser adapter contract | Observed 2026-07-27 at release `0.13.6` (`950eb03617e67548d759c02beac1ad122c6b6458`, MIT); cloud, tunnels, real profiles, and vendor claims are not inherited |
| `EVID-1710` | `REFERENCE_OBSERVATION` | Playwright official documentation distinguishes executable tests/assertions from planner, generator, healer, CLI, and MCP agent workflows and exposes traces, screenshots, accessibility snapshots, and origin controls | Supports deterministic UI assertions plus a separate agentic exploration phase | Observed 2026-07-27 at release `v1.62.0` (`e3950d9c140d007bd52853b45813c6274b24e36f`, Apache-2.0); no dependency is assumed installed |
| `EVID-1711` | `REFERENCE_OBSERVATION` | Stagehand official documentation separates `observe`/`act`/agent primitives from measurable evaluations and supports local or Browserbase environments | Corroborates plan-then-execute, structured validation, and repeated-evaluation constraints | Observed 2026-07-27 at server release `v3.7.4` (`6ff9490945e4ed762fa9ebca9dab6f46fa34bc4a`, MIT); cloud behavior is excluded |
| `EVID-1712` | `SPEC_DELTA` | `verification-spec-v2` (`SLICE-017.md` SHA-256 `277fb413390f83f49fdf34fab4a42e3eca83d3f499fe5442e884f165a0128399`) fixed `retention_days = 30` but did not define the retention anchor or earliest cleanup time | Closes the retention ambiguity in `REQ-1706` and `TEST-1706` without claiming implementation | The v3 decision uses the terminal-report timestamp as the retention anchor |
| `EVID-1713` | `SPEC_DELTA` | IS-1701 review showed that a record could carry unverified check requiredness and that the configuration example omitted already-required exact adapter/browser versions | Makes check linkage explicit in `REQ-1704` and repairs the configuration example without changing approved behavior | Schema-2 records use a check ID where applicable and reject requiredness that differs from the immutable snapshot |

Repository evidence was captured from clean Git commit
`150d81a4ebe97ce0aeb2046f8f1461a73fa91742`
(`SOURCE_ID: GIT-COMMIT:150d81a4ebe97ce0aeb2046f8f1461a73fa91742`).
Mutable official-document URLs were retrieved on 2026-07-27 UTC:
`https://github.com/browser-use/browser-use`,
`https://github.com/browser-use/browser-use/blob/0.13.6/skills/qa/SKILL.md`,
`https://docs.browser-use.com/open-source/customize/agent/output-format`,
`https://docs.browser-use.com/open-source/examples/templates/sensitive-data`,
`https://playwright.dev/docs/test-agents`,
`https://playwright.dev/docs/test-assertions`,
`https://playwright.dev/mcp/introduction`,
`https://docs.stagehand.dev/v3/basics/observe`, and
`https://docs.stagehand.dev/v3/basics/evals`.

Reference-derived capabilities are classified as follows:

| Reference capability | Disposition | Contract decision |
| --- | --- | --- |
| Playwright Test actions, web-first assertions, isolation, traces, and visual/accessibility snapshots | `KEEP` | Default evidence model for deterministic UI pass/fail; exact installed adapter and version remain capability-gated |
| Playwright planner/generator/healer, CLI, and MCP | `ADAPT` | May explore or propose tests; generated or healed files require separate review and cannot change a gate run |
| Browser Use local agent/CLI QA | `ADAPT` | Candidate bounded `agentic_browser` adapter for advisory exploration with domain/tool limits and structured evidence |
| Browser Use Cloud, tunnels, proxies, real profiles, and separate hosted model calls | `DEFER` | Remote and credential-bearing behavior is outside this local contract and remains approval-gated |
| Stagehand local `observe`/`act`/agent | `DEFER` | Candidate future adapter; no dependency or compatibility is claimed until capability and project-specific evaluation exist |

Exploration coverage for this revision is:

| Surface | Status | Evidence channel | Capabilities | Gaps |
| --- | --- | --- | --- | --- |
| Repository configuration, state records, and current verification schemas/tests | `EXPLORED` | `SOURCE` | contract-v1/schema-1 compatibility and schema-2 extension points | No schema-2 lane implementation exists |
| `verification-spec-v2` requirements, acceptance, tests, and slice order | `EXPLORED` | `DOCUMENT` | lane/retention delta impact | Existing documentation tests remain future work |
| Browser Use release, QA skill, output, browser, and sensitive-data contracts | `PARTIAL` | `DOCUMENT`, `SOURCE` | agentic QA, evidence, domain/tool controls | No local install, model call, or target run |
| Playwright Test, Test Agents, CLI/MCP, assertions, traces, and snapshots | `PARTIAL` | `DOCUMENT`, `SOURCE` | deterministic gate and agentic authoring | Installed version and target compatibility unknown |
| Stagehand local/remote browser, observe/act, and eval contracts | `PARTIAL` | `DOCUMENT`, `SOURCE` | alternative agentic adapter | No local install or target evaluation |
| Target routes, selectors, accounts, baselines, and live adapter capabilities | `NOT_AVAILABLE` | `UNVERIFIED` | project-specific Backend/UI scenarios | Must be supplied by an approved project config/runtime discovery |
| Third-party cloud, tunnel, proxy, real-profile, and remote-model execution | `OUT_OF_SCOPE` | `UNVERIFIED` | none in this local contract | Requires a separate approved remote/privacy contract |

The directly observed facts are the documented interfaces above. The product
decisions are independent QA lanes, deterministic assertions as pass
authority, advisory-only agentic exploration in contract v2, and fail-closed
local security. Installed adapter availability, target routes, selectors,
accounts, and project-specific agent repeatability remain `UNKNOWN` until
runtime capability discovery or an approved project scenario supplies them.

No route, selector, action, baseline, browser installation, image capability,
secret, remote authority, model correctness, or visual result is inferred from
these findings.
Unknown acceptance-relevant facts are handled by the structured
`SPEC_DELTA_REQUIRED` result defined below.

### Revision decisions and open questions

| Decision ID | Status | Decision |
| --- | --- | --- |
| `DEC-1701` | `APPROVED` | Backend and UI are independently selectable QA lanes with separate summaries and one aggregate outcome. |
| `DEC-1702` | `APPROVED` | Declared deterministic UI assertions are the only UI pass authority. |
| `DEC-1703` | `APPROVED` | Browser Use-, Playwright agent-, or Stagehand-like exploration is local, bounded, advisory, and cannot modify a gate run. |
| `DEC-1704` | `APPROVED` | Retention starts at the persisted terminal-report timestamp and expires after exactly `30 * 24 hours`. |

The exact installed adapters, project routes, selectors, accounts, baselines,
and repeatability thresholds are non-blocking package questions. They must be
supplied by strict project configuration and runtime capability discovery
before the dependent lane runs; absence fails closed rather than being
inferred here.

## Scope, actors, vocabulary, and status

### Scope and actors

This slice specifies one coordinator for bounded local QA verification. It
covers dynamic source/config capture, strict configuration, immutable run
records, independently selectable Backend and UI QA lanes, capability
discovery, local-server readiness, literal-argv API checks, deterministic UI
assertions, bounded agentic UI exploration, exact screenshot capture, semantic
image review, immutable baseline comparison, artifact retention, PM gating,
rollback, and reproducible bootstrap scenarios.

Actors are the coordinator, implementation PL, integration PL, original PM,
operator/approving user, local server, API adapter, browser adapter, screenshot
adapter, semantic-review adapter, comparison adapter, reviewer, and artifact
store. Only the coordinator advances verification state. Adapters return typed
records and cannot mutate snapshots, baselines, outcomes, or registered paths.

The coordinator runs after an integrated result exists and before the original
Sol/xhigh read-only PM final review. It is not a team and does not alter the
Sol/Terra/Luna hierarchy, sandbox rules, or approval rules.

### Closed vocabulary

- **Implementation baseline**: a dynamic, immutable capture of the selected
  source worktree and approved package immediately before implementation or a
  later verification stage begins.
- **Package fingerprint**: the SHA-256 of the canonical approved
  `SLICE-017.md` bytes together with its package identity and authority date.
- **Contract version**: the executable coordinator contract ID. This package
  defines `verification_contract_v2`; it is distinct from package identity
  `verification-spec-v3` and record `schema_version: 2`.
- **Run snapshot**: the immutable, resolved configuration and environment
  record created before the first server, API, or browser action.
- **Artifact root**: the registered absolute per-run directory
  `<ARK_TEAM_STATE_ROOT>/<run_id>/verification`; all per-run outputs stay
  beneath it.
- **Approved baseline**: an immutable, content-addressed visual artifact and
  manifest approved by one explicit user decision for its exact identity and
  environment tuple.
- **QA lane**: one independently enabled and required-or-optional verification
  branch named `backend` or `ui`; disabled lanes create no checks and require no
  lane-specific capability or configuration.
- **Deterministic UI check**: a declared action and assertion sequence whose
  pass/fail result is computed without an LLM deciding whether the assertion
  succeeded.
- **Agentic UI exploration**: a bounded, model-directed browser task using an
  allowlisted local adapter; it may discover or execute a path but cannot
  establish `passed` without declared deterministic postconditions.
- **Required check**: a check whose `required` field is `true` in the immutable
  run snapshot. Its aggregate effective requiredness is
  `lane.required && check.required`; a required lane has at least one required
  check. A check cannot be silently downgraded within its lane.
- **Lane outcome**: one of `passed`, `failed`, `unavailable`, `skipped`, or
  `error`, computed for an enabled lane from that lane's required checks.
  Disabled lanes have no outcome.
- **Capability**: an independently detected ability named `server`, `api`,
  `browser`, `agentic_browser`, `screenshot`, `semantic_review`, or
  `comparison`.
- **Passed**: at least one lane is enabled and required; each required lane has
  at least one required check; every required lane's required checks and
  deterministic assertions passed; and every effectively required evidence
  item exists. Optional lane/check outcomes remain visible but do not block
  aggregate pass unless they expose a source-integrity or security failure.
  Missing required capability or artifact, source drift, unresolved approval,
  skipped required work, unrun required work, or agentic self-certification is
  not passed.

The only verification terminal outcomes are `passed`, `failed`,
`unavailable`, `skipped`, and `error`. `SPEC_DELTA_REQUIRED` is a structured
package/contract disposition and is never a passed outcome.
Post-terminal cleanup emits exactly one append-only operational disposition in
`retention_active`, `cleaned`, or `cleanup_error`, not a second verification
terminal outcome. `cleanup_error` carries a closed error code and bounded
diagnostic without changing the run.

The coordinator lifecycle is closed:

```text
integrated → configured → snapshotted → capabilities → ready → executing
→ collecting → deciding
deciding → passed | failed | unavailable | skipped | error
passed with every effectively required check → pm_review_pending → original_pm_review
```

Invalid, repeated, or out-of-order transitions leave the prior state unchanged
and produce `error` with a bounded diagnostic. Closed error codes are
`SOURCE_DRIFT`, `PACKAGE_FINGERPRINT_MISMATCH`,
`CONTRACT_VERSION_MISMATCH`, `CONFIG_INVALID`,
`SCENARIO_SNAPSHOT_MISMATCH`, `ARTIFACT_ROOT_INVALID`,
`BASELINE_NOT_APPROVED`, `CAPABILITY_UNAVAILABLE`, `SERVER_NOT_READY`,
`API_CONTRACT_MISMATCH`, `BROWSER_CONTRACT_MISMATCH`,
`SCREENSHOT_CAPTURE_FAILED`, `IMAGE_REVIEW_REJECTED`,
`COMPARISON_THRESHOLD_FAILED`, `APPROVAL_REQUIRED`, `TIMEOUT`,
`ENVIRONMENT_UNAVAILABLE`, and `INVALID_RECORD`.

Every error stores its code, stage, case ID, snapshot ID, UTC time, and bounded
sanitized message. It stores no credential, cookie, secret header, private
reasoning, or unrestricted command/response output.

### Documentation-only boundary

This package does not change product/runtime behavior, routes, fixtures,
browser pages, server configuration, image assets, baselines, generators, CI,
deployments, infrastructure, Docker configuration, databases, permissions,
credentials, remote repositories, or external integrations. It does not start
a server, call an API, drive a browser, capture an image, invoke image review
or comparison, run product tests/builds, install a browser/dependency, or claim
that any future verification passed.

## Normative requirements

### OBJ-1701 — Authority and dynamic source capture

#### REQ-1701 — Dynamic implementation-baseline capture

- Level: `MUST`
- Source: `SDD_PACKAGE` and `SOURCE_OBSERVATION`
- Actors: implementation PL, coordinator, and operator
- Preconditions: an approved package and a selected local Git worktree exist.
- Trigger: implementation of `IS-1701` or any later verification stage is
  about to begin.
- Observable result: the system captures one immutable baseline before any
  dependent action with package ID/fingerprint, authority date, worktree root,
  ref or detached-state label, full commit, full tree fingerprint, porcelain
  status, clean-state classification, capture method, and UTC timestamp. The
  baseline is dynamically read from the selected worktree; an implementation
  baseline eligible for a stage is `GIT_CLEAN`, while `GIT_DIRTY` is captured
  and blocks that stage. This contract does not hard-code a commit, tree,
  branch, or absolute target path.
- Acceptance: `AC-1701`
- Verification: `TEST-1701`
- Implementation slice: `IS-1701`

#### REQ-1702 — Strict source drift and reference-boundary enforcement

- Level: `MUST`
- Source: `SAFETY_POLICY`
- Actors: coordinator and operator
- Preconditions: an implementation baseline and package fingerprint exist.
- Trigger: any commit, tree, ref label, clean-state assertion, package
  fingerprint, resolved scenario, or baseline identity differs from the
  captured values, or a non-`NONE` reference is requested.
- Observable result: dependent work stops before execution with
  `SOURCE_DRIFT` or `PACKAGE_FINGERPRINT_MISMATCH`; stale snapshots and
  baselines are not used, and no external reference is consulted.
- Acceptance: `AC-1702`
- Verification: `TEST-1702`
- Implementation slice: `IS-1701`

### OBJ-1702 — Records, lifecycle, and ownership

#### REQ-1703 — Closed lifecycle and terminal outcomes

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: coordinator and all verification adapters
- Preconditions: a valid run snapshot exists.
- Trigger: a stage transition or terminal result is submitted.
- Observable result: only the lifecycle transitions and five terminal outcomes
  listed above are accepted; invalid or replayed events preserve state and
  produce a linked `error` record.
- Acceptance: `AC-1703`
- Verification: `TEST-1703`
- Implementation slice: `IS-1703`

#### REQ-1704 — Versioned, linked, and append-only evidence records

- Level: `MUST`
- Source: `CONSTRAINT`
- Actors: coordinator and artifact store
- Preconditions: a snapshot, case, or artifact record is being persisted.
- Trigger: a record is created or an adapter returns evidence.
- Observable result: every new schema-2 record has `schema_version: 2`,
  non-empty run and case IDs, check ID where applicable, lane where applicable,
  stage, UTC timestamp,
  source/package fingerprint, lane/check requiredness, adapter/model/version
  where applicable, and explicit artifact/hash links. Existing schema-1
  records remain readable under their original contract and are never mixed
  into a schema-2 hash chain. Unknown required states and missing
  acceptance-relevant fields are rejected; evidence records are append-only.
- Acceptance: `AC-1704`
- Verification: `TEST-1704`
- Implementation slice: `IS-1701`

### OBJ-1703 — Strict configuration and immutable run snapshot

#### REQ-1705 — Strict resolved configuration and pre-action snapshot

- Level: `MUST`
- Source: `SOURCE_OBSERVATION` and `INTERFACE_CONTRACT`
- Actors: coordinator, implementation PL, and artifact store
- Preconditions: the existing project configuration mechanism is available.
- Trigger: a verification run is requested.
- Observable result: the coordinator validates and resolves the complete
  `[verification.coordinator]` object, persists its byte-stable canonical form
  and SHA-256 together with the dynamic implementation baseline, then creates
  one immutable run snapshot before a server, API, or browser action. Unknown
  fields, implicit acceptance-relevant defaults, blank values, duplicate IDs,
  unsupported adapters, out-of-range values, secret-bearing values, and
  missing required values produce `CONFIG_INVALID`.

  A top-level disabled object contains exactly `schema_version: 2`,
  `contract_id = "verification_contract_v2"`, and `enabled = false`; it starts
  no run and accepts no server or lane fields. A top-level enabled object also
  contains literal server argv/lifecycle/readiness and discriminated `backend`
  and `ui` lane objects. At least one lane is enabled and required, and every
  required lane contains at least one required check.
  An enabled backend lane contains requiredness, capabilities, API adapter and
  probes. An enabled UI lane contains requiredness, capabilities,
  deterministic browser cases/assertions, optional bounded agentic tasks,
  exact viewports, visual-review/comparison policy, and baseline identity.
  A disabled lane contains only `enabled = false`; its lane-specific fields are
  rejected rather than ignored.

  Common configuration contains evidence limits, timeouts, retry policy,
  retention, and approval policy. The snapshot contains package/source
  identity, run/case IDs, scenario version, resolved config hash, artifact
  root, optional UI baseline root, origin and selected port, both lane
  contracts, adapter/model/browser identities, exact approved agentic
  prompt/checklist source bytes and their hashes, thresholds, and creation
  time. Later resume/reopen uses only this snapshot.
- Acceptance: `AC-1705`
- Verification: `TEST-1705`
- Implementation slice: `IS-1701`

#### REQ-1706 — Artifact-root and approved-baseline controls

- Level: `MUST`
- Source: `SECURITY_POLICY`
- Actors: coordinator, artifact store, reviewer, and operator
- Preconditions: a snapshot and registered artifact root are present; an
  enabled UI visual-comparison check also has a registered baseline root.
- Trigger: an artifact or baseline is created, read, reviewed, compared, or
  cleaned.
- Observable result: paths are absolute, canonical, component-boundary safe,
  beneath their registered root, and free of symlink traversal. Per-run
  artifacts are non-empty, type-checked, SHA-256 hashed, size-bounded, and
  linked to the snapshot. Approved baselines are separate, read-only,
  content-addressed, retain their approval manifest, and cannot be replaced or
  deleted by comparison or ordinary cleanup. Per-run artifacts remain
  ineligible for cleanup until exactly 30 periods of 24 hours after the
  terminal report's persisted UTC timestamp. Earlier cleanup appends a
  `retention_active` operational disposition without deleting bytes; eligible
  cleanup returns `cleaned` and affects only the registered run root after the
  report, manifest, hashes, and cleanup audit have been committed to durable
  coordinator state outside that root. A failed cleanup returns
  `cleanup_error`; no cleanup disposition changes the run's terminal outcome.
- Acceptance: `AC-1706`
- Verification: `TEST-1706`
- Implementation slice: `IS-1702`

### OBJ-1704 — Coordinator and deterministic failure handling

#### REQ-1707 — Sole coordinator state ownership

- Level: `MUST`
- Source: `DECISION`
- Actors: coordinator and all adapters/reviewers
- Preconditions: a valid snapshot and capability matrix exist.
- Trigger: an adapter or reviewer returns a result, artifact, or error.
- Observable result: only the coordinator mutates lifecycle state, snapshots,
  baselines, outcomes, and registered roots. Components return typed records
  with provenance and cannot write coordinator-owned state directly.
- Acceptance: `AC-1707`
- Verification: `TEST-1707`
- Implementation slice: `IS-1703`

#### REQ-1708 — Bounded retries and deterministic outcome reporting

- Level: `MUST`
- Source: `RELIABILITY_POLICY`
- Actors: coordinator and operator
- Preconditions: a case has a valid snapshot.
- Trigger: an action fails, times out, or returns an unexpected result.
- Observable result: API, deterministic browser, and readiness actions have two
  total attempts; each agentic exploration task, screenshot, artifact write,
  semantic review, comparison, and cleanup has one. Retry never changes the
  snapshot, lane requiredness, task/assertion bytes, adapter/model identity,
  baseline, or input. The coordinator persists the exact closed error code,
  bounded diagnostic, attempt count, evidence references, and exactly one
  terminal outcome per run. A post-terminal cleanup attempt instead appends
  one operational cleanup record and never changes that terminal outcome.
- Acceptance: `AC-1708`
- Verification: `TEST-1708`
- Implementation slice: `IS-1703`

### OBJ-1705 — Independent Backend and deterministic UI contracts

#### REQ-1709 — Literal local API verification

- Level: `MUST`
- Source: `INTERFACE_CONTRACT`
- Actors: API adapter and local server
- Preconditions: the backend lane is enabled, `server` and `api` capabilities
  are available, and the snapshot contains at least one API probe.
- Trigger: an API case begins.
- Observable result: the adapter uses literal argv and sends only the
  snapshot's method, relative path, exact query, allowlisted headers, and body
  digest. It rejects absolute/cross-origin URLs, `..` traversal, proxy use,
  credentials, undeclared headers, shell interpretation, and redirects outside
  the recorded origin. It records status, content type, bounded redacted
  metadata/body preview, digest, elapsed milliseconds, expected status, and
  exact contract identity.
- Acceptance: `AC-1709`
- Verification: `TEST-1709`
- Implementation slice: `IS-1705`

#### REQ-1710 — Reproducible deterministic UI verification

- Level: `MUST`
- Source: `INTERFACE_CONTRACT`
- Actors: browser adapter and local server
- Preconditions: the UI lane is enabled, `browser` is available, and browser
  version, context, URL, readiness condition, viewport, action list, and
  deterministic postconditions are snapshotted.
- Trigger: a browser case begins.
- Observable result: a fresh isolated Chromium context uses DPR `1`, locale
  `en-US`, timezone `UTC`, light color scheme, and
  `no-preference` reduced motion. It navigates only to the recorded local
  origin, waits for the declared bounded readiness condition, executes ordered
  declared actions, and evaluates declared role/name, text, URL, value,
  visibility, accessibility-snapshot, or response assertions with
  bounded auto-wait. It records navigation, console, page-error, dialog, trace,
  and assertion evidence. No LLM verdict, unbounded sleep, undeclared action,
  visual assertion, or automatic assertion/baseline update is accepted as a
  pass; screenshot, semantic-review, and pixel-comparison behavior belongs only
  to `IS-1706`.
- Acceptance: `AC-1710`
- Verification: `TEST-1710`
- Implementation slice: `IS-1705`

### OBJ-1706 — Screenshots, semantic review, and comparison

#### REQ-1711 — Exact screenshot artifacts

- Level: `MUST`
- Source: `VISUAL_CONTRACT`
- Actors: browser adapter, screenshot adapter, and artifact store
- Preconditions: the UI lane is enabled, and browser readiness and
  `screenshot` capability passed.
- Trigger: the declared browser action sequence is complete.
- Observable result: exactly one PNG is captured for each of `375x812`,
  `768x1024`, and `1440x900`, at DPR `1`, with no browser chrome, resize,
  crop, JPEG conversion, or unrecorded post-processing. Each record includes
  actual dimensions, viewport, byte size, SHA-256, URL/case, source/package
  fingerprint, browser/adapter version, UTC capture time, and artifact path.
- Acceptance: `AC-1711`
- Verification: `TEST-1711`
- Implementation slice: `IS-1706`

#### REQ-1712 — Capability-gated semantic image review

- Level: `MUST`
- Source: `VISUAL_CONTRACT` and `PARTIAL_PROTOCOL_OBSERVATION`
- Actors: semantic-review adapter, reviewer, and coordinator
- Preconditions: the UI lane is enabled, a valid screenshot exists, and
  `semantic_review` has an explicit active runtime capability signal and
  recorded version/identity.
- Trigger: a screenshot is submitted for review.
- Observable result: review returns only `approved`, `rejected`, or `blocked`,
  with input hash, identity/version, checklist version, UTC time, and bounded
  observations covering clipping, missing/extra UI, legibility, obvious layout
  shifts, and privacy leakage. For the local-image protocol, the only turn
  extension is `{ "type": "localImage", "path": "<absolute-path>" }`; the
  path is an existing regular non-symlink PNG beneath the current run's
  screenshot root. A turn accepts at most three such items and each item is at
  most 10 MiB. Findings are limited to 50 entries and 16 KiB. Missing runtime
  signal yields `unavailable` for a required review and `skipped` for an
  optional review; model/package presence alone never implies approval.
- Acceptance: `AC-1712`
- Verification: `TEST-1712`
- Implementation slice: `IS-1706`

#### REQ-1713 — Immutable baseline and deterministic comparison

- Level: `MUST`
- Source: `VISUAL_CONTRACT`
- Actors: comparison adapter, reviewer, and coordinator
- Preconditions: the UI lane is enabled, an approved baseline matches the
  scenario, source-compatible snapshot/environment tuple, viewport, browser
  context, and dimensions; the `comparison` capability is available.
- Trigger: a candidate screenshot is ready.
- Observable result: equal-dimension PNGs are decoded to RGBA8 without resize,
  crop, alpha normalization, or color-space conversion. The adapter computes
  row-major `pixel_diff_fraction` and `max_channel_delta`, writes a
  deterministic diff PNG whose changed pixels are opaque magenta and unchanged
  pixels are transparent, and persists all input/output hashes and metrics.
  Passing requires approved semantic review when that check is required, no
  declared critical-region difference, `pixel_diff_fraction <= 0.005`, and
  `max_channel_delta <= 8`. An optional semantic-review result remains visible
  but is not a comparison prerequisite. Missing/incompatible baseline approval
  produces `BASELINE_NOT_APPROVED`; comparison never creates or overwrites a
  baseline.
- Acceptance: `AC-1713`
- Verification: `TEST-1713`
- Implementation slice: `IS-1706`

### OBJ-1707 — Capability, server, security, privacy, and operations

#### REQ-1714 — Hard capability gates

- Level: `MUST`
- Source: `SAFETY_POLICY`
- Actors: coordinator and operator
- Preconditions: capabilities required by each enabled lane are declared in
  the immutable snapshot.
- Trigger: discovery completes or a required capability becomes unavailable.
- Observable result: each capability has an availability state, adapter/name,
  version where available, check time, and bounded diagnostic. An unavailable
  effectively required capability prevents only its dependent lane or check
  and yields `unavailable`; an optional lane/check dependency yields `skipped`.
  Capability effective requiredness is derived from the immutable lane/check
  matrix and cannot be strengthened or weakened during discovery. A disabled
  lane requires no lane-specific capability. No browser-to-API,
  agentic-to-deterministic, screenshot-to-text, semantic-review-to-pixel, or
  comparator-to-review substitution can satisfy a required check.
- Acceptance: `AC-1714`
- Verification: `TEST-1714`
- Implementation slice: `IS-1704`

#### REQ-1715 — Local development-server contract

- Level: `MUST`
- Source: `OPERATING_CONSTRAINT`
- Actors: coordinator and local server
- Preconditions: the scenario declares a local server and readiness check.
- Trigger: server startup or readiness probing begins.
- Observable result: the server uses literal argv, binds `0.0.0.0`, accepts
  hostname `dev`, and uses port `10001` or the next available integer at or
  above `10001`, recording the selected port in the snapshot. The origin is
  `http://dev:<recorded-port>`, readiness is an explicit HTTP/status condition
  within 30,000 ms, and port `3000`, Docker, remote services, infrastructure
  mutation, and unregistered processes are rejected. A Next.js target includes
  `dev` in `allowedDevOrigins`.
- Acceptance: `AC-1715`
- Verification: `TEST-1715`
- Implementation slice: `IS-1704`

#### REQ-1716 — Security, privacy, approval, and operations contract

- Level: `MUST`
- Source: `SECURITY_POLICY` and `OPERATING_CONSTRAINT`
- Actors: coordinator, operator, artifact store, and all adapters
- Preconditions: local verification is authorized.
- Trigger: any command, request, log, artifact, approval, retry, or cleanup.
- Observable result: network targets are limited to the recorded local origin;
  commands are literal argv in the registered worktree or artifact root;
  secrets, tokens, cookies, authorization/secret headers, personal data, raw
  model reasoning, and unrestricted command/console/network output are rejected
  or redacted. Agentic browser adapters use a fresh ephemeral profile, the
  exact local origin allowlist, an allowlisted minimal tool set, and no
  arbitrary code, shell, file, download, upload, extension, stored profile,
  proxy, tunnel, or cloud-browser capability.

  A separately hosted browser or model service is remote work and is not
  authorized by this local contract. Remote, destructive, credential,
  permission, deployment, infrastructure, Docker, automatic test healing,
  baseline update, and product file-change requests stop before effect and
  produce terminal `error` with `APPROVAL_REQUIRED` plus an opaque approval
  ID. They cannot resume the immutable local run; any later authorization
  requires a separately approved contract and a new snapshot. Reports include
  UTC timestamps, runtime/browser/API/agentic-adapter/model versions,
  capability matrix, timeout and retry counters, hashes, bounded action/result
  ledgers, redacted errors, and cleanup state; conversation transcripts and
  model thoughts are never persisted.
- Acceptance: `AC-1716`
- Verification: `TEST-1716`
- Implementation slice: `IS-1704`

### OBJ-1708 — Versioned rollout and safe rollback

#### REQ-1717 — Versioned guarded rollout

- Level: `MUST`
- Source: `OPERATIONS_POLICY`
- Actors: implementation PL, coordinator, integration PL, and operator
- Preconditions: the first vertical slice and its mapped checks are accepted.
- Trigger: the verification contract is enabled for a project.
- Observable result: enablement is explicitly versioned as
  `verification_contract_v2`; the package fingerprint, schema version, and
  source baseline are announced before execution. Existing
  `verification_contract_v1` records retain their snapshots and remain
  readable but cannot start or resume under contract v2 and are not
  reinterpreted.
  Stages enable in order: source/config/snapshot, artifacts/baselines,
  coordinator/lane aggregation, capability/server, Backend API,
  deterministic UI, visual checks, bounded agentic UI, then bootstrap.
- Acceptance: `AC-1717`
- Verification: `TEST-1717`
- Implementation slice: `IS-1707`

#### REQ-1718 — Non-destructive rollback and recovery

- Level: `MUST`
- Source: `OPERATIONS_POLICY`
- Actors: operator and coordinator
- Preconditions: a legacy schema-1 or current schema-2 run, snapshot, or
  artifact exists.
- Trigger: disablement, contract mismatch, source drift, capability loss, or
  recovery request.
- Observable result: new starts are disabled; snapshots, source baselines,
  config hashes, approved baselines, actuals, diff images, review records,
  manifests, and redacted logs remain readable and recoverable. A legacy
  `verification_contract_v1` run is read-only; attempting to resume it as
  contract v2 returns `error` with `CONTRACT_VERSION_MISMATCH`. A nonterminal
  `verification_contract_v2` run may continue only from its exact immutable
  schema-2 snapshot after source, package, config, capability, approval, and
  artifact links revalidate. Source/package drift returns `SOURCE_DRIFT` or
  `PACKAGE_FINGERPRINT_MISMATCH`; capability or environment loss returns
  `ENVIRONMENT_UNAVAILABLE`. A terminal run never resumes or gains another
  terminal outcome. No database migration, schema rewrite, broad cleanup,
  branch deletion, baseline deletion, or in-place baseline replacement occurs.
- Acceptance: `AC-1718`
- Verification: `TEST-1718`
- Implementation slice: `IS-1707`

### OBJ-1709 — Bootstrap, PM gate, and delta handoff

#### REQ-1719 — Reproducible bootstrap scenario

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: coordinator, local server, API adapter, browser adapter, screenshot
  adapter, semantic reviewer, comparison adapter, and artifact store
- Preconditions: source/package identity passed, the schema-2 run snapshot
  exists, the artifact root is registered, every effectively required visual
  comparison has an approved baseline, at least one QA lane is enabled and
  required, and all lane/check capability demands are snapshotted.
- Trigger: `BOOTSTRAP-1701` is requested.
- Observable result: the future implementation performs this exact order:
  (1) validate dynamic source/package identity; (2) validate and persist the
  resolved config; (3) create the immutable run snapshot; (4) discover and
  persist capabilities; (5) start/attach only to the registered local server;
  (6) when the backend lane is enabled, execute its declared API probes;
  (7) when the UI lane is enabled, create a fresh context and execute its
  deterministic cases/assertions; (8) execute enabled screenshot, semantic
  review, and baseline comparison checks; (9) execute each enabled agentic UI
  exploration in a separate fresh context without changing deterministic
  tests or baselines; (10) persist separate backend/UI lane summaries; and
  (11) aggregate them into exactly one terminal outcome and handoff report.
  A disabled lane has no synthetic `skipped` result. A failed precondition
  stops only safe independent work and produces the corresponding closed
  outcome.
- Acceptance: `AC-1719`
- Verification: `TEST-1719`
- Implementation slice: `IS-1707`

#### REQ-1720 — PM success gate and complete first-slice handoff

- Level: `MUST`
- Source: `SOURCE_OBSERVATION` and `SDD_PACKAGE`
- Actors: coordinator, implementation PL, integration PL, and original PM
- Preconditions: integration has produced its result and the coordinator has
  a terminal verification report.
- Trigger: the coordinator reports to the original PM.
- Observable result: only one report whose effectively required checks and
  required lanes all have `passed`, and which contains complete
  `REQ → AC → TEST → IS` evidence, source/package fingerprint, snapshot ID,
  enabled/required lane matrix, per-lane outcome, deterministic assertion
  evidence, artifact/baseline hashes, attempt counts, and redacted errors, can
  enter `pm_review_pending` and the original Sol/xhigh read-only PM final
  review. Any non-pass in a required lane or effectively required check,
  missing evidence, `APPROVAL_REQUIRED`, safety violation, or
  `SPEC_DELTA_REQUIRED` blocks PM success and remains a recorded non-pass.
  Optional agentic findings remain visible but cannot turn deterministic
  failure into pass. `IS-1701` is closed for v3 only when its requirements
  `REQ-1701`, `REQ-1702`, `REQ-1704`, and `REQ-1705`, their mapped acceptance
  criteria/tests, dynamic baseline, resolved config hash, immutable snapshot,
  and rollback record all have observable evidence; no later slice starts
  before that closure.
- Acceptance: `AC-1720`
- Verification: `TEST-1720`
- Implementation slice: `IS-1707`

#### REQ-1721 — Structured SPEC_DELTA_REQUIRED disposition

- Level: `MUST`
- Source: `SAFETY_POLICY`
- Actors: coordinator, implementation PL, integration PL, and PM
- Preconditions: a required route, selector, action, baseline, capability,
  dependency, configuration field, authority fact, or acceptance condition is
  missing, contradictory, unsafe, environment-incompatible, or unverifiable.
- Trigger: the issue is detected before or during a future implementation
  stage.
- Observable result: execution stops before the affected dependent behavior and
  emits one bounded record with exactly these fields: `status` set to
  `SPEC_DELTA_REQUIRED`; `runtime_status` set to `not_started`;
  `affected_ids` containing the relevant `OBJ`, `REQ`, `AC`, `TEST`, and `IS`
  identifiers; `classification` in `omission`, `contradiction`,
  `unsafe_input`, `environment_mismatch`, or `unverifiable`; `source_snapshot`
  identity; bounded observable `evidence`; `impact`; `proposed_resolution`;
  `blocking_stage`; and UTC creation time. The record contains no secret,
  private reasoning, or unrestricted output, and is not treated as an approval
  or pass.
- Acceptance: `AC-1721`
- Verification: `TEST-1721`
- Implementation slice: `IS-1707`

### OBJ-1710 — Independent QA lanes and bounded agentic UI exploration

#### REQ-1722 — Independent Backend and UI lane selection

- Level: `MUST`
- Source: `USER_REQUIREMENT` and `DECISION`
- Actors: coordinator, operator, Backend adapter, and UI adapters
- Preconditions: `REQ-1705` produced a valid immutable schema-2 snapshot with
  independent `backend` and `ui` lane declarations.
- Trigger: the coordinator schedules snapshotted work or aggregates an enabled
  lane result.
- Observable result: the coordinator instantiates checks and capabilities only
  for enabled lanes. A backend-only run creates no UI work or UI capability
  demand; a UI-only run creates no API work or API capability demand while
  still using the common registered local server/origin. A disabled lane has
  no synthetic `skipped` result.

  Each enabled lane persists one summary with its `required` value, checks,
  evidence links, and one lane outcome from the closed five-value outcome set.
  A check's aggregate effective requiredness is exactly
  `lane.required && check.required`. Source-integrity or security failure
  produces aggregate `error` regardless of lane requiredness. Otherwise only
  effectively required checks participate in aggregation: all pass produces
  `passed`; non-pass precedence is `error`, `unavailable`, `failed`, then
  `skipped`. Optional lane/check results remain visible but do not alter the
  aggregate outcome or replace required evidence.
- Acceptance: `AC-1722`
- Verification: `TEST-1722`
- Implementation slice: `IS-1703`

#### REQ-1723 — Deterministic UI authority and advisory agentic exploration

- Level: `MUST`
- Source: `USER_REQUIREMENT`, `REFERENCE_OBSERVATION`, and `SAFETY_POLICY`
- Actors: coordinator, deterministic browser adapter, agentic browser adapter,
  reviewer, and operator
- Preconditions: the UI lane is enabled and any agentic task is fully
  snapshotted.
- Trigger: an agentic UI exploration is requested.
- Observable result: an agentic task declares a non-empty task ID, start path,
  UTF-8 natural-language goal of at most 4 KiB, machine-checkable success
  criteria, exact local origin allowlist, allowlisted actions/tools, maximum
  steps, one total attempt, timeout, evidence limits, an approved UTF-8
  system-prompt template of at most 16 KiB, and a checklist of 1–50 non-empty
  items whose canonical UTF-8 form is at most 16 KiB. The snapshot pins those
  exact input bytes, adapter name, package/API major and exact version, browser
  build, model identity when a model is used, and hashes of the task, system
  prompt, checklist, and deterministic postconditions. A non-required
  `agentic_browser` capability demand is declared whenever tasks exist;
  unavailable capability yields `skipped` without invoking an adapter.

  The adapter runs in a fresh ephemeral local context and returns one schema-2
  result whose `execution_status` is `completed`, `blocked`, or `error` and
  whose `finding_status` is `finding`, `no_finding`, or `unknown`. The record
  includes `required = false`, all run/snapshot/lane/task IDs, pinned
  provenance and input hashes, bounded findings, sanitized URL/action/error
  ledger and its hash, artifact references/hashes, step count, UTC timing, and
  optional self/judge verdict in `achieved`, `not_achieved`, or `unknown`.
  Findings are limited to 50 entries and 16 KiB total.
  Self-evaluation, judge output, model completion, `no_finding`, or claimed
  task success is advisory and cannot by itself pass the UI lane. Declared
  postconditions are re-evaluated by the deterministic browser adapter.
  Agent-generated plans, locators, scripts, tests, healer patches, and
  baselines are candidate artifacts only and cannot be applied, promoted, or
  used to change the current run without a separate explicit approval.

  `verification_contract_v2` permits agentic tasks only with
  `required = false`; making them gate PM success requires a later approved
  contract with project-specific repeatability evidence. Browser Use,
  Playwright CLI/MCP, and Stagehand-like tools are candidate adapter families,
  not required dependencies. Cloud browsers, tunnels, proxies, persistent or
  real user profiles, and separate remote model calls stop before effect with
  `APPROVAL_REQUIRED` and are not executed by this local contract.
- Acceptance: `AC-1723`
- Verification: `TEST-1723`
- Implementation slice: `IS-1706`

## Closed traceability

Every requirement has exactly one acceptance criterion and one verification
case. Every first-slice requirement has one complete
`OBJ → REQ → AC → TEST → IS → SLICE-017` path.

| Objective | Requirement | Acceptance | Verification | Implementation slice | First vertical slice |
| --- | --- | --- | --- | --- | --- |
| `OBJ-1701` | `REQ-1701` | `AC-1701` | `TEST-1701` | `IS-1701` | yes |
| `OBJ-1701` | `REQ-1702` | `AC-1702` | `TEST-1702` | `IS-1701` | yes |
| `OBJ-1702` | `REQ-1703` | `AC-1703` | `TEST-1703` | `IS-1703` | no |
| `OBJ-1702` | `REQ-1704` | `AC-1704` | `TEST-1704` | `IS-1701` | yes |
| `OBJ-1703` | `REQ-1705` | `AC-1705` | `TEST-1705` | `IS-1701` | yes |
| `OBJ-1703` | `REQ-1706` | `AC-1706` | `TEST-1706` | `IS-1702` | no |
| `OBJ-1704` | `REQ-1707` | `AC-1707` | `TEST-1707` | `IS-1703` | no |
| `OBJ-1704` | `REQ-1708` | `AC-1708` | `TEST-1708` | `IS-1703` | no |
| `OBJ-1705` | `REQ-1709` | `AC-1709` | `TEST-1709` | `IS-1705` | no |
| `OBJ-1705` | `REQ-1710` | `AC-1710` | `TEST-1710` | `IS-1705` | no |
| `OBJ-1706` | `REQ-1711` | `AC-1711` | `TEST-1711` | `IS-1706` | no |
| `OBJ-1706` | `REQ-1712` | `AC-1712` | `TEST-1712` | `IS-1706` | no |
| `OBJ-1706` | `REQ-1713` | `AC-1713` | `TEST-1713` | `IS-1706` | no |
| `OBJ-1707` | `REQ-1714` | `AC-1714` | `TEST-1714` | `IS-1704` | no |
| `OBJ-1707` | `REQ-1715` | `AC-1715` | `TEST-1715` | `IS-1704` | no |
| `OBJ-1707` | `REQ-1716` | `AC-1716` | `TEST-1716` | `IS-1704` | no |
| `OBJ-1708` | `REQ-1717` | `AC-1717` | `TEST-1717` | `IS-1707` | no |
| `OBJ-1708` | `REQ-1718` | `AC-1718` | `TEST-1718` | `IS-1707` | no |
| `OBJ-1709` | `REQ-1719` | `AC-1719` | `TEST-1719` | `IS-1707` | no |
| `OBJ-1709` | `REQ-1720` | `AC-1720` | `TEST-1720` | `IS-1707` | no |
| `OBJ-1709` | `REQ-1721` | `AC-1721` | `TEST-1721` | `IS-1707` | no |
| `OBJ-1710` | `REQ-1722` | `AC-1722` | `TEST-1722` | `IS-1703` | no |
| `OBJ-1710` | `REQ-1723` | `AC-1723` | `TEST-1723` | `IS-1706` | no |

The normative path is:

```text
OBJ-17xx → REQ-17xx → AC-17xx → TEST-17xx → IS-170x → SLICE-017
```

### First vertical slice — IS-1701 v3 reopening and closure

`IS-1701 — Dynamic source baseline, strict configuration, record schemas, and
immutable run snapshot` is the first complete vertical slice. It includes
exactly `REQ-1701`, `REQ-1702`, `REQ-1704`, and `REQ-1705`, with
`AC-1701`/`TEST-1701`, `AC-1702`/`TEST-1702`, `AC-1704`/`TEST-1704`, and
`AC-1705`/`TEST-1705`.

Its implementation inputs are the selected worktree, approved package bytes,
the existing TOML loader, the existing persisted run-record mechanism, and a
registered state root. Its v3 outputs are a dynamic implementation-baseline
record, validated canonical schema-2 lane configuration plus hash,
schema-versioned record definitions, and an immutable pre-action run snapshot.
It does not
start a server, make an API request, launch a browser, capture a screenshot,
invoke agentic or semantic review, or compare images.

The implementation produced under `verification-spec-v2` and merged at
`391d13b78e6de5999c55649a1227c63c3b353510` remains readable compatibility
evidence for `verification_contract_v1` and schema 1, but its single combined
coordinator schema does not close v3. `IS-1701` is reopened only for package
identity, `schema_version: 2`, conditional Backend/UI lane configuration, and
snapshot/record linkage. It is closed again when all four mapped tests pass
with observable records and hashes, the schema-2 snapshot is reopened
byte-equivalently, and rollback disables new contract-v2 starts while
preserving schema-1 and schema-2 evidence. `IS-1702` cannot begin before this
closure. A missing prerequisite or contradiction emits
`SPEC_DELTA_REQUIRED` with `runtime_status: not_started`.

### Ordered implementation slices

1. `IS-1701`: reopen the dynamic source baseline/configuration slice for
   `verification_contract_v2`, conditional Backend/UI lanes, record schemas,
   and immutable run snapshot while preserving contract-v1/schema-1
   readability.
2. `IS-1702`: registered artifact roots, hashes, PNG metadata, immutable
   approved baselines, diff artifacts, retention, and safe cleanup records.
3. `IS-1703`: coordinator ownership, lifecycle, independent Backend/UI lane
   summaries and aggregation, typed adapter records, bounded timeout/retry
   handling, and one terminal outcome.
4. `IS-1704`: capability discovery, local server readiness, port/host rules,
   approvals, redaction, and local-only security gates.
5. `IS-1705`: independent Backend API probes and deterministic UI cases.
6. `IS-1706`: exact screenshots, semantic review, deterministic comparison,
   advisory bounded agentic UI exploration, and baseline-safe visual evidence.
7. `IS-1707`: versioned rollout, rollback, bootstrap, PM gate, and structured
   delta handoff.

Each later slice reports its mapped requirements, acceptance/tests, source and
package identity, artifact hashes, and rollback state. No slice adds behavior
outside this contract without an approved package change.

## Configuration contract

The future extension is under the existing project configuration mechanism at
`.codex/team-orchestrator.toml`:

```toml
[verification.coordinator]
schema_version = 2
enabled = true
contract_id = "verification_contract_v2"
server_argv = ["<literal-program>", "<literal-arg>"]
server_bind = "0.0.0.0"
server_host = "dev"
server_port_floor = 10001
server_readiness_path = "/"
server_readiness_status = 200
server_readiness_timeout_ms = 30000
evidence_limits = { console_events = 100, network_events = 100, metadata_bytes = 65536, api_preview_bytes = 65536, file_bytes = 52428800, total_bytes = 524288000, file_count = 500 }
console_bytes = 32768
network_bytes = 32768
retention_days = 30
retention_anchor = "terminal-report-created-at"
server_timeout_ms = 30000
api_timeout_ms = 30000
browser_timeout_ms = 60000
case_timeout_ms = 120000
attempts = { readiness = 2, api = 2, browser = 2, agentic_browser = 1, screenshot = 1, semantic_review = 1, comparison = 1, artifact_write = 1, cleanup = 1 }
approval_policy = "explicit-one-time-user-decision"

[verification.coordinator.backend]
enabled = true
required = true
required_capabilities = ["api", "server"]
api_adapter = "<allowlisted-literal-argv-adapter>"
api_adapter_version = "<exact-version>"
api_probes = [{ id = "<id>", method = "GET", path = "/", query = {}, headers = {}, expected_status = 200, expected_content_type = "<type>", body_digest = "<digest-or-none>", required = true }]

[verification.coordinator.ui]
enabled = true
required = true
required_capabilities = ["browser", "comparison", "screenshot", "semantic_review", "server"]
optional_capabilities = ["agentic_browser"]
deterministic_adapter = "<allowlisted-deterministic-browser-adapter>"
deterministic_adapter_version = "<exact-version>"
browser_build = "<exact-browser-build>"
browser_cases = [{ id = "<id>", path = "/", readiness = "<bounded-condition>", actions = [], assertions = [{ kind = "visible", role = "heading", name = "<accessible-name>" }], required = true }]
viewports = ["375x812", "768x1024", "1440x900"]
baseline_root = "<canonical-approved-root>"
baseline_identity = "<explicit-hash-and-environment-tuple>"
pixel_diff_fraction_max = 0.005
max_channel_delta = 8
critical_regions = []
semantic_review_required = true
agentic_tasks = [{ id = "<id>", required = false, adapter = "<allowlisted-local-agentic-adapter>", adapter_version = "<exact-version>", api_major = "<exact-major>", model_identity = "<exact-managed-or-local-model>", browser_build = "<exact-browser-build>", start_path = "/", goal = "<bounded-goal>", success_criteria = [{ kind = "visible", role = "heading", name = "<accessible-name>" }], allowed_actions = ["navigate", "snapshot", "click", "type", "screenshot"], max_steps = 20, timeout_ms = 120000, system_prompt_template = "<bounded-approved-template-bytes>", checklist = ["<bounded-check>"], prompt_sha256 = "<sha256>", checklist_sha256 = "<sha256>" }]
```

This example enables both lanes. A backend-only configuration replaces the
entire UI table with exactly `{ enabled = false }`; a UI-only configuration
does the inverse for the backend table. A top-level disabled object is exactly:

```toml
[verification.coordinator]
schema_version = 2
contract_id = "verification_contract_v2"
enabled = false
```

An enabled lane requires its complete shape, at least one enabled lane must be
required, and each required lane has at least one required check. Effective
requiredness is not serialized separately; it is always derived as
`lane.required && check.required`. `optional_capabilities` is exact and
derived: it contains `agentic_browser` iff agentic tasks exist, and contains
`semantic_review` instead of listing it as required when
`semantic_review_required = false`. An optional semantic result remains
visible but is not a comparison prerequisite. Both capability lists are
explicit, duplicate-free, disjoint, and lexically sorted. Disabled-lane or
top-level disabled residual fields, `required = true` on an agentic task,
`latest` or version ranges, implicit model fallback, remote execution,
cloud/tunnel/profile options, and undeclared tools are `CONFIG_INVALID`.

For schema-2 evidence, `check_id` resolves to the snapshotted Backend API
probe, deterministic UI browser case, or agentic UI task selected by the
record type and lane. A deterministic browser record's `case_sha256` is the
SHA-256 of the canonical JSON bytes of that exact snapshotted browser case.

The implementation validates literal argv (no shell), unique bounded IDs,
relative paths without `..`, allowlisted methods/headers/actions/assertions,
bounded action and agent-step lists, allowlisted API/deterministic/agentic
adapters, exact versions, exact viewport order, explicit
environment/baseline/model identity, bounded system-prompt/checklist bytes,
matching hashes, and every timeout/attempt/limit. It rejects unknown keys,
empty/implicit fields, secrets, unsupported adapters, duplicates, unbounded
arrays, and out-of-range values. The resolved canonical object, hash, exact
agentic input bytes, and dynamic source baseline are persisted before
dependent work. No globally installed adapter or browser is assumed.

## Artifact, baseline, and security contract

Per-run paths are exactly beneath
`<ARK_TEAM_STATE_ROOT>/<run_id>/verification`; screenshots and diffs use:

```text
screenshots/<case-id>/375x812.actual.png
screenshots/<case-id>/768x1024.actual.png
screenshots/<case-id>/1440x900.actual.png
diffs/<case-id>/375x812.diff.png
diffs/<case-id>/768x1024.diff.png
diffs/<case-id>/1440x900.diff.png
traces/<case-id>/<attempt-id>.playwright-trace.zip
agentic/<task-id>/actions.jsonl
agentic/<task-id>/result.json
```

The baseline root is a separate, explicitly configured approved root and is
read-only after approval. Every path is canonicalized with component-boundary
and symlink checks. Only `.png`, `.json`, `.jsonl`, `.txt`, and the exact
`.playwright-trace.zip` suffix are accepted. Trace archives are opaque,
type-checked adapter outputs: the coordinator hashes and stores them but never
extracts, executes, rewrites, or trusts archive paths. Video, GIF, HAR,
downloads, and arbitrary archives are not contract-v2 evidence.

Writes use an exclusive temporary file and atomic rename after validation.
Each file is non-empty, SHA-256 hashed, size-bounded, and linked to run/case/
lane/stage/source/package identity. Limits are 500 files, 50 MiB per file,
500 MiB per run, 64 KiB per metadata record, 100 console events, 100 network
events, 32 KiB each for console and network evidence, and 64 KiB API preview.
Agentic action ledgers contain at most 20 steps and only declared action names,
sanitized parameters, URLs under the local origin, result/error codes,
artifact references, and UTC timing. `agentic/<task-id>/result.json` uses the
closed execution/finding/self-judge values and schema-2 fields in `REQ-1723`;
unknown values or missing provenance/input/artifact hashes are `INVALID_RECORD`.
No target-project runtime artifact, conversation transcript, model thought, or
unrestricted DOM is used as a per-run output.

An approved baseline manifest contains approval ID, approver, exact baseline
identity/hash, source/environment tuple, dimensions, viewport, browser/adapter
versions, path, and UTC time. Creating or updating one requires an explicit
one-time user approval naming that identity; comparison cannot create or
replace it. The persisted terminal-report timestamp is the sole retention
anchor. Cleanup before `terminal_report_at + 30 * 24 hours` appends
`retention_active` without mutation. At or after that instant, cleanup first
persists the report, manifest/hash, and cleanup audit in durable coordinator
state outside the run root, then operates only on the registered canonical run
root and appends `cleaned`; failure appends `cleanup_error`. It never changes
the verification terminal outcome or deletes a baseline or unregistered path.

Browser and child-adapter network access is restricted to
`http://dev:<recorded-port>`. Every command is literal argv and runs only in
the registered worktree or artifact root. Agentic execution may use only an
already authorized managed-agent channel or an explicitly detected local
model; it cannot open an additional provider connection. Remote/cloud browser
or model services, tunnels, proxies, real profiles, destructive, credential,
permission, deployment, infrastructure, Docker, automatic test repair,
baseline mutation, and product file-change requests stop before effect with
`APPROVAL_REQUIRED` and an opaque approval ID. Secrets, cookies,
authorization/secret headers, personal data, raw reasoning, transcripts, and
unrestricted command/console/network/DOM payloads are rejected or redacted.

## Rollout, rollback, PM gate, and handoff

Rollout is additive and version-gated as `verification_contract_v2`. The
implementation enables the seven slices in order and announces package
fingerprint, source baseline, schema, and config hash before each stage. A
future schema uses a new version and an explicit conversion contract. Existing
`verification_contract_v1` schema-1 records remain readable and frozen; they
are not guessed, rewritten, reinterpreted, or resumed as contract v2.

Rollback disables new starts and leaves all existing records readable. Recovery
begins only after rechecking the dynamic source baseline, package fingerprint,
config hash, capability matrix, and approval state. It preserves snapshots,
actuals, diffs, baselines, review records, manifests, and redacted logs. It
does not perform destructive migration, branch deletion, broad cleanup, or
baseline deletion.

After integration, the coordinator emits one bounded report containing the
enabled/required lane matrix and separate Backend/UI summaries. Only an
all-required-pass report with complete traceability and deterministic evidence
reaches `pm_review_pending` and the original Sol/xhigh read-only PM final
review. Advisory agentic findings remain visible but are not pass evidence. A
required non-pass or safety failure is recorded and blocks PM success; it is
not retried by the PM gate as if it passed.

The structured delta record is:

```json
{
  "status": "SPEC_DELTA_REQUIRED",
  "runtime_status": "not_started",
  "affected_ids": ["OBJ-170x", "REQ-17xx", "AC-17xx", "TEST-17xx", "IS-170x"],
  "classification": "omission | contradiction | unsafe_input | environment_mismatch | unverifiable",
  "source_snapshot": {"worktree_root": "<absolute>", "commit": "<full>", "tree": "<full>", "package_fingerprint": "<sha256>"},
  "evidence": [{"kind": "bounded-observation", "value": "<sanitized>"}],
  "impact": "<bounded>",
  "proposed_resolution": "<bounded>",
  "blocking_stage": "<IS-170x>",
  "created_at_utc": "<RFC3339>"
}
```

The record is returned before dependent behavior starts and is routed to the
implementation PL, integration PL, and PM for an explicit package decision.

## Documentation-run status

This handoff records static source, convention, and official-document
inspection only. `TEST-1701` through `TEST-1723` are `NOT_RUN`. No server,
API, browser, agentic task, screenshot, image review, deterministic
comparison, bootstrap, product test, build, generator/healer, Docker,
infrastructure, installation, or remote action was run or is claimed. The only
current deliverable is `docs/slices/SLICE-017.md`.

## Acceptance criteria

### AC-1701 — Baseline is dynamically captured

Before `IS-1701` or a later stage, the implementation records the selected
worktree root, ref/detached label, full commit, full tree, machine-readable
porcelain status, clean-state classification, package fingerprint, authority
date, capture method, and UTC time. No hard-coded source identity or absolute
target path is used. The baseline is immutable for that stage.

### AC-1702 — Drift fails closed

Changed source identity, dirty-state classification, package fingerprint,
scenario, baseline identity, or reference boundary stops dependent work before
execution with `SOURCE_DRIFT` or `PACKAGE_FINGERPRINT_MISMATCH`. No external
reference is consulted.

### AC-1703 — Lifecycle is closed

Valid transitions follow the lifecycle exactly. Out-of-order, duplicate, and
replayed transitions preserve prior state. Only the five listed terminal
outcomes are accepted, each with its required evidence or bounded diagnostic.

### AC-1704 — Records are versioned and linked

Every snapshot, config, lane summary, capability, request, deterministic or
agentic browser event, screenshot, review, comparison, artifact, cleanup,
error, and report has an explicit schema version, required run/case/check IDs
where applicable, UTC time,
source/package fingerprint, lane/check requiredness, adapter/model provenance
where applicable, and explicit links. Agentic result fields use their closed
value sets. Blank, unknown, or acceptance-relevant missing fields are rejected.

### AC-1705 — Configuration and snapshot cannot drift

The strict resolved schema-2 `[verification.coordinator]` object and its
SHA-256 are persisted before any server/API/browser action, together with the
dynamic source baseline. Top-level disabled, backend-only, UI-only, and
both-enabled configurations have their exact discriminated shapes;
disabled-object residual fields are rejected. When the top-level object is
enabled, at least one lane and one check are effectively required. The
snapshot contains all required lane, environment, contract, adapter/model,
exact bounded agentic prompt/checklist bytes and hashes, timeout, retry,
approval, artifact, and conditional baseline values and is immutable on
reopen. Unknown fields and implicit required defaults return `CONFIG_INVALID`.

### AC-1706 — Artifact and baseline paths are safe

Traversal, non-canonical roots, symlink escape, primary-checkout output, empty
files, missing hashes, unsupported extensions, and baseline replacement are
rejected. Valid per-run artifacts are contained, bounded, typed, SHA-256
hashed, and linked; approved baselines remain immutable and recoverable.
Cleanup before the terminal-report timestamp plus exactly 30 periods of 24
hours appends `retention_active` without mutation. Eligible cleanup deletes
only the registered run root after durable report/manifest/hash/audit records
exist outside that root and appends `cleaned`; failure appends
`cleanup_error`. No cleanup disposition changes the run terminal outcome.

### AC-1707 — Coordinator owns state

Instrumented adapters that attempt to mutate state, snapshots, baselines, or
roots cannot do so. Only the coordinator persists transitions, provenance, and
terminal outcomes.

### AC-1708 — Retries converge

Readiness/API/deterministic-browser have at most two total attempts; each
agentic task, artifact, screenshot/review/comparison, and cleanup has one. A
preterminal timeout or failure contributes to one bounded terminal record with
exact code, attempts, and evidence, without changing immutable inputs. A
post-terminal cleanup result is operational evidence and cannot add or replace
a terminal outcome.

### AC-1709 — API contract is literal and local

An enabled backend lane's positive probes use only snapshotted literal argv and
request fields. A disabled backend lane requires no API adapter or probe.
Negative cases for traversal, absolute/cross-origin URLs, proxy/credentials,
undeclared headers, shell interpretation, and cross-origin redirects are
rejected. Observed response evidence is bounded, redacted, hashed, and linked.

### AC-1710 — Deterministic UI contract is reproducible

A fresh Chromium context uses exact DPR/locale/timezone/color/reduced-motion
values, navigates only to the recorded origin, waits on a bounded declared
condition, executes ordered actions, evaluates declared deterministic
postconditions with bounded auto-wait, and records navigation, console,
page-error, dialog, trace, and assertion evidence. An LLM verdict,
auto-generated assertion, visual assertion, self-heal, or baseline update
cannot produce pass in `IS-1705`; visual evidence belongs to `IS-1706`.

### AC-1711 — Screenshot bytes are exact

Exactly one non-empty PNG per required viewport has exact pixel dimensions and
DPR `1`, no unrecorded transformation, and persisted metadata, hash, source,
case, browser/adapter version, and capture time.

### AC-1712 — Semantic review is capability-gated

The local-image input path is canonical, regular, non-symlink PNG under the run
root and is sent only when the active-turn runtime signal advertises the
capability. At most three items of at most 10 MiB each are sent per turn, and
findings are limited to 50 entries/16 KiB. Review returns only `approved`,
`rejected`, or `blocked` with bounded findings. Missing signal is `unavailable`
for required review and `skipped` for optional review; it cannot become
approval.

### AC-1713 — Comparison is deterministic and baseline-safe

Only compatible equal-dimension RGBA8 PNGs compare. Metrics and diff bytes are
persisted; changed pixels in the deterministic diff are opaque magenta and
unchanged pixels are transparent. Pass requires approved review when semantic
review is required, no critical-region difference,
`pixel_diff_fraction <= 0.005`, and `max_channel_delta <= 8`. An optional
semantic result remains visible but is not a comparison prerequisite. No
automatic baseline creation or overwrite is possible.

### AC-1714 — Capability absence blocks work

Each capability demanded by an enabled lane/check has persisted availability,
effective requiredness, adapter/version, check time, and bounded diagnostic.
Missing effectively required capability prevents only safe dependent work;
optional dependency absence is `skipped`, and a disabled lane needs no
lane-specific capability. Agentic, deterministic, semantic, pixel, and API
capabilities cannot substitute for one another.

### AC-1715 — Server constraints are enforced

The server uses literal argv, `0.0.0.0`, hostname `dev`, port `10001` or the
recorded next port at or above it, and an explicit HTTP readiness check within
30,000 ms. Port `3000`, Docker, remote services, infrastructure mutation, and
unregistered processes fail closed. Next.js includes `dev` in
`allowedDevOrigins`.

### AC-1716 — Security and operations evidence is bounded

Only the local origin is contacted by browsers and child adapters; argv,
roots, redaction, approval IDs, exact adapter/model/browser identities, prompt
and checklist hashes, UTC timing, retries, bounded action ledgers, evidence
hashes, and cleanup are recorded. Cloud/remote model or browser services,
tunnels, proxies, real profiles, broad tools, self-healing, and other
dangerous or out-of-scope requests stop before effect with terminal `error`
and `APPROVAL_REQUIRED`; the immutable local run cannot resume under a later
approval. Secrets, transcripts, private reasoning, and unrestricted
command/response/DOM data do not enter records.

### AC-1717 — Rollout is versioned and staged

`verification_contract_v2`, package fingerprint, schema, and source baseline
are announced before a new run. Stages are enabled in the declared order.
Existing `verification_contract_v1` schema-1 snapshots remain readable but
cannot resume as contract v2 and are not reinterpreted.

### AC-1718 — Rollback preserves evidence

Disabling starts preserves snapshots, config/source hashes, baselines, actuals,
diffs, reviews, manifests, and redacted logs. Legacy contract-v1/schema-1
resume returns `CONTRACT_VERSION_MISMATCH`; a nonterminal
contract-v2/schema-2 run continues only from the exact snapshot after
successful revalidation, with exact drift or environment error otherwise.
Terminal runs never resume. No destructive migration, baseline deletion,
broad cleanup, or in-place rewrite occurs.

### AC-1719 — Bootstrap order is closed

`BOOTSTRAP-1701` validates identity/config, snapshots, discovers capabilities,
starts the constrained local server, executes only enabled Backend/UI lanes in
the declared order, records separate lane summaries, and writes exactly one
aggregate terminal report. Backend-only requires no UI evidence; UI-only
requires no API probe. Agentic exploration follows deterministic UI/visual
checks in a fresh context and remains advisory; unavailable optional
capabilities produce visible skips without blocking required work. This
documentation handoff makes no claim that the procedure ran.

### AC-1720 — PM gate and first slice are complete

Only a complete report in which every effectively required check and its
required lane passed reaches `pm_review_pending` and the original PM final
review. `IS-1701` must close again for v3 with its four mapped requirements,
acceptance/tests, dynamic baseline, schema-2 lane config hash, immutable run
snapshot, legacy contract-v1/schema-1 readability, and rollback record before
`IS-1702` begins.
Required non-pass, safety failure, or missing evidence blocks PM success;
advisory agentic output cannot override deterministic evidence.

### AC-1721 — Delta records are structured and bounded

A missing, contradictory, unsafe, environment-incompatible, or unverifiable
contract fact produces one `SPEC_DELTA_REQUIRED` record with the exact required
fields, affected traceability IDs, bounded evidence, `runtime_status:
not_started`, and no private or secret data. Dependent behavior does not run.

### AC-1722 — Backend and UI lanes are independently selectable

Backend-only, UI-only, and both-enabled configurations each run without
requiring disabled-lane fields or capabilities. At least one lane is enabled
and required, and each required lane has a required check. Each enabled lane
has one requiredness-preserving summary and closed outcome; disabled lanes have
no synthetic outcome. Effective requiredness is exactly
`lane.required && check.required`; required non-pass aggregation follows
`error > unavailable > failed > skipped`, while any safety or source-integrity
failure produces aggregate `error` regardless of optionality.

### AC-1723 — Agentic UI is bounded and cannot self-certify

Each agentic task is local, advisory, single-attempt, version/model/input-byte
pinned, origin/tool/step/time bounded, isolated, and fully linked to a
schema-2 result with closed execution, finding, and self/judge values.
Unavailable `agentic_browser` capability is a visible optional skip. Its
self-evaluation, judge verdict, or `no_finding` cannot pass the UI lane;
declared postconditions are checked deterministically. Generated or healed
plans, selectors, scripts, tests, and baselines remain unapplied candidate
artifacts, and remote/cloud/profile/tunnel requests produce
`APPROVAL_REQUIRED` before effect.

## Verification cases

All procedures here are future implementation checks. Their status in this
documentation-only package is `NOT_RUN`.

### TEST-1701 — Dynamic baseline capture

At the start of `IS-1701` and a later-stage replay, read the selected worktree
with literal Git argv and assert full commit/tree/ref state, porcelain status,
package fingerprint, authority date, clean classification, timestamp, and
immutable stage record. Assert that changing the selected root changes the
captured identity rather than matching a hard-coded value. Expected: `AC-1701`.

### TEST-1702 — Drift and reference-boundary negatives

Run changed commit/tree/ref, dirty state, package bytes, scenario, baseline,
and forbidden external-reference cases. Assert stop-before-dependent-work and
the exact drift/fingerprint error. Expected: `AC-1702`.

### TEST-1703 — Lifecycle state machine

Exercise every valid transition, out-of-order transition, duplicate terminal
event, and replay. Assert exact state preservation, one terminal outcome, and
closed outcome values. Expected: `AC-1703`.

### TEST-1704 — Versioned record linkage

Validate config, snapshot, lane summary, capability, request, deterministic and
agentic browser, screenshot, review, comparison, artifact, cleanup, error, and
report records. Try blank or unknown check IDs, unknown states, missing fingerprints, missing
lane/check requiredness, missing adapter/model provenance, and broken artifact
links. For agentic results also reject every unknown execution/finding/
self-judge value and missing input or ledger hash. Expected: `AC-1704`.

### TEST-1705 — Strict config and snapshot immutability

Load top-level disabled, backend-only, UI-only, and both-enabled schema-2
coordinator objects and verify canonical bytes/hash and their exact
discriminated shapes. Exercise required and optional semantic review and exact
derived capability lists. Reject disabled-object residual fields, all-disabled
or all-optional lanes within a top-level enabled object, a required lane
without a required check, disabled-lane residual fields, a required agentic
task, missing or mismatched prompt/
checklist source bytes and hashes, unknown fields, implicit values, version
ranges/`latest`, fallback model, duplicates, unsupported
adapter/tool/assertion, secret, invalid range, and missing fields. Start a
snapshot, mutate source/config/scenario/lane/adapter/model/prompt/checklist
inputs, reopen it, and assert byte-equivalent resolved values and unchanged
identity before any action. Reopen legacy contract-v1/schema-1 evidence
read-only and reject resuming it as contract v2. Expected: `AC-1705`.

### TEST-1706 — Root, artifact, and baseline security

Attempt traversal, non-canonical root, symlink escape, checkout output, empty
file, unsupported/arbitrary archive type, missing hash, oversize file, trace
archive extraction, and baseline replacement. Then write valid
PNG/JSON/JSONL/TXT and opaque `.playwright-trace.zip` records and verify
containment, limits, hashes, metadata, approval manifest, and preservation.
Attempt cleanup immediately before and exactly at
`terminal_report_at + 30 * 24 hours`; assert a `retention_active` operational
record with no mutation before the boundary and registered-root-only cleanup
after report/manifest/hash/audit persistence outside that root at the boundary.
Assert exact `cleaned` and `cleanup_error` records and that no cleanup path
changes the existing terminal outcome. Expected: `AC-1706`.

### TEST-1707 — Coordinator ownership

Use instrumented adapters and reviewers that attempt direct mutation of state,
snapshots, baselines, outcomes, and roots. Assert rejection and coordinator-
only persistence. Expected: `AC-1707`.

### TEST-1708 — Timeout and retry convergence

Exercise timeout/failure for readiness/API/deterministic browser and for
single-attempt agentic/screenshot/review/comparison/artifact/cleanup. Assert
attempt ceilings, immutable lane/task/adapter/model inputs, exact error,
evidence references, and exactly one terminal outcome. Run cleanup after that
outcome and assert its one operational record cannot add or change a terminal
outcome. Expected: `AC-1708`.

### TEST-1709 — API contract positives and negatives

Use a local fake server and inspect literal argv/request evidence for declared
probes. Reject traversal, absolute URL, cross-origin redirect, proxy,
credential, undeclared header, shell metacharacter, unexpected status/content
type, and unbounded body cases. Run a UI-only configuration and assert no API
adapter, probe, capability requirement, or synthetic skip is created. Expected:
`AC-1709`.

### TEST-1710 — Browser context and action order

Use a supported deterministic driver fake and local page to assert fresh
Chromium context, exact settings, local-only navigation, bounded readiness,
ordered actions, web-first postconditions and accessibility assertions, and
recorded console/page/dialog/navigation/trace evidence. Reject visual or
screenshot assertions in `IS-1705`, an LLM verdict, generated assertion,
automatic healer change, baseline update, unbounded wait, and missing
assertion. Assert missing driver is capability-gated rather than silently
installed or substituted. Run a backend-only configuration and assert no UI
work is created. Expected: `AC-1710`.

### TEST-1711 — Screenshot dimensions and byte integrity

Capture the three declared viewports with a controlled browser and assert one
PNG per viewport, exact dimensions/DPR, no resize/crop/post-processing, nonzero
bytes, metadata, and SHA-256. Expected: `AC-1711`.

### TEST-1712 — Semantic-review capability and input contract

Exercise active-turn `localImage` signal present, absent, malformed path,
symlink path, outside-root path, oversize input, bounded findings, rejection,
block, and approval. Assert required/optional unavailable behavior and no raw
reasoning persistence. Expected: `AC-1712`.

### TEST-1713 — Comparison thresholds and baseline immutability

Compare equal valid PNGs and threshold-boundary cases; assert deterministic
row-major metrics, diff bytes, critical-region behavior, required-review
prerequisite, optional-review independence, dimension mismatch handling,
missing/incompatible baseline error, and no baseline create/overwrite.
Expected: `AC-1713`.

### TEST-1714 — Capability matrix hard gates

Independently make server, API, deterministic browser, agentic browser,
screenshot, semantic-review, and comparison unavailable across backend-only,
UI-only, and both-enabled configurations. Assert effectively required
dependencies are `unavailable`, optional lane/check dependencies are
`skipped`, effective requiredness equals the immutable lane/check conjunction,
disabled lanes require nothing, diagnostics are bounded, and no substitution
produces `passed`. Expected: `AC-1714`.

### TEST-1715 — Server constraints and readiness

Inspect literal argv, bind/host, port-floor selection, `dev` origin, Next.js
allowed-origin setting, readiness status/30,000 ms timeout, and rejection of
port 3000, Docker, remote, infrastructure, or unregistered process cases.
Expected: `AC-1715`.

### TEST-1716 — Security, privacy, approval, and operations audit

Attempt remote, destructive, credential, permission, deployment, Docker,
secret-bearing, out-of-root, and product-file actions. For agentic adapters,
also attempt external navigation/search, arbitrary evaluate, file access,
upload/download, broad tool use, remote model/browser, tunnel, proxy, real or
persistent profile, transcript/thought persistence, auto-heal, and baseline
write. Assert each request stops before effect with terminal `error`,
`APPROVAL_REQUIRED`, and an opaque approval ID; assert the run cannot resume
under later approval. Also assert local-only network, literal argv, redaction,
bounded action logs, exact version/model/prompt/checklist hashes, timing/retry
evidence, and cleanup state. Expected: `AC-1716`.

### TEST-1717 — Versioned rollout compatibility

Enable each stage in order, inspect the announced contract-v2/package-v3/
schema-2/source identities, and reopen an existing contract-v1/schema-1 run
after the version change. Assert legacy evidence remains readable but cannot
resume as contract v2, no reinterpretation occurs, and no later stage begins
before its prerequisite evidence. Expected: `AC-1717`.

### TEST-1718 — Rollback and recovery preservation

Disable starts during each stage. Attempt a contract-v1/schema-1 resume and
assert `CONTRACT_VERSION_MISMATCH`. Resume a nonterminal
contract-v2/schema-2 snapshot with exact inputs, then separately exercise
source drift, package drift, capability loss, environment loss, and a terminal
run resume. Assert exact continuation or bounded error, one terminal outcome,
readable evidence, and no destructive migration or baseline mutation.
Expected: `AC-1718`.

### TEST-1719 — Bootstrap procedure order

Instrument `BOOTSTRAP-1701` in backend-only, UI-only, and both-enabled modes.
Assert the eleven ordered steps, no disabled-lane work/synthetic skip,
per-enabled-lane summary, Backend API work only when enabled, deterministic
UI/visual work only when enabled, advisory agentic work after deterministic
checks in a fresh context, optional capability absence as a visible skip, one
aggregate report, and safe stop-on-failed-precondition for effectively required
work. This procedure remains future work and is not run by this documentation
task. Expected: `AC-1719`.

### TEST-1720 — PM gate and first-slice closure

Provide complete and incomplete `IS-1701` evidence. Assert only complete
`REQ-1701`, `REQ-1702`, `REQ-1704`, and `REQ-1705` evidence with baseline,
schema-2 lane config hash, immutable snapshot, legacy contract-v1/schema-1
readability, and rollback record permits the next slice. Assert only reports
whose effectively required checks and required lanes all passed enter
`pm_review_pending`; optional agentic output cannot override deterministic
evidence. Expected: `AC-1720`.

### TEST-1721 — SPEC_DELTA_REQUIRED schema

Inject each delta classification and omit each required field in turn. Assert
one bounded record, exact affected traceability IDs, `runtime_status` set to
`not_started`, no dependent execution, and no secret/private/unrestricted
content. Expected: `AC-1721`.

### TEST-1722 — Independent QA lane matrix and aggregation

Using already-valid immutable snapshots from `TEST-1705`, run backend-only,
UI-only, both-required, and one-required/one-optional matrices, including
required and optional checks inside each enabled lane. Assert each enabled lane
has one requiredness-preserving summary and closed outcome, disabled lanes have
no capability/check/outcome records, effective requiredness is the exact
lane/check conjunction, required non-pass uses the declared precedence,
optional non-pass is visible without changing aggregate pass, and any
source/security failure produces aggregate `error`. Expected: `AC-1722`.

### TEST-1723 — Bounded agentic UI evidence and promotion guard

Use instrumented Browser Use-like, Playwright agent-like, and Stagehand-like
fakes rather than installing those products. Exercise a valid local advisory
task and unavailable optional capability. Reject missing/excess steps, repeated
attempt, version range, model, prompt/checklist source-byte or hash drift,
undeclared tool/action, external origin, remote/cloud/tunnel/profile use,
unbounded output, transcript/thought persistence, unknown result status, and
self-reported success without deterministic postconditions. Assert the exact
schema-2 result fields and hashes, closed execution/finding/self-judge values,
visible optional skip, advisory-only verdicts, authoritative deterministic
recheck, `APPROVAL_REQUIRED` before remote effect, and unapplied generated/
healed tests, scripts, locators, and baselines. Expected: `AC-1723`.
