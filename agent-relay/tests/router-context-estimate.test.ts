/**
 * 路由上下文 token 估计自检。
 * 运行：npm run test:router-context-estimate
 */
import assert from "node:assert/strict";

import {
  estimateRouterContextTokens,
  estimateTokensFromText,
} from "../src/model-router/router-context-estimate.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("estimateTokensFromText 按字符/3 估算", () => {
  assert.equal(estimateTokensFromText("abc"), 1);
  assert.equal(estimateTokensFromText("a".repeat(300)), 100);
});

test("estimateRouterContextTokens 累加多轮消息", () => {
  const total = estimateRouterContextTokens([
    { role: "system", content: "a".repeat(90) },
    { role: "user", content: "b".repeat(90) },
  ]);
  assert.equal(total, 60);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\nrouter-context-estimate: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
