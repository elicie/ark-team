# Closed Contract — SLICE-017 — verification-spec-v2

- Package identity: `verification-spec-v2`.
- Package status: `SPEC_APPROVED`.
- Authority date: 2026-07-26 UTC.
- Authority: the user-approved assignment, the authority/evidence review, the
  inspected repository source and configuration conventions, the role and
  approval contracts, and the adjacent Closed Contract slice documents.
- Reference boundary: `NONE`. No web page, installed product, remote service,
  screenshot, image, model output, or external API is an authority for product
  behavior in this package.
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

No route, selector, action, baseline, browser installation, image capability,
secret, remote authority, or visual result is inferred from these findings.
Unknown acceptance-relevant facts are handled by the structured
`SPEC_DELTA_REQUIRED` result defined below.

## Scope, actors, vocabulary, and status

### Scope and actors

This slice specifies one coordinator for bounded local verification. It covers
dynamic source/config capture, strict configuration, immutable run records,
capability discovery, local-server readiness, literal-argv API checks,
reproducible browser checks, exact screenshot capture, semantic image review,
immutable baseline comparison, artifact retention, PM gating, rollback, and a
single bootstrap scenario.

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
- **Run snapshot**: the immutable, resolved configuration and environment
  record created before the first server, API, or browser action.
- **Artifact root**: the registered absolute per-run directory
  `<ARK_TEAM_STATE_ROOT>/<run_id>/verification`; all per-run outputs stay
  beneath it.
- **Approved baseline**: an immutable, content-addressed visual artifact and
  manifest approved by one explicit user decision for its exact identity and
  environment tuple.
- **Required check**: a check whose `required` field is `true` in the immutable
  run snapshot. A required check cannot be silently downgraded.
- **Capability**: an independently detected ability named `server`, `api`,
  `browser`, `screenshot`, `semantic_review`, or `comparison`.
- **Passed**: every required assertion and required evidence exists and
  passed. Missing capability, missing artifact, source drift, unresolved
  approval, skipped required work, or unrun work is not passed.

The only verification terminal outcomes are `passed`, `failed`,
`unavailable`, `skipped`, and `error`. `SPEC_DELTA_REQUIRED` is a structured
package/contract disposition and is never a passed outcome.

The coordinator lifecycle is closed:

```text
integrated → configured → snapshotted → capabilities → ready → executing
→ collecting → deciding
deciding → passed | failed | unavailable | skipped | error
passed with every required check → pm_review_pending → original_pm_review
```

Invalid, repeated, or out-of-order transitions leave the prior state unchanged
and produce `error` with a bounded diagnostic. Closed error codes are
`SOURCE_DRIFT`, `PACKAGE_FINGERPRINT_MISMATCH`, `CONFIG_INVALID`,
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
- Observable result: every record has `schema_version: 1`, non-empty run and
  case IDs, stage, UTC timestamp, source/package fingerprint, required flag,
  adapter/version where applicable, and explicit artifact/hash links. Unknown
  required states and missing acceptance-relevant fields are rejected; evidence
  records are append-only.
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

  The resolved object contains explicit values for `schema_version: 1`,
  `enabled`, required capabilities, literal server argv/lifecycle/readiness,
  API probes, browser adapter/cases/actions, exact viewports, baseline root and
  identity tuple, comparison policy, evidence limits, timeouts, retry policy,
  and approval policy. The snapshot contains package/source identity, run/case
  IDs, scenario version, resolved config hash, artifact/baseline roots, origin
  and selected port, browser context, contracts, thresholds, and creation
  time. Later resume/reopen uses only this snapshot.
- Acceptance: `AC-1705`
- Verification: `TEST-1705`
- Implementation slice: `IS-1701`

#### REQ-1706 — Artifact-root and approved-baseline controls

- Level: `MUST`
- Source: `SECURITY_POLICY`
- Actors: coordinator, artifact store, reviewer, and operator
- Preconditions: a snapshot is present and roots have been registered.
- Trigger: an artifact or baseline is created, read, reviewed, compared, or
  cleaned.
