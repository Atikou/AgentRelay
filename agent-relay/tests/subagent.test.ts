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
import { SubAgentCoordinator, SubAgentRunner, aggregateSubAgentResultsStructured, listSubAgentRoles, resolveGrantedPermissions } from "../src/subagent/index.js";
import { NotificationQueue } from "../src/background/NotificationQueue.js";
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

test("listSubAgentRoles 包含三个角色且 patch_worker 可写", async () => {
  const roles = listSubAgentRoles();
  assert.equal(roles.length, 3);
  const readOnly = roles.filter((r) => r.id !== "patch_worker");
  assert.ok(readOnly.every((r) => r.allowedPermissions.join() === "read"));
  assert.deepEqual(SUB_AGENT_ROLES.patch_worker.allowedPermissions, ["read", "write"]);
  assert.ok(SUB_AGENT_ROLES.code_review.defaultBudget.maxModelTurns >= 10);
  assert.equal(SUB_AGENT_ROLES.code_review.defaultBudget.maxWriteCalls, 0);
});

test("extractFilePaths 从任务描述提取路径", async () => {
  const paths = extractFilePaths("审查 src/agent/AgentLoop.ts 的错误处理");
  assert.deepEqual(paths, ["src/agent/AgentLoop.ts"]);
});

test("SubAgentRunner 完成后写入通知队列", async () => {
  const journal = path.join(sandbox, "notifications.jsonl");
  const queue = new NotificationQueue(journal);
  const chat: LoopChatFn = async () => ({
    content: '{"action":"final","answer":"完成"}',
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
    notificationQueue: queue,
  });
  await runner.run({
    role: "test_analyze",
    task: "分析日志",
    parentTaskId: "parent-notify",
  });
  const pending = queue.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.source, "subagent");
  assert.equal(pending[0]!.taskId, "parent-notify");
  assert.match(pending[0]!.message, /test_analyze/);
});

test("resolveGrantedPermissions 只读角色拒绝 write", async () => {
  const role = SUB_AGENT_ROLES.code_review;
  assert.throws(() => resolveGrantedPermissions(role, ["write"]), /超出允许范围/);
});

test("resolveGrantedPermissions patch_worker 须显式授予", async () => {
  const role = SUB_AGENT_ROLES.patch_worker;
  assert.throws(() => resolveGrantedPermissions(role), /显式授予/);
  assert.throws(() => resolveGrantedPermissions(role, ["read"]), /须包含 write/);
  const granted = resolveGrantedPermissions(role, ["read", "write"]);
  assert.deepEqual(granted, ["read", "write"]);
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

test("detectWriteConflicts 检测多角色写入同一文件", async () => {
  const results = [
    {
      id: "a",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok",
      steps: [
        {
          iteration: 1,
          tool: "write_file",
          input: { path: "src/foo.ts" },
          output: { path: "src/foo.ts", changeId: "c1" },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read", "write"] as const,
    },
    {
      id: "b",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok2",
      steps: [
        {
          iteration: 1,
          tool: "apply_patch",
          input: { path: "src/foo.ts" },
          output: { path: "src/foo.ts", changeId: "c2" },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read", "write"] as const,
    },
  ];
  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");
  const conflicts = detectWriteConflicts(results);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.path, "src/foo.ts");
  assert.deepEqual(conflicts[0]!.roles, ["patch_worker", "patch_worker"]);
});

test("runBatch arbitrateConflicts 在文本冲突时附加仲裁摘要", async () => {
  let chatCalls = 0;
  const chat: LoopChatFn = async () => {
    const scripts = [
      '{"action":"final","answer":"login 模块通过 ok。"}',
      '{"action":"final","answer":"login 模块失败 error。"}',
      "建议以 test_analyze 的失败结论为准，并人工复核 login 模块。",
    ];
    const content = scripts[chatCalls] ?? scripts[scripts.length - 1]!;
    chatCalls += 1;
    return {
      content,
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    };
  };
  const coord = new SubAgentCoordinator({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const batch = await coord.runBatch({
    roles: ["code_review", "test_analyze"],
    task: "检查 login 模块",
    arbitrateConflicts: true,
  });
  assert.equal(batch.aggregate.status, "conflict");
  assert.ok(batch.aggregate.arbitration?.applied);
  assert.match(batch.summary, /模型仲裁/);
  assert.match(batch.aggregate.arbitration!.summary, /test_analyze|login/);
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
