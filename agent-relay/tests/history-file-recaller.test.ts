/**
 * HistoryFileRecaller 自检。
 * 运行：npm run test:history-file-recaller
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { extractFilePathsFromText } from "../src/context/filePathExtract.js";
import { HistoryFileRecaller } from "../src/context/HistoryFileRecaller.js";
import { MemoryStore, SummaryStore } from "../src/context/stores.js";
import { SessionStore } from "../src/context/SessionStore.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("extractFilePathsFromText 识别 src 路径", () => {
  const paths = extractFilePathsFromText("请查看 src/plan/PlanCompiler.ts 与 tests/tools.test.ts");
  assert.ok(paths.includes("src/plan/PlanCompiler.ts"));
  assert.ok(paths.includes("tests/tools.test.ts"));
});

test("recall 合并摘要 important_files 与 RunState location", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ar-hist-"));
  const dbm = new DatabaseManager(dataDir);
  const sessions = new SessionStore(dbm);
  const summaries = new SummaryStore(dbm);
  const memories = new MemoryStore(dbm);
  const recaller = new HistoryFileRecaller(dbm, memories);
  try {
    const session = sessions.create("定位测试", "default");
    summaries.save({
      sessionId: session.id,
      projectId: "default",
      summaryType: "session_summary",
      content: {
        important_files: ["src/agent/AgentLoop.ts"],
        current_goal: "分析 AgentLoop",
      },
    });
    memories.upsert({
      scope: "project",
      scopeId: "default",
      memoryType: "project_note",
      key: "router_files",
      value: "模型路由主要在 src/model-router/SmartModelRouter.ts",
      importance: 0.8,
      confidence: 0.9,
    });
    const ts = new Date().toISOString();
    dbm.connection
      .prepare(
        `INSERT INTO runs (id, kind, status, session_id, goal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("run-hist-1", "agent", "running", session.id, "分析计划模块", ts, ts);
    dbm.connection
      .prepare(
        `INSERT INTO run_states
         (run_id, mode, goal, session_id, task_id, status, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "run-hist-1",
        "plan",
        "分析计划模块",
        session.id,
        null,
        "resumable",
        JSON.stringify({
          readFiles: ["src/plan/PlanStore.ts"],
          location: {
            projectId: "default",
            primaryFiles: ["src/plan/PlanCompiler.ts"],
            candidateFiles: ["src/plan/PlanService.ts"],
            visitedFiles: ["src/plan/PlanCompiler.ts"],
            visitedDirs: ["src/plan"],
          },
        }),
        ts,
        ts,
      );

    const result = await recaller.recall({
      projectId: "default",
      query: "AgentLoop 计划模块",
      sessionId: session.id,
      limit: 10,
    });

    const paths = result.hits.map((h) => h.path);
    assert.ok(paths.includes("src/agent/AgentLoop.ts"));
    assert.ok(paths.includes("src/model-router/SmartModelRouter.ts"));
    assert.ok(paths.includes("src/plan/PlanCompiler.ts"));
    assert.ok(result.sourcesUsed.includes("summary_important_files"));
    assert.ok(result.sourcesUsed.includes("run_state_location"));
  } finally {
    dbm.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`  ok ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(error);
  }
}
console.log(`\nhistory-file-recaller: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
