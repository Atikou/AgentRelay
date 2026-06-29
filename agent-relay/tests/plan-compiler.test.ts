/**
 * PlanCompiler 权限推断与 tool 绑定一致性。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PlanCompiler } from "../src/plan/PlanCompiler.js";
import { bindPlanTools } from "../src/plan/planToolBinder.js";
import { internalPlanFromLegacy } from "../src/plan/planConverter.js";
import { PlanValidator } from "../src/plan/PlanValidator.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import type { UserVisiblePlan } from "../src/plan/types.js";

const compiler = new PlanCompiler();

function sampleUvp(todos: UserVisiblePlan["todos"]): UserVisiblePlan {
  return {
    id: "uvp-test",
    title: "测试计划",
    markdown: "# test",
    todos,
    risks: [],
    sessionId: "sess-1",
    sourceRunId: "run-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("medium Todo 含 npm 安装应推断 shell 权限", () => {
  const plan = compiler.compile({
    userVisiblePlan: sampleUvp([
      {
        id: "todo-1",
        priority: "P0",
        title: "安装 TypeScript",
        goal: "npm install typescript --save-dev",
        implementationIdea: "npm install typescript --save-dev",
        acceptanceCriteria: ["npx tsc 成功"],
        riskLevel: "medium",
        allowAutoImplement: false,
        requiresUserConfirmation: true,
      },
    ]),
    confirmedTodoIds: ["todo-1"],
  });
  assert.ok(plan.steps[0]?.requiredPermissions.includes("shell"));
});

test("bindPlanTools 绑定 shell_run 后同步 requiredPermissions", () => {
  const plan = compiler.compile({
    userVisiblePlan: sampleUvp([
      {
        id: "todo-1",
        priority: "P0",
        title: "运行测试",
        goal: "npm test",
        implementationIdea: "npm test",
        acceptanceCriteria: ["通过"],
        riskLevel: "low",
        allowAutoImplement: true,
        requiresUserConfirmation: false,
      },
    ]),
    confirmedTodoIds: ["todo-1"],
  });
  const registry = createDefaultRegistry({ dataDir: mkdtempSync(path.join(tmpdir(), "ar-plan-compiler-")) });
  const bound = bindPlanTools(plan, { registry, defaultReadPath: "package.json" });
  assert.equal(bound.steps[0]?.tool, "shell_run");
  assert.ok(bound.steps[0]?.requiredPermissions.includes("shell"));
});

test("低风险的 npm test Todo 编译校验通过且 requiresApproval=true", () => {
  const plan = compiler.compile({
    userVisiblePlan: sampleUvp([
      {
        id: "todo-5",
        priority: "P1",
        title: "建立测试框架 Vitest",
        goal: "npm install vitest --save-dev；npm test",
        implementationIdea: "npm test",
        acceptanceCriteria: ["npm test 通过"],
        riskLevel: "low",
        allowAutoImplement: true,
        requiresUserConfirmation: false,
      },
    ]),
    confirmedTodoIds: ["todo-5"],
  });
  const dataDir = mkdtempSync(path.join(tmpdir(), "ar-plan-compiler-val-"));
  const registry = createDefaultRegistry({ dataDir });
  const bound = bindPlanTools(plan, { registry, defaultReadPath: "package.json" });
  const internal = internalPlanFromLegacy(bound, {
    planId: "plan-todo5",
    version: 1,
    workspaceRoot: dataDir,
  });
  const step = internal.steps.find((s) => s.stepId === "todo-5");
  assert.equal(step?.riskLevel, "high");
  assert.equal(step?.requiresApproval, true);
  const validator = new PlanValidator({ workspaceRoot: dataDir, registry });
  assert.doesNotThrow(() => validator.validate(internal));
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err);
  }
}
console.log(`\nplan-compiler: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
