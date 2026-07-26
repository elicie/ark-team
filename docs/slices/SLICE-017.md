# Closed Contract — SLICE-017

- Spec identity: `verification-spec-v1` — the user-approved SDD package for a
  deterministic local API, browser, screenshot, image-review, and comparison
  verification handoff.
- Package status: `SPEC_APPROVED`.
- Authority: the owning PL's approved SDD package and this explicit handoff;
  no product behavior is inferred from an external source.
- Authority date: 2026-07-26 UTC.
- Git source identity: `origin/main` / `refs/heads/main` at commit
  `50531832a57e3fd0dae093b7ad0b51197e668045`.
- Descriptive main label: `Ark Team verification source — main @ 5053183`.
- Capture state: `GIT_CLEAN` at capture. The source checkout had no staged,
  unstaged, or untracked paths before this contract was authored.
- Source fingerprint: Git tree
  `de77e16a2c257456721bd44fc260f6b90afd2af6`; the tuple
  `commit + tree + refs/heads/main + authority date` is the package identity.
- Source-drift policy: strict. Before implementation or verification, compare
  the recorded commit, tree, branch label, and clean-capture assertion with the
  selected source. Any mismatch is `SPEC_DRIFT`; stop, preserve artifacts, and
  recapture or obtain an explicit package delta. Do not silently rebase this
  contract or accept a changed source as equivalent.
- Reference boundary: `NONE`. The assignment package and the recorded Git
  source are the only authorities; no web, installed-product, external API,
  screenshot, image, model, or other reference material is admitted.
- Objective: define one closed, documentation-only implementation handoff for
  reproducible local verification. The future implementation must persist an
  immutable run/config snapshot, gate unavailable capabilities, exercise the
  declared API and browser contracts, capture controlled visual artifacts,
  review and compare them against an immutable baseline, and report a bounded
  outcome without leaking secrets or claiming unrun work.

## Evidence inventory

The inventory is classified so that observations are not mistaken for future
implementation evidence.

| Evidence ID | Class | Captured item | Authority and use | Limitation |
| --- | --- | --- | --- | --- |
| `EVID-1701` | `SDD_PACKAGE` | The assignment's requirements, acceptance criteria, and verification obligations | Normative source for this closed contract | Does not prove implementation or runtime behavior |
| `EVID-1702` | `GIT_SOURCE_IDENTITY` | `origin/main`, commit `50531832a57e3fd0dae093b7ad0b51197e668045`, tree `de77e16a2c257456721bd44fc260f6b90afd2af6` | Identifies the captured source and drift boundary | Valid only for the recorded capture |
| `EVID-1703` | `GIT_CAPTURE_STATE` | Clean Git status before authoring this file | Establishes the baseline method `GIT_CLEAN` | The intended new slice file is the only post-capture change |
| `EVID-1704` | `REPOSITORY_CONVENTION` | `docs/slices/SLICE-016.md` and adjacent Closed Contract slices | Supplies document structure and traceability conventions | Convention is not evidence that the new contract is implemented |
| `EVID-1705` | `OPERATING_CONSTRAINT` | Local-only execution, explicit dangerous-action approval, bounded artifacts, and no private reasoning | Fixes safety and reporting controls | No command, server, browser, API, screenshot, or image-review run is claimed |
| `EVID-1706` | `NOT_EXECUTED` | No product runtime, live browser, API, screenshot, image reviewer, comparator, generator, build, or product test was run for this handoff | Makes the verification boundary explicit | All `TEST-17xx` procedures below remain future implementation checks |

`EVID-1701` and `EVID-1705` are authority inputs, not observed product
results. `EVID-1702` and `EVID-1703` are source-capture facts. No row in this
document claims future runtime verification was executed.

## Closed terminology and fixed literals

- A **source snapshot** is the exact Git identity and clean-state record above.
- A **baseline** is an approved, immutable visual artifact plus its hash and
  capture snapshot. A baseline is never replaced in place.
- A **run snapshot** is the immutable configuration and environment record
  created before the first API request or browser navigation.
- An **artifact root** is the pre-registered absolute directory for one run;
  every output path is resolved beneath it with component-boundary checks and
  symlink escape checks.
- A **capability** is an independently checked ability such as `server`,
  `api`, `browser`, `screenshot`, `image_review`, or `comparison`.
- A **PASS** is a complete result, not a partial result. Missing capability,
  missing artifact, source drift, unresolved approval, or an unrun required
  check cannot be represented as PASS.
- Required desktop viewport literals are `1440x900` (primary) and `1280x720`
  (secondary). The device scale factor is `1`; locale is `en-US`; timezone is
  `UTC`; color scheme is `light`; and reduced motion is `no-preference`.
- The bootstrap server defaults to port `10001`. If it is occupied, the
  implementation selects the next available port at or above `10001` and
  records that literal port in the run snapshot. Port `3000` is prohibited.
  The server binds `0.0.0.0` and accepts the hostname `dev`. A Next.js target
  must include `dev` in `allowedDevOrigins`.
- The default bootstrap origin is `http://dev:<recorded-port>`. A scenario may
  declare another local path only when the path, method, expected response, and
  readiness condition are all present in the immutable scenario snapshot.

## Scope, actors, lifecycle, and outcomes

### Scope

This slice defines the contract for a verification coordinator and its local
evidence. It covers source identity, run/config snapshots, server readiness,
capability gating, API requests, browser actions, screenshot capture, image
review, baseline comparison, artifact retention, outcomes, and the bootstrap
scenario. It is intentionally a handoff, not an implementation.

Actors are the verification coordinator, the operator or approving user, the
local server under test, the literal-argv API client, the browser runner, the
screenshot capturer, the image-review capability, the comparison engine, and
the artifact store. The coordinator is the only component that changes run
state. A reviewer may approve or reject a baseline or image review, but may
not alter the captured bytes.

The lifecycle is:

```text
planned
  → snapshotted
  → capability_checked
  → server_ready
  → executing
  → captured
  → reviewed
  → compared
  → passed | failed | blocked | invalid
```

The following terminal outcome values are closed:

