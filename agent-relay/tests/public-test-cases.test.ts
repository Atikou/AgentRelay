/**
 * Public test case asset validation.
 * Run: npm run test:public-test-cases
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const casesRoot = path.join(__dirname, "../public/test-cases");

interface TestCaseIndex {
  features: Array<{ featureId: string; file: string }>;
}

interface PublicTestCase {
  id?: unknown;
  title?: unknown;
  purpose?: unknown;
  method?: unknown;
  path?: unknown;
  input?: unknown;
  expect?: unknown;
}

function readCases(parsed: unknown, file: string): PublicTestCase[] {
  if (Array.isArray(parsed)) return parsed as PublicTestCase[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cases?: unknown }).cases)) {
    return (parsed as { cases: PublicTestCase[] }).cases;
  }
  assert.fail(`${file} must contain an array or a { cases: [] } object`);
}

const index = JSON.parse(await readFile(path.join(casesRoot, "index.json"), "utf-8")) as TestCaseIndex;
assert.ok(Array.isArray(index.features), "index.features must be an array");

const seenIds = new Set<string>();
let count = 0;

for (const feature of index.features) {
  assert.equal(typeof feature.featureId, "string", "featureId is required");
  assert.equal(typeof feature.file, "string", `file is required for ${feature.featureId}`);
  const filePath = path.join(casesRoot, feature.file);
  const raw = await readFile(filePath, "utf-8");
  const cases = readCases(JSON.parse(raw), feature.file);
  assert.ok(cases.length >= 2, `${feature.file} should contain at least 2 cases`);

  for (const item of cases) {
    count += 1;
    assert.equal(typeof item.id, "string", `${feature.file} case id is required`);
    assert.ok(item.id.trim(), `${feature.file} case id cannot be empty`);
    assert.equal(seenIds.has(item.id), false, `duplicate public test case id: ${item.id}`);
    seenIds.add(item.id);
    assert.equal(typeof item.title, "string", `${item.id} title is required`);
    assert.equal(typeof item.purpose, "string", `${item.id} purpose is required`);
    assert.equal(typeof item.method, "string", `${item.id} method is required`);
    assert.equal(typeof item.path, "string", `${item.id} path is required`);
    assert.ok("input" in item, `${item.id} input field is required`);
    assert.ok("expect" in item, `${item.id} expect field is required`);
  }
}

console.log(`public-test-cases: ${count} cases validated across ${index.features.length} files`);
