/**
 * M6 上下文压缩与持久化自检（无需网络）。
 * 运行：npm run test:context
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentLoop } from "../src/agent/AgentLoop.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { createLlmMemoryExtractor } from "../src/context/MemoryExtractor.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";
import type { ModelResponse } from "../src/model/types.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let tmpDir = "";

test("MessageStore 持久化与计数", async () => {
  const mgr = new ContextManager({
    dataDir: tmpDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
    messageThreshold: 100,
  });
  const session = mgr.createSession("测试会话");
  mgr.appendMessage(session.id, "user", "你好");
  mgr.appendMessage(session.id, "assistant", "你好，有什么可以帮你？");
  assert.equal(mgr.messages.countInSession(session.id), 2);
  mgr.close();
});

test("超过阈值触发 chunk_summary 压缩", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "compress"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
    messageThreshold: 5,
    recentMessageCount: 3,
  });
  const session = mgr.createSession();
  for (let i = 0; i < 12; i += 1) {
    mgr.appendMessage(session.id, "user", `消息 ${i}`);
    mgr.appendMessage(session.id, "assistant", `回复 ${i}`);
  }
  assert.ok(mgr.summaryManager.needsCompression(session.id));
  const compressed = await mgr.summaryManager.compressIfNeeded(session.id);
  assert.ok(compressed);
  assert.equal(compressed.summaryType, "chunk_summary");
  mgr.close();
});

test("ContextRestorer 恢复摘要与最近消息", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "restore"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
    messageThreshold: 4,
    recentMessageCount: 2,
  });
  const session = mgr.createSession();
  for (let i = 0; i < 10; i += 1) {
    mgr.appendMessage(session.id, "user", `u${i}`);
    mgr.appendMessage(session.id, "assistant", `a${i}`);
  }
  await mgr.summaryManager.compressIfNeeded(session.id);
  mgr.summaryManager.ensureSessionSummary(session.id);
  const pkg = await mgr.restoreContextPackage(session.id);
  assert.ok(pkg.systemSections.length > 0);
  assert.ok(pkg.messages.length <= 2);
  mgr.close();
});

test("ContextManager 重建后仍能恢复最近对话", async () => {
  const dataDir = path.join(tmpDir, "reload");
  const mgr = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
    recentMessageCount: 4,
  });
  const session = mgr.createSession("刷新恢复测试");
  mgr.appendMessage(session.id, "user", "之后只能回答 1");
  mgr.appendMessage(session.id, "assistant", "1");
  mgr.close();

  const reopened = new ContextManager({
    dataDir,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
    recentMessageCount: 4,
  });
  const pkg = await reopened.restoreContextPackage(session.id, "现在测试一下");
  assert.ok(pkg.messages.some((m) => m.content.includes("之后只能回答 1")));
  reopened.close();
});

test("FTS 关键词检索 memories", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "fts"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    key: "lang",
    value: "用户偏好使用 TypeScript 与中文回复",
    summary: "偏好 TS",
    importance: 0.9,
  });
  const hits = await mgr.search("TypeScript");
  assert.ok(hits.length >= 1);
  mgr.close();
});

test("MemoryStore 重复 key 更新原记忆", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "memory-upsert-key"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const first = mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    key: "test_lang",
    value: "偏好使用 TypeScript 开发 AgentRelay",
    summary: "TS 偏好",
    importance: 0.7,
  });
  const second = mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    key: "test_lang",
    value: "偏好使用 TypeScript 开发 AgentRelay",
    summary: "TS 偏好更新",
    importance: 0.9,
  });
  const memories = mgr.listMemories("global");
  assert.equal(second.id, first.id);
  assert.equal(memories.filter((m) => m.key === "test_lang").length, 1);
  assert.equal(memories.find((m) => m.key === "test_lang")?.summary, "TS 偏好更新");
  mgr.close();
});

test("current_plan section 从 task_steps 注入", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "current-plan"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession("计划注入");
  const task = mgr.tasks.create({ goal: "实现功能", sessionId: session.id, status: "running" });
  mgr.setActiveTask(session.id, task.id);
  mgr.tasks.upsertSteps(task.id, [
    {
      stepId: "s1",
      position: 0,
      title: "读取配置",
      description: "只读 package.json",
      status: "pending",
      requiredPermissions: ["read"],
      needsConfirmation: false,
    },
    {
      stepId: "s2",
      position: 1,
      title: "写补丁",
      status: "blocked",
      requiredPermissions: ["write"],
      needsConfirmation: true,
      dependsOn: ["s1"],
    },
  ]);
  const pkg = await mgr.restoreContextPackage(session.id, "继续任务");
  const planSection = pkg.systemSections.find((s) => s.type === "current_plan");
  assert.ok(planSection);
  assert.ok(planSection!.items.some((i) => i.text.includes("读取配置")));
  assert.ok(planSection!.items.some((i) => i.text.includes("写补丁")));
  const rendered = mgr.buildRenderedPrompt(pkg);
  assert.ok(rendered.systemSectionsText.includes("当前计划"));
  mgr.close();
});

test("task_steps 持久化子任务元数据", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "subtask-meta"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const task = mgr.tasks.create({ goal: "子任务拆分测试", status: "pending" });
  mgr.tasks.update(task.id, {
    inputs: ["需求文档"],
    outputs: ["PR"],
    acceptanceCriteria: ["CI 通过"],
  });
  mgr.tasks.upsertSteps(task.id, [
    {
      stepId: "s1",
      position: 0,
      title: "调研",
      objective: "阅读现有代码",
      status: "pending",
      requiredPermissions: ["read"],
      needsConfirmation: false,
      requiredContext: ["src/index.ts"],
      availableTools: ["read_file"],
      expectedArtifacts: ["调研摘要"],
      priority: 10,
      acceptance: "列出改动文件",
    },
  ]);
  const steps = mgr.tasks.listSteps(task.id);
  assert.equal(steps[0]!.objective, "阅读现有代码");
  assert.deepEqual(steps[0]!.requiredContext, ["src/index.ts"]);
  assert.equal(steps[0]!.priority, 10);
  const updated = mgr.tasks.get(task.id);
  assert.deepEqual(updated!.inputs, ["需求文档"]);
  mgr.close();
});

test("ContextPackage 含结构化 systemSections", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "pkg"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession("结构化恢复");
  mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    key: "zh",
    value: "默认使用中文回答",
    summary: "中文偏好",
    importance: 0.9,
  });
  const pkg = await mgr.restoreContextPackage(session.id, "中文");
  assert.ok(pkg.systemSections.length > 0);
  const pref = pkg.systemSections.find((s) => s.type === "user_preferences");
  assert.ok(pref);
  assert.ok(pref.items.some((i) => i.text.includes("中文")));
  mgr.close();
});

test("renderedPrompt 由 PromptBuilder 生成且不写回 contextPackage", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "rendered"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.appendMessage(session.id, "user", "测试渲染");
  const pkg = await mgr.restoreContextPackage(session.id);
  const before = structuredClone(pkg);
  const rendered = mgr.buildRenderedPrompt(pkg, "base", {
    phase: "pre_call",
    currentUser: "测试渲染",
  });
  assert.ok(rendered.systemSectionsText.length > 0);
  assert.ok(rendered.finalMessages.length >= 2);
  assert.equal(rendered.finalMessages.at(-1)?.role, "user");
  assert.deepEqual(pkg, before);
  mgr.close();
});

test("contextPackage.messages 含 id 与 createdAt", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "msg-meta"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.saveUserMessage(session.id, "带元数据");
  mgr.saveAssistantMessage(session.id, "回复");
  const pkg = await mgr.restoreContextPackage(session.id);
  assert.ok(pkg.messages.length >= 2);
  for (const m of pkg.messages) {
    assert.ok(m.id);
    assert.ok(m.createdAt);
  }
  mgr.close();
});

test("pre_call 不含本次 assistant 回复", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "pre-call"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.saveUserMessage(session.id, "历史问题");
  mgr.saveAssistantMessage(session.id, "历史回答");
  mgr.saveUserMessage(session.id, "新问题");
  const snap = await mgr.buildContextSnapshot(session.id, {
    phase: "pre_call",
    currentUser: "新问题",
  });
  assert.equal(snap.phase, "pre_call");
  const final = snap.renderedPrompt.finalMessages;
  assert.equal(final.at(-1)?.role, "user");
  assert.equal(final.at(-1)?.content, "新问题");
  const lastUserIdx = final.findLastIndex((m) => m.role === "user");
  assert.ok(!final.slice(lastUserIdx + 1).some((m) => m.role === "assistant"));
  mgr.close();
});

test("PromptBuilder converts persisted tool messages before model calls", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "tool-role-sanitize"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.saveUserMessage(session.id, "inspect file");
  mgr.saveToolMessage(
    session.id,
    'tool read_file result JSON:\n{"path":"src/index.ts","content":"export const x = 1;\\n"}',
  );
  mgr.saveUserMessage(session.id, "continue");

  const snap = await mgr.buildContextSnapshot(session.id, {
    phase: "pre_call",
    userInput: "continue",
    currentUser: "continue",
  });
  const final = snap.renderedPrompt.finalMessages;
  assert.equal(final.some((m) => m.role === "tool"), false);
  assert.ok(
    final.some(
      (m) =>
        m.role === "user" &&
        m.content.includes("历史工具执行结果") &&
        m.content.includes("read_file"),
    ),
  );
  assert.equal(snap.contextPackage.messages.some((m) => m.role === "tool"), true);
  mgr.close();
});

test("file_snippets 从 read_file 工具消息注入", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "file-snippets"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.saveToolMessage(
    session.id,
    '工具「read_file」执行结果（JSON）：\n{"path":"src/index.ts","content":"export const x = 1;\\n"}',
  );
  const pkg = await mgr.restoreContextPackage(session.id);
  const section = pkg.systemSections.find((s) => s.type === "file_snippets");
  assert.ok(section);
  assert.ok(section!.items.some((i) => i.text.includes("src/index.ts")));
  assert.ok(section!.items.some((i) => i.text.includes("export const x")));
  const fileItem = section!.items.find((i) => i.text.includes("src/index.ts"));
  assert.ok(fileItem?.tags?.includes("code-fragment"));
  assert.ok(fileItem?.tags?.includes("ext:ts"));
  assert.ok(fileItem?.tags?.includes("lang:typescript"));
  assert.ok(pkg.taggedFragments.some((f) => f.tags.includes("section:file_snippets")));
  mgr.close();
});

test("记忆写入带 memoryType 标签且可按标签检索", async () => {
  const vectors = new InMemoryVectorStore();
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "tag-search"),
    useLanceDb: false,
    vectorStore: vectors,
  });
  mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    key: "lang",
    value: "偏好 Rust 实现底层模块",
    summary: "Rust 偏好",
    importance: 0.9,
  });
  const hits = await mgr.search("Rust", "global", undefined, ["memory:preference"]);
  assert.ok(hits.length >= 1);
  assert.ok(hits[0]!.tags?.includes("memory:preference"));
  mgr.close();
});

test("finalizeTurn 索引代码片段到向量库", async () => {
  const vectors = new InMemoryVectorStore();
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "index-snippet"),
    useLanceDb: false,
    vectorStore: vectors,
    messageThreshold: 100,
  });
  const session = mgr.createSession();
  mgr.saveUserMessage(session.id, "读文件");
  mgr.saveToolMessage(
    session.id,
    '工具「read_file」执行结果（JSON）：\n{"path":"lib/main.rs","content":"fn main() {}"}',
  );
  mgr.saveAssistantMessage(session.id, "已读取");
  await mgr.finalizeTurn(session.id, "读文件");
  const indexed = vectors.listAll().filter((i) => i.itemType === "code");
  assert.ok(indexed.length >= 1);
  assert.ok(indexed.some((i) => i.tags?.includes("lang:rust")));
  mgr.close();
});

test("recent_tool_results 从 tool 消息注入", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "tool-section"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.saveToolMessage(
    session.id,
    '工具「read_file」执行结果（JSON）：\n{"ok":true,"content":"hello"}',
  );
  const pkg = await mgr.restoreContextPackage(session.id);
  const section = pkg.systemSections.find((s) => s.type === "recent_tool_results");
  assert.ok(section);
  assert.ok(section!.items.some((i) => i.text.includes("read_file")));
  mgr.close();
});

test("deactivateMemory 后记忆不再出现在 listMemories", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "deactivate-api"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const mem = mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    key: "to_remove",
    value: "待停用记忆",
    summary: "待停用",
  });
  assert.ok(mgr.deactivateMemory(mem.id, "test"));
  assert.equal(mgr.getMemory(mem.id)?.isActive, false);
  assert.equal(mgr.listMemories("global").some((m) => m.id === mem.id), false);
  mgr.close();
});

test("post_call 在 saveAssistantMessage 后包含 assistant", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "post-call"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.saveUserMessage(session.id, "你好");
  mgr.saveAssistantMessage(session.id, "你好呀");
  const snap = await mgr.buildContextSnapshot(session.id, { phase: "post_call" });
  assert.equal(snap.phase, "post_call");
  assert.ok(snap.renderedPrompt.finalMessages.some((m) => m.role === "assistant"));
  mgr.close();
});

test("停用记忆不再注入上下文", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "inactive"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  const mem = mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    key: "old_pref",
    value: "旧偏好应被忽略",
    summary: "旧偏好",
  });
  mgr.deactivateMemory(mem.id, "test");
  const pkg = await mgr.restoreContextPackage(session.id, "旧偏好");
  const block = mgr.buildRenderedPrompt(pkg, "", { phase: "pre_call" }).systemSectionsText;
  assert.equal(block.includes("旧偏好应被忽略"), false);
  mgr.close();
});

test("ContextRestorer 长期记忆按内容去重", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "memory-upsert-value"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession("记忆去重");
  mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    value: "偏好使用 TypeScript 开发 AgentRelay",
    summary: "TS 偏好",
  });
  mgr.upsertMemory({
    scope: "global",
    memoryType: "preference",
    value: "偏好使用 TypeScript 开发 AgentRelay",
    summary: "TS 偏好",
  });
  const pkg = await mgr.restoreContextPackage(session.id, "TypeScript");
  const block = mgr.buildRenderedPrompt(pkg, "", { phase: "pre_call" }).systemSectionsText;
  const matches = block.match(/TS 偏好/g) ?? [];
  assert.equal(matches.length, 1);
  mgr.close();
});

test("finalizeTurn 从用户消息抽取偏好记忆", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "extract-turn"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession();
  mgr.saveUserMessage(session.id, "以后请默认使用中文回答");
  mgr.saveAssistantMessage(session.id, "好的");
  await mgr.finalizeTurn(session.id);
  const prefs = mgr.listMemories("global");
  assert.ok(prefs.some((m) => m.key === "lang_zh"));
  mgr.close();
});

test("createLlmMemoryExtractor 解析 JSON 候选", async () => {
  const extractor = createLlmMemoryExtractor(async () =>
    JSON.stringify([
      {
        scope: "global",
        memoryType: "preference",
        key: "editor",
        value: "偏好 VS Code",
        summary: "VS Code",
        importance: 0.8,
        confidence: 0.9,
      },
    ]),
  );
  const candidates = await extractor.extractFromMessages([
    {
      id: "m1",
      sessionId: "s1",
      role: "user",
      content: "我用 VS Code",
      tokenEstimate: 1,
      isSummarized: false,
      createdAt: new Date().toISOString(),
    },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.key, "editor");
});

test("AgentLoop 集成 sessionId 与压缩标记", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "loop"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
    messageThreshold: 2,
  });
  let calls = 0;
  const chat = async (): Promise<ModelResponse> => {
    calls += 1;
    if (calls === 1) {
      return { content: '{"action":"final","answer":"完成"}', model: "mock" };
    }
    return { content: '{"action":"final","answer":"x"}', model: "mock" };
  };
  const loop = new AgentLoop({
    chat,
    registry: { list: () => [], get: () => undefined, run: async () => ({ ok: false, code: "x", error: "n" }) } as never,
    workspaceRoot: tmpDir,
    contextManager: mgr,
  });
  const r1 = await loop.run("第一条");
  assert.ok(r1.sessionId);
  const loop2 = new AgentLoop({
    chat,
    registry: { list: () => [], get: () => undefined, run: async () => ({ ok: false, code: "x", error: "n" }) } as never,
    workspaceRoot: tmpDir,
    contextManager: mgr,
    sessionId: r1.sessionId,
  });
  for (let i = 0; i < 6; i += 1) {
    await loop2.run(`批量 ${i}`);
  }
  const pkg = await mgr.restoreContextPackage(r1.sessionId!);
  assert.ok(pkg.messages.length > 0);
  mgr.close();
});

test("会话标题可修改", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "rename"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession("旧标题");
  const updated = mgr.updateSessionTitle(session.id, "新标题");
  assert.equal(updated?.title, "新标题");
  assert.equal(mgr.getSession(session.id)?.title, "新标题");
  mgr.close();
});

test("deleteSession 级联删除消息与会话", async () => {
  const mgr = new ContextManager({
    dataDir: path.join(tmpDir, "delete"),
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  const session = mgr.createSession("待删除");
  mgr.appendMessage(session.id, "user", "hello");
  assert.equal(mgr.messages.countInSession(session.id), 1);
  assert.ok(mgr.deleteSession(session.id));
  assert.equal(mgr.getSession(session.id), null);
  assert.equal(mgr.messages.countInSession(session.id), 0);
  assert.equal(mgr.deleteSession(session.id), false);
  mgr.close();
});

async function main() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-context-"));
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
  console.log(`\ncontext: ${passed}/${tests.length} 通过`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
