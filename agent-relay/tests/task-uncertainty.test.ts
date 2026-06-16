/**
 * 任务不确定性检测与计划模式回退自检。
 * 运行：npm run test:task-uncertainty
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Planner } from "../src/agent/Planner.js";
import { ALL_PERMISSIONS } from "../src/core/permissions.js";
import { PlanSchema } from "../src/agent/types.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { Orchestrator } from "../src/orchestrator/Orchestrator.js";
import { RunStore } from "../src/orchestrator/RunStore.js";
import { RunStateStore } from "../src/orchestrator/RunStateStore.js";
import {
  buildPlanFallbackContext,
  detectTaskUncertainty,
} from "../src/orchestrator/taskUncertainty.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { createTestPlanService } from "./planTestHelper.js";
import { createTestOrchestrator } from "./orchestratorTestHelper.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("detectTaskUncertainty 识别 blocked 与 failed", () => {
  const plan = PlanSchema.parse({
    goal: "g",
    steps: [
      { id: "a", title: "A", status: "completed" },
      { id: "b", title: "B", status: "blocked", error: "等待用户确认" },
      { id: "c", title: "C", status: "failed", error: "boom" },
    ],
  });
  const u = detectTaskUncertainty(plan);
  assert.equal(u.uncertain, true);
  assert.equal(u.reasons.length, 2);
  assert.match(u.reasons[0]!, /阻塞/);
  assert.match(u.reasons[1]!, /失败/);
});

test("detectTaskUncertainty 全部完成时不触发", () => {
  const plan = PlanSchema.parse({
    goal: "g",
    steps: [{ id: "a", title: "A", status: "completed" }],
  });
  assert.equal(detectTaskUncertainty(plan).uncertain, false);
});

test("buildPlanFallbackContext 含步骤状态与原因", () => {
  const plan = PlanSchema.parse({
    goal: "原目标",
    steps: [{ id: "s1", title: "写", status: "failed", error: "权限不足" }],
  });
  const text = buildPlanFallbackContext(plan, ["步骤 s1 失败"]);
  assert.match(text, /原目标|修订/);
  assert.match(text, /s1/);
  assert.match(text, /权限不足/);
});

let sandbox = "";
let dataDir = "";
let ctx: ContextManager;
let runs: RunStore;
let runStateStore: RunStateStore;

test("Orchestrator fallbackToPlanOnUncertainty 返回 revisedPlan", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const revised = PlanSchema.parse({
    goal: "修订计划",
    steps: [{ id: "r1", title: "先只读排查", requiredPermissions: ["read"] }],
  });
  const stubPlanner = {
    generatePlan: async (goal: string, context?: string) => {
      assert.equal(goal, "遇阻任务");
      assert.ok(context?.includes("不确定原因"));
      return revised;
    },
  } as unknown as Planner;

  const { orchestrator } = createTestOrchestrator({
    workspaceRoot: sandbox,
    modelRouter: {} as never,
    planner: stubPlanner,
    registry,
    contextManager: ctx,
    tasks: ctx.tasks,
    runs,
    runStateStore,
    notificationQueue: { drain: () => [] } as never,
    makeChatFn: () => async () => {
      throw new Error("不应调用 chat");
    },
    planService: createTestPlanService({ workspaceRoot: sandbox, db: ctx.db, registry }),
    projectAllowedPermissions: ALL_PERMISSIONS,
  });

  const plan = PlanSchema.parse({
    goal: "遇阻任务",
    steps: [
      {
        id: "s1",
        title: "需确认",
        requiredPermissions: ["write"],
        needsConfirmation: true,
        status: "pending",
      },
    ],
  });

  const result = await orchestrator.runTask(
    { plan, autoConfirm: false, fallbackToPlanOnUncertainty: true },
    true,
    stubPlanner,
  );
  assert.equal(result.status, 200);
  const body = result.body as {
    plan: { steps: Array<{ status: string }> };
    modeFallback?: { revisedPlan?: { goal: string }; planRunId?: string };
  };
  assert.equal(body.plan.steps[0]!.status, "blocked");
  assert.equal(body.modeFallback?.revisedPlan?.goal, "修订计划");
  assert.ok(body.modeFallback?.planRunId);
  registry.close();
});

test("Orchestrator 未开启 fallback 时不生成 modeFallback", async () => {
  const registry = createDefaultRegistry({ dataDir });
  const { orchestrator } = createTestOrchestrator({
    workspaceRoot: sandbox,
    modelRouter: {} as never,
    planner: {} as never,
    registry,
    contextManager: ctx,
    tasks: ctx.tasks,
    runs,
    runStateStore,
    notificationQueue: {} as never,
    makeChatFn: () => async () => {
      throw new Error("no chat");
    },
    planService: createTestPlanService({ workspaceRoot: sandbox, db: ctx.db, registry }),
    projectAllowedPermissions: ALL_PERMISSIONS,
  });
  const plan = PlanSchema.parse({
    goal: "x",
    steps: [
      {
        id: "s1",
        title: "需确认",
        requiredPermissions: ["write"],
        needsConfirmation: true,
        status: "pending",
      },
    ],
  });
  const result = await orchestrator.runTask({ plan, autoConfirm: false }, true);
  assert.equal((result.body as { modeFallback?: unknown }).modeFallback, undefined);
  registry.close();
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-unc-"));
  dataDir = path.join(sandbox, "data");
  await fs.mkdir(dataDir, { recursive: true });
  ctx = new ContextManager({ dataDir, useLanceDb: false });
  runs = new RunStore(ctx.db);
  runStateStore = new RunStateStore(ctx.db);

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
  ctx.db.close();
  try {
    await fs.rm(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows 偶发 EBUSY */
  }
  console.log(`\ntask-uncertainty: ${passed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
