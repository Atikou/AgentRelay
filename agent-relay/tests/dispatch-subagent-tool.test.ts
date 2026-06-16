/**

 * 主 Agent dispatch_subagent 工具自检（无需网络）。

 * 运行：npm run test:dispatch-subagent

 */

import assert from "node:assert/strict";

import { promises as fs } from "node:fs";

import os from "node:os";

import path from "node:path";



import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";

import type { ModelResponse } from "../src/model/types.js";

import { SubAgentCoordinator } from "../src/subagent/SubAgentCoordinator.js";

import { createDefaultRegistry } from "../src/tools/index.js";

import { dispatchSubagentTool, normalizeDispatchSubagentInput } from "../src/tools/subagentTool.js";



const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>) {

  tests.push({ name, fn });

}



let sandbox = "";



function scriptedChat(scripts: string[]): LoopChatFn {

  let i = 0;

  return async () => {

    const content = scripts[i] ?? '{"action":"final","answer":"脚本耗尽"}';

    i += 1;

    return {

      content,

      toolCalls: [],

      clientName: "fake",

      modelName: "fake",

      location: "local",

      latencyMs: 1,

    } satisfies ModelResponse;

  };

}



function makeCoordinator(chat: LoopChatFn): SubAgentCoordinator {

  return new SubAgentCoordinator({

    chat,

    registry: createDefaultRegistry(),

    workspaceRoot: sandbox,

  });

}



test("dispatch_subagent 缺少 coordinator 时报错", async () => {

  const registry = createDefaultRegistry();

  const res = await registry.run(

    "dispatch_subagent",

    { tasks: [{ goal: "审查 foo.ts" }] },

    { workspaceRoot: sandbox },

  );

  assert.equal(res.ok, false);

  if (res.ok) return;

  assert.match(res.error, /subAgentCoordinator/);

});



test("dispatch_subagent 在达到派生深度上限时拒绝", async () => {

  const registry = createDefaultRegistry();

  registry.setDefaultContext({

    subAgentCoordinator: makeCoordinator(scriptedChat([])),

    maxSubAgentDispatchDepth: 1,

  });

  const res = await registry.run(

    "dispatch_subagent",

    { tasks: [{ goal: "审查 src/x.ts" }] },

    { workspaceRoot: sandbox, subAgentDispatchDepth: 1, maxSubAgentDispatchDepth: 1 },

  );

  assert.equal(res.ok, false);

  if (res.ok) return;

  assert.match(res.error, /深度上限|无限递归/);

});



test("dispatch_subagent 单任务派生成功", async () => {

  await fs.writeFile(path.join(sandbox, "review-me.ts"), "export const todo = true;", "utf-8");

  const chat: LoopChatFn = async () => ({

    content: '{"action":"final","answer":"发现 TODO 待修复"}',

    toolCalls: [],

    clientName: "fake",

    modelName: "fake",

    location: "local",

    latencyMs: 1,

  });

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(chat) });

  const res = await registry.run(

    "dispatch_subagent",

    { tasks: [{ goal: "审查 review-me.ts", instructions: "审查 review-me.ts" }] },

    { workspaceRoot: sandbox, taskId: "parent-task-1" },

  );

  assert.equal(res.ok, true);

  if (!res.ok) return;

  const out = res.output as {

    mode: string;

    summary: string;

    results: Array<{ taskId: string; goal: string; status: string }>;

    parentTaskId?: string;

  };

  assert.equal(out.mode, "single");

  assert.equal(out.parentTaskId, "parent-task-1");

  assert.equal(out.results.length, 1);

  assert.match(out.results[0]!.goal, /review-me\.ts/);

  assert.ok(out.results[0]!.taskId.length > 0);

  assert.equal(out.results[0]!.status, "completed");

  assert.match(out.summary, /TODO/);

});



test("dispatch_subagent 多任务 batch 汇总", async () => {

  const chat: LoopChatFn = async () => ({

    content: '{"action":"final","answer":"子 Agent 结论"}',

    toolCalls: [],

    clientName: "fake",

    modelName: "fake",

    location: "local",

    latencyMs: 1,

  });

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(chat) });

  const res = await registry.run(

    "dispatch_subagent",

    {

      tasks: [

        { goal: "审查 src/README.md 最近改动", instructions: "代码审查" },

        { goal: "分析 src/README.md 相关测试输出", instructions: "测试分析" },

      ],

    },

    { workspaceRoot: sandbox },

  );

  assert.equal(res.ok, true);

  if (!res.ok) return;

  const out = res.output as { mode: string; aggregate?: { status: string }; results: unknown[] };

  assert.equal(out.mode, "batch");

  assert.equal(out.results.length, 2);

  assert.equal(out.aggregate?.status, "completed");

});

