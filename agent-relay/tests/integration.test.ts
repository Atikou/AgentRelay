/**
 * 跨模块集成自检（无需网络）。
 * 运行：npm run test:integration
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";
import { TaskRunner } from "../src/agent/TaskRunner.js";
import { ToolStepExecutor } from "../src/agent/ToolStepExecutor.js";
import type { Plan, PlanStep } from "../src/agent/types.js";
import { BackgroundTaskManager } from "../src/background/BackgroundTaskManager.js";
import { NotificationQueue } from "../src/background/NotificationQueue.js";
import type { ModelResponse } from "../src/model/types.js";
import { SubAgentCoordinator } from "../src/subagent/index.js";
import { TraceLogger } from "../src/trace/TraceLogger.js";
import { readReplayTraceEvents } from "../src/trace/traceReader.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makePlan(steps: Array<Partial<PlanStep> & { id: string; title: string }>): Plan {
  return {
    goal: "integration",
    scope: { inScope: [], outOfScope: [] },
    risks: [],
    dependencies: [],
    steps: steps.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description ?? "",
      requiredPermissions: s.requiredPermissions ?? ["read"],
      needsConfirmation: s.needsConfirmation ?? false,
      tool: s.tool,
      toolInput: s.toolInput,
      status: s.status ?? "pending",
    })),
  };
}

test("集成：完整任务链路 TaskRunner + 工具 + trace", async () => {
  const sandbox = path.join(tmpDir, "task-chain");
  await mkdir(sandbox, { recursive: true });
  await writeFile(path.join(sandbox, "hello.txt"), "world", "utf-8");
  const traceFile = path.join(tmpDir, "int-trace.jsonl");
  const trace = new TraceLogger(traceFile);
  const registry = createDefaultRegistry(trace);
  const plan = makePlan([
    {
      id: "read",
      title: "读取",
      tool: "read_file",
      toolInput: { path: "hello.txt" },
    },
  ]);
  const runner = new TaskRunner(plan, {
    executor: new ToolStepExecutor({ registry, workspaceRoot: sandbox }),
    autoConfirm: true,
    trace,
  });
  const result = await runner.run();
  assert.equal(result.steps[0]!.status, "completed");
  await trace.close();
  const replay = readReplayTraceEvents(traceFile, { limit: 20, redact: false });
  assert.ok(replay.some((e) => e.type === "tool_audit" && e.tool === "read_file"));
});

test("集成：后台任务完成通知被 AgentLoop 安全点消费", async () => {
  const sandbox = path.join(tmpDir, "bg-notify");
  await mkdir(sandbox, { recursive: true });
  const nqFile = path.join(tmpDir, "int-nq.jsonl");
  const nq = new NotificationQueue(nqFile);
  nq.enqueue({
    source: "background_task",
    level: "info",
    message: "后台构建已完成",
    payload: { status: "completed" },
  });
  const registry = createDefaultRegistry();
  const chat = scriptedChat(['{"action":"final","answer":"已看到通知"}']);
  const loop = new AgentLoop({
    chat,
    registry,
    workspaceRoot: sandbox,
    notificationQueue: nq,
  });
  const res = await loop.run("继续");
  assert.equal(res.notifications?.length, 1);
  assert.match(res.answer, /已看到通知/);
  assert.equal(nq.listPending().length, 0);
});

test("集成：后台 spawn 完成后写入通知并可被调度", async () => {
  const sandbox = path.join(tmpDir, "bg-spawn");
  await mkdir(sandbox, { recursive: true });
  const nqFile = path.join(tmpDir, "int-bg.jsonl");
  const nq = new NotificationQueue(nqFile);
  const bg = new BackgroundTaskManager(sandbox, nq);
  const task = bg.start('node -e "process.exit(0)"');
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const t = bg.get(task.id);
    if (t && t.status !== "running") break;
    await sleep(50);
  }
  assert.ok(nq.listPending().some((n) => n.source === "background_task"));
});

test("集成：子 Agent 并行执行并汇总", async () => {
  const sandbox = path.join(tmpDir, "sub-par");
  await mkdir(path.join(sandbox, "src"), { recursive: true });
  await writeFile(path.join(sandbox, "src", "a.ts"), "export const a = 1;", "utf-8");
  const registry = createDefaultRegistry();
  let calls = 0;
  const chat: LoopChatFn = async () => {
    calls += 1;
    return {
      content: '{"action":"final","answer":"并行审查完成"}',
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    };
  };
  const coordinator = new SubAgentCoordinator({
    chat,
    registry,
    workspaceRoot: sandbox,
  });
  const result = await coordinator.runBatch({
    tasks: [
      { goal: "审查 src/a.ts", instructions: "代码审查 src/a.ts" },
      { goal: "分析 src/a.ts 相关测试输出", instructions: "测试分析" },
    ],
  });
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.status === "completed"));
  assert.ok(result.summary.length > 0);
  assert.ok(calls >= 2);
});

async function main() {
  tmpDir = await mkdtemp(path.join(tmpdir(), "agent-int-"));
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (error) {
      console.error(`  ✗ ${t.name}`);
      throw error;
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
  console.log(`\nintegration: ${passed}/${tests.length} 通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
