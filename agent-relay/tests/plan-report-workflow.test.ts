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
            "# Plan",
            "## 6. TodoList",
            "- [ ] P0 Keep workflow layered: goal / acceptance / risk",
            "This turn only creates a plan and changes no files.",
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
  assert.match(String(seenBody?.message), /organize plan service into workflow layer/);
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
