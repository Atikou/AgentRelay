# 计划执行升级 — TodoList

> **来源**：`agent_system_issue_summary.md`（工程级审计）中现有 TodoList **未覆盖**的能力缺口。  
> **关联**：[计划JSON与Markdown分离-TodoList.md](计划JSON与Markdown分离-TodoList.md)、[项目验收清单.md](项目验收清单.md) §0/§3。  
> **验收**：本清单跟踪实现；模块是否验收仍以 `项目验收清单.md` 人类勾选为准。

## 完成度概览

| 优先级 | 主题 | 状态 |
| --- | --- | --- |
| P0 | Plan Activation Layer | 已落地（待人类 E2E） |
| P0 | compile → approve → execute 一键链路 | 已落地 |
| P1 | 计划步骤 Agent Loop 执行（`agent_loop`） | 已落地 |
| P1 | Semantic Tool Compiler 增强 | 部分落地 |
| P1 | Unified Plan Runtime | 已落地 |
| P2 | DAG 执行引擎深化 | 已落地（波次 trace + 动态插步） |
| P2 | SubAgent 调度优化 | 已落地（队列背压 + 配置） |

---

## P0：Plan Activation Layer

- [x] 全部条目（见 git `9495090`）

---

## P1：Agent Loop / Semantic / Unified Runtime

- [x] `executionMode` / `PlanStepAgentExecutor` / activate API
- [x] `planToolBinder` write 路径 / `PlanCompiler` availableTools
- [x] `PlanRuntime` + analyze `autoActivate` + chat 触发
- [x] `task_plan_run_steps` + step trace
- [ ] Draft 路径：`PlanRuntime.activateFromDraft` + `/api/plans/draft?autoActivate`（**P2 已补**）
- [ ] 工具 args zod / 语义编译降级指标（仍属 P1 缺口）

---

## P2：架构升级

- [x] **DAG 编译**：`planDagBuilder` — 同优先级 Todo 并行，低优先级 band 为依赖
- [x] **DAG 执行可观测**：`plan.dag_wave` trace + `groupStepsIntoDagWaves`
- [x] **动态插步**：`TaskRunner.insertSteps` + `buildCorrectionSteps`（`fallbackToPlanOnUncertainty` + `agent_loop`）
- [x] **SubAgent 背压**：`SubAgentLocalQueueGate` + `security.subagent.localModelMaxConcurrent`
- [x] **SubAgent 超时配置**：`security.subagent.defaultTimeoutMs` → `setSubagentDefaultTimeoutMs`
- [x] **`GET /api/subagent/schedule`**：运行中子任务 + 本地队列状态 + 策略快照
- [x] **Draft 统一运行时**：`POST /api/plans/draft` + `autoActivate` 走 `PlanRuntime.activateFromDraft`
- [ ] 全项目 Agent Execution System 级统一 runtime（隐式计划 / 主 Agent 仍独立入口）

---

## 相关文件（落地索引）

| 能力 | 路径 |
| --- | --- |
| DAG 编译 | `agent-relay/src/plan/planDagBuilder.ts` |
| 动态 replan | `agent-relay/src/plan/planReplanOnFailure.ts` |
| SubAgent 背压 | `agent-relay/src/subagent/SubAgentLocalQueueGate.ts` |
| 调度观测 | `GET /api/subagent/schedule` |
| Draft 激活 | `PlanRuntime.activateFromDraft` |
