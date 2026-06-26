/**
 * WorkflowRouter 自检。
 * 运行：node .\node_modules\tsx\dist\cli.mjs tests\workflow-router.test.ts
 */
import assert from "node:assert/strict";

import type { AgentIntentType } from "../src/agent/IntentTypes.js";
import { defaultIntentRouter } from "../src/agent/IntentRouter.js";
import { defaultWorkflowRouter } from "../src/agent/WorkflowRouter.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const expected: Record<AgentIntentType, {
  workflowType: string;
  workflowKind: string;
  executor: string;
  readonlyOnly: boolean;
  enforceReadOnlyTools: boolean;
  sideEffectKind: string;
}> = {
  answer: {
    workflowType: "answerWorkflow",
    workflowKind: "hard",
    executor: "answerExecutor",
    readonlyOnly: true,
    enforceReadOnlyTools: true,
    sideEffectKind: "none",
  },
  plan: {
    workflowType: "planWorkflow",
    workflowKind: "hard",
    executor: "planExecutor",
    readonlyOnly: true,
    enforceReadOnlyTools: false,
    sideEffectKind: "none",
  },
  edit: {
    workflowType: "editWorkflow",
    workflowKind: "soft",
    executor: "editExecutor",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "write",
  },
  run: {
    workflowType: "runWorkflow",
    workflowKind: "soft",
    executor: "runExecutor",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "shell",
  },
  debug: {
    workflowType: "debugWorkflow",
    workflowKind: "soft",
    executor: "debugExecutor",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "mixed",
  },
  review: {
    workflowType: "reviewWorkflow",
    workflowKind: "hard",
    executor: "reviewExecutor",
    readonlyOnly: true,
    enforceReadOnlyTools: false,
    sideEffectKind: "none",
  },
  verify: {
    workflowType: "verifyWorkflow",
    workflowKind: "soft",
    executor: "verifyExecutor",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "shell",
  },
  summarize: {
    workflowType: "summarizeWorkflow",
    workflowKind: "hard",
    executor: "summarizeExecutor",
    readonlyOnly: true,
    enforceReadOnlyTools: true,
    sideEffectKind: "none",
  },
  search: {
    workflowType: "searchWorkflow",
    workflowKind: "hard",
    executor: "searchExecutor",
    readonlyOnly: true,
    enforceReadOnlyTools: true,
    sideEffectKind: "none",
  },
  refactor: {
    workflowType: "refactorWorkflow",
    workflowKind: "soft",
    executor: "refactorExecutor",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "write",
  },
  generate_file: {
    workflowType: "generateFileWorkflow",
    workflowKind: "soft",
    executor: "generateFileExecutor",
    readonlyOnly: false,
    enforceReadOnlyTools: false,
    sideEffectKind: "write",
  },
};

test("每个 intent 都能路由到确定工作流执行器", () => {
  for (const [intent, route] of Object.entries(expected) as Array<[AgentIntentType, typeof expected[AgentIntentType]]>) {
    assert.deepEqual(defaultWorkflowRouter.routeIntent(intent), {
      intent,
      ...route,
    });
  }
});

test("IntentRouter 使用 WorkflowRouter 输出 workflowType", () => {
  assert.equal(
    defaultIntentRouter.route({ message: "生成文件 README 草稿" }).workflowType,
    defaultWorkflowRouter.routeIntent("generate_file").workflowType,
  );
  assert.equal(
    defaultIntentRouter.route({ message: "运行测试验证结果" }).workflowType,
    defaultWorkflowRouter.routeIntent("verify").workflowType,
  );
});

test("answer/summarize/search 工作流声明工具层强制只读", () => {
  assert.equal(defaultWorkflowRouter.routeIntent("answer").enforceReadOnlyTools, true);
  assert.equal(defaultWorkflowRouter.routeIntent("summarize").enforceReadOnlyTools, true);
  assert.equal(defaultWorkflowRouter.routeIntent("search").enforceReadOnlyTools, true);
  assert.equal(defaultWorkflowRouter.routeIntent("edit").enforceReadOnlyTools, false);
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
console.log(`\nworkflow-router: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
