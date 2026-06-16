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
import { MEMORY_DB_SCHEMA_VERSION } from "../src/context/memoryDbMigrations.js";

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

test("memory.db schema v11 含 project_imports / project_exports", () => {
  const { dataDir, cleanup } = tempWorkspace();
  const dbm = new DatabaseManager(dataDir);
  try {
    assert.equal(dbm.schemaVersion, MEMORY_DB_SCHEMA_VERSION);
    const importsTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_imports'`)
      .get() as { name: string };
    const exportsTable = dbm.connection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_exports'`)
      .get() as { name: string };
    assert.equal(importsTable.name, "project_imports");
    assert.equal(exportsTable.name, "project_exports");
  } finally {
    dbm.close();
    cleanup();
  }
});

test("syncFiles 写入 import 依赖并可查询邻居", async () => {
  const { dataDir, root, cleanup } = tempWorkspace();
  mkdirSync(path.join(root, "src", "plan"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "plan", "PlanCompiler.ts"),
    "export class PlanCompiler {}\n",
    "utf-8",
  );
  writeFileSync(
    path.join(root, "src", "plan", "PlanRunner.ts"),
    "import { PlanCompiler } from './PlanCompiler';\nexport class PlanRunner {}\n",
    "utf-8",
  );
  const dbm = new DatabaseManager(dataDir);
  const index = new ProjectIndex(dbm);
  try {
    await index.syncFiles({
      projectId: "default",
      workspaceRoot: root,
      files: [
        {
          path: "src/plan/PlanCompiler.ts",
          fileName: "PlanCompiler.ts",
          extension: ".ts",
          sizeBytes: 64,
          modifiedAt: new Date().toISOString(),
          mtimeMs: Date.now(),
          contentHash: "hash-compiler",
          language: "typescript",
          tags: ["source"],
        },
        {
          path: "src/plan/PlanRunner.ts",
          fileName: "PlanRunner.ts",
          extension: ".ts",
          sizeBytes: 64,
          modifiedAt: new Date().toISOString(),
          mtimeMs: Date.now(),
          contentHash: "hash-runner",
          language: "typescript",
          tags: ["source"],
        },
      ],
      extractSymbols: true,
      extractDependencies: true,
    });
    const deps = index.getDependencies("default", root, "src/plan/PlanRunner.ts");
    assert.deepEqual(deps, ["src/plan/PlanCompiler.ts"]);
    const dependents = index.getDependents("default", root, "src/plan/PlanCompiler.ts");
    assert.deepEqual(dependents, ["src/plan/PlanRunner.ts"]);
    const neighbors = index.expandGraphNeighbors("default", root, ["src/plan/PlanRunner.ts"], {
      maxDepth: 1,
      limit: 8,
    });
    assert.ok(neighbors.some((n) => n.path === "src/plan/PlanCompiler.ts" && n.relation === "imports"));
  } finally {
    dbm.close();
    cleanup();
  }
});

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

test("searchSymbolsQuery 支持 prefix 匹配", async () => {
  const { dataDir, root, cleanup } = tempWorkspace();
  const dbm = new DatabaseManager(dataDir);
  const index = new ProjectIndex(dbm);
  try {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "PlanCompiler.ts"), "export class PlanCompiler {}\n", "utf-8");
    writeFileSync(path.join(root, "src", "PlanRunner.ts"), "export class PlanRunner {}\n", "utf-8");
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
          contentHash: "hash-c",
          language: "typescript",
          tags: ["source"],
        },
        {
          path: "src/PlanRunner.ts",
          fileName: "PlanRunner.ts",
          extension: ".ts",
          sizeBytes: 64,
          modifiedAt: new Date().toISOString(),
          mtimeMs: Date.now(),
          contentHash: "hash-r",
          language: "typescript",
          tags: ["source"],
        },
      ],
      extractSymbols: true,
    });
    const hits = index.searchSymbolsQuery({
      projectId: "default",
      workspaceRoot: root,
      queries: ["Plan"],
      match: "prefix",
      limit: 10,
    });
    assert.ok(hits.some((h) => h.symbol === "PlanCompiler"));
    assert.ok(hits.some((h) => h.symbol === "PlanRunner"));
  } finally {
    dbm.close();
    cleanup();
  }
});

test("syncFiles forceResync 在 hash 未变时仍更新符号", async () => {
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
          contentHash: "hash-force",
          language: "typescript",
          tags: ["source"],
        },
      ],
      extractSymbols: true,
    });
    const forced = await index.syncFiles({
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
          contentHash: "hash-force",
          language: "typescript",
          tags: ["source"],
        },
      ],
      extractSymbols: true,
      forceResync: true,
    });
    assert.equal(forced.skipped, 0);
    assert.ok(forced.symbolsUpdated >= 1);
  } finally {
    dbm.close();
    cleanup();
  }
});

test("syncFiles 增量批次不 prune 未包含的既有文件", async () => {
  const { dataDir, root, cleanup } = tempWorkspace();
  mkdirSync(path.join(root, "src", "a"), { recursive: true });
  mkdirSync(path.join(root, "src", "b"), { recursive: true });
  writeFileSync(path.join(root, "src", "a", "A.ts"), "export class A {}\n", "utf-8");
  writeFileSync(path.join(root, "src", "b", "B.ts"), "export class B {}\n", "utf-8");
  const dbm = new DatabaseManager(dataDir);
  const index = new ProjectIndex(dbm);
  try {
    const fileA = {
      path: "src/a/A.ts",
      fileName: "A.ts",
      extension: ".ts",
      sizeBytes: 32,
      modifiedAt: new Date().toISOString(),
      mtimeMs: Date.now(),
      contentHash: "hash-a",
      language: "typescript",
      tags: ["source"],
    };
    const fileB = {
      path: "src/b/B.ts",
      fileName: "B.ts",
      extension: ".ts",
      sizeBytes: 32,
      modifiedAt: new Date().toISOString(),
      mtimeMs: Date.now(),
      contentHash: "hash-b",
      language: "typescript",
      tags: ["source"],
    };
    await index.syncFiles({
      projectId: "default",
      workspaceRoot: root,
      files: [fileA],
      extractSymbols: false,
      pruneMissing: false,
    });
    await index.syncFiles({
      projectId: "default",
      workspaceRoot: root,
      files: [fileB],
      extractSymbols: false,
      pruneMissing: false,
    });
    assert.equal(index.getStats("default", root).fileCount, 2);
  } finally {
    dbm.close();
    cleanup();
  }
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
