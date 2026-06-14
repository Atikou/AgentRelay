/**
 * WorkflowWriteGate + EditWriteWorkflow + DebugFixWorkflow self-check.
 * Run: npm run test:workflow-write-gate
 */
import assert from "node:assert/strict";

import { DebugFixWorkflow } from "../src/agent/DebugFixWorkflow.js";
import { EditWriteWorkflow } from "../src/agent/EditWriteWorkflow.js";
import {
  assessWorkflowWriteGate,
  countSuccessfulReadTools,
  requiresReadBeforeWrite,
} from "../src/agent/WorkflowWriteGate.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const readStep: AgentToolStep = {
  iteration: 0,
  tool: "read_file",
  input: { path: "src/a.ts" },
  permission: "read",
  ok: true,
};

test("blocks edit write without proposal and read tools", () => {
  const gate = assessWorkflowWriteGate({
    intent: "edit",
    goal: "修改 src/a.ts",
    tool: "write_file",
    steps: [],
    hasProposal: false,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason ?? "", /proposal phase/);
});

test("blocks scoped edit write without read tools", () => {
  const gate = assessWorkflowWriteGate({
    intent: "edit",
    goal: "修改 AgentLoop 模块",
    tool: "apply_patch",
    steps: [],
    hasProposal: true,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason ?? "", /proposal phase is not complete/);
});

test("allows simple generate_file write with proposal only", () => {
  const gate = assessWorkflowWriteGate({
    intent: "generate_file",
    goal: "新建文件",
    tool: "write_file",
    steps: [],
    hasProposal: true,
  });
  assert.equal(gate.blocked, false);
  assert.equal(gate.phase, "write");
  assert.equal(requiresReadBeforeWrite("generate_file", "新建文件"), false);
});

test("allows edit write after read tools and records write phase", () => {
  const gate = assessWorkflowWriteGate({
    intent: "edit",
    goal: "修改 src/a.ts",
    tool: "write_file",
    steps: [readStep],
    hasProposal: true,
  });
  assert.equal(gate.blocked, false);
  assert.equal(countSuccessfulReadTools([readStep]), 1);

  const writePhase = new EditWriteWorkflow().run({
    goal: "修改 src/a.ts",
    intent: "edit",
    permissionPolicy: "autoEdit",
    gate,
    tool: "write_file",
  });
  assert.ok(writePhase);
  assert.equal(writePhase.record.phase, "write");
  assert.match(writePhase.modelContext, /editWorkflow write phase/);
});

test("blocks debug fix without analysis", () => {
  const gate = assessWorkflowWriteGate({
    intent: "debug",
    goal: "修复 AgentLoop 报错",
    tool: "write_file",
    steps: [readStep],
    hasDebugAnalysis: false,
  });
  assert.equal(gate.blocked, true);
  assert.match(gate.reason ?? "", /analysis phase/);
});

test("allows debug fix after analysis and read tools", () => {
  const gate = assessWorkflowWriteGate({
    intent: "debug",
    goal: "修复 AgentLoop 报错",
    tool: "apply_patch",
    steps: [readStep],
    hasDebugAnalysis: true,
  });
  assert.equal(gate.blocked, false);
  assert.equal(gate.phase, "fix");

  const fixPhase = new DebugFixWorkflow().run({
    goal: "修复 AgentLoop 报错",
    intent: "debug",
    permissionPolicy: "autoEdit",
    gate,
    tool: "apply_patch",
  });
  assert.ok(fixPhase);
  assert.equal(fixPhase.record.phase, "fix");
  assert.match(fixPhase.modelContext, /debugWorkflow fix phase/);
});

test("blocks second write until previous write is verified", () => {
  const writeStep: AgentToolStep = {
    iteration: 1,
    tool: "write_file",
    input: { path: "src/a.ts", content: "new" },
    permission: "write",
    ok: true,
    output: { path: "src/a.ts" },
  };
  const gate = assessWorkflowWriteGate({
    intent: "edit",
    goal: "修改 src/a.ts",
    tool: "apply_patch",
    steps: [readStep, writeStep],
    hasProposal: true,
  });

  assert.equal(gate.blocked, true);
  assert.match(gate.reason ?? "", /requires verification/);
  assert.equal(gate.state.phase, "write_pending_verification");
});

test("allows correction write after failed verification before limit", () => {
  const writeStep: AgentToolStep = {
    iteration: 1,
    tool: "write_file",
    input: { path: "src/a.ts", content: "new" },
    permission: "write",
    ok: true,
    output: { path: "src/a.ts" },
  };
  const failedVerify: AgentToolStep = {
    iteration: 2,
    tool: "shell_run",
    input: { command: "npm test" },
    permission: "shell",
    ok: false,
    error: "failed",
  };
  const gate = assessWorkflowWriteGate({
    intent: "debug",
    goal: "修复 src/a.ts",
    tool: "apply_patch",
    steps: [readStep, writeStep, failedVerify],
    hasDebugAnalysis: true,
  });

  assert.equal(gate.blocked, false);
  assert.equal(gate.phase, "fix");
  assert.equal(gate.state.phase, "correction_allowed");
});

test("blocks refactor write without staged plan", () => {
  const gate = assessWorkflowWriteGate({
    intent: "refactor",
    goal: "重构 src/agent 模块",
    tool: "apply_patch",
    steps: [readStep],
    hasRefactorPlan: false,
  });

  assert.equal(gate.blocked, true);
  assert.match(gate.reason ?? "", /staged plan phase/);
});

test("allows refactor write after staged plan and read tools", () => {
  const gate = assessWorkflowWriteGate({
    intent: "refactor",
    goal: "重构 src/agent 模块",
    tool: "apply_patch",
    steps: [readStep],
    hasRefactorPlan: true,
  });

  assert.equal(gate.blocked, false);
  assert.equal(gate.phase, "write");

  const writePhase = new EditWriteWorkflow().run({
    goal: "重构 src/agent 模块",
    intent: "refactor",
    permissionPolicy: "autoEdit",
    gate,
    tool: "apply_patch",
  });
  assert.ok(writePhase);
  assert.equal(writePhase.record.workflowType, "refactorWorkflow");
  assert.match(writePhase.modelContext, /one isolated refactor stage/);
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ok ${t.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(error);
  }
}
console.log(`\nworkflow-write-gate: ${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
