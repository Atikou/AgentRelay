/**
 * DraftReviewPipeline 解析与流程（mock chat）。
 */
import assert from "node:assert/strict";

import { FallbackManager } from "../src/model-router/fallback-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import type { CollaborationRunStore } from "../src/model-router/route-stores.js";
import type { ModelProfile, RouterDecision } from "../src/model-router/types.js";
import {
  parseDraftReviewResult,
  runDraftReviewPipeline,
} from "../src/model-orchestrator/pipelines/draft-review-pipeline.js";
import type { ModelChatFn, OrchestratorInput, PipelineFallbackContext } from "../src/model-orchestrator/types.js";
import type { ModelResponse } from "../src/model/types.js";

const localDraft: ModelProfile = {
  id: "local-small",
  displayName: "本地轻量",
  provider: "local",
  defaultLevel: 1,
  enabled: true,
  supportsStreaming: true,
  supportsTools: false,
  supportsVision: false,
  supportsJsonMode: false,
  maxInputTokens: 8192,
  maxOutputTokens: 2048,
  relativeCost: "free",
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa"],
  allowedRoles: ["primary", "draft"],
  canDraft: true,
  canReview: false,
  canFinal: true,
};

const apiGeneral: ModelProfile = {
  id: "api-general",
  displayName: "普通 API",
  provider: "api",
  defaultLevel: 2,
  enabled: true,
  supportsStreaming: true,
  supportsTools: true,
  supportsVision: false,
  supportsJsonMode: true,
  maxInputTokens: 32000,
  maxOutputTokens: 4096,
  relativeCost: "medium",
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: true,
  canReview: true,
  canFinal: true,
};

const apiStrong: ModelProfile = {
  id: "api-strong",
  displayName: "强 API",
  provider: "api",
  defaultLevel: 3,
  enabled: true,
  supportsStreaming: true,
  supportsTools: true,
  supportsVision: true,
  supportsJsonMode: true,
  maxInputTokens: 128000,
  maxOutputTokens: 8192,
  relativeCost: "high",
  allowedTaskTypes: ["architecture", "document_qa", "technical_qa"],
  allowedRoles: ["primary", "review", "final"],
  canDraft: false,
  canReview: true,
  canFinal: true,
};

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

class MockFallbackLogStore {
  rows: Array<Record<string, unknown>> = [];
  create(row: Record<string, unknown>): string {
    const id = `fb-${this.rows.length + 1}`;
    this.rows.push({ id, ...row });
    return id;
  }
}

function makeFallbackCtx(): PipelineFallbackContext & { recorded: string[] } {
  const manager = new FallbackManager(new ModelRegistry([localDraft, apiGeneral, apiStrong]));
  const logStore = new MockFallbackLogStore();
  const recorded: string[] = [];
  return {
    manager,
    logStore: logStore as unknown as PipelineFallbackContext["logStore"],
    recordFallback: (id) => recorded.push(id),
    recorded,
  };
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
  const fallbackCtx = makeFallbackCtx();
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
  const result = await runDraftReviewPipeline(
    baseInput,
    chat,
    store as CollaborationRunStore,
    "medium",
    fallbackCtx,
  );
  assert.equal(result.finalAnswer, "草稿内容");
  assert.equal(result.reviewResult?.verdict, "approve");
  assert.equal(result.modelCallIds.length, 2);
});

test("revise 使用 revisedAnswer", async () => {
  const store = new MockCollabStore();
  const fallbackCtx = makeFallbackCtx();
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
  const result = await runDraftReviewPipeline(
    baseInput,
    chat,
    store as CollaborationRunStore,
    "medium",
    fallbackCtx,
  );
  assert.equal(result.finalAnswer, "修正版答案");
});

test("reject 高风险且无 revisedAnswer 走强模型 fallback", async () => {
  const store = new MockCollabStore();
  const fallbackCtx = makeFallbackCtx();
  const chat: ModelChatFn = async (modelId, _req, meta) => {
    if (meta.role === "draft") {
      return { response: mockResponse("坏草稿", "local-small"), callLogId: "1" };
    }
    if (modelId === "api-strong") {
      return { response: mockResponse("强模型重写答案", "api-strong"), callLogId: "3" };
    }
    return {
      response: mockResponse(
        '{"verdict":"reject","confidence":0.2,"issues":[],"revisedAnswer":""}',
        "api-general",
      ),
      callLogId: "2",
    };
  };
  const highInput: OrchestratorInput = {
    ...baseInput,
    routerDecision: { ...baseDecision, risk: "high" },
  };
  const result = await runDraftReviewPipeline(
    highInput,
    chat,
    store as CollaborationRunStore,
    "high",
    fallbackCtx,
  );
  assert.equal(result.finalAnswer, "强模型重写答案");
  assert.equal(result.usedStrategy, "strong_model_direct");
});

test("审查 JSON 首次无效第二次解析成功", async () => {
  const store = new MockCollabStore();
  const fallbackCtx = makeFallbackCtx();
  let reviewCalls = 0;
  const chat: ModelChatFn = async (modelId, _req, meta) => {
    if (meta.role === "draft") {
      return { response: mockResponse("草稿正文", "local-small"), callLogId: "1" };
    }
    reviewCalls += 1;
    const content =
      reviewCalls === 1
        ? "not-json"
        : '{"verdict":"approve","confidence":1,"issues":[],"revisedAnswer":""}';
    return { response: mockResponse(content, "api-general"), callLogId: `r-${reviewCalls}` };
  };
  const result = await runDraftReviewPipeline(
    baseInput,
    chat,
    store as CollaborationRunStore,
    "medium",
    fallbackCtx,
  );
  assert.equal(reviewCalls, 2);
  assert.equal(result.finalAnswer, "草稿正文");
  assert.equal(fallbackCtx.recorded.length, 0);
});

test("审查 JSON 两次失败升级强模型且 draft 不进 finalAnswer", async () => {
  const store = new MockCollabStore();
  const fallbackCtx = makeFallbackCtx();
  const chat: ModelChatFn = async (modelId, _req, meta) => {
    if (meta.role === "draft") {
      return { response: mockResponse("低质量草稿", "local-small"), callLogId: "1" };
    }
    if (modelId === "api-strong") {
      return { response: mockResponse("强模型重生答案", "api-strong"), callLogId: "3" };
    }
    return { response: mockResponse("still-not-json", "api-general"), callLogId: "2" };
  };
  const result = await runDraftReviewPipeline(
    baseInput,
    chat,
    store as CollaborationRunStore,
    "medium",
    fallbackCtx,
  );
  assert.equal(result.finalAnswer, "强模型重生答案");
  assert.notEqual(result.finalAnswer, "低质量草稿");
  assert.equal(result.usedStrategy, "strong_model_direct");
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
