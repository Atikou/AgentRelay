/**
 * M7 安全与审计集成自检（无需网络）：AgentLoop / TaskRunner + Trace + 工具审计链路。
 * 运行：npm run test:m7-integration
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";
import { TaskRunner } from "../src/agent/TaskRunner.js";
import { ToolStepExecutor } from "../src/agent/ToolStepExecutor.js";
import type { Plan, PlanStep } from "../src/agent/types.js";
import { TraceLogger } from "../src/trace/TraceLogger.js";
import { readRecentTraceEvents } from "../src/trace/traceReader.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

const FAKE_SECRET = "sk-abcdefghijklmnopqrstuvwxyz1234567890";

type TraceEvent = Record<string, unknown>;

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
    };
  };
}

function auditEvents(events: TraceEvent[], tool?: string): TraceEvent[] {
  return events.filter(
    (e) => e.type === "tool_audit" && (tool === undefined || e.tool === tool),
  );
}

function makePlan(steps: Array<Partial<PlanStep> & { id: string; title: string }>): Plan {
  return {
    goal: "m7-audit",
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
      acceptance: s.acceptance,
      status: s.status ?? "pending",
    })),
  };
}

interface TraceWorkspace {
  sandbox: string;
  traceFile: string;
  trace: TraceLogger;
  /** 读取 trace 前先刷盘（WriteStream 需 end 后 readFile 才可靠）。 */
  flushTrace: () => Promise<void>;
}

async function withTraceWorkspace<T>(fn: (ctx: TraceWorkspace) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "m7-int-"));
  const sandbox = path.join(root, "ws");
  await fs.mkdir(sandbox, { recursive: true });
  const traceFile = path.join(root, "trace.jsonl");
  const trace = new TraceLogger(traceFile);
  let closed = false;
  const flushTrace = async () => {
    if (!closed) {
      closed = true;
      await trace.close();
    }
  };
  try {
    return await fn({ sandbox, traceFile, trace, flushTrace });
  } finally {
    await flushTrace();
    await rm(root, { recursive: true, force: true });
  }
}

test("集成：AgentLoop 只读工具写入 agent_tool 与 tool_audit 链路", async () => {
  await withTraceWorkspace(async ({ sandbox, traceFile, trace, flushTrace }) => {
    await fs.writeFile(path.join(sandbox, "note.txt"), "hello-audit", "utf-8");
    const registry = createDefaultRegistry(trace);
    const chat = scriptedChat([
      '{"action":"tool","tool":"read_file","input":{"path":"note.txt"}}',
      '{"action":"final","answer":"已读取"}',
    ]);
    const loop = new AgentLoop({ chat, registry, workspaceRoot: sandbox, trace });
    const res = await loop.run("读文件");
    assert.equal(res.steps[0]!.ok, true);

    await flushTrace();
    const events = readRecentTraceEvents(traceFile, { limit: 50, redact: false });
    const agentTool = events.find((e) => e.type === "agent_tool" && e.tool === "read_file");
    assert.ok(agentTool);
    const audits = auditEvents(events, "read_file");
    assert.ok(agentTool.toolCallId);
    assert.ok(audits.every((e) => e.toolCallId === agentTool.toolCallId));
    assert.ok(audits.some((e) => e.status === "start"));
    assert.ok(audits.some((e) => e.status === "ok"));
  });
});

test("集成：AgentLoop 每轮模型决策写入 agent_decision", async () => {
  await withTraceWorkspace(async ({ sandbox, traceFile, trace, flushTrace }) => {
    await fs.writeFile(path.join(sandbox, "decision.txt"), "hello-decision", "utf-8");
    const registry = createDefaultRegistry(trace);
    const chat = scriptedChat([
      '{"action":"tool","tool":"read_file","input":{"path":"decision.txt"},"thought":"需要读取文件"}',
      '{"action":"final","answer":"已读取"}',
    ]);
    const loop = new AgentLoop({
      chat,
      registry,
      workspaceRoot: sandbox,
      trace,
      runId: "run-decision",
      sessionId: "session-decision",
    });
    await loop.run("读文件");

    await flushTrace();
    const events = readRecentTraceEvents(traceFile, { limit: 80, redact: false });
    const decisions = events.filter((e) => e.type === "agent_decision");
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions.map((e) => e.action), ["tool", "final"]);
    assert.equal(decisions[0]!.tool, "read_file");
    assert.equal(decisions[0]!.runId, "run-decision");
    assert.equal(decisions[1]!.answerLength, 3);
  });
});

