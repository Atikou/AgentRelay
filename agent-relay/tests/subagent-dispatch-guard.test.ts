import assert from "node:assert/strict";

import {
  assessSubagentDispatchGuard,
  assessSubagentSideEffectGuard,
  countSuccessfulSubagentDispatches,
  renderDispatchSubagentFailure,
  renderSubagentFinalConvergencePrompt,
} from "../src/agent/SubagentDispatchGuard.js";
import type { AgentToolStep } from "../src/agent/toolStep.js";

const tests: Array<{ name: string; fn: () => void }> = [];

function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

const dispatchStep = (ok: boolean, extra?: Partial<AgentToolStep>): AgentToolStep => ({
  iteration: 1,
  tool: "dispatch_subagent",
  input: {},
  ok,
  output: {},
  ...extra,
});

test("counts only successful executed dispatch_subagent steps", () => {
  const steps: AgentToolStep[] = [
    dispatchStep(true, { outcomeClass: "observation_success" }),
    dispatchStep(true, { blocked: true }),
    dispatchStep(false),
    { ...dispatchStep(true), tool: "read_file" },
  ];
  assert.equal(countSuccessfulSubagentDispatches(steps), 1);
});

test("blocks further dispatch after enough successful subagent results", () => {
  const steps = [
    dispatchStep(true),
    dispatchStep(true),
    dispatchStep(true),
  ];
  const reason = assessSubagentDispatchGuard({ tool: "dispatch_subagent", input: { tasks: [{ goal: "more" }] } }, steps);
  assert.match(reason ?? "", /足够子 Agent 结果/);
});

test("requires parent write permission and automatic write policy for write child tasks", () => {
  const action = {
    tool: "dispatch_subagent",
    input: { tasks: [{ goal: "patch", toolPolicy: { writeAllowed: true } }] },
  };

  assert.match(
    assessSubagentSideEffectGuard({
      action,
      allowedPermissions: ["read"],
      permissionPolicy: "confirmBeforeEdit",
    }) ?? "",
    /未授予 write/,
  );

  assert.match(
    assessSubagentSideEffectGuard({
      action,
      allowedPermissions: ["read", "write"],
      permissionPolicy: "confirmBeforeEdit",
    }) ?? "",
    /需要用户确认/,
  );

  assert.equal(
    assessSubagentSideEffectGuard({
      action,
      allowedPermissions: ["read", "write"],
      permissionPolicy: "autoEdit",
    }),
    undefined,
  );
});

test("requires autoRun for shell child tasks", () => {
  const action = {
    tool: "dispatch_subagent",
    input: { tasks: [{ goal: "run tests", toolPolicy: { shellAllowed: true } }] },
  };

  assert.match(
    assessSubagentSideEffectGuard({
      action,
      allowedPermissions: ["read", "shell"],
      permissionPolicy: "autoEdit",
    }) ?? "",
    /执行命令子 Agent 需要用户确认/,
  );
  assert.equal(
    assessSubagentSideEffectGuard({
      action,
      allowedPermissions: ["read", "shell"],
      permissionPolicy: "autoRun",
    }),
    undefined,
  );
});

test("renders dispatch failure and final convergence hints", () => {
  const failure = renderDispatchSubagentFailure(dispatchStep(false, { error: "[invalid_input] roles is not allowed" }));
  assert.match(failure, /tasks: DelegatedTask\[\]/);

  const base = "工具「dispatch_subagent」执行结果（JSON）：{}";
  const rendered = renderSubagentFinalConvergencePrompt(base, [dispatchStep(true), dispatchStep(true), dispatchStep(true)]);
  assert.match(rendered, /下一步必须汇总/);
});

for (const t of tests) {
  t.fn();
  console.log(`ok - ${t.name}`);
}
