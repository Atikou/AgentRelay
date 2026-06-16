/**
 * TaskExecutionWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\task-execution-workflow.test.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { ALL_PERMISSIONS } from "../src/core/permissions.js";
import { TaskExecutionWorkflow } from "../src/agent/TaskExecutionWorkflow.js";
import type { Plan } from "../src/agent/types.js";
import { createMockRegistry, createMockTool } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";

test("dry-run executes a plan through TaskExecutionWorkflow", async () => {
  const updates: string[] = [];
  const plan: Plan = {
    goal: "dry run task workflow",
    steps: [
      {
        id: "read",
        title: "Inspect files",
        requiredPermissions: ["read"],
        status: "pending",
      },
    ],
  };

  const result = await new TaskExecutionWorkflow({
    registry: createMockRegistry(),
    workspaceRoot: sandbox,
  }).run({
    plan,
    dryRun: true,
    onUpdate: (updated) => updates.push(updated.steps[0]?.status ?? "missing"),
  });

  assert.equal(result.steps[0]?.status, "completed");
  assert.match(result.steps[0]?.result ?? "", /dry-run/);
  assert.ok(updates.includes("running"));
  assert.ok(updates.includes("completed"));
});

test("resume confirm continues a blocked dry-run step", async () => {
  const plan: Plan = {
    goal: "resume task workflow",
    steps: [
      {
        id: "confirm",
        title: "Needs confirmation",
        requiredPermissions: ["write"],
        needsConfirmation: true,
        status: "blocked",
        error: "waiting",
      },
      {
        id: "after",
        title: "After confirmation",
        requiredPermissions: ["read"],
        dependsOn: ["confirm"],
        status: "pending",
      },
    ],
  };

  const result = await new TaskExecutionWorkflow({
    registry: createMockRegistry(),
    workspaceRoot: sandbox,
    projectAllowedPermissions: ALL_PERMISSIONS,
  }).resume({
    plan,
    dryRun: true,
    action: "confirm",
    stepId: "confirm",
  });

  assert.equal(result.steps[0]?.status, "completed");
  assert.equal(result.steps[1]?.status, "completed");
});

test("tool execution path propagates task context", async () => {
  const tool = createMockTool({
    name: "mock_write",
    permission: "write",
    hasSideEffect: true,
    output: { ok: true },
  });
  const plan: Plan = {
    goal: "tool task workflow",
    steps: [
      {
        id: "write",
        title: "Run mock writer",
        requiredPermissions: ["write"],
        status: "pending",
        tool: "mock_write",
        toolInput: { path: "a.txt" },
      },
    ],
  };

  const result = await new TaskExecutionWorkflow({
    registry: createMockRegistry([tool]),
    workspaceRoot: sandbox,
    projectAllowedPermissions: ALL_PERMISSIONS,
  }).run({
    plan,
    dryRun: false,
    autoConfirm: true,
    taskId: "task-1",
    sessionId: "session-1",
    runId: "run-1",
  });

  assert.equal(result.steps[0]?.status, "completed");
  assert.equal(tool.calls.length, 1);
  assert.equal(tool.calls[0]?.context.workspaceRoot, sandbox);
  assert.equal(tool.calls[0]?.context.taskId, "task-1");
  assert.equal(tool.calls[0]?.context.sessionId, "session-1");
  assert.equal(tool.calls[0]?.context.requestId, "run-1");
  assert.equal(tool.calls[0]?.context.toolCallId, "run-1:step-write:mock_write");
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "task-execution-workflow-"));
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
  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(`\ntask-execution-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
