# AgentRelay 全链路架构审查 TodoList

> ✅ **已完成** · 完成时间：**2026-06-26** · 全链路审查报告 P0–D 落地与对抗测试。

> 基于全链路审查报告落地。**Phase A–D 已全部完成**。

## Phase A — P0 ✅

- [x] **A1** 历史引用不得无 ledger 标记 `completed_success`
- [x] **A2** 统一 `executeToolStep()` 管道
- [x] **A3** `PausedRunSnapshot.runtimeState`
- [x] **A4** `RunVerifyWorkflow` 在 `confirmBeforeRun` 等策略下不自动 shell

## Phase B — 入口与运行时状态 ✅

- [x] **B1** `RoutingSnapshot` + `effectiveTaskContext`
- [x] **B2** AI `isNewTask` 不再直接 `markInactive`
- [x] **B3** `EffectiveWorkflowContext` + SQLite v22 entry/reconciled + `RunPolicyManager.routeWorkflowType`
- [x] **B4** `task_continuation` 经 `resolveForContinuation`

## Phase C — 体验与可信展示 ✅

- [x] **C1** `budget_exhausted` → Timeline `partialCompleteRun`
- [x] **C2** UI 气泡要求 `trusted` 或 `source=guard`
- [x] **C3** 仅 `completed_success` 保存 `trusted` final
- [x] **C4** 旧 `chunk_summary` 恢复时 scrub + backfill `ui_visible=0`
- [x] **C5** recovery 不计主预算 + `recovery_partial` + Timeline 恢复预算展示

## Phase D — 观测与测试 ✅

- [x] **D1** Legacy 关键词降级为 `LegacyIntentHints` hint extractor
- [x] **D2** Classifier prompt 注入 reconciled/completionStatus/toolLedger
- [x] **D3** `executionMeta` / `RunPolicy` 观测字段扩展
- [x] **D4** `tests/architecture-audit.test.ts` + `npm run test:architecture-audit`
- [x] **D5** OpenAPI `stopReason` / `completionStatus` 枚举同步

## 主要源码

| 能力 | 路径 |
|------|------|
| 统一工具管道 | `agent-relay/src/agent/AgentLoop.ts` → `executeToolStep` |
| Legacy hint | `agent-relay/src/agent/routing/LegacyIntentHints.ts` |
| 决策 enrichment | `agent-relay/src/agent/routing/IntentDecisionEnrichment.ts` |
| 会话 entry/reconciled | `memoryDbMigrations` v22 + `SessionTaskStore.ts` |
| 摘要去污 | `contextTrust.scrubStructuredSummaryContent` |
| 对抗测试 | `agent-relay/tests/architecture-audit.test.ts` |

**归档**：见 [completed/AgentRelay_全链路架构审查-TodoList.md](completed/AgentRelay_全链路架构审查-TodoList.md)
