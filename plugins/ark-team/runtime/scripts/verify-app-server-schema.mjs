import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const generatedRoot = await mkdtemp(path.join(tmpdir(), "ark-team-app-server-schema-"));

const requiredTokens = {
  "ClientRequest.ts": [
    '"method": "initialize"',
    '"method": "thread/start"',
    '"method": "thread/resume"',
    '"method": "turn/start"',
    '"method": "turn/interrupt"',
  ],
  "ServerRequest.ts": [
    '"method": "item/commandExecution/requestApproval"',
    '"method": "item/fileChange/requestApproval"',
    '"method": "item/permissions/requestApproval"',
  ],
  "ServerNotification.ts": ['"method": "model/rerouted"'],
  "v2/ThreadStartParams.ts": [
    "approvalPolicy?:",
    "approvalsReviewer?:",
    "sandbox?:",
    "config?:",
    "developerInstructions?:",
    "ephemeral?:",
  ],
  "v2/ThreadStartResponse.ts": [
    "approvalPolicy:",
    "approvalsReviewer:",
    "sandbox:",
    "reasoningEffort:",
  ],
  "v2/ThreadResumeParams.ts": [
    "threadId:",
    "model?:",
    "cwd?:",
    "approvalPolicy?:",
    "approvalsReviewer?:",
    "sandbox?:",
    "config?:",
    "developerInstructions?:",
  ],
  "v2/ThreadResumeResponse.ts": [
    "approvalPolicy:",
    "approvalsReviewer:",
    "sandbox:",
    "reasoningEffort:",
  ],
  "v2/TurnStartParams.ts": [
    "threadId:",
    "input:",
    "approvalPolicy?:",
    "approvalsReviewer?:",
    "model?:",
    "effort?:",
    "outputSchema?:",
  ],
  "v2/UserInput.ts": ['"type": "text"', "text_elements:"],
  "v2/CommandExecutionApprovalDecision.ts": [
    '"accept"',
    '"acceptForSession"',
    '"decline"',
    '"cancel"',
  ],
  "v2/FileChangeApprovalDecision.ts": [
    '"accept"',
    '"acceptForSession"',
    '"decline"',
    '"cancel"',
  ],
  "v2/PermissionsRequestApprovalResponse.ts": [
    "permissions:",
    "scope:",
  ],
  "v2/PermissionGrantScope.ts": ['"turn"', '"session"'],
  "v2/TokenUsageBreakdown.ts": [
    "inputTokens:",
    "cachedInputTokens:",
    "cacheWriteInputTokens:",
    "outputTokens:",
    "reasoningOutputTokens:",
  ],
  "v2/ModelReroutedNotification.ts": [
    "threadId:",
    "turnId:",
    "fromModel:",
    "toModel:",
  ],
};

try {
  const version = (
    await execFileAsync("codex", ["--version"], {
      encoding: "utf8",
    })
  ).stdout.trim();
  await execFileAsync(
    "codex",
    ["app-server", "generate-ts", "--out", generatedRoot],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  let checkedTokenCount = 0;
  for (const [relativePath, tokens] of Object.entries(requiredTokens)) {
    const content = await readFile(path.join(generatedRoot, relativePath), "utf8");
    for (const token of tokens) {
      if (!content.includes(token)) {
        throw new Error(
          `Incompatible Codex app-server schema: ${relativePath} lacks ${JSON.stringify(token)}`,
        );
      }
      checkedTokenCount += 1;
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "APP_SERVER_SCHEMA_COMPATIBLE",
      codex_version: version,
      files_checked: Object.keys(requiredTokens).length,
      tokens_checked: checkedTokenCount,
    })}\n`,
  );
} finally {
  await rm(generatedRoot, { recursive: true, force: true });
}
