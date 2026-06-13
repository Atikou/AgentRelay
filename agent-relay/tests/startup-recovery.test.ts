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
