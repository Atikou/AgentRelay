import assert from "node:assert/strict";
import { applyCompanionSafety } from "../src/companion/index.js";

const result = applyCompanionSafety({
  userText: "我有点烦",
  assistantText: "请注意，本系统无法提供现实陪伴。",
});

assert.equal(result.warmEnough, true);
assert.match(result.content, /我会陪你|我在这里|听你/);
assert.doesNotMatch(result.content, /^请注意，本系统无法/);
console.log("companion-warmth-style: passed");

