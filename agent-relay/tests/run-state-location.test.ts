/**
 * RunState 定位上下文提取自检。
 * 运行：npm run test:run-state-location
 */
import assert from "node:assert/strict";

import { extractLocationContextFromSteps } from "../src/orchestrator/runStateLocation.js";
import { buildRunStateFromAgentRun } from "../src/orchestrator/runStateTypes.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("extractLocationContextFromSteps 从 locate 步骤提取 searchPlan 与 visitedFiles", () => {
  const location = extractLocationContextFromSteps([
    { iteration: 0, tool: "project_scan", input: {}, ok: true },
    {
      iteration: 0,
      tool: "locate_relevant_files",
      input: { goal: "分析路由" },
      ok: true,
      output: {
        projectId: "default",
        searchPlan: {
          goal: "分析路由",
          keywords: ["路由", "router"],
          possibleSymbols: ["RuleRouter"],
          possiblePaths: ["src/model-router"],
          exclude: [],
          taskType: "architecture_or_code_edit",
        },
        primaryFiles: [{ path: "src/model-router/route-rules.ts", score: 0.9, reason: "x", matchTypes: [] }],
        candidateFiles: [{ path: "src/model-router/types.ts", score: 0.6, reason: "y", matchTypes: [] }],
        locateStats: {
          visitedFiles: ["src/model-router/route-rules.ts"],
          visitedDirs: ["src/model-router"],
        },
      },
    },
    { iteration: 1, tool: "read_file", input: { path: "package.json" }, ok: true },
  ]);
  assert.ok(location);
  assert.equal(location!.searchPlan?.keywords.includes("router"), true);
  assert.deepEqual(location!.visitedFiles, [
    "src/model-router/route-rules.ts",
    "package.json",
  ]);
  assert.deepEqual(location!.visitedDirs, ["src/model-router"]);
  assert.equal(location!.primaryFiles[0], "src/model-router/route-rules.ts");
  assert.equal(location!.candidateFiles[0], "src/model-router/types.ts");
});

test("buildRunStateFromAgentRun 写入 location 与 ProjectIndex 统计", () => {
  const state = buildRunStateFromAgentRun({
    runId: "r1",
    goal: "只读分析当前项目结构",
    mode: "plan",
    steps: [
      { iteration: 0, tool: "project_scan", input: {}, ok: true },
      {
        iteration: 0,
        tool: "locate_relevant_files",
        input: {},
        ok: true,
        output: {
          searchPlan: { goal: "只读分析", keywords: ["项目"], possibleSymbols: [], possiblePaths: [], exclude: [], taskType: "unknown" },
          locateStats: { visitedFiles: [], visitedDirs: ["src"] },
          primaryFiles: [],
          candidateFiles: [],
        },
      },
    ],
    executionMeta: {
      mode: "plan",
      budget: resolveRunPolicy({ requestedMode: "plan", message: "x" }).budget,
      usage: {
        modelTurns: 1,
        toolCalls: 2,
        readCalls: 2,
        writeCalls: 0,
        shellCalls: 0,
        runtimeMs: 1,
      },
      usedIterations: 1,
      usedModelTurns: 1,
      usedToolCalls: 2,
      usedReadCalls: 2,
      usedWriteCalls: 0,
      usedShellCalls: 0,
      stopReason: "budget_exhausted",
      needsMoreBudget: true,
      budgetExhausted: "maxModelTurns",
    },
    projectIndexStats: { fileCount: 42, symbolCount: 10 },
  });
  assert.ok(state);
  assert.ok(state!.location);
  assert.equal(state!.location!.indexFileCount, 42);
  assert.equal(state!.location!.indexSymbolCount, 10);
  assert.deepEqual(state!.pendingSteps, ["context_pack"]);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\nrun-state-location: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
