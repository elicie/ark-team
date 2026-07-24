import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(scriptDirectory, "../dist/server.js");
const bundle = await readFile(bundlePath, "utf8");

await writeFile(bundlePath, bundle.replace(/[ \t]+$/gm, ""), "utf8");
