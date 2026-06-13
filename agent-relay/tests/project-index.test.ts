/**
 * ProjectIndex 持久化索引自检。
 * 运行：npm run test:project-index
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { ProjectIndex, extractSymbolsFromContent } from "../src/context/ProjectIndex.js";
import { MEMORY_DB_SCHEMA_VERSION } from "../src/storage/memoryDbMigrations.js";

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function tempWorkspace(): { dataDir: string; root: string; cleanup: () => void } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ar-pidx-"));
  const root = path.join(dataDir, "workspace");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "PlanCompiler.ts"),
    "export class PlanCompiler {\n  compile() { return true; }\n}\n",
    "utf-8",
  );
  writeFileSync(path.join(root, "README.md"), "# demo\n", "utf-8");
  return { dataDir, root, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("memory.db schema v10 含 project_files / project_symbols", () => {
  const { dataDir, cleanup } = tempWorkspace();
  const dbm = new DatabaseManager(dataDir);
  try {
    assert.equal(dbm.schemaVersion, MEMORY_DB_SCHEMA_VERSION);
    const filesTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_files'`)
      .get() as { name: string };
    const symbolsTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_symbols'`)
      .get() as { name: string };
    assert.equal(filesTable.name, "project_files");
    assert.equal(symbolsTable.name, "project_symbols");
  } finally {
    dbm.close();
    cleanup();
  }
});

test("syncFiles 增量写入文件与符号", async () => {
  const { dataDir, root, cleanup } = tempWorkspace();
  const dbm = new DatabaseManager(dataDir);
  const index = new ProjectIndex(dbm);
  try {
    const first = await index.syncFiles({
      projectId: "default",
      workspaceRoot: root,
      files: [
        {
          path: "src/PlanCompiler.ts",
          fileName: "PlanCompiler.ts",
          extension: ".ts",
          sizeBytes: 64,
          modifiedAt: new Date().toISOString(),
          mtimeMs: Date.now(),
          contentHash: "hash-a",
          language: "typescript",
          tags: ["source"],
        },
      ],
      extractSymbols: true,
    });
    assert.equal(first.upserted, 1);
    const stats = index.getStats("default", root);
    assert.equal(stats.fileCount, 1);
    assert.ok(stats.symbolCount >= 1);

    const second = await index.syncFiles({
      projectId: "default",
      workspaceRoot: root,
      files: [
        {
          path: "src/PlanCompiler.ts",
          fileName: "PlanCompiler.ts",
          extension: ".ts",
          sizeBytes: 64,
          modifiedAt: new Date().toISOString(),
          mtimeMs: Date.now(),
          contentHash: "hash-a",
          language: "typescript",
          tags: ["source"],
        },
      ],
      extractSymbols: true,
    });
    assert.equal(second.skipped, 1);
    assert.equal(second.upserted, 0);
  } finally {
    dbm.close();
    cleanup();
  }
});

test("searchSymbols 可按名称命中索引", async () => {
  const { dataDir, root, cleanup } = tempWorkspace();
  const dbm = new DatabaseManager(dataDir);
  const index = new ProjectIndex(dbm);
  try {
    await index.syncFiles({
      projectId: "default",
      workspaceRoot: root,
      files: [
        {
          path: "src/PlanCompiler.ts",
          fileName: "PlanCompiler.ts",
          extension: ".ts",
          sizeBytes: 64,
          modifiedAt: new Date().toISOString(),
          mtimeMs: Date.now(),
          contentHash: "hash-b",
          language: "typescript",
          tags: ["source"],
        },
      ],
      extractSymbols: true,
    });
    const hits = index.searchSymbols("default", root, ["PlanCompiler"]);
    assert.ok(hits.some((h) => h.symbol === "PlanCompiler"));
  } finally {
    dbm.close();
    cleanup();
  }
});

test("extractSymbolsFromContent 提取 class 定义", () => {
  const symbols = extractSymbolsFromContent(
    "src/Foo.ts",
    "export class Foo {}\nfunction bar() {}\n",
  );
  assert.ok(symbols.some((s) => s.symbol === "Foo" && s.kind === "class"));
  assert.ok(symbols.some((s) => s.symbol === "bar" && s.kind === "function"));
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\nproject-index: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
