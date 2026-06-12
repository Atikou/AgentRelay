/**
 * 计划 JSON / Markdown 分离自检。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { finalizePlan } from "../src/agent/taskGraph.js";
import type { Plan } from "../src/agent/types.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";
import {
  PlanApprovalManager,
  PlanService,
  PlanStore,
  PlanValidationError,
  PlanValidator,
  internalPlanFromLegacy,
  renderUserVisiblePlan,
  renderPublicPlanJson,
} from "../src/plan/index.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

function samplePlan(): Plan {
  return finalizePlan({
    goal: "测试目标",
    scope: { inScope: ["模块 A"], outOfScope: [] },
    inputs: ["README"],
    outputs: ["补丁"],
    acceptanceCriteria: ["测试通过"],
    risks: [],
    dependencies: [],
    steps: [
      {
        id: "s1",
        title: "调研",
        objective: "阅读代码",
        description: "只读",
        requiredPermissions: ["read"],
        needsConfirmation: false,
        dependsOn: [],
        requiredContext: [],
        availableTools: ["read_file"],
        expectedArtifacts: [],
        priority: 10,
        status: "pending",
      },
      {
        id: "s2",
        title: "实现",
        objective: "写补丁",
        description: "写入",
        requiredPermissions: ["write"],
        needsConfirmation: true,
        dependsOn: ["s1"],
        requiredContext: [],
        availableTools: ["write_file"],
        expectedArtifacts: ["out.ts"],
        priority: 20,
        status: "pending",
      },
    ],
  });
}

function createPlanService(dataDir: string) {
  const ctx = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const registry = createDefaultRegistry({ dataDir });
  const store = new PlanStore(ctx.db);
  const validator = new PlanValidator({ workspaceRoot: dataDir, registry });
  const approval = new PlanApprovalManager(store);
  const service = new PlanService({
    workspaceRoot: dataDir,
    store,
    validator,
    approval,
    registry,
    trace: undefined,
  });
  return { ctx, registry, service };
}

test("PublicPlanJson 永远 executable=false", async () => {
  const { ctx, service } = createPlanService(path.join(tmpDir, "pub-json"));
  const draft = service.persistLegacyAsDraft(samplePlan(), { originType: "planner" });
  assert.equal(draft.publicPlanJson.executable, false);
  assert.equal(draft.publicPlanJson.kind, "public_plan_preview");
  ctx.close();
});

test("Executor 拒绝 PublicPlanJson 作为执行体", async () => {
  const { ctx, service } = createPlanService(path.join(tmpDir, "reject-pub"));
  const draft = service.persistLegacyAsDraft(samplePlan(), { originType: "planner" });
  const validator = new PlanValidator({
    workspaceRoot: path.join(tmpDir, "reject-pub"),
    registry: createDefaultRegistry({ dataDir: path.join(tmpDir, "reject-pub") }),
  });
  assert.throws(
    () => validator.rejectPublicPreview(draft.publicPlanJson),
    (err: unknown) =>
      err instanceof PlanValidationError && err.code === "EXECUTABLE_PREVIEW_REJECTED",
  );
  ctx.close();
});

test("未审批 InternalTaskPlan 不可执行", async () => {
  const { ctx, service } = createPlanService(path.join(tmpDir, "not-approved"));
  const draft = service.persistLegacyAsDraft(samplePlan(), { originType: "planner" });
  assert.throws(
    () => service.loadExecutable(draft.planId, draft.version),
    (err: unknown) => err instanceof PlanValidationError && err.code === "PLAN_NOT_APPROVED",
  );
  ctx.close();
});

test("审批后可 loadExecutable", async () => {
  const { ctx, service } = createPlanService(path.join(tmpDir, "approved"));
  const draft = service.persistLegacyAsDraft(samplePlan(), { originType: "planner" });
  service.approve(draft.planId, draft.version, "tester");
  const internal = service.loadExecutable(draft.planId, draft.version);
  assert.equal(internal.kind, "internal_task_plan");
  ctx.close();
});

test("拒绝后不可 loadExecutable", async () => {
  const { ctx, service } = createPlanService(path.join(tmpDir, "rejected"));
  const draft = service.persistLegacyAsDraft(samplePlan(), { originType: "planner" });
  const rejected = service.reject(draft.planId, draft.version, "reviewer", "范围过大");
  assert.equal(rejected.status, "rejected");
  assert.throws(
    () => service.loadExecutable(draft.planId, draft.version),
    (err: unknown) => err instanceof PlanValidationError && err.code === "PLAN_NOT_APPROVED",
  );
  ctx.close();
});

test("internalPlanFromLegacy 含 guards 与 audit.planHash", async () => {
  const internal = internalPlanFromLegacy(samplePlan(), {
    planId: "plan-test",
    version: 1,
    workspaceRoot: tmpDir,
  });
  assert.ok(internal.audit.planHash.startsWith("sha256:"));
  assert.ok(internal.guards.forbiddenPaths.includes(".env"));
});

test("Markdown 预览不包含完整 tool args", async () => {
  const plan = samplePlan();
  plan.steps[0]!.tool = "read_file";
  plan.steps[0]!.toolInput = { path: "secret/internal.ts" };
  const internal = internalPlanFromLegacy(plan, {
    planId: "p1",
    version: 1,
    workspaceRoot: tmpDir,
  });
  const { service, ctx } = createPlanService(path.join(tmpDir, "md-preview"));
  const saved = service.persistLegacyAsDraft(plan, { planId: "p1", version: 1, originType: "planner" });
  const md = service.getPreview(saved.planId, saved.version, "markdown");
  assert.ok(md);
  assert.ok(!md!.includes("secret/internal.ts"));
  const pub = renderPublicPlanJson(internal);
  assert.equal(pub.executable, false);
  ctx.close();
});

test("UserVisiblePlan 可保存并按 id 读取", async () => {
  const { service, ctx } = createPlanService(path.join(tmpDir, "user-visible"));
  const plan = renderUserVisiblePlan({
    sourceRunId: "run-visible",
    goal: "完善计划体系",
    markdown: [
      "# 计划模式分析结果",
      "## 6. TodoList",
      "- [ ] P0 类型分离：目标 / 验收 / 风险",
      "本次仅生成计划，未修改任何文件。",
    ].join("\n"),
  });
  const saved = service.saveUserVisiblePlan(plan);
  const loaded = service.getUserVisiblePlan(saved.id);
  assert.ok(loaded);
  assert.equal(loaded!.kind, "user_visible_plan");
  assert.equal(loaded!.todos[0]?.priority, "P0");
  ctx.close();
});

test("UserVisiblePlan 编译为 awaiting_approval 内部计划草案", async () => {
  const { service, ctx } = createPlanService(path.join(tmpDir, "compile-visible"));
  const visible = service.saveUserVisiblePlan(
    renderUserVisiblePlan({
      sourceRunId: "run-compile",
      goal: "完善计划体系",
      markdown: [
        "# 计划模式分析结果",
        "## 6. TodoList",
        "- [ ] P0 类型分离：目标 / 验收 / 风险",
        "- [ ] P1 实现编译器：目标 / 验收 / 风险",
        "本次仅生成计划，未修改任何文件。",
      ].join("\n"),
    }),
  );
  const draft = service.compileUserVisiblePlan({
    userVisiblePlanId: visible.id,
    confirmedTodoIds: [visible.todos[0]!.id],
  });
  assert.equal(draft.status, "awaiting_approval");
  assert.equal(draft.sourceUserVisiblePlan.id, visible.id);
  assert.ok(draft.previewMarkdown.includes("类型分离"));
  assert.equal(draft.publicPlanJson.executable, false);
  ctx.close();
});

test("PlanValidator 拒绝高风险但未审批步骤", async () => {
  const registry = createDefaultRegistry({ dataDir: tmpDir });
  const validator = new PlanValidator({
    workspaceRoot: tmpDir,
    registry,
  });
  const internal = internalPlanFromLegacy(samplePlan(), {
    planId: "risk-plan",
    version: 1,
    workspaceRoot: tmpDir,
  });
  internal.steps[0]!.riskLevel = "high";
  internal.steps[0]!.requiresApproval = false;
  internal.audit.planHash = "";
  assert.throws(
    () => validator.validate(internal),
    (err: unknown) => err instanceof PlanValidationError && err.code === "INVALID_SCHEMA",
  );
  registry.close();
});

async function main() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (error) {
      console.error(`  ✗ ${t.name}`);
      console.error(error);
      process.exitCode = 1;
      break;
    }
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\nplan: ${passed}/${tests.length} passed`);
}

main();
