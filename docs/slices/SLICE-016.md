# Closed Contract — SLICE-016

- Spec identity: User-approved approval-policy delta on 2026-07-26, live run
  `ark-20260725t060604z-4df971`, and accepted SLICE-015 at Git revision
  `bf1881c`.
- Status: APPROVED
- Objective: Make Codex app-server 0.145 writer sessions and recovery reliable,
  and complete routine local Git and test work without repeatedly interrupting
  the user while preserving explicit approval for dangerous or external
  actions.
- Evidence inventory:
  - `USER_REQUIREMENT`: Local `git add`, `git commit`, and `npm test` must
    proceed without asking; the same policy applies to equivalent routine
    local integration and test preparation.
  - `RUNTIME_OBSERVATION`: app-server 0.145 reports the assigned worktree in
    `runtimeWorkspaceRoots` while `sandbox.writableRoots` may be empty.
  - `RUNTIME_OBSERVATION`: `thread/resume` can replay prior-turn token usage
    before the new `turn/start` response.
  - `RUNTIME_OBSERVATION`: routine `npm ci`, `npm test`, local staging,
    commit, and recorded-branch merge surfaced command approvals during the
    successful live hierarchy.
  - `TEST`: the final post-change live run used Sol PM, Terra PL/integration
    PL, Luna worker, local commit
    `62235256dd8fb5f13a2e2c0bb94edf253397721d`, integration commit
    `d5ebf288c26309a7dae9c13592fd8fb13d817965`, 5 passing fixture tests, two
    `routine_policy` approvals, zero user approvals, PM acceptance, and
    verified worktree cleanup.
- Reference boundary: `NONE`.

## Requirements

### REQ-1601 — Current app-server workspace-root compatibility

- Level: MUST
- Source: FACT
- Actors: managed PL, worker, and integration PL sessions
- Preconditions: app-server returns the exact assigned worktree as either a
  sandbox writable root or a runtime workspace root.
- Trigger: the controller starts or resumes a writer thread.
- Observable result: the thread is accepted only when at least one returned
  root source contains the exact assigned worktree; missing evidence still
  fails closed.
- Acceptance: AC-1601
- Verification: TEST-1601

### REQ-1602 — Safe prior-turn replay handling

- Level: MUST
- Source: FACT
- Actors: resumed managed writer sessions
- Preconditions: app-server replays a turn-scoped notification before the new
  turn ID is known.
- Trigger: `thread/resume` followed by `turn/start`.
- Observable result: the controller buffers a bounded number of pre-start
  messages, ignores only identified prior-turn replay during resume, processes
  a buffered message for the new turn, and continues to reject mismatched
  messages after the active turn is established.
- Acceptance: AC-1602
- Verification: TEST-1602

### REQ-1603 — Routine local command approval

- Level: MUST
- Source: USER_REQUIREMENT
- Actors: managed PL, worker, integration PL, controller
- Preconditions: an app-server command approval belongs to the assignment's
  exact registered managed worktree and matches one controller-validated
  routine command:
  - lockfile-pinned local preparation: `npm ci`;
  - local tests: `npm test` or a bounded `npm run test[:name]`;
  - `git add` containing only the team's recorded owned paths;
  - `git commit -m` with a bounded inert message; or
  - integration-PL `git merge` of one exact recorded team branch with only
    the supported local merge flags and inert message.
- A request may join at most four individually qualifying commands with exact
  ` && ` separators. Every component must independently pass the same role,
  worktree, path, and branch checks.
- Trigger: the routine command approval is surfaced.
- Observable result: the controller persists the request, delivers exactly one
  `approve_once`, records its routine-policy origin, and continues the same
  turn without returning `waiting_user` to the caller.
- Exclusions: approval-for-session, any other shell composition, unregistered
  directories, path traversal, broad staging, package publish, and remote Git.
- Acceptance: AC-1603
- Verification: TEST-1603

### REQ-1604 — Dangerous-action boundary remains explicit

