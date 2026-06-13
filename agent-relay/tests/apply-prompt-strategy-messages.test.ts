/**
 * applyPromptStrategyToMessages 自检。
 * 运行：npm run test:apply-prompt-strategy-messages
 */
import assert from "node:assert/strict";

import { applyPromptStrategyToMessages } from "../src/model-router/apply-prompt-strategy-messages.js";
import type { PromptStrategy } from "../src/model-router/prompt-strategy-builder.js";

const strategy: PromptStrategy = {
  temperature: 0.2,
  responseStyle: "concise",
  preferJsonMode: false,
  systemAddendum: "请简洁作答。",
  hints: ["style=concise"],
};

const messages = applyPromptStrategyToMessages(
  [
    { role: "system", content: "基础 system" },
    { role: "user", content: "hi" },
  ],
  strategy,
);

assert.match(messages[0]!.content, /基础 system/);
assert.match(messages[0]!.content, /请简洁作答/);
assert.equal(messages[1]!.content, "hi");
console.log("apply-prompt-strategy-messages: 1 passed");