| Outcome | Meaning | Required behavior |
| --- | --- | --- |
| `PASS` | Every required API, browser, artifact, review, and comparison check passed | Persist all evidence references and the exact snapshot |
| `FAIL` | A required assertion, API response, browser assertion, image review, or comparison threshold failed | Preserve the failing artifact and redacted diagnostic; do not retry indefinitely |
| `BLOCKED_CAPABILITY` | A required capability is unavailable or its version is not accepted | Do not execute the dependent check and do not claim PASS |
| `BLOCKED_ENVIRONMENT` | Server, port, artifact root, permission, or local runtime precondition is unavailable | Preserve the run as resumable and report the exact bounded error |
| `SPEC_DRIFT` | Source, package, scenario, baseline, or snapshot identity changed | Stop before dependent execution and require recapture or a spec delta |
| `INVALID` | The contract, artifact, request, or persisted record is malformed or unsafe | Fail closed without using the malformed value |

Closed error codes are `SOURCE_DRIFT`, `PACKAGE_FINGERPRINT_MISMATCH`,
`SCENARIO_SNAPSHOT_MISMATCH`, `ARTIFACT_ROOT_INVALID`,
`BASELINE_NOT_APPROVED`, `CAPABILITY_UNAVAILABLE`, `SERVER_NOT_READY`,
`API_CONTRACT_MISMATCH`, `BROWSER_CONTRACT_MISMATCH`,
`SCREENSHOT_CAPTURE_FAILED`, `IMAGE_REVIEW_REJECTED`,
`COMPARISON_THRESHOLD_FAILED`, `APPROVAL_REQUIRED`, `TIMEOUT`, and
`INVALID_RECORD`. Every error stores its code, stage, case ID, and a bounded
redacted message; it stores no credentials, raw model reasoning, or unrestricted
command output.

### Explicit documentation-only exclusions

This slice does not create or modify product/runtime behavior, test fixtures,
API routes, browser pages, server configuration, image assets, baselines,
generators, CI, deployments, infrastructure, Docker configuration, databases,
remote repositories, credentials, permissions, or external integrations. It
does not start a development server, call an API, drive a browser, take a
screenshot, invoke image review or comparison, run product tests/builds, or
claim that any future `TEST-17xx` procedure passed. It does not choose a
product-specific endpoint or visual acceptance result outside the literals and
scenario fields defined here.

## Requirements

### OBJ-1701 — Authoritative source and approval boundary

#### REQ-1701 — Immutable source identity and clean capture

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: coordinator, operator, implementation PL
- Preconditions: a Git source and package identity are available.
- Trigger: a run or implementation begins.
- Observable result: the system records the exact source label, ref, commit,
  tree fingerprint, authority date, package status, and capture state; a clean
  capture records `GIT_CLEAN` and a machine-readable empty status.
- Acceptance: `AC-1701`
- Verification: `TEST-1701`
- Implementation slice: `IS-1701`

#### REQ-1702 — Strict drift and reference-boundary enforcement

- Level: `MUST`
- Source: `DECISION`
- Actors: coordinator and operator
- Preconditions: a recorded source fingerprint and `Reference boundary: NONE`
  exist.
- Trigger: any source, scenario, baseline, or package identity differs from
  the recorded identity.
- Observable result: execution stops with `SPEC_DRIFT` or
  `PACKAGE_FINGERPRINT_MISMATCH`; no external reference is consulted and no
  stale baseline is used.
- Acceptance: `AC-1702`
- Verification: `TEST-1702`
- Implementation slice: `IS-1701`

### OBJ-1702 — Closed behavior, actors, data, and failure semantics

#### REQ-1703 — Bounded actor lifecycle and outcome semantics

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: coordinator, server, API client, browser runner, reviewer, and
  comparison engine
- Preconditions: a valid run snapshot exists.
- Trigger: a run advances through a lifecycle stage.
- Observable result: only the listed lifecycle transitions and terminal
  outcomes are accepted; a missing, repeated, or out-of-order transition
  produces `INVALID` without changing the prior state.
- Acceptance: `AC-1703`
- Verification: `TEST-1703`
- Implementation slice: `IS-1703`

#### REQ-1704 — Versioned data and interface records

- Level: `MUST`
- Source: `CONSTRAINT`
- Actors: coordinator and artifact store
- Preconditions: the run is being snapshotted.
- Trigger: a record or artifact reference is persisted.
- Observable result: each record has `schema_version: 1`, a non-empty run ID,
  case ID, stage, timestamp, source fingerprint, and artifact references; API,
  browser, screenshot, review, comparison, and outcome records are linked by
  those identifiers and reject unknown required states.
- Acceptance: `AC-1704`
- Verification: `TEST-1704`
- Implementation slice: `IS-1701`

### OBJ-1703 — Configuration and run snapshots

#### REQ-1705 — Immutable configuration/run snapshot

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: coordinator and operator
- Preconditions: the source identity has passed `REQ-1701`.
- Trigger: the first run action is requested.
- Observable result: before any server, API, or browser action, the coordinator
  stores one immutable snapshot containing package status and fingerprint,
  source identity, run/case IDs, scenario version, artifact and baseline roots,
  server origin and port, capability requirements, viewport literals, browser
  context, timeouts, retry limits, API contract, browser contract, comparison
  thresholds, approval policy, and creation timestamp.
- Acceptance: `AC-1705`
- Verification: `TEST-1705`
- Implementation slice: `IS-1701`

#### REQ-1706 — Artifact root and baseline controls

- Level: `MUST`
- Source: `SECURITY_POLICY`
- Actors: coordinator, artifact store, reviewer
- Preconditions: a run-specific artifact root and a separate baseline identity
  have been registered.
- Trigger: an artifact or baseline is written, read, reviewed, or cleaned.
- Observable result: paths are absolute, normalized, beneath their registered
  root, and not symlink escapes; every artifact is non-empty, typed, hashed
  with SHA-256, and linked to the snapshot. Approved baselines are immutable,
  content-addressed, and retained through comparison and rollback.
