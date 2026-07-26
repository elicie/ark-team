import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const agentDirectory = path.join(repositoryRoot, ".codex/agents");

interface ExpectedAgent {
  filename: string;
  name: string;
  model: string;
  sandbox: "read-only" | "workspace-write";
  approval: "never" | "on-request";
  requiredInstructions: string[];
}

const expectedAgents: ExpectedAgent[] = [
  {
    filename: "ark_pm.toml",
    name: "ark_pm",
    model: "gpt-5.6-sol",
    sandbox: "read-only",
    approval: "never",
    requiredInstructions: [
      "UNSAFE_PM_PERMISSIONS",
      "Never request write escalation.",
      "ark_pl",
      "ark_worker",
      "WORKER_SPAWN_REQUEST",
    ],
  },
  {
    filename: "ark_pl.toml",
    name: "ark_pl",
    model: "gpt-5.6-terra",
    sandbox: "workspace-write",
    approval: "on-request",
    requiredInstructions: [
      "Spawn only the custom agent named ark_worker",
      "WORKER_SPAWN_REQUEST",
      "one PL report",
      "non-overlapping paths",
      "team's local commit",
    ],
  },
  {
    filename: "ark_worker.toml",
    name: "ark_worker",
    model: "gpt-5.6-luna",
    sandbox: "workspace-write",
    approval: "on-request",
    requiredInstructions: [
      "Do not spawn or delegate to other agents.",
      "one worker report",
      "owning ark_pl",
      "Do not stage or commit changes",
    ],
  },
];

test("TEST-201 custom agents match the approved role contract", async () => {
  assert.deepEqual(
    (await readdir(agentDirectory)).sort(),
    expectedAgents.map((agent) => agent.filename).sort(),
  );

  for (const expected of expectedAgents) {
    const content = await readFile(path.join(agentDirectory, expected.filename), "utf8");
    assert.equal(readString(content, "name"), expected.name);
    assert.equal(readString(content, "model"), expected.model);
    assert.equal(readString(content, "model_reasoning_effort"), "xhigh");
    assert.equal(readString(content, "sandbox_mode"), expected.sandbox);
    assert.equal(readString(content, "approval_policy"), expected.approval);
    assert.match(content, /description\s*=\s*"[^"]+"/);
    assert.match(content, /developer_instructions\s*=\s*"""[\s\S]+"""/);

    for (const instruction of expected.requiredInstructions) {
      assert.ok(
        content.includes(instruction),
        `${expected.name} is missing instruction: ${instruction}`,
      );
    }
  }
});

test("TEST-201 skill selects named roles and preserves the fallback hierarchy", async () => {
  const skill = await readFile(
    path.join(repositoryRoot, "plugins/ark-team/skills/ark-team/SKILL.md"),
    "utf8",
  );

  for (const role of ["ark_pm", "ark_pl", "ark_worker", "WORKER_SPAWN_REQUEST"]) {
    assert.ok(skill.includes(role), `skill is missing ${role}`);
  }
  assert.match(skill, /report the degraded guarantee instead of claiming/);
  assert.match(skill, /Preserve the logical reporting hierarchy/);
  assert.match(skill, /Do not treat custom-agent TOML permissions as an isolation boundary/);
  assert.match(skill, /For a writing run, require a managed runtime/);
  assert.match(skill, /Workers edit, test, and report without/);
  assert.match(skill, /create the team's local commit/);
});

function readString(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  assert.notEqual(match, null, `missing TOML string field: ${key}`);
  return match?.[1] ?? "";
}