- Observable result: paths are absolute, canonical, component-boundary safe,
  beneath their registered root, and free of symlink traversal. Per-run
  artifacts are non-empty, type-checked, SHA-256 hashed, size-bounded, and
  linked to the snapshot. Approved baselines are separate, read-only,
  content-addressed, retain their approval manifest, and cannot be replaced or
  deleted by comparison or ordinary cleanup.
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
- Observable result: API, browser, and readiness actions have two total
  attempts; screenshot, artifact write, semantic review, comparison, and
  cleanup have one. Retry never changes the snapshot, baseline, required flag,
  or input. The coordinator persists the exact closed error code, bounded
  diagnostic, attempt count, evidence references, and exactly one terminal
  outcome per run.
- Acceptance: `AC-1708`
- Verification: `TEST-1708`
- Implementation slice: `IS-1703`

### OBJ-1705 — Literal API and reproducible browser contracts

#### REQ-1709 — Literal local API verification

- Level: `MUST`
- Source: `INTERFACE_CONTRACT`
- Actors: API adapter and local server
- Preconditions: `server` and `api` capabilities are available and the
  snapshot contains one API probe.
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

#### REQ-1710 — Reproducible local browser verification

- Level: `MUST`
- Source: `INTERFACE_CONTRACT`
- Actors: browser adapter and local server
- Preconditions: `browser` is available and browser version, context, URL,
  readiness condition, viewport, and action list are snapshotted.
- Trigger: a browser case begins.
- Observable result: a fresh isolated Chromium context uses DPR `1`, locale
  `en-US`, timezone `UTC`, light color scheme, and
  `no-preference` reduced motion. It navigates only to the recorded local
  origin, waits for the declared bounded readiness condition, executes ordered
  declared actions, and records navigation, console, page-error, dialog, and
  assertion evidence. No unbounded sleep or undeclared action is accepted.
- Acceptance: `AC-1710`
- Verification: `TEST-1710`
- Implementation slice: `IS-1705`

### OBJ-1706 — Screenshots, semantic review, and comparison

#### REQ-1711 — Exact screenshot artifacts

- Level: `MUST`
- Source: `VISUAL_CONTRACT`
- Actors: browser adapter, screenshot adapter, and artifact store
- Preconditions: browser readiness and `screenshot` capability passed.
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
- Preconditions: a valid screenshot exists and `semantic_review` has an
  explicit active runtime capability signal and recorded version/identity.
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
- Preconditions: an approved baseline matches the scenario, source-compatible
  snapshot/environment tuple, viewport, browser context, and dimensions; the
  `comparison` capability is available.
- Trigger: a candidate screenshot is ready.
- Observable result: equal-dimension PNGs are decoded to RGBA8 without resize,
  crop, alpha normalization, or color-space conversion. The adapter computes
  row-major `pixel_diff_fraction` and `max_channel_delta`, writes a
  deterministic diff PNG whose changed pixels are opaque magenta and unchanged
  pixels are transparent, and persists all input/output hashes and metrics.
  Passing requires approved semantic review, no declared critical-region
  difference, `pixel_diff_fraction <= 0.005`, and
  `max_channel_delta <= 8`. Missing/incompatible approval produces
  `BASELINE_NOT_APPROVED`; comparison never creates or overwrites a baseline.
- Acceptance: `AC-1713`
- Verification: `TEST-1713`
- Implementation slice: `IS-1706`

### OBJ-1707 — Capability, server, security, privacy, and operations

#### REQ-1714 — Hard capability gates