- Acceptance: `AC-1706`
- Verification: `TEST-1706`
- Implementation slice: `IS-1702`

### OBJ-1704 — Coordinator architecture and result ownership

#### REQ-1707 — Single coordinator with explicit component boundaries

- Level: `MUST`
- Source: `DECISION`
- Actors: coordinator and all verification components
- Preconditions: a valid snapshot and capability matrix exist.
- Trigger: a component returns a result or error.
- Observable result: only the coordinator advances lifecycle state; components
  return typed records and cannot mutate snapshots, baselines, outcomes, or
  artifact paths directly. The coordinator stores ordering and provenance.
- Acceptance: `AC-1707`
- Verification: `TEST-1707`
- Implementation slice: `IS-1703`

#### REQ-1708 — Deterministic errors, retries, and outcome reporting

- Level: `MUST`
- Source: `RELIABILITY_POLICY`
- Actors: coordinator and operator
- Preconditions: a case has a valid snapshot.
- Trigger: an action times out, fails, or returns an unexpected result.
- Observable result: the exact closed error code is persisted; each API/browser
  case has at most two attempts, with one retry, and no hidden retry occurs for
  screenshot, review, or comparison. A terminal outcome is emitted exactly
  once and includes pass/fail/blocked reason, case IDs, artifact hashes, and
  snapshot identity.
- Acceptance: `AC-1708`
- Verification: `TEST-1708`
- Implementation slice: `IS-1703`

### OBJ-1705 — API and browser contracts

#### REQ-1709 — Literal local API contract

- Level: `MUST`
- Source: `INTERFACE_CONTRACT`
- Actors: API client and local server
- Preconditions: `server` and `api` capabilities are available and the server
  origin is recorded in the snapshot.
- Trigger: an API case begins.
- Observable result: the client sends only the snapshot's literal method, path,
  query, allowlisted headers, and body; paths are relative to the recorded
  local origin and reject traversal, redirects to another origin, shell
  interpretation, and undeclared headers. The case records status, bounded
  redacted headers/body digest, response schema result, elapsed time, and exact
  expected status/content type.
- Acceptance: `AC-1709`
- Verification: `TEST-1709`
- Implementation slice: `IS-1705`

#### REQ-1710 — Reproducible browser contract

- Level: `MUST`
- Source: `INTERFACE_CONTRACT`
- Actors: browser runner and local server
- Preconditions: `browser` capability is available and the browser version,
  context, viewport, URL, readiness condition, and action list are snapshotted.
- Trigger: a browser case begins.
- Observable result: a fresh isolated browser context uses Chromium, DPR `1`,
  locale `en-US`, timezone `UTC`, light color scheme, and
  `no-preference` reduced motion. It navigates only to the recorded local
  origin, waits for the declared readiness condition without unbounded sleeps,
  executes the ordered declared actions, and records console/page errors and
  navigation outcome.
- Acceptance: `AC-1710`
- Verification: `TEST-1710`
- Implementation slice: `IS-1705`

### OBJ-1706 — Visual artifacts, image review, and comparison

#### REQ-1711 — Controlled screenshot capture

- Level: `MUST`
- Source: `VISUAL_CONTRACT`
- Actors: browser runner, screenshot capturer, artifact store
- Preconditions: the browser case is ready and the screenshot capability is
  available.
- Trigger: the declared readiness condition is satisfied.
- Observable result: a PNG is captured at exactly `1440x900` and, when the
  secondary viewport is required by the scenario, exactly `1280x720`; the
  capture uses DPR `1`, full declared page bounds, no browser chrome, and no
  post-capture resizing. The artifact path, dimensions, byte size, SHA-256,
  source fingerprint, and snapshot ID are persisted.
- Acceptance: `AC-1711`
- Verification: `TEST-1711`
- Implementation slice: `IS-1706`

#### REQ-1712 — Image-review contract and capability gating

- Level: `MUST`
- Source: `VISUAL_CONTRACT`
- Actors: image-review capability, reviewer, coordinator
- Preconditions: a valid screenshot artifact exists and `image_review` is
  available with a recorded version and model/reviewer identity.
- Trigger: a screenshot is ready for review.
- Observable result: review checks dimensions, clipping, missing/extra UI,
  text legibility, obvious layout shifts, and privacy leakage; it returns only
  `approved`, `rejected`, or `blocked` with bounded observations and the input
  artifact hash. If the capability is unavailable, the result is
  `BLOCKED_CAPABILITY`, never an inferred approval.
- Acceptance: `AC-1712`
- Verification: `TEST-1712`
- Implementation slice: `IS-1706`

#### REQ-1713 — Immutable baseline and measurable comparison

- Level: `MUST`
- Source: `VISUAL_CONTRACT`
- Actors: comparison engine, reviewer, coordinator
- Preconditions: the baseline is approved, content-addressed, captured under
  the same scenario, browser context, viewport, DPR, and source-compatible
  snapshot, and the comparison capability is available.
- Trigger: a candidate screenshot is ready.
- Observable result: the engine compares equal-dimension PNGs and persists
  `pixel_diff_fraction`, `max_channel_delta`, and a deterministic diff image.
  Comparison passes only when `pixel_diff_fraction <= 0.005`,
  `max_channel_delta <= 8`, the image review is `approved`, and no declared
  critical region differs. A candidate with a missing or incompatible baseline
  returns `BASELINE_NOT_APPROVED` or `INVALID`; it never creates or overwrites
  a baseline automatically.
- Acceptance: `AC-1713`
- Verification: `TEST-1713`
- Implementation slice: `IS-1706`

### OBJ-1707 — Capability, server, security, privacy, and operations

#### REQ-1714 — Capability matrix is a hard gate

- Level: `MUST`
- Source: `SAFETY_POLICY`
- Actors: coordinator and operator
- Preconditions: the run snapshot declares required capabilities.
- Trigger: capability discovery completes or a required capability later
  becomes unavailable.
- Observable result: each required capability has `available` or `unavailable`,
  version, check time, and bounded diagnostic. Any unavailable required
  capability prevents dependent execution and yields `BLOCKED_CAPABILITY`;
  there is no silent browser-to-API, screenshot-to-text, image-review-to-pixel,
  or comparator-to-review substitution.
