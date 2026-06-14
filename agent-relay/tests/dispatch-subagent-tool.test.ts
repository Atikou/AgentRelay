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
    { roles: ["code_review"], task: "审查 foo" },
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
    { roles: ["code_review"], task: "审查" },
    { workspaceRoot: sandbox, subAgentDispatchDepth: 1, maxSubAgentDispatchDepth: 1 },
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /深度上限|无限递归/);
});

test("dispatch_subagent 单角色派生成功", async () => {
  await fs.writeFile(path.join(sandbox, "review-me.txt"), "TODO: fix", "utf-8");
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
    { roles: ["code_review"], task: "审查 review-me.txt" },
    { workspaceRoot: sandbox, taskId: "parent-task-1" },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const out = res.output as {
    mode: string;
    summary: string;
    results: Array<{ role: string; status: string }>;
    parentTaskId?: string;
  };
  assert.equal(out.mode, "single");
  assert.equal(out.parentTaskId, "parent-task-1");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.role, "code_review");
  assert.equal(out.results[0]!.status, "completed");
  assert.match(out.summary, /TODO/);
});

test("dispatch_subagent 多角色 batch 汇总", async () => {
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
    { roles: ["code_review", "test_analyze"], task: "检查最近改动" },
    { workspaceRoot: sandbox },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const out = res.output as { mode: string; aggregate?: { status: string }; results: unknown[] };
  assert.equal(out.mode, "batch");
  assert.equal(out.results.length, 2);
  assert.equal(out.aggregate?.status, "completed");
});

test("dispatch_subagent 归一化模型常见错参", async () => {
  const normalized = normalizeDispatchSubagentInput({
    roles: ["plan", "time_scheduling", "risk"],
    task: [
      { goal: "学习计划", mode: "分析" },
      { goal: "时间安排", mode: "分析" },
      { goal: "风险与坚持方法", mode: "分析" },
    ],
    context: {},
    writeFilePickStrategy: null,
    grantedPermissions: ["read"],
  }) as { roles: string[]; task: string; context: string; writeFilePickStrategy?: string };

  assert.deepEqual(normalized.roles, ["code_review", "test_analyze", "test_analyze"]);
  assert.match(normalized.task, /学习计划/);
  assert.equal(normalized.context, "");
  assert.equal("writeFilePickStrategy" in normalized, false);
});

test("dispatch_subagent 对只读分析自动移除未授权 patch_worker", async () => {
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
      roles: ["code_review", "test_analyze", "patch_worker"],
      task: "分析如何每天学习1小时编程的最佳方法",
      context: "",
      grantedPermissions: ["read"],
      writeFilePickStrategy: "latest",
    },
    { workspaceRoot: sandbox },
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const out = res.output as { roles: string[]; results: unknown[] };
  assert.deepEqual(out.roles, ["code_review", "test_analyze"]);
  assert.equal(out.results.length, 2);
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
    '{"action":"tool","tool":"dispatch_subagent","input":{"roles":["code_review"],"task":"审查 sample.ts"},"thought":"专项审查"}',
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
    '{"action":"tool","tool":"dispatch_subagent","input":{"roles":["code_review"],"task":"学习计划"},"thought":"一"}',
    '{"action":"tool","tool":"dispatch_subagent","input":{"roles":["test_analyze"],"task":"时间安排"},"thought":"二"}',
    '{"action":"tool","tool":"dispatch_subagent","input":{"roles":["test_analyze"],"task":"风险与坚持"},"thought":"三"}',
    '{"action":"tool","tool":"dispatch_subagent","input":{"roles":["code_review"],"task":"继续分析"},"thought":"不该继续"}',
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
    { roles: ["code_review"], task: "nested" },
    { workspaceRoot: sandbox, subAgentDispatchDepth: 1 },
  );
  assert.equal(blocked.ok, false);
});

test("dispatchSubagentTool 元信息为 read 且无副作用", async () => {
  assert.equal(dispatchSubagentTool.permission, "read");
  assert.equal(dispatchSubagentTool.hasSideEffect, false);
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