- Level: MUST
- Source: DECISION
- Actors: controller and user
- Trigger: an approval is not exactly classified by REQ-1603.
- Observable result: the assignment remains `waiting_user` with its opaque
  request ID. In particular, push, pull-request work, remote merge, deploy,
  reset, clean, checkout-based overwrite, branch deletion, file-change
  approval, permission expansion, arbitrary shell syntax, and commands outside
  the registered worktree are never automatically approved.
- Acceptance: AC-1604
- Verification: TEST-1604

### REQ-1605 — Observable automatic-decision audit

- Level: MUST
- Source: DECISION
- Actors: PM, controller, operator
- Trigger: REQ-1603 resolves a routine request.
- Observable result: run events record the exact approval ID, one-time
  decision, and `routine_policy` source without command output, credentials,
  or private reasoning.
- Acceptance: AC-1605
- Verification: TEST-1605

### REQ-1606 — Timeout and failure convergence

- Level: MUST
- Source: RUNTIME_OBSERVATION
- Actors: scheduler and controller
- Trigger: a persisted approval still exists but the live approval session has
  already timed out or otherwise reports that no request is pending.
- Observable result: the scheduler records a managed-session failure and lets
  the configured retry/recovery policy proceed; it does not leave a knowingly
  dead live session indefinitely represented as approvable.
- Acceptance: AC-1606
- Verification: TEST-1606

### REQ-1607 — Full live hierarchy remains valid

- Level: MUST
- Source: USER_REQUIREMENT
- Actors: Sol PM, Terra PL/integration PL, Luna worker
- Trigger: a writing objective is executed in a clean Git repository with no
  remote action requested.
- Observable result: planning, worker execution, PL verification, local
  integration, PM review, local target-branch update, usage logging, and
  verified worktree cleanup complete without routine Git/test prompts.
- Acceptance: AC-1607
- Verification: TEST-1607

## Acceptance and verification

### AC-1601

Given an exact assigned linked worktree, when app-server returns it only in
`runtimeWorkspaceRoots`, the session starts; when neither root source includes
it, startup fails with a protocol error.

### AC-1602

Given a resumed thread with replayed old usage, when the new turn starts, the
old usage is ignored and the new turn can finish; a mismatched notification
after start still fails closed.

### AC-1603

Given each allowlisted routine command in the exact assignment worktree, when
the session surfaces a command approval, it receives one `approve_once` and
the assignment continues without a user decision.

### AC-1604

Given near-miss, dangerous, remote, composed-shell, wrong-path, permission, or
file-change requests, no automatic decision is sent and the opaque approval is
returned in `waiting_user`.

### AC-1605

Given an automatic routine decision, logs distinguish `routine_policy` from a
user decision and contain no private reasoning or unrestricted command output.

### AC-1606

Given an expired live request with matching persisted state, an attempted
delivery transitions the assignment to a retryable failure instead of leaving
the stale request as a usable live approval.

### AC-1607

Given the live title-normalizer fixture, the completed record shows the exact
models and xhigh effort, passing tests, accepted local integration, no remote
action, preserved branches, removed registered worktrees, routine approvals,
and zero user approval decisions.

### TEST-1601

- Level: unit and live protocol
- Procedure: exercise both root response shapes and the empty-root negative
  case.
- Expected: AC-1601.

### TEST-1602

- Level: unit and live protocol
- Procedure: replay old usage before `turn/start`, then emit current and
  mismatched active-turn events.
- Expected: AC-1602.

### TEST-1603

- Level: unit and scheduler integration
- Procedure: pass exact routine approvals through a scripted session and
  registered team/integration context.
- Expected: AC-1603.

### TEST-1604

- Level: security unit
- Procedure: enumerate push/reset/clean, broad add, unknown branch, wrong cwd,
  shell composition, file-change, and permission requests.
- Expected: AC-1604.

### TEST-1605

- Level: persistence integration
- Procedure: reopen the run after an automatic decision and inspect events.
- Expected: AC-1605.

### TEST-1606

- Level: scheduler unit
- Procedure: let a live session invalidate its pending request before delivery.
- Expected: AC-1606.

