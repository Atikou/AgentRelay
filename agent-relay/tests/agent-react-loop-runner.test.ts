/**
 * AgentReactLoopRunner 单元测试。
 * 运行：npm run test:agent-react-loop-runner
 */
import assert from "node:assert/strict";

import type { AgentRunSession } from "../src/agent/AgentRunBootstrap.js";
import { runAgentReactLoop } from "../src/agent/AgentReactLoopRunner.js";
import { BudgetManager } from "../src/agent/BudgetManager.js";
import { defaultFinalizer } from "../src/agent/Finalizer.js";
import { defaultPlanHandoffStore } from "../src/policy/PlanHandoffStore.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { FailedActionMemory } from "../src/agent/recovery/FailedActionMemory.js";
import { RunToolResultCache } from "../src/agent/recovery/RunToolResultCache.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function baseSession(overrides: Partial<AgentRunSession> = {}): AgentRunSession {
  return {
    effectiveGoal: "测试",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "测试" },
    ],
    steps: [],
    modelTurns: 0,
    consumedNotifications: [],
    injectNotifications: () => {},
    ...overrides,
  };
}

function baseLoopCtx(overrides: {
  chat?: Parameters<typeof runAgentReactLoop>[0]["chat"];
  finishRun?: Parameters<typeof runAgentReactLoop>[0]["finishRun"];
} = {}) {
  const policy = resolveRunPolicy({
    requestedMode: "answer",
    forceMode: true,
    message: "测试",
  });
  const budgetManager = new BudgetManager(policy.budget, policy.suggestedBudget);
  budgetManager.markRunStarted();
  const defaultFinishRun: Parameters<typeof runAgentReactLoop>[0]["finishRun"] = async (input) => ({
    answer: input.answer,
    steps: input.steps,
    iterations: input.iterations,
    reachedLimit: input.reachedLimit,
    executionMeta: {
      stopReason: input.stopReason ?? "completed",
      mode: policy.mode,
      intent: policy.intent,
      workflowType: policy.workflowType,
      permissionPolicy: policy.permissionPolicy,
      budget: policy.budget,
      iterations: input.iterations,
      toolCalls: input.steps.length,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      blockedToolCalls: 0,
      preflightToolCalls: 0,
      modelTurns: input.iterations,
      userFacingState: "completed",
    },
  });
  return {
    chat: overrides.chat ?? (async () => ({
      content: '{"action":"final","answer":"OK"}',
      clientName: "mock",
      modelName: "mock",
      latencyMs: 1,
    })),
    maxModelTurns: policy.budget.maxModelTurns,
    budgetManager,
    policy,
    capabilityEscalations: [],
    failedActionMemory: new FailedActionMemory(policy.budget.maxRepeatedToolFailures),
    toolResultCache: new RunToolResultCache(),
    finalizer: defaultFinalizer,
    planHandoffStore: defaultPlanHandoffStore,
    getEffectiveIntent: () => policy.intent,
    getModelTurnMetrics: () => [],
    recordModelTurn: () => {},
    setRunRoutingMeta: () => {},
    getRunRoutingMeta: () => undefined,
    assertNotCancelled: () => {},
    isCancelledError: () => false,
    makeToolCallId: (i, tool) => `tc-${i}-${tool}`,
    writeAgentDecisionTrace: () => {},
    shouldCreatePlanHandoff: () => false,
    snapshotPausedRun: () => {},
    executeToolStep: async () => {
      throw new Error("executeToolStep should not be called");
    },
    recordToolStepMessages: () => {},
    maybeRunSystemRecovery: async () => {},
    runEditAutoVerification: async () => undefined,
    buildPartialAnswer: () => "partial",
    finishRun: overrides.finishRun ?? defaultFinishRun,
  };
}

test("非法 JSON 后纠偏并继续到 final", async () => {
  let calls = 0;
  const result = await runAgentReactLoop(
    baseLoopCtx({
      chat: async () => {
        calls++;
        if (calls === 1) {
          return {
            content: "not json",
            clientName: "mock",
            modelName: "mock",
            latencyMs: 1,
          };
        }
        return {
          content: '{"action":"final","answer":"第二轮"}',
          clientName: "mock",
          modelName: "mock",
          latencyMs: 1,
        };
      },
    }),
    baseSession(),
  );
  assert.equal(calls, 2);
  assert.equal(result.answer, "第二轮");
  assert.equal(result.iterations, 2);
});

test("final 动作调用 finishRun 并返回答案", async () => {
  let finishInput: { answer: string; iterations: number } | undefined;
  const policy = resolveRunPolicy({
    requestedMode: "answer",
    forceMode: true,
    message: "测试",
  });
  const result = await runAgentReactLoop(
    baseLoopCtx({
      finishRun: async (input) => {
        finishInput = { answer: input.answer, iterations: input.iterations };
        return {
          answer: input.answer,
          steps: input.steps,
          iterations: input.iterations,
          reachedLimit: false,
          executionMeta: {
            stopReason: "completed",
            mode: policy.mode,
            intent: policy.intent,
            workflowType: policy.workflowType,
            permissionPolicy: policy.permissionPolicy,
            budget: policy.budget,
            iterations: input.iterations,
            toolCalls: 0,
            successfulToolCalls: 0,
            failedToolCalls: 0,
            blockedToolCalls: 0,
            preflightToolCalls: 0,
            modelTurns: input.iterations,
            userFacingState: "completed",
          },
        };
      },
    }),
    baseSession(),
  );
  assert.equal(finishInput?.answer, "OK");
  assert.equal(finishInput?.iterations, 1);
  assert.equal(result.answer, "OK");
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\nagent-react-loop-runner: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
