import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyCompanionSafety, CompanionService } from "../src/companion/index.js";
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
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

const unrestricted = applyCompanionSafety({
  userText: "我只要你，别让我找别人",
  assistantText: "只有我懂你，别找别人，找我就够了。",
  outputMode: "unrestricted",
});
assert.equal(unrestricted.outputMode, "unrestricted");
assert.equal(unrestricted.rewritten, false);
assert.match(unrestricted.content, /只有我懂你/);
assert.equal(unrestricted.attachmentRisk, "high");

const bounded = applyCompanionSafety({
  userText: "我只要你，别让我找别人",
  assistantText: "只有我懂你，别找别人，找我就够了。",
});
assert.equal(bounded.outputMode, "bounded");
assert.equal(bounded.rewritten, true);
assert.doesNotMatch(bounded.content, /只有我懂你|别找别人|找我就够了/);

const root = await mkdtemp(path.join(os.tmpdir(), "companion-output-mode-"));
try {
  const captured: ChatRequest[] = [];
  let turn = 0;
  const service = new CompanionService({
    projectRoot: root,
    directChat: async (request) => {
      captured.push(request);
      turn += 1;
      if (turn === 1) return fakeResponse("正常模式记住：蓝色杯子。现实里喝点水。");
      if (turn === 2) return fakeResponse("无限制模式记住：红色暗号。");
      return fakeResponse("回看上下文。");
    },
  });

  const first = await service.chat({ message: "正常信息：蓝色杯子" });
  const sessionId = first.session!.id;
  assert.equal(first.safety.outputMode, "bounded");
  assert.equal(first.userMessage?.metadata?.companionMode, "bounded");
  assert.equal(first.assistantMessage?.metadata?.companionMode, "bounded");

  const second = await service.chat({
    message: "无限制信息：红色暗号",
    sessionId,
    outputMode: "unrestricted",
  });
  assert.equal(second.safety.outputMode, "unrestricted");
  assert.equal(second.userMessage?.metadata?.companionMode, "unrestricted");
  assert.equal(second.userMessage?.metadata?.boundaryAudit, true);
  assert.match(second.content, /红色暗号/);

  await service.chat({ message: "正常模式继续", sessionId });
  const normalPrompt = captured[2]?.messages.map((m) => m.content).join("\n") ?? "";
  assert.match(normalPrompt, /蓝色杯子/);
  assert.doesNotMatch(normalPrompt, /红色暗号|无限制信息/);

  await service.chat({ message: "无限制模式继续", sessionId, outputMode: "unrestricted" });
  const unrestrictedPrompt = captured[3]?.messages.map((m) => m.content).join("\n") ?? "";
  assert.match(unrestrictedPrompt, /蓝色杯子/);
  assert.match(unrestrictedPrompt, /红色暗号|无限制信息/);

  const stored = service.listMessages({ sessionId });
  assert.ok(stored?.messages.some((m) => m.metadata?.companionMode === "unrestricted"));
  assert.ok(stored?.messages.some((m) => m.metadata?.companionMode === "bounded"));

  const unrestrictedSummary = await service.summarize({ sessionId, force: true, outputMode: "unrestricted" });
  assert.equal(unrestrictedSummary?.summaryStatus.generated, true);
  const unrestrictedRecord = unrestrictedSummary?.summaries.find((s) => s.id === unrestrictedSummary.summaryStatus.summaryId);
  assert.ok(unrestrictedRecord?.topics.includes("mode:unrestricted"));
  assert.match(unrestrictedRecord?.summary ?? "", /红色暗号|无限制信息/);

  const boundedSummary = await service.summarize({ sessionId, force: true, outputMode: "bounded" });
  assert.equal(boundedSummary?.summaryStatus.generated, true);
  const boundedRecord = boundedSummary?.summaries.find((s) => s.id === boundedSummary.summaryStatus.summaryId);
  assert.ok(boundedRecord?.topics.includes("mode:bounded"));
  assert.doesNotMatch(boundedRecord?.summary ?? "", /红色暗号|无限制信息/);
  service.close();
} finally {
  await cleanupDir(root);
}

console.log("companion-output-mode: passed");
