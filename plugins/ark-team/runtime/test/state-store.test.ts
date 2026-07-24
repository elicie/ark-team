import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import { RunStore } from "../src/state-store.js";

let testRoot: string;
let stateRoot: string;
let projectRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "ark-team-state-test-"));
  stateRoot = path.join(testRoot, "state");
  projectRoot = path.join(testRoot, "project");
  await mkdir(projectRoot);
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

test("TEST-001 creates a run and reopens persisted state", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Implement persistent lifecycle control",
    project_path: projectRoot,
  });

  assert.match(created.run_id, /^ark-\d{8}t\d{6}z-[a-z0-9]{6}$/);
  assert.equal(created.state, "planning");
  assert.equal(created.event_count, 1);

  const reopened = new RunStore({ root_path: stateRoot });
  assert.deepEqual(await reopened.getRun(created.run_id), created);

  const listed = await reopened.listRuns();
  assert.equal(listed.total, 1);
  assert.equal(listed.runs[0]?.run_id, created.run_id);
});

test("TEST-002 pauses, resumes, cancels, and resumes from cancellation", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Exercise lifecycle transitions",
    project_path: projectRoot,
  });

  const paused = await store.pauseRun(created.run_id, "User requested pause");
  assert.equal(paused.changed, true);
  assert.equal(paused.run.state, "paused");
  assert.equal(paused.run.resume_state, "planning");

  const resumed = await store.resumeRun(created.run_id);
  assert.equal(resumed.run.state, "planning");
  assert.equal(resumed.run.resume_state, null);

  const cancelled = await store.cancelRun(created.run_id, "User cancelled");
  assert.equal(cancelled.run.state, "cancelled");
  assert.equal(cancelled.run.resume_state, "planning");

  const resumedAfterCancel = await store.resumeRun(created.run_id);
  assert.equal(resumedAfterCancel.run.state, "planning");
  assert.equal(resumedAfterCancel.run.resume_state, null);
});

test("TEST-003 rejects an invalid transition without modifying state", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Reject invalid transition",
    project_path: projectRoot,
  });
  const recordPath = path.join(stateRoot, created.run_id, "run.json");
  const before = await readFile(recordPath, "utf8");

  await assert.rejects(
    () => store.resumeRun(created.run_id),
    (error: unknown) =>
      error instanceof ArkTeamError && error.code === "INVALID_TRANSITION",
  );

  assert.equal(await readFile(recordPath, "utf8"), before);
  assert.deepEqual(await store.getRun(created.run_id), created);
});

test("TEST-004 returns ordered event pages with a stable cursor", async () => {
  const store = new RunStore({ root_path: stateRoot });
  const created = await store.createRun({
    objective: "Paginate lifecycle events",
    project_path: projectRoot,
  });
  await store.pauseRun(created.run_id);
  await store.resumeRun(created.run_id);
  await store.cancelRun(created.run_id);

  const firstPage = await store.getLogs(created.run_id, { limit: 2 });
  assert.deepEqual(
    firstPage.events.map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(firstPage.next_after_sequence, 2);
  assert.equal(firstPage.has_more, true);

  const secondPage = await store.getLogs(created.run_id, {
    after_sequence: firstPage.next_after_sequence,
    limit: 2,
  });
  assert.deepEqual(
    secondPage.events.map((event) => event.sequence),
    [3, 4],
  );
  assert.equal(secondPage.has_more, false);
  assert.equal(
    secondPage.events.some((event) => "private_reasoning" in event),
    false,
  );
});

test("TEST-005 rejects relative project paths and unsafe run identifiers", async () => {
  const store = new RunStore({ root_path: stateRoot });

  await assert.rejects(
    () =>
      store.createRun({
        objective: "Invalid path",
        project_path: "relative/project",
      }),
    (error: unknown) => error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );

  await assert.rejects(
    () => store.getRun("../escape"),
    (error: unknown) => error instanceof ArkTeamError && error.code === "INVALID_INPUT",
  );
});
