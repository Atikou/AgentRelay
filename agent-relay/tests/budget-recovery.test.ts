/**

 * 运行预算分层、工具缓存与系统恢复自检。

 * 运行：npx tsx tests/budget-recovery.test.ts

 */

import assert from "node:assert/strict";

import { promises as fs } from "node:fs";

import os from "node:os";

import path from "node:path";



import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";

import { BudgetManager } from "../src/agent/BudgetManager.js";

import { FailedActionMemory } from "../src/agent/recovery/FailedActionMemory.js";

import { RunToolResultCache } from "../src/agent/recovery/RunToolResultCache.js";

import { planSystemRecovery } from "../src/agent/recovery/SystemToolRecovery.js";

import { resolveRunPolicy } from "../src/agent/RunPolicy.js";

import { defaultFinalizer } from "../src/agent/Finalizer.js";

import type { ModelResponse } from "../src/model/types.js";

import { resolveToolOutcome } from "../src/tools/toolOutcome.js";

import { createDefaultRegistry } from "../src/tools/index.js";



const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>) {

  tests.push({ name, fn });

}



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



test("RunBudget 含分层字段 preflight / recovery / repeat", () => {

  const policy = resolveRunPolicy({ requestedMode: "chat", forceMode: true, message: "x" });

  assert.ok(policy.budget.maxPreflightTools > 0);

  assert.ok(policy.budget.maxRecoveryTurns > 0);

  assert.equal(policy.budget.maxRepeatedToolFailures, 1);

});



test("FailedActionMemory 第 2 次相同 tool+input 直接熔断", () => {

  const memory = new FailedActionMemory(1);

  memory.record({

    iteration: 1,

    tool: "project_scan",

    input: { root: "/bad" },

    ok: false,

    executed: true,

    outcomeClass: "execution_error",

    outcomeKind: "tool_crash",

    error: "crash",

  });

  const blocked = memory.assess({ tool: "project_scan", input: { root: "/bad" } });

  assert.ok(blocked?.blocked);

});



test("RunToolResultCache 同 input 命中", () => {

  const cache = new RunToolResultCache();

  const input = { path: "a.ts" };

  cache.store("read_file", input, { path: "a.ts", content: "hello", found: true });

  const hit = cache.lookup("read_file", input);

  assert.ok(hit);

});



test("project_scan 空结果归类 no_project_info 而非 tool_crash", () => {

  const outcome = resolveToolOutcome("project_scan", {

    scannedFiles: 0,

    importantFiles: [],

    sourceRoots: [],

    root: ".",

  });

  assert.equal(outcome.class, "observation_failure");

  assert.equal(outcome.kind, "no_project_info");

});



test("planSystemRecovery project_scan 失败给出 list_files fallback", () => {

  const plan = planSystemRecovery(

    {

      iteration: 1,

      tool: "project_scan",

      input: { root: "/testTs" },

      ok: false,

      outcomeClass: "execution_error",

      outcomeKind: "tool_crash",

      error: "sandbox",

    },

    "testTS 项目增强星空",

  );

  assert.ok(plan);

  assert.equal(plan!.actions[0]?.tool, "list_files");

});



test("重复 read_file 第二次走缓存，不增加 readCalls", async () => {

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "budget-cache-"));

  const filePath = path.join(sandbox, "demo.txt");

  await fs.writeFile(filePath, "cached-content", "utf-8");



  const chat = scriptedChat([

    '{"action":"tool","tool":"read_file","input":{"path":"demo.txt"},"thought":"r1"}',

    '{"action":"tool","tool":"read_file","input":{"path":"demo.txt"},"thought":"r2"}',

    '{"action":"final","answer":"done"}',

  ]);

  const policy = resolveRunPolicy({

    message: "读文件",

    permissionPolicy: "autoRun",

    budget: { maxModelTurns: 4, maxReadCalls: 2 },

  });

  const loop = new AgentLoop({

    chat,

    registry: createDefaultRegistry(),

    workspaceRoot: sandbox,

    policy,

    runId: "cache-run",

  });

  const res = await loop.run("读 demo.txt");

  assert.equal(res.steps.length, 2);

  assert.equal(res.steps.filter((s) => s.cached).length, 1);

  assert.equal(res.executionMeta.usage.readCalls, 1);

  assert.equal(res.executionMeta.usage.cachedToolHits, 1);

  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

});



test("project_scan 失败后系统自动 recovery，不额外消耗 model turn", async () => {

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "budget-recovery-"));

  await fs.mkdir(path.join(sandbox, "testTS"), { recursive: true });

  await fs.writeFile(path.join(sandbox, "testTS", "note.txt"), "x", "utf-8");



  const chat = scriptedChat([

    '{"action":"tool","tool":"project_scan","input":{"root":"/testTs"},"thought":"scan"}',

    '{"action":"final","answer":"已了解目录"}',

  ]);

  const policy = resolveRunPolicy({

    message: "testTS 项目",

    permissionPolicy: "autoRun",

    budget: { maxModelTurns: 2, maxRecoveryTurns: 2 },

  });

  const loop = new AgentLoop({

    chat,

    registry: createDefaultRegistry(),

    workspaceRoot: sandbox,

    policy,

    runId: "recovery-run",

  });

  const res = await loop.run("testTS 项目");

  assert.ok(res.steps.some((s) => s.systemRecovery && s.tool === "list_files"));
  assert.equal(res.steps.filter((s) => s.tool === "project_scan" && !s.preflight).length, 1);
  assert.ok((res.executionMeta.usage.recoveryTurns ?? 0) >= 1);
  assert.ok(res.executionMeta.usage.modelTurns <= 2);

  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

});



test("Finalizer partial 含已完成/未完成/原因结构", () => {

  const policy = resolveRunPolicy({ requestedMode: "chat", forceMode: true, message: "x" });

  const mgr = new BudgetManager(policy.budget, policy.suggestedBudget);

  mgr.markRunStarted();

  const text = defaultFinalizer.buildPartialAnswer({

    steps: [

      {

        iteration: 1,

        tool: "list_files",

        input: { root: "." },

        permission: "read",

        ok: true,

        executed: true,

        outcomeClass: "observation_success",

        resultLayers: {

          raw: {},

          modelVisible: {},

          userDisplay: { tool: "list_files", truncated: false, summary: "列出 4 个条目" },

          rawJsonLength: 1,

          modelJsonLength: 1,

        },

      },

    ],

    budgetExhausted: "maxModelTurns",

    budgetManager: mgr,

    mode: "chat",

    goal: "改星空",

  });

  assert.match(text, /已完成/);

  assert.match(text, /未完成/);

  assert.match(text, /原因/);

  assert.match(text, /尚未修改文件/);

});



let passed = 0;

let failed = 0;

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

console.log(`\nbudget-recovery: ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);


