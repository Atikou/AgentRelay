/**
 * AgentRunBootstrap 单元测试。
 * 运行：npm run test:agent-run-bootstrap
 */
import assert from "node:assert/strict";

import { bootstrapAgentRunSession } from "../src/agent/AgentRunBootstrap.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("无 ContextManager 时构建 system + user 消息", async () => {
  const policy = resolveRunPolicy({
    requestedMode: "answer",
    forceMode: true,
    message: "你好",
  });
  const result = await bootstrapAgentRunSession(
    {
      policy,
      getEffectiveIntent: () => policy.intent,
      buildSystemPrompt: () => "SYS",
      drainNotifications: () => [],
      runWorkflowExecutor: async () => ({
        steps: [],
        modelContexts: [],
        workflowProposals: [],
        workflowDebugAnalyses: [],
        workflowRefactorPlans: [],
        workflowInternalPlans: [],
      }),
      applyWorkflowResult: () => {},
      setWorkflowSwitch: () => {},
      getWorkflowProposals: () => [],
      recordPreflightTools: () => {},
      applyPlanHandoffSystemPrompt: () => {},
    },
    {
      userMessage: "你好",
      effectiveGoal: "你好",
      isResume: false,
      initialSteps: [],
      initialModelTurns: 0,
    },
  );
  assert.equal(result.session.messages.length, 2);
  assert.equal(result.session.messages[0]?.role, "system");
  assert.equal(result.session.messages[0]?.content, "SYS");
  assert.equal(result.session.messages[1]?.role, "user");
  assert.equal(result.session.messages[1]?.content, "你好");
});

test("pausedRun resumeMode 触发 plan handoff 系统提示替换", async () => {
  const policy = resolveRunPolicy({
    requestedMode: "implement",
    forceMode: true,
    message: "执行计划",
  });
  let handoffApplied = false;
  const messages = [
    { role: "system" as const, content: "OLD" },
    { role: "user" as const, content: "goal" },
  ];
  const pausedRun = {
    goal: "goal",
    messages: [...messages],
    steps: [],
    modelTurns: 1,
    resumeMode: "implement" as const,
    workflowProposals: [],
    workflowDebugAnalyses: [],
    workflowRefactorPlans: [],
    workflowInternalPlans: [],
    runtimeState: {},
  };
  const result = await bootstrapAgentRunSession(
    {
      policy,
      getEffectiveIntent: () => policy.intent,
      buildSystemPrompt: () => "EXEC_SYS",
      drainNotifications: () => [],
      runWorkflowExecutor: async () => ({
        steps: [],
        modelContexts: [],
        workflowProposals: [],
        workflowDebugAnalyses: [],
        workflowRefactorPlans: [],
        workflowInternalPlans: [],
      }),
      applyWorkflowResult: () => {},
      setWorkflowSwitch: () => {},
      getWorkflowProposals: () => [],
      recordPreflightTools: () => {},
      applyPlanHandoffSystemPrompt: (msgs, pr) => {
        handoffApplied = true;
        assert.equal(pr.resumeMode, "implement");
        msgs[0] = { role: "system", content: "EXEC_SYS\n\nhandoff" };
      },
    },
    {
      userMessage: "goal",
      effectiveGoal: "goal",
      isResume: false,
      pausedRun,
      initialSteps: [...pausedRun.steps],
      initialModelTurns: pausedRun.modelTurns,
    },
  );
  assert.equal(handoffApplied, true);
  assert.match(String(result.session.messages[0]?.content), /EXEC_SYS/);
});

test("工作流预扫描步骤并入 session.steps", async () => {
  const policy = resolveRunPolicy({
    requestedMode: "answer",
    forceMode: true,
    message: "查资料",
  });
  const preflightStep = {
    iteration: 0,
    tool: "locate_relevant_files",
    input: {},
    permission: "read" as const,
    preflight: true,
    ok: true,
  };
  const result = await bootstrapAgentRunSession(
    {
      policy,
      getEffectiveIntent: () => policy.intent,
      buildSystemPrompt: () => "SYS",
      drainNotifications: () => [],
      runWorkflowExecutor: async () => ({
        steps: [preflightStep],
        modelContexts: ["CTX"],
        workflowProposals: [],
        workflowDebugAnalyses: [],
        workflowRefactorPlans: [],
        workflowInternalPlans: [],
      }),
      applyWorkflowResult: () => {},
      setWorkflowSwitch: () => {},
      getWorkflowProposals: () => [],
      recordPreflightTools: () => {},
      applyPlanHandoffSystemPrompt: () => {},
    },
    {
      userMessage: "查资料",
      effectiveGoal: "查资料",
      isResume: false,
      initialSteps: [],
      initialModelTurns: 0,
    },
  );
  assert.equal(result.session.steps.length, 1);
  assert.equal(result.session.steps[0]?.tool, "locate_relevant_files");
  assert.ok(result.session.messages.some((m) => m.content === "CTX"));
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
console.log(`\nagent-run-bootstrap: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
