/**
 * 测试台静态入口自检。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "../public");
const docsDir = path.join(__dirname, "../../docs");

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("测试台侧栏提供模型路由日志入口", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
  assert.ok(html.includes('data-action="routing-logs"'));
  assert.ok(html.includes("模型路由日志"));
});

test("app.js 注册模型路由日志面板处理器", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  assert.ok(js.includes("async function handleRoutingLogs()"));
  assert.ok(js.includes("/api/routing/logs?"));
  assert.ok(js.includes('action === "routing-logs"'));
});

test("M2 网页用例覆盖路由日志面板", async () => {
  const raw = await readFile(path.join(publicDir, "test-cases/m2-routing.json"), "utf-8");
  const page = JSON.parse(raw) as { cases: Array<{ id: string; purpose?: string }> };
  const ids = new Set(page.cases.map((c) => c.id));
  assert.ok(ids.has("m2-routing-panel-entry-documented"));
  assert.ok(ids.has("m2-routing-doc-panel-status"));
  for (const id of ["m2-routing-panel-entry-documented", "m2-routing-doc-panel-status"]) {
    const item = page.cases.find((c) => c.id === id);
    assert.ok(item?.purpose && item.purpose.length > 10, `${id} 缺少 purpose`);
  }
});

test("模型路由文档标记测试台面板已落地", async () => {
  const md = await readFile(path.join(docsDir, "模型路由与协作.md"), "utf-8");
  assert.ok(md.includes("测试台「模型路由日志」"));
  assert.ok(!md.includes("测试台面板待做"));
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
console.log(`public-ui: ${passed}/${tests.length} passed`);
