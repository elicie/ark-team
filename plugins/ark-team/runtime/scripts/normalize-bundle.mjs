import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

for (const bundleName of ["approval-session.js", "server.js", "session-cli.js"]) {
  const bundlePath = path.resolve(scriptDirectory, "../dist", bundleName);
  const bundle = await readFile(bundlePath, "utf8");
  await writeFile(bundlePath, bundle.replace(/[ \t]+$/gm, ""), "utf8");
}
