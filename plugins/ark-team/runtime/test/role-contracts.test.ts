import assert from "node:assert/strict";
import { test } from "node:test";

import { ArkTeamError } from "../src/errors.js";
import {
  assertManagedOutputContractRole,
  managedOutputJsonSchemas,
  parseManagedOutput,
  plWorkerPlanSchema,
  pmPlanSchema,
} from "../src/role-contracts.js";

test("TEST-601 parses strict role outputs and enforces role compatibility", () => {
  const plan = validPmPlan();
  assert.deepEqual(parseManagedOutput("pm_plan", JSON.stringify(plan)), plan);
  assert.doesNotThrow(() => assertManagedOutputContractRole("pm", "pm_plan"));
  assert.doesNotThrow(() =>
    assertManagedOutputContractRole("pl", "pl_worker_plan"),
  );
  assert.doesNotThrow(() =>
    assertManagedOutputContractRole("worker", "worker_report"),
  );

  assert.throws(
    () => assertManagedOutputContractRole("worker", "pm_plan"),
    invalidInput,
  );
  assert.throws(
    () => parseManagedOutput("pm_plan", "not-json"),
    protocolError,
  );
  assert.throws(
    () =>
      parseManagedOutput(
        "pm_plan",
        JSON.stringify({
          ...plan,
          private_reasoning: "must not be accepted",
        }),
      ),
    protocolError,
  );

  for (const schema of Object.values(managedOutputJsonSchemas)) {
    assert.equal(schema.additionalProperties, false);
  }
});

test("TEST-602 enforces bounded unique acyclic team and worker plans", () => {
  const plan = validPmPlan();
  assert.equal(pmPlanSchema.safeParse(plan).success, true);

  const tooManyTeams = {
    ...plan,
    teams: Array.from({ length: 5 }, (_, index) => ({
      ...plan.teams[0],
      team_id: `team-${index + 1}`,
    })),
  };
  assert.equal(pmPlanSchema.safeParse(tooManyTeams).success, false);
  assert.equal(
    pmPlanSchema.safeParse({
      ...plan,
      teams: [
        plan.teams[0],
        {
          ...plan.teams[0],
          team_id: "team-b",
          dependencies: ["missing-team"],
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    pmPlanSchema.safeParse({
      ...plan,
      teams: [
        {
          ...plan.teams[0],
          dependencies: ["team-b"],
        },
        {
          ...plan.teams[0],
          team_id: "team-b",
          dependencies: ["team-a"],
        },
      ],
    }).success,
    false,
  );

  const worker = {
    worker_key: "worker-a",
    mission: "Implement the bounded change.",
    owned_paths: ["src/feature.ts"],
    dependencies: [] as string[],
    acceptance_criteria: ["The focused behavior is observable."],
    verification: ["Run the focused unit test."],
    commit_required: true,
  };
  assert.equal(
    plWorkerPlanSchema.safeParse({
      kind: "pl_worker_plan",
      team_id: "team-a",
      workers: [worker],
    }).success,
    true,
  );
  assert.equal(
    plWorkerPlanSchema.safeParse({
      kind: "pl_worker_plan",
      team_id: "team-a",
      workers: [
        worker,
        {
          ...worker,
          dependencies: ["worker-a"],
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    plWorkerPlanSchema.safeParse({
      kind: "pl_worker_plan",
      team_id: "team-a",
      workers: Array.from({ length: 6 }, (_, index) => ({
        ...worker,
        worker_key: `worker-${index + 1}`,
      })),
    }).success,
    false,
  );
});

function validPmPlan() {
  return {
    kind: "pm_plan" as const,
    objective: "Deliver one bounded feature.",
    teams: [
      {
        team_id: "team-a",
        mission: "Implement the feature.",
        owned_paths: ["src/feature.ts"],
        dependencies: [] as string[],
        acceptance_criteria: ["The requested behavior is implemented."],
        verification: ["Run the focused unit tests."],
        worker_count: 1,
      },
    ],
    integration: {
      strategy: "local_merge" as const,
      acceptance_criteria: ["The integrated branch remains buildable."],
      verification: ["Run the repository test suite."],
    },
  };
}

function invalidInput(error: unknown): boolean {
  return error instanceof ArkTeamError && error.code === "INVALID_INPUT";
}

function protocolError(error: unknown): boolean {
  return (
    error instanceof ArkTeamError &&
    error.code === "AGENT_SESSION_PROTOCOL_ERROR"
  );
}
