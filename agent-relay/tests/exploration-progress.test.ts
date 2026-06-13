/**
 * ExplorationProgressTracker 自检。
 * 运行：npm run test:exploration-progress
 */
import assert from "node:assert/strict";

import { ExplorationProgressTracker } from "../src/agent/ExplorationProgressTracker.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

test("续跑已访问路径记为 duplicate 且无 newInformation", () => {
  const tracker = new ExplorationProgressTracker(["src/a.ts"]);
  const step = tracker.record({ path: "src/a.ts", contentRead: false, scoreDelta: 0.4 });
  assert.equal(step.duplicate, true);
  assert.equal(step.newInformation, false);
  assert.equal(step.informationGain, 0);
});

test("新路径内容读取产生 informationGain", () => {
  const tracker = new ExplorationProgressTracker();
  tracker.record({ path: "src/b.ts", contentRead: true, scoreDelta: 0.35 });
  const snap = tracker.snapshot();
  assert.equal(snap.newInformationCount, 1);
  assert.ok(snap.informationGain > 0);
});

test("重复探索多于新信息时标记 lowYieldLoop", () => {
  const tracker = new ExplorationProgressTracker(["a", "b", "c"]);
  tracker.record({ path: "a", contentRead: false, scoreDelta: 0.2 });
  tracker.record({ path: "b", contentRead: false, scoreDelta: 0.1 });
  tracker.record({ path: "c", contentRead: false, scoreDelta: 0.05 });
  tracker.record({ path: "src/new.ts", contentRead: true, scoreDelta: 0.05 });
  const snap = tracker.snapshot();
  assert.equal(snap.lowYieldLoop, true);
  assert.ok(snap.duplicateCount >= snap.newInformationCount);
});

test("markContributors 标记 contributesToGoal", () => {
  const tracker = new ExplorationProgressTracker();
  tracker.record({ path: "src/plan/X.ts", contentRead: true, scoreDelta: 0.5 });
  tracker.markContributors(["src/plan/X.ts"]);
  assert.equal(tracker.snapshot().contributesCount, 1);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed += 1;
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}
console.log(`\nexploration-progress: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
