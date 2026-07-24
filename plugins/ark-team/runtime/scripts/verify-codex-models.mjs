import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const expectedModels = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

const { stdout } = await execFileAsync("codex", ["debug", "models"], {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
const catalog = JSON.parse(stdout);

for (const slug of expectedModels) {
  const model = catalog.models?.find((candidate) => candidate.slug === slug);
  if (!model) {
    throw new Error(`Codex model catalog is missing ${slug}`);
  }

  const supportsXhigh = model.supported_reasoning_levels?.some(
    (level) => level.effort === "xhigh",
  );
  if (!supportsXhigh) {
    throw new Error(`${slug} does not advertise xhigh reasoning`);
  }
}

console.log(`Verified Codex models: ${expectedModels.join(", ")} (xhigh)`);