- Acceptance: `AC-1714`
- Verification: `TEST-1714`
- Implementation slice: `IS-1704`

#### REQ-1715 — Local server and development-server constraints

- Level: `MUST`
- Source: `OPERATING_CONSTRAINT`
- Actors: coordinator and local server
- Preconditions: a local server is required by the scenario.
- Trigger: server startup or readiness probing begins.
- Observable result: the server binds `0.0.0.0`, uses port `10001` or the next
  available port at or above it, advertises `http://dev:<port>`, and records
  the actual command as literal argv. Port `3000`, Docker, infrastructure
  mutation, remote service use, and unregistered server processes are rejected.
  Readiness has a bounded 30,000 ms timeout and a declared HTTP/status
  condition.
- Acceptance: `AC-1715`
- Verification: `TEST-1715`
- Implementation slice: `IS-1704`

#### REQ-1716 — Security, privacy, compatibility, and operations controls

- Level: `MUST`
- Source: `SECURITY_POLICY`
- Actors: coordinator, operator, artifact store, and all runners
- Preconditions: the run is authorized for local verification.
- Trigger: any command, request, log, artifact, approval, retry, or cleanup.
- Observable result: network access is limited to the recorded local origin;
  secrets, tokens, cookies, authorization headers, personal data, raw model
  reasoning, and unrestricted command output are redacted or rejected. Every
  command uses literal argv in the registered worktree or artifact root. A
  remote, destructive, permission, credential, deployment, or file-change
  action stays `waiting_user` with its opaque approval ID. The report includes
  runtime/browser/API versions, UTC timestamps, timeout and retry counters,
  and enough evidence to reproduce the result.
- Acceptance: `AC-1716`
- Verification: `TEST-1716`
- Implementation slice: `IS-1704`

### OBJ-1708 — Rollout, rollback, and migration

#### REQ-1717 — Guarded rollout and compatibility versioning

- Level: `MUST`
- Source: `OPERATIONS_POLICY`
- Actors: implementation PL, coordinator, and operator
- Preconditions: implementation slices `IS-1701` through `IS-1706` have passed
  their focused checks.
- Trigger: the verification contract is enabled for a project.
- Observable result: enablement is behind the versioned `verification_contract_v1`
  capability/configuration; a run announces its schema and package fingerprint
  before execution. Existing runs retain their snapshots and are not silently
  reinterpreted by a newer contract.
- Acceptance: `AC-1717`
- Verification: `TEST-1717`
- Implementation slice: `IS-1707`

#### REQ-1718 — Safe rollback and no destructive migration

- Level: `MUST`
- Source: `OPERATIONS_POLICY`
- Actors: operator and coordinator
- Preconditions: a run or artifact exists under version 1.
- Trigger: rollout is disabled, a contract mismatch is found, or recovery is
  requested.
- Observable result: rollback disables new verification starts, preserves
  source identity, snapshots, baselines, candidate artifacts, diff images,
  review records, and redacted logs, and returns resumable runs as
  `SPEC_DRIFT` or `BLOCKED_ENVIRONMENT`. No database migration, baseline
  deletion, branch deletion, broad cleanup, or in-place schema rewrite is
  performed by this slice.
- Acceptance: `AC-1718`
- Verification: `TEST-1718`
- Implementation slice: `IS-1707`

### OBJ-1709 — Bootstrap, ordered implementation, and handoff

#### REQ-1719 — Reproducible bootstrap scenario

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: coordinator, local server, API client, browser runner, reviewer, and
  comparison engine
- Preconditions: a clean source snapshot, an approved package fingerprint, a
  registered artifact root, and all required capabilities are available.
- Trigger: `BOOTSTRAP-1701` is requested.
- Observable result: the future implementation performs this exact order:
  (1) validate source and package identity; (2) create the immutable run
  snapshot; (3) discover and persist capabilities; (4) start or attach only to
  the registered local server on `dev` and port `10001` or the recorded next
  port; (5) probe `GET /` at the recorded local origin and require HTTP `200`;
  (6) create a fresh browser context, navigate to the same origin, and require
  the declared readiness condition; (7) capture the primary `1440x900`
  screenshot and required secondary `1280x720` screenshot; (8) run image review;
  (9) compare with the approved baseline; and (10) persist one terminal
  outcome and handoff report. Any failed precondition stops at its stage with
  the corresponding closed outcome.
- Acceptance: `AC-1719`
- Verification: `TEST-1719`
- Implementation slice: `IS-1707`

#### REQ-1720 — Ordered implementation slices and package handoff

- Level: `MUST`
- Source: `SDD_PACKAGE`
- Actors: owning PL, implementation workers, integration PL, and PM
- Preconditions: this document is `SPEC_APPROVED` and all acceptance-relevant
  fields are closed.
- Trigger: implementation is assigned.
- Observable result: work is performed in order, with no later slice starting
  before its dependency is accepted:
  `IS-1701` schemas/source snapshot → `IS-1702` artifact and baseline controls
  → `IS-1703` coordinator/lifecycle → `IS-1704` server and capability gates
  → `IS-1705` API/browser runners → `IS-1706` screenshot/review/comparison →
  `IS-1707` outcomes/bootstrap/operations. Each slice reports its exact
  `REQ-17xx`/`AC-17xx`/`TEST-17xx` coverage and artifact hashes. The handoff
  remains `SPEC_APPROVED` until implementation and verification independently
  establish a later terminal implementation status.
- Acceptance: `AC-1720`
- Verification: `TEST-1720`
- Implementation slice: `IS-1707`

## Acceptance criteria

### AC-1701 — Source capture is authoritative and clean

The package record names `origin/main`, `refs/heads/main`, commit
`50531832a57e3fd0dae093b7ad0b51197e668045`, tree fingerprint
`de77e16a2c257456721bd44fc260f6b90afd2af6`, authority date 2026-07-26 UTC,
descriptive main label, and `GIT_CLEAN`. The status inventory is empty at
capture and the intended `docs/slices/SLICE-017.md` addition is the only owned
post-capture path.

