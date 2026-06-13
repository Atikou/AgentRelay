/**
 * 工具系统自检（无需网络）：注册表、路径沙箱、文件读写/补丁/回滚、命令风险、git。
 * 运行：npm run test:tools
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry, createMockRegistry, createMockTool } from "../src/tools/index.js";
import { checkCommandRisk } from "../src/tools/risk.js";
import { resolveInsideWorkspace } from "../src/tools/pathSafe.js";
import { ALL_PERMISSIONS } from "../src/agent/permissions.js";
import { createShellPolicy } from "../src/policy/ShellPolicy.js";
import { ToolRegistry, classifyToolError } from "../src/tools/ToolRegistry.js";
import { ToolStorage } from "../src/tools/storage/ToolStorage.js";
import { z } from "zod";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";
let dataDir = "";
let registryInstance: ReturnType<typeof createDefaultRegistry> | null = null;

async function ctx() {
  return { workspaceRoot: sandbox, allowedPermissions: ALL_PERMISSIONS };
}

function reg() {
  if (!registryInstance) {
    registryInstance = createDefaultRegistry({ dataDir });
  }
  return registryInstance;
}

const EXPECTED_TOOLS = [
  "apply_patch",
  "backup_file",
  "context_pack",
  "diff_file",
  "git_diff",
  "git_status",
  "list_files",
  "locate_relevant_files",
  "project_scan",
  "read_file",
  "rollback_change",
  "search_text",
  "shell_run",
  "symbol_search",
  "write_file",
];

test("默认注册表包含内置工具与相关文件定位工具", async () => {
  const names = reg().list().map((t) => t.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
});

test("write_file → read_file 往返一致", async () => {
  const r = reg();
  const w = await r.run("write_file", { path: "sub/a.txt", content: "你好tool", backup: false }, await ctx());
  assert.equal(w.ok, true);
  const read = await r.run("read_file", { path: "sub/a.txt" }, await ctx());
  assert.equal(read.ok, true);
  assert.equal((read as { output: { content: string } }).output.content, "你好tool");
  assert.ok((read as { output: { sha256: string } }).output.sha256);
});

test("write_file 返回 changeId 与 diff", async () => {
  const r = reg();
  const w = await r.run("write_file", { path: "chg.txt", content: "v1" }, await ctx());
  assert.equal(w.ok, true);
  const out = (w as { output: { changeId: string; diff: string } }).output;
  assert.ok(out.changeId);
  assert.match(out.diff, /v1/);
});

test("list_files 返回 files 数组", async () => {
  const r = reg();
  await r.run("write_file", { path: "list/x.txt", content: "1", backup: false }, await ctx());
  const res = await r.run("list_files", { root: "list" }, await ctx());
  assert.equal(res.ok, true);
  assert.ok((res as { output: { files: Array<{ path: string }> } }).output.files.some((e) => e.path === "list/x.txt"));
});

test("search_text 命中查询", async () => {
  const r = reg();
  await r.run("write_file", { path: "src/needle.txt", content: "find HAYSTACK here", backup: false }, await ctx());
  const res = await r.run("search_text", { query: "HAYSTACK", root: "src" }, await ctx());
  assert.equal(res.ok, true);
  assert.ok((res as { output: { results: unknown[] } }).output.results.length >= 1);
});

test("project_scan 返回项目类型与重要文件", async () => {
  const r = reg();
  await r.run("write_file", { path: "package.json", content: JSON.stringify({ scripts: { test: "node test.js" }, devDependencies: { typescript: "^5.0.0" } }), backup: false }, await ctx());
  await r.run("write_file", { path: "src/agent/AgentLoop.ts", content: "export class AgentLoop {}", backup: false }, await ctx());
  const res = await r.run("project_scan", {}, await ctx());
  assert.equal(res.ok, true);
  const out = (res as { output: { projectType: string; importantFiles: string[]; sourceRoots: string[] } }).output;
  assert.equal(out.projectType, "typescript_node");
  assert.ok(out.importantFiles.includes("package.json"));
  assert.ok(out.sourceRoots.includes("src"));
});

test("locate_relevant_files 根据目标返回 primaryFiles", async () => {
  const r = reg();
  await r.run("write_file", { path: "src/plan/PlanCompiler.ts", content: "export class PlanCompiler {}\nexport function compilePlan() {}", backup: false }, await ctx());
  await r.run("write_file", { path: "src/server/unrelated.ts", content: "export const other = 1", backup: false }, await ctx());
  const res = await r.run(
    "locate_relevant_files",
    { goal: "修复 PlanCompiler compilePlan 逻辑", possibleSymbols: ["PlanCompiler", "compilePlan"] },
    await ctx(),
  );
  assert.equal(res.ok, true);
  const out = (res as { output: { primaryFiles: Array<{ path: string }>; confidence: number } }).output;
  assert.ok(out.primaryFiles.some((f) => f.path === "src/plan/PlanCompiler.ts"));
  assert.ok(out.confidence > 0);
});

test("symbol_search 无索引时从文件系统命中符号", async () => {
  const r = reg();
  await r.run(
    "write_file",
    {
      path: "src/plan/PlanCompiler.ts",
      content: "export class PlanCompiler {}\nexport function compilePlan() {}\n",
      backup: false,
    },
    await ctx(),
  );
  const res = await r.run("symbol_search", { query: "PlanCompiler" }, await ctx());
  assert.equal(res.ok, true);
  const out = (res as {
    output: {
      indexSource: string;
      symbols: Array<{ symbol: string; filePath: string }>;
    };
  }).output;
  assert.equal(out.indexSource, "filesystem");
  assert.ok(out.symbols.some((s) => s.symbol === "PlanCompiler" && s.filePath.includes("PlanCompiler.ts")));
});

test("symbol_search 优先使用 ProjectIndex", async () => {
  const { DatabaseManager } = await import("../src/context/DatabaseManager.js");
  const { ProjectIndex } = await import("../src/context/ProjectIndex.js");
  const dbm = new DatabaseManager(dataDir);
  const projectIndex = new ProjectIndex(dbm);
  const r = reg();
  r.setDefaultContext({ projectIndex });
  try {
    await r.run(
      "write_file",
      { path: "src/agent/AgentLoop.ts", content: "export class AgentLoop {}\n", backup: false },
      await ctx(),
    );
    await r.run("project_scan", { root: ".", maxDepth: 4 }, await ctx());
    const res = await r.run("symbol_search", { query: "AgentLoop", kinds: ["class"] }, await ctx());
    assert.equal(res.ok, true);
    const out = (res as {
      output: { indexSource: string; symbols: Array<{ symbol: string; kind: string }> };
    }).output;
    assert.equal(out.indexSource, "project_index");
    assert.ok(out.symbols.some((s) => s.symbol === "AgentLoop" && s.kind === "class"));
  } finally {
    dbm.close();
  }
});

test("symbol_search 缺少 query 与 symbols 时校验失败", async () => {
  const r = reg();
  const res = await r.run("symbol_search", {}, await ctx());
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "invalid_input");
});

test("locate_relevant_files 在已有 ProjectIndex 时复用索引", async () => {
  const { DatabaseManager } = await import("../src/context/DatabaseManager.js");
  const { ProjectIndex } = await import("../src/context/ProjectIndex.js");
  const dbm = new DatabaseManager(dataDir);
  const projectIndex = new ProjectIndex(dbm);
  const r = reg();
  r.setDefaultContext({ projectIndex });
  try {
    for (let i = 0; i < 10; i += 1) {
      await r.run(
        "write_file",
        { path: `src/module/file${i}.ts`, content: `export const v${i} = ${i};`, backup: false },
        await ctx(),
      );
    }
    await r.run("project_scan", { root: ".", maxDepth: 4 }, await ctx());
    const res = await r.run(
      "locate_relevant_files",
      { goal: "查看 module 目录文件", possiblePaths: ["src/module"], limit: 5 },
      await ctx(),
    );
    assert.equal(res.ok, true);
    const out = (res as { output: { indexSource: string } }).output;
    assert.equal(out.indexSource, "project_index");
  } finally {
    dbm.close();
  }
});

test("locate_relevant_files resumeContext 合并 searchPlan 并跳过已访问文件", async () => {
  const { DatabaseManager } = await import("../src/context/DatabaseManager.js");
  const { ProjectIndex } = await import("../src/context/ProjectIndex.js");
  const dbm = new DatabaseManager(dataDir);
  const projectIndex = new ProjectIndex(dbm);
  const r = reg();
  r.setDefaultContext({ projectIndex });
  try {
    await r.run(
      "write_file",
      { path: "src/plan/PlanCompiler.ts", content: "export class PlanCompiler {}\n", backup: false },
      await ctx(),
    );
    await r.run("project_scan", { root: ".", maxDepth: 4 }, await ctx());
    const first = await r.run(
      "locate_relevant_files",
      { goal: "修复 PlanCompiler", possibleSymbols: ["PlanCompiler"] },
      await ctx(),
    );
    assert.equal(first.ok, true);
    const firstOut = (first as { output: { locateStats: { visitedFiles: string[] } } }).output;
    const visited = firstOut.locateStats.visitedFiles;
    const second = await r.run(
      "locate_relevant_files",
      {
        goal: "修复 PlanCompiler",
        possibleSymbols: ["PlanCompiler"],
        resumeContext: {
          visitedFiles: visited,
          visitedDirs: ["src/plan"],
          candidateFiles: ["src/plan/PlanCompiler.ts"],
          searchPlan: {
            goal: "修复 PlanCompiler",
            keywords: ["PlanCompiler"],
            possibleSymbols: ["PlanCompiler"],
          },
        },
      },
      await ctx(),
    );
    assert.equal(second.ok, true);
    const secondOut = (second as {
      output: { locationResume?: { mergedSearchPlan: boolean }; searchPlan: { keywords: string[] } };
    }).output;
    assert.equal(secondOut.locationResume?.mergedSearchPlan, true);
    assert.ok(secondOut.searchPlan.keywords.includes("PlanCompiler"));
  } finally {
    dbm.close();
  }
});

test("context_pack 一次性打包多个相关文件", async () => {
  const r = reg();
  await r.run("write_file", { path: "src/context/A.ts", content: "export function alpha() { return 1; }", backup: false }, await ctx());
  await r.run("write_file", { path: "src/context/B.ts", content: "export function beta() { return 2; }", backup: false }, await ctx());
  const res = await r.run(
    "context_pack",
    { files: ["src/context/A.ts", "src/context/B.ts"], maxFiles: 2, maxTokens: 2000 },
    await ctx(),
  );
  assert.equal(res.ok, true);
  const out = (res as { output: { files: Array<{ path: string; summary: string }>; combinedSummary: string } }).output;
  assert.equal(out.files.length, 2);
  assert.match(out.combinedSummary, /src\/context\/A.ts/);
});

test("apply_patch 唯一匹配替换", async () => {
  const r = reg();
  await r.run("write_file", { path: "patch.txt", content: "hello world", backup: false }, await ctx());
  const res = await r.run(
    "apply_patch",
    { path: "patch.txt", search: "world", replace: "AgentRelay" },
    await ctx(),
  );
  assert.equal(res.ok, true);
  const read = await r.run("read_file", { path: "patch.txt" }, await ctx());
  assert.match((read as { output: { content: string } }).output.content, /AgentRelay/);
  assert.ok((res as { output: { changeId: string; diff: string } }).output.changeId);
});

test("apply_patch search 多处匹配拒绝", async () => {
  const r = reg();
  await r.run("write_file", { path: "dup.txt", content: "aa aa", backup: false }, await ctx());
  const res = await r.run("apply_patch", { path: "dup.txt", search: "aa", replace: "b" }, await ctx());
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /多处/);
});

test("rollback_change 恢复文件", async () => {
  const r = reg();
  await r.run("write_file", { path: "rb.txt", content: "original", backup: false }, await ctx());
  const w2 = await r.run("write_file", { path: "rb.txt", content: "modified" }, await ctx());
  assert.equal(w2.ok, true);
  const changeId = (w2 as { output: { changeId: string } }).output.changeId;
  const rb = await r.run("rollback_change", { changeId }, await ctx());
  assert.equal(rb.ok, true);
  const read = await r.run("read_file", { path: "rb.txt" }, await ctx());
  assert.equal((read as { output: { content: string } }).output.content, "original");
});

test("read_file 大文件 truncated", async () => {
  const r = reg();
  await r.run("write_file", { path: "big.txt", content: "x".repeat(300_000), backup: false }, await ctx());
  const res = await r.run("read_file", { path: "big.txt", maxBytes: 1000 }, await ctx());
  assert.equal(res.ok, true);
  assert.equal((res as { output: { truncated: boolean } }).output.truncated, true);
});

test("路径越权被拦截", async () => {
  const r = reg();
  const res = await r.run("read_file", { path: "../../etc/passwd" }, await ctx());
  assert.equal(res.ok, false);
});

test("resolveInsideWorkspace 拒绝越界路径", async () => {
  assert.throws(() => resolveInsideWorkspace(sandbox, "../outside.txt"));
});

test("权限不在允许集时拒绝", async () => {
  const r = reg();
  const res = await r.run(
    "write_file",
    { path: "p.txt", content: "x", backup: false },
    { workspaceRoot: sandbox, allowedPermissions: ["read"] },
  );
  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "permission_denied");
  assert.equal((res as { category: string }).category, "permission_error");
});

test("工具失败分类覆盖用户/权限/临时/环境/未知错误", async () => {
  const r = new ToolRegistry();
  r.register({
    name: "needs_input",
    description: "input",
    permission: "read",
    hasSideEffect: false,
    inputSchema: z.object({ path: z.string() }),
    async execute() {
      return {};
    },
  });
  r.register({
    name: "slow_tool",
    description: "slow",
    permission: "read",
    hasSideEffect: false,
    timeoutMs: 10,
    inputSchema: z.object({}),
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {};
    },
  });
  r.register({
    name: "missing_env",
    description: "missing env",
    permission: "read",
    hasSideEffect: false,
    inputSchema: z.object({}),
    async execute() {
      throw new Error("ENOENT: no such file or directory");
    },
  });
  r.register({
    name: "boom",
    description: "boom",
    permission: "read",
    hasSideEffect: false,
    inputSchema: z.object({}),
    async execute() {
      throw new Error("unexpected invariant");
    },
  });

  const invalid = await r.run("needs_input", {}, await ctx());
  assert.equal(invalid.ok, false);
  assert.equal((invalid as { category: string }).category, "user_error");
  const denied = await r.run("needs_input", { path: "x" }, { workspaceRoot: sandbox, allowedPermissions: [] });
  assert.equal(denied.ok, false);
  assert.equal((denied as { category: string }).category, "permission_error");
  const timeout = await r.run("slow_tool", {}, await ctx());
  assert.equal(timeout.ok, false);
  assert.equal((timeout as { category: string }).category, "temporary_error");
  const env = await r.run("missing_env", {}, await ctx());
  assert.equal(env.ok, false);
  assert.equal((env as { category: string }).category, "environment_error");
  const unknown = await r.run("boom", {}, await ctx());
  assert.equal(unknown.ok, false);
  assert.equal((unknown as { category: string }).category, "unknown_error");
  assert.equal(classifyToolError("unknown_tool", "x"), "user_error");
});

test("mock 工具记录调用并返回动态输出", async () => {
  const mock = createMockTool({
    name: "mock_echo",
    inputSchema: z.object({ text: z.string() }),
    permission: "read",
    output: (input, context, calls) => ({
      echoed: input.text,
      requestId: context.requestId,
      toolCallId: context.toolCallId,
      callCount: calls.length,
    }),
  });
  const r = createMockRegistry([mock], { defaultContext: { requestId: "mock-run" } });
  const res = await r.run("mock_echo", { text: "hello" }, { workspaceRoot: sandbox, toolCallId: "mock-call-1" });

  assert.equal(res.ok, true);
  assert.deepEqual((res as { output: { echoed: string; requestId: string; toolCallId: string; callCount: number } }).output, {
    echoed: "hello",
    requestId: "mock-run",
    toolCallId: "mock-call-1",
    callCount: 1,
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]?.input.text, "hello");
  assert.equal(mock.calls[0]?.context.toolCallId, "mock-call-1");
  mock.reset();
  assert.equal(mock.calls.length, 0);
});

test("mock 工具支持失败注入并参与失败分类", async () => {
  const mock = createMockTool({
    name: "mock_unstable",
    inputSchema: z.object({}),
    permission: "read",
    failWith: () => new Error("ECONNRESET temporary failure"),
  });
  const r = createMockRegistry([mock]);
  const res = await r.run("mock_unstable", {}, await ctx());

  assert.equal(res.ok, false);
  assert.equal((res as { code: string }).code, "error");
  assert.equal((res as { category: string }).category, "temporary_error");
  assert.equal(mock.calls.length, 1);
});

test("tool_logs 持久化前会脱敏输入输出和错误", async () => {
  const redactedDataDir = path.join(sandbox, "redacted-storage");
  await fs.mkdir(path.join(redactedDataDir, "agent_data"), { recursive: true });
  const storage = new ToolStorage(redactedDataDir);
  const r = new ToolRegistry(undefined, storage);
  r.register(
    createMockTool({
      name: "secret_echo",
      inputSchema: z.object({ apiKey: z.string(), message: z.string() }),
      permission: "read",
      output: () => ({
        message: "ok",
        token: "secret-token-value",
        text: "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456",
      }),
    }),
  );
  r.register(
    createMockTool({
      name: "secret_fail",
      inputSchema: z.object({}),
      permission: "read",
      failWith: "password=super-secret-value",
    }),
  );

  const ok = await r.run(
    "secret_echo",
    { apiKey: "sk-should-not-be-stored-1234567890", message: "keep-me" },
    { workspaceRoot: sandbox, requestId: "redaction-run" },
  );
  const failed = await r.run("secret_fail", {}, { workspaceRoot: sandbox, requestId: "redaction-run" });
  assert.equal(ok.ok, true);
  assert.equal(failed.ok, false);

  const logs = storage.listRecentToolLogs(2);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("sk-should-not-be-stored"), false);
  assert.equal(serialized.includes("secret-token-value"), false);
  assert.equal(serialized.includes("super-secret-value"), false);
  assert.ok(serialized.includes("keep-me"));
  assert.ok(serialized.includes("[REDACTED"));
  r.close();
});

test("命令风险：git reset --hard 为 dangerous", async () => {
  assert.equal(checkCommandRisk("git reset --hard").level, "dangerous");
  assert.equal(checkCommandRisk("rm -rf /").level, "dangerous");
  assert.equal(checkCommandRisk("npm install left-pad").level, "caution");
  assert.equal(checkCommandRisk("node -v").level, "safe");
});

test("shell_run 拒绝高风险命令", async () => {
  const r = reg();
  const res = await r.run("shell_run", { command: "rm -rf /" }, await ctx());
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /高风险/);
});

test("shell_run 遵守 denyCommands 策略", async () => {
  const r = createDefaultRegistry({
    shellPolicy: createShellPolicy({ denyCommands: ["node\\s+-e"] }),
  });
  const res = await r.run("shell_run", { command: 'node -e "console.log(42)"' }, await ctx());
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /denyCommands/);
  r.close();
});

test("shell_run 遵守 allowCommands 策略", async () => {
  const r = createDefaultRegistry({
    shellPolicy: createShellPolicy({ allowCommands: ["^git\\s+status\\b"] }),
  });
  const denied = await r.run("shell_run", { command: 'node -e "console.log(42)"' }, await ctx());
  assert.equal(denied.ok, false);
  assert.match((denied as { error: string }).error, /allowCommands/);
  r.close();
});

test("shell_run 安全命令 exitCode 0", async () => {
  const r = reg();
  const nodeCmd = `"${process.execPath}" -e "console.log(42)"`;
  const res = await r.run("shell_run", { command: nodeCmd }, await ctx());
  assert.equal(res.ok, true);
  assert.equal((res as { output: { exitCode: number } }).output.exitCode, 0);
  assert.match((res as { output: { stdout: string } }).output.stdout, /42/);
});

test("git_status 在 git 仓库返回 isRepo", async () => {
  const r = reg();
  const res = await r.run("git_status", {}, await ctx());
  assert.equal(res.ok, true);
  const out = (res as { output: { isRepo: boolean } }).output;
  assert.equal(typeof out.isRepo, "boolean");
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tools-"));
  dataDir = path.join(sandbox, "data");
  await fs.mkdir(dataDir, { recursive: true });
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  \u2717 ${t.name}\n    ${String(error)}`);
      failed += 1;
    }
  }
  await registryInstance?.close();
  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();
