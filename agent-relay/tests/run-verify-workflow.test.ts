/**
 * RunVerifyWorkflow self-check.
 * Run: node .\node_modules\tsx\dist\cli.mjs tests\run-verify-workflow.test.ts
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { extractSafeCommand, RunVerifyWorkflow } from "../src/agent/RunVerifyWorkflow.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

let sandbox = "";

test("extractSafeCommand only extracts allowlisted commands", () => {
  assert.equal(extractSafeCommand("please run node --version to verify env"), "node --version");
  assert.equal(extractSafeCommand("please run rm -rf dist"), undefined);
});

test("verify workflow executes a safe command and collects output", async () => {
  const workflow = new RunVerifyWorkflow({
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    allowedPermissions: ["read", "shell"],
    permissionPolicy: "autoRun",
    budget: {
      maxModelTurns: 1,
      maxToolCalls: 1,
      maxReadCalls: 0,
      maxWriteCalls: 0,
      maxShellCalls: 1,
      maxRuntimeMs: 60000,
    },
  });
  const result = await workflow.run("run node --version to verify env", "verify");
  assert.equal(result?.executed, true);
  assert.equal(result?.steps.length, 1);
  assert.equal(result?.steps[0]!.tool, "shell_run");
  assert.equal(result?.steps[0]!.ok, true);
  assert.match(JSON.stringify(result?.steps[0]!.output), /v\d+\./);
  assert.match(result?.modelContext ?? "", /verifyWorkflow automatic verification result/);
});

test("confirmBeforeRun 下 verify preflight 不自动执行 shell", async () => {
  const workflow = new RunVerifyWorkflow({
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    allowedPermissions: ["read", "shell"],
    permissionPolicy: "confirmBeforeRun",
    budget: {
      maxModelTurns: 1,
      maxToolCalls: 1,
      maxReadCalls: 0,
      maxWriteCalls: 0,
      maxShellCalls: 1,
      maxRuntimeMs: 60000,
      maxPreflightTools: 2,
      maxRecoveryTurns: 2,
      maxRepeatedToolFailures: 1,
    },
  });
  const result = await workflow.run("run npm test to verify", "verify");
  assert.equal(result?.executed, false);
  assert.equal(result?.steps.length, 0);
  assert.match(result?.fallbackReason ?? "", /JIT confirmation/i);
});

test("workflow falls back when shell permission is unavailable", async () => {
  const workflow = new RunVerifyWorkflow({
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    allowedPermissions: ["read"],
    budget: {
      maxModelTurns: 1,
      maxToolCalls: 1,
      maxReadCalls: 1,
      maxWriteCalls: 0,
      maxShellCalls: 1,
      maxRuntimeMs: 60000,
      maxPreflightTools: 2,
      maxRecoveryTurns: 2,
      maxRepeatedToolFailures: 1,
    },
  });
  const result = await workflow.run("run node --version to verify env", "verify");
  assert.equal(result?.executed, false);
  assert.equal(result?.steps.length, 0);
  assert.match(result?.fallbackReason ?? "", /permission policy/);
  assert.match(result?.modelContext ?? "", /static fallback/);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "run-verify-workflow-"));
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
  console.log(`\nrun-verify-workflow: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