### AC-1702 — Drift and references fail closed

Changing the Git commit, tree, ref/label, clean-state assertion, package
fingerprint, scenario, or baseline identity before execution produces
`SPEC_DRIFT` or `PACKAGE_FINGERPRINT_MISMATCH` and performs no dependent check.
No source outside `Reference boundary: NONE` is consulted.

### AC-1703 — Lifecycle and outcomes are closed

Valid transitions follow the listed lifecycle exactly. Invalid or replayed
transitions leave state unchanged. The only terminal outcomes are `PASS`,
`FAIL`, `BLOCKED_CAPABILITY`, `BLOCKED_ENVIRONMENT`, `SPEC_DRIFT`, and
`INVALID`, each with its required evidence or redacted diagnostic.

### AC-1704 — Records are linked and versioned

Every snapshot, request, browser event, screenshot, review, comparison,
artifact, error, and terminal report has schema version 1, non-empty IDs,
timestamps, source fingerprint, and explicit links. Unknown or blank
acceptance-relevant fields are rejected.

### AC-1705 — Run configuration cannot drift

The complete configuration/run snapshot is persisted before execution and is
immutable. Reopening a run uses the stored source, scenario, server, viewport,
browser, capability, API, artifact, baseline, approval, timeout, retry, and
comparison values even if project configuration later changes.

### AC-1706 — Artifacts and baselines are controlled

Traversal, symlink escape, primary-checkout output, missing hashes, empty
artifacts, and baseline overwrite are rejected. A valid artifact has the exact
registered root, type, dimensions where applicable, byte size, SHA-256, and
snapshot link; an approved baseline remains recoverable.

### AC-1707 — Component ownership is explicit

Only the coordinator mutates state and emits outcomes. Runners and reviewers
return typed, linked records and cannot change the snapshot, baseline, or
artifact root.

### AC-1708 — Failures converge deterministically

API/browser actions receive at most one retry and no hidden screenshot/review/
comparison retry. Every terminal outcome is emitted once with a bounded error,
attempt count, and evidence references; a timeout cannot remain indefinitely
active.

### AC-1709 — API calls obey the local literal contract

The API client sends only the snapshotted local method/path/query/allowlisted
headers/body, rejects traversal and cross-origin redirects, and records the
exact expected response and redacted observed response.

### AC-1710 — Browser execution is reproducible

The browser uses the snapshotted Chromium context and exact `1440x900` and
`1280x720` viewport literals where required, navigates only to the local origin,
executes declared actions in order, and records readiness, console, page-error,
and navigation evidence.

### AC-1711 — Screenshot bytes are controlled

Required screenshots are PNGs at the exact viewport and DPR values, with no
post-capture resize, a non-empty artifact, and a persisted SHA-256 and source/
run link.

### AC-1712 — Image review is gated and auditable

An unavailable image-review capability yields `BLOCKED_CAPABILITY`; it cannot
be treated as approval. An available reviewer returns `approved`, `rejected`,
or `blocked` with identity/version, input hash, bounded observations, and UTC
time.

### AC-1713 — Comparison is measurable and baseline-safe

Only compatible equal-dimension images compare. PASS requires approved image
review, no critical-region difference, `pixel_diff_fraction <= 0.005`, and
`max_channel_delta <= 8`. A candidate cannot create or overwrite a baseline.

### AC-1714 — Capability absence blocks dependent work

The persisted capability matrix gates server, API, browser, screenshot,
image-review, and comparison stages independently. No silent fallback or
unrecorded capability substitution can produce PASS.

### AC-1715 — Server constraints are enforced

The server uses `0.0.0.0`, `dev`, port `10001` or the recorded next available
port at or above it, and a declared HTTP readiness check within 30,000 ms.
Port `3000`, Docker, infrastructure, unregistered processes, and remote
services are rejected.

### AC-1716 — Safety and operational evidence are preserved

Local-only literal-argv execution, artifact-root containment, redaction,
approval gating, version reporting, UTC timing, bounded retries, and cleanup
records are present. Dangerous, remote, destructive, permission, credential,
deployment, and file-change actions remain explicit `waiting_user` decisions.

### AC-1717 — Rollout is versioned

`verification_contract_v1` is announced and snapshotted before execution;
existing runs retain their original contract and cannot be reinterpreted by a
new version.

### AC-1718 — Rollback is non-destructive

Disabling the contract preserves every snapshot, baseline, artifact, diff,
review, and log, and returns affected work as a resumable drift or environment
block. No destructive migration or in-place baseline replacement occurs.

### AC-1719 — Bootstrap order is reproducible

`BOOTSTRAP-1701` runs the ten ordered steps in `REQ-1719`, including `GET /`
HTTP 200 readiness, exact viewport literals, image review, baseline comparison,
and one terminal outcome. No step is claimed to have run in this documentation
handoff.

### AC-1720 — Handoff is complete and traceable

The ordered `IS-1701` through `IS-1707` plan is the only implementation path;
each requirement, acceptance criterion, and test has an explicit mapping. The
package remains `SPEC_APPROVED` until a later implementation loop records
actual evidence and a new terminal status.

## Verification cases

All procedures below are future checks for the implementation slices. Their
status in this documentation-only handoff is `NOT_RUN`.

### TEST-1701 — Source identity and clean capture

Read Git ref, commit, tree, and porcelain status from the selected source;
compare them with the package record and assert the exact main label, authority
date, fingerprint, and `GIT_CLEAN` state. Expected: `AC-1701`.

### TEST-1702 — Drift and reference-boundary negative cases

Run with a changed commit/tree, changed ref label, dirty status, changed
scenario, changed baseline, and a forbidden external reference. Assert that
each stops before dependent execution with `SPEC_DRIFT` or
`PACKAGE_FINGERPRINT_MISMATCH`. Expected: `AC-1702`.

### TEST-1703 — Lifecycle state machine

Exercise every valid transition, an out-of-order transition, a duplicate
terminal transition, and a replayed event. Assert exact state preservation and
closed outcomes. Expected: `AC-1703`.

