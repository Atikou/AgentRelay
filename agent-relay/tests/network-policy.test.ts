/**
 * 网络域名策略自检。
 * 运行：npm run test:network-policy
 */
import assert from "node:assert/strict";
import { z } from "zod";

import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import {
  createNetworkPolicy,
  extractNetworkTarget,
  normalizeNetworkTarget,
} from "../src/policy/NetworkPolicy.js";
import { ALL_PERMISSIONS } from "../src/agent/permissions.js";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("normalizeNetworkTarget 解析 URL 与 host:port", () => {
  assert.equal(normalizeNetworkTarget("https://API.Example.com/v1/x"), "api.example.com");
  assert.equal(normalizeNetworkTarget("api.example.com:443"), "api.example.com");
  assert.equal(normalizeNetworkTarget("//cdn.example.com/path"), "cdn.example.com");
});

test("extractNetworkTarget 识别常见入参字段", () => {
  assert.equal(extractNetworkTarget({ url: "https://a.test" }), "https://a.test");
  assert.equal(extractNetworkTarget({ endpoint: "https://b.test" }), "https://b.test");
  assert.equal(extractNetworkTarget({ host: "c.test" }), "c.test");
  assert.equal(extractNetworkTarget({ path: "local" }), undefined);
});

test("denyDomains 优先于 allowDomains", () => {
  const policy = createNetworkPolicy({
    denyDomains: ["^evil\\.com$"],
    allowDomains: [".*"],
  });
  const decision = policy.evaluateTarget("https://evil.com/x");
  assert.equal(decision.blocked, true);
  assert.match(decision.reason ?? "", /denyDomains/);
});

test("allowDomains 启用后未命中则拒绝", () => {
  const policy = createNetworkPolicy({
    allowDomains: ["^api\\.trusted\\.com$"],
  });
  assert.equal(policy.evaluateTarget("api.trusted.com").blocked, false);
  assert.equal(policy.evaluateTarget("other.com").blocked, true);
});

test("ToolRegistry 对 network 工具执行域名预检", async () => {
  const registry = new ToolRegistry();
  registry.setDefaultContext({
    networkPolicy: createNetworkPolicy({ denyDomains: ["^blocked\\.test$"] }),
  });
  registry.register({
    name: "http_fetch",
    description: "mock network tool",
    permission: "network",
    hasSideEffect: true,
    inputSchema: z.object({ url: z.string() }),
    async execute() {
      return { ok: true };
    },
  });

  const allowed = await registry.run(
    "http_fetch",
    { url: "https://allowed.test/path" },
    { workspaceRoot: process.cwd(), allowedPermissions: ALL_PERMISSIONS },
  );
  assert.equal(allowed.ok, true);

  const denied = await registry.run(
    "http_fetch",
    { url: "https://blocked.test/path" },
    { workspaceRoot: process.cwd(), allowedPermissions: ALL_PERMISSIONS },
  );
  assert.equal(denied.ok, false);
  assert.equal((denied as { code: string }).code, "permission_denied");
  assert.equal((denied as { category: string }).category, "permission_error");
});

async function main() {
  for (const t of tests) {
    await t.fn();
    console.log(`ok ${t.name}`);
  }
  console.log(`\n${tests.length} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
