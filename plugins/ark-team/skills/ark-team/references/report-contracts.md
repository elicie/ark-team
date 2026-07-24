# Ark Team Report Contracts

## Contents

1. Worker report
2. PL report
3. PM start report
4. PM status report
5. PM final report
6. Event-log fields

## Worker report

Require:

```text
Assignment:
Status: completed | blocked | failed
Result:
Files or artifacts:
Local commit:
Verification performed:
Verification result:
Known risks:
Blockers or follow-up:
```

Reject a `completed` report that lacks evidence appropriate to the task.

## PL report

Require:

```text
Team:
Mission:
Status: completed | blocked | failed
Worker outcomes:
Integrated result:
Acceptance criteria:
Verification evidence:
Commits or artifacts:
Dependencies resolved:
Remaining risks:
Decision needed from PM:
```

Require the PL to distinguish observed evidence from inference.

## PM start report

Keep it concise:

```text
Run:
Objective:
Teams:
Dependencies:
Execution mode: managed | native fallback
Isolation mode:
Important constraints:
```

Inform the user; do not request approval unless the plan contains a dangerous action.

## PM status report

Report only milestones or blocked states in chat:

```text
Run:
Overall state:
Completed teams:
Active teams:
Blocked teams:
Approval or decision needed:
```

Keep detailed worker progress in the status surface or event log.

## PM final report

Use the user's language and this order:

```text
Result summary
Acceptance criteria and outcome
Team results
Changed files and integration commit
Tests and verification evidence
Approvals or decisions still required
Remaining risks and follow-up work
Run ID and log location
```

Never claim success when required verification did not run or failed.

## Event-log fields

Record events with enough structure to reconstruct progress:

```text
timestamp
run_id
team_id
agent_id
agent_role
state
assignment
event_type
observable_result
worktree
branch
commit
verification
retry_count
usage
```

Redact secrets. Do not include private chain-of-thought.