### TEST-1704 — Record schema and identifier linkage

Validate serialized snapshots and all linked records against schema version 1;
try blank IDs, unknown states, missing fingerprints, and missing artifact
links. Expected: `AC-1704`.

### TEST-1705 — Snapshot immutability and reopen

Create a run snapshot, mutate source/config/scenario inputs, reopen the run,
and assert byte-equivalent effective configuration and unchanged identity.
Expected: `AC-1705`.

### TEST-1706 — Artifact-root and baseline security

Attempt traversal, symlink escape, primary-checkout output, empty output,
missing hash, and baseline overwrite; then write valid PNG, JSON, and diff
artifacts and verify root containment, SHA-256, dimensions, and retention.
Expected: `AC-1706`.

### TEST-1707 — Coordinator ownership

Use instrumented runner, reviewer, and comparison fakes that attempt direct
state, snapshot, baseline, and root mutation. Assert that only coordinator
operations persist changes and all records retain provenance. Expected:
`AC-1707`.

### TEST-1708 — Timeout and retry convergence

Make API/browser attempts timeout once and then pass, fail both attempts, and
make screenshot/review/comparison fail. Assert one retry only for API/browser,
no hidden retry elsewhere, one terminal outcome, and bounded redacted errors.
Expected: `AC-1708`.

### TEST-1709 — API contract positives and negatives

Issue the snapshotted local request and verify method/path/headers/body,
status/content type, digest, and timing. Attempt traversal, undeclared header,
cross-origin redirect, undeclared method, and shell text. Expected: `AC-1709`.

### TEST-1710 — Browser context and action order

Inspect browser context metadata, run both required viewports, verify local-only
navigation, readiness, action order, console/page-error capture, and rejection
of an undeclared action. Expected: `AC-1710`.

### TEST-1711 — Screenshot dimensions and byte integrity

Capture the bootstrap page at `1440x900` and `1280x720` with DPR `1`; inspect
PNG dimensions, byte size, hash, and path; attempt resize and wrong viewport.
Expected: `AC-1711`.

### TEST-1712 — Image-review gating and audit

Run with unavailable, available-approved, available-rejected, and
available-blocked image-review capabilities. Assert no unavailable case can
pass and every available result contains identity/version, input hash, and
bounded observations. Expected: `AC-1712`.

### TEST-1713 — Comparison thresholds and baseline immutability

Compare identical images, a candidate at each threshold boundary, a candidate
over each threshold, different dimensions, a missing baseline, and a baseline
overwrite attempt. Assert the exact threshold and immutable-baseline behavior.
Expected: `AC-1713`.

### TEST-1714 — Capability matrix hard gates

Disable each required capability independently and assert only dependent
stages are skipped, the outcome is `BLOCKED_CAPABILITY`, and no fallback result
or PASS is emitted. Expected: `AC-1714`.

### TEST-1715 — Server constraints and readiness

Start on `10001`, occupy it and start on the next available port, inspect
`0.0.0.0`/`dev`, enforce the 30,000 ms readiness bound, and reject `3000`,
Docker, remote, unregistered, or shell-interpreted launch paths. Expected:
`AC-1715`.

### TEST-1716 — Security, privacy, approval, and operations audit

Inject credentials, cookies, authorization headers, private reasoning, remote,
destructive, permission, deployment, and file-change requests. Assert redaction
or rejection, opaque `waiting_user` approvals where required, literal argv,
root containment, UTC records, and bounded cleanup. Expected: `AC-1716`.

### TEST-1717 — Versioned rollout compatibility

Enable `verification_contract_v1`, create a run, change the active contract,
reopen the run, and assert its original schema/fingerprint/snapshot remains in
force while new runs announce the new version. Expected: `AC-1717`.

### TEST-1718 — Rollback and recovery preservation

Disable the contract during planned, executing, captured, and compared states;
assert preserved snapshots, baselines, artifacts, diff images, reviews, and
logs, with no destructive migration or in-place rewrite. Expected: `AC-1718`.

### TEST-1719 — Bootstrap end-to-end procedure

From a clean source and approved baseline, execute `BOOTSTRAP-1701` with the
local server and all capabilities. Inspect the ordered event log, both literal
viewports, `GET /` HTTP 200 evidence, image-review record, comparison metrics,
artifact hashes, and exactly one terminal outcome. Expected: `AC-1719`.

### TEST-1720 — Handoff traceability and implementation ordering

Validate that each `REQ-17xx`, `AC-17xx`, and `TEST-17xx` appears exactly once
in the coverage matrix, maps to one `IS-170x`, has no blank or placeholder
field, and
that dependency order rejects a later slice before its prerequisite. Expected:
`AC-1720`.

## Coverage and closed traceability

The following table is the normative closed mapping. `Implementation slice`
means the future implementation unit; this document itself is the sole current
implementation deliverable and is not product behavior.

