/**
 * 多轮续写场景下的上下文信任过滤自检。
 * 运行：npm run test:context-trust-continuation
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContextManager } from "../src/context/ContextManager.js";
import { InMemoryVectorStore } from "../src/context/VectorStore.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("第二轮 restore 仍排除首轮虚假 tool 完成声明", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ctx-cont-"));
  try {
    const mgr = new ContextManager({
      dataDir: tmp,
      useLanceDb: false,
      vectorStore: new InMemoryVectorStore(),
      recentMessageCount: 20,
    });
    const session = mgr.createSession("多轮续写");
    mgr.saveUserMessage(session.id, "请安装依赖");
    mgr.saveToolMessage(
      session.id,
      "npm install 已成功完成，依赖已安装。",
      undefined,
      { outcomeClass: "observation_success", ledgerBacked: false },
    );
    mgr.saveAssistantMessage(session.id, "我先检查一下 package.json。", {
      messageKind: "final_answer",
      trusted: true,
      source: "guard",
    });

    const first = await mgr.restoreContextPackage(session.id, "请安装依赖");
    assert.equal(
      first.messages.some((m) => m.content.includes("npm install 已成功完成")),
      false,
    );

    mgr.saveUserMessage(session.id, "继续，并运行 typecheck");
    const second = await mgr.restoreContextPackage(session.id, "继续，并运行 typecheck");
    assert.equal(
      second.messages.some((m) => m.content.includes("npm install 已成功完成")),
      false,
    );
    assert.ok(second.messages.some((m) => m.role === "user" && m.content.includes("继续")));
    assert.ok(second.contextTrust);
    assert.ok(second.contextTrust!.excludedCount >= 1);
    const toolSection = second.systemSections.find((s) => s.type === "recent_tool_results");
    if (toolSection) {
      const text = toolSection.items.map((i) => i.text).join("\n");
      assert.equal(text.includes("npm install 已成功完成"), false);
    }
    mgr.close();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("buildRenderedPrompt 多轮续写不含虚假完成声明", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ctx-render-"));
  try {
    const mgr = new ContextManager({
      dataDir: tmp,
      useLanceDb: false,
      vectorStore: new InMemoryVectorStore(),
      recentMessageCount: 20,
    });
    const session = mgr.createSession("渲染续写");
    mgr.saveUserMessage(session.id, "请安装依赖");
    mgr.saveToolMessage(
      session.id,
      "npm install 已成功完成，依赖已安装。",
      undefined,
      { outcomeClass: "observation_success", ledgerBacked: false },
    );
    mgr.saveUserMessage(session.id, "继续，并运行 typecheck");
    const pkg = await mgr.restoreContextPackage(session.id, "继续，并运行 typecheck");
    const rendered = mgr.buildRenderedPrompt(pkg, "", {
      phase: "pre_call",
      currentUser: "继续，并运行 typecheck",
    });
    const joined =
      rendered.systemSectionsText + JSON.stringify(rendered.finalMessages);
    assert.equal(joined.includes("npm install 已成功完成"), false);
    assert.ok(joined.includes("继续，并运行 typecheck"));
    assert.ok(
      rendered.finalMessages.some(
        (m) => m.role === "user" && m.content.includes("继续，并运行 typecheck"),
      ),
    );
    mgr.close();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function main() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(error);
    }
  }
  console.log(`\ncontext-trust-continuation: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
