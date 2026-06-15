/**
 * ExecutionRouter / DelegatedTask / ResultCollector 自检（无需网络）。
 * 运行：npm run test:subagent-execution-router
 */
import assert from "node:assert/strict";

import { buildDelegatedTaskRouterInput } from "../src/model-router/create-subagent-chat.js";
import {
  ExecutionRouter,
  defaultContextRouter,
  defaultResultCollector,
  defaultTaskSplitter,
  normalizeDelegatedTask,
} from "../src/subagent/index.js";
import { createDelegatedTaskChatFn } from "../src/model-router/create-subagent-chat.js";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

const router = new ExecutionRouter();

test("ExecutionRouter 简单任务建议主 Agent 直接执行", () => {
  const route = router.route({ goal: "解释什么是 REST API" });
  assert.equal(route.mode, "direct");
});

test("ExecutionRouter 复杂任务可委派子 Agent", () => {
  const route = router.route({
    goal: "审查 src/a.ts src/b.ts src/c.ts 的调用链与风险",
    forceDelegate: true,
  });
  assert.equal(route.mode, "delegate");
  assert.ok(route.delegatedTask?.goal);
  assert.ok(route.toolPolicy);
  assert.equal(route.toolPolicy?.writeAllowed, false);
});

test("ContextRouter 不注入主 Agent 全量历史", () => {
  const task = normalizeDelegatedTask({
    goal: "分析日志",
    instructions: "找出启动失败根因",
    input: "Error: ECONNREFUSED",
    context: { logs: ["line1", "line2"] },
  });
  const packaged = defaultContextRouter.package(task);
  assert.match(packaged.userContent, /子任务目标/);
  assert.match(packaged.userContent, /ECONNREFUSED/);
  assert.doesNotMatch(packaged.userContent, /父 Agent 完整对话/);
});

test("TaskSplitter 多文件任务可拆成并行子任务", () => {
  const tasks = defaultTaskSplitter.split("请分别审查 src/foo.ts 与 src/bar.ts");
  assert.ok(tasks.length >= 2);
  assert.equal(tasks[0]?.context?.files?.[0], "src/foo.ts");
});

test("ResultCollector 从 JSON final 解析结构化结果", () => {
  const structured = defaultResultCollector.collect({
    taskId: "t1",
    status: "completed",
    rawAnswer: JSON.stringify({
      status: "success",
      summary: "发现空指针风险",
      findings: ["未检查 null"],
      risks: ["可能崩溃"],
      nextActions: ["加 guard"],
      confidence: 0.85,
    }),
    steps: [{ tool: "read_file", ok: true, iteration: 1 } as never],
  });
  assert.equal(structured.status, "success");
  assert.equal(structured.findings[0], "未检查 null");
  assert.deepEqual(structured.usedTools, ["read_file"]);
});

test("buildDelegatedTaskRouterInput 按 modelPolicy 选型而非角色", () => {
  const task = normalizeDelegatedTask({
    goal: "跨模块重构 export",
    instructions: "分析依赖",
    input: "",
    modelPolicy: { prefer: "auto", allowRemoteEscalation: true, minQuality: "strong" },
    toolPolicy: {
      allowedTools: ["read_file"],
      writeAllowed: false,
      shellAllowed: false,
      requireApproval: false,
    },
  });
  const input = buildDelegatedTaskRouterInput(task, task.goal, { sensitive: true });
  assert.equal(input.localOnly, true);
  assert.equal(input.forceSingleModel, true);
  assert.equal(input.mayModifyWorkspace, false);
});

test("通用子 Agent 不默认绑定代码能力或代码任务类型", () => {
  const task = normalizeDelegatedTask({
    goal: "每天如何提升自我",
    instructions: "给出一个可执行建议",
    input: "",
  });
  assert.deepEqual(task.modelPolicy?.requiredCapabilities, []);

  const input = buildDelegatedTaskRouterInput(task, task.goal);
  assert.equal(input.taskTypeOverride, "simple_qa");
  assert.equal(input.mayModifyWorkspace, false);
});

test("createDelegatedTaskChatFn 导出为函数工厂", () => {
  assert.equal(typeof createDelegatedTaskChatFn, "function");
});

async function main() {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`✓ ${t.name}`);
    } catch (error) {
      console.error(`✗ ${t.name}`);
      console.error(error);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exit(1);
}

main();
