/**
 * M5 子 Agent 自检（无需网络）。
 * 运行：npm run test:subagent
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LoopChatFn } from "../src/agent/AgentLoop.js";
import type { ModelResponse } from "../src/model/types.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { buildUnifiedDiff } from "../src/tools/file/diff.js";
import { hashContent } from "../src/tools/file/hash.js";
import { ToolStorage } from "../src/tools/storage/ToolStorage.js";
import { SubAgentCoordinator, SubAgentRunner, aggregateSubAgentResultsStructured, listSubAgentRoles, resolveGrantedPermissions } from "../src/subagent/index.js";
import { SubAgentRunRegistry } from "../src/subagent/SubAgentRunRegistry.js";
import {
  applySearchReplaceInMemory,
  attemptAutoMergeWriteConflict,
} from "../src/subagent/writeConflictAutoMerge.js";
import {
  parseWriteFilePickHints,
} from "../src/subagent/writeFileVersionPick.js";
import { NotificationQueue } from "../src/background/NotificationQueue.js";
import { SUB_AGENT_ROLES } from "../src/subagent/roles.js";
import { extractFilePaths } from "../src/subagent/taskContext.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";

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

function slowChat(delayMs: number): LoopChatFn {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return {
      content: '{"action":"final","answer":"慢"}',
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: delayMs,
    };
  };
}

test("listSubAgentRoles 包含三个角色且 patch_worker 可写", async () => {
  const roles = listSubAgentRoles();
  assert.equal(roles.length, 3);
  const readOnly = roles.filter((r) => r.id !== "patch_worker");
  assert.ok(readOnly.every((r) => r.allowedPermissions.join() === "read"));
  assert.deepEqual(SUB_AGENT_ROLES.patch_worker.allowedPermissions, ["read", "write"]);
  assert.ok(SUB_AGENT_ROLES.code_review.defaultBudget.maxModelTurns >= 10);
  assert.equal(SUB_AGENT_ROLES.code_review.defaultBudget.maxWriteCalls, 0);
});

test("extractFilePaths 从任务描述提取路径", async () => {
  const paths = extractFilePaths("审查 src/agent/AgentLoop.ts 的错误处理");
  assert.deepEqual(paths, ["src/agent/AgentLoop.ts"]);
});

test("SubAgentRunner 完成后写入通知队列", async () => {
  const journal = path.join(sandbox, "notifications.jsonl");
  const queue = new NotificationQueue(journal);
  const chat: LoopChatFn = async () => ({
    content: '{"action":"final","answer":"完成"}',
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const runner = new SubAgentRunner({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    notificationQueue: queue,
  });
  await runner.run({
    role: "test_analyze",
    task: "分析日志",
    parentTaskId: "parent-notify",
  });
  const pending = queue.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.source, "subagent");
  assert.equal(pending[0]!.taskId, "parent-notify");
  assert.match(pending[0]!.message, /test_analyze/);
});

test("resolveGrantedPermissions 只读角色拒绝 write", async () => {
  const role = SUB_AGENT_ROLES.code_review;
  assert.throws(() => resolveGrantedPermissions(role, ["write"]), /超出允许范围/);
});

test("resolveGrantedPermissions patch_worker 须显式授予", async () => {
  const role = SUB_AGENT_ROLES.patch_worker;
  assert.throws(() => resolveGrantedPermissions(role), /显式授予/);
  assert.throws(() => resolveGrantedPermissions(role, ["read"]), /须包含 write/);
  const granted = resolveGrantedPermissions(role, ["read", "write"]);
  assert.deepEqual(granted, ["read", "write"]);
});

test("SubAgentRunner 预读 ts 文件走单次审查（无需 JSON）", async () => {
  const agentDir = path.join(sandbox, "src", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "AgentLoop.ts"),
    "export function run() { throw new Error('x'); }",
    "utf-8",
  );
  const chat: LoopChatFn = async () => ({
    content: "发现 run() 未捕获异常，建议补充 try/catch。",
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const runner = new SubAgentRunner({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const result = await runner.run({
    role: "code_review",
    task: "审查 src/agent/AgentLoop.ts 的错误处理",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 1);
  assert.equal(result.steps.length, 0);
  assert.match(result.answer, /try\/catch|异常/);
});

test("SubAgentRunner 预读 txt 后可直接 final", async () => {
  await fs.writeFile(path.join(sandbox, "review-me.txt"), "TODO: fix bug", "utf-8");
  const chat = scriptedChat(['{"action":"final","answer":"发现 TODO 注释"}']);
  const runner = new SubAgentRunner({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const result = await runner.run({
    role: "code_review",
    task: "审查 review-me.txt",
    parentTaskId: "parent-1",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.parentTaskId, "parent-1");
  assert.match(result.answer, /TODO/);
  assert.equal(result.grantedPermissions.join(), "read");
  assert.equal(result.iterations, 1);
});

test("SubAgentRunner 超时返回 timeout", async () => {
  const runner = new SubAgentRunner({
    chat: slowChat(500),
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const result = await runner.run({
    role: "test_analyze",
    task: "分析",
    timeoutMs: 50,
  });
  assert.equal(result.status, "timeout");
});

test("SubAgentCoordinator 并行汇总多个角色", async () => {
  const chat: LoopChatFn = async () => ({
    content: '{"action":"final","answer":"子 Agent 结论"}',
    toolCalls: [],
    clientName: "fake",
    modelName: "fake",
    location: "local",
    latencyMs: 1,
  });
  const coord = new SubAgentCoordinator({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const batch = await coord.runBatch({
    roles: ["code_review", "test_analyze"],
    task: "检查最近改动",
    parentTaskId: "batch-parent",
  });
  assert.equal(batch.results.length, 2);
  assert.equal(batch.parentTaskId, "batch-parent");
  assert.ok(batch.results.every((r) => r.status === "completed"));
  assert.match(batch.summary, /code_review/);
  assert.match(batch.summary, /test_analyze/);
  assert.equal(batch.aggregate.status, "completed");
  assert.equal(batch.aggregate.completed, 2);
  assert.equal(batch.aggregate.conflicts.length, 0);
});

test("detectWriteConflicts 检测多角色写入同一文件", async () => {
  const results = [
    {
      id: "a",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok",
      steps: [
        {
          iteration: 1,
          tool: "write_file",
          input: { path: "src/foo.ts" },
          output: { path: "src/foo.ts", changeId: "c1" },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read", "write"] as const,
    },
    {
      id: "b",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok2",
      steps: [
        {
          iteration: 1,
          tool: "apply_patch",
          input: { path: "src/foo.ts" },
          output: { path: "src/foo.ts", changeId: "c2" },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read", "write"] as const,
    },
  ];
  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");
  const conflicts = detectWriteConflicts(results);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.path, "src/foo.ts");
  assert.deepEqual(conflicts[0]!.roles, ["patch_worker", "patch_worker"]);
});

test("applySearchReplaceInMemory 唯一匹配与多处拒绝", async () => {
  const ok = applySearchReplaceInMemory("const a = 1;", "a = 1", "a = 10");
  assert.ok(ok.ok);
  assert.equal(ok.content, "const a = 10;");
  const bad = applySearchReplaceInMemory("aaa", "a", "b");
  assert.equal(bad.ok, false);
});

test("attemptAutoMerge 非重叠 apply_patch 顺序合并写盘", async () => {
  const dataDir = path.join(sandbox, "merge-data-ok");
  const fileRel = "src/foo.ts";
  const fileAbs = path.join(sandbox, fileRel);
  const original = "const a = 1;\nconst b = 2;\n";
  await fs.mkdir(path.dirname(fileAbs), { recursive: true });
  await fs.writeFile(fileAbs, original, "utf-8");

  const storage = new ToolStorage(dataDir);
  const batch = await storage.createBackupBatch(sandbox, [fileRel], {
    reason: "test_base",
    sha256ByPath: new Map([[fileRel, hashContent(original)]]),
  });
  const backupPath = batch.files[0]!.backupPath;
  const changeId1 = randomUUID();
  const changeId2 = randomUUID();
  const patchedA = "const a = 10;\nconst b = 2;\n";
  const patchedBoth = "const a = 10;\nconst b = 20;\n";

  storage.insertFileChange({
    id: changeId1,
    toolName: "apply_patch",
    path: fileRel,
    beforeHash: hashContent(original),
    afterHash: hashContent(patchedA),
    backupPath,
    diff: buildUnifiedDiff(original, patchedA, fileRel),
  });
  storage.insertFileChange({
    id: changeId2,
    toolName: "apply_patch",
    path: fileRel,
    beforeHash: hashContent(original),
    afterHash: hashContent(patchedBoth),
    backupPath,
    diff: buildUnifiedDiff(original, patchedBoth, fileRel),
  });

  await fs.writeFile(fileAbs, "const a = 1;\nconst b = 20;\n", "utf-8");

  const results = [
    {
      id: "a",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok",
      steps: [
        {
          iteration: 1,
          tool: "apply_patch",
          input: { path: fileRel, search: "const a = 1", replace: "const a = 10" },
          output: { path: fileRel, changeId: changeId1 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read", "write"] as const,
    },
    {
      id: "b",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok2",
      steps: [
        {
          iteration: 1,
          tool: "apply_patch",
          input: { path: fileRel, search: "const b = 2", replace: "const b = 20" },
          output: { path: fileRel, changeId: changeId2 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read", "write"] as const,
    },
  ];
  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");
  const conflict = detectWriteConflicts(results)[0]!;
  const attempt = await attemptAutoMergeWriteConflict(storage, sandbox, conflict, results);
  assert.equal(attempt.status, "merged");
  assert.equal(attempt.appliedPatches, 2);
  assert.ok(attempt.changeId);

  const merged = await fs.readFile(fileAbs, "utf-8");
  assert.equal(merged, patchedBoth);
  storage.close();
});

test("attemptAutoMerge 重叠补丁标记 manual_required", async () => {
  const dataDir = path.join(sandbox, "merge-data-overlap");
  const fileRel = "src/bar.ts";
  const fileAbs = path.join(sandbox, fileRel);
  const marker = "UNIQUE_ALPHA_MARKER";
  const original = `const x = 1; // ${marker}\n`;
  await fs.mkdir(path.dirname(fileAbs), { recursive: true });
  await fs.writeFile(fileAbs, original, "utf-8");

  const storage = new ToolStorage(dataDir);
  const batch = await storage.createBackupBatch(sandbox, [fileRel], {
    reason: "test_base",
    sha256ByPath: new Map([[fileRel, hashContent(original)]]),
  });
  const backupPath = batch.files[0]!.backupPath;
  const changeId1 = randomUUID();
  const changeId2 = randomUUID();

  storage.insertFileChange({
    id: changeId1,
    toolName: "apply_patch",
    path: fileRel,
    beforeHash: hashContent(original),
    afterHash: hashContent(`const x = 1; // BETA\n`),
    backupPath,
    diff: buildUnifiedDiff(original, `const x = 1; // BETA\n`, fileRel),
  });
  storage.insertFileChange({
    id: changeId2,
    toolName: "apply_patch",
    path: fileRel,
    beforeHash: hashContent(original),
    afterHash: hashContent(`const x = 1; // GAMMA\n`),
    backupPath,
    diff: buildUnifiedDiff(original, `const x = 1; // GAMMA\n`, fileRel),
  });

  const results = [
    {
      id: "a",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok",
      steps: [
        {
          iteration: 1,
          tool: "apply_patch",
          input: { path: fileRel, search: marker, replace: "BETA" },
          output: { path: fileRel, changeId: changeId1 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read", "write"] as const,
    },
    {
      id: "b",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "ok2",
      steps: [
        {
          iteration: 1,
          tool: "apply_patch",
          input: { path: fileRel, search: marker, replace: "GAMMA" },
          output: { path: fileRel, changeId: changeId2 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read", "write"] as const,
    },
  ];
  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");
  const conflict = detectWriteConflicts(results)[0]!;
  const attempt = await attemptAutoMergeWriteConflict(storage, sandbox, conflict, results);
  assert.equal(attempt.status, "manual_required");
  assert.equal(attempt.appliedPatches, 1);
  assert.match(attempt.reason, /未找到|重叠|上下文/);
  storage.close();
});

test("parseWriteFilePickHints 解析仲裁 WRITE_PICK 行", async () => {
  const hints = parseWriteFilePickHints(
    "建议保留 A。\nWRITE_PICK: path=src/a.ts changeId=c1 role=patch_worker\nWRITE_PICK: path=src/b.ts manual=true",
  );
  assert.equal(hints.length, 2);
  assert.equal(hints[0]!.path, "src/a.ts");
  assert.equal(hints[0]!.changeId, "c1");
  assert.equal(hints[1]!.manual, true);
});

test("write_file 冲突按 latest 选版写盘", async () => {
  const dataDir = path.join(sandbox, "write-pick-latest");
  const fileRel = "src/pick.ts";
  const fileAbs = path.join(sandbox, fileRel);
  await fs.mkdir(path.dirname(fileAbs), { recursive: true });
  await fs.writeFile(fileAbs, "old\n", "utf-8");

  const storage = new ToolStorage(dataDir);
  const changeId1 = randomUUID();
  const changeId2 = randomUUID();
  const t1 = "2026-01-01T00:00:00.000Z";
  const t2 = "2026-01-02T00:00:00.000Z";
  storage.insertFileChange({
    id: changeId1,
    toolName: "write_file",
    path: fileRel,
    afterHash: hashContent("version1\n"),
    createdAt: t1,
    diff: "",
  });
  storage.insertFileChange({
    id: changeId2,
    toolName: "write_file",
    path: fileRel,
    afterHash: hashContent("version2\n"),
    createdAt: t2,
    diff: "",
  });

  const results = [
    {
      id: "a",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "v1",
      steps: [
        {
          iteration: 1,
          tool: "write_file",
          input: { path: fileRel, content: "version1\n" },
          output: { path: fileRel, changeId: changeId1 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read", "write"] as const,
    },
    {
      id: "b",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "v2",
      steps: [
        {
          iteration: 1,
          tool: "write_file",
          input: { path: fileRel, content: "version2\n" },
          output: { path: fileRel, changeId: changeId2 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read", "write"] as const,
    },
  ];
  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");
  const conflict = detectWriteConflicts(results)[0]!;
  const attempt = await attemptAutoMergeWriteConflict(storage, sandbox, conflict, results, {
    writeFilePickStrategy: "latest",
  });
  assert.equal(attempt.status, "merged");
  assert.equal(attempt.pickedChangeId, changeId2);
  assert.equal(await fs.readFile(fileAbs, "utf-8"), "version2\n");
  storage.close();
});

test("write_file 冲突按仲裁 WRITE_PICK 选版", async () => {
  const dataDir = path.join(sandbox, "write-pick-arb");
  const fileRel = "src/arb.ts";
  const fileAbs = path.join(sandbox, fileRel);
  await fs.mkdir(path.dirname(fileAbs), { recursive: true });
  await fs.writeFile(fileAbs, "old\n", "utf-8");

  const storage = new ToolStorage(dataDir);
  const changeId1 = randomUUID();
  const changeId2 = randomUUID();
  storage.insertFileChange({
    id: changeId1,
    toolName: "write_file",
    path: fileRel,
    createdAt: "2026-01-02T00:00:00.000Z",
    afterHash: hashContent("first\n"),
    diff: "",
  });
  storage.insertFileChange({
    id: changeId2,
    toolName: "write_file",
    path: fileRel,
    createdAt: "2026-01-01T00:00:00.000Z",
    afterHash: hashContent("second\n"),
    diff: "",
  });

  const results = [
    {
      id: "a",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "1",
      steps: [
        {
          iteration: 1,
          tool: "write_file",
          input: { path: fileRel, content: "first\n" },
          output: { path: fileRel, changeId: changeId1 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read", "write"] as const,
    },
    {
      id: "b",
      role: "patch_worker" as const,
      status: "completed" as const,
      answer: "2",
      steps: [
        {
          iteration: 1,
          tool: "write_file",
          input: { path: fileRel, content: "second\n" },
          output: { path: fileRel, changeId: changeId2 },
          ok: true,
        },
      ],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read", "write"] as const,
    },
  ];
  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");
  const conflict = detectWriteConflicts(results)[0]!;
  const attempt = await attemptAutoMergeWriteConflict(storage, sandbox, conflict, results, {
    writeFilePickStrategy: "arbitration",
    arbitrationSummary: `保留较早版本。\nWRITE_PICK: path=${fileRel} changeId=${changeId2} role=patch_worker`,
  });
  assert.equal(attempt.status, "merged");
  assert.equal(attempt.pickedChangeId, changeId2);
  assert.equal(await fs.readFile(fileAbs, "utf-8"), "second\n");
  storage.close();
});

test("SubAgentRunner 显式 cancel 返回 cancelled", async () => {
  const runRegistry = new SubAgentRunRegistry();
  const runner = new SubAgentRunner({
    chat: slowChat(4_000),
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    runRegistry,
  });
  const runPromise = runner.run({ role: "code_review", task: "慢任务", timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 80));
  const running = runRegistry.listRunning();
  assert.equal(running.length, 1);
  const cancelled = runRegistry.cancel(running[0]!.subAgentId);
  assert.equal(cancelled?.status, "cancelling");
  const result = await runPromise;
  assert.equal(result.status, "cancelled");
  assert.match(result.answer, /已取消/);
  assert.equal(runRegistry.listRunning().length, 0);
});

test("SubAgentCoordinator.cancel 委托注册表", async () => {
  const runRegistry = new SubAgentRunRegistry();
  const coord = new SubAgentCoordinator({
    chat: slowChat(4_000),
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    runRegistry,
  });
  const runPromise = coord.run({ role: "test_analyze", task: "慢", timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 80));
  const id = coord.listRunning()[0]!.subAgentId;
  const cancel = coord.cancel(id);
  assert.equal(cancel?.status, "cancelling");
  const result = await runPromise;
  assert.equal(result.status, "cancelled");
});

test("runBatch arbitrateConflicts 在文本冲突时附加仲裁摘要", async () => {
  let chatCalls = 0;
  const chat: LoopChatFn = async () => {
    const scripts = [
      '{"action":"final","answer":"login 模块通过 ok。"}',
      '{"action":"final","answer":"login 模块失败 error。"}',
      "建议以 test_analyze 的失败结论为准，并人工复核 login 模块。",
    ];
    const content = scripts[chatCalls] ?? scripts[scripts.length - 1]!;
    chatCalls += 1;
    return {
      content,
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    };
  };
  const coord = new SubAgentCoordinator({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });
  const batch = await coord.runBatch({
    roles: ["code_review", "test_analyze"],
    task: "检查 login 模块",
    arbitrateConflicts: true,
  });
  assert.equal(batch.aggregate.status, "conflict");
  assert.ok(batch.aggregate.arbitration?.applied);
  assert.match(batch.summary, /模型仲裁/);
  assert.match(batch.aggregate.arbitration!.summary, /test_analyze|login/);
});

test("aggregateSubAgentResultsStructured 检测角色冲突并合并摘要", async () => {
  const aggregate = aggregateSubAgentResultsStructured([
    {
      id: "a",
      role: "code_review",
      status: "completed",
      answer: "login 模块通过 ok。",
      steps: [],
      iterations: 1,
      durationMs: 10,
      grantedPermissions: ["read"],
    },
    {
      id: "b",
      role: "test_analyze",
      status: "completed",
      answer: "login 模块失败 error。",
      steps: [],
      iterations: 1,
      durationMs: 12,
      grantedPermissions: ["read"],
    },
  ]);
  assert.equal(aggregate.status, "conflict");
  assert.equal(aggregate.conflicts.length, 1);
  assert.equal(aggregate.conflicts[0]!.topic, "login");
  assert.match(aggregate.mergedAnswer, /冲突/);
  assert.match(aggregate.mergedAnswer, /code_review/);
  assert.match(aggregate.mergedAnswer, /test_analyze/);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-sub-"));
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  ✗ ${t.name}`);
      console.error(err);
      failed += 1;
    }
  }
  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(`\nsubagent: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
