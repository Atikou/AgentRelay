# ✅ 已完成：修复 TodoList（架构审阅后续）

> **状态：已全部完成**  
> **完成时间：2026-06-13**  
> **归档位置：`docs/completed/`**（便于整条链路复查）  
> 依据 2026-06-13 系统审阅结论整理并落地。

---

## P0 — 测试与基础设施（阻塞 CI / 开发信心）

- [x] **ToolStorage 目录竞态**：`mkdirSync` 同步创建目录后再打开 SQLite
- [x] **Windows 路径沙箱**：`resolveInsideWorkspaceAsync` 对 workspace root 同步 `realpath`
- [x] **验证**：`npm run test:tools`、`npm run test:plan` 全绿

## P1 — 路由一致性（双轨消除）

- [x] **`/api/agent` 默认 SmartModelRouter**：`createAgentChatFn` + `makeChatFn()` 未指定 `clientName` 时经 Registry 选模型
- [x] **`Planner` 默认 SmartModelRouter**：`createPlannerChatFn`
- [x] **保留 forceClient 路径**：显式 `clientName` 仍走 `ModelRouter.forceClient`
- [x] **测试**：`tests/agent-smart-router.test.ts`、`tests/planner-router.test.ts` + 网页用例
- [x] **文档**：`模型路由升级TodoList.md`、`模型路由与协作.md`、`项目整体架构.md`、`AGENTS.md`

## P2 — 文档与架构图同步

- [x] 架构模块表更新 Agent/Planner Smart 路由说明
- [x] `ModelRouter` vs `SmartModelRouter` 职责边界（`模型路由与协作.md`）

## P3 — 后续能力

- [x] **子 Agent / 无人值守统一 Smart 路由**：`SubAgentCoordinator` 默认 `defaultAgentChat`；无人值守经 `makeChatFn()`
- [x] **模型 token 流式输出**：`ChatRequest.onToken` + OpenAI 兼容 streaming + `/api/agent/stream?streamTokens=true` SSE `token` 事件
- [x] **V3 RouterModelEvaluator 运行时接入**：启发式 V3 + `DecisionEngine` `source=evaluator`
- [x] **启动时恢复**：`recoverOnStartup` 标记悬挂 `running` Run；统计未消费通知；`GET /api/config.startupRecovery`
- [x] **成本预算与运行报告**：`security.budget.maxCostUsdPerRun` + `AgentLoop` 检查；`GET /api/runs/:id/report`

---

## 落地文件索引（复查用）

| 能力 | 主要文件 |
|------|----------|
| 路径沙箱 / ToolStorage | `src/tools/pathSafe.ts`、`src/tools/storage/ToolStorage.ts` |
| Agent/Planner Smart 路由 | `src/model-router/create-smart-single-model-chat.ts`、`create-planner-chat.ts` |
| 子 Agent Smart 路由 | `src/app/createAppContext.ts` |
| V3 评估器 | `src/model-router/router-model-evaluator.ts`、`decision-engine.ts` |
| 启动恢复 | `src/app/startupRecovery.ts` |
| 费用预算 | `src/util/costBudget.ts`、`src/agent/AgentLoop.ts`、`src/config/types.ts` |
| Run 报告 | `src/trace/runReport.ts`、`src/server/handlers/runs.handlers.ts` |
| Token 流式 | `src/model/types.ts`、`OpenAICompatibleClient.ts`、`AgentStream.ts` |

## 自检记录

- `npm run typecheck` 通过
- `npm test` 全量通过
- 网页用例：`m1-agent.json`、`m3-plan.json`、`m5-subagent.json`、`m9-orchestrator.json` 已补充

---

> 原路径 `docs/修复TodoList.md` 已归档至本文件；新任务请新建独立 TodoList 文档。
