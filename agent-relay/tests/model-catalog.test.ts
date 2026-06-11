/**
 * 本地模型目录探测自检（纯函数 + mock fetch）。
 * 运行：npm run test:model-catalog
 */
import assert from "node:assert/strict";

import type { ModelClientConfig } from "../src/config/types.js";
import {
  isConfiguredModelInstalled,
  listLocalModelCatalog,
  parseOllamaTagNames,
  parseOpenAiModelIds,
} from "../src/model/ModelCatalog.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

test("parseOllamaTagNames 去重排序", async () => {
  const names = parseOllamaTagNames({
    models: [{ name: "b:latest" }, { name: "a:7b" }, { name: "b:latest" }],
  });
  assert.deepEqual(names, ["a:7b", "b:latest"]);
});

test("parseOpenAiModelIds 提取 id", async () => {
  const ids = parseOpenAiModelIds({ data: [{ id: "local-model" }, { id: "other" }] });
  assert.deepEqual(ids, ["local-model", "other"]);
});

test("isConfiguredModelInstalled 支持 Ollama tag 前缀", async () => {
  assert.equal(isConfiguredModelInstalled("qwen3.5", ["qwen3.5:0.8b"]), true);
  assert.equal(isConfiguredModelInstalled("missing", ["a:b"]), false);
});

test("listLocalModelCatalog 仅探测 location=local", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen3.5:0.8b" }] }), { status: 200 });
    }
    if (url.includes("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const clients: ModelClientConfig[] = [
      {
        name: "local-qwen",
        provider: "ollama",
        location: "local",
        baseUrl: "http://localhost:11434",
        model: "qwen3.5:0.8b",
      },
      {
        name: "local-lm",
        provider: "openai-compatible",
        location: "local",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "lm-studio",
        model: "local-model",
      },
      {
        name: "cloud",
        provider: "openai-compatible",
        location: "remote",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-4o-mini",
      },
    ];
    const entries = await listLocalModelCatalog(clients);
    assert.equal(entries.length, 2);
    const ollama = entries.find((e) => e.clientName === "local-qwen")!;
    assert.equal(ollama.reachable, true);
    assert.deepEqual(ollama.models, ["qwen3.5:0.8b"]);
    assert.equal(ollama.configuredModelInstalled, true);
    const lm = entries.find((e) => e.clientName === "local-lm")!;
    assert.deepEqual(lm.models, ["local-model"]);
    assert.equal(lm.configuredModelInstalled, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("listLocalModelCatalog 端点不可达时 reachable=false", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    const entries = await listLocalModelCatalog([
      {
        name: "down",
        provider: "ollama",
        location: "local",
        baseUrl: "http://localhost:11434",
        model: "x",
      },
    ]);
    assert.equal(entries[0]!.reachable, false);
    assert.equal(entries[0]!.models.length, 0);
    assert.ok(entries[0]!.error);
  } finally {
    globalThis.fetch = original;
  }
});

async function main() {
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
  console.log(`\nmodel-catalog: ${passed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
