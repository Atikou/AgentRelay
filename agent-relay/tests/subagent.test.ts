/**
 * M5 子 Agent 自检（无需网络）。
 * 运行：npm run test:subagent
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LoopChatFn } from "../src/agent/AgentLoop.js";
import type { ModelResponse } from "../src/model/types.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import {
  SubAgentCoordinator,
  SubAgentRunner,
  aggregateSubAgentResultsStructured,
  listSubAgentRoles,
  resolveGrantedPermissions,
} from "../src/subagent/index.js";
import { SUB_AGENT_ROLES } from "../src/subagent/roles.js";
import { extractFilePaths } from "../src/subagent/taskContext.js";

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

function slowChat(delayMs: number): LoopChatFn {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return {
      content: '{"action":"final","answer":"慢"}',
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: delayMs,
    };
  };
}

test("listSubAgentRoles 包含两个只读角色", async () => {
  const roles = listSubAgentRoles();
  assert.equal(roles.length, 2);
  assert.ok(roles.every((r) => r.allowedPermissions.join() === "read"));
  assert.ok(SUB_AGENT_ROLES.code_review.defaultBudget.maxModelTurns >= 10);
  assert.equal(SUB_AGENT_ROLES.code_review.defaultBudget.maxWriteCalls, 0);
});

test("extractFilePaths 从任务描述提取路径", async () => {
  const paths = extractFilePaths("审查 src/agent/AgentLoop.ts 的错误处理");
  assert.deepEqual(paths, ["src/agent/AgentLoop.ts"]);
});

test("resolveGrantedPermissions 拒绝超出角色的权限", async () => {
  const role = SUB_AGENT_ROLES.code_review;
  assert.throws(() => resolveGrantedPermissions(role, ["write"]), /超出允许范围/);
});

test("SubAgentRunner 预读 ts 文件走单次审查（无需 JSON）", async () => {
  const agentDir = path.join(sandbox, "src", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "AgentLoop.ts"),
    "export function run() { throw new Error('x'); }",
    "utf-8",
  );
  const chat: LoopChatFn = async () => ({
    content: "发现 run() 未捕获异常，建议补充 try/catch。",
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const runner = new SubAgentRunner({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const result = await runner.run({
    role: "code_review",
    task: "审查 src/agent/AgentLoop.ts 的错误处理",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 1);
  assert.equal(result.steps.length, 0);
  assert.match(result.answer, /try\/catch|异常/);
});

test("SubAgentRunner 预读 txt 后可直接 final", async () => {
  await fs.writeFile(path.join(sandbox, "review-me.txt"), "TODO: fix bug", "utf-8");
  const chat = scriptedChat(['{"action":"final","answer":"发现 TODO 注释"}']);
  const runner = new SubAgentRunner({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const result = await runner.run({
    role: "code_review",
    task: "审查 review-me.txt",
    parentTaskId: "parent-1",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.parentTaskId, "parent-1");
  assert.match(result.answer, /TODO/);
  assert.equal(result.grantedPermissions.join(), "read");
  assert.equal(result.iterations, 1);
});

test("SubAgentRunner 超时返回 timeout", async () => {
  const runner = new SubAgentRunner({
    chat: slowChat(500),
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const result = await runner.run({
    role: "test_analyze",
    task: "分析",
    timeoutMs: 50,
  });
  assert.equal(result.status, "timeout");
});

test("SubAgentCoordinator 并行汇总多个角色", async () => {
  const chat: LoopChatFn = async () => ({
    content: '{"action":"final","answer":"子 Agent 结论"}',
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const coord = new SubAgentCoordinator({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const batch = await coord.runBatch({
    roles: ["code_review", "test_analyze"],
    task: "检查最近改动",
    parentTaskId: "batch-parent",
  });
  assert.equal(batch.results.length, 2);
  assert.equal(batch.parentTaskId, "batch-parent");
  assert.ok(batch.results.every((r) => r.status === "completed"));
  assert.match(batch.summary, /code_review/);
  assert.match(batch.summary, /test_analyze/);
  assert.equal(batch.aggregate.status, "completed");
  assert.equal(batch.aggregate.completed, 2);
  assert.equal(batch.aggregate.conflicts.length, 0);
});

test("aggregateSubAgentResultsStructured 检测角色冲突并合并摘要", async () => {
  const aggregate = aggregateSubAgentResultsStructured([
    {
      id: "a",
      role: "code_review",
      status: "completed",
      answer: "login 模块通过 ok。",
      steps: [],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read"],
    },
    {
      id: "b",
      role: "test_analyze",
      status: "completed",
      answer: "login 模块失败 error。",
      steps: [],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read"],
    },
  ]);
  assert.equal(aggregate.status, "conflict");
  assert.equal(aggregate.conflicts.length, 1);
  assert.equal(aggregate.conflicts[0]!.topic, "login");
  assert.match(aggregate.mergedAnswer, /冲突/);
  assert.match(aggregate.mergedAnswer, /code_review/);
  assert.match(aggregate.mergedAnswer, /test_analyze/);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-sub-"));
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
  console.log(`\nsubagent: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
