/**
 * FailedActionMemory + toolOutcome 协议自检。
 * 运行：npm run test:failed-action-memory
 */
import assert from "node:assert/strict";

import { FailedActionMemory } from "../src/agent/recovery/FailedActionMemory.js";
import { applyOutcomeToStep } from "../src/agent/recovery/renderToolOutcome.js";
import { buildNotFoundOutcome } from "../src/tools/toolOutcome.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const notFoundOutcome = buildNotFoundOutcome("testTS/index.html");
const notFoundStep: AgentToolStep = applyOutcomeToStep(
  {
    iteration: 1,
    tool: "read_file",
    input: { path: "testTS/index.html", encoding: "utf8" },
    ok: false,
  },
  notFoundOutcome,
  { executed: true },
);

test("记录 observation_failure 后第二次相同 read_file 被拦截", () => {
  const memory = new FailedActionMemory();
  memory.record(notFoundStep);
  const assessment = memory.assess({
    tool: "read_file",
    input: { path: "testTS/index.html", encoding: "utf8" },
  });
  assert.ok(assessment);
  assert.equal(assessment!.circuitOpen, false);
  assert.match(assessment!.reason, /禁止重复/);
});

test("第二次拦截后再请求触发熔断", () => {
  const memory = new FailedActionMemory();
  memory.record(notFoundStep);
  memory.record({
    iteration: 2,
    tool: "read_file",
    input: { path: "testTS/index.html", encoding: "utf8" },
    blocked: true,
    executed: false,
    ok: false,
    error: "blocked once",
  });
  const assessment = memory.assess({
    tool: "read_file",
    input: { path: "testTS/index.html", encoding: "utf8" },
  });
  assert.ok(assessment);
  assert.equal(assessment!.circuitOpen, true);
  assert.match(assessment!.reason, /熔断/);
});

test("write_file 后清除 not_found 记忆，允许再次 read_file", () => {
  const memory = new FailedActionMemory();
  memory.record(notFoundStep);
  const writeStep = applyOutcomeToStep(
    { iteration: 2, tool: "write_file", input: { path: "testTS/index.html", content: "<html></html>" }, ok: true },
    { class: "observation_success", kind: "ok", message: "ok", recoverable: false, path: "testTS/index.html" },
    { executed: true },
  );
  memory.record(writeStep);
  const assessment = memory.assess({
    tool: "read_file",
    input: { path: "testTS/index.html", encoding: "utf8" },
  });
  assert.equal(assessment, undefined);
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
console.log(`\nfailed-action-memory: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
