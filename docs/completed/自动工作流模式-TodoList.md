# ✅ 已完成：自动工作流模式 TodoList

> **状态：已全部完成**  
> **完成时间：2026-06-14**  
> **归档位置：`docs/completed/`**  
> 来源：`C:/Users/Administrator/Downloads/Agent 自动工作流模式设计文档.docx`

目标：从“用户手动选择对话/计划/Agent 模式”逐步演进为“一个统一 Agent 入口，系统内部自动识别意图、路由工作流，并由权限策略控制能力边界”。

> **范围说明**：主 Agent 经 `dispatch_subagent` 调度子 Agent 属 M5 子 Agent 专题，不在本清单内；本清单聚焦意图路由、工作流层与测试台统一入口。

## P0：统一入口的可观测意图路由

- [x] 定义内部意图类型：`answer` / `plan` / `edit` / `run` / `debug` / `review` / `verify` / `summarize` / `search` / `refactor` / `generate_file`。
- [x] 定义内部工作流类型：`answerWorkflow` / `planWorkflow` / `editWorkflow` / `runWorkflow` / `debugWorkflow` / `reviewWorkflow` / `verifyWorkflow` / `summarizeWorkflow` / `searchWorkflow` / `refactorWorkflow` / `generateFileWorkflow`。
- [x] 扩展 `IntentRouter.route()`，在保持现有 `mode` 兼容的同时返回 `intent`、`workflowType`、`modeSource`。
- [x] 扩展 `RunPolicy` 与 `executionMeta`，让 `/api/agent` 响应暴露内部意图与工作流元信息。
- [x] 补测试：规则识别、显式 mode 覆盖、`executionMeta` 元信息。
- [x] 测试台展示当前内部处理状态：如“计划生成中 / 正在验证结果 / 正在修改文件”。

## P1：权限策略与工作流解耦

- [x] 引入用户侧权限策略枚举：`readOnly` / `confirmBeforeEdit` / `autoEdit` / `confirmBeforeRun` / `autoRun`。
- [x] 将权限策略与当前 `AgentRunMode` 解耦，避免用 mode 直接决定“能不能改文件/执行命令”。
- [x] 实现 `PermissionGuard`：根据 intent、权限策略、工具风险、用户显式限制给出 allow / needsConfirmation / deny。
- [x] 确认文案结构化：将要做什么、影响哪些文件、是否执行命令、风险、等待用户确认。
- [x] 高风险行为强制确认：删除大量文件、清空目录、提交/推送、上传私有代码、执行未知远程脚本、修改系统环境、安装全局依赖、泄露密钥。

## P2：工作流路由器与分阶段执行

- [x] 新增 `WorkflowRouter`：从 `intent` 映射到具体工作流执行器。
- [x] 将现有内部预扫描、PlanService、TaskRunner、验证命令组织到工作流层，而不是散落在 AgentLoop。
  - [x] 预模型确定性工作流统一进入 `WorkflowExecutor`：`PlanWorkflow` 预扫描与 `RunVerifyWorkflow` 安全命令不再由 `AgentLoop` 直接调度。
  - [x] `PlanService.saveUserVisiblePlan` 进入 `PlanReportWorkflow`：`/api/plans/analyze` 仅负责参数校验与模型选择。
  - [x] `TaskRunner` 继续收敛到工作流层入口：新增 `TaskExecutionWorkflow` 统一封装已审批计划执行与 resume 的 `TaskRunner` / `ToolStepExecutor` / `DryRunExecutor` 装配。
- [x] `planWorkflow` / `editWorkflow` / `debugWorkflow` / `refactorWorkflow` / `runWorkflow` / `verifyWorkflow` / 只读工作流全链路（含 `WorkflowStateCenter`、`WorkflowWriteGate`、proposal/write/verify/correction 闭环）。
- [x] `runWorkflow` / `verifyWorkflow`：`RunVerifyWorkflow` 白名单安全命令 + 静态降级。

## P3：隐式计划与状态管理

- [x] `ImplicitPlanWorkflow` + `WorkflowTaskState` + `RunState` 扩展 + `WorkflowSessionSwitch`。

## P4：UI 与用户体验

- [x] 测试台统一 `handleUnifiedAgent` + `permission-policy-select` + `msg-workflow-badge` + 高级 `explicit-mode-select`。

## P5：验收与回归

- [x] 网页用例：`m1-agent.json`、`m1-auto-workflow-ui.json`。
- [x] 单元测试：`workflow-*` / `loop` / `implicit-plan` 等。
- [x] 文档与 `api-spec.json` 同步；`WorkflowStateCenter` 写入门控补强。
- [x] 归档至 `docs/completed/`，原路径保留 stub。

---

## 落地文件索引（复查用）

| 模块 | 路径 |
| --- | --- |
| 意图路由 | `agent-relay/src/agent/IntentRouter.ts` |
| 工作流路由 | `agent-relay/src/agent/WorkflowRouter.ts` |
| 工作流执行 | `agent-relay/src/agent/WorkflowExecutor.ts` |
| 状态中心 | `agent-relay/src/agent/WorkflowStateCenter.ts` |
| 写入门控 | `agent-relay/src/agent/WorkflowWriteGate.ts` |
| 权限门控 | `agent-relay/src/policy/PermissionGuard.ts` |
| 测试台 UI | `agent-relay/public/app.js` |
| 网页用例 | `public/test-cases/m1-agent.json`、`m1-auto-workflow-ui.json` |

## 自检命令

```bash
npm run test:workflow-executor
npm run test:workflow-state-center
npm run test:loop
npm run test:implicit-plan-workflow
```
