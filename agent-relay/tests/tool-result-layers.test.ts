/**
 * 工具结果三层 trace 自检（raw / modelVisible / userDisplay）。
 * 运行：npm run test:tool-result-layers
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentLoop, type LoopChatFn } from "../src/agent/AgentLoop.js";
import {
  buildToolResultLayers,
  clipModelToolJson,
  compactToolOutputForModel,
  isModelCompactTruncated,
  jsonSerializedLength,
} from "../src/util/toolResultLayers.js";
import type { ModelResponse } from "../src/model/types.js";
import { readRecentTraceEvents } from "../src/trace/traceReader.js";
import { TraceLogger } from "../src/trace/TraceLogger.js";
import { createDefaultRegistry } from "../src/tools/index.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";
let dataDir = "";

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

test("compactToolOutputForModel 大 JSON 返回 _truncated 摘要", async () => {
  const raw = { files: Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.txt`, type: "file" })), truncated: false };
  const { modelVisible, truncated } = compactToolOutputForModel("list_files", raw, 2000);
  assert.equal(truncated, true);
  assert.ok(isModelCompactTruncated(modelVisible));
});

test("clipModelToolJson 对 undefined 安全", async () => {
  assert.equal(clipModelToolJson(undefined), "null");
  assert.equal(compactToolOutputForModel("read_file", undefined).truncated, false);
  assert.equal(jsonSerializedLength(undefined), 4);
  assert.doesNotThrow(() => buildToolResultLayers("project_scan", undefined));
});

test("buildToolResultLayers list_files userDisplay 标记 truncated", async () => {
  const raw = {
    root: "bulk",
    files: Array.from({ length: 80 }, (_, i) => ({ path: `bulk/f${i}.txt`, type: "file" as const })),
    truncated: true,
  };
  const layers = buildToolResultLayers("list_files", raw, { largeToolChars: 500 });
  assert.equal(layers.userDisplay.truncated, true);
  assert.equal(layers.userDisplay.itemCount, 80);
  assert.match(layers.userDisplay.summary, /已截断/);
  assert.ok(layers.rawJsonLength > layers.modelJsonLength);
});

test("测试4：list_files 大量结果 raw trace 完整 + model summary + truncated", async () => {
  const dir = path.join(sandbox, "bulk");
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < 100; i++) {
    await fs.writeFile(path.join(dir, `file-${i}.txt`), `payload-${i}-${"x".repeat(40)}`, "utf-8");
  }

  const traceFile = path.join(dataDir, "trace.jsonl");
  const trace = new TraceLogger(traceFile);
  const chat = scriptedChat([
    '{"action":"tool","tool":"list_files","input":{"root":"bulk","limit":100},"thought":"列目录"}',
    '{"action":"final","answer":"已查看目录"}',
  ]);
  const loop = new AgentLoop({
    chat,
    registry: createDefaultRegistry(),
    workspaceRoot: sandbox,
    trace,
    runId: "run-tool-layers",
  });
  const res = await loop.run("列出 bulk 目录");
  assert.equal(res.steps.length, 1);
  const step = res.steps[0]!;
  assert.ok(step.resultLayers);
  const raw = step.resultLayers!.raw as { files: unknown[]; truncated?: boolean };
  assert.equal(raw.files.length, 100);
  assert.equal(step.resultLayers!.userDisplay.truncated, true);
  assert.ok(isModelCompactTruncated(step.resultLayers!.modelVisible));
  assert.ok(step.resultLayers!.rawJsonLength > step.resultLayers!.modelJsonLength);

  await trace.close();
  const events = await readRecentTraceEvents(traceFile, { limit: 30 });
  const toolDone = events.find(
    (e) => (e as { type?: string; status?: string }).type === "agent_tool" &&
      (e as { status?: string }).status === "ok",
  ) as { rawOutput?: { files: unknown[] }; userDisplay?: { truncated: boolean } } | undefined;
  assert.ok(toolDone?.rawOutput);
  assert.equal(toolDone.rawOutput!.files.length, 100);
  assert.equal(toolDone.userDisplay?.truncated, true);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "agent-layers-"));
  dataDir = path.join(sandbox, "data");
  await fs.mkdir(dataDir, { recursive: true });

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
  console.log(`\ntool-result-layers: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
