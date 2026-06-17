/**
 * planDagBuilder self-check.
 */
import assert from "node:assert/strict";

import { buildTodoDependsOn, groupStepsIntoDagWaves } from "../src/plan/planDagBuilder.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const todos = [
  { id: "a", priority: "P0" as const },
  { id: "b", priority: "P0" as const },
  { id: "c", priority: "P1" as const },
];

test("同优先级 P0 并行无互相依赖", () => {
  assert.deepEqual(buildTodoDependsOn(todos, todos[0]!), []);
  assert.deepEqual(buildTodoDependsOn(todos, todos[1]!), []);
});

test("P1 依赖全部 P0", () => {
  assert.deepEqual(buildTodoDependsOn(todos, todos[2]!), ["a", "b"]);
});

test("groupStepsIntoDagWaves 分出两波", () => {
  const waves = groupStepsIntoDagWaves([
    { id: "a", dependsOn: [] },
    { id: "b", dependsOn: [] },
    { id: "c", dependsOn: ["a", "b"] },
  ]);
  assert.equal(waves.length, 2);
  assert.deepEqual(waves[0]!.map((s) => s.id).sort(), ["a", "b"]);
  assert.deepEqual(waves[1]!.map((s) => s.id), ["c"]);
});

function main() {
  for (const t of tests) {
    t.fn();
    console.log(`  ✓ ${t.name}`);
  }
  console.log(`\nplan-dag-builder: ${tests.length}/${tests.length} passed`);
}

main();
