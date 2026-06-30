import assert from "node:assert/strict";
import { classifyAttachmentRisk } from "../src/companion/index.js";

assert.equal(classifyAttachmentRisk("日常聊聊天"), "low");
assert.equal(classifyAttachmentRisk("我很孤独，只想和你说"), "medium");
assert.equal(classifyAttachmentRisk("我离不开你，只有你"), "high");
assert.equal(classifyAttachmentRisk("我不想活了"), "critical");
console.log("companion-attachment-risk: passed");

