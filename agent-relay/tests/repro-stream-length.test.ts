/**
 * Reproduce TypeError: Cannot read properties of undefined (reading 'length')
 * after list_files + read_file in install-deps flow.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";
import { resolveRunPolicy } from "../src/agent/RunPolicy.js";
import { ContextManager } from "../src/context/ContextManager.js";
import type { ModelResponse } from "../src/model/types.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

function scriptedChat(scripts: string[]): LoopChatFn {
  let i = 0;
  return async () => {
    const content = scripts[i] ?? '{"action":"final","answer":"脚本耗尽"}';
    i += 1;
    return {
      content,
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    } satisfies ModelResponse;
  };
}

test("install flow: list + read + shell permission pause does not throw length error", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "repro-length-"));
  const testDir = path.join(sandbox, "testTS");
  await fs.mkdir(testDir, { recursive: true });
  await fs.writeFile(
    path.join(testDir, "package.json"),
    JSON.stringify({ name: "testts", dependencies: { three: "^0.162.0" } }, null, 2),
    "utf-8",
  );

  const dataDir = path.join(sandbox, "data");
  const cm = new ContextManager({ dataDir, workspaceRoot: sandbox });
  const session = cm.createSession("repro");
  const registry = createDefaultRegistry({ dataDir });

  const chat = scriptedChat([
    '{"action":"tool","tool":"list_files","input":{"root":"testTS","recursive":false,"maxDepth":1,"limit":30},"thought":"list"}',
    '{"action":"tool","tool":"read_file","input":{"path":"testTS/package.json"},"thought":"read"}',
    '{"action":"tool","tool":"shell_run","input":{"command":"npm install","cwd":"testTS"},"thought":"install"}',
  ]);

  const policy = resolveRunPolicy({
    message: "给 testTS 安装依赖",
    permissionPolicy: "confirmBeforeRun",
  });

  const loop = new AgentLoop({
    chat,
    registry,
    workspaceRoot: sandbox,
    policy,
    contextManager: cm,
    sessionId: session.id,
    runId: "run-repro",
    pauseOnPermissionRequest: true,
  });

  const res = await loop.run("给 testTS 安装依赖");
  assert.equal(res.steps.length, 3);
  assert.equal(res.awaitingPermission, true);
  assert.equal(res.executionMeta.stopReason, "awaiting_permission");
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

test("project_scan outside workspace: tool_crash does not throw length error", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "repro-scan-crash-"));
  const dataDir = path.join(sandbox, "data");
  const registry = createDefaultRegistry({ dataDir });

  const chat = scriptedChat([
    '{"action":"tool","tool":"project_scan","input":{"root":"/testTs","maxDepth":3},"thought":"scan"}',
    '{"action":"final","answer":"无法扫描工作区外路径"}',
  ]);

  const loop = new AgentLoop({
    chat,
    registry,
    workspaceRoot: sandbox,
    runId: "run-scan-crash",
  });

  const res = await loop.run("testTs 项目");
  assert.ok(res.steps.length >= 1);
  const scan = res.steps.find((s) => s.tool === "project_scan" && !s.preflight);
  assert.ok(scan);
  assert.equal(scan!.ok, false);
  assert.equal(scan!.outcomeKind, "tool_crash");
  assert.ok(res.steps.some((s) => s.systemRecovery) || res.executionMeta.usage.recoveryTurns === 0);
  assert.equal(res.executionMeta.stopReason, "completed");
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`✓ ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${t.name}`);
    console.error(error);
  }
}
process.exit(failed > 0 ? 1 : 0);
