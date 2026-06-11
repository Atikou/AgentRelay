/**
 * M4 后台任务与通知队列自检（无需网络）。
 * 运行：npm run test:background
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BackgroundTaskManager } from "../src/background/BackgroundTaskManager.js";
import { parseBackgroundTimeoutMs } from "../src/background/constants.js";
import { NotificationQueue } from "../src/background/NotificationQueue.js";
import { renderNotifications } from "../src/agent/AgentLoop.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTask(
  mgr: BackgroundTaskManager,
  id: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = mgr.get(id);
    if (task && task.status !== "running") return;
    await sleep(50);
  }
  throw new Error("等待后台任务结束超时");
}

test("NotificationQueue enqueue / drain / 持久化回放", async () => {
  const journal = path.join(tmpDir, "nq.jsonl");
  const q1 = new NotificationQueue(journal);
  q1.enqueue({ source: "system", level: "info", message: "hello" });
  assert.equal(q1.listPending().length, 1);

  const drained = q1.drain();
  assert.equal(drained.length, 1);
  assert.equal(q1.listPending().length, 0);

  const q2 = new NotificationQueue(journal);
  assert.equal(q2.listPending().length, 0);
  assert.equal(q2.listAll().length, 1);
});

test("NotificationQueue 按 mergeKey 折叠多条为一条", async () => {
  const journal = path.join(tmpDir, "nq-merge.jsonl");
  const q = new NotificationQueue(journal);
  q.enqueue({
    source: "scheduler",
    level: "info",
    message: "触发 A",
    mergeKey: "scheduler:t1",
    dedupeKey: "event-a",
  });
  q.enqueue({
    source: "scheduler",
    level: "info",
    message: "触发 B",
    mergeKey: "scheduler:t1",
    dedupeKey: "event-b",
  });

  const pending = q.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.mergeKey, "scheduler:t1");
  assert.equal((pending[0]!.payload as Record<string, unknown>).mergeCount, 2);
  assert.match(pending[0]!.message, /合并 2 条/);
});

test("NotificationQueue 按 priority 排序并按 dedupeKey 合并", async () => {
  const journal = path.join(tmpDir, "nq-priority.jsonl");
  const q = new NotificationQueue(journal);
  q.enqueue({ source: "system", level: "info", priority: "low", message: "low" });
  q.enqueue({
    source: "scheduler",
    level: "info",
    priority: "normal",
    message: "first",
    dedupeKey: "same",
    payload: { count: 1 },
  });
  q.enqueue({
    source: "scheduler",
    level: "warn",
    priority: "high",
    message: "latest",
    dedupeKey: "same",
    payload: { count: 2 },
  });

  const pending = q.listPending();
  assert.equal(pending.length, 2);
  assert.equal(pending[0]!.message, "latest");
  assert.equal(pending[0]!.priority, "high");
  assert.equal((pending[0]!.payload as Record<string, unknown>).count, 2);
  assert.equal((pending[0]!.payload as Record<string, unknown>).mergeCount, 1);
});

test("renderNotifications 生成可回灌文本", async () => {
  const text = renderNotifications([
    {
      id: "n1",
      source: "background_task",
      level: "info",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: "任务完成",
      consumed: false,
    },
  ]);
  assert.match(text, /系统通知/);
  assert.match(text, /任务完成/);
});

test("BackgroundTaskManager 运行短命令并写入通知", async () => {
  const journal = path.join(tmpDir, "bg-nq.jsonl");
  const queue = new NotificationQueue(journal);
  const mgr = new BackgroundTaskManager(tmpDir, queue);

  const task = mgr.start(process.platform === "win32" ? "node -e \"console.log('ok')\"" : "node -e \"console.log('ok')\"");
  assert.equal(task.status, "running");

  await waitForTask(mgr, task.id);
  const done = mgr.get(task.id)!;
  assert.equal(done.status, "completed");
  assert.match(done.stdout, /ok/);

  await sleep(100);
  const pending = queue.listPending();
  assert.ok(pending.length >= 1);
  assert.equal(pending[0]!.source, "background_task");
});

test("BackgroundTaskManager 拦截危险命令", async () => {
  const queue = new NotificationQueue(path.join(tmpDir, "danger.jsonl"));
  const mgr = new BackgroundTaskManager(tmpDir, queue);
  assert.throws(() => mgr.start("rm -rf /"), /危险命令被拦截/);
});

test("parseBackgroundTimeoutMs 校验范围", async () => {
  assert.equal(parseBackgroundTimeoutMs(undefined), undefined);
  assert.equal(parseBackgroundTimeoutMs(5000), 5000);
  assert.throws(() => parseBackgroundTimeoutMs(0), /timeoutMs/);
  assert.throws(() => parseBackgroundTimeoutMs(1.5), /timeoutMs/);
});

test("BackgroundTaskManager timeoutMs 超时终止任务", async () => {
  const journal = path.join(tmpDir, "timeout.jsonl");
  const queue = new NotificationQueue(journal);
  const mgr = new BackgroundTaskManager(tmpDir, queue);

  const task = mgr.start('node -e "setInterval(()=>{}, 60_000)"', { timeoutMs: 800 });
  assert.equal(task.timeoutMs, 800);

  await waitForTask(mgr, task.id, 10_000);
  const done = mgr.get(task.id)!;
  assert.equal(done.status, "timed_out");
  assert.match(done.error ?? "", /超时/);
});

test("BackgroundTaskManager 可取消长时间任务", async () => {
  const journal = path.join(tmpDir, "cancel.jsonl");
  const queue = new NotificationQueue(journal);
  const mgr = new BackgroundTaskManager(tmpDir, queue);

  const task = mgr.start('node -e "setInterval(()=>{}, 60_000)"');
  await sleep(200);
  const cancelled = mgr.cancel(task.id);
  assert.ok(cancelled);

  await waitForTask(mgr, task.id, 15_000);
  const done = mgr.get(task.id)!;
  assert.equal(done.status, "cancelled");
});

async function main() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-relay-bg-"));
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  ✗ ${t.name}`);
      console.error(err);
      failed += 1;
    }
  }
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows 上子进程退出后临时目录可能短暂锁定，忽略清理失败。
  }
  console.log(`\nbackground: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
