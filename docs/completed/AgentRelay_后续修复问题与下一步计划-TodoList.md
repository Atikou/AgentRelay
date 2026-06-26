# AgentRelay 后续修复：统一执行入口与可信事实链

> ✅ **已完成** · 完成时间：**2026-06-26** · 统一 ToolExecutionGateway、FinalGuard/Chat 可信语义、ToolLedger 全路径、预算分层与 tool_result ledger 过滤。

> 基于架构审核落地进度（2026-06-26）。

## Phase A — ToolExecutionGateway ✅

- [x] **A1** 新建 `ToolExecutionGateway`（workflow → PermissionGuard → Budget → registry）
- [x] **A2** `AgentLoop.runToolAction` 经 `invokeRegistry`
- [x] **A3** `RunVerifyWorkflow` / `ToolStepExecutor` / `TaskRollback` / `tools.handlers` 接入
- [x] **A4** `PlanWorkflow` preflight、`subagent/taskContext` 经 Gateway；业务层仅 Gateway 内保留 `registry.run`

## Phase B — ChatService 消息可信度 ✅

- [x] **B1** 纯 chat final 经 `persistChatFinalAnswer` → `saveTrustedModelFinalAnswer`（含副作用声明降权）

## Phase C — FinalGuard 语义拆分 ✅

- [x] **C1** `trustedVisible` / `trustedForMemory` / `visibleAnswer`
- [x] **C2** `accepted` 对齐 `trustedForMemory`；非成功状态不 trusted 记忆

## Phase D — ToolLedger 全路径 ✅

- [x] **D1** `buildExecutionMeta` 每次从 `steps` 构建 `toolLedger` / `toolLedgerSummary`（不依赖 FinalGuard）

## Phase E — 预算分层 ✅

- [x] Gateway `budgetBucket` 字段与 preflight/recovery 记账
- [x] `TaskExecutionWorkflow` 共享 `BudgetManager` 注入 `ToolStepExecutor`

## Phase F — tool_result 可信度 ✅

- [x] `saveToolMessage` 支持 `outcomeClass` / `ledgerBacked` 元数据（memory.db v23）
- [x] `AgentLoop` / `RunVerifyWorkflow` / `PlanWorkflow` 写入 outcome meta
- [x] `ContextRestorer` 经 `MessageRecord.ledgerBacked` 过滤虚假完成声明

## Phase G — UI / Run Report ✅

- [x] **G1** `resolveRunUiStatus` 已优先 `completionStatus` / `stopReason`
- [x] **G2** `accumulateUsage` 按 `toolCallId` 去重计数

## 落地文件索引

| 能力 | 路径 |
|------|------|
| 统一网关 | `agent-relay/src/agent/ToolExecutionGateway.ts` |
| FinalGuard 信任语义 | `agent-relay/src/agent/completion/CompletionFinalGuard.ts` |
| Chat 可信保存 | `agent-relay/src/orchestrator/ChatService.ts` |
| Ledger 全路径 | `agent-relay/src/agent/AgentLoop.ts` + `completion/ToolLedger.ts` |
| Report 去重 | `agent-relay/src/trace/runReport.ts` |
| Plan 预扫描 Gateway | `agent-relay/src/agent/PlanWorkflow.ts` |
| 子 Agent 预读 Gateway | `agent-relay/src/subagent/taskContext.ts` |
| Task 预算共享 | `agent-relay/src/agent/TaskExecutionWorkflow.ts` |
| Tool 结果可信落盘 | `agent-relay/src/context/ContextManager.ts` + `memoryDbMigrations` v23 |
| 上下文过滤 | `agent-relay/src/context/contextTrust.ts` + `ContextRestorer.ts` |

## 自检结论

- `npm run typecheck` ✅
- `npm run test:tool-execution-gateway` 2/2 ✅
- `npx tsx tests/context-trust.test.ts` 7/7 ✅
- `npx tsx tests/schema-migration.test.ts` v23 列断言 ✅（Windows 偶发 EBUSY 清理与本轮无关）
