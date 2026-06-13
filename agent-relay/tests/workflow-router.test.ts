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
  executor: string;
  readonlyOnly: boolean;
  sideEffectKind: string;
}> = {
  answer: {
    workflowType: "answerWorkflow",
    executor: "answerExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  plan: {
    workflowType: "planWorkflow",
    executor: "planExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  edit: {
    workflowType: "editWorkflow",
    executor: "editExecutor",
    readonlyOnly: false,
    sideEffectKind: "write",
  },
  run: {
    workflowType: "runWorkflow",
    executor: "runExecutor",
    readonlyOnly: false,
    sideEffectKind: "shell",
  },
  debug: {
    workflowType: "debugWorkflow",
    executor: "debugExecutor",
    readonlyOnly: false,
    sideEffectKind: "mixed",
  },
  review: {
    workflowType: "reviewWorkflow",
    executor: "reviewExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  verify: {
    workflowType: "verifyWorkflow",
    executor: "verifyExecutor",
    readonlyOnly: false,
    sideEffectKind: "shell",
  },
  summarize: {
    workflowType: "summarizeWorkflow",
    executor: "summarizeExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  search: {
    workflowType: "searchWorkflow",
    executor: "searchExecutor",
    readonlyOnly: true,
    sideEffectKind: "none",
  },
  refactor: {
    workflowType: "refactorWorkflow",
    executor: "refactorExecutor",
    readonlyOnly: false,
    sideEffectKind: "write",
  },
  generate_file: {
    workflowType: "generateFileWorkflow",
    executor: "generateFileExecutor",
    readonlyOnly: false,
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

