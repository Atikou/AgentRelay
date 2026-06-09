/**
 * Agent 对话循环自检（无需网络）：用假 chat 驱动 ReAct 协议。
 * 运行：npm run test:loop
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentLoop, parseAction, type LoopChatFn } from "../src/agent/AgentLoop.js";
import type { ModelResponse } from "../src/model/types.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";

/** 返回一个按脚本逐条回复的假 chat：每次调用弹出下一条 content。 */
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

test("parseAction 能从夹杂文本/围栏中提取 JSON 动作", async () => {
  const a = parseAction('好的\n```json\n{"action":"final","answer":"hi"}\n```');
  assert.equal(a?.action, "final");
  const b = parseAction('{"action":"tool","tool":"read_file","input":{"path":"a"}}');
  assert.equal(b?.action, "tool");
  assert.equal(parseAction("没有 JSON"), null);
});

test("循环：调用只读工具后给出最终答案", async () => {
  await fs.writeFile(path.join(sandbox, "name.txt"), "项目名=agent-relay", "utf-8");
  const chat = scriptedChat([
    '{"action":"tool","tool":"read_file","input":{"path":"name.txt"},"thought":"先读"}',
    '{"action":"final","answer":"项目名是 agent-relay"}',
  ]);
  const loop = new AgentLoop({ chat, registry: createDefaultRegistry(), workspaceRoot: sandbox });
  const res = await loop.run("项目名是什么？");
  assert.equal(res.reachedLimit, false);
  assert.equal(res.steps.length, 1);
  assert.equal(res.steps[0]!.ok, true);
  assert.match(res.answer, /agent-relay/);
});

test("未开启自动确认时写工具被阻塞", async () => {
  const chat = scriptedChat([
    '{"action":"tool","tool":"write_file","input":{"path":"x.txt","content":"y"}}',
    '{"action":"final","answer":"完成"}',
  ]);
  const loop = new AgentLoop({ chat, registry: createDefaultRegistry(), workspaceRoot: sandbox });
  const res = await loop.run("写个文件");
  assert.equal(res.steps[0]!.blocked, true);
  // 文件不应被创建
  await assert.rejects(fs.access(path.join(sandbox, "x.txt")));
});

test("开启自动确认时写工具可执行", async () => {
  const chat = scriptedChat([
    '{"action":"tool","tool":"write_file","input":{"path":"w.txt","content":"hello"}}',
    '{"action":"final","answer":"已写入"}',
  ]);
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    autoConfirm: true,
  });
  const res = await loop.run("写个文件");
  assert.equal(res.steps[0]!.ok, true);
  assert.equal(await fs.readFile(path.join(sandbox, "w.txt"), "utf-8"), "hello");
});

test("达到迭代上限时返回 reachedLimit", async () => {
  // 始终请求工具，永不 final。
  const chat: LoopChatFn = async () => ({
    content: '{"action":"tool","tool":"list_files","input":{"path":"."}}',
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    maxIterations: 3,
  });
  const res = await loop.run("一直列目录");
  assert.equal(res.reachedLimit, true);
  assert.equal(res.iterations, 3);
});

test("未知工具不会中断循环，可继续到 final", async () => {
  const chat = scriptedChat([
    '{"action":"tool","tool":"does_not_exist","input":{}}',
    '{"action":"final","answer":"换个思路"}',
  ]);
  const loop = new AgentLoop({ chat, registry: createDefaultRegistry(), workspaceRoot: sandbox });
  const res = await loop.run("调用不存在的工具");
  assert.equal(res.steps[0]!.ok, false);
  assert.equal(res.reachedLimit, false);
  assert.match(res.answer, /换个思路/);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-"));
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  \u2717 ${t.name}\n    ${String(error)}`);
      failed += 1;
    }
  }
  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();
