/**
 * 上下文去污端到端：虚假完成后刷新续问不得把 raw final 当事实。
 * 运行：npm run test:context-decontamination-e2e
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AgentLoop } from "../src/agent/AgentLoop.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { backfillMessageEnvelopes } from "../src/context/messageEnvelopeBackfill.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import type { ModelResponse } from "../src/model/types.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("虚假完成 Guard 后 restore 不含 raw final 且含纠偏", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ctx-e2e-"));
  try {
    const mgr = new ContextManager({
      dataDir: tmp,
      useLanceDb: false,
      vectorStore: new InMemoryVectorStore(),
      recentMessageCount: 20,
    });
    const chat = async (): Promise<ModelResponse> => ({
      content: JSON.stringify({
        action: "final",
        answer: "依赖安装已完成，npm install 成功。",
      }),
      clientName: "fake",
      modelName: "fake",
      latencyMs: 1,
    });
    const policy = resolveRunPolicy({
      forceMode: true,
      requestedMode: "implement",
      message: "安装依赖",
      requestedPermissionPolicy: "autoRun",
    });
    const loop = new AgentLoop({
      chat,
      registry: createDefaultRegistry(),
      workspaceRoot: tmp,
      contextManager: mgr,
      policy: { ...policy, intent: "run" },
      runId: randomUUID(),
      budget: {
        maxModelTurns: 4,
        maxToolCalls: 4,
        maxReadCalls: 4,
        maxWriteCalls: 2,
        maxShellCalls: 2,
        maxRuntimeMs: 60000,
      },
    });
    const res = await loop.run("安装依赖");
    assert.ok(res.sessionId);
    assert.equal(res.executionMeta.completionStatus, "misleading_completion");

    const pkg = await mgr.restoreContextPackage(res.sessionId!, "安装依赖");
    const rawInAssistant = pkg.messages.filter(
      (m) => m.role === "assistant" && m.content.includes("依赖安装已完成"),
    );
    assert.equal(rawInAssistant.length, 0);

    assert.ok(pkg.contextTrust);
    assert.ok(pkg.contextTrust!.excludedCount >= 1);
    assert.ok(
      pkg.contextTrust!.excluded.some((e) => e.reason === "filtered_raw_model_final"),
    );
    assert.ok(
      pkg.contextTrust!.corrections.length >= 1 ||
        pkg.messages.some((m) => m.messageKind === "guard_notice"),
    );

    const rendered = mgr.buildRenderedPrompt(pkg, "", {
      phase: "pre_call",
      currentUser: "安装依赖",
    });
    const assistantMsgs = rendered.finalMessages.filter((m) => m.role === "assistant");
    assert.equal(
      assistantMsgs.some((m) => m.content.includes("npm install 成功")),
      false,
    );

    mgr.close();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("backfill 将遗留 JSON final 标为 raw_model_final", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ctx-mig-"));
  const mgr = new ContextManager({
    dataDir: tmp,
    useLanceDb: false,
    vectorStore: new InMemoryVectorStore(),
  });
  try {
    assert.equal(mgr.db.schemaVersion, 21);
    const session = mgr.createSession("迁移测试");
    const msgId = randomUUID();
    mgr.db.connection
      .prepare(
        `INSERT INTO messages (
           id, session_id, role, content, token_estimate, is_summarized, created_at
         ) VALUES (?, ?, 'assistant', ?, 10, 0, ?)`,
      )
      .run(
        msgId,
        session.id,
        JSON.stringify({ action: "final", answer: "已完成" }),
        new Date().toISOString(),
      );
    backfillMessageEnvelopes(mgr.db.connection);
    const row = mgr.db.connection
      .prepare(`SELECT message_kind, trusted FROM messages WHERE id = ?`)
      .get(msgId) as { message_kind: string; trusted: number };
    assert.equal(row.message_kind, "raw_model_final");
    assert.equal(row.trusted, 0);
  } finally {
    mgr.close();
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