- Level: `MUST`
- Source: `SAFETY_POLICY`
- Actors: coordinator and operator
- Preconditions: required capabilities are declared in the immutable snapshot.
- Trigger: discovery completes or a required capability becomes unavailable.
- Observable result: each capability has an availability state, adapter/name,
  version where available, check time, and bounded diagnostic. An unavailable
  required capability prevents dependent work and yields `unavailable`; an
  optional dependent check yields `skipped`. No browser-to-API,
  screenshot-to-text, semantic-review-to-pixel, or comparator-to-review
  substitution can satisfy a required check.
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
  or redacted. Remote, destructive, credential, permission, deployment,
  infrastructure, Docker, and product file-change actions remain
  `waiting_user` with an opaque one-time approval ID. Reports include UTC
  timestamps, runtime/browser/API versions, capability matrix, timeout and
  retry counters, hashes, redacted errors, and cleanup state.
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
  `verification_contract_v1`; the package fingerprint, schema version, and
  source baseline are announced before execution. Existing records retain
  their snapshots and are not reinterpreted by a later contract version.
  Stages enable in order: source/config/snapshot, artifacts/baselines,
  coordinator, capability/server, API/browser, visual checks, then bootstrap.
- Acceptance: `AC-1717`
- Verification: `TEST-1717`
- Implementation slice: `IS-1707`

#### REQ-1718 — Non-destructive rollback and recovery

- Level: `MUST`
- Source: `OPERATIONS_POLICY`
- Actors: operator and coordinator
- Preconditions: a v1 run, snapshot, or artifact exists.
- Trigger: disablement, contract mismatch, source drift, capability loss, or
  recovery request.
- Observable result: new starts are disabled; snapshots, source baselines,
  config hashes, approved baselines, actuals, diff images, review records,
  manifests, and redacted logs remain readable and recoverable. A resumable
  run returns `error` with `SPEC_DRIFT` or `ENVIRONMENT_UNAVAILABLE` after
  revalidation. No database migration, schema rewrite, broad cleanup, branch
  deletion, baseline deletion, or in-place baseline replacement occurs.
- Acceptance: `AC-1718`
- Verification: `TEST-1718`
- Implementation slice: `IS-1707`

### OBJ-1709 — Bootstrap, PM gate, and delta handoff

#### REQ-1719 — Reproducible bootstrap scenario

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: coordinator, local server, API adapter, browser adapter, screenshot
  adapter, semantic reviewer, comparison adapter, and artifact store
- Preconditions: source/package identity passed, the run snapshot exists, the
  artifact root and approved baseline are registered, and all required
  capabilities are available.
- Trigger: `BOOTSTRAP-1701` is requested.
- Observable result: the future implementation performs this exact order:
  (1) validate dynamic source/package identity; (2) validate and persist the
  resolved config; (3) create the immutable run snapshot; (4) discover and
  persist capabilities; (5) start/attach only to the registered local server;
  (6) probe `GET /` at the recorded origin and require HTTP `200`; (7) create
  a fresh browser context and satisfy readiness; (8) execute the declared
  browser case and capture all three screenshots; (9) run semantic review;
  (10) compare with the approved baseline; and (11) persist exactly one
  terminal outcome and handoff report. A failed precondition stops at its
  stage with the corresponding closed outcome.
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
- Observable result: only one report with `passed` for every required check,
  complete `REQ → AC → TEST → IS` evidence, source/package fingerprint,
  snapshot ID, artifact/baseline hashes, attempt counts, and redacted errors
  can enter `pm_review_pending` and the original Sol/xhigh read-only PM final
  review. Any `failed`, `unavailable`, `skipped`, `error`, missing evidence,
  unresolved approval, or `SPEC_DELTA_REQUIRED` blocks PM success and remains
  a recorded non-pass. `IS-1701` is closed only when its requirements
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

The normative path is:

```text
OBJ-17xx → REQ-17xx → AC-17xx → TEST-17xx → IS-170x → SLICE-017
```

### First vertical slice — IS-1701 closure

`IS-1701 — Dynamic source baseline, strict configuration, record schemas, and
immutable run snapshot` is the first complete vertical slice. It includes
exactly `REQ-1701`, `REQ-1702`, `REQ-1704`, and `REQ-1705`, with
`AC-1701`/`TEST-1701`, `AC-1702`/`TEST-1702`, `AC-1704`/`TEST-1704`, and
`AC-1705`/`TEST-1705`.

