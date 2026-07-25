import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ManagedAssignmentScheduler } from "../src/assignment-scheduler.js";
import { ArkTeamError } from "../src/errors.js";
import {
  DEFAULT_PROJECT_CONFIG,
  loadProjectConfig,
  resolveVerificationCommands,
} from "../src/project-config.js";
import { RunStore } from "../src/state-store.js";
import { TeamCoordinator } from "../src/team-coordinator.js";

test("TEST-1401 resolves defaults and normalizes one valid project snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-config-"));
  try {
    const missing = await loadProjectConfig(root);
    assert.equal(missing.source_path, null);
    assert.deepEqual(missing.config, DEFAULT_PROJECT_CONFIG);

    await mkdir(path.join(root, ".codex"), { recursive: true });
    await mkdir(path.join(root, "packages", "app"), { recursive: true });
    await writeFile(
      path.join(root, ".codex", "team-orchestrator.toml"),
      [
        "version = 1",
        "",
        "[organization]",
        "max_teams = 2",
        "min_workers_per_team = 2",
        "max_workers_per_team = 3",
        "",
        "[execution]",
        "agent_timeout_minutes = 45",
        "internal_agent_retries = 1",
        "",
        "[git]",
        'integration_branch_prefix = "project-integration/"',
        "",
        "[[verification.commands]]",
        'argv = ["npm", "test"]',
        'cwd = "packages/app"',
      ].join("\n"),
      "utf8",
    );

    const resolved = await loadProjectConfig(root);
    assert.equal(
      resolved.source_path,
      path.join(root, ".codex", "team-orchestrator.toml"),
    );
    assert.equal(resolved.config.organization.max_teams, 2);
    assert.equal(resolved.config.organization.min_workers_per_team, 2);
    assert.equal(resolved.config.organization.max_workers_per_team, 3);
    assert.equal(resolved.config.execution.agent_timeout_minutes, 45);
    assert.equal(resolved.config.execution.internal_agent_retries, 1);
    assert.equal(
      resolved.config.git.integration_branch_prefix,
      "project-integration/",
    );
    assert.deepEqual(resolveVerificationCommands(resolved.config, root), [
      {
        argv: ["npm", "test"],
        cwd: path.join(root, "packages", "app"),
      },
    ]);
    assert.equal(resolved.config.models.pm, "gpt-5.6-sol");
    assert.equal(resolved.config.models.worker, "gpt-5.6-luna");
    assert.equal(resolved.config.logging.record_private_reasoning, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-1402 rejects malformed, unknown, unsafe, and secret-bearing project settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-bad-config-"));
  const configDirectory = path.join(root, ".codex");
  const configPath = path.join(configDirectory, "team-orchestrator.toml");
  await mkdir(configDirectory, { recursive: true });
  try {
    const invalidDocuments = [
      'version = "broken"',
      "version = 1\nunknown = true",
      'version = 1\n[models]\nworker = "unapproved-model"',
      'version = 1\n[git]\nintegration_branch_prefix = "../escape/"',
      'version = 1\n[[verification.commands]]\nargv = ["npm", "test"]\ncwd = "../outside"',
      'version = 1\n[external_models]\napi_key = "SHOULD_NOT_LEAK"',
    ];
    for (const document of invalidDocuments) {
      await writeFile(configPath, document, "utf8");
      await assert.rejects(
        loadProjectConfig(root),
        (error: unknown) => {
          assert.ok(error instanceof ArkTeamError);
          assert.equal(error.code, "INVALID_PROJECT_CONFIG");
          assert.equal(error.message.includes("SHOULD_NOT_LEAK"), false);
          return true;
        },
      );
    }
    await writeFile(configPath, 'version = "unterminated', "utf8");
    await assert.rejects(
      loadProjectConfig(root),
      (error: unknown) =>
        error instanceof ArkTeamError &&
        error.code === "INVALID_PROJECT_CONFIG" &&
        error.message === "Project configuration is not valid TOML",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TEST-1404 reopens and enforces a persisted zero-retry policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ark-team-policy-"));
  const project = path.join(root, "project");
  const stateRoot = path.join(root, "state");
  await mkdir(project);
  try {
    const config = structuredClone(DEFAULT_PROJECT_CONFIG);
    config.execution.internal_agent_retries = 0;
    const firstStore = new RunStore({
      root_path: stateRoot,
      assignment_suffix: () => "000000000140",
    });
    const run = await firstStore.createRun({
      objective: "Persist a zero-retry project policy",
      project_path: project,
      project_config: config,
      project_config_source: path.join(
        project,
        ".codex",
        "team-orchestrator.toml",
      ),
    });
    const assignment = await firstStore.createAssignment({
      run_id: run.run_id,
      team_id: "team-a",
      role: "pl",
      assignment: "Fail once without automatic retry",
      working_directory: project,
    });
    await firstStore.failAssignment(
      run.run_id,
      assignment.assignment_id,
      "simulated failure",
    );

    const reopenedStore = new RunStore({ root_path: stateRoot });
    const coordinator = new TeamCoordinator(
      reopenedStore,
      new ManagedAssignmentScheduler(reopenedStore, {
        session_factory: () => {
          throw new Error("persisted zero-retry policy must prevent relaunch");
        },
      }),
    );
    const waiting = await coordinator.advance(run.run_id);
    const reopenedAssignment = waiting.assignments.find(
      (candidate) => candidate.assignment_id === assignment.assignment_id,
    );
    assert.equal(waiting.run.state, "waiting_user");
    assert.equal(
      reopenedAssignment?.pending_retry?.kind,
      "internal_failure_exhausted",
    );
    assert.equal(reopenedAssignment?.session_attempt_count, 1);
    assert.equal(
      (await reopenedStore.getRun(run.run_id)).project_config.execution
        .internal_agent_retries,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
