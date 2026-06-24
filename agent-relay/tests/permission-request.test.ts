/**
 * Plan → Approval → Execute 权限申请自检。
 * 运行：npm run test:permission-request
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectPlanExecutionVariant } from "../src/agent/planExecutionVariant.js";
import { ContextManager } from "../src/context/ContextManager.js";
import { PermissionRequestStore } from "../src/policy/PermissionRequestStore.js";
import { SessionPermissionGrants } from "../src/policy/SessionPermissionGrants.js";
import { isToolCallGranted } from "../src/policy/scopedPermissionCheck.js";
import { evaluatePermissionGuard } from "../src/policy/PermissionGuard.js";
import { PausedRunStore } from "../src/agent/PausedRunStore.js";
import { findBlockingAgentPause } from "../src/policy/permissionPauseGate.js";

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function tempDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ar-permission-"));
}

function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("detectPlanExecutionVariant 识别 plan_then_execute", () => {
  assert.equal(
    detectPlanExecutionVariant("先分析项目，制定 README 修改计划，然后按计划执行"),
    "plan_then_execute",
  );
  assert.equal(
    detectPlanExecutionVariant("请制定计划，但不要执行"),
    "plan_only",
  );
});

test("PermissionRequestStore respond allow_session", () => {
  const store = new PermissionRequestStore();
  const created = store.create({
    runId: "run-1",
    sessionId: "sess-1",
    title: "测试",
    summary: "需要写 README",
    requiredPermissions: [{ type: "write_file", target: "README.md", reason: "更新文档" }],
  });
  const responded = store.respond(created.id, { decision: "allow_session" });
  assert.equal(responded?.status, "approved");
  assert.deepEqual(responded?.approvedPermissions?.write_file, ["README.md"]);
});

test("PermissionRequestStore 持久化后可跨实例读取和流转状态", () => {
  const dataDir = tempDataDir();
  let ctx: ContextManager | undefined;
  try {
    ctx = new ContextManager({ dataDir, useLanceDb: false });
    const store = new PermissionRequestStore(ctx.db.connection);
    const created = store.create({
      runId: "run-db",
      sessionId: "sess-db",
      title: "写入确认",
      summary: "需要写 README",
      requiredPermissions: [{ type: "write_file", target: "README.md", reason: "更新说明" }],
    });

    const reloaded = new PermissionRequestStore(ctx.db.connection);
    assert.equal(reloaded.get(created.id)?.status, "pending");
    assert.equal(reloaded.getPendingByRunId("run-db")?.id, created.id);

    const approved = reloaded.respond(created.id, { decision: "allow_once" });
    assert.equal(approved?.status, "approved");

    const afterApprove = new PermissionRequestStore(ctx.db.connection);
    assert.equal(afterApprove.get(created.id)?.status, "approved");
    assert.equal(afterApprove.getPendingByRunId("run-db"), null);
  } finally {
    ctx?.close();
    removeTempDir(dataDir);
  }
});

test("scoped grants 允许已批准写文件", () => {
  assert.equal(
    isToolCallGranted({
      toolName: "write_file",
      permission: "write",
      toolInput: { path: "README.md" },
      grants: { write_file: ["README.md"] },
    }),
    true,
  );
  assert.equal(
    isToolCallGranted({
      toolName: "write_file",
      permission: "write",
      toolInput: { path: "secret.env" },
      grants: { write_file: ["README.md"] },
    }),
    false,
  );
});

test("PermissionGuard 在 scoped grants 下放行写入", () => {
  const decision = evaluatePermissionGuard({
    intent: "edit",
    permissionPolicy: "confirmBeforeEdit",
    toolName: "write_file",
    permission: "write",
    input: { path: "README.md" },
    allowedPermissions: ["read", "write"],
    scopedGrants: { write_file: ["README.md"] },
  });
  assert.equal(decision.decision, "allow");
});

test("SessionPermissionGrants merge 累积会话授权", () => {
  const grants = new SessionPermissionGrants();
  grants.merge("s1", { write_file: ["README.md"] });
  grants.merge("s1", { shell: ["npm run typecheck"] });
  const merged = grants.get("s1");
  assert.deepEqual(merged?.write_file, ["README.md"]);
  assert.deepEqual(merged?.shell, ["npm run typecheck"]);
});

test("PausedRunStore take 取出后即失效（避免对同一快照重复续跑）", () => {
  const store = new PausedRunStore();
  store.save({
    runId: "run-paused",
    sessionId: "sess-paused",
    goal: "修改 README 并验证",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "修改 README 并验证" },
      { role: "assistant", content: '{"action":"tool","tool":"write_file","input":{"path":"README.md"}}' },
    ],
    steps: [],
    modelTurns: 1,
    pendingAction: { tool: "write_file", input: { path: "README.md" } },
    mode: "implement",
    permissionPolicy: "confirmBeforeEdit",
    createdAt: new Date().toISOString(),
  });
  const taken = store.take("run-paused");
  assert.equal(taken?.runId, "run-paused");
  assert.equal(taken?.pendingAction?.tool, "write_file");
  assert.equal(taken?.messages.length, 3);
  assert.equal(store.take("run-paused"), null);
});

test("PausedRunStore 持久化后可跨实例 take 且只消费一次", () => {
  const dataDir = tempDataDir();
  let ctx: ContextManager | undefined;
  try {
    ctx = new ContextManager({ dataDir, useLanceDb: false });
    const store = new PausedRunStore(ctx.db.connection);
    store.save({
      runId: "run-paused-db",
      sessionId: "sess-paused-db",
      goal: "修改 README",
      messages: [{ role: "user", content: "修改 README" }],
      steps: [],
      modelTurns: 1,
      pendingAction: { tool: "write_file", input: { path: "README.md" } },
      mode: "implement",
      permissionPolicy: "confirmBeforeEdit",
      createdAt: new Date().toISOString(),
    });

    const reloaded = new PausedRunStore(ctx.db.connection);
    assert.equal(reloaded.get("run-paused-db")?.pendingAction?.tool, "write_file");
    assert.equal(reloaded.take("run-paused-db")?.runId, "run-paused-db");
    assert.equal(new PausedRunStore(ctx.db.connection).get("run-paused-db"), null);
  } finally {
    ctx?.close();
    removeTempDir(dataDir);
  }
});

test("PausedRunStore 计划→执行交接快照无 pendingAction 且 resumeMode=implement", () => {
  const store = new PausedRunStore();
  store.save({
    runId: "run-handoff",
    sessionId: "sess-handoff",
    goal: "制定计划然后执行",
    messages: [
      { role: "user", content: "制定计划然后执行" },
      { role: "assistant", content: "## 计划\n- 改 README" },
    ],
    steps: [],
    modelTurns: 1,
    mode: "plan",
    permissionPolicy: "readOnly",
    resumeMode: "implement",
    workflowProposals: [
      {
        workflowType: "generateFileWorkflow",
        phase: "proposal",
        goal: "制定计划然后执行",
        intent: "generate_file",
        permissionPolicy: "autoEdit",
        requiredFields: ["targetFiles", "changeSummary", "diffPlan", "verificationPlan", "permissionCheck"],
        writeAllowedByPolicy: true,
        requiresConfirmationBeforeWrite: false,
        permissionSummary: "write_allowed",
        permissionChecks: [
          {
            toolName: "write_file",
            permission: "write",
            decision: "allow",
            risk: {
              tier: "low",
              category: "file_write",
              requiresConfirmation: false,
              policyBlocked: false,
            },
          },
        ],
      },
    ],
    createdAt: new Date().toISOString(),
  });
  const snapshot = store.get("run-handoff");
  assert.equal(snapshot?.pendingAction, undefined);
  assert.equal(snapshot?.resumeMode, "implement");
  assert.equal(snapshot?.workflowProposals?.length, 1);
  assert.equal(snapshot?.workflowProposals?.[0]?.workflowType, "generateFileWorkflow");
});

test("findBlockingPermissionPause 有待批准申请时阻止新 agent", () => {
  const store = new PermissionRequestStore();
  store.create({
    runId: "run-block",
    sessionId: "sess-block",
    title: "待批准",
    summary: "s",
    requiredPermissions: [{ type: "write_file", target: "a.ts", reason: "r" }],
  });
  const gate = findBlockingAgentPause({
    sessionId: "sess-block",
    permissionRequestStore: store,
  });
  assert.equal(gate?.code, "PERMISSION_PAUSE_PENDING");
  assert.equal(gate?.runId, "run-block");
});

test("findBlockingPermissionPause 有暂停快照时阻止新 agent", () => {
  const paused = new PausedRunStore();
  paused.save({
    runId: "run-snap",
    sessionId: "sess-snap",
    goal: "g",
    messages: [],
    steps: [],
    modelTurns: 0,
    mode: "plan",
    permissionPolicy: "readOnly",
    resumeMode: "implement",
    createdAt: new Date().toISOString(),
  });
  const perm = new PermissionRequestStore();
  const created = perm.create({
    runId: "run-snap",
    sessionId: "sess-snap",
    title: "t",
    summary: "s",
    requiredPermissions: [{ type: "write_file", target: "a.ts", reason: "r" }],
  });
  perm.respond(created.id, { decision: "allow_once" });
  const gate = findBlockingAgentPause({
    sessionId: "sess-snap",
    permissionRequestStore: perm,
    pausedRunStore: paused,
  });
  assert.equal(gate?.code, "PERMISSION_RESUME_REQUIRED");
  assert.equal(gate?.runId, "run-snap");
});

test("PausedRunStore hasPausedForSession 检测会话级暂停", () => {
  const store = new PausedRunStore();
  assert.equal(store.hasPausedForSession("sess-x"), false);
  store.save({
    runId: "run-x",
    sessionId: "sess-x",
    goal: "g",
    messages: [],
    steps: [],
    modelTurns: 0,
    mode: "implement",
    permissionPolicy: "confirmBeforeEdit",
    createdAt: new Date().toISOString(),
  });
  assert.equal(store.hasPausedForSession("sess-x"), true);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(error);
  }
}
console.log(`\npermission-request: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
