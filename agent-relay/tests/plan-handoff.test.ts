/**
 * planHandoff 计划交接自检。
 * 运行：node --import tsx tests/plan-handoff.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { planHandoffMessageForVariant } from "../src/agent/planHandoffMessages.js";
import { isPlanHandoffFollowUpMessage } from "../src/agent/planHandoffFollowUp.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { PlanHandoffStore } from "../src/policy/PlanHandoffStore.js";
import { PermissionRequestStore } from "../src/policy/PermissionRequestStore.js";
import { findBlockingAgentPause } from "../src/policy/permissionPauseGate.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ar-plan-handoff-"));
}

function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("planHandoffMessageForVariant 按变体返回文案", () => {
  assert.match(planHandoffMessageForVariant("plan_only"), /可选择按计划执行/);
  assert.match(planHandoffMessageForVariant("plan_wait_approval"), /等待您批准/);
  assert.match(planHandoffMessageForVariant("plan_then_execute"), /是否继续执行/);
});

test("isPlanHandoffFollowUpMessage 识别继续执行短句", () => {
  assert.equal(isPlanHandoffFollowUpMessage("继续"), true);
  assert.equal(isPlanHandoffFollowUpMessage("开始吧"), true);
  assert.equal(isPlanHandoffFollowUpMessage("按这个做"), true);
  assert.equal(isPlanHandoffFollowUpMessage("分析一下别的模块"), false);
});

test("PlanHandoffStore respond approve/reject", () => {
  const store = new PlanHandoffStore();
  const created = store.create({
    runId: "run-ph",
    sessionId: "sess-ph",
    planMarkdown: "## 计划",
    planVariant: "plan_only",
    message: "已完成计划",
  });
  const approved = store.respond(created.id, { decision: "approve" });
  assert.equal(approved?.status, "approved");
  assert.equal(store.getPendingByRunId("run-ph"), null);
});

test("PlanHandoffStore 持久化 v16", () => {
  const dataDir = tempDataDir();
  let ctx: ContextManager | undefined;
  try {
    ctx = new ContextManager({ dataDir, useLanceDb: false });
    const store = new PlanHandoffStore(ctx.db.connection);
    const created = store.create({
      runId: "run-db-ph",
      sessionId: "sess-db-ph",
      planMarkdown: "plan",
      planVariant: "plan_wait_approval",
      message: "等待批准",
    });
    const reloaded = new PlanHandoffStore(ctx.db.connection);
    assert.equal(reloaded.getPendingBySessionId("sess-db-ph")?.id, created.id);
    reloaded.respond(created.id, { decision: "reject" });
    assert.equal(new PlanHandoffStore(ctx.db.connection).getPendingBySessionId("sess-db-ph"), null);
  } finally {
    ctx?.close();
    removeTempDir(dataDir);
  }
});

test("findBlockingAgentPause 有待批准 planHandoff 时阻止新 agent", () => {
  const handoffStore = new PlanHandoffStore();
  handoffStore.create({
    runId: "run-handoff-block",
    sessionId: "sess-handoff-block",
    planMarkdown: "p",
    planVariant: "plan_only",
    message: "m",
  });
  const gate = findBlockingAgentPause({
    sessionId: "sess-handoff-block",
    planHandoffStore: handoffStore,
  });
  assert.equal(gate?.code, "PLAN_HANDOFF_PENDING");
  assert.equal(gate?.planHandoff?.runId, "run-handoff-block");
});

test("findBlockingAgentPause planHandoff 优先于 permission pending", () => {
  const handoffStore = new PlanHandoffStore();
  handoffStore.create({
    runId: "run-handoff-block",
    sessionId: "sess-handoff-block",
    planMarkdown: "p",
    planVariant: "plan_only",
    message: "m",
  });
  const permStore = new PermissionRequestStore();
  permStore.create({
    runId: "run-other",
    sessionId: "sess-handoff-block",
    title: "t",
    summary: "s",
    requiredPermissions: [{ type: "write_file", target: "a.ts", reason: "r" }],
  });
  const gate = findBlockingAgentPause({
    sessionId: "sess-handoff-block",
    planHandoffStore: handoffStore,
    permissionRequestStore: permStore,
  });
  assert.equal(gate?.code, "PLAN_HANDOFF_PENDING");
  assert.equal(gate?.planHandoff?.runId, "run-handoff-block");
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\nplan-handoff: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
