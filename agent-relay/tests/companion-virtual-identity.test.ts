import assert from "node:assert/strict";
import { applyCompanionSafety } from "../src/companion/index.js";

const result = applyCompanionSafety({
  userText: "你是真的人吗",
  assistantText: "我是现实中的人，也是你的恋人，我会永远陪着你。",
});

assert.equal(result.virtualIdentitySafe, true);
assert.doesNotMatch(result.content, /现实中的人|你的恋人|永远陪着你/);
assert.match(result.content, /现实|可信的人|支持/);
console.log("companion-virtual-identity: passed");

