/**
 * M8 定时与事件触发自检（无需网络）。
 * 运行：npm run test:scheduler
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BackgroundTaskManager } from "../src/background/BackgroundTaskManager.js";
import { NotificationQueue, readMergeCount } from "../src/background/NotificationQueue.js";
import { matchFilePattern } from "../src/scheduler/FileWatchHub.js";
import { Scheduler } from "../src/scheduler/Scheduler.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("once 触发器到期后写入 scheduler 通知", async () => {
  const journal = path.join(tmpDir, "sched-once.jsonl");
  const nqFile = path.join(tmpDir, "nq-once.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.start();
  const at = new Date(Date.now() + 80).toISOString();
  sched.register({
    name: "提醒",
    kind: "once",
    goal: "检查构建状态",
    at,
  });
  await sleep(200);
  const pending = nq.listPending();
  assert.ok(pending.some((n) => n.source === "scheduler" && n.message.includes("检查构建状态")));
  sched.stop();
});

test("scheduler fire handler 返回的 runId 会写入通知", async () => {
  const journal = path.join(tmpDir, "sched-runid.jsonl");
  const nqFile = path.join(tmpDir, "nq-runid.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.setFireHandler(() => ({ runId: "run-scheduled-1" }));
  sched.start();
  sched.register({
    name: "runid",
    kind: "once",
    goal: "create run",
    at: new Date(Date.now() - 100).toISOString(),
    missPolicy: "run_once",
  });
  await sleep(80);
  const note = nq.listPending()[0]!;
  assert.equal(note.runId, "run-scheduled-1");
  assert.equal((note.payload as Record<string, unknown>).runId, "run-scheduled-1");
  assert.equal(note.priority, "high");
  sched.stop();
});

test("interval 触发器周期性写入通知", async () => {
  const journal = path.join(tmpDir, "sched-interval.jsonl");
  const nqFile = path.join(tmpDir, "nq-interval.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.start();
  sched.register({
    name: "心跳",
    kind: "interval",
    goal: "周期巡检",
    intervalMs: 1000,
  });
  await sleep(2200);
  const pending = nq.listPending();
  assert.ok(pending.length >= 1);
  assert.ok(readMergeCount(pending[0]!.payload) >= 2, "同类 interval 通知应经 mergeKey 折叠");
  sched.stop();
});

test("pause 后 interval 不再触发", async () => {
  const journal = path.join(tmpDir, "sched-pause.jsonl");
  const nqFile = path.join(tmpDir, "nq-pause.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.start();
  const trigger = sched.register({
    name: "可暂停",
    kind: "interval",
    goal: "暂停测试",
    intervalMs: 1000,
  });
  await sleep(1100);
  const before = nq.listPending().length;
  sched.pause(trigger.id);
  await sleep(1200);
  assert.equal(nq.listPending().length, before);
  sched.stop();
});

test("持久化重启后恢复触发器定义", async () => {
  const journal = path.join(tmpDir, "sched-persist.jsonl");
  const nqFile = path.join(tmpDir, "nq-persist.jsonl");
  const nq1 = new NotificationQueue(nqFile);
  const s1 = new Scheduler(journal, nq1);
  const created = s1.register({
    name: "持久",
    kind: "event",
    goal: "后台完成后提醒",
    eventType: "background_completed",
    eventFilter: { status: "completed" },
  });
  s1.stop();

  const nq2 = new NotificationQueue(nqFile);
  const s2 = new Scheduler(journal, nq2);
  const restored = s2.get(created.id);
  assert.ok(restored);
  assert.equal(restored!.kind, "event");
  assert.equal(restored!.status, "active");
  s2.stop();
});

test("后台任务完成可触发 event 触发器", async () => {
  const journal = path.join(tmpDir, "sched-event.jsonl");
  const nqFile = path.join(tmpDir, "nq-event.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.start();
  sched.register({
    name: "构建后",
    kind: "event",
    goal: "后台构建完成后汇总",
    eventType: "background_completed",
    eventFilter: { status: "completed" },
  });
  const bg = new BackgroundTaskManager(
    tmpDir,
    nq,
    undefined,
    (record) => sched.handleBackgroundCompleted(record),
  );
  const task = bg.start('node -e "process.exit(0)"');
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const t = bg.get(task.id);
    if (t && t.status !== "running") break;
    await sleep(50);
  }
  const pending = nq.listPending();
  assert.ok(
    pending.some(
      (n) => n.source === "scheduler" && n.message.includes("后台构建完成后汇总"),
    ),
  );
  sched.stop();
});

test("matchFilePattern 支持 * 通配", async () => {
  assert.equal(matchFilePattern("src/a.ts", "*.ts"), true);
  assert.equal(matchFilePattern("a.ts", "*.ts"), true);
  assert.equal(matchFilePattern("pkg/readme.md", "pkg/*.md"), true);
  assert.equal(matchFilePattern("pkg/readme.md", "other/*.md"), false);
});

test("handleFileChanged 按 pattern 过滤并去抖", async () => {
  const journal = path.join(tmpDir, "sched-file-filter.jsonl");
  const nqFile = path.join(tmpDir, "nq-file-filter.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.register({
    name: "文档",
    kind: "event",
    eventType: "file_changed",
    goal: "文档有更新",
    eventFilter: { watchPath: ".", pattern: "*.md", debounceMs: 100 },
  });
  sched.handleFileChanged({ relativePath: "notes.md", kind: "change" });
  await sleep(150);
  assert.equal(nq.listPending().length, 1);
  sched.handleFileChanged({ relativePath: "main.ts", kind: "change" });
  await sleep(150);
  assert.equal(nq.listPending().length, 1);
});

test("file_changed 监听真实写入", async () => {
  const ws = path.join(tmpDir, "watch-ws");
  await mkdir(ws, { recursive: true });
  const journal = path.join(tmpDir, "sched-file-watch.jsonl");
  const nqFile = path.join(tmpDir, "nq-file-watch.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq, undefined, { workspaceRoot: ws });
  sched.start();
  sched.register({
    name: "TS 变更",
    kind: "event",
    eventType: "file_changed",
    goal: "检查 TypeScript 文件",
    eventFilter: { watchPath: ".", pattern: "*.ts", debounceMs: 100 },
  });
  await sleep(400);
  await writeFile(path.join(ws, "touch.ts"), "export {}", "utf-8");
  await sleep(1200);
  assert.ok(
    nq.listPending().some((n) => n.source === "scheduler" && n.message.includes("touch.ts")),
  );
  sched.stop();
});

test("git_changed 脏工作区触发通知", async () => {
  const journal = path.join(tmpDir, "sched-git.jsonl");
  const nqFile = path.join(tmpDir, "nq-git.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.register({
    name: "git-dirty",
    kind: "event",
    eventType: "git_changed",
    goal: "工作区有未提交变更",
    eventFilter: { dirtyOnly: true },
  });
  sched.handleGitChanged({
    branch: "main",
    dirty: true,
    porcelain: " M README.md",
    signature: "main|true| M README.md",
  });
  assert.ok(nq.listPending().some((n) => n.message.includes("未提交")));
});

test("无人值守白名单不要求确认", async () => {
  const journal = path.join(tmpDir, "sched-unattended.jsonl");
  const nqFile = path.join(tmpDir, "nq-unattended.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq, undefined, {
    unattendedGoalPatterns: ["周期巡检"],
  });
  sched.start();
  sched.register({
    name: "巡检",
    kind: "once",
    goal: "周期巡检磁盘",
    at: new Date(Date.now() - 100).toISOString(),
    missPolicy: "run_once",
  });
  await sleep(80);
  const note = nq.listPending()[0]!;
  assert.equal((note.payload as Record<string, unknown>).requiresConfirmation, false);
  assert.equal((note.payload as Record<string, unknown>).unattended, true);
  sched.stop();
});

test("cancel 后触发器不再写入通知", async () => {
  const journal = path.join(tmpDir, "sched-cancel.jsonl");
  const nqFile = path.join(tmpDir, "nq-cancel.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  sched.start();
  const trigger = sched.register({
    name: "将取消",
    kind: "interval",
    goal: "取消测试",
    intervalMs: 1000,
  });
  sched.cancel(trigger.id);
  await sleep(1200);
  assert.equal(nq.listPending().length, 0);
  sched.stop();
});

test("拒绝过小 interval/debounce，避免后台高频忙循环", async () => {
  const journal = path.join(tmpDir, "sched-minimums.jsonl");
  const nqFile = path.join(tmpDir, "nq-minimums.jsonl");
  const nq = new NotificationQueue(nqFile);
  const sched = new Scheduler(journal, nq);
  assert.throws(() =>
    sched.register({
      name: "too-fast",
      kind: "interval",
      goal: "过快轮询",
      intervalMs: 10,
    }),
  );
  assert.throws(() =>
    sched.register({
      name: "too-fast-file",
      kind: "event",
      eventType: "file_changed",
      goal: "过快文件监听",
      eventFilter: { watchPath: ".", debounceMs: 1 },
    }),
  );
  sched.stop();
});

async function main() {
  tmpDir = await mkdtemp(path.join(tmpdir(), "agent-sched-"));
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (error) {
      console.error(`  ✗ ${t.name}`);
      throw error;
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
  console.log(`\nscheduler: ${passed}/${tests.length} 通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
