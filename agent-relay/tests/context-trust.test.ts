/**
 * 上下文去污 / trusted 记忆 / ContextRestorer 过滤规则自检。
 * 运行：npx tsx tests/context-trust.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ContextManager } from "../src/context/ContextManager.js";
import {
  claimsCompletionInText,
  evaluateContextMessageTrust,
  shouldIncludeInContext,
} from "../src/context/contextTrust.js";
import { RunFactsLookup } from "../src/context/runFactsLookup.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("raw_model_final 与 tool_action 被过滤", () => {
  const raw = evaluateContextMessageTrust({
    id: "1",
    role: "assistant",
    content: JSON.stringify({ action: "final", answer: "依赖已安装" }),
    createdAt: new Date().toISOString(),
    messageKind: "raw_model_final",
    trusted: false,
  });
  assert.equal(raw.include, false);
  assert.equal(raw.reason, "filtered_raw_model_final");
  assert.ok(raw.needsCorrection);

  const tool = evaluateContextMessageTrust({
    id: "2",
    role: "assistant",
    content: JSON.stringify({ action: "tool", tool: "shell_run" }),
    createdAt: new Date().toISOString(),
    messageKind: "tool_action",
    trusted: false,
  });
  assert.equal(tool.include, false);
  assert.equal(tool.reason, "filtered_tool_action");
});

test("trusted final_answer 与 tool_result 被保留", () => {
  const fin = shouldIncludeInContext({
    id: "3",
    role: "assistant",
    content: "依赖尚未安装，需要先执行 npm install。",
    createdAt: new Date().toISOString(),
    messageKind: "final_answer",
    trusted: true,
    source: "guard",
  });
  assert.equal(fin.include, true);
  assert.equal(fin.reason, "trusted_final");

  const tool = shouldIncludeInContext({
    id: "4",
    role: "tool",
    content: "exitCode=0\nstdout: added 120 packages",
    createdAt: new Date().toISOString(),
    messageKind: "tool_result",
    trusted: true,
    source: "tool",
  });
  assert.equal(tool.include, true);
  assert.equal(tool.reason, "trusted_tool_result");
});

test("misleading_completion run 回查后过滤并纠偏", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ctx-trust-"));
  try {
    const mgr = new ContextManager({
      dataDir: tmp,
      useLanceDb: false,
      vectorStore: new InMemoryVectorStore(),
      recentMessageCount: 10,
    });
    const session = mgr.createSession("去污测试");
    const runId = randomUUID();
    mgr.db.connection
      .prepare(
        `INSERT INTO runs (id, kind, status, session_id, goal, result_json, created_at, updated_at)
         VALUES (?, 'agent', 'completed', ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        session.id,
        "安装依赖",
        JSON.stringify({
          executionMeta: {
            completionStatus: "misleading_completion",
            stopReason: "misleading_completion",
            toolLedger: { successfulShellCalls: 0, successfulWriteCalls: 0 },
            rawModelAnswer: "依赖安装已完成。",
          },
        }),
        new Date().toISOString(),
        new Date().toISOString(),
      );

    mgr.saveUserMessage(session.id, "安装依赖", runId);
    mgr.saveRawModelFinal(session.id, "依赖安装已完成。", runId);

    const pkg = await mgr.restoreContextPackage(session.id, "安装依赖");
    const assistantClaims = pkg.messages.filter(
      (m) => m.role === "assistant" && m.content.includes("依赖安装已完成"),
    );
    assert.equal(assistantClaims.length, 0);

    const correction = pkg.systemSections.find((s) => s.type === "context_corrections");
    assert.ok(correction);
    assert.ok(correction!.items.some((i) => i.text.includes("历史结论已失效")));
    assert.ok(pkg.messages.some((m) => m.messageKind === "guard_notice"));

    assert.ok(pkg.contextTrust);
    assert.equal(pkg.contextTrust!.excludedCount, 1);
    assert.equal(pkg.contextTrust!.excluded[0]?.reason, "filtered_raw_model_final");

    const rendered = mgr.buildRenderedPrompt(pkg, "", {
      phase: "pre_call",
      currentUser: "安装依赖",
    });
    const assistantInPrompt = rendered.finalMessages.filter((m) => m.role === "assistant");
    assert.equal(
      assistantInPrompt.some((m) => m.content.includes("依赖安装已完成")),
      false,
    );
    const joined = rendered.systemSectionsText + JSON.stringify(rendered.finalMessages);
    assert.ok(joined.includes("历史结论已失效") || joined.includes("纠偏"));

    mgr.close();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("run 验证通过的 legacy final 可升级入上下文", () => {
  const runId = randomUUID();
  const lookup = {
    get(id: string | undefined) {
      if (id !== runId) return null;
      return {
        runId,
        goal: "安装依赖",
        completionStatus: "completed_success",
        stopReason: "completed",
        toolLedger: { successfulShellCalls: 1, successfulWriteCalls: 0 },
      };
    },
  } as RunFactsLookup;

  const decision = evaluateContextMessageTrust(
    {
      id: "5",
      role: "assistant",
      content: "依赖安装已完成。",
      createdAt: new Date().toISOString(),
      runId,
    },
    lookup,
  );
  assert.equal(decision.include, true);
  assert.equal(decision.reason, "run_verified_legacy");
  assert.equal(decision.envelope.trusted, true);
});

test("记忆检索排除未验证完成声明", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ctx-mem-"));
  try {
    const mgr = new ContextManager({
      dataDir: tmp,
      useLanceDb: false,
      vectorStore: new InMemoryVectorStore(),
    });
    mgr.upsertMemory({
      scope: "project",
      scopeId: "proj-1",
      memoryType: "fact",
      value: "增强方案已完成，所有文件已写入",
      importance: 0.9,
    });
    mgr.upsertMemory({
      scope: "project",
      scopeId: "proj-1",
      memoryType: "fact",
      value: "项目使用 TypeScript",
      importance: 0.8,
    });
    const hits = await mgr.retriever.retrieve({
      userInput: "增强方案",
      sessionId: "s1",
      projectId: "proj-1",
    });
    assert.ok(!hits.some((h) => h.memory.value.includes("增强方案已完成")));
    assert.ok(claimsCompletionInText("依赖已安装完成"));
    mgr.close();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${t.name}`);
      console.error(error);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length} passed`);
}

main();
