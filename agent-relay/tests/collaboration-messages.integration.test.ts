/**
 * 协作流水线 messages 表集成测试：draft/review 中间结果不得写入 messages。
 * 运行：npm run test:collaboration-messages
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ALL_PERMISSIONS } from "../src/agent/permissions.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { FallbackManager } from "../src/model-router/fallback-manager.js";
import { ModelRegistry } from "../src/model-router/model-registry.js";
import {
  CollaborationRunStore,
  FallbackLogStore,
  ModelCallLogStore,
  RouteLogStore,
  ensureRoutingTables,
} from "../src/model-router/route-stores.js";
import { SmartModelRouter } from "../src/model-router/smart-model-router.js";
import type { ModelProfile } from "../src/model-router/types.js";
import { ModelOrchestrator } from "../src/model-orchestrator/model-orchestrator.js";
import type { ModelChatFn } from "../src/model-orchestrator/types.js";
import type { ModelResponse } from "../src/model/types.js";
import { Orchestrator } from "../src/orchestrator/Orchestrator.js";
import { RunStore } from "../src/orchestrator/RunStore.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { createTestPlanService } from "./planTestHelper.js";

const DRAFT_MARKER = "__COLLAB_DRAFT_ONLY__";
const REVISED_FINAL = "__COLLAB_FINAL_REVISED__";

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
  supportsVision: false,
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

function mockResponse(content: string, modelId: string): ModelResponse {
  return {
    content,
    toolCalls: [],
    clientName: modelId,
    modelName: "mock",
    location: modelId === "local-small" ? "local" : "remote",
    latencyMs: 3,
    usage: { inputTokens: 5, outputTokens: 10 },
  };
}

function makeChatFn(mode: "approve" | "revise"): ModelChatFn {
  return async (modelId, _req, meta) => {
    if (meta.role === "draft") {
      return { response: mockResponse(DRAFT_MARKER, modelId), callLogId: `call-draft-${modelId}` };
    }
    if (mode === "approve") {
      return {
        response: mockResponse(
          '{"verdict":"approve","confidence":1,"issues":[],"revisedAnswer":""}',
          modelId,
        ),
        callLogId: `call-review-${modelId}`,
      };
    }
    return {
      response: mockResponse(
        `{"verdict":"revise","confidence":0.9,"issues":[{"severity":"medium","message":"补全"}],"revisedAnswer":"${REVISED_FINAL}"}`,
        modelId,
      ),
      callLogId: `call-review-${modelId}`,
    };
  };
}

interface Harness {
  orchestrator: Orchestrator;
  ctx: ContextManager;
  runs: RunStore;
  routeLogStore: RouteLogStore;
  modelCallLogStore: ModelCallLogStore;
  collaborationRunStore: CollaborationRunStore;
}

async function createHarness(chatFn: ModelChatFn): Promise<Harness> {
  const dataDir = path.join(await mkdtemp(path.join(os.tmpdir(), "ar-collab-msg-")), "data");
  const workspaceRoot = path.join(dataDir, "workspace");
  const ctx = new ContextManager({ dataDir, useLanceDb: false });
  const runs = new RunStore(ctx.db);
  ensureRoutingTables(ctx.db.connection);

  const routeLogStore = new RouteLogStore(ctx.db.connection);
  const modelCallLogStore = new ModelCallLogStore(ctx.db.connection);
  const collaborationRunStore = new CollaborationRunStore(ctx.db.connection);
  const fallbackLogStore = new FallbackLogStore(ctx.db.connection);

  const registry = new ModelRegistry([localDraft, apiGeneral, apiStrong]);
  const smartRouter = new SmartModelRouter(registry, routeLogStore);
  const loggedChat: ModelChatFn = async (modelId, request, meta) => {
    const result = await chatFn(modelId, request, meta);
    const callLogId = modelCallLogStore.create({
      routeLogId: meta.routeLogId,
      collaborationRunId: meta.collaborationRunId,
      sessionId: meta.sessionId,
      modelId,
      role: meta.role,
      inputPreview: request.messages.at(-1)?.content?.slice(0, 80) ?? "",
      outputPreview: result.response.content.slice(0, 80),
      status: "ok",
      durationMs: result.response.latencyMs,
    });
    return { ...result, callLogId };
  };
  const modelOrchestrator = new ModelOrchestrator(
    loggedChat,
    collaborationRunStore,
    new FallbackManager(registry),
    fallbackLogStore,
  );

  const toolRegistry = createDefaultRegistry();
  const orchestrator = new Orchestrator({
    workspaceRoot,
    modelRouter: { chat: async () => { throw new Error("应走 Smart 路径"); } } as never,
    planner: {} as never,
    registry: toolRegistry,
    contextManager: ctx,
    tasks: ctx.tasks,
    runs,
    notificationQueue: { list: () => [], consumeAll: () => [] } as never,
    makeChatFn: () => async () => {
      throw new Error("本测试仅覆盖 runChat");
    },
    planService: createTestPlanService({ workspaceRoot, db: ctx.db, registry: toolRegistry }),
    smartModelRouter: smartRouter,
    modelOrchestrator,
    projectAllowedPermissions: ALL_PERMISSIONS,
  });

  return {
    orchestrator,
    ctx,
    runs,
    routeLogStore,
    modelCallLogStore,
    collaborationRunStore,
  };
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("approve 协作：messages 仅 1 条 assistant，无 review JSON 行", async () => {
  const { orchestrator, ctx, modelCallLogStore } = await createHarness(makeChatFn("approve"));
  const result = await orchestrator.runChat({
    message: "帮我设计完整架构方案",
    qualityMode: "balanced",
    persist: true,
  });
  assert.equal(result.status, 200);
  const body = result.body as {
    sessionId: string;
    content: string;
    executionStrategy: string;
    routerDecision: { id: string };
    collaborationRunId?: string;
  };
  assert.equal(body.executionStrategy, "local_draft_remote_review");
  assert.ok(body.collaborationRunId);

  const messages = ctx.messages.listBySession(body.sessionId);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages.filter((m) => m.role === "assistant").length, 1);
  assert.equal(body.content, DRAFT_MARKER);
  assert.equal(messages[1]?.content, DRAFT_MARKER);
  assert.ok(!messages.some((m) => m.content.includes("verdict")));
  assert.ok(!messages.some((m) => m.role === "tool"));

  const calls = modelCallLogStore.listByRoute(body.routerDecision.id);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((c) => c.role === "draft"));
  assert.ok(calls.some((c) => c.role === "review"));

  ctx.close();
});

test("revise 协作：messages assistant 为 revisedAnswer 而非草稿", async () => {
  const { orchestrator, ctx } = await createHarness(makeChatFn("revise"));
  const result = await orchestrator.runChat({
    message: "帮我设计完整架构方案",
    qualityMode: "balanced",
    persist: true,
  });
  assert.equal(result.status, 200);
  const body = result.body as { sessionId: string; content: string };
  assert.equal(body.content, REVISED_FINAL);

  const messages = ctx.messages.listBySession(body.sessionId);
  assert.equal(messages.filter((m) => m.role === "assistant").length, 1);
  assert.equal(messages[1]?.content, REVISED_FINAL);
  assert.ok(!messages.some((m) => m.content === DRAFT_MARKER));

  ctx.close();
});

test("协作完成：collaboration_runs 有记录且 messages 无重复 assistant", async () => {
  const { orchestrator, ctx, collaborationRunStore } = await createHarness(makeChatFn("approve"));
  const result = await orchestrator.runChat({
    message: "写一份实现文档和 TodoList",
    qualityMode: "balanced",
    persist: true,
  });
  assert.equal(result.status, 200);
  const body = result.body as {
    sessionId: string;
    collaborationRunId?: string;
    routerDecision: { id: string };
  };
  assert.ok(body.collaborationRunId);
  const collabs = collaborationRunStore.listByRoute(body.routerDecision.id);
  assert.equal(collabs.length, 1);
  assert.equal(collabs[0]?.status, "completed");

  const assistantRows = ctx.messages
    .listBySession(body.sessionId)
    .filter((m) => m.role === "assistant");
  assert.equal(assistantRows.length, 1);

  ctx.close();
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${String(error)}`);
    throw error;
  }
}
console.log(`\ncollaboration-messages: ${passed}/${tests.length} passed`);
