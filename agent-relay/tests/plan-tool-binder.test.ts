/**
 * planToolBinder self-check.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { finalizePlan } from "../src/agent/taskGraph.js";
import { bindPlanTools } from "../src/plan/planToolBinder.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

test("bindPlanTools 为只读步骤绑定 read_file", async () => {
  const registry = createDefaultRegistry({ dataDir: path.join(tmpDir, "read") });
  const plan = finalizePlan({
    goal: "只读调研",
    scope: { inScope: [], outOfScope: [] },
    inputs: [],
    outputs: [],
    acceptanceCriteria: [],
    risks: [],
    dependencies: [],
    steps: [
      {
        id: "s1",
        title: "阅读 README",
        description: "阅读 README.md",
        requiredPermissions: ["read"],
        needsConfirmation: false,
        dependsOn: [],
        requiredContext: ["README.md"],
        availableTools: ["read_file"],
        expectedArtifacts: [],
        priority: 10,
        status: "pending",
      },
    ],
  });
  const bound = bindPlanTools(plan, { registry });
  assert.equal(bound.steps[0]!.tool, "read_file");
  assert.equal(bound.steps[0]!.toolInput?.path, "README.md");
  registry.close();
});

test("bindPlanTools 为 write 步骤绑定 write_file 而非 read_file", async () => {
  const registry = createDefaultRegistry({ dataDir: path.join(tmpDir, "write") });
  const plan = finalizePlan({
    goal: "实现",
    scope: { inScope: [], outOfScope: [] },
    inputs: [],
    outputs: [],
    acceptanceCriteria: [],
    risks: [],
    dependencies: [],
    steps: [
      {
        id: "s1",
        title: "实现新模块",
        description: "在 src/foo.ts 实现功能",
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
  });
  const bound = bindPlanTools(plan, { registry });
  assert.equal(bound.steps[0]!.tool, "write_file");
  assert.equal(bound.steps[0]!.toolInput?.path, "src/foo.ts");
  registry.close();
});

test("bindPlanTools 为 shell 步骤绑定 shell_run", async () => {
  const registry = createDefaultRegistry({ dataDir: path.join(tmpDir, "shell") });
  const plan = finalizePlan({
    goal: "跑测试",
    scope: { inScope: [], outOfScope: [] },
    inputs: [],
    outputs: [],
    acceptanceCriteria: [],
    risks: [],
    dependencies: [],
    steps: [
      {
        id: "s1",
        title: "运行 npm test",
        description: "执行测试命令",
        requiredPermissions: ["shell"],
        needsConfirmation: true,
        dependsOn: [],
        requiredContext: [],
        availableTools: ["shell_run"],
        expectedArtifacts: [],
        priority: 10,
        status: "pending",
      },
    ],
  });
  const bound = bindPlanTools(plan, { registry });
  assert.equal(bound.steps[0]!.tool, "shell_run");
  assert.ok(String(bound.steps[0]!.toolInput?.command ?? "").includes("npm"));
  registry.close();
});

async function main() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "plan-tool-binder-"));
  let passed = 0;
  for (const t of tests) {
    await t.fn();
    passed += 1;
    console.log(`  ✓ ${t.name}`);
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  console.log(`\nplan-tool-binder: ${passed}/${tests.length} passed`);
}

main();
