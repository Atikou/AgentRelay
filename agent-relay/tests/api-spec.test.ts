/**
 * API 规范自检：结构合法且覆盖主要 HTTP 路由。
 * 运行：npm run test:api-spec
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(__dirname, "../public/api-spec.json");
const apiDocsHtml = path.join(__dirname, "../public/api-docs.html");
const scalarJs = path.join(__dirname, "../public/vendor/scalar-api-reference.js");

const REQUIRED_PATHS = [
  "/api/config",
  "/api/models/catalog",
  "/api/chat",
  "/api/agent",
  "/api/agent/resume",
  "/api/agent/stream",
  "/api/plan",
  "/api/plans/draft",
  "/api/plans/analyze",
  "/api/plans/import-preview",
  "/api/plans/{userVisiblePlanId}/compile",
  "/api/plans/{planId}/preview",
  "/api/plans/{planId}/approve",
  "/api/plans/{planId}/reject",
  "/api/plans/{planId}/execute",
  "/api/runs",
  "/api/runs/{runId}",
  "/api/runs/{runId}/report",
  "/api/tasks",
  "/api/tasks/{taskId}",
  "/api/tasks/{taskId}/resume",
  "/api/routing/logs",
  "/api/routing/profiles",
  "/api/routing/stats",
  "/api/routing/eval/run",
  "/api/routing/eval/runs",
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

test("api-spec.json 可解析且含 AgentRelay 标题", async () => {
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
  assert.ok(spec.components.schemas.RunRecord);
  assert.ok(Array.isArray(spec.tags) && spec.tags.length >= 9);
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

test("api-docs 页面使用 Scalar 官方 script 集成", async () => {
  const html = await readFile(apiDocsHtml, "utf-8");
  assert.ok(html.includes('id="api-reference"'));
  assert.ok(html.includes('data-url="/api-spec.json"'));
  assert.ok(html.includes("/vendor/scalar-api-reference.js"));
  assert.ok(!html.includes("cdn.jsdelivr.net"));
  assert.ok(!html.includes("Scalar.createApiReference"));
  assert.ok(!html.includes('<div id="api-reference"'));
  const js = await readFile(scalarJs, "utf-8");
  assert.ok(js.length > 10_000);
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
console.log(`api-spec: ${passed}/${tests.length} passed`);
