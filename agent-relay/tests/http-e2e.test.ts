/**
 * HTTP 层端到端自检：真实监听端口 + fetch，覆盖配置、编排、API 参考页。
 * 运行：npm run test:http-e2e
 */
import assert from "node:assert/strict";
import type { Server } from "node:http";

import { createAppContext, type AppContext } from "../src/app/createAppContext.js";
import { createHttpServer } from "../src/server/createHttpServer.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let app: AppContext;
let server: Server;
let baseUrl = "";

async function startServer(): Promise<void> {
  app = createAppContext();
  server = createHttpServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function stopServer(): Promise<void> {
  await app.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /api/config 返回 capabilities", async () => {
  const res = await get("/api/config");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    profile: string;
    capabilities: { orchestrator?: boolean; runsApi?: boolean; highRiskConfirmation?: boolean };
  };
  assert.ok(body.profile);
  assert.equal(body.capabilities.orchestrator, true);
  assert.equal(body.capabilities.runsApi, true);
  assert.equal(body.capabilities.highRiskConfirmation, true);
});

test("GET /api/runs 返回 runs 数组", async () => {
  const res = await get("/api/runs?limit=5");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { runs: unknown[] };
  assert.ok(Array.isArray(body.runs));
});

test("GET /api-spec.json 可解析", async () => {
  const res = await get("/api-spec.json");
  assert.equal(res.status, 200);
  const spec = (await res.json()) as { info: { title: string }; paths: Record<string, unknown> };
  assert.ok(spec.info.title.includes("AgentRelay"));
  assert.ok(spec.paths["/api/runs"]);
});

test("GET /api-docs 返回含 data-url 的 HTML", async () => {
  const res = await get("/api-docs");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('data-url="/api-spec.json"'));
  assert.ok(html.includes("AgentRelay"));
});

test("GET /vendor/scalar-api-reference.js 可加载", async () => {
  const res = await get("/vendor/scalar-api-reference.js");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.length > 100_000);
  assert.ok(text.includes("createApiReference"));
});

test("GET /api/routing/profiles 返回能力矩阵", async () => {
  const res = await get("/api/routing/profiles");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    profiles: unknown[];
    matrix: unknown[];
    coverage: unknown[];
    validationWarnings: unknown[];
    generatedAt: string;
    enabledCount: number;
    validationErrors: unknown[];
    runtimeHintsByModelId: Record<string, unknown>;
  };
  assert.ok(Array.isArray(body.profiles));
  assert.ok(body.matrix.length >= 10);
  assert.ok(Array.isArray(body.coverage));
  assert.ok(Array.isArray(body.validationWarnings));
  assert.ok(typeof body.generatedAt === "string");
  assert.ok(typeof body.enabledCount === "number");
  assert.ok(Array.isArray(body.validationErrors));
  assert.ok(body.runtimeHintsByModelId && typeof body.runtimeHintsByModelId === "object");
});

test("GET /api/models/catalog 返回 entries 数组", async () => {
  const res = await get("/api/models/catalog");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { entries: unknown[] };
  assert.ok(Array.isArray(body.entries));
});

test("POST /api/agent/stream 空 message 返回 400 JSON", async () => {
  const res = await postJson("/api/agent/stream", { message: "" });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

test("POST /api/agent 非法 permissionPolicy 返回 400", async () => {
  const res = await postJson("/api/agent", { message: "运行测试", permissionPolicy: "fullAccess" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /permissionPolicy/);
});

test("POST /api/task/dry-run 缺 plan 返回 400", async () => {
  const res = await postJson("/api/task/dry-run", {});
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("计划"));
});

test("POST /api/tools/run 高风险 shell 未确认时只返回预览", async () => {
  const res = await postJson("/api/tools/run", {
    name: "shell_run",
    input: { command: "rm -rf /" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    needsConfirmation?: boolean;
    tool?: string;
    preview?: { kind?: string; risk?: { level?: string } };
  };
  assert.equal(body.needsConfirmation, true);
  assert.equal(body.tool, "shell_run");
  assert.equal(body.preview?.kind, "shell_run");
  assert.equal(body.preview?.risk?.level, "dangerous");
});

test("POST /api/permission-requests shell 项拒绝 allow_workspace", async () => {
  const created = app.permissionRequestStore.create({
    runId: "run-shell-ws",
    title: "shell grant",
    summary: "需要运行 npm test",
    requiredPermissions: [{ type: "shell", target: "npm test", reason: "验证" }],
  });
  const res = await postJson(`/api/permission-requests/${encodeURIComponent(created.id)}/respond`, {
    decision: "allow_workspace",
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /shell.*长期工作区/);
});

test("POST /api/tools/run git push 确认后仍被强制确认拒绝", async () => {
  const res = await postJson("/api/tools/run", {
    name: "shell_run",
    input: { command: "git push origin main" },
    confirm: true,
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok?: boolean; code?: string; error?: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "permission_denied");
  assert.match(body.error ?? "", /推送|确认/);
});

test("POST /api/tools/run 高风险 shell 确认后仍被策略拒绝", async () => {
  const res = await postJson("/api/tools/run", {
    name: "shell_run",
    input: { command: "rm -rf /" },
    confirm: true,
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok?: boolean; code?: string; category?: string; error?: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "permission_denied");
  assert.equal(body.category, "permission_error");
  assert.match(body.error ?? "", /高风险命令被拒绝|命令被策略拒绝|递归强制删除|必须人工确认/);
});

test("POST /api/plans/analyze 空 goal 返回 400", async () => {
  const res = await postJson("/api/plans/analyze", { goal: "" });
  assert.equal(res.status, 400);
});

test("POST /api/plans/:id/compile 缺 confirmedTodoIds 返回 400", async () => {
  const res = await postJson("/api/plans/uvp_missing/compile", { confirmedTodoIds: [] });
  assert.equal(res.status, 400);
});

test("POST /api/plans/:id/compile 不存在的 UserVisiblePlan 返回 404", async () => {
  const res = await postJson("/api/plans/uvp_missing/compile", { confirmedTodoIds: ["todo-1"] });
  assert.equal(res.status, 404);
});

async function main() {
  await startServer();
  let passed = 0;
  try {
    for (const t of tests) {
      try {
        await t.fn();
        passed++;
        console.log(`  ✓ ${t.name}`);
      } catch (error) {
        console.error(`  ✗ ${t.name}\n    ${String(error)}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await stopServer();
  }
  console.log(`\nhttp-e2e: ${passed}/${tests.length} passed`);
}

void main();
