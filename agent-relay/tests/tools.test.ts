/**
 * 工具系统自检（无需网络）：注册表校验/权限/越权防护、文件工具、命令风险。
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
async function ctx() {
  return { workspaceRoot: sandbox, allowedPermissions: ALL_PERMISSIONS };
}

test("默认注册表包含 5 个内置工具", async () => {
  const reg = createDefaultRegistry();
  const names = reg.list().map((t) => t.name).sort();
  assert.deepEqual(names, ["list_files", "read_file", "search_text", "shell_run", "write_file"]);
});

test("write_file → read_file 往返一致", async () => {
  const reg = createDefaultRegistry();
  const w = await reg.run("write_file", { path: "sub/a.txt", content: "你好tool" }, await ctx());
  assert.equal(w.ok, true);
  const r = await reg.run("read_file", { path: "sub/a.txt" }, await ctx());
  assert.equal(r.ok, true);
  assert.equal((r as any).output.content, "你好tool");
});

test("list_files 返回目录条目", async () => {
  const reg = createDefaultRegistry();
  await reg.run("write_file", { path: "list/x.txt", content: "1" }, await ctx());
  const res = await reg.run("list_files", { path: "list" }, await ctx());
  assert.equal(res.ok, true);
  assert.ok((res as any).output.entries.some((e: any) => e.name === "x.txt"));
});

test("search_text 命中查询", async () => {
  const reg = createDefaultRegistry();
  await reg.run("write_file", { path: "src/needle.txt", content: "find HAYSTACK here" }, await ctx());
  const res = await reg.run("search_text", { query: "HAYSTACK", dir: "src" }, await ctx());
  assert.equal(res.ok, true);
  assert.ok((res as any).output.matches.length >= 1);
});

test("路径越权被拦截（read_file 工作区之外）", async () => {
  const reg = createDefaultRegistry();
  const res = await reg.run("read_file", { path: "../../etc/passwd" }, await ctx());
  assert.equal(res.ok, false);
  assert.equal((res as any).code, "error");
});

test("resolveInsideWorkspace 拒绝越界路径", async () => {
  assert.throws(() => resolveInsideWorkspace(sandbox, "../outside.txt"));
  assert.doesNotThrow(() => resolveInsideWorkspace(sandbox, "inside.txt"));
});

test("权限不在允许集时拒绝", async () => {
  const reg = createDefaultRegistry();
  const res = await reg.run(
    "write_file",
    { path: "p.txt", content: "x" },
    { workspaceRoot: sandbox, allowedPermissions: ["read"] },
  );
  assert.equal(res.ok, false);
  assert.equal((res as any).code, "permission_denied");
});

test("入参非法时返回 invalid_input", async () => {
  const reg = createDefaultRegistry();
  const res = await reg.run("read_file", { path: 123 }, await ctx());
  assert.equal(res.ok, false);
  assert.equal((res as any).code, "invalid_input");
});

test("未知工具返回 unknown_tool", async () => {
  const reg = createDefaultRegistry();
  const res = await reg.run("nope", {}, await ctx());
  assert.equal(res.ok, false);
  assert.equal((res as any).code, "unknown_tool");
});

test("命令风险分级：危险/谨慎/安全", async () => {
  assert.equal(checkCommandRisk("rm -rf /").level, "dangerous");
  assert.equal(checkCommandRisk("git push --force origin main").level, "dangerous");
  assert.equal(checkCommandRisk("npm install left-pad").level, "caution");
  assert.equal(checkCommandRisk("node -v").level, "safe");
});

test("shell_run 拦截危险命令", async () => {
  const reg = createDefaultRegistry();
  const res = await reg.run("shell_run", { command: "rm -rf /" }, await ctx());
  assert.equal(res.ok, false);
  assert.match((res as any).error, /危险命令被拦截/);
});

test("shell_run 执行安全命令返回退出码 0", async () => {
  const reg = createDefaultRegistry();
  const res = await reg.run("shell_run", { command: 'node -e "console.log(42)"' }, await ctx());
  assert.equal(res.ok, true);
  assert.equal((res as any).output.exitCode, 0);
  assert.match((res as any).output.stdout, /42/);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tools-"));
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
  await fs.rm(sandbox, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();
