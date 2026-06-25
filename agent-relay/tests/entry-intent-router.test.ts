/**
 * EntryIntentRouter 架构纠偏路由自检。
 * 运行：npm run test:entry-intent-router
 */
import assert from "node:assert/strict";

import { EntryIntentRouter } from "../src/agent/routing/EntryIntentRouter.js";
import { SessionTaskManager } from "../src/agent/task/SessionTaskManager.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("活跃任务 + 粘贴失败输出 → task_continuation", () => {
  const sessionId = "entry-router-failure";
  const manager = new SessionTaskManager();
  manager.updateFromRun({
    sessionId,
    goal: "修改 vite 配置",
    intent: "edit",
    workflowType: "editWorkflow",
    stopReason: "completed",
    workflowTaskState: "executing",
  });
  const router = new EntryIntentRouter(manager);
  const pasted = ["#2 read_file", "[error] ENOENT"].join("\n");
  const decision = router.resolve({ sessionId, message: pasted });
  assert.equal(decision.source, "task_continuation");
  assert.equal(decision.intent, "edit");
  assert.equal(decision.mode, "implement");
  assert.equal(decision.isContinuation, true);
});

test("活跃任务 + legacy answer → 默认延续 edit", () => {
  const sessionId = "entry-router-active-default";
  const manager = new SessionTaskManager();
  manager.updateFromRun({
    sessionId,
    goal: "修改 vite 配置",
    intent: "edit",
    workflowType: "editWorkflow",
    stopReason: "completed",
  });
  const router = new EntryIntentRouter(manager);
  const decision = router.resolve({
    sessionId,
    message: "我贴一段日志你看看是不是路径问题，路径在 testTS 下面",
  });
  assert.ok(decision.isContinuation);
  assert.equal(decision.intent, "edit");
  assert.ok(
    decision.source === "session_continuation" || decision.source === "task_continuation",
  );
});

test("无会话时走 legacy_fallback", () => {
  const router = new EntryIntentRouter();
  const decision = router.resolve({ message: "你好，介绍一下你自己" });
  assert.equal(decision.source, "legacy_fallback");
  assert.equal(decision.intent, "answer");
});

test("无会话 + 星空效果改进诉求 → intent_adjudicator 纠偏为 edit", () => {
  const router = new EntryIntentRouter();
  const decision = router.resolve({
    message: "testTs项目这个星空看起来有点假，我需要那种漫天星空的感觉，就是星云那样",
  });
  assert.equal(decision.intent, "edit");
  assert.equal(decision.mode, "implement");
  assert.equal(decision.workflowType, "editWorkflow");
  assert.equal(decision.source, "intent_adjudicator");
  assert.equal(decision.needsWrite, true);
  assert.equal(decision.isNewTask, true);
});

test("显式 mode 走 explicit_mode", () => {
  const router = new EntryIntentRouter();
  const decision = router.resolve({
    requestedMode: "plan",
    forceRequestedMode: true,
    message: "随便什么",
  });
  assert.equal(decision.source, "explicit_mode");
  assert.equal(decision.mode, "plan");
});

test("generate_file 活跃任务 + 安装依赖 → task_boundary 进入 runWorkflow", () => {
  const sessionId = "entry-router-install-deps";
  const manager = new SessionTaskManager();
  manager.updateFromRun({
    sessionId,
    goal: "执行增强方案",
    intent: "generate_file",
    workflowType: "generateFileWorkflow",
    stopReason: "completed",
    workflowTaskState: "completed",
    sideEffectsMet: false,
    completionStatus: "misleading_completion",
  });
  const router = new EntryIntentRouter(manager);
  const decision = router.resolve({ sessionId, message: "安装依赖" });
  assert.equal(decision.source, "task_boundary");
  assert.equal(decision.intent, "run");
  assert.equal(decision.workflowType, "runWorkflow");
  assert.equal(decision.isContinuation, false);
  assert.equal(decision.needsRunCommand, true);
});

test("edit 活跃任务 + 再好看壮观一点 → task_continuation 继承", () => {
  const sessionId = "entry-router-visual-tweak";
  const manager = new SessionTaskManager();
  manager.updateFromRun({
    sessionId,
    goal: "修改星系页面",
    intent: "edit",
    workflowType: "editWorkflow",
    stopReason: "completed",
    sideEffectSummary: { wroteFiles: ["testTS/src/index.ts"], ranShell: false },
  });
  const router = new EntryIntentRouter(manager);
  const decision = router.resolve({ sessionId, message: "再好看壮观一点" });
  assert.equal(decision.source, "task_continuation");
  assert.equal(decision.intent, "edit");
  assert.equal(decision.isContinuation, true);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\nentry-intent-router: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