### TEST-1607

- Level: live end-to-end
- Evidence: run `ark-20260726t051859z-967bc7`; worker
  `62235256dd8fb5f13a2e2c0bb94edf253397721d`; integration
  `d5ebf288c26309a7dae9c13592fd8fb13d817965`; 5/5 tests; two routine-policy
  approvals; zero user approvals; final state `completed`.
- Expected: AC-1607.

## Slice and traceability

### SLICE-016 — Reliable routine-command managed execution

- Status: ACCEPTED
- Includes: REQ-1601 through REQ-1607

## Acceptance evidence

| Requirement | Evidence | Result |
| --- | --- | --- |
| REQ-1601 | `TEST-607`; Codex 0.145.0 schema verification across 16 files and 62 protocol tokens | PASS |
| REQ-1602 | `TEST-608` covers bounded pre-turn buffering, prior-turn replay, and active-turn mismatch rejection | PASS |
| REQ-1603 | `TEST-1603` classifier and scheduler integration cover one-time routine approval and same-turn continuation | PASS |
| REQ-1604 | `TEST-1604` rejects remote, destructive, broad, composed, misplaced, permission, and unknown-branch requests | PASS |
| REQ-1605 | `TEST-1605` reopens persisted events and distinguishes `routine_policy` from `user` | PASS |
| REQ-1606 | `TEST-1606` converts an expired live request into `AGENT_SESSION_FAILED` with no stale pending approval | PASS |
| REQ-1607 | Live run `ark-20260726t051859z-967bc7`, commits `62235256dd8fb5f13a2e2c0bb94edf253397721d` and `d5ebf288c26309a7dae9c13592fd8fb13d817965`, 5/5 fixture tests, two routine-policy approvals, zero user approvals, PM acceptance, local merge, cleaned worktrees, preserved branches, and no remote action | PASS |

Repository verification on 2026-07-26 completed with 79 unit tests, 1 built
CLI test, 5 MCP tests, TypeScript checking, production bundle generation,
skill validation, plugin validation, model-profile verification, and
`npm audit --omit=dev` with zero reported vulnerabilities.

The final live run recorded usage-only events totaling 212,242 input tokens
(142,080 cached), 7,160 output tokens, and 2,689 reasoning-output tokens. No
raw model reasoning or unrestricted command output was persisted.

Terminal implementation-loop status: `SLICE_ACCEPTED`.
- Acceptance: AC-1601 through AC-1607
- Verification: TEST-1601 through TEST-1607
- Dependencies: accepted SLICE-015, Codex app-server 0.145, linked Git
  worktrees, existing approval persistence and recovery.
- Excludes: automatic remote actions, arbitrary project shell commands,
  non-Git shadow repositories, external-model adapters, and dashboard work.
- Rollback: disable routine classification and retain ordinary `waiting_user`;
  compatibility parsing may be reverted independently if the app-server
  response contract changes.
- Completion rule: all deterministic tests, live protocol checks, plugin
  validation, installed-cache verification, and the recorded live E2E evidence
  pass while dangerous negative cases remain blocked.

Traceability:

```text
routine managed execution
  → REQ-1601..REQ-1607
  → AC-1601..AC-1607
  → TEST-1601..TEST-1607
  → SLICE-016
```

## Baseline

- Target: `/home/elicie/Dev/arc`
- Recorded at: 2026-07-26 UTC
- Method: `GIT_DIRTY`
- Git revision: `bf1881ce69890ad9adf143ade18e3ae118f53db7`
- Existing slice changes before this contract:
  `approval-session.ts`, its unit tests, and rebuilt runtime bundles for
  app-server 0.145 root/replay compatibility.
- Existing temporary live-diagnostic artifacts: untracked
  `.ark-team-*.ts`/`.mjs` files; these are not product deliverables.
- Existing validation failures: none in the compatibility-focused typecheck
  and tests; the earlier full suite passed before the replay patch.
- Environmental limits: no Docker or infrastructure action; no fixture
  push/PR/deploy. The authorized paid live E2E is recorded above.
