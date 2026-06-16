/**
 * 结构化工具风险自检。
 * 运行：npm run test:tool-risk
 */
import assert from "node:assert/strict";

import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { shellRunTool } from "../src/tools/shellTool.js";
import { createShellPolicy } from "../src/policy/ShellPolicy.js";
import {
  assessFileWriteRisk,
  assessShellCommandRisk,
  assessToolRisk,
} from "../src/policy/ToolRiskAssessment.js";
import { ALL_PERMISSIONS } from "../src/core/permissions.js";

const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

test("assessShellCommandRisk dangerous 为 critical", () => {
  const risk = assessShellCommandRisk("rm -rf /");
  assert.equal(risk.tier, "critical");
  assert.equal(risk.commandLevel, "dangerous");
  assert.equal(risk.policyBlocked, false);
});

test("assessShellCommandRisk denyCommands 标记 policyBlocked", () => {
  const policy = createShellPolicy({ denyCommands: ["^npm\\s+install"] });
  const risk = assessShellCommandRisk("npm install lodash", policy);
  assert.equal(risk.policyBlocked, true);
  assert.equal(risk.tier, "critical");
});

test("assessFileWriteRisk 敏感路径提升为 high", () => {
  const risk = assessFileWriteRisk(".env", false);
  assert.equal(risk.tier, "high");
  assert.match(risk.reasons.join(" "), /敏感路径/);
});

test("assessToolRisk write_file 返回结构化字段", () => {
  const risk = assessToolRisk({
    toolName: "write_file",
    permission: "write",
    input: { path: "src/a.ts", content: "x" },
    preview: { kind: "write_file", path: "src/a.ts", isNew: true },
  });
  assert.equal(risk.category, "file_write");
  assert.equal(risk.requiresConfirmation, true);
  assert.deepEqual(Object.keys(risk).sort(), [
    "category",
    "policyBlocked",
    "reasons",
    "requiresConfirmation",
    "summary",
    "target",
    "tier",
  ]);
});

test("ToolRegistry shell 策略拒绝时附带 risk", async () => {
  const registry = new ToolRegistry();
  registry.setDefaultContext({
    shellPolicy: createShellPolicy({ denyCommands: ["node\\s+-e"] }),
  });
  registry.register(shellRunTool);

  const res = await registry.run(
    "shell_run",
    { command: "node -e \"1\"" },
    { workspaceRoot: process.cwd(), allowedPermissions: ALL_PERMISSIONS },
  );
  assert.equal(res.ok, false);
  assert.equal((res as { risk?: { tier: string } }).risk?.tier, "critical");
  assert.equal((res as { risk?: { policyBlocked: boolean } }).risk?.policyBlocked, true);
});

async function main() {
  for (const t of tests) {
    await t.fn();
    console.log(`ok ${t.name}`);
  }
  console.log(`\n${tests.length} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
