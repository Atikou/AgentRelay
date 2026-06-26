/**
 * parallel_vote 路由决策与管线（mock chat）。
 */
import assert from "node:assert/strict";

import { DecisionEngine } from "../src/model-router/decision-engine.js";
import { FallbackManager } from "../src/model-router/fallback-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import { RuleRouter } from "../src/model-router/route-rules.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
import type { CollaborationRunStore } from "../src/model-router/route-stores.js";
import type { ModelProfile } from "../src/model-router/types.js";
import {
  parseParallelVoteJudge,
  runParallelVotePipeline,
} from "../src/model-orchestrator/pipelines/parallel-vote-pipeline.js";
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

const registry = new ModelRegistry([localDraft, apiGeneral, apiStrong]);
const router = new SmartModelRouter(registry);

function mockResponse(content: string, name: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    clientName: name,
    modelName: "mock",
    location: name.startsWith("local") ? "local" : "remote",
    latencyMs: 5,
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

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("qualityMode=deep 架构任务 → parallel_vote", () => {
  const d = router.route({
    userInput: "帮我设计完整架构方案",
    qualityMode: "deep",
  });
  assert.equal(d.executionStrategy, "parallel_vote");
  assert.ok(d.voteModelIds && d.voteModelIds.length === 2);
  assert.ok(d.judgeModelId);
});

test("qualityMode=balanced 架构仍走 draft-review", () => {
  const d = router.route({ userInput: "帮我设计完整架构方案", qualityMode: "balanced" });
  assert.equal(d.executionStrategy, "local_draft_remote_review");
});

test("parseParallelVoteJudge 解析 winnerIndex", () => {
  const parsed = parseParallelVoteJudge('{"winnerIndex":1,"reason":"更完整"}');
  assert.equal(parsed.winnerIndex, 1);
  assert.equal(parsed.reason, "更完整");
});

test("runParallelVotePipeline 并行作答并由裁决模型选 winner", async () => {
  const rule = new RuleRouter().evaluate({
    userInput: "设计微服务架构",
    qualityMode: "deep",
  });
  const engine = new DecisionEngine(registry);
  const decision = engine.decide(rule, {
    userInput: "设计微服务架构",
    qualityMode: "deep",
  });
  assert.equal(decision.executionStrategy, "parallel_vote");

  const chat: ModelChatFn = async (modelId, _request, meta) => {
    if (meta.role === "review") {
      return {
        response: mockResponse('{"winnerIndex":1,"reason":"candidate 1 better"}', modelId),
        callLogId: "call-judge",
      };
    }
    const idx = decision.voteModelIds?.indexOf(modelId) ?? 0;
    return {
      response: mockResponse(
        idx === 1 ? "详细架构方案 B：含模块边界与验收标准" : "简短方案 A",
        modelId,
      ),
      callLogId: `call-${modelId}`,
    };
  };

  const collab = new MockCollabStore();
  const fallbackCtx: PipelineFallbackContext = {
    manager: new FallbackManager(registry),
    logStore: { create: () => "fb-1" } as PipelineFallbackContext["logStore"],
    recordFallback: () => undefined,
  };

  const input: OrchestratorInput = {
    routerDecision: decision,
    renderedPrompt: {
      systemSectionsText: "",
      finalMessages: [{ role: "user", content: "设计微服务架构" }],
    },
    userInput: "设计微服务架构",
  };

  const result = await runParallelVotePipeline(input, chat, collab as CollaborationRunStore, fallbackCtx);
  assert.equal(result.usedStrategy, "parallel_vote");
  assert.ok(result.finalAnswer.includes("详细架构方案 B"));
  assert.equal(result.voteResult?.winnerIndex, 1);
  assert.equal(result.clientName, decision.voteModelIds?.[1]);
  assert.equal(collab.runs[0]?.strategy, "parallel_vote");
});

test("judge winnerIndex 越界时回退启发式且结果一致", async () => {
  const decision = new DecisionEngine(registry).decide(
    new RuleRouter().evaluate({ userInput: "设计微服务架构", qualityMode: "deep" }),
    { userInput: "设计微服务架构", qualityMode: "deep" },
  );
  assert.equal(decision.executionStrategy, "parallel_vote");

  const chat: ModelChatFn = async (modelId, _request, meta) => {
    if (meta.role === "review") {
      return {
        response: mockResponse('{"winnerIndex":99,"reason":"bad index"}', modelId),
        callLogId: "call-judge",
      };
    }
    const idx = decision.voteModelIds?.indexOf(modelId) ?? 0;
    return {
      response: mockResponse(idx === 1 ? "足够长的候选答案 B，包含验收标准" : "短 A", modelId),
      callLogId: `call-${modelId}`,
    };
  };

  const collab = new MockCollabStore();
  const fallbackCtx: PipelineFallbackContext = {
    manager: new FallbackManager(registry),
    logStore: { create: () => "fb-1" } as PipelineFallbackContext["logStore"],
    recordFallback: () => undefined,
  };
  const result = await runParallelVotePipeline(
    {
      routerDecision: decision,
      renderedPrompt: { systemSectionsText: "", finalMessages: [{ role: "user", content: "设计微服务架构" }] },
      userInput: "设计微服务架构",
    },
    chat,
    collab as CollaborationRunStore,
    fallbackCtx,
  );
  assert.equal(result.voteResult?.winnerIndex, 1);
  assert.equal(result.voteResult?.winnerModelId, decision.voteModelIds?.[1]);
  assert.ok(result.finalAnswer.includes("候选答案 B"));
});

test("单个 voter 失败时协作记录降级收尾，不停留 running", async () => {
  const decision = new DecisionEngine(registry).decide(
    new RuleRouter().evaluate({ userInput: "设计微服务架构", qualityMode: "deep" }),
    { userInput: "设计微服务架构", qualityMode: "deep" },
  );
  assert.equal(decision.executionStrategy, "parallel_vote");
  const survivingModel = decision.voteModelIds?.[0]!;

  const chat: ModelChatFn = async (modelId, _request, meta) => {
    if (modelId !== survivingModel) throw new Error("voter failed");
    return {
      response: mockResponse("幸存候选答案：仍可给出完整方案", modelId),
      callLogId: `call-${modelId}-${meta.role}`,
    };
  };

  const collab = new MockCollabStore();
  const fallbackCtx: PipelineFallbackContext = {
    manager: new FallbackManager(registry),
    logStore: { create: () => "fb-1" } as PipelineFallbackContext["logStore"],
    recordFallback: () => undefined,
  };
  const result = await runParallelVotePipeline(
    {
      routerDecision: decision,
      renderedPrompt: { systemSectionsText: "", finalMessages: [{ role: "user", content: "设计微服务架构" }] },
      userInput: "设计微服务架构",
    },
    chat,
    collab as CollaborationRunStore,
    fallbackCtx,
  );
  assert.equal(result.finalAnswer, "幸存候选答案：仍可给出完整方案");
  assert.equal(collab.runs[0]?.status, "vote_degraded_single");
  assert.equal(collab.runs[0]?.verdict, "revise");
});

async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok ${t.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  not ok ${t.name}`);
      console.error(error);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length} passed`);
}

main();
