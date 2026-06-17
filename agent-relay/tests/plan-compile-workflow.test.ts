/**
 * PlanCompileWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\plan-compile-workflow.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PlanCompileWorkflow } from "../src/agent/PlanCompileWorkflow.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";
import { PlanValidationError, renderUserVisiblePlan } from "../src/plan/index.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { createTestPlanService } from "./planTestHelper.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

function createWorkflow(dataDir: string) {
  const ctx = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const registry = createDefaultRegistry({ dataDir });
  const planService = createTestPlanService({
    workspaceRoot: dataDir,
    db: ctx.db,
    registry,
  });
  return {
    ctx,
    registry,
    planService,
    workflow: new PlanCompileWorkflow({ planService }),
  };
}

test("compiles confirmed todos into an awaiting approval draft", async () => {
  const dataDir = path.join(tmpDir, "success");
  const { ctx, registry, planService, workflow } = createWorkflow(dataDir);
  const visible = planService.saveUserVisiblePlan(
    renderUserVisiblePlan({
      sourceRunId: "run-plan-compile",
      sessionId: "session-compile",
      goal: "Add automatic workflow compile step",
      markdown: [
        "# Plan",
        "## 6. TodoList",
        "- [ ] P0 Compile confirmed todos: generate InternalTaskPlan draft / verify preview / low",
        "- [ ] P1 Leave unrelated todos untouched: preserve later work / verify only selected item / low",
      ].join("\n"),
    }),
  );

  const result = await workflow.run({
    userVisiblePlanId: visible.id,
    confirmedTodoIds: [visible.todos[0]!.id],
  });
  const body = result.body as {
    status?: string;
    sourceUserVisiblePlanId?: string;
    publicPlanJson?: { executable?: boolean; steps?: unknown[] };
    previewMarkdown?: string;
    warning?: string;
  };

  assert.equal(result.status, 200);
  assert.equal(body.status, "awaiting_approval");
  assert.equal(body.sourceUserVisiblePlanId, visible.id);
  assert.equal(body.publicPlanJson?.executable, false);
  assert.equal(body.publicPlanJson?.steps?.length, 1);
  assert.match(body.previewMarkdown ?? "", /Compile confirmed todos/);
  assert.match(body.warning ?? "", /approve before execute/);
  const record = planService.getRecord(
    (result.body as { planId: string }).planId,
    (result.body as { version: number }).version,
  );
  assert.equal(record?.internal.steps[0]?.type, "tool_call");
  assert.ok(record?.internal.steps[0]?.toolName);
  ctx.close();
  registry.close();
});

test("keeps PlanService validation errors for bad compile input", async () => {
  const dataDir = path.join(tmpDir, "errors");
  const { ctx, registry, planService, workflow } = createWorkflow(dataDir);
  const visible = planService.saveUserVisiblePlan(
    renderUserVisiblePlan({
      sourceRunId: "run-plan-compile-error",
      goal: "Compile error path",
      markdown: ["# Plan", "## 6. TodoList", "- [ ] P0 Real todo: do thing / verify / low"].join("\n"),
    }),
  );

  await assert.rejects(
    () =>
      workflow.run({
        userVisiblePlanId: visible.id,
        confirmedTodoIds: ["missing-todo"],
      }),
    /confirmedTodoIds/,
  );
  await assert.rejects(
    () =>
      workflow.run({
        userVisiblePlanId: "missing-plan",
        confirmedTodoIds: ["todo-1"],
      }),
    (err: unknown) => err instanceof PlanValidationError && err.code === "INVALID_SCHEMA",
  );
  ctx.close();
  registry.close();
});

async function main() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-compile-workflow-"));
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
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\nplan-compile-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
