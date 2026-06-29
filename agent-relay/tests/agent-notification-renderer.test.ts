/**
 * AgentNotificationRenderer 自检。
 * 运行：npm run test:agent-notification-renderer
 */
import assert from "node:assert/strict";

import { renderNotifications } from "../src/agent/AgentNotificationRenderer.js";
import type { AgentNotification } from "../src/background/types.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function notification(overrides: Partial<AgentNotification>): AgentNotification {
  return {
    id: "n1",
    source: "background_task",
    level: "info",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: "任务完成",
    consumed: false,
    ...overrides,
  };
}

test("renderNotifications 生成系统通知上下文", () => {
  const text = renderNotifications([notification({})]);
  assert.match(text, /系统通知/);
  assert.match(text, /\[background_task\/info\]/);
  assert.match(text, /任务完成/);
  assert.match(text, /可忽略/);
});

test("renderNotifications 展示合并通知次数", () => {
  const text = renderNotifications([
    notification({
      payload: { mergeCount: 2 },
      message: "重复完成",
    }),
  ]);
  assert.match(text, /合并×2/);
  assert.match(text, /重复完成/);
});

test("renderNotifications 空列表仍返回边界说明", () => {
  const text = renderNotifications([]);
  assert.match(text, /系统通知/);
  assert.match(text, /请酌情纳入下一步推理/);
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
  console.log(`\nagent-notification-renderer: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
