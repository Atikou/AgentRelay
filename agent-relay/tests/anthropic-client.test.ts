/**
 * AnthropicClient 流式解析自检。
 * 运行：npm run test:anthropic-client
 */
import assert from "node:assert/strict";

import { AnthropicClient } from "../src/model/AnthropicClient.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("AnthropicClient onToken 解析 SSE content_block_delta", async () => {
  const sse = [
    "event: message_start",
    'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":12}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","usage":{"output_tokens":2}}',
    "",
  ].join("\n");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
    }) as Response) as typeof fetch;

  try {
    const client = new AnthropicClient({
      name: "anthropic-test",
      model: "claude-test",
      apiKey: "test-key",
    });
    const tokens: string[] = [];
    const response = await client.chat({
      messages: [{ role: "user", content: "hi" }],
      onToken: (delta) => tokens.push(delta),
    });
    assert.deepEqual(tokens, ["你", "好"]);
    assert.equal(response.content, "你好");
    assert.equal(response.modelName, "claude-test");
    assert.equal(response.usage?.inputTokens, 12);
    assert.equal(response.usage?.outputTokens, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}
console.log(`anthropic-client: ${passed}/${tests.length} passed`);