| Objective | Requirement | Acceptance | Verification | Implementation slice |
| --- | --- | --- | --- | --- |
| `OBJ-1701` | `REQ-1701` | `AC-1701` | `TEST-1701` | `IS-1701` |
| `OBJ-1701` | `REQ-1702` | `AC-1702` | `TEST-1702` | `IS-1701` |
| `OBJ-1702` | `REQ-1703` | `AC-1703` | `TEST-1703` | `IS-1703` |
| `OBJ-1702` | `REQ-1704` | `AC-1704` | `TEST-1704` | `IS-1701` |
| `OBJ-1703` | `REQ-1705` | `AC-1705` | `TEST-1705` | `IS-1701` |
| `OBJ-1703` | `REQ-1706` | `AC-1706` | `TEST-1706` | `IS-1702` |
| `OBJ-1704` | `REQ-1707` | `AC-1707` | `TEST-1707` | `IS-1703` |
| `OBJ-1704` | `REQ-1708` | `AC-1708` | `TEST-1708` | `IS-1703` |
| `OBJ-1705` | `REQ-1709` | `AC-1709` | `TEST-1709` | `IS-1705` |
| `OBJ-1705` | `REQ-1710` | `AC-1710` | `TEST-1710` | `IS-1705` |
| `OBJ-1706` | `REQ-1711` | `AC-1711` | `TEST-1711` | `IS-1706` |
| `OBJ-1706` | `REQ-1712` | `AC-1712` | `TEST-1712` | `IS-1706` |
| `OBJ-1706` | `REQ-1713` | `AC-1713` | `TEST-1713` | `IS-1706` |
| `OBJ-1707` | `REQ-1714` | `AC-1714` | `TEST-1714` | `IS-1704` |
| `OBJ-1707` | `REQ-1715` | `AC-1715` | `TEST-1715` | `IS-1704` |
| `OBJ-1707` | `REQ-1716` | `AC-1716` | `TEST-1716` | `IS-1704` |
| `OBJ-1708` | `REQ-1717` | `AC-1717` | `TEST-1717` | `IS-1707` |
| `OBJ-1708` | `REQ-1718` | `AC-1718` | `TEST-1718` | `IS-1707` |
| `OBJ-1709` | `REQ-1719` | `AC-1719` | `TEST-1719` | `IS-1707` |
| `OBJ-1709` | `REQ-1720` | `AC-1720` | `TEST-1720` | `IS-1707` |

Closed traceability is therefore:

```text
OBJ-17xx → REQ-17xx → AC-17xx → TEST-17xx → IS-170x → SLICE-017
```

No requirement, acceptance criterion, or test is intentionally unlinked, and
no acceptance-relevant cell is blank or a placeholder.

## Ordered implementation slices

1. `IS-1701 — Contract, source identity, and snapshot schemas`: persist the
   package/source tuple, strict drift check, schema version, run/config
   snapshot, identifiers, and closed lifecycle/outcome enums.
2. `IS-1702 — Artifact and baseline controls`: create and validate registered
   roots, content hashes, PNG metadata, immutable approved baselines, diff
   artifacts, retention, and safe cleanup records.
3. `IS-1703 — Coordinator and failure convergence`: implement sole ownership of
   state transitions, typed component results, bounded timeout/retry handling,
   and one terminal outcome.
4. `IS-1704 — Server and capability gates`: implement local server readiness,
   exact port/host constraints, capability discovery, hard gating, literal
   argv, approval routing, and redaction.
5. `IS-1705 — API/browser runners`: implement the snapshotted API request and
   browser context/action contracts with local-only navigation and evidence.
6. `IS-1706 — Screenshot, image review, and comparison`: implement both exact
   viewport captures, review result schema, threshold comparison, and
   baseline-safe behavior.
7. `IS-1707 — Bootstrap, rollout, rollback, and handoff`: implement
   `BOOTSTRAP-1701`, versioned enablement, preservation on rollback, ordered
   integration, and final reports.

Each implementation slice must run its mapped `TEST-17xx` checks, report
observable evidence and artifact hashes, and leave unrelated user work
untouched. The implementation may not add behavior not represented in this
closed contract without a spec delta.

## Configuration and run snapshot contract

The persisted v1 snapshot has these required, non-empty fields:

```text
schema_version=1
package_id=verification-spec-v1
package_status=SPEC_APPROVED
source_label=Ark Team verification source — main @ 5053183
source_ref=refs/heads/main
source_commit=50531832a57e3fd0dae093b7ad0b51197e668045
source_tree=de77e16a2c257456721bd44fc260f6b90afd2af6
reference_boundary=NONE
run_id=<opaque stable run identifier>
case_id=BOOTSTRAP-1701
scenario_version=1
artifact_root=<absolute registered per-run root>
baseline_id=<immutable approved baseline hash and snapshot link>
server_host=dev
server_bind=0.0.0.0
server_port=<10001 or recorded next available port>
api_origin=http://dev:<server_port>
primary_viewport=1440x900
secondary_viewport=1280x720
device_scale_factor=1
locale=en-US
timezone=UTC
color_scheme=light
reduced_motion=no-preference
required_capabilities=server,api,browser,screenshot,image_review,comparison
api_contract=<versioned literal request/response record>
browser_contract=<versioned literal navigation/action/readiness record>
timeouts_ms=server:30000,api:30000,browser:60000,case:120000
attempt_policy=api/browser:2-total; screenshot/review/comparison:1-total
comparison_policy=pixel_diff_fraction<=0.005;max_channel_delta<=8;critical_regions=none-or-declared
approval_policy=opaque-one-time-user-decision-for-dangerous-or-external-actions
created_at_utc=<RFC3339 timestamp>
```

`<...>` fields are runtime values with required formats, not unresolved
acceptance-relevant unknowns: run IDs are generated opaque IDs, the artifact
root and baseline are registered before execution, the port is selected by the
closed rule, and the two contract records are complete scenario inputs. A
missing value is `INVALID`, not an invitation to guess.

## API, browser, screenshot, image-review, and comparison interfaces

The API case record contains `case_id`, `method`, relative `path`, exact query
map, allowlisted request headers, request body digest, expected status, expected
content type, response schema version, timeout, and attempt number. The client
must reject path segments `..`, absolute/cross-origin URLs, undeclared headers,
redirects outside `api_origin`, shell metacharacter interpretation, and body
data that is not represented in the snapshot. It records a bounded response
digest and redacted response metadata.

The browser case record contains browser capability/version, URL relative to
`api_origin`, readiness condition, ordered actions, expected title or selector
assertions, viewport, DPR, locale, timezone, color scheme, reduced-motion mode,
timeout, and attempt number. A fresh context is required per case. Browser
console errors, page errors, failed navigations, unexpected dialogs, and
undeclared actions are recorded as failures unless the scenario explicitly
declares a bounded expected event.

The screenshot record contains PNG media type, viewport literal, DPR, pixel
dimensions, byte size, SHA-256, capture timestamp, input page/case, and artifact
path. Screenshot capture is after readiness and before comparison; no resizing,
JPEG conversion, crop, or unrecorded post-processing is allowed.

The image-review record contains reviewer capability identity and version,
input artifact hash, review checklist version, `approved`/`rejected`/`blocked`,
bounded observations, and timestamp. Review cannot alter the input image or
baseline. An unavailable reviewer is a hard capability block.

