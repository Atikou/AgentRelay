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

import {

  SubAgentCoordinator,

  SubAgentRunner,

  aggregateSubAgentResultsStructured,

  normalizeDelegatedTask,

} from "../src/subagent/index.js";

import { SubAgentRunRegistry } from "../src/subagent/SubAgentRunRegistry.js";

import {

  applySearchReplaceInMemory,

  attemptAutoMergeWriteConflict,

} from "../src/subagent/writeConflictAutoMerge.js";

import { parseWriteFilePickHints } from "../src/subagent/writeFileVersionPick.js";

import { NotificationQueue } from "../src/background/NotificationQueue.js";

import { extractFilePaths } from "../src/subagent/taskContext.js";

import type { SubAgentRunResult } from "../src/subagent/types.js";



const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>) {

  tests.push({ name, fn });

}



let sandbox = "";



function task(goal: string, instructions?: string) {

  return normalizeDelegatedTask({ goal, instructions: instructions ?? goal });

}



function mockWriteResult(

  partial: Pick<SubAgentRunResult, "id" | "taskId" | "goal" | "steps"> & Partial<SubAgentRunResult>,

): SubAgentRunResult {

  return {

    status: "completed",

    answer: "ok",

    iterations: 1,

    durationMs: 10,

    grantedPermissions: ["read", "write"],

    ...partial,

  };

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

  await runner.runDelegated({

    task: task("分析 npm test 失败 stderr 日志"),

    parentTaskId: "parent-notify",

  });

  const pending = queue.listPending();

  assert.equal(pending.length, 1);

  assert.equal(pending[0]!.source, "subagent");

  assert.equal(pending[0]!.taskId, "parent-notify");

  assert.match(pending[0]!.message, /npm test|分析/);

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

  const result = await runner.runDelegated({

    task: task("审查 src/agent/AgentLoop.ts 的错误处理"),

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

  const result = await runner.runDelegated({

    task: task("审查 review-me.txt"),

    parentTaskId: "parent-1",

  });

  assert.equal(result.status, "completed");

  assert.equal(result.parentTaskId, "parent-1");

  assert.match(result.answer, /TODO/);

  assert.equal(result.grantedPermissions.join(), "read");

  assert.equal(result.iterations, 1);

});



test("SubAgentRunner 轻量只读子任务单次完成", async () => {
  const runner = new SubAgentRunner({
    chat: async () => ({
      content: "每天阅读 30 分钟并做笔记",
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    }),
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
  });

  const result = await runner.runDelegated({
    task: {
      goal: "写一条关于学习与知识的每日自我提升建议",
      instructions: "简短可执行",
      input: "",
      toolPolicy: {
        allowedTools: [],
        writeAllowed: false,
        shellAllowed: false,
        requireApproval: false,
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 1);
  assert.match(result.answer, /阅读|30/);
});

test("resolveSubagentTimeoutMs 不低于 120 秒下限", async () => {
  const { resolveSubagentTimeoutMs, MIN_SUBAGENT_TIMEOUT_MS, DEFAULT_SUBAGENT_TIMEOUT_CONFIG_MS } =
    await import("../src/subagent/dispatchInputNormalize.js");
  // 低于下限的请求被抬到 MIN；未指定时回落到（不低于下限的）配置默认值。
  assert.equal(resolveSubagentTimeoutMs(30_000), MIN_SUBAGENT_TIMEOUT_MS);
  assert.equal(resolveSubagentTimeoutMs(undefined), DEFAULT_SUBAGENT_TIMEOUT_CONFIG_MS);
  assert.ok(resolveSubagentTimeoutMs(undefined) >= MIN_SUBAGENT_TIMEOUT_MS);
});

test("SubAgentCoordinator 并行汇总多个任务", async () => {

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

    tasks: [

      task("审查 src/README.md 最近代码改动"),

      task("分析 src/README.md 相关测试输出"),

    ],

    parentTaskId: "batch-parent",

  });

  assert.equal(batch.results.length, 2);

  assert.equal(batch.parentTaskId, "batch-parent");

  assert.ok(batch.results.every((r) => r.status === "completed"));

  assert.match(batch.summary, /README/);

  assert.equal(batch.aggregate.status, "completed");

  assert.equal(batch.aggregate.completed, 2);

  assert.equal(batch.aggregate.conflicts.length, 0);

});



test("detectWriteConflicts 检测多任务写入同一文件", async () => {

  const results = [

    mockWriteResult({

      id: "a",

      taskId: "task-a",

      goal: "补丁任务 A",

      steps: [

        {

          iteration: 1,

          tool: "write_file",

          input: { path: "src/foo.ts" },

          output: { path: "src/foo.ts", changeId: "c1" },

          ok: true,

        },

      ],

    }),

    mockWriteResult({

      id: "b",

      taskId: "task-b",

      goal: "补丁任务 B",

      steps: [

        {

          iteration: 1,

          tool: "apply_patch",

          input: { path: "src/foo.ts" },

          output: { path: "src/foo.ts", changeId: "c2" },

          ok: true,

        },

      ],

    }),

  ];

  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");

  const conflicts = detectWriteConflicts(results);

  assert.equal(conflicts.length, 1);

  assert.equal(conflicts[0]!.path, "src/foo.ts");

  assert.deepEqual(conflicts[0]!.taskIds, ["task-a", "task-b"]);

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

    mockWriteResult({

      id: "a",

      taskId: "task-a",

      goal: "补丁 A",

      steps: [

        {

          iteration: 1,

          tool: "apply_patch",

          input: { path: fileRel, search: "const a = 1", replace: "const a = 10" },

          output: { path: fileRel, changeId: changeId1 },

          ok: true,

        },

      ],

    }),

    mockWriteResult({

      id: "b",

      taskId: "task-b",

      goal: "补丁 B",

      steps: [

        {

          iteration: 1,

          tool: "apply_patch",

          input: { path: fileRel, search: "const b = 2", replace: "const b = 20" },

          output: { path: fileRel, changeId: changeId2 },

          ok: true,

        },

      ],

    }),

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

    mockWriteResult({

      id: "a",

      taskId: "task-a",

      goal: "补丁 A",

      steps: [

        {

          iteration: 1,

          tool: "apply_patch",

          input: { path: fileRel, search: marker, replace: "BETA" },

          output: { path: fileRel, changeId: changeId1 },

          ok: true,

        },

      ],

    }),

    mockWriteResult({

      id: "b",

      taskId: "task-b",

      goal: "补丁 B",

      steps: [

        {

          iteration: 1,

          tool: "apply_patch",

          input: { path: fileRel, search: marker, replace: "GAMMA" },

          output: { path: fileRel, changeId: changeId2 },

          ok: true,

        },

      ],

    }),

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

    "建议保留 A。\nWRITE_PICK: path=src/a.ts changeId=c1 taskId=task-a\nWRITE_PICK: path=src/b.ts manual=true",

  );

  assert.equal(hints.length, 2);

  assert.equal(hints[0]!.path, "src/a.ts");

  assert.equal(hints[0]!.changeId, "c1");

  assert.equal(hints[0]!.taskId, "task-a");

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

    mockWriteResult({

      id: "a",

      taskId: "task-a",

      goal: "写 v1",

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

    }),

    mockWriteResult({

      id: "b",

      taskId: "task-b",

      goal: "写 v2",

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

    }),

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

    mockWriteResult({

      id: "a",

      taskId: "task-a",

      goal: "写 first",

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

    }),

    mockWriteResult({

      id: "b",

      taskId: "task-b",

      goal: "写 second",

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

    }),

  ];

  const { detectWriteConflicts } = await import("../src/subagent/writeConflictMerge.js");

  const conflict = detectWriteConflicts(results)[0]!;

  const attempt = await attemptAutoMergeWriteConflict(storage, sandbox, conflict, results, {

    writeFilePickStrategy: "arbitration",

    arbitrationSummary: `保留较早版本。\nWRITE_PICK: path=${fileRel} changeId=${changeId2} taskId=task-b`,

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

  const runPromise = runner.runDelegated({

    task: task("审查 src/slow.ts"),

    timeoutMs: 60_000,

  });

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

  const runPromise = coord.runDelegated(task("分析 tests/slow.test.ts 日志"), { timeoutMs: 60_000 });

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

      "建议以测试分析任务的失败结论为准，并人工复核 login 模块。",

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

    tasks: [

      task("审查 src/login 模块代码"),

      task("分析 src/login 模块测试失败日志"),

    ],

    arbitrateConflicts: true,

  });

  assert.equal(batch.aggregate.status, "conflict");

  assert.ok(batch.aggregate.arbitration?.applied);

  assert.match(batch.summary, /模型仲裁/);

  assert.match(batch.aggregate.arbitration!.summary, /login|测试/);

});



test("aggregateSubAgentResultsStructured 检测任务冲突并合并摘要", async () => {

  const aggregate = aggregateSubAgentResultsStructured([

    {

      id: "a",

      taskId: "review-task",

      goal: "检查 login 模块代码",

      status: "completed",

      answer: "login 模块通过 ok。",

      steps: [],

      iterations: 1,

      durationMs: 10,

      grantedPermissions: ["read"],

    },

    {

      id: "b",

      taskId: "test-task",

      goal: "分析 login 模块测试",

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

  assert.deepEqual(aggregate.conflicts[0]!.taskIds, ["review-task", "test-task"]);

  assert.match(aggregate.mergedAnswer, /冲突/);

  assert.match(aggregate.mergedAnswer, /检查 login|分析 login/);

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