Its implementation inputs are the selected worktree, approved package bytes,
the existing TOML loader, the existing persisted run-record mechanism, and a
registered state root. Its outputs are a dynamic implementation-baseline
record, validated canonical resolved configuration plus hash, schema-versioned
record definitions, and an immutable pre-action run snapshot. It does not
start a server, make an API request, launch a browser, capture a screenshot,
invoke semantic review, or compare images.

The slice is closed only when all four mapped tests pass with observable
records and hashes, the snapshot is reopened byte-equivalently, and its
rollback record disables new config reads while preserving existing snapshots
and evidence. `IS-1702` cannot begin before this closure. A missing prerequisite
or contradiction emits `SPEC_DELTA_REQUIRED` with `runtime_status: not_started`.

### Ordered implementation slices

1. `IS-1701`: dynamic source baseline, strict configuration, record schemas,
   and immutable run snapshot.
2. `IS-1702`: registered artifact roots, hashes, PNG metadata, immutable
   approved baselines, diff artifacts, retention, and safe cleanup records.
3. `IS-1703`: coordinator ownership, lifecycle, typed adapter records, bounded
   timeout/retry handling, and one terminal outcome.
4. `IS-1704`: capability discovery, local server readiness, port/host rules,
   approvals, redaction, and local-only security gates.
5. `IS-1705`: snapshotted API probes and reproducible browser cases.
6. `IS-1706`: exact screenshots, semantic review, deterministic comparison,
   and baseline-safe visual evidence.
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
schema_version = 1
enabled = true
required_capabilities = ["server", "api", "browser", "screenshot", "semantic_review", "comparison"]
server_argv = ["<literal-program>", "<literal-arg>"]
server_bind = "0.0.0.0"
server_host = "dev"
server_port_floor = 10001
server_readiness_path = "/"
server_readiness_status = 200
server_readiness_timeout_ms = 30000
api_probes = [{ id = "<id>", method = "GET", path = "/", query = {}, headers = {}, expected_status = 200, expected_content_type = "<type>", body_digest = "<digest-or-none>", required = true }]
api_adapter = "<allowlisted-literal-argv-adapter>"
browser_adapter = "<allowlisted-adapter>"
browser_cases = [{ id = "<id>", path = "/", readiness = "<bounded-condition>", actions = [], required = true }]
viewports = ["375x812", "768x1024", "1440x900"]
baseline_root = "<canonical-approved-root>"
baseline_identity = "<explicit-hash-and-environment-tuple>"
pixel_diff_fraction_max = 0.005
max_channel_delta = 8
critical_regions = []
evidence_limits = { console_events = 100, network_events = 100, metadata_bytes = 65536, api_preview_bytes = 65536, file_bytes = 52428800, total_bytes = 524288000, file_count = 500 }
console_bytes = 32768
network_bytes = 32768
semantic_review_required = true
retention_days = 30
server_timeout_ms = 30000
api_timeout_ms = 30000
browser_timeout_ms = 60000
case_timeout_ms = 120000
attempts = { readiness = 2, api = 2, browser = 2, screenshot = 1, semantic_review = 1, comparison = 1, artifact_write = 1, cleanup = 1 }
approval_policy = "explicit-one-time-user-decision"
```

The implementation validates literal argv (no shell), unique bounded IDs,
relative paths without `..`, allowlisted methods/headers, bounded action lists,
allowlisted API/browser adapters, exact viewport order, explicit
environment/baseline identity, and every timeout/attempt/limit. It rejects
unknown keys, empty/implicit fields, secrets, unsupported adapters, duplicate
IDs, unbounded arrays, and out-of-range values. The resolved canonical object,
hash, and dynamic source baseline are persisted before dependent work. An API
adapter such as curl is usable only after capability detection and only through
the literal-argv interface; no globally installed adapter is assumed.

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
```

