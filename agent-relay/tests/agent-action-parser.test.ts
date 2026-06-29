/**
 * AgentActionParser 自检。
 * 运行：npm run test:agent-action-parser
 */
import assert from "node:assert/strict";

import { parseAction, stripModelNoise } from "../src/agent/AgentActionParser.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("stripModelNoise 移除 think 与 redacted_reasoning 块", () => {
  assert.equal(
    stripModelNoise("<think>secret</think>\n{\"action\":\"final\",\"answer\":\"ok\"}"),
    "{\"action\":\"final\",\"answer\":\"ok\"}",
  );
  assert.equal(
    stripModelNoise("<redacted_reasoning>hidden</redacted_reasoning>\n{\"action\":\"final\",\"answer\":\"ok\"}"),
    "{\"action\":\"final\",\"answer\":\"ok\"}",
  );
});

test("parseAction 解析直接 final JSON", () => {
  assert.deepEqual(parseAction("{\"action\":\"final\",\"answer\":\"hi\"}"), {
    action: "final",
    answer: "hi",
  });
});

test("parseAction 解析夹杂文本中的 tool JSON 且忽略字符串内花括号", () => {
  assert.deepEqual(
    parseAction('说明 {"action":"tool","tool":"read_file","input":{"path":"a{b}.ts"},"thought":"read"} trailing'),
    {
      action: "tool",
      tool: "read_file",
      input: { path: "a{b}.ts" },
      thought: "read",
    },
  );
});

test("parseAction 恢复字符串化 JSON", () => {
  assert.deepEqual(parseAction(JSON.stringify("{\"action\":\"final\",\"answer\":\"nested\"}")), {
    action: "final",
    answer: "nested",
  });
});

test("parseAction 保留 final.answer 内部 Markdown 代码块", () => {
  const text = "{\"action\":\"final\",\"answer\":\"```json\\n{\\\"note\\\":true}\\n```\"}";
  assert.deepEqual(parseAction(text), {
    action: "final",
    answer: "```json\n{\"note\":true}\n```",
  });
});

test("parseAction 无动作时返回 null", () => {
  assert.equal(parseAction("没有 JSON"), null);
});

function main() {
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
  console.log(`\nagent-action-parser: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
