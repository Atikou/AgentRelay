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
| P2 | DAG 执行引擎深化 | 未开始 |
| P2 | SubAgent 调度优化 | 未开始 |

---

## P0：Plan Activation Layer（issue §二-1、§四-1）

- [x] `POST /api/plans/:userVisiblePlanId/activate`：compile →（可选 autoApprove）→ execute
- [x] `POST /api/plans/analyze` 支持 `autoActivate` / `confirmedTodoIds` / `executionMode`
- [x] 默认 Todo 选择：优先全部 `P0`，无 P0 时取全部 Todo
- [x] 非 dry-run 且含 write/shell/dangerous 步骤时，无 `autoApprove:true` 停在 `awaiting_approval`
- [x] Chat 会话内「开始执行计划」自然语言触发 activate（须同 session 有 UserVisiblePlan）
- [x] 测试台「计划工作流」一键激活按钮

---

## P1：Agent Loop Execution（issue §二-2、§四-2）

- [x] `executionMode: static | agent_loop`（execute / activate 入参）
- [x] `PlanStepAgentExecutor`：每步委派 `POST /api/agent` `mode=implement` 子运行
- [ ] 步骤失败中途 replan（fallbackToPlanOnUncertainty 与 agent_loop 联动深化）
- [ ] 步骤级预算与父 run 预算汇总

---

## P1：Semantic Tool Compiler（issue §二-3、§四-3）

- [x] `planToolBinder`：write 任务绑定 `write_file` / `apply_patch`，禁止降级为 `read_file`
- [x] `PlanCompiler`：按 Todo 权限推断 `availableTools`
- [ ] 工具 args 经各工具 zod 校验（见分离 TodoList P1）
- [ ] Planner 语义编译失败时的可观测降级指标

---

## P1：Unified Runtime（issue §二-4、§四-4）

- [x] `PlanRuntime` / `PlanActivationWorkflow` 门面
- [x] analyze + `autoActivate` 与 activate API 共用同一运行时
- [x] analyze 响应携带 `nextAction.activate` / `nextAction.compile`
- [ ] Draft Planner（`/api/plans/draft`）与 Workflow 共享 activation 路径

---

## P1：Execution Semantic Layer（issue §二-6）

- [x] Todo → InternalTaskPlan steps（PlanCompiler）
- [x] compile 强制 tool/args（Planner + planToolBinder）
- [x] `task_plan_run_steps` 逐步审计表（memory.db v12）
- [x] `plan.step_started` / `plan.step_completed` / `plan.step_failed` trace

---

## P2：架构升级（issue §五 P2）

- [ ] DAG 执行引擎：同波并行 + 运行时动态插入步骤
- [ ] SubAgent 调度：可配置 timeout、并发上限、本地模型队列背压
- [ ] 全项目「Agent Execution System」级统一 runtime

---

## 相关文件（落地索引）

| 能力 | 路径 |
| --- | --- |
| Plan Activation | `agent-relay/src/plan/PlanActivationWorkflow.ts` |
| Unified Runtime | `agent-relay/src/plan/PlanRuntime.ts` |
| 激活意图检测 | `agent-relay/src/plan/planActivationIntent.ts` |
| Agent Loop 步骤执行 | `agent-relay/src/agent/PlanStepAgentExecutor.ts` |
| 语义绑定 | `agent-relay/src/plan/planToolBinder.ts` |
| HTTP | `agent-relay/src/server/handlers/plan.handlers.ts` |
