/**
 * POST /api/chat/stream 无 clientName 时走 Smart 栈并透传 onToken。
 * 运行：npx tsx tests/smart-chat-stream.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContextManager } from "../src/context/ContextManager.js";
import type { OrchestratorResult } from "../src/model-orchestrator/types.js";
import { AgentRunRegistry } from "../src/orchestrator/AgentRunRegistry.js";
import { ChatService } from "../src/orchestrator/ChatService.js";
import { RunStore } from "../src/orchestrator/RunStore.js";

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ar-smart-stream-"));
  const dataDir = path.join(tmp, "data");
  await mkdir(dataDir, { recursive: true });
  try {
    const ctx = new ContextManager({ dataDir, useLanceDb: false });
    const runs = new RunStore(ctx.db);
    const legacyCalled = { value: false };
    let capturedOnToken: ((delta: string) => void) | undefined;

    const chatService = new ChatService({
      runs,
      contextManager: ctx,
      modelRouter: {
        chat: async () => {
          legacyCalled.value = true;
          throw new Error("不应走 legacy ModelRouter");
        },
      } as never,
      smartModelRouter: {
        routeDetailed: () => ({
          decision: {
            id: "route-test",
            taskType: "simple_qa",
            executionStrategy: "single_model",
            selectedModelId: "local-stream",
            selectedLevel: 1,
            risk: "low",
            reason: "test",
            source: "test",
            candidates: ["local-stream"],
            requireUserConfirmation: false,
          },
          routingContext: {},
        }),
      } as never,
      modelOrchestrator: {
        run: async (input) => {
          capturedOnToken = input.onToken;
          input.onToken?.("你");
          input.onToken?.("好");
          const result: OrchestratorResult = {
            finalAnswer: "你好",
            usedStrategy: "single_model",
            usedModelIds: ["local-stream"],
            modelCallIds: ["call-1"],
            clientName: "local-stream",
            modelName: "local-stream",
            location: "local",
            latencyMs: 2,
          };
          return result;
        },
      } as never,
      agentRunRegistry: new AgentRunRegistry(),
    });

    const events: import("../src/orchestrator/ChatStream.js").ChatStreamEvent[] = [];
    await chatService.runChatStream(
      { message: "测试流式", persist: false, streamTokens: true },
      (e) => events.push(e),
    );

    assert.equal(legacyCalled.value, false);
    assert.equal(typeof capturedOnToken, "function");
    assert.ok(events.some((e) => e.type === "token"));
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type === "done") {
      assert.equal(done.content, "你好");
      assert.ok(done.routerDecision);
    }
    ctx.db.close();
    console.log("ok - smart chat stream delegates onToken to orchestrator");
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore windows sqlite lock
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
