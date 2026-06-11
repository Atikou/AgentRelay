/**
 * 工具系统自检（无需网络）：注册表、路径沙箱、文件读写/补丁/回滚、命令风险、git。
 * 运行：npm run test:tools
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/tools/index.js";
import { checkCommandRisk } from "../src/tools/risk.js";
import { resolveInsideWorkspace } from "../src/tools/pathSafe.js";
import { ALL_PERMISSIONS } from "../src/agent/permissions.js";

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
  "diff_file",
  "git_diff",
  "git_status",
  "list_files",
  "read_file",
  "rollback_change",
  "search_text",
  "shell_run",
  "write_file",
];

test("默认注册表包含 11 个第一阶段工具", async () => {
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

test("shell_run 安全命令 exitCode 0", async () => {
  const r = reg();
  const res = await r.run("shell_run", { command: 'node -e "console.log(42)"' }, await ctx());
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
