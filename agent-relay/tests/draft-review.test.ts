/**
 * DraftReviewPipeline 解析与流程（mock chat）。
 */
import assert from "node:assert/strict";

import type { CollaborationRunStore } from "../src/model-router/route-stores.js";
import type { RouterDecision } from "../src/model-router/types.js";
import {
  parseDraftReviewResult,
  runDraftReviewPipeline,
} from "../src/model-orchestrator/pipelines/draft-review-pipeline.js";
import type { ModelChatFn, OrchestratorInput } from "../src/model-orchestrator/types.js";
import type { ModelResponse } from "../src/model/types.js";

function mockResponse(content: string, name: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    clientName: name,
    modelName: "mock",
    location: name.startsWith("local") ? "local" : "remote",
    latencyMs: 10,
  };
}

class MockCollabStore implements Pick<CollaborationRunStore, "create" | "finish"> {
  runs: Array<Record<string, unknown>> = [];
  create(input: Parameters<CollaborationRunStore["create"]>[0]): string {
    const id = `collab-${this.runs.length + 1}`;
    this.runs.push({ id, ...input, status: "running" });
    return id;
  }
  finish(id: string, patch: Parameters<CollaborationRunStore["finish"]>[1]): void {
    const row = this.runs.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  }
}

const baseDecision: RouterDecision = {
  id: "route-1",
  taskType: "architecture",
  selectedLevel: 3,
  risk: "medium",
  reason: "test",
  source: "rule",
  executionStrategy: "local_draft_remote_review",
  draftModelId: "local-small",
  reviewModelId: "api-general",
  finalModelId: "api-general",
  requireUserConfirmation: false,
  candidates: ["local-small", "api-general"],
  createdAt: new Date().toISOString(),
};

const baseInput: OrchestratorInput = {
  routerDecision: baseDecision,
  userInput: "设计架构",
  renderedPrompt: {
    systemSectionsText: "",
    finalMessages: [{ role: "user", content: "设计架构" }],
  },
};

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("parseDraftReviewResult 解析 approve JSON", () => {
  const r = parseDraftReviewResult(
    '{"verdict":"approve","confidence":0.9,"issues":[],"revisedAnswer":""}',
  );
  assert.equal(r.verdict, "approve");
});

test("approve 使用 draft 作为 finalAnswer", async () => {
  const store = new MockCollabStore();
  let call = 0;
  const chat: ModelChatFn = async (modelId) => {
    call += 1;
    if (modelId === "local-small") {
      return { response: mockResponse("草稿内容", "local-small"), callLogId: `log-${call}` };
    }
    return {
      response: mockResponse(
        '{"verdict":"approve","confidence":1,"issues":[],"revisedAnswer":""}',
        "api-general",
      ),
      callLogId: `log-${call}`,
    };
  };
  const result = await runDraftReviewPipeline(baseInput, chat, store as CollaborationRunStore, "medium");
  assert.equal(result.finalAnswer, "草稿内容");
  assert.equal(result.reviewResult?.verdict, "approve");
  assert.equal(result.modelCallIds.length, 2);
});

test("revise 使用 revisedAnswer", async () => {
  const store = new MockCollabStore();
  const chat: ModelChatFn = async (modelId, _req, meta) => {
    if (meta.role === "draft") {
      return { response: mockResponse("草稿", "local-small"), callLogId: "1" };
    }
    return {
      response: mockResponse(
        '{"verdict":"revise","confidence":0.8,"issues":[{"severity":"medium","message":"遗漏风险"}],"revisedAnswer":"修正版答案"}',
        "api-general",
      ),
      callLogId: "2",
    };
  };
  const result = await runDraftReviewPipeline(baseInput, chat, store as CollaborationRunStore, "medium");
  assert.equal(result.finalAnswer, "修正版答案");
});

test("reject 高风险且无 revisedAnswer 抛错", async () => {
  const store = new MockCollabStore();
  const chat: ModelChatFn = async (modelId, _req, meta) => {
    if (meta.role === "draft") {
      return { response: mockResponse("坏草稿", "local-small"), callLogId: "1" };
    }
    return {
      response: mockResponse(
        '{"verdict":"reject","confidence":0.2,"issues":[],"revisedAnswer":""}',
        "api-general",
      ),
      callLogId: "2",
    };
  };
  await assert.rejects(() =>
    runDraftReviewPipeline(baseInput, chat, store as CollaborationRunStore, "high"),
  );
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${t.name}\n    ${String(error)}`);
    failed += 1;
  }
}
console.log(`\ndraft-review: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
