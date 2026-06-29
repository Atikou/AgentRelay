/**
 * API 规范自检：结构合法且覆盖主要 HTTP 路由。
 * 运行：npm run test:api-spec
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(__dirname, "../public/api-spec.json");
const apiDocsHtml = path.join(__dirname, "../public/api-docs.html");
const scalarJs = path.join(__dirname, "../public/vendor/scalar-api-reference.js");

import { HTTP_ROUTE_PATHS } from "../src/server/httpRouteRegistry.js";

const REQUIRED_PATHS = [...HTTP_ROUTE_PATHS];

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("api-spec.json 可解析且含 AgentRelay 标题", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as {
    openapi: string;
    info: { title: string };
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
    tags: unknown[];
  };
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.info.title.includes("AgentRelay"));
  assert.ok(spec.components.schemas.ErrorBody);
  assert.ok(spec.components.schemas.RunRecord);
  assert.ok(Array.isArray(spec.tags) && spec.tags.length >= 9);
});

test("主要 API 路径已在规范中登记", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as { paths: Record<string, unknown> };
  for (const p of REQUIRED_PATHS) {
    assert.ok(spec.paths[p], `missing path: ${p}`);
  }
});

test("动态路径含 path 参数", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as { paths: Record<string, unknown> };
  assert.ok(spec.paths["/api/background/{taskId}"]);
  assert.ok(spec.paths["/api/scheduler/triggers/{triggerId}/pause"]);
  assert.ok(spec.paths["/api/context/sessions/{sessionId}/restore"]);
});

test("Agent API 规范登记 permissionPolicy", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as {
    components: {
      schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }>;
    };
  };
  const requestPolicy = spec.components.schemas.AgentRequest?.properties?.permissionPolicy;
  const resumePolicy = spec.components.schemas.AgentResumeRequest?.properties?.permissionPolicy;
  const metaPolicy = spec.components.schemas.AgentExecutionMeta?.properties?.permissionPolicy;
  assert.ok(requestPolicy?.enum?.includes("readOnly"));
  assert.ok(requestPolicy?.enum?.includes("autoRun"));
  assert.ok(resumePolicy?.enum?.includes("confirmBeforeRun"));
  assert.ok(metaPolicy?.enum?.includes("confirmBeforeEdit"));
});

test("M2 并行投票与管线图字段进入 API 规范", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as {
    components: {
      schemas: Record<string, { properties?: Record<string, unknown> }>;
    };
    paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
  };
  const chat = spec.components.schemas.ChatResponse?.properties ?? {};
  const decision = spec.components.schemas.RouterDecision?.properties ?? {};
  const vote = spec.components.schemas.ParallelVoteResult?.properties ?? {};
  const graph = spec.components.schemas.PipelineGraph?.properties ?? {};
  assert.ok(chat.voteResult);
  assert.ok(decision.voteModelIds);
  assert.ok(decision.judgeModelId);
  assert.ok(vote.winnerModelId);
  assert.ok(graph.mermaid);
  assert.ok(spec.paths["/api/routing/logs"]?.get?.responses?.["200"]);
});

test("权限与续跑 API 规范登记 JIT / shell allow_workspace", async () => {
  const raw = await readFile(specPath, "utf-8");
  const spec = JSON.parse(raw) as {
    paths: Record<string, Record<string, { responses?: Record<string, unknown>; description?: string }>>;
    components: { schemas: Record<string, unknown> };
  };
  const respond = spec.paths["/api/permission-requests/{requestId}/respond"]?.post;
  assert.ok(respond);
  const respondDoc = respond!.description ?? "";
  assert.ok(respondDoc.includes("allow_workspace") && respondDoc.includes("shell"));
  assert.ok(spec.paths["/api/runs/{runId}/resume-permission"]?.post);
  assert.ok(spec.paths["/api/runs/{runId}/resume-plan-handoff"]?.post);
  assert.ok(spec.paths["/api/plan-handoffs/pending"]?.get);
  assert.ok(spec.paths["/api/plan-handoffs/{handoffId}/respond"]?.post);
  assert.ok(spec.components.schemas.PermissionRequestPayload);
  assert.ok(spec.components.schemas.ToolRunError);
  const resume = spec.components.schemas.AgentResumeRequest as {
    properties?: { permissionPolicy?: { description?: string } };
  };
  assert.match(resume.properties?.permissionPolicy?.description ?? "", /忽略/);
});

test("api-docs 页面使用 Scalar 官方 script 集成", async () => {
  const html = await readFile(apiDocsHtml, "utf-8");
  assert.ok(html.includes('id="api-reference"'));
  assert.ok(html.includes('data-url="/api-spec.json"'));
  assert.ok(html.includes("/vendor/scalar-api-reference.js"));
  assert.ok(!html.includes("cdn.jsdelivr.net"));
  assert.ok(!html.includes("Scalar.createApiReference"));
  assert.ok(!html.includes('<div id="api-reference"'));
  const js = await readFile(scalarJs, "utf-8");
  assert.ok(js.length > 10_000);
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}
console.log(`api-spec: ${passed}/${tests.length} passed`);
