/**
 * Orchestrator 权限/计划续跑策略自检：续跑不得被客户端 permissionPolicy 覆盖。
 * 运行：npm run test:orchestrator-resume
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LoopChatFn } from "../src/agent/AgentLoop.js";
import { PausedRunStore } from "../src/agent/PausedRunStore.js";
import { ContextManager } from "../src/context/ContextManager.js";
import type { ModelResponse } from "../src/model/types.js";
import { PermissionRequestStore } from "../src/policy/PermissionRequestStore.js";
import { PlanHandoffStore } from "../src/policy/PlanHandoffStore.js";
import { SessionPermissionGrants } from "../src/policy/SessionPermissionGrants.js";
import { RunStore } from "../src/orchestrator/RunStore.js";
import { RunStateStore } from "../src/orchestrator/RunStateStore.js";
import { ALL_PERMISSIONS } from "../src/core/permissions.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import { createTestPlanService } from "./planTestHelper.js";
import { createTestOrchestrator } from "./orchestratorTestHelper.js";

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];
function test(name: string, fn: () => Promise<void>) {
  tests.push({ name, fn });
}

let sandbox = "";
let dataDir = "";
let ctx: ContextManager;
let runs: RunStore;
let runStateStore: RunStateStore;

function finalChat(answer = "续跑完成"): LoopChatFn {
  return async () =>
    ({
      content: JSON.stringify({ action: "final", answer }),
      toolCalls: [],
      clientName: "fake",
      modelName: "fake",
      location: "local",
      latencyMs: 1,
    }) satisfies ModelResponse;
}

function makeOrchestrator(chat: LoopChatFn, extra?: Record<string, unknown>) {
  const registry = createDefaultRegistry({ dataDir });
  const planService = createTestPlanService({ workspaceRoot: sandbox, db: ctx.db, registry });
  const permissionRequestStore = new PermissionRequestStore(ctx.db.connection);
  const pausedRunStore = new PausedRunStore(ctx.db.connection);
  const sessionPermissionGrants = new SessionPermissionGrants(ctx.db.connection);
  const { orchestrator } = createTestOrchestrator({
    workspaceRoot: sandbox,
    directChat: {} as never,
    planner: {} as never,
    registry,
    contextManager: ctx,
    tasks: ctx.tasks,
    runs,
    runStateStore,
    notificationQueue: { drain: () => [], listPending: () => [] } as never,
    makeChatFn: () => chat,
    planService,
    projectAllowedPermissions: ALL_PERMISSIONS,
    permissionRequestStore,
    pausedRunStore,
    sessionPermissionGrants,
    runStateStore,
    ...extra,
  });
  return { orchestrator, permissionRequestStore, pausedRunStore, registry };
}

test("resumeAfterPermission 忽略 body.permissionPolicy，沿用快照策略", async () => {
  await fs.writeFile(path.join(sandbox, "resume-target.txt"), "old", "utf-8");
  const { orchestrator, permissionRequestStore, pausedRunStore } = makeOrchestrator(finalChat());
  const session = ctx.createSession("resume-policy");
  const run = runs.create({
    kind: "agent",
    status: "waiting_confirmation",
    goal: "更新文件",
    sessionId: session.id,
  });
  const request = permissionRequestStore.create({
    runId: run.id,
    sessionId: session.id,
    title: "写入文件",
    summary: "需要写 resume-target.txt",
    requiredPermissions: [{ type: "write_file", target: "resume-target.txt", reason: "更新" }],
  });
  permissionRequestStore.respond(request.id, { decision: "allow_once" });

  pausedRunStore.save({
    runId: run.id,
    sessionId: session.id,
    goal: "更新文件",
    messages: [
      { role: "user", content: "更新文件" },
      {
        role: "assistant",
        content:
          '{"action":"tool","tool":"write_file","input":{"path":"resume-target.txt","content":"new"}}',
      },
    ],
    steps: [],
    modelTurns: 1,
    pendingAction: { tool: "write_file", input: { path: "resume-target.txt", content: "new" } },
    mode: "implement",
    permissionPolicy: "confirmBeforeEdit",
    createdAt: new Date().toISOString(),
  });

  const result = await orchestrator.resumeAfterPermission(
    {
      runId: run.id,
      permissionRequestId: request.id,
      permissionPolicy: "autoEdit",
    },
    finalChat(),
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { executionMeta?: { permissionPolicy?: string } };
  assert.equal(body.executionMeta?.permissionPolicy, "confirmBeforeEdit");
});

test("resumeAfterPlanHandoff 忽略 body.permissionPolicy，沿用快照策略", async () => {
  const planHandoffStore = new PlanHandoffStore(ctx.db.connection);
  const { orchestrator, pausedRunStore } = makeOrchestrator(finalChat("计划执行完成"), {
    planHandoffStore,
  });
  const session = ctx.createSession("handoff-policy");
  const run = runs.create({
    kind: "agent",
    status: "waiting_plan_handoff",
    goal: "按计划改 README",
    sessionId: session.id,
  });
  const handoff = planHandoffStore.create({
    runId: run.id,
    sessionId: session.id,
    message: "是否执行计划？",
    planMarkdown: "## 计划\n- 更新 README",
    planVariant: "plan_then_execute",
  });
  planHandoffStore.respond(handoff.id, { decision: "approve" });

  pausedRunStore.save({
    runId: run.id,
    sessionId: session.id,
    goal: "按计划改 README",
    messages: [{ role: "user", content: "按计划改 README" }],
    steps: [],
    modelTurns: 1,
    mode: "plan",
    permissionPolicy: "readOnly",
    resumeMode: "implement",
    createdAt: new Date().toISOString(),
  });

  const result = await orchestrator.resumeAfterPlanHandoff(
    {
      runId: run.id,
      planHandoffId: handoff.id,
      permissionPolicy: "autoEdit",
    },
    finalChat("计划执行完成"),
  );
  assert.equal(result.status, 200);
  const body = result.body as { executionMeta?: { permissionPolicy?: string } };
  assert.equal(body.executionMeta?.permissionPolicy, "readOnly");
});

test("resumeAgent 忽略 body.permissionPolicy，沿用 RunState 策略", async () => {
  const { orchestrator } = makeOrchestrator(finalChat("预算续跑完成"));
  const session = ctx.createSession("budget-resume");
  const run = runs.create({
    kind: "agent",
    status: "running",
    goal: "续跑测试",
    sessionId: session.id,
  });
  runStateStore.save({
    runId: run.id,
    mode: "plan",
    goal: "续跑测试",
    sessionId: session.id,
    status: "resumable",
    completedSteps: [],
    pendingSteps: ["read_file"],
    scannedPaths: [],
    readFiles: [],
    toolResultRefs: [],
    completedToolSteps: [],
    budgetUsage: {
      modelTurns: 1,
      toolCalls: 1,
      readCalls: 1,
      writeCalls: 0,
      shellCalls: 0,
      runtimeMs: 100,
    },
    stopReason: "budget_exhausted",
    permissionPolicy: "confirmBeforeEdit",
    updatedAt: new Date().toISOString(),
  });

  const resumed = await orchestrator.resumeAgent({
    runId: run.id,
    permissionPolicy: "autoEdit",
    budget: { maxReadCalls: 5, maxToolCalls: 5, maxModelTurns: 2 },
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const resumedBody = resumed.body as { executionMeta?: { permissionPolicy?: string }; answer?: string };
  assert.equal(resumedBody.executionMeta?.permissionPolicy, "confirmBeforeEdit");
  assert.match(resumedBody.answer ?? "", /预算续跑完成/);
});

async function main() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "ar-orch-resume-"));
  dataDir = path.join(sandbox, "data");
  await fs.mkdir(dataDir, { recursive: true });
  ctx = new ContextManager({ dataDir, useLanceDb: false });
  runs = new RunStore(ctx.db);
  runStateStore = new RunStateStore(ctx.db);

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}`);
      console.error(error);
    }
  }

  ctx.close();
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);

  console.log(`\norchestrator-resume: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

main();
