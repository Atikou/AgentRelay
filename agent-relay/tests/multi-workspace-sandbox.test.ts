/**
 * 多工作区授权沙箱自检。
 * 运行：npm run test:multi-workspace-sandbox
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";
import { buildToolLedger } from "../src/agent/completion/ToolLedger.js";
import { ToolExecutionGateway } from "../src/agent/ToolExecutionGateway.js";
import { PermissionRequestStore } from "../src/policy/PermissionRequestStore.js";
import { PathPolicy } from "../src/policy/PathPolicy.js";
import { WorkspaceGrantStore } from "../src/policy/WorkspaceScopeManager.js";
import { applySqliteMigrations } from "../src/storage/sqliteMigration.js";
import { MEMORY_DB_MIGRATIONS } from "../src/context/memoryDbMigrations.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import type { ModelResponse } from "../src/model/types.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

async function makeSandboxes(): Promise<{ primary: string; external: string; externalFile: string }> {
  const tmpRoot = path.join(process.cwd(), ".tmp-tests");
  await fs.mkdir(tmpRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tmpRoot, "ar-mw-"));
  const primary = path.join(root, "primary");
  const external = path.join(root, "external");
  await fs.mkdir(primary, { recursive: true });
  await fs.mkdir(external, { recursive: true });
  const externalFile = path.join(external, "shared.txt");
  await fs.writeFile(externalFile, "shared-lib", "utf-8");
  return { primary, external, externalFile };
}

function scriptedChat(scripts: string[]): LoopChatFn {
  let i = 0;
  return async () => {
    const content = scripts[i] ?? '{"action":"final","answer":"done"}';
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

test("PathPolicy：主工作区读取放行，外部读取需要确认", async () => {
  const { primary, externalFile } = await makeSandboxes();
  const policy = new PathPolicy(primary);

  const inside = policy.prepareTool("read_file", { path: "a.txt" });
  assert.equal(inside?.decision.allowed, true);
  assert.equal(inside?.decision.reason, "inside_primary_workspace");

  const outside = policy.prepareTool("read_file", { path: externalFile });
  assert.equal(outside?.decision.allowed, false);
  assert.equal(outside?.decision.needsConfirmation, true);
  assert.equal(outside?.decision.reason, "outside_workspace");
  assert.equal(outside?.audit.crossWorkspace, true);
});

test("PathPolicy：primary root 使用真实路径规范化，避免 Windows 短路径误判跨工作区", async () => {
  const primary = await fs.mkdtemp(path.join(os.tmpdir(), "ar-primary-"));
  await fs.writeFile(path.join(primary, "inside.txt"), "ok", "utf-8");

  const policy = new PathPolicy(primary);
  const inside = policy.prepareTool("read_file", { path: "inside.txt" });

  assert.equal(inside?.decision.allowed, true);
  assert.equal(inside?.decision.reason, "inside_primary_workspace");
  assert.equal(inside?.audit.crossWorkspace, false);
});

test("WorkspaceGrantStore：project/workspace 授权可落盘、重启恢复并撤销", async () => {
  const { primary, external } = await makeSandboxes();
  const dbFile = path.join(path.dirname(primary), "memory.db");
  const db = new DatabaseSync(dbFile);
  applySqliteMigrations(db, MEMORY_DB_MIGRATIONS);
  const store = new WorkspaceGrantStore(db);
  const grant = store.add({
    rootPath: external,
    permissions: ["read", "write"],
    scope: "workspace",
    source: "user_confirmed",
  });
  db.close();

  const reopened = new DatabaseSync(dbFile);
  applySqliteMigrations(reopened, MEMORY_DB_MIGRATIONS);
  const restored = new WorkspaceGrantStore(reopened);
  assert.equal(restored.list().some((g) => g.id === grant.id && g.permissions.includes("write")), true);
  assert.equal(restored.revoke(grant.id, "test"), true);
  assert.equal(restored.list().some((g) => g.id === grant.id), false);
  reopened.close();
});

test("PathPolicy：配置型 workspace 只读放行，外部写入需 write 授权", async () => {
  const { primary, external, externalFile } = await makeSandboxes();
  const readPolicy = new PathPolicy({
    primaryRoot: primary,
    configScopes: [{ id: "config:external", rootPath: external, permissions: ["read"] }],
  });
  const configRead = readPolicy.prepareTool("read_file", { path: externalFile });
  assert.equal(configRead?.decision.allowed, true);
  assert.equal(configRead?.decision.permissionSource, "config");

  const writeBlocked = readPolicy.prepareTool("write_file", { path: externalFile, content: "x" });
  assert.equal(writeBlocked?.decision.allowed, false);
  assert.equal(writeBlocked?.decision.needsConfirmation, true);

  const writeAllowed = readPolicy.prepareTool("write_file", { path: externalFile, content: "x" }, {
    scopedGrants: { write_file: [`${external}/**`] },
  });
  assert.equal(writeAllowed?.decision.allowed, true);
  assert.equal(writeAllowed?.input.path, "shared.txt");
});

test("ToolExecutionGateway：未授权外部读被阻断，授权 scope 后可执行", async () => {
  const { primary, external, externalFile } = await makeSandboxes();
  const registry = createDefaultRegistry();
  const gateway = new ToolExecutionGateway(registry);

  const blocked = await gateway.run({
    toolName: "read_file",
    input: { path: externalFile },
    source: "manual",
    budgetBucket: "manual",
    workspaceRoot: primary,
    allowedPermissions: ["read"],
    intent: "answer",
    permissionPolicy: "readOnly",
    skipBudgetCheck: true,
  });
  assert.equal(blocked.executed, false);
  assert.equal(blocked.outcomeKind, "permission_denied");
  assert.equal(blocked.requiresUserAction, true);

  const allowed = await gateway.run({
    toolName: "read_file",
    input: { path: externalFile },
    source: "manual",
    budgetBucket: "manual",
    workspaceRoot: primary,
    allowedPermissions: ["read"],
    intent: "answer",
    permissionPolicy: "readOnly",
    scopedGrants: { read_file: [`${external}/**`] },
    skipBudgetCheck: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal((allowed.output as { content?: string }).content, "shared-lib");
});

test("context_pack：敏感文件只记录 redactedFiles，不把内容放入上下文包", async () => {
  const { primary } = await makeSandboxes();
  await fs.writeFile(path.join(primary, ".env"), "SECRET_TOKEN=abc", "utf-8");
  await fs.writeFile(path.join(primary, "safe.ts"), "export const ok = true;", "utf-8");
  const registry = createDefaultRegistry();
  const result = await registry.run(
    "context_pack",
    { files: [".env", "safe.ts"], maxFiles: 2 },
    { workspaceRoot: primary, allowedPermissions: ["read"] },
  );
  assert.equal(result.ok, true);
  const output = result.output as {
    files?: Array<{ path: string; content?: string }>;
    redactedFiles?: Array<{ path: string }>;
    skippedSensitiveFiles?: string[];
  };
  assert.equal(output.files?.some((f) => f.path === ".env" || f.content?.includes("SECRET_TOKEN")), false);
  assert.equal(output.redactedFiles?.some((f) => f.path === ".env"), true);
  assert.deepEqual(output.skippedSensitiveFiles, [".env"]);
});

test("AgentLoop：外部 read_file 首次触发 permissionRequest，授权后 ledger 记录 crossWorkspace", async () => {
  const { primary, external, externalFile } = await makeSandboxes();
  const store = new PermissionRequestStore();
  const chat = scriptedChat([
    JSON.stringify({ action: "tool", tool: "read_file", input: { path: externalFile } }),
  ]);
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: primary,
    runId: "run-mw-1",
    sessionId: "session-mw-1",
    permissionRequestStore: store,
    pauseOnPermissionRequest: true,
  });

  const paused = await loop.run("读取外部共享实现");
  assert.equal(paused.awaitingPermission, true);
  assert.equal(paused.executionMeta.stopReason, "awaiting_permission");
  assert.equal(paused.permissionRequest?.requiredPermissions[0]?.type, "read_file");
  assert.match(paused.permissionRequest?.requiredPermissions[0]?.target ?? "", /\*\*$/);

  const chatAllowed = scriptedChat([
    JSON.stringify({ action: "tool", tool: "read_file", input: { path: externalFile } }),
    JSON.stringify({ action: "final", answer: "ok" }),
  ]);
  const allowedLoop = new AgentLoop({
    chat: chatAllowed,
    registry: createDefaultRegistry(),
    workspaceRoot: primary,
    scopedGrants: { read_file: [`${external}/**`] },
    runId: "run-mw-2",
    sessionId: "session-mw-1",
  });
  const done = await allowedLoop.run("读取外部共享实现");
  assert.equal(done.steps[0]?.ok, true);
  assert.equal(done.steps[0]?.workspaceAccess?.crossWorkspace, true);
  assert.equal(done.steps[0]?.workspaceAccess?.permissionSource, "user_confirmed");
  const ledger = buildToolLedger(done.steps);
  assert.equal(ledger.entries[0]?.crossWorkspace, true);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\nmulti-workspace-sandbox: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
