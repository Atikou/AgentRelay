/**
 * WorkflowPlanner 自检。
 * 运行：npm run test:workflow-planner
 */
import assert from "node:assert/strict";

import {
  defaultWorkflowPlanner,
  shouldRunAgentWorkflow,
} from "../src/agent/WorkflowPlanner.js";
import { shouldRunPlanWorkflow } from "../src/agent/PlanWorkflow.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("plan 模式项目分析选择 plan_prescan 三步", () => {
  const plan = defaultWorkflowPlanner.plan("只读分析当前项目结构", "plan");
  assert.ok(plan);
  assert.equal(plan!.id, "plan_prescan");
  assert.deepEqual(plan!.steps, ["project_scan", "locate_relevant_files", "context_pack"]);
});

test("plan 模式非项目分析不触发工作流", () => {
  assert.equal(defaultWorkflowPlanner.plan("计划模式中新建文件", "plan"), null);
  assert.equal(shouldRunPlanWorkflow("计划模式中新建文件", "plan"), false);
});

test("implement 模式代码修改选择 implement_locate 两步", () => {
  const plan = defaultWorkflowPlanner.plan("修改 AgentLoop.ts 中的预算逻辑", "implement");
  assert.ok(plan);
  assert.equal(plan!.id, "edit_locate");
  assert.deepEqual(plan!.steps, ["locate_relevant_files", "context_pack"]);
});

test("implement mode generate-file task chooses generate_file_locate", () => {
  const plan = defaultWorkflowPlanner.plan(
    "\u751f\u6210\u6587\u4ef6 src/agent/NewWorkflow.ts",
    "implement",
    "generate_file",
  );
  assert.ok(plan);
  assert.equal(plan!.id, "generate_file_locate");
  assert.deepEqual(plan!.steps, ["locate_relevant_files", "context_pack"]);
});

test("debug mode chooses debug_locate before generic implementation locate", () => {
  const plan = defaultWorkflowPlanner.plan(
    "修复 src/agent/AgentLoop.ts 中未知工具 PlanWorkflow 的错误",
    "debug",
    "debug",
  );
  assert.ok(plan);
  assert.equal(plan!.id, "debug_locate");
  assert.deepEqual(plan!.steps, ["locate_relevant_files", "context_pack"]);
  assert.match(plan!.contextHeader, /debugWorkflow/);
});

test("implement mode refactor task chooses refactor_locate prescan", () => {
  const plan = defaultWorkflowPlanner.plan(
    "先解耦 model-router 与 agent 模块，梳理当前项目依赖",
    "implement",
    "refactor",
  );
  assert.ok(plan);
  assert.equal(plan!.id, "refactor_locate");
  assert.deepEqual(plan!.steps, ["project_scan", "locate_relevant_files", "context_pack"]);
  assert.match(plan!.contextHeader, /refactorWorkflow/);
});

test("chat 模式不触发预扫描工作流", () => {
  assert.equal(defaultWorkflowPlanner.plan("分析当前项目路由模块", "chat"), null);
  assert.equal(shouldRunAgentWorkflow("分析当前项目路由模块", "chat"), false);
});

test("显式禁止工具时不触发工作流", () => {
  assert.equal(
    defaultWorkflowPlanner.plan("只读分析当前项目结构，不要扫描", "plan"),
    null,
  );
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
console.log(`\nworkflow-planner: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
