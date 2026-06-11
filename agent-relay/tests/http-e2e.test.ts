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
  app.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

test("GET /api/config 返回 capabilities", async () => {
  const res = await get("/api/config");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    profile: string;
    capabilities: { orchestrator?: boolean; runsApi?: boolean };
  };
  assert.ok(body.profile);
  assert.equal(body.capabilities.orchestrator, true);
  assert.equal(body.capabilities.runsApi, true);
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

test("GET /api/models/catalog 返回 entries 数组", async () => {
  const res = await get("/api/models/catalog");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { entries: unknown[] };
  assert.ok(Array.isArray(body.entries));
});

test("POST /api/agent/stream 空 message 返回 400 JSON", async () => {
  const res = await fetch(`${baseUrl}/api/agent/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "" }),
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
});

test("POST /api/task/dry-run 缺 plan 返回 400", async () => {
  const res = await fetch(`${baseUrl}/api/task/dry-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("计划"));
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
