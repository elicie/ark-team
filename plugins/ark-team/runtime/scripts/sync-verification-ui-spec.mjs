import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_SHA256 =
  "571b5cae52473b6dc5b0e8416406f881062b2a8c8729c401aaa06667efe6e383";
const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = path.resolve(pluginRoot, "../..");
const sourcePath = path.join(
  repositoryRoot,
  "docs/specs/verification-ui-runtime/SPEC.md",
);
const installedPath = path.join(
  pluginRoot,
  "runtime/contracts/verification-ui-runtime/SPEC.md",
);
const mode = process.argv[2] ?? "--check";

if (!["--check", "--write"].includes(mode)) {
  throw new Error("usage: sync-verification-ui-spec.mjs [--check|--write]");
}

const sourceBytes = await readFile(sourcePath);
const sourceSha256 = sha256(sourceBytes);
if (sourceSha256 !== EXPECTED_SHA256) {
  throw new Error(
    `normative UI runtime SPEC SHA-256 ${sourceSha256} is not approved`,
  );
}

if (mode === "--write") {
  await mkdir(path.dirname(installedPath), { recursive: true });
  await copyFile(sourcePath, installedPath);
}

const installedBytes = await readFile(installedPath);
if (!sourceBytes.equals(installedBytes)) {
  throw new Error("plugin UI runtime SPEC bytes differ from the normative SPEC");
}

console.log(
  JSON.stringify({
    status: "PLUGIN_UI_SPEC_VERIFIED",
    sha256: sourceSha256,
    mode,
  }),
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
