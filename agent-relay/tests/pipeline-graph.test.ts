/**
 * V9 路由管线图构建。
 */
import assert from "node:assert/strict";

import { buildPipelineGraph } from "../src/model-router/pipeline-graph.js";
import type { RouteLogRow } from "../src/model-router/route-stores.js";

const route: RouteLogRow = {
  id: "route-1",
  taskType: "architecture",
  selectedLevel: 3,
  executionStrategy: "parallel_vote",
  draftModelId: "api-general",
  finalModelId: "api-strong",
  reviewModelId: "api-general",
  risk: "medium",
  reason: "测试",
  source: "rule",
  candidates: ["api-general", "api-strong"],
  requireUserConfirmation: false,
  createdAt: new Date().toISOString(),
};

const graph = buildPipelineGraph({
  route,
  calls: [
    {
      id: "c1",
      routeLogId: "route-1",
      modelId: "api-general",
      role: "primary",
      status: "ok",
      createdAt: new Date().toISOString(),
    },
  ],
  collaborations: [
    {
      id: "col-1",
      routeLogId: "route-1",
      strategy: "parallel_vote",
      status: "completed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  fallbacks: [],
});

assert.ok(graph.nodes.some((n) => n.kind === "strategy" && n.label === "parallel_vote"));
assert.ok(graph.nodes.some((n) => n.label.includes("投票")));
assert.ok(graph.edges.length > 0);
assert.match(graph.mermaid, /flowchart LR/);
assert.match(graph.mermaid, /parallel_vote/);

console.log("pipeline-graph: 1 passed");