test("集成：含密钥的文件内容在 trace 预览中脱敏", async () => {
  await withTraceWorkspace(async ({ sandbox, traceFile, trace, flushTrace }) => {
    await fs.writeFile(
      path.join(sandbox, "secret.txt"),
      `token=${FAKE_SECRET}`,
      "utf-8",
    );
    const registry = createDefaultRegistry(trace);
    await registry.run("read_file", { path: "secret.txt" }, { workspaceRoot: sandbox });

    await flushTrace();
    const raw = await fs.readFile(traceFile, "utf-8");
    assert.equal(raw.includes(FAKE_SECRET), false, "trace 文件不应含明文密钥");
    const okAudit = auditEvents(readRecentTraceEvents(traceFile, { limit: 20, redact: false }), "read_file").find(
      (e) => e.status === "ok",
    );
    assert.ok(okAudit?.outputPreview);
    assert.equal(String(okAudit.outputPreview).includes(FAKE_SECRET), false);
  });
});

test("集成：危险 shell 经 ToolRegistry 拦截并记录 tool_audit error", async () => {
  await withTraceWorkspace(async ({ sandbox, traceFile, trace, flushTrace }) => {
    const registry = createDefaultRegistry(trace);
    const res = await registry.run("shell_run", { command: "rm -rf /" }, { workspaceRoot: sandbox });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /高风险/);

    await flushTrace();
    const audits = auditEvents(readRecentTraceEvents(traceFile, { limit: 20, redact: false }), "shell_run");
    assert.ok(audits.some((e) => e.status === "start"));
    assert.ok(audits.some((e) => e.status === "error"));
  });
});

test("集成：AgentLoop 副作用工具需 autoConfirm，否则不写 tool_audit", async () => {
  await withTraceWorkspace(async ({ sandbox, traceFile, trace, flushTrace }) => {
    const registry = createDefaultRegistry(trace);
    const chat = scriptedChat([
      '{"action":"tool","tool":"shell_run","input":{"command":"node -v"}}',
      '{"action":"final","answer":"完成"}',
    ]);
    const loop = new AgentLoop({ chat, registry, workspaceRoot: sandbox, trace, autoConfirm: false });
    const res = await loop.run("查 node 版本");
    assert.equal(res.steps[0]!.blocked, true);

    await flushTrace();
    const events = readRecentTraceEvents(traceFile, { limit: 20, redact: false });
    assert.equal(events.some((e) => e.type === "tool_audit"), false);
    assert.equal(events.some((e) => e.type === "agent_tool"), false);
  });
});

test("集成：TaskRunner + ToolStepExecutor 写入 task_step 与 tool_audit", async () => {
  await withTraceWorkspace(async ({ sandbox, traceFile, trace, flushTrace }) => {
    const registry = createDefaultRegistry(trace);
    const plan = makePlan([
      {
        id: "list",
        title: "列工作区",
        tool: "list_files",
        toolInput: { path: "." },
        requiredPermissions: ["read"],
      },
    ]);
    const runner = new TaskRunner(plan, {
      executor: new ToolStepExecutor({
        registry,
        workspaceRoot: sandbox,
        requestId: "run-task-status",
        taskId: "task-status",
      }),
      autoConfirm: true,
      trace,
      runId: "run-task-status",
      taskId: "task-status",
    });
    const result = await runner.run();
    assert.equal(result.steps[0]!.status, "completed");

    await flushTrace();
    const events = readRecentTraceEvents(traceFile, { limit: 40, redact: false });
    const taskStep = events.find((e) => e.type === "task_step" && e.step === "list" && e.status === "completed");
    assert.ok(taskStep);
    assert.equal(taskStep.toolCallId, "run-task-status:step-list:list_files");
    assert.ok(
      events.some(
        (e) =>
          e.type === "task_status_change" &&
          e.scope === "step" &&
          e.step === "list" &&
          e.from === "pending" &&
          e.to === "running" &&
          e.taskId === "task-status",
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "task_status_change" &&
          e.scope === "task" &&
          e.to === "completed" &&
          e.runId === "run-task-status",
      ),
    );
    const audits = auditEvents(events, "list_files");
    assert.ok(audits.every((e) => e.toolCallId === taskStep.toolCallId));
    assert.ok(audits.some((e) => e.status === "start"));
    assert.ok(audits.some((e) => e.status === "ok"));
  });
});

test("集成：readRecentTraceEvents 可汇总完整审计链路并二次脱敏", async () => {
  await withTraceWorkspace(async ({ sandbox, traceFile, trace, flushTrace }) => {
    const registry = createDefaultRegistry(trace);
    trace.write({ type: "setup", apiKey: FAKE_SECRET });
    await registry.run(
      "read_file",
      { path: "missing.txt" },
      { workspaceRoot: sandbox },
    );

    await flushTrace();
    const exported = readRecentTraceEvents(traceFile, { limit: 50, redact: true });
    assert.ok(exported.length >= 2);
    const blob = JSON.stringify(exported);
    assert.equal(blob.includes(FAKE_SECRET), false);
    assert.ok(auditEvents(exported, "read_file").some((e) => e.status === "error"));
  });
});

async function main() {
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
  console.log(`\nm7-integration: ${passed}/${tests.length} 通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
