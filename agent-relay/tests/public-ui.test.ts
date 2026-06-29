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

test("架构文档登记入口路由", async () => {
  const md = await readFile(path.join(docsDir, "执行流程.md"), "utf-8");
  assert.ok(md.includes("AIIntentClassifier"));
  assert.ok(md.includes("intentDecisionSource"));
});

test("默认执行元信息不暴露 mode/intent", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  assert.ok(js.includes("function formatExecutionMetaSummary"));
  assert.ok(js.includes("if (!DEV_MODE) return usagePart"));
  assert.ok(js.includes("formatAgentExecutionMetaDetail"));
});

test("权限面板展示风险与预览字段", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  assert.ok(js.includes("perm-item-risk"));
  assert.ok(js.includes("inputPreview"));
  assert.ok(js.includes("blockedTool"));
  assert.ok(js.includes("permissionPanelHasShellOnly"));
});

test("续跑成功后再关闭权限/计划面板", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  assert.ok(js.includes("hidePermissionRequestPanel();"));
  assert.match(js, /resume[\s\S]{0,400}hidePermissionRequestPanel\(\)/);
  assert.match(js, /resume-plan-handoff[\s\S]{0,400}hidePlanHandoffPanel\(\)/);
});

test("Agent 结果卡展示自然状态标签", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  assert.ok(js.includes("userFacingLabel"));
  assert.ok(js.includes("renderWorkflowStatus"));
  assert.ok(js.includes("getWorkflowStatusLabel"));
  assert.ok(js.includes("DEV_MODE"));
  assert.ok(js.includes("renderConfirmationRequest"));
});

test("显式 mode 默认隐藏，仅 dev 模式可用", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  const css = await readFile(path.join(publicDir, "styles.css"), "utf-8");
  assert.ok(html.includes('id="explicit-mode-select"'));
  assert.ok(html.includes("dev-only-tools"));
  assert.ok(css.includes(".dev-only-tools"));
  assert.ok(js.includes("initDevModeUi"));
  assert.ok(js.includes("if (!DEV_MODE) return undefined"));
});

test("测试台默认自动工作流入口与权限策略", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  const css = await readFile(path.join(publicDir, "styles.css"), "utf-8");
  assert.ok(html.includes('id="permission-policy-select"'));
  assert.ok(!html.includes('id="mode-select"'));
  assert.ok(html.includes('class="advanced-panel"'));
  assert.ok(css.includes(".advanced-panel"));
  assert.ok(js.includes("handleUnifiedAgent"));
  assert.ok(js.includes("PERMISSION_POLICY_KEY"));
});

test("M1 自动工作流 UI 用例覆盖结构化面板紧凑显示", async () => {
  const raw = await readFile(path.join(publicDir, "test-cases/m1-auto-workflow-ui.json"), "utf-8");
  const page = JSON.parse(raw) as { cases: Array<{ id: string; purpose?: string }> };
  const ids = new Set(page.cases.map((c) => c.id));
  for (const id of [
    "m1-auto-ui-structured-bubble-class",
    "m1-auto-ui-structured-bubble-spacing",
    "m1-auto-ui-advanced-panel-container",
    "m1-auto-ui-advanced-panel-spacing",
  ]) {
    const item = page.cases.find((c) => c.id === id);
    assert.ok(ids.has(id), `${id} 未登记`);
    assert.ok(item?.purpose && item.purpose.length > 10, `${id} 缺少 purpose`);
  }
});

test("Agent 工作流状态样式已登记", async () => {
  const css = await readFile(path.join(publicDir, "styles.css"), "utf-8");
  assert.ok(css.includes(".workflow-status"));
  assert.ok(css.includes(".workflow-status-detail"));
  assert.ok(css.includes(".confirmation-request"));
});

test("结构化系统面板不继承文本 pre-wrap 间距", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  const css = await readFile(path.join(publicDir, "styles.css"), "utf-8");
  assert.ok(js.includes('bubble.classList.add("structured-bubble")'));
  assert.ok(css.includes(".bubble.structured-bubble"));
  assert.ok(css.includes("white-space: normal"));
});

test("测试台 Activity Timeline 面板处理 activity_event", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  const css = await readFile(path.join(publicDir, "styles.css"), "utf-8");
  assert.ok(js.includes("function createActivityTimelinePanel"));
  assert.ok(js.includes('evt.type === "activity_event"'));
  assert.ok(js.includes("ACTIVITY_STEP_ICONS"));
  assert.ok(css.includes(".activity-timeline-card"));
  assert.ok(css.includes(".activity-step-running"));
});

test("测试台历史会话支持重命名与删除", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  const css = await readFile(path.join(publicDir, "styles.css"), "utf-8");
  assert.ok(js.includes("session-menu-popover"));
  assert.ok(js.includes("openSessionMenu"));
  assert.ok(js.includes('data-action="session-menu-toggle"'));
  assert.ok(js.includes("saveHistorySessionTitle"));
  assert.ok(js.includes("performDeleteHistorySession"));
  assert.ok(!js.includes("renameHistorySession"));
  assert.ok(css.includes(".session-menu-popover"));
  assert.ok(css.includes(".sidebar-session-more"));
});

test("计划全流程审阅阶段展示编译与激活按钮", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  const css = await readFile(path.join(publicDir, "styles.css"), "utf-8");
  assert.ok(js.includes("plan-review-actions"));
  assert.ok(js.includes("plan-compile-btn-review"));
  assert.ok(js.includes("plan-activate-btn-review"));
  assert.ok(js.includes("unlockSectionsUpTo(2, 1)"));
  assert.ok(css.includes(".plan-review-actions"));
});

test("app.js 时间显示经 parseTimestamp 转本地时区", async () => {
  const js = await readFile(path.join(publicDir, "app.js"), "utf-8");
  assert.ok(js.includes("function parseTimestamp(value)"));
  assert.ok(js.includes("function formatDateTime(value)"));
  assert.ok(js.includes('toLocaleString("zh-CN"'));
  assert.ok(js.includes("formatDateTime(n.timestamp)"));
  assert.ok(js.includes("year: \"numeric\""));
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