test("dispatch_subagent 可一次派生三个通用独立子任务", async () => {

  const chat: LoopChatFn = async () => ({

    content: '{"action":"final","answer":"保持每日复盘，并把一个行动写进今天的清单。"}',

    toolCalls: [],

    clientName: "fake",

    modelName: "fake",

    location: "local",

    latencyMs: 1,

  });

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(chat) });

  const res = await registry.run(

    "dispatch_subagent",

    {

      tasks: [

        { goal: "从学习角度提出一个每日自我提升建议", instructions: "只输出一个可执行建议", toolPolicy: { allowedTools: [] } },

        { goal: "从健康角度提出一个每日自我提升建议", instructions: "只输出一个可执行建议", toolPolicy: { allowedTools: [] } },

        { goal: "从复盘角度提出一个每日自我提升建议", instructions: "只输出一个可执行建议", toolPolicy: { allowedTools: [] } },

      ],

    },

    { workspaceRoot: sandbox },

  );

  assert.equal(res.ok, true);

  if (!res.ok) return;

  const out = res.output as { mode: string; aggregate?: { status: string }; results: Array<{ goal: string; status: string }> };

  assert.equal(out.mode, "batch");

  assert.equal(out.results.length, 3);

  assert.ok(out.results.every((r) => r.status === "completed"));

  assert.match(out.results[0]!.goal, /学习/);

});

test("dispatch_subagent 拒绝旧 roles 参数", async () => {

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(scriptedChat([])) });

  const res = await registry.run(

    "dispatch_subagent",

    {

      roles: ["patch_worker", "code_review"],

      task: "请派生两个旧角色子 Agent",

    },

    { workspaceRoot: sandbox },

  );

  assert.equal(res.ok, false);

  if (res.ok) return;

  assert.match(res.error, /invalid_input|tasks/i);

});



test("dispatch_subagent 归一化剔除 writeFilePickStrategy null", () => {
  const normalized = normalizeDispatchSubagentInput({
    tasks: [{ goal: "审查 src/foo.ts" }],
    writeFilePickStrategy: null,
  }) as { tasks: Array<{ goal: string }>; writeFilePickStrategy?: unknown };

  assert.equal(normalized.tasks.length, 1);
  assert.match(normalized.tasks[0]!.goal, /src\/foo\.ts/);
  assert.equal("writeFilePickStrategy" in normalized, false);
});



test("dispatch_subagent 只读 toolPolicy 拒绝未授权写入", async () => {

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(scriptedChat([])) });

  const res = await registry.run(

    "dispatch_subagent",

    {

      tasks: [

        {

          goal: "修改 src/utils.ts 并应用补丁",

          instructions: "写入修复",

          toolPolicy: { writeAllowed: true, requireApproval: true },

        },

      ],

      grantedPermissions: ["read"],

    },

    { workspaceRoot: sandbox },

  );

  assert.equal(res.ok, false);

  if (res.ok) return;

  assert.match(res.error, /write|显式授予/);

});



test("dispatch_subagent 写子任务缺少 grantedPermissions 直接拒绝（不依赖 requireApproval）", async () => {

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(scriptedChat([])) });

  const res = await registry.run(

    "dispatch_subagent",

    {

      tasks: [

        {

          goal: "修改 src/utils.ts 并应用补丁",

          instructions: "写入修复",

          // 注意：未显式 requireApproval，模型也未传 grantedPermissions。

          toolPolicy: { writeAllowed: true },

        },

      ],

    },

    { workspaceRoot: sandbox },

  );

  assert.equal(res.ok, false);

  if (res.ok) return;

  assert.match(res.error, /write|显式授予/);

});



test("AgentLoop 在只读权限下阻止派生写文件子 Agent", async () => {

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(scriptedChat([])) });

  const mainChat = scriptedChat([

    '{"action":"tool","tool":"dispatch_subagent","input":{"tasks":[{"goal":"修改 src/x.ts","toolPolicy":{"writeAllowed":true}}],"grantedPermissions":["write"]},"thought":"尝试写"}',

    '{"action":"final","answer":"已停止写操作。"}',

  ]);

  const loop = new AgentLoop({

    chat: mainChat,

    registry,

    workspaceRoot: sandbox,

    roleAllowedPermissions: ["read"],

    allowedPermissions: ["read"],

  });

  const res = await loop.run("用子 Agent 修改文件");

  const dispatchStep = res.steps.find((s) => s.tool === "dispatch_subagent");

  assert.ok(dispatchStep);

  assert.equal(dispatchStep!.blocked, true);

  assert.match(dispatchStep!.error ?? "", /写权限|未授予 write|需要用户确认/);

});



