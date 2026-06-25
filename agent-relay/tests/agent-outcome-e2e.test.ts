/**
 * Agent 工具 outcome 端到端链路测试（假 chat 驱动 ReAct）。
 * 运行：npm run test:agent-outcome-e2e
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import type { ModelResponse } from "../src/model/types.js";
import { createDefaultRegistry } from "../src/tools/index.js";

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

function e2ePolicy(overrides: Parameters<typeof resolveRunPolicy>[0] = {}) {
  return resolveRunPolicy({
    forceMode: true,
    requestedMode: "implement",
    autoConfirm: true,
    ...overrides,
  });
}

test("用例1：read_file not_found 后第二次同路径被 blocked", async () => {
  const chat = scriptedChat([
    '{"action":"tool","tool":"read_file","input":{"path":"testTS/index.html"}}',
    '{"action":"tool","tool":"read_file","input":{"path":"testTS/index.html"}}',
    '{"action":"final","answer":"停止"}',
  ]);
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    policy: e2ePolicy({ message: "启动 Vite 项目", requestedPermissionPolicy: "autoEdit" }),
    budget: { maxModelTurns: 8, maxToolCalls: 10, maxReadCalls: 8, maxWriteCalls: 2, maxShellCalls: 2, maxRuntimeMs: 60000 },
  });
  const res = await loop.run("启动 Vite 项目");
  const reads = res.steps.filter((s) => s.tool === "read_file");
  assert.equal(reads.length, 2);
  assert.equal(reads[0]?.outcomeClass, "observation_failure");
  assert.equal(reads[0]?.outcomeKind, "not_found");
  assert.equal(reads[1]?.blocked, true);
});

test("用例5：write_file 后 read_file 同路径允许验证", async () => {
  const chat = scriptedChat([
    '{"action":"tool","tool":"read_file","input":{"path":"testTS/index.html"}}',
    '{"action":"tool","tool":"write_file","input":{"path":"testTS/index.html","content":"<html></html>","backup":false}}',
    '{"action":"tool","tool":"read_file","input":{"path":"testTS/index.html"}}',
    '{"action":"final","answer":"已创建并验证"}',
  ]);
  const base = e2ePolicy({ message: "补齐 index.html", requestedPermissionPolicy: "autoEdit" });
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    policy: { ...base, intent: "answer" },
    autoConfirm: true,
    budget: { maxModelTurns: 10, maxToolCalls: 12, maxReadCalls: 8, maxWriteCalls: 3, maxShellCalls: 2, maxRuntimeMs: 60000 },
  });
  const res = await loop.run("补齐 testTS/index.html");
  const reads = res.steps.filter((s) => s.tool === "read_file");
  const write = res.steps.find((s) => s.tool === "write_file");
  assert.ok(write?.executed, `write_file 应执行成功，实际: ${write?.error ?? write?.blocked}`);
  assert.equal(reads.length, 2);
  assert.equal(reads[0]?.outcomeKind, "not_found");
  assert.notEqual(reads[1]?.blocked, true);
  assert.equal(reads[1]?.outcomeClass, "observation_success");
});

test("用例3：shell_run 非零退出为 command_failed 非 execution_error", async () => {
  const cmd = process.platform === "win32" ? "exit 1" : "false";
  const chat = scriptedChat([
    `{"action":"tool","tool":"shell_run","input":{"command":"${cmd}"}}`,
    '{"action":"final","answer":"构建失败已记录"}',
  ]);
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    policy: e2ePolicy({ message: "运行构建检查", requestedPermissionPolicy: "autoRun" }),
    budget: { maxModelTurns: 5, maxToolCalls: 6, maxReadCalls: 4, maxWriteCalls: 1, maxShellCalls: 3, maxRuntimeMs: 60000 },
  });
  const res = await loop.run("运行构建检查");
  const shell = res.steps.find((s) => s.tool === "shell_run");
  assert.ok(shell, `应有 shell 步骤，实际 steps: ${res.steps.map((s) => s.tool).join(",")}`);
  assert.equal(shell!.executed, true);
  assert.equal(shell!.outcomeClass, "observation_failure");
  assert.equal(shell!.outcomeKind, "command_failed");
});

test("用例2：search_text no_results 后第二次同 query 被 blocked", async () => {
  await writeFile(path.join(sandbox, "readme.txt"), "hello vite", "utf8");
  const chat = scriptedChat([
    '{"action":"tool","tool":"search_text","input":{"query":"zzzz-no-match-xyz","root":"."}}',
    '{"action":"tool","tool":"search_text","input":{"query":"zzzz-no-match-xyz","root":"."}}',
    '{"action":"final","answer":"停止"}',
  ]);
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    policy: e2ePolicy({ message: "搜索入口文件", requestedPermissionPolicy: "autoEdit" }),
    budget: { maxModelTurns: 8, maxToolCalls: 10, maxReadCalls: 8, maxWriteCalls: 1, maxShellCalls: 2, maxRuntimeMs: 60000 },
  });
  const res = await loop.run("搜索入口文件");
  const searches = res.steps.filter((s) => s.tool === "search_text");
  assert.equal(searches.length, 2);
  assert.equal(searches[0]?.outcomeKind, "no_results");
  assert.equal(searches[1]?.blocked, true);
});

test("用例4：shell_run 命令不存在为 command_not_found", async () => {
  const chat = scriptedChat([
    '{"action":"tool","tool":"shell_run","input":{"command":"agent_relay_nonexistent_cmd_xyz_999"}}',
    '{"action":"final","answer":"命令不存在"}',
  ]);
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    policy: e2ePolicy({ message: "运行未知命令", requestedPermissionPolicy: "autoRun" }),
    budget: { maxModelTurns: 5, maxToolCalls: 6, maxReadCalls: 4, maxWriteCalls: 1, maxShellCalls: 3, maxRuntimeMs: 60000 },
  });
  const res = await loop.run("运行未知命令");
  const shell = res.steps.find((s) => s.tool === "shell_run");
  assert.ok(shell);
  assert.equal(shell!.outcomeKind, "command_not_found");
  assert.equal(shell!.outcomeClass, "observation_failure");
});

let passed = 0;
let failed = 0;
(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "agent-outcome-e2e-"));
  await writeFile(path.join(sandbox, "package.json"), JSON.stringify({ name: "testTS", scripts: { dev: "vite" } }), "utf8");
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(error);
    }
  }
  console.log(`\nagent-outcome-e2e: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
