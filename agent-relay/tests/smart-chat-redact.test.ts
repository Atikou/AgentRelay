/**
 * Smart 栈远程 prompt 脱敏（与 legacy ModelRouter 对齐）。
 * 运行：npx tsx tests/smart-chat-redact.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createModelChatFn } from "../src/model-router/create-model-chat.js";
import { ModelCallLogStore, ensureRoutingTables } from "../src/model-router/route-stores.js";
import type { ChatRequest, ModelClient, ModelResponse } from "../src/model/types.js";
import { createSegmentedTraceLogger } from "../src/trace/TraceLogger.js";
import { readRecentTraceEvents } from "../src/trace/traceReader.js";

function mockRemoteClient(): ModelClient & { getLastRequest: () => ChatRequest | undefined } {
  let lastRequest: ChatRequest | undefined;
  const client: ModelClient = {
    name: "mock-remote",
    model: "gpt-test",
    provider: "openai-compatible",
    location: "remote",
    async chat(request) {
      lastRequest = request;
      const response: ModelResponse = {
        clientName: client.name,
        modelName: client.model,
        location: client.location,
        content: "ok",
        latencyMs: 1,
      };
      return response;
    },
  };
  return Object.assign(client, {
    getLastRequest: () => lastRequest,
  });
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ar-smart-redact-"));
  const db = new DatabaseSync(":memory:");
  ensureRoutingTables(db);
  try {
    const client = mockRemoteClient();
    const clientMap = new Map<string, ModelClient>([["mock-remote", client]]);
    const callLogStore = new ModelCallLogStore(db);
    const tracesDir = path.join(tmp, "traces");
    const { logger: trace, index } = createSegmentedTraceLogger(tracesDir, {
      rotationMaxBytes: 1024 * 1024,
      rotationMaxAgeHours: 24,
    });

    const chatFn = createModelChatFn(clientMap, callLogStore, trace);
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    await chatFn(
      "mock-remote",
      { messages: [{ role: "user", content: `key=${secret}` }] },
      { role: "primary" },
    );

    const sent = client.getLastRequest();
    assert.ok(sent);
    assert.ok(!sent.messages[0]!.content.includes(secret), "远程请求应脱敏密钥");
    assert.ok(sent.messages[0]!.content.includes("[REDACTED_KEY]"));

    const events = readRecentTraceEvents(trace.getActiveFile(), { limit: 5, redact: false });
    assert.ok(events.some((e) => e.type === "model_prompt_redacted"));

    await trace.close();
    index.close();
    console.log("ok - smart path redacts remote prompts");
  } finally {
    db.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
