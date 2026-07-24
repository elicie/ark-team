import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ManagedCodexSessionLauncher } from "../src/managed-session.js";

const execFileAsync = promisify(execFile);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ark-team-live-probe-"));
const repository = path.join(temporaryRoot, "repository");
const workerWorktree = path.join(temporaryRoot, "worker");

try {
  await execFileAsync("git", ["init", "-b", "main", repository]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Ark Team Probe"]);
  await execFileAsync("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "ark-team-probe@example.invalid",
  ]);
  await execFileAsync("git", ["-C", repository, "commit", "--allow-empty", "-m", "probe baseline"]);
  await execFileAsync("git", [
    "-C",
    repository,
    "worktree",
    "add",
    "-b",
    "probe/worker",
    workerWorktree,
  ]);

  const launcher = new ManagedCodexSessionLauncher();
  const pm = await launcher.run({
    role: "pm",
    assignment:
      "Reply exactly PM_SESSION_OK. Do not edit files, run commands, or delegate work.",
    working_directory: repository,
  });
  const { stdout: pmStatus } = await execFileAsync("git", [
    "-C",
    repository,
    "status",
    "--porcelain",
  ]);
  if (pm.final_report !== "PM_SESSION_OK" || pmStatus.trim()) {
    throw new Error("PM live probe did not remain read-only");
  }

  const worker = await launcher.run({
    role: "worker",
    assignment:
      "Create worker-proof.txt containing exactly WORKER_WRITE_OK followed by a newline. Do not commit. Then reply exactly WORKER_SESSION_OK.",
    working_directory: workerWorktree,
  });
  const proof = await readFile(path.join(workerWorktree, "worker-proof.txt"), "utf8");
  if (worker.final_report !== "WORKER_SESSION_OK" || proof !== "WORKER_WRITE_OK\n") {
    throw new Error("Worker live probe did not demonstrate isolated write access");
  }
  if (pm.session_id === worker.session_id) {
    throw new Error("Managed live probe reused a thread across roles");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        pm: {
          session_id: pm.session_id,
          model: pm.model,
          effort: pm.model_reasoning_effort,
          sandbox: pm.sandbox_mode,
          requested_approval: pm.requested_approval_policy,
          usage: pm.usage,
        },
        worker: {
          session_id: worker.session_id,
          model: worker.model,
          effort: worker.model_reasoning_effort,
          sandbox: worker.sandbox_mode,
          requested_approval: worker.requested_approval_policy,
          usage: worker.usage,
        },
        checks: {
          independent_sessions: true,
          pm_read_only: true,
          worker_linked_worktree_write: true,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
