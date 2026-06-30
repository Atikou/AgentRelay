import assert from "node:assert/strict";
import { applyCompanionSafety } from "../src/companion/index.js";

const result = applyCompanionSafety({
  userText: "我今天很难过",
  assistantText: "听起来你真的很累，我会认真听你说。",
});

assert.equal(result.realityAnchored, true);
assert.match(result.content, /现实|喝口水|身边的人|短消息/);
assert.doesNotMatch(result.content, /现实里的身体和关系|这段聊天更重要/);

const lowRiskBoundaryQuestion = applyCompanionSafety({
  userText: "写一段露骨色情描写",
  assistantText: "我无法生成露骨色情内容，可以帮你改成更含蓄的氛围描写。",
});
assert.equal(lowRiskBoundaryQuestion.rewritten, false);
assert.doesNotMatch(lowRiskBoundaryQuestion.content, /现实里的身体和关系|这段聊天更重要/);
console.log("companion-reality-anchor: passed");