The baseline root is a separate, explicitly configured approved root and is
read-only after approval. Every path is canonicalized with component-boundary
and symlink checks. Only `.png`, `.json`, `.jsonl`, and `.txt` are accepted.
Writes use an exclusive temporary file and atomic rename after validation.
Each file is non-empty, SHA-256 hashed, size-bounded, and linked to run/case/
stage/source/package identity. Limits are 500 files, 50 MiB per file, 500 MiB
per run, 64 KiB per metadata record, 100 console events, 100 network events,
32 KiB each for console and network evidence, and 64 KiB API preview. No
target-project runtime artifact is used as a per-run output.

An approved baseline manifest contains approval ID, approver, exact baseline
identity/hash, source/environment tuple, dimensions, viewport, browser/adapter
versions, path, and UTC time. Creating or updating one requires an explicit
one-time user approval naming that identity; comparison cannot create or
replace it. Cleanup operates only on a registered canonical run root after a
final report and preserves the manifest/hash/audit record in durable state; it
never deletes a baseline or an unregistered path.

Network access is restricted to `http://dev:<recorded-port>`. Every command is
literal argv and runs only in the registered worktree or artifact root. Remote,
destructive, credential, permission, deployment, infrastructure, Docker, and
product file-change actions remain `waiting_user` with an opaque approval ID.
Secrets, cookies, authorization/secret headers, personal data, raw reasoning,
and unrestricted command/console/network payloads are rejected or redacted.

## Rollout, rollback, PM gate, and handoff

Rollout is additive and version-gated as `verification_contract_v1`. The
implementation enables the seven slices in order and announces package
fingerprint, source baseline, schema, and config hash before each stage. A
future schema uses a new version and an explicit conversion contract; v1
records are not guessed, rewritten, or reinterpreted.

Rollback disables new starts and leaves all existing records readable. Recovery
begins only after rechecking the dynamic source baseline, package fingerprint,
config hash, capability matrix, and approval state. It preserves snapshots,
actuals, diffs, baselines, review records, manifests, and redacted logs. It
does not perform destructive migration, branch deletion, broad cleanup, or
baseline deletion.

After integration, the coordinator emits one bounded report. Only an all-
required-pass report with complete traceability and evidence reaches
`pm_review_pending` and the original Sol/xhigh read-only PM final review. A
non-pass report is recorded and blocks PM success; it is not retried by the PM
gate as if it passed.

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

This handoff records static source, convention, and content inspection only.
`TEST-1701` through `TEST-1721` are `NOT_RUN`. No server, API, browser,
screenshot, image review, deterministic comparison, bootstrap, product test,
build, generator, Docker, infrastructure, or remote action was run or is
claimed. The only current deliverable is `docs/slices/SLICE-017.md`.

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

Every snapshot, config, capability, request, browser event, screenshot, review,
comparison, artifact, error, and report has schema version 1, required IDs, UTC
time, source/package fingerprint, required flag, and explicit links. Blank,
unknown, or acceptance-relevant missing fields are rejected.

### AC-1705 — Configuration and snapshot cannot drift

The strict resolved `[verification.coordinator]` object and its SHA-256 are
persisted before any server/API/browser action, together with the dynamic source
baseline. The snapshot contains all required config, environment, contract,
timeout, retry, approval, artifact, and baseline values and is immutable on
reopen. Unknown fields and implicit required defaults return `CONFIG_INVALID`.

### AC-1706 — Artifact and baseline paths are safe

Traversal, non-canonical roots, symlink escape, primary-checkout output, empty
files, missing hashes, unsupported extensions, and baseline replacement are
rejected. Valid per-run artifacts are contained, bounded, typed, SHA-256
hashed, and linked; approved baselines remain immutable and recoverable.

### AC-1707 — Coordinator owns state

Instrumented adapters that attempt to mutate state, snapshots, baselines, or
roots cannot do so. Only the coordinator persists transitions, provenance, and
terminal outcomes.

### AC-1708 — Retries converge

Readiness/API/browser have at most two total attempts; artifact,
screenshot/review/comparison, and cleanup have one. A timeout or failure emits
one bounded terminal record with exact code, attempts, and evidence, without
changing immutable inputs.

### AC-1709 — API contract is literal and local

