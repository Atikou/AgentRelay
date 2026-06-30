import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompanionStorage, CompanionStorageManager } from "../src/companion/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("默认 storageRoot 位于项目目录 .agentrelay/companion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-project-"));
  try {
    const manager = new CompanionStorageManager(root);
    const storage = manager.get();
    assert.equal(storage.storageRoot, path.join(root, ".agentrelay", "companion"));
    assert.equal(storage.schemaVersion, 1);
    assert.ok(existsSync(path.join(storage.storageRoot, "companion.db")));
    manager.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("自定义相对 storageRoot 解析到项目目录下", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-project-"));
  try {
    const manager = new CompanionStorageManager(root);
    const storage = manager.get("data/companion-custom");
    assert.equal(storage.storageRoot, path.join(root, "data", "companion-custom"));
    manager.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("逐条落盘并可重启恢复", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-store-"));
  try {
    let storage = new CompanionStorage(root);
    const session = storage.createSession({ title: "恢复测试" });
    storage.createMessage({ sessionId: session.id, role: "user", content: "你好" });
    storage.createMessage({ sessionId: session.id, role: "assistant", content: "我在这里听你说。" });
    storage.close();

    storage = new CompanionStorage(root);
    const restored = storage.getSession(session.id);
    assert.equal(restored?.title, "恢复测试");
    const messages = storage.listMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.content, "你好");
    storage.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("中断 draft 保留 interrupted 状态", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "companion-store-"));
  try {
    const storage = new CompanionStorage(root);
    const session = storage.createSession();
    const draft = storage.createMessage({
      sessionId: session.id,
      role: "assistant",
      content: "半句",
      status: "streaming",
    });
    const updated = storage.updateMessage(draft.id, { status: "interrupted", content: "半句" });
    assert.equal(updated?.status, "interrupted");
    assert.equal(storage.listMessages(session.id)[0]?.content, "半句");
    storage.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
console.log(`companion-storage: ${passed}/${tests.length} passed`);

