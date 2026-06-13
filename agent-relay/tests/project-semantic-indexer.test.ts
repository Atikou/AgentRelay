/**
 * ProjectSemanticIndexer 自检。
 * 运行：npm run test:project-semantic-indexer
 */
import assert from "node:assert/strict";

import { EmbeddingService, MockEmbeddingProvider } from "../src/context/EmbeddingService.js";
import { ProjectSemanticIndexer } from "../src/context/ProjectSemanticIndexer.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("indexFile + searchFiles 可语义召回项目文件", async () => {
  const embeddings = new EmbeddingService(new MockEmbeddingProvider());
  const vectors = new InMemoryVectorStore();
  const indexer = new ProjectSemanticIndexer(embeddings, vectors);
  const root = "E:/demo/workspace";
  await indexer.indexFile({
    projectId: "default",
    workspaceRoot: root,
    path: "src/agent/AgentLoop.ts",
    summary: "智能体主循环与工具调用",
    symbols: ["AgentLoop"],
    tags: ["source"],
  });
  await indexer.indexFile({
    projectId: "default",
    workspaceRoot: root,
    path: "src/plan/PlanCompiler.ts",
    summary: "计划编译与审批",
    symbols: ["PlanCompiler"],
    tags: ["source"],
  });
  const hits = await indexer.searchFiles({
    projectId: "default",
    query: "智能体主循环 AgentLoop",
    limit: 3,
  });
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.path === "src/agent/AgentLoop.ts"));
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
console.log(`\nproject-semantic-indexer: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
