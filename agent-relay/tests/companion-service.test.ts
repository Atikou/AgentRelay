import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompanionService } from "../src/companion/index.js";
import type { ChatRequest, ModelResponse } from "../src/model/types.js";

function fakeResponse(content: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    clientName: "fake",
    modelName: "fake-model",
    location: "local",
    latencyMs: 1,
  };
}

async function cleanupDir(root: string): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("chat 保存用户和 assistant 消息", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-service-"));
  try {
    const service = new CompanionService({
      projectRoot: root,
      directChat: async () => fakeResponse("听起来你今天有点累。我在这里听你说，也建议你回到现实里先喝点水，早点休息。"),
    });
    const result = await service.chat({ message: "今天有点累" });
    assert.ok(result.session?.id);
    assert.equal(result.userMessage?.role, "user");
    assert.equal(result.assistantMessage?.role, "assistant");
    assert.equal(result.safety.realityAnchored, true);
    const listed = service.listMessages({ sessionId: result.session!.id });
    assert.equal(listed?.messages.length, 2);
    service.close();
  } finally {
    await cleanupDir(root);
  }
});

test("incognito 不落长期会话", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-service-"));
  try {
    const service = new CompanionService({
      projectRoot: root,
      directChat: async () => fakeResponse("我在这里听你说。也别忘了现实里的休息和身边的人。"),
    });
    const result = await service.chat({ message: "随便聊聊", incognito: true });
    assert.equal(result.session, undefined);
    assert.equal(result.userMessage, undefined);
    assert.equal(service.listSessions().sessions.length, 0);
    service.close();
  } finally {
    await cleanupDir(root);
  }
});

test("chat prompt 不包含工具协议", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-service-"));
  try {
    let captured: ChatRequest | undefined;
    const service = new CompanionService({
      projectRoot: root,
      directChat: async (request) => {
        captured = request;
        return fakeResponse("慢慢来，我听着。也可以看看现实里有没有一个能说句话的人。");
      },
    });
    await service.chat({ message: "陪我说话" });
    assert.equal(captured?.tools, undefined);
    const prompt = captured?.messages.map((m) => m.content).join("\n") ?? "";
    assert.doesNotMatch(prompt, /ToolRegistry|PermissionGuard/);
    assert.match(prompt, /只输出自然语言/);
    service.close();
  } finally {
    await cleanupDir(root);
  }
});

test("摘要达到阈值后生成 summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-service-"));
  try {
    const service = new CompanionService({
      projectRoot: root,
      directChat: async () => fakeResponse("我听见了。我们也把注意力放回现实里的一个小动作。"),
    });
    let sessionId = "";
    for (let i = 0; i < 9; i += 1) {
      const result = await service.chat({ message: `第 ${i} 轮`, sessionId: sessionId || undefined });
      sessionId = result.session!.id;
    }
    const messages = service.listMessages({ sessionId });
    assert.ok((messages?.summaries.length ?? 0) >= 1);
    service.close();
  } finally {
    await cleanupDir(root);
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
console.log(`companion-service: ${passed}/${tests.length} passed`);
