/**
 * toolOutcome 协议自检（read_file / search_text / shell_run）。
 * 运行：npm run test:tool-outcome
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultRegistry } from "../src/tools/index.js";
import { resolveToolOutcome } from "../src/tools/toolOutcome.js";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

let sandbox = "";

async function setup() {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "tool-outcome-"));
}

test("read_file not_found → observation_failure", async () => {
  const registry = createDefaultRegistry();
  const res = await registry.run("read_file", { path: "missing/index.html" }, { workspaceRoot: sandbox });
  assert.equal(res.executed, true);
  assert.equal(res.outcomeClass, "observation_failure");
  assert.equal(res.outcomeKind, "not_found");
  assert.equal(res.ok, false);
});

test("search_text 无结果 → observation_failure no_results", async () => {
  await writeFile(path.join(sandbox, "a.txt"), "hello", "utf8");
  const registry = createDefaultRegistry();
  const res = await registry.run(
    "search_text",
    { query: "zzzz-not-exist", root: "." },
    { workspaceRoot: sandbox },
  );
  assert.equal(res.outcomeClass, "observation_failure");
  assert.equal(res.outcomeKind, "no_results");
});

test("shell_run 非零退出码 → observation_failure command_failed", async () => {
  const registry = createDefaultRegistry();
  const cmd = process.platform === "win32" ? "exit 1" : "false";
  const res = await registry.run("shell_run", { command: cmd }, { workspaceRoot: sandbox });
  assert.equal(res.executed, true);
  assert.equal(res.outcomeClass, "observation_failure");
  assert.equal(res.outcomeKind, "command_failed");
});

test("shell_run 命令不存在 → observation_failure command_not_found", async () => {
  const registry = createDefaultRegistry();
  const cmd = "agent_relay_nonexistent_cmd_xyz_999";
  const res = await registry.run("shell_run", { command: cmd }, { workspaceRoot: sandbox });
  assert.equal(res.executed, true);
  assert.equal(res.outcomeClass, "observation_failure");
  assert.equal(res.outcomeKind, "command_not_found");
});

test("symbol_search 无结果 → observation_failure no_results", async () => {
  const registry = createDefaultRegistry();
  const res = await registry.run(
    "symbol_search",
    { query: "TotallyMissingSymbolNameXYZ", root: "." },
    { workspaceRoot: sandbox },
  );
  assert.equal(res.outcomeClass, "observation_failure");
  assert.equal(res.outcomeKind, "no_results");
});

test("write_file 成功 → observation_success", async () => {
  const registry = createDefaultRegistry();
  const res = await registry.run(
    "write_file",
    { path: "outcome-test.txt", content: "ok", backup: false },
    { workspaceRoot: sandbox },
  );
  assert.equal(res.outcomeClass, "observation_success");
  assert.equal(res.outcomePath, "outcome-test.txt");
});

test("locate_relevant_files 无候选 → observation_failure no_results", () => {
  const outcome = resolveToolOutcome("locate_relevant_files", {
    primaryFiles: [],
    candidateFiles: [],
    searchPlan: { goal: "missing module" },
  });
  assert.equal(outcome.class, "observation_failure");
  assert.equal(outcome.kind, "no_results");
});

test("context_pack 无文件 → observation_failure no_results", async () => {
  const registry = createDefaultRegistry();
  const res = await registry.run(
    "context_pack",
    { files: ["missing-a.txt", "missing-b.txt"], maxFiles: 4, maxTokens: 2000 },
    { workspaceRoot: sandbox },
  );
  assert.equal(res.outcomeClass, "observation_failure");
  assert.equal(res.outcomeKind, "no_results");
});

test("resolveToolOutcome 与注册表一致", async () => {
  const registry = createDefaultRegistry();
  const res = await registry.run("read_file", { path: "nope.txt" }, { workspaceRoot: sandbox });
  const outcome = resolveToolOutcome("read_file", res.output);
  assert.equal(outcome.class, "observation_failure");
  assert.equal(outcome.kind, "not_found");
});

let passed = 0;
let failed = 0;
(async () => {
  await setup();
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
  console.log(`\ntool-outcome: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
