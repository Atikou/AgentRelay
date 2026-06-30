import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const companionDir = path.join(__dirname, "../src/companion");
const forbidden = [
  /from\s+["']\.\.\/agent\/AgentLoop\.js["']/,
  /from\s+["']\.\.\/tools\//,
  /from\s+["']\.\.\/policy\/PermissionGuard\.js["']/,
  /from\s+["']\.\.\/policy\/PathPolicy\.js["']/,
];

for (const file of await readdir(companionDir)) {
  if (!file.endsWith(".ts")) continue;
  const source = await readFile(path.join(companionDir, file), "utf-8");
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern, `${file} imports forbidden execution boundary`);
  }
}

console.log("companion-boundary: passed");

