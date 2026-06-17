/**
 * Plan Activation Layer self-check.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { finalizePlan } from "../src/agent/taskGraph.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";
import {
  PlanActivationWorkflow,
  PlanApprovalManager,
  PlanService,
  PlanStore,
  PlanValidator,
  bindPlanTools,
  canAutoApprovePlan,
  defaultConfirmedTodoIds,
  detectPlanActivationIntent,
  internalPlanFromLegacy,
  planRequiresHumanApproval,
  renderUserVisiblePlan,
} from "../src/plan/index.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

function createPlanService(dataDir: string) {
  const ctx = new ContextManager({
    dataDir,
    workspaceRoot: dataDir,
    vectorStore: new InMemoryVectorStore(),
  });
  const store = new PlanStore(ctx.db);
  const registry = createDefaultRegistry({ dataDir: path.join(dataDir, "tools") });
  const service = new PlanService({
    workspaceRoot: dataDir,
    store,
    validator: new PlanValidator({ registry, workspaceRoot: dataDir }),
    approval: new PlanApprovalManager(store),
    registry,
  });
  return { service, registry, ctx };
}

test("detectPlanActivationIntent 识别显式执行计划语义", () => {
  assert.equal(detectPlanActivationIntent("请执行计划"), true);
  assert.equal(detectPlanActivationIntent("请开始执行"), false);
  assert.equal(detectPlanActivationIntent("你好"), false);
});

test("defaultConfirmedTodoIds 优先 P0", () => {
  const ids = defaultConfirmedTodoIds([
    { id: "a", priority: "P1" },
    { id: "b", priority: "P0" },
  ]);
  assert.deepEqual(ids, ["b"]);
});

test("planRequiresHumanApproval 对 write 步骤为 true", () => {
  const internal = internalPlanFromLegacy(
    bindPlanTools(
      finalizePlan({
        goal: "写",
        scope: { inScope: [], outOfScope: [] },
        inputs: [],
        outputs: [],
        acceptanceCriteria: [],
        risks: [],
        dependencies: [],
        steps: [
          {
            id: "w1",
            title: "实现功能",
            description: "修改 src/foo.ts",
            requiredPermissions: ["write"],
            needsConfirmation: true,
            dependsOn: [],
            requiredContext: ["src/foo.ts"],
            availableTools: ["write_file"],
            expectedArtifacts: [],
            priority: 10,
            status: "pending",
          },
        ],
      }),
      { registry: createDefaultRegistry({ dataDir: path.join(tmpDir, "w") }) },
    ),
    { planId: "p1", version: 1, workspaceRoot: tmpDir },
  );
  assert.equal(planRequiresHumanApproval(internal), true);
  assert.equal(canAutoApprovePlan({ dryRun: false, autoApprove: true, internal }), false);
  assert.equal(canAutoApprovePlan({ dryRun: true, autoApprove: false, internal }), true);
});

test("activate dry-run 编译并执行", async () => {
  const { service, registry, ctx } = createPlanService(path.join(tmpDir, "activate"));
  const uvp = service.saveUserVisiblePlan(
    renderUserVisiblePlan({
      sourceRunId: "run-1",
      goal: "测试激活",
      markdown: `# 计划\n\n- [ ] P0 阅读 README：验收 / 风险\n`,
    }),
  );
  let executed = false;
  const workflow = new PlanActivationWorkflow({
    planService: service,
    planner: undefined,
    executeStoredPlan: async (planId, version, _payload, dryRun) => {
      executed = true;
      assert.equal(dryRun, true);
      assert.ok(planId);
      assert.equal(version, 1);
      return { status: 200, body: { ok: true } };
    },
  });
  const result = await workflow.activate({
    userVisiblePlanId: uvp.id,
    dryRun: true,
    executionMode: "static",
  });
  assert.equal(result.status, 200);
  const body = result.body as { phase: string; autoApproved: boolean };
  assert.equal(body.phase, "executed");
  assert.equal(body.autoApproved, true);
  assert.equal(executed, true);
  registry.close();
  ctx.close();
});

test("activate 非 dry-run 写步骤无 autoApprove 停在 compiled", async () => {
  const { service, registry, ctx } = createPlanService(path.join(tmpDir, "compiled"));
  const uvp = service.saveUserVisiblePlan(
    renderUserVisiblePlan({
      sourceRunId: "run-2",
      goal: "写文件",
      markdown: `# 计划\n\n- [ ] P0 实现 write_file 绑定：修改 src/x.ts / 验收 / 风险\n`,
    }),
  );
  const workflow = new PlanActivationWorkflow({
    planService: service,
    executeStoredPlan: async () => {
      throw new Error("不应执行");
    },
  });
  const result = await workflow.activate({
    userVisiblePlanId: uvp.id,
    dryRun: false,
    autoApprove: false,
  });
  assert.equal(result.status, 200);
  const body = result.body as { phase: string };
  assert.equal(body.phase, "compiled");
  registry.close();
  ctx.close();
});

async function main() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-activation-"));
  let passed = 0;
  for (const t of tests) {
    await t.fn();
    passed += 1;
    console.log(`  ✓ ${t.name}`);
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\nplan-activation: ${passed}/${tests.length} passed`);
}

main();
