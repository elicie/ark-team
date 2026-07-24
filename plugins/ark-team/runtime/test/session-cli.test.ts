import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const cliPath = path.join(
  repositoryRoot,
  "plugins/ark-team/runtime/dist/session-cli.js",
);

test("TEST-306 built session CLI rejects a writing role in the primary checkout", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        cliPath,
        "--role",
        "worker",
        "--cwd",
        repositoryRoot,
        "--assignment",
        "This assignment must not start.",
      ],
      {
        encoding: "utf8",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const stderr = "stderr" in error ? String(error.stderr) : "";
      const payload = JSON.parse(stderr);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "UNSAFE_AGENT_WORKSPACE");
      return true;
    },
  );
});
