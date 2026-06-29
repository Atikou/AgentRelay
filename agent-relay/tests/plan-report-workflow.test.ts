/**
 * PlanReportWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\plan-report-workflow.test.ts
 */
import assert from "node:assert/strict";

import { PlanReportWorkflow } from "../src/agent/PlanReportWorkflow.js";
import type { UserVisiblePlan } from "../src/plan/types.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("PlanReportWorkflow runs plan agent and saves UserVisiblePlan", async () => {
  const saved: UserVisiblePlan[] = [];
  let seenBody: Record<string, unknown> | undefined;
  const workflow = new PlanReportWorkflow({
    planService: {
      saveUserVisiblePlan(plan) {
        saved.push(plan);
        return plan;
      },
    },
    async runAgent(body) {
      seenBody = body as Record<string, unknown>;
      return {
        status: 200,
        body: {
          runId: "run-plan-report",
          sessionId: "session-1",
          answer: [
            "# 计划模式分析结果",
            "## 1. 任务理解",
            "organize plan service into workflow layer",
            "## 2. 只读扫描结果",
            "已扫描 plan 模块与 agent 工作流目录，确认 PlanReportWorkflow、PlanService、PlanCompileWorkflow 分层边界。",
            "主要入口：src/agent/PlanReportWorkflow.ts、src/plan/PlanService.ts；建议将报告生成与 internal 落盘彻底分离。",
            "当前测试覆盖 plan-report-workflow 与 plan-compile-workflow，缺少 analyze 质量门回归。",
            "## 6. TodoList",
            "- [ ] P0 Keep workflow layered: goal / acceptance / risk",
            "本次仅生成计划，未修改任何文件。",
          ].join("\n"),
          executionMeta: { mode: "plan", workflowType: "planWorkflow" },
        },
      };
    },
  });

  const result = await workflow.run({
    goal: "organize plan service into workflow layer",
    context: "Use read-only analysis.",
    sessionId: "session-1",
    clientName: "local-test",
    budget: { maxModelTurns: 1 },
  });

  assert.equal(result.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.sourceRunId, "run-plan-report");
  assert.equal(saved[0]!.sessionId, "session-1");
  assert.equal(saved[0]!.kind, "user_visible_plan");
  assert.ok(saved[0]!.todos.length >= 1);
  assert.equal((result.body as { userVisiblePlan: UserVisiblePlan }).userVisiblePlan.id, saved[0]!.id);
  assert.equal(seenBody?.mode, "plan");
  assert.equal(seenBody?.clientName, "local-test");
  assert.equal(seenBody?.autoConfirm, false);
  assert.equal(seenBody?.sensitive, true);
  assert.equal(seenBody?.skipPlanHandoff, true);
  assert.equal(seenBody?.forceMode, true);
  assert.match(String(seenBody?.message), /organize plan service into workflow layer/);
});

test("PlanReportWorkflow rejects empty model answer without tool steps", async () => {
  const saved: UserVisiblePlan[] = [];
  const workflow = new PlanReportWorkflow({
    planService: {
      saveUserVisiblePlan(plan) {
        saved.push(plan);
        return plan;
      },
    },
    async runAgent() {
      return {
        status: 200,
        body: {
          runId: "run-empty",
          answer: "",
          steps: [],
        },
      };
    },
  });

  const result = await workflow.run({ goal: "analyze architecture" });
  assert.equal(result.status, 422);
  assert.equal(saved.length, 0);
  assert.equal((result.body as { code?: string }).code, "PLAN_REPORT_QUALITY_LOW");
});

test("PlanReportWorkflow enriches from tool steps when model answer is empty", async () => {
  const saved: UserVisiblePlan[] = [];
  const workflow = new PlanReportWorkflow({
    planService: {
      saveUserVisiblePlan(plan) {
        saved.push(plan);
        return plan;
      },
    },
    async runAgent() {
      return {
        status: 200,
        body: {
          runId: "run-enrich",
          answer: "",
          steps: [
            {
              iteration: 0,
              tool: "project_scan",
              input: {},
              ok: true,
              preflight: true,
              output: "app/\npages/",
            },
          ],
        },
      };
    },
  });

  const result = await workflow.run({ goal: "analyze nextjs app" });
  assert.equal(result.status, 200);
  assert.equal(saved.length, 1);
  assert.ok(saved[0]!.todos.length >= 1);
  assert.match(saved[0]!.markdown, /只读扫描结果/);
  assert.equal((result.body as { reportEnriched?: boolean }).reportEnriched, true);
});

test("PlanReportWorkflow returns non-200 agent result without saving", async () => {
  const saved: UserVisiblePlan[] = [];
  const workflow = new PlanReportWorkflow({
    planService: {
      saveUserVisiblePlan(plan) {
        saved.push(plan);
        return plan;
      },
    },
    async runAgent() {
      return { status: 502, body: { error: "model failed" } };
    },
  });

  const result = await workflow.run({ goal: "create plan" });
  assert.equal(result.status, 502);
  assert.equal(saved.length, 0);
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${t.name}`);
      console.error(error);
      failed += 1;
    }
  }
  console.log(`\nplan-report-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
