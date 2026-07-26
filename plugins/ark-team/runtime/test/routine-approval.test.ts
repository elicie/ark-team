import assert from "node:assert/strict";
import { test } from "node:test";

import type { PendingApproval } from "../src/approval-session.js";
import { isRoutineCommandApproval } from "../src/routine-approval.js";

const worktree = "/tmp/ark-team-state/worktrees/run/team-a";
const integrationWorktree = "/tmp/ark-team-state/worktrees/run/integration";
const teams = [
  {
    team_id: "team-a",
    owned_paths: ["src/slugify.ts", "test/slugify.test.ts"],
    branch: "ark-team/run/team-a",
  },
];

test("TEST-1603 accepts only bounded routine Git and npm commands", () => {
  const workerAssignment = {
    role: "worker" as const,
    team_id: "team-a",
    working_directory: worktree,
  };
  for (const command of [
    "/usr/bin/zsh -lc 'npm ci'",
    "/usr/bin/zsh -lc 'npm test'",
    "/usr/bin/zsh -lc 'npm run test:unit'",
  ]) {
    assert.equal(
      isRoutineCommandApproval({
        assignment: workerAssignment,
        approval: commandApproval(command, worktree),
        teams,
      }),
      true,
      command,
    );
  }

  const plAssignment = {
    role: "pl" as const,
    team_id: "team-a",
    working_directory: worktree,
  };
  for (const command of [
    "/usr/bin/zsh -lc 'git add src/slugify.ts test/slugify.test.ts'",
    "/usr/bin/zsh -lc 'git add -- src/slugify.ts test/slugify.test.ts && git commit -m \"Implement slugify\"'",
    "/usr/bin/zsh -lc 'git commit -m \"Implement slugify\"'",
  ]) {
    assert.equal(
      isRoutineCommandApproval({
        assignment: plAssignment,
        approval: commandApproval(command, worktree),
        teams,
      }),
      true,
      command,
    );
  }

  assert.equal(
    isRoutineCommandApproval({
      assignment: {
        role: "integration_pl",
        team_id: "integration",
        working_directory: integrationWorktree,
      },
      approval: commandApproval(
        "/usr/bin/zsh -lc \"git merge --no-ff ark-team/run/team-a -m 'Merge team-a' && npm test\"",
        integrationWorktree,
      ),
      teams,
    }),
    true,
  );
});

test("TEST-1604 rejects dangerous, broad, composed, and misplaced approvals", () => {
  const assignment = {
    role: "worker" as const,
    team_id: "team-a",
    working_directory: worktree,
  };
  for (const command of [
    "/usr/bin/zsh -lc 'git add src/slugify.ts test/slugify.test.ts'",
    "/usr/bin/zsh -lc 'git commit -m \"Implement slugify\"'",
    "/usr/bin/zsh -lc 'git push origin main'",
    "/usr/bin/zsh -lc 'git reset --hard HEAD~1'",
    "/usr/bin/zsh -lc 'git clean -fd'",
    "/usr/bin/zsh -lc 'git add .'",
    "/usr/bin/zsh -lc 'git add ../outside.txt'",
    "/usr/bin/zsh -lc 'git add package.json'",
    "/usr/bin/zsh -lc 'npm test && git push'",
    "/usr/bin/zsh -lc 'npm test & git commit -m \"unsafe\"'",
    "/usr/bin/zsh -lc 'npm test && npm test && npm test && npm test && npm test'",
    "/usr/bin/zsh -lc 'npm publish'",
  ]) {
    assert.equal(
      isRoutineCommandApproval({
        assignment,
        approval: commandApproval(command, worktree),
        teams,
      }),
      false,
      command,
    );
  }
  assert.equal(
    isRoutineCommandApproval({
      assignment,
      approval: commandApproval("/usr/bin/zsh -lc 'npm test'", "/tmp/other"),
      teams,
    }),
    false,
  );
  assert.equal(
    isRoutineCommandApproval({
      assignment,
      approval: {
        approval_id: "11111111-1111-4111-8111-111111111111",
        kind: "permissions",
        reason: "network",
        cwd: worktree,
        requested_permissions: { network: true },
      },
      teams,
    }),
    false,
  );
  assert.equal(
    isRoutineCommandApproval({
      assignment: {
        role: "integration_pl",
        team_id: "integration",
        working_directory: integrationWorktree,
      },
      approval: commandApproval(
        "/usr/bin/zsh -lc 'git merge --no-ff unknown/team'",
        integrationWorktree,
      ),
      teams,
    }),
    false,
  );
});

function commandApproval(command: string, cwd: string): PendingApproval {
  return {
    approval_id: "11111111-1111-4111-8111-111111111111",
    kind: "command",
    reason: "routine command",
    command,
    cwd,
  };
}