The comparison record contains baseline ID/hash, candidate ID/hash, exact
dimensions, `pixel_diff_fraction`, `max_channel_delta`, critical-region result,
review result, comparator version, and generated diff-artifact hash. It is
`PASS` only under `REQ-1713`; otherwise it is `FAIL`, `BLOCKED_CAPABILITY`, or
`INVALID` with the relevant reason.

## Approval, artifact, baseline, server, and privacy controls

The artifact root is registered before any write and must be outside the
primary checkout, owned by the current run, and validated by normalized
component-boundary and symlink checks. The baseline root is separate and
read-only after approval. Cleanup may remove only registered clean run roots
after the final report and must preserve the manifest, hashes, and audit record;
it may not remove a baseline or any user path.

Routine local preparation and tests remain subject to the repository's existing
managed-session policy. Any command or action that is remote, destructive,
credential-bearing, permission-changing, deployment-related, or outside the
registered worktree/artifact root stays in `waiting_user` with its opaque
request ID. No session-wide approval is allowed. Every automatically resolved
routine decision, if applicable to a future implementation, records the exact
one-time decision and `routine_policy` source without command output or private
reasoning.

The local server is the only permitted network target. API and browser evidence
must include origin, method/path or URL, timestamp, status, and redacted
metadata. Secrets are rejected from scenario configuration and redacted from
headers, bodies, logs, screenshots, review observations, and error messages.

## Rollout, rollback, migration, and operations

Rollout is additive and version-gated as `verification_contract_v1`. The
implementation first enables schema/source/artifact checks, then capability and
server gates, then API/browser execution, then visual review/comparison, and
finally bootstrap orchestration. Each stage must pass its mapped tests before
the next stage is enabled.

There is no database migration in this slice. Persisted v1 records are
append-only for evidence and immutable for snapshots/baselines. A future schema
must use a new version and an explicit conversion contract; an unsupported
version returns `INVALID` and is not guessed or rewritten. Rollback disables
new starts, leaves existing records and artifacts readable, and preserves every
baseline and diff. Recovery resumes only from the recorded state after source
and capability revalidation.

Operational reports include run ID, package/source fingerprint, scenario,
outcome, stage, timestamps in UTC, server/browser/API versions, capability
matrix, attempt counts, artifact and baseline hashes, redacted errors,
approval source, and cleanup state. They do not include raw reasoning,
credentials, unrestricted command output, or unbounded response bodies.

## Bootstrap and package handoff

`BOOTSTRAP-1701` is the sole smoke scenario in this handoff. Its fixed inputs
are the source/package identity above, `GET /` with expected HTTP `200`, local
origin `http://dev:<recorded-port>`, primary viewport `1440x900`, secondary
viewport `1280x720`, DPR `1`, UTC/en-US/light/no-preference browser context,
registered artifact root, approved immutable baseline, and the required
capability set. The scenario's output is one persisted terminal outcome and a
report that links every check and artifact. It has no external dependency and
does not authorize remote, destructive, Docker, infrastructure, or deployment
actions.

Package handoff:

- Consumer: owning implementation PL, then integration PL and PM.
- Current status: `SPEC_APPROVED`.
- Current deliverable: exactly `docs/slices/SLICE-017.md`; no product behavior
  is implemented by this slice.
- Implementation order: `IS-1701` through `IS-1707` in the ordered list above.
- Acceptance gate: all `AC-1701` through `AC-1720` and their mapped
  `TEST-1701` through `TEST-1720` must have observable evidence before a later
  implementation loop can report an implementation terminal status.
- Source-drift gate: recheck the commit/tree/clean state and package
  fingerprint before each implementation stage; route differences as a spec
  delta.
- Handoff report: return changed paths, commit SHA, exact artifact hashes,
  `REQ → AC → TEST` evidence, outcome, residual risks, and rollback state. Do
  not report a future test as run when it is not present in the evidence.
- Current verification statement: content-only audit is the only verification
  performed for this documentation handoff. No product tests, builds,
  generators, Docker, servers, live browser/API scenarios, screenshot capture,
  image review, or comparison execution is claimed.

## Baseline and slice result

- Target: `/home/elicie/.codex/team-orchestrator/runs/.worktrees/ark-20260726t075628z-af8de8/verification-spec`
- Recorded at: 2026-07-26 UTC.
- Method: `GIT_CLEAN` at capture.
- `TARGET_BASELINE_ID`: `GIT:50531832a57e3fd0dae093b7ad0b51197e668045:TREE:de77e16a2c257456721bd44fc260f6b90afd2af6`.
- Existing modified/untracked artifacts at capture: none.
- Existing validation failures at capture: none observed in the read-only
  source inspection; product tests were not run for this documentation-only
  assignment.
- Relevant commands confirmed: `git rev-parse HEAD`, `git rev-parse HEAD^{tree}`,
  `git status --porcelain=v1`, and content inspection of adjacent slice docs.
- Environmental limits: no Docker, infrastructure, development server,
  product build/test, generator, API, browser, screenshot, image-review,
  comparison, external network, or remote Git action.

Slice result:

- Status: `SPEC_APPROVED`.
- Changed artifact: exactly `docs/slices/SLICE-017.md`.
- Verification summary: content-only self-audit required by the assignment;
  `TEST-1701` through `TEST-1720` are specified and `NOT_RUN`.
- Security/NFR summary: closed controls cover source drift, capabilities,
  artifact roots, baselines, approvals, ports, privacy, reliability,
  compatibility, rollout, rollback, and operations.
- Warnings and unverified areas: all future product behavior and runtime
  verification remain unverified by design; no unsupported implementation claim
  is made.
- Rollback/recovery: remove or supersede only this documentation contract via
  an explicit spec delta; future implementation rollback follows `REQ-1718`
  and preserves evidence.
- Recommended next action: owning PL independently review this file, then
  authorize the ordered implementation slices only if the package remains
  `SPEC_APPROVED` and the source fingerprint is unchanged.
