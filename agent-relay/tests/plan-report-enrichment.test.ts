/**
 * 计划报告质量与补全自检。
 * Run: npm run test:plan-report-enrichment
 */
import assert from "node:assert/strict";

import type { AgentToolStep } from "../src/agent/toolStep.js";
import {
  assessPlanReportQuality,
  buildPlanReportFromToolSteps,
  isPlanReportShellOnly,
  resolvePlanReportMarkdown,
} from "../src/plan/planReportEnrichment.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const goal = "只读分析 nextjs 项目架构并给出阶段性修复计划";

test("空 answer 识别为 shell_only", () => {
  assert.equal(isPlanReportShellOnly("", goal), true);
  const q = assessPlanReportQuality("", goal);
  assert.equal(q.acceptable, false);
  assert.ok(q.issues.includes("empty_answer"));
});

test("buildPlanReportFromToolSteps 含 Todo 与扫描节", () => {
  const steps: AgentToolStep[] = [
    {
      iteration: 0,
      tool: "project_scan",
      input: {},
      ok: true,
      preflight: true,
      output: "src/app\nsrc/pages",
      outcomeMessage: "扫描到 2 个顶层目录",
    },
  ];
  const md = buildPlanReportFromToolSteps(goal, steps);
  assert.match(md, /## 2\. 只读扫描结果/);
  assert.match(md, /- \[ \] P0/);
  const q = assessPlanReportQuality(md, goal);
  assert.equal(q.acceptable, true);
});

test("resolvePlanReportMarkdown 在模型空答时从工具步骤补全", () => {
  const steps: AgentToolStep[] = [
    {
      iteration: 0,
      tool: "context_pack",
      input: { paths: ["package.json"] },
      ok: true,
      output: '{"files":[{"path":"package.json","snippet":"next"}]}',
    },
  ];
  const resolved = resolvePlanReportMarkdown({ goal, modelAnswer: "", steps });
  assert.equal(resolved.enriched, true);
  assert.equal(resolved.quality.acceptable, true);
  assert.match(resolved.markdown, /package\.json|next/);
});

test("无工具步骤且空答不可接受", () => {
  const resolved = resolvePlanReportMarkdown({ goal, modelAnswer: "", steps: [] });
  assert.equal(resolved.quality.acceptable, false);
});

function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.fn();
      console.log(`  ok ${t.name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${t.name}`);
      console.error(error);
      failed += 1;
    }
  }
  console.log(`\nplan-report-enrichment: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