test("AgentLoop 主循环可经 dispatch_subagent 派生子 Agent", async () => {

  await fs.writeFile(path.join(sandbox, "sample.ts"), "export const x = 1;", "utf-8");

  const subChat: LoopChatFn = async () => ({

    content: '{"action":"final","answer":"sample.ts 导出常量，无明显问题。"}',

    toolCalls: [],

    clientName: "fake",

    modelName: "fake",

    location: "local",

    latencyMs: 1,

  });

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(subChat) });

  const mainChat = scriptedChat([

    '{"action":"tool","tool":"dispatch_subagent","input":{"tasks":[{"goal":"审查 sample.ts"}]},"thought":"专项审查"}',

    '{"action":"final","answer":"已派生子 Agent 审查，结论见工具结果。"}',

  ]);

  const loop = new AgentLoop({

    chat: mainChat,

    registry,

    workspaceRoot: sandbox,

    taskId: "main-task-42",

  });

  const res = await loop.run("请用子 Agent 审查 sample.ts");

  assert.equal(res.steps.length, 1);

  assert.equal(res.steps[0]!.tool, "dispatch_subagent");

  assert.equal(res.steps[0]!.ok, true);

  assert.match(res.answer, /子 Agent|审查/);

});



test("AgentLoop 已有三个子 Agent 结果后阻止继续派生并要求 final", async () => {

  const subChat: LoopChatFn = async () => ({

    content: '{"action":"final","answer":"子 Agent 结论。"}',

    toolCalls: [],

    clientName: "fake",

    modelName: "fake",

    location: "local",

    latencyMs: 1,

  });

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(subChat) });

  const mainChat = scriptedChat([

    '{"action":"tool","tool":"dispatch_subagent","input":{"tasks":[{"goal":"审查 src/auth.ts 的导出"}]},"thought":"一"}',

    '{"action":"tool","tool":"dispatch_subagent","input":{"tasks":[{"goal":"分析 tests/auth.test.ts 失败日志"}]},"thought":"二"}',

    '{"action":"tool","tool":"dispatch_subagent","input":{"tasks":[{"goal":"分析 npm run test 的 stderr"}]},"thought":"三"}',

    '{"action":"tool","tool":"dispatch_subagent","input":{"tasks":[{"goal":"继续审查 src/auth.ts"}]},"thought":"不该继续"}',

    '{"action":"final","answer":"汇总三个子 Agent 结果。"}',

  ]);

  const loop = new AgentLoop({

    chat: mainChat,

    registry,

    workspaceRoot: sandbox,

    taskId: "main-task-stop-subagent",

    budget: {

      maxModelTurns: 8,

      maxToolCalls: 8,

      maxReadCalls: 8,

      maxWriteCalls: 0,

      maxShellCalls: 0,

      maxRuntimeMs: 60_000,

    },

  });

  const res = await loop.run("请派出 3 个子 Agent 后汇总");

  assert.equal(res.steps.length, 4);

  assert.equal(res.steps.filter((s) => s.tool === "dispatch_subagent" && s.ok).length, 3);

  assert.equal(res.steps[3]!.blocked, true);

  assert.match(res.steps[3]!.error ?? "", /足够子 Agent 结果|不要继续派生/);

  assert.match(res.answer, /汇总三个/);

});



test("子 Agent 内 AgentLoop 不暴露 dispatch_subagent", async () => {

  const registry = createDefaultRegistry();

  registry.setDefaultContext({ subAgentCoordinator: makeCoordinator(scriptedChat([])) });

  const loop = new AgentLoop({

    chat: scriptedChat(['{"action":"final","answer":"ok"}']),

    registry,

    workspaceRoot: sandbox,

    roleAllowedPermissions: ["read"],

    allowedPermissions: ["read"],

  });

  const res = await loop.run("nested");

  assert.ok(res.answer);

  const names = registry.list().map((t) => t.name);

  assert.ok(names.includes("dispatch_subagent"));

  const blocked = await registry.run(

    "dispatch_subagent",

    { tasks: [{ goal: "审查 nested.ts" }] },

    { workspaceRoot: sandbox, subAgentDispatchDepth: 1 },

  );

  assert.equal(blocked.ok, false);

});



test("dispatchSubagentTool 派发为 read 级但如实声明可能有副作用", async () => {

  assert.equal(dispatchSubagentTool.permission, "read");

  // 子 Agent 在授权下可写盘/跑命令，故按「可能有副作用」对待，确认门据此提示。
  assert.equal(dispatchSubagentTool.hasSideEffect, true);

  assert.equal(dispatchSubagentTool.name, "dispatch_subagent");

});



async function main() {

  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-dispatch-sub-"));

  let passed = 0;

  let failed = 0;

  for (const t of tests) {

    try {

      await t.fn();

      console.log(`  ✓ ${t.name}`);

      passed += 1;

    } catch (err) {

      console.error(`  ✗ ${t.name}`);

      console.error(err);

      failed += 1;

    }

  }

  await fs.rm(sandbox, { recursive: true, force: true });

  console.log(`\ndispatch-subagent: ${passed} passed, ${failed} failed`);

  if (failed > 0) process.exit(1);
}

main();
