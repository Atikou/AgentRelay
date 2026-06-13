/**
 * IntentRouter 自检。
 * 运行：npm run test:intent-router
 */
import assert from "node:assert/strict";

import { defaultIntentRouter } from "../src/agent/IntentRouter.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("route 显式 mode 优先于文案推断", () => {
  const route = defaultIntentRouter.route({
    requestedMode: "chat",
    message: "请进入计划模式，只读分析当前项目",
  });
  assert.equal(route.mode, "chat");
  assert.equal(route.modeSource, "explicit");
  assert.equal(route.intent, "answer");
  assert.equal(route.workflowType, "answerWorkflow");
  assert.equal(route.workflowPlan, null);
});

test("route 从计划类文案推断 plan 与 planWorkflow", () => {
  const route = defaultIntentRouter.route({
    message: "请进入计划模式，只读分析当前项目模型路由",
  });
  assert.equal(route.mode, "plan");
  assert.equal(route.modeSource, "inferred");
  assert.equal(route.intent, "plan");
  assert.equal(route.workflowType, "planWorkflow");
  assert.equal(route.workflowPlan?.id, "plan_prescan");
});

test("route 实现类任务推断 editWorkflow 与 implement_locate", () => {
  const route = defaultIntentRouter.route({
    requestedMode: "implement",
    message: "修改 AgentLoop.ts 中的预算耗尽逻辑",
  });
  assert.equal(route.mode, "implement");
  assert.equal(route.intent, "edit");
  assert.equal(route.workflowType, "editWorkflow");
  assert.equal(route.workflowPlan?.id, "implement_locate");
  assert.deepEqual(route.workflowPlan?.steps, ["locate_relevant_files", "context_pack"]);
});

test("inferMode codegen taskType 映射 implement", () => {
  assert.equal(
    defaultIntentRouter.inferMode({ message: "优化路由", taskType: "codegen" }),
    "implement",
  );
});

test("inferIntent 区分 verify / run / refactor / summarize / generate_file", () => {
  assert.equal(defaultIntentRouter.route({ message: "运行测试看看" }).intent, "verify");
  assert.equal(defaultIntentRouter.route({ message: "启动服务" }).intent, "run");
  assert.equal(defaultIntentRouter.route({ message: "先解耦这个模块" }).intent, "refactor");
  assert.equal(defaultIntentRouter.route({ message: "总结当前项目进度" }).intent, "summarize");
  assert.equal(defaultIntentRouter.route({ message: "生成文件 README 草稿" }).workflowType, "generateFileWorkflow");
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
console.log(`\nintent-router: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
