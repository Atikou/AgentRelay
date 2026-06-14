/**
 * Agent Activity Timeline 单元测试。
 * 运行：npm run test:activity-timeline
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentTimelineService } from "../src/agent/timeline/AgentTimelineService.js";
import { AgentEventBus } from "../src/agent/timeline/AgentEventBus.js";
import { ActivityRunStore } from "../src/agent/timeline/ActivityRunStore.js";
import { sanitizeToolArgs } from "../src/agent/timeline/sanitizeToolArgs.js";
import { mapToolToActivityStep } from "../src/agent/timeline/toolStepMapper.js";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test("sanitizeToolArgs 隐藏敏感字段", () => {
  const out = sanitizeToolArgs({ apiKey: "sk-secret", path: "a.ts", token: "t" });
  assert.equal(out.apiKey, "***");
  assert.equal(out.token, "***");
  assert.equal(out.path, "a.ts");
});

test("mapToolToActivityStep 映射 read_file", () => {
  const mapped = mapToolToActivityStep("read_file", { path: "src/a.ts" });
  assert.equal(mapped.type, "file_read");
  assert.equal(mapped.title, "正在读取文件");
  assert.equal(mapped.content, "src/a.ts");
});

test("AgentTimelineService 持久化 run 与 events", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ar-timeline-"));
  try {
    const events: string[] = [];
    const tl = new AgentTimelineService({
      workspaceRoot: root,
      onEvent: (e) => events.push(e.type),
    });
    const run = tl.createRun({ id: "run-1", goal: "测试目标" });
    assert.equal(run.status, "running");
    const step = tl.startStep({
      runId: run.id,
      type: "analysis",
      title: "正在分析任务",
    });
    tl.completeStep(step.id, "分析完成");
    tl.completeRun("任务完成");

    const store = new ActivityRunStore(root);
    const loaded = store.loadRun("run-1");
    assert.ok(loaded);
    assert.equal(loaded!.status, "success");
    assert.equal(loaded!.steps.length, 1);
    assert.equal(loaded!.steps[0]!.status, "success");

    const diskEvents = store.listEvents("run-1");
    assert.ok(diskEvents.length >= 4);
    assert.ok(events.includes("run_started"));
    assert.ok(events.includes("run_completed"));

    const summaryPath = path.join(root, ".agent", "runs", "run-1", "summary.md");
    assert.ok(existsSync(summaryPath));
    assert.ok(readFileSync(summaryPath, "utf-8").includes("测试目标"));

    const manifestPath = path.join(root, ".agent", "runs", "run-1", "manifest.json");
    assert.ok(existsSync(manifestPath));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { runId: string; status: string };
    assert.equal(manifest.runId, "run-1");
    assert.equal(manifest.status, "success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ActivityRunStore 对缺失 run 返回 null", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ar-timeline-"));
  try {
    const store = new ActivityRunStore(root);
    assert.equal(store.loadRun("missing-run"), null);
    assert.deepEqual(store.listEvents("missing-run"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AgentEventBus 不在内存保留事件历史", () => {
  const bus = new AgentEventBus();
  let count = 0;
  bus.subscribe("run-x", () => {
    count += 1;
  });
  bus.publish({ type: "run_completed", runId: "run-x", summary: "ok" });
  assert.equal(count, 1);
  assert.equal(typeof (bus as { listEvents?: unknown }).listEvents, "undefined");
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${t.name}`, error);
  }
}
if (failed > 0) process.exitCode = 1;
