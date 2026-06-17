/**
 * SubAgentLocalQueueGate self-check.
 */
import assert from "node:assert/strict";

import {
  SubAgentLocalQueueGate,
  initSubAgentLocalQueueGate,
  getSubAgentLocalQueueGate,
} from "../src/subagent/SubAgentLocalQueueGate.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("背压：超过 maxConcurrent 时串行化", async () => {
  const gate = new SubAgentLocalQueueGate(1);
  const release1 = await gate.acquire();
  let secondStarted = false;
  const pending = gate.acquire().then(() => {
    secondStarted = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(secondStarted, false);
  release1();
  await pending;
  assert.equal(secondStarted, true);
});

test("initSubAgentLocalQueueGate 注册单例", async () => {
  const gate = initSubAgentLocalQueueGate(2);
  assert.equal(getSubAgentLocalQueueGate(), gate);
  assert.equal(gate.stats.maxConcurrent, 2);
});

async function main() {
  for (const t of tests) {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
  }
  console.log(`\nsubagent-queue-gate: ${tests.length}/${tests.length} passed`);
}

main();
