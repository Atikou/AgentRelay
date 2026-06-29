/**

 * 子 Agent 能力声明与 Smart 路由输入（无需网络）。

 * 运行：npm run test:subagent-routing

 */

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";



import { buildDelegatedTaskRouterInput } from "../src/model-router/create-subagent-chat.js";

import {

  analyzeTaskRoutingSignals,

  normalizeDelegatedTask,

} from "../src/subagent/index.js";



const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>) {

  tests.push({ name, fn });

}



const __dirname = path.dirname(fileURLToPath(import.meta.url));

const subagentSrcDir = path.join(__dirname, "../src/subagent");



test("analyzeTaskRoutingSignals 不含硬编码模型名", () => {

  const signals = analyzeTaskRoutingSignals("审查 src/foo.ts 的 import 错误");

  const json = JSON.stringify(signals);

  assert.ok(signals.taskType.length > 0);

  assert.ok(signals.qualityMode.length > 0);

  assert.doesNotMatch(json, /phi4|qwen|deepseek|local-/i);

});



test("buildDelegatedTaskRouterInput 使用任务信号与 tool 模式", () => {

  const delegated = normalizeDelegatedTask({ goal: "审查 src/foo.ts" });

  const input = buildDelegatedTaskRouterInput(delegated, "审查 src/foo.ts", { sensitive: false });

  assert.equal(input.taskTypeOverride, "code_question");

  assert.equal(input.mode, "tool");

  assert.equal(input.forceSingleModel, true);

  assert.equal(input.allowCollaboration, false);

  assert.equal(input.mayUseTools, true);

  assert.equal(input.mayModifyWorkspace, false);

});



test("buildDelegatedTaskRouterInput honors sensitive localOnly", () => {
  const delegated = normalizeDelegatedTask({ goal: "分析 npm run test 失败 stderr" });
  const input = buildDelegatedTaskRouterInput(delegated, "分析失败日志", { sensitive: true });
  assert.equal(input.localOnly, true);
  assert.equal(input.taskTypeOverride, "debug");
});

test("buildDelegatedTaskRouterInput 继承主 Agent edit/debug 工作流路由提示", () => {
  const delegated = normalizeDelegatedTask({ goal: "检查 utils 模块" });
  const debugInput = buildDelegatedTaskRouterInput(delegated, "检查 utils 模块", {
    parentIntent: "debug",
    parentWorkflowType: "debugWorkflow",
  });
  assert.equal(debugInput.taskTypeOverride, "debug");
  const editInput = buildDelegatedTaskRouterInput(delegated, "检查 utils 模块", {
    parentIntent: "edit",
    parentWorkflowType: "editWorkflow",
  });
  assert.equal(editInput.taskTypeOverride, "code_edit");
});

test("subagent source files do not hardcode model client names", () => {

  const files = [

    "delegatedTask.ts",

    "routingSignals.ts",

    "SubAgentRunner.ts",

    "SubAgentCoordinator.ts",

    "types.ts",

    "ToolRouter.ts",

  ];

  const forbidden = /\b(local-phi4|local-qwen|phi4|deepseek)\b/i;

  for (const file of files) {

    const text = readFileSync(path.join(subagentSrcDir, file), "utf8");

    assert.doesNotMatch(text, forbidden, `${file} 不应硬编码模型名`);

  }

});



test("buildDelegatedTaskRouterInput bumps qualityMode for complex patch task", () => {

  const longGoal = `修改以下文件：\n${Array.from({ length: 5 }, (_, i) => `src/pkg/module${i}.ts`).join("\n")}\n跨模块重构 export apply_patch`;

  const delegated = normalizeDelegatedTask({

    goal: longGoal,

    toolPolicy: { writeAllowed: true },

  });

  const signals = analyzeTaskRoutingSignals(longGoal, "", delegated.modelPolicy);

  assert.equal(signals.complexity, "high");

  const input = buildDelegatedTaskRouterInput(delegated, longGoal);

  assert.equal(input.qualityMode, "deep");

  assert.equal(input.mayModifyWorkspace, true);

  assert.equal(input.taskTypeOverride, "code_edit");

});



let failed = 0;

for (const { name, fn } of tests) {

  try {

    await fn();

    console.log(`✓ ${name}`);

  } catch (error) {

    failed += 1;

    console.error(`✗ ${name}`);

    console.error(error);

  }

}

if (failed > 0) {

  process.exit(1);

}

console.log(`\n${tests.length - failed}/${tests.length} passed`);