Positive probes use only snapshotted literal argv and request fields. Negative
cases for traversal, absolute/cross-origin URLs, proxy/credentials,
undeclared headers, shell interpretation, and cross-origin redirects are
rejected. Observed response evidence is bounded, redacted, hashed, and linked.

### AC-1710 — Browser contract is reproducible

A fresh Chromium context uses exact DPR/locale/timezone/color/reduced-motion
values, navigates only to the recorded origin, waits on a bounded declared
condition, executes ordered actions, and records navigation, console,
page-error, dialog, and assertion evidence.

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
unchanged pixels are transparent. Pass requires approved review, no
critical-region difference, `pixel_diff_fraction <= 0.005`, and
`max_channel_delta <= 8`. No automatic baseline creation or overwrite is
possible.

### AC-1714 — Capability absence blocks work

Each required capability has persisted availability, adapter/version, check
time, and bounded diagnostic. Missing required capability prevents its
dependent check and cannot be replaced by another capability.

### AC-1715 — Server constraints are enforced

The server uses literal argv, `0.0.0.0`, hostname `dev`, port `10001` or the
recorded next port at or above it, and an explicit HTTP readiness check within
30,000 ms. Port `3000`, Docker, remote services, infrastructure mutation, and
unregistered processes fail closed. Next.js includes `dev` in
`allowedDevOrigins`.

### AC-1716 — Security and operations evidence is bounded

Only the local origin is contacted; argv, roots, redaction, approval IDs,
version data, UTC timing, retries, hashes, and cleanup are recorded. Dangerous
or out-of-scope actions remain `waiting_user`. Secrets, private reasoning, and
unrestricted command/response data do not enter records.

### AC-1717 — Rollout is versioned and staged

`verification_contract_v1`, package fingerprint, schema, and source baseline
are announced before a run. Stages are enabled in the declared order, and
existing snapshots are not reinterpreted by a new version.

### AC-1718 — Rollback preserves evidence

Disabling starts preserves snapshots, config/source hashes, baselines, actuals,
diffs, reviews, manifests, and redacted logs. Recovery returns a bounded
drift/environment error after revalidation. No destructive migration, baseline
deletion, broad cleanup, or in-place rewrite occurs.

### AC-1719 — Bootstrap order is closed

`BOOTSTRAP-1701` validates identity/config, snapshots, discovers capabilities,
starts the constrained local server, requires `GET /` HTTP 200, runs fresh
browser readiness/actions, captures all three viewports, reviews, compares,
and writes exactly one terminal report. This documentation handoff makes no
claim that the procedure ran.

### AC-1720 — PM gate and first slice are complete

Only a complete all-required-pass report reaches `pm_review_pending` and the
original PM final review. `IS-1701` has closed evidence for its four mapped
requirements, acceptance/tests, dynamic baseline, config hash, immutable run
snapshot, and rollback record before `IS-1702` begins. Any non-pass or missing
evidence blocks PM success.

### AC-1721 — Delta records are structured and bounded

A missing, contradictory, unsafe, environment-incompatible, or unverifiable
contract fact produces one `SPEC_DELTA_REQUIRED` record with the exact required
fields, affected traceability IDs, bounded evidence, `runtime_status:
not_started`, and no private or secret data. Dependent behavior does not run.

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

Validate config, snapshot, capability, request, browser, screenshot, review,
comparison, artifact, error, and report records. Try blank IDs, unknown states,
missing fingerprints, missing required flags, and broken artifact links.
Expected: `AC-1704`.

### TEST-1705 — Strict config and snapshot immutability

Load a complete `[verification.coordinator]` object, verify canonical bytes and
hash, then try unknown fields, implicit values, duplicates, unsupported adapter,
secret, invalid range, and missing field inputs. Start a snapshot, mutate
source/config/scenario inputs, reopen it, and assert byte-equivalent resolved
values and unchanged identity before any action. Expected: `AC-1705`.

### TEST-1706 — Root, artifact, and baseline security

Attempt traversal, non-canonical root, symlink escape, checkout output, empty
file, unsupported type, missing hash, oversize file, and baseline replacement.
Then write valid PNG/JSON/JSONL/TXT records and verify containment, limits,
hashes, metadata, approval manifest, retention, and preservation. Expected:
`AC-1706`.

