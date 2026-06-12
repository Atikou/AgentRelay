/**
 * 后台命令输出匹配规则。
 */
import assert from "node:assert/strict";

import {
  evaluateOutputRules,
  matchRuleOnStream,
  shouldTriggerOnMatch,
} from "../src/background/outputMatcher.js";
import type { BackgroundTaskRecord } from "../src/background/types.js";

function record(partial: Partial<BackgroundTaskRecord>): BackgroundTaskRecord {
  return {
    id: "t1",
    command: "test",
    cwd: "/tmp",
    status: "completed",
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    exitCode: 0,
    ...partial,
  };
}

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("子串匹配 stderr 错误关键字", () => {
  const results = evaluateOutputRules(
    record({ stderr: "npm ERR! code ELIFECYCLE", exitCode: 1, status: "failed" }),
    [{ name: "npm_error", pattern: "npm ERR!", stream: "stderr" }],
  );
  assert.equal(results[0]?.matched, true);
});

test("正则匹配测试通过日志", () => {
  const results = evaluateOutputRules(
    record({ stdout: "Tests: 3 passed, 0 failed" }),
    [{ name: "test_passed", pattern: "Tests?:\\s+\\d+\\s+passed", regex: true, stream: "stdout" }],
  );
  assert.equal(results[0]?.matched, true);
});

test("shouldTriggerOnMatch all 模式需全部命中", () => {
  const rules = [
    { name: "a", pattern: "ok", stream: "stdout" as const },
    { name: "b", pattern: "missing", stream: "stdout" as const },
  ];
  const results = evaluateOutputRules(record({ stdout: "ok" }), rules);
  assert.equal(
    shouldTriggerOnMatch(record({ stdout: "ok" }), rules, results, { goal: "next", mode: "all" }),
    false,
  );
  assert.equal(
    shouldTriggerOnMatch(record({ stdout: "ok ok" }), rules, [
      { name: "a", matched: true },
      { name: "b", matched: true },
    ], { goal: "next", mode: "all" }),
    true,
  );
});

test("requireSuccess 默认 true 时非零退出码不触发", () => {
  const rules = [{ name: "x", pattern: "done", stream: "stdout" as const }];
  const r = record({ stdout: "done", exitCode: 1, status: "failed" });
  const results = evaluateOutputRules(r, rules);
  assert.equal(shouldTriggerOnMatch(r, rules, results, { goal: "g" }), false);
});

test("fireOnStream 在输出追加时可命中", () => {
  const r = record({ stdout: "Server listening on port 3000\n", status: "running" });
  const hit = matchRuleOnStream(r, {
    name: "ready",
    pattern: "listening on",
    regex: true,
    ignoreCase: true,
    stream: "stdout",
    fireOnStream: true,
  });
  assert.ok(hit?.matched);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ✓ ${t.name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${t.name}\n    ${String(error)}`);
    failed += 1;
  }
}
console.log(`\noutput-matcher: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
