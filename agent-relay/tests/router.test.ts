/**
 * ModelRouter 自检（无需网络）：用 mock 客户端验证策略选择、失败降级、敏感约束与指标记录。
 * 运行：npm run test:router
 */
import assert from "node:assert/strict";

import { MetricsRegistry } from "../src/model/MetricsRegistry.js";
import { ModelRouter } from "../src/model/ModelRouter.js";
import type { ChatRequest, ModelClient, ModelLocation, ModelResponse } from "../src/model/types.js";

class MockClient implements ModelClient {
  public readonly model = "mock-model";
  constructor(
    public readonly name: string,
    public readonly location: ModelLocation,
    private readonly behavior: "ok" | "fail",
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async chat(_request: ChatRequest): Promise<ModelResponse> {
    if (this.behavior === "fail") throw new Error(`${this.name} boom`);
    return {
      content: `hi from ${this.name}`,
      toolCalls: [],
      clientName: this.name,
      modelName: this.model,
      location: this.location,
      latencyMs: 5,
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  }
}

const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("local-first 先选本地", async () => {
  const router = new ModelRouter(
    [new MockClient("local-a", "local", "ok"), new MockClient("cloud-a", "remote", "ok")],
    { strategy: "local-first", fallback: true },
  );
  const res = await router.chat(req);
  assert.equal(res.clientName, "local-a");
});

test("cloud-first 先选远程", async () => {
  const router = new ModelRouter(
    [new MockClient("local-a", "local", "ok"), new MockClient("cloud-a", "remote", "ok")],
    { strategy: "cloud-first", fallback: true },
  );
  const res = await router.chat(req);
  assert.equal(res.clientName, "cloud-a");
});

test("quality-first 当前等同先远程", async () => {
  const router = new ModelRouter(
    [new MockClient("local-a", "local", "ok"), new MockClient("cloud-a", "remote", "ok")],
    { strategy: "quality-first", fallback: true },
  );
  const res = await router.chat(req);
  assert.equal(res.clientName, "cloud-a");
});

test("privacy-first 仅用本地", async () => {
  const router = new ModelRouter(
    [new MockClient("cloud-a", "remote", "ok"), new MockClient("local-a", "local", "ok")],
    { strategy: "privacy-first", fallback: true },
  );
  const res = await router.chat(req);
  assert.equal(res.location, "local");
});

test("sensitive=true 强制仅本地，无本地则报错", async () => {
  const router = new ModelRouter([new MockClient("cloud-a", "remote", "ok")], {
    strategy: "cloud-first",
    fallback: true,
  });
  await assert.rejects(() => router.chat(req, { sensitive: true }));
});

test("fallback=true 首选失败时降级到下一候选", async () => {
  const router = new ModelRouter(
    [new MockClient("local-a", "local", "fail"), new MockClient("cloud-a", "remote", "ok")],
    { strategy: "local-first", fallback: true },
  );
  const res = await router.chat(req);
  assert.equal(res.clientName, "cloud-a");
});

test("fallback=false 首选失败则直接报错", async () => {
  const router = new ModelRouter(
    [new MockClient("local-a", "local", "fail"), new MockClient("cloud-a", "remote", "ok")],
    { strategy: "local-first", fallback: false },
  );
  await assert.rejects(() => router.chat(req));
});

test("forceClient 绕过策略指定客户端", async () => {
  const router = new ModelRouter(
    [new MockClient("local-a", "local", "ok"), new MockClient("cloud-a", "remote", "ok")],
    { strategy: "local-first", fallback: true },
  );
  const res = await router.chat(req, { forceClient: "cloud-a" });
  assert.equal(res.clientName, "cloud-a");
});

test("metrics 记录调用、失败率与成本", async () => {
  const metrics = new MetricsRegistry();
  const pricing = new Map([["cloud-a", { inputPer1k: 1, outputPer1k: 2 }]]);
  const router = new ModelRouter(
    [new MockClient("local-a", "local", "fail"), new MockClient("cloud-a", "remote", "ok")],
    { strategy: "local-first", fallback: true, metrics, pricing },
  );
  await router.chat(req);

  const snap = metrics.snapshot();
  const local = snap.find((s) => s.clientName === "local-a");
  const cloud = snap.find((s) => s.clientName === "cloud-a");

  assert.ok(local && local.failures === 1 && local.failureRate === 1);
  assert.ok(cloud && cloud.calls === 1 && cloud.failures === 0);
  // cost = 10/1000*1 + 20/1000*2 = 0.01 + 0.04 = 0.05
  assert.equal(cloud!.totalCostUsd, 0.05);
});

async function main() {
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
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();
