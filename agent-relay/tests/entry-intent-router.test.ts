/**
 * EntryIntentRouter 架构纠偏路由自检。
 * 运行：npm run test:entry-intent-router
 */
import assert from "node:assert/strict";

import { EntryIntentRouter } from "../src/agent/routing/EntryIntentRouter.js";
import { SessionTaskManager } from "../src/agent/task/SessionTaskManager.js";
import { defaultWorkflowSessionStore } from "../src/agent/WorkflowSessionSwitch.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("活跃任务 + 粘贴失败输出 → session_continuation", () => {
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
  assert.equal(decision.source, "session_continuation");
  assert.equal(decision.intent, "edit");
  assert.equal(decision.mode, "implement");
  assert.equal(decision.isContinuation, true);
});

test("活跃任务 + legacy answer → 默认延续 edit", () => {
  const sessionId = "entry-router-active-default";
  defaultWorkflowSessionStore.set({
    sessionId,
    intent: "edit",
    workflowType: "editWorkflow",
    updatedAt: new Date().toISOString(),
  });
  const router = new EntryIntentRouter(new SessionTaskManager());
  const decision = router.resolve({
    sessionId,
    message: "我贴一段日志你看看是不是路径问题，路径在 testTS 下面",
  });
  assert.equal(decision.source, "session_continuation");
  assert.equal(decision.intent, "edit");
  defaultWorkflowSessionStore.clear(sessionId);
});

test("无会话时走 legacy_fallback", () => {
  const router = new EntryIntentRouter();
  const decision = router.resolve({ message: "你好，介绍一下你自己" });
  assert.equal(decision.source, "legacy_fallback");
  assert.equal(decision.intent, "answer");
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