### TEST-1707 — Coordinator ownership

Use instrumented adapters and reviewers that attempt direct mutation of state,
snapshots, baselines, outcomes, and roots. Assert rejection and coordinator-
only persistence. Expected: `AC-1707`.

### TEST-1708 — Timeout and retry convergence

Exercise timeout/failure for readiness/API/browser and for single-attempt
screenshot/review/comparison/artifact/cleanup. Assert attempt ceilings,
immutable inputs, exact error, evidence references, and exactly one terminal
outcome. Expected: `AC-1708`.

### TEST-1709 — API contract positives and negatives

Use a local fake server and inspect literal argv/request evidence for declared
probes. Reject traversal, absolute URL, cross-origin redirect, proxy,
credential, undeclared header, shell metacharacter, unexpected status/content
type, and unbounded body cases. Expected: `AC-1709`.

### TEST-1710 — Browser context and action order

Use a supported driver fake and local page to assert fresh Chromium context,
exact context settings, local-only navigation, bounded readiness, ordered
actions, and recorded console/page/dialog/navigation evidence. Assert missing
driver is capability-gated rather than silently installed or substituted.
Expected: `AC-1710`.

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
row-major metrics, diff bytes, critical-region behavior, review prerequisite,
dimension mismatch handling, missing/incompatible baseline error, and no
baseline create/overwrite. Expected: `AC-1713`.

### TEST-1714 — Capability matrix hard gates

Independently make server, API, browser, screenshot, semantic-review, and
comparison unavailable. Assert required dependent checks are `unavailable`,
optional checks are `skipped`, diagnostics are bounded, and no substitution
produces `passed`. Expected: `AC-1714`.

### TEST-1715 — Server constraints and readiness

Inspect literal argv, bind/host, port-floor selection, `dev` origin, Next.js
allowed-origin setting, readiness status/30,000 ms timeout, and rejection of
port 3000, Docker, remote, infrastructure, or unregistered process cases.
Expected: `AC-1715`.

### TEST-1716 — Security, privacy, approval, and operations audit

Attempt remote, destructive, credential, permission, deployment, Docker,
secret-bearing, out-of-root, and product-file actions. Assert opaque
`waiting_user` decisions, local-only network, literal argv, redaction, bounded
logs, version/timing/hash/retry evidence, and cleanup state. Expected: `AC-1716`.

### TEST-1717 — Versioned rollout compatibility

Enable each stage in order, inspect the announced v1/package/source identity,
and reopen an existing run after a version change. Assert no reinterpretation
and no later stage before its prerequisite evidence. Expected: `AC-1717`.

### TEST-1718 — Rollback and recovery preservation

Disable starts during each stage and exercise source drift, capability loss,
and recovery. Assert all listed records/artifacts remain readable, the exact
bounded recovery outcome is recorded, and no destructive migration or baseline
mutation occurs. Expected: `AC-1718`.

### TEST-1719 — Bootstrap procedure order

Instrument `BOOTSTRAP-1701` and assert the eleven ordered steps, `GET /` HTTP
200, exact viewport set, one report, and stop-on-first-failed-precondition.
This procedure remains future work and is not run by this documentation task.
Expected: `AC-1719`.

### TEST-1720 — PM gate and first-slice closure

Provide complete and incomplete `IS-1701` evidence. Assert only complete
`REQ-1701`, `REQ-1702`, `REQ-1704`, and `REQ-1705` evidence with baseline,
config hash, immutable snapshot, and rollback record permits the next slice;
assert only all-required-pass reports enter `pm_review_pending` and the
original PM review. Expected: `AC-1720`.

### TEST-1721 — SPEC_DELTA_REQUIRED schema

Inject each delta classification and omit each required field in turn. Assert
one bounded record, exact affected traceability IDs, `runtime_status` set to
`not_started`, no dependent execution, and no secret/private/unrestricted
content. Expected: `AC-1721`.
