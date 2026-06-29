/**
 * 启动恢复自检。
 * 运行：npm run test:startup-recovery
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NotificationQueue } from "../src/background/NotificationQueue.js";
import { recoverOnStartup } from "../src/app/startupRecovery.js";
import { PausedRunStore } from "../src/agent/PausedRunStore.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { RunStore } from "../src/orchestrator/RunStore.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("recoverOnStartup 将 running Run 标记为 failed", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "startup-rec-"));
  const ctx = new ContextManager({ dataDir: tmp, useLanceDb: false });
  const runs = new RunStore(ctx.db);
  const nq = new NotificationQueue(path.join(tmp, "notifications.jsonl"));

  const run = runs.create({ kind: "agent", status: "running", goal: "test" });
  const summary = recoverOnStartup({ runs, notificationQueue: nq });
  assert.equal(summary.interruptedRuns, 1);
  assert.equal(summary.preservedPausedRuns, 0);
  const updated = runs.get(run.id);
  assert.equal(updated?.status, "failed");
  assert.match(updated?.error ?? "", /startupRecovery/);

  ctx.close();
  await rm(tmp, { recursive: true, force: true });
});

test("recoverOnStartup 统计未消费通知", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "startup-rec-"));
  const ctx = new ContextManager({ dataDir: tmp, useLanceDb: false });
  const runs = new RunStore(ctx.db);
  const nq = new NotificationQueue(path.join(tmp, "notifications.jsonl"));
  nq.enqueue({ source: "system", level: "info", message: "pending" });

  const summary = recoverOnStartup({ runs, notificationQueue: nq });
  assert.equal(summary.pendingNotifications, 1);
  assert.equal(summary.interruptedRuns, 0);
  assert.equal(summary.preservedPausedRuns, 0);

  ctx.close();
  await rm(tmp, { recursive: true, force: true });
});

test("recoverOnStartup 保留有暂停快照的 running Run", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "startup-rec-"));
  const ctx = new ContextManager({ dataDir: tmp, useLanceDb: false });
  const runs = new RunStore(ctx.db);
  const nq = new NotificationQueue(path.join(tmp, "notifications.jsonl"));
  const pausedRunStore = new PausedRunStore(ctx.db.connection);

  const run = runs.create({ kind: "agent", status: "running", goal: "edit" });
  pausedRunStore.save({
    runId: run.id,
    goal: "edit",
    messages: [{ role: "user", content: "edit" }],
    steps: [],
    modelTurns: 1,
    pendingAction: { tool: "write_file", input: { path: "README.md" } },
    mode: "implement",
    permissionPolicy: "confirmBeforeEdit",
    createdAt: new Date().toISOString(),
  });

  const summary = recoverOnStartup({ runs, notificationQueue: nq, pausedRunStore });
  assert.equal(summary.interruptedRuns, 0);
  assert.equal(summary.preservedPausedRuns, 1);
  assert.equal(runs.get(run.id)?.status, "waiting_confirmation");
  assert.equal(pausedRunStore.get(run.id)?.pendingAction?.tool, "write_file");

  ctx.close();
  await rm(tmp, { recursive: true, force: true });
});

test("recoverOnStartup 保留 plan handoff 暂停 Run 为 waiting_plan_handoff", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "startup-handoff-"));
  const ctx = new ContextManager({ dataDir: tmp, useLanceDb: false });
  const runs = new RunStore(ctx.db);
  const nq = new NotificationQueue(path.join(tmp, "notifications.jsonl"));
  const pausedRunStore = new PausedRunStore(ctx.db.connection);
  const { PlanHandoffStore } = await import("../src/policy/PlanHandoffStore.js");
  const planHandoffStore = new PlanHandoffStore(ctx.db.connection);

  const run = runs.create({ kind: "agent", status: "running", goal: "按计划执行" });
  pausedRunStore.save({
    runId: run.id,
    goal: "按计划执行",
    messages: [{ role: "user", content: "按计划执行" }],
    steps: [],
    modelTurns: 1,
    mode: "plan",
    permissionPolicy: "readOnly",
    resumeMode: "implement",
    createdAt: new Date().toISOString(),
  });
  planHandoffStore.create({
    runId: run.id,
    message: "是否执行？",
    planMarkdown: "## 计划",
    planVariant: "plan_then_execute",
  });

  const summary = recoverOnStartup({ runs, notificationQueue: nq, pausedRunStore, planHandoffStore });
  assert.equal(summary.preservedPausedRuns, 1);
  assert.equal(runs.get(run.id)?.status, "waiting_plan_handoff");
  assert.equal(planHandoffStore.getPendingByRunId(run.id)?.status, "pending");

  ctx.close();
  await rm(tmp, { recursive: true, force: true });
});

let passed = 0;
for (const t of tests) {
  await t.fn();
  passed++;
  console.log(`  ✓ ${t.name}`);
}
console.log(`\nstartup-recovery: ${passed}/${tests.length} passed`);
