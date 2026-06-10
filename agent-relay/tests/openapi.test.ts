/**
 * OpenAPI 规范自检：结构合法且覆盖主要 HTTP 路由。
 * 运行：npm run test:openapi
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(__dirname, "../public/openapi.json");

const REQUIRED_PATHS = [
  "/api/config",
  "/api/chat",
  "/api/agent",
  "/api/plan",
  "/api/tools",
  "/api/tools/run",
  "/api/background",
  "/api/background/start",
  "/api/notifications",
  "/api/scheduler/triggers",
  "/api/subagent/run",
  "/api/context/sessions",
  "/api/trace/recent",
  "/api/trace/replay",
  "/api/docs",
];

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("openapi.json 可解析且版本为 3.1", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as {
    openapi: string;
    info: { title: string };
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
    tags: unknown[];
  };
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.info.title.includes("AgentRelay"));
  assert.ok(spec.components.schemas.ErrorBody);
  assert.ok(Array.isArray(spec.tags) && spec.tags.length >= 8);
});

test("主要 API 路径已在规范中登记", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as { paths: Record<string, unknown> };
  for (const p of REQUIRED_PATHS) {
    assert.ok(spec.paths[p], `missing path: ${p}`);
  }
});

test("动态路径含 path 参数", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as { paths: Record<string, unknown> };
  assert.ok(spec.paths["/api/background/{taskId}"]);
  assert.ok(spec.paths["/api/scheduler/triggers/{triggerId}/pause"]);
  assert.ok(spec.paths["/api/context/sessions/{sessionId}/restore"]);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}
console.log(`openapi: ${passed}/${tests.length} passed`);
