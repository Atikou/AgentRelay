# 自动工作流模式 TodoList

来源：`C:/Users/Administrator/Downloads/Agent 自动工作流模式设计文档.docx`

目标：从“用户手动选择对话/计划/Agent 模式”逐步演进为“一个统一 Agent 入口，系统内部自动识别意图、路由工作流，并由权限策略控制能力边界”。

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
- [x] `planWorkflow`：生成内部计划 JSON 与用户可读 Markdown 计划，不直接执行。
  - [x] 用户可读 Markdown 计划通过 `PlanReportWorkflow` 生成并保存为 `UserVisiblePlan`，不可直接执行。
  - [x] 内部计划 JSON 通过 `PlanCompileWorkflow` 从已确认 Todo 编译为 awaiting_approval `InternalTaskPlan` 草案，仍需 approve 后 execute。
- [ ] `editWorkflow` / `generateFileWorkflow`：定位文件、生成修改方案、检查权限、执行修改、记录 diff。
- [ ] `debugWorkflow`：报错分析、定位文件、最小修复、验证失败后继续迭代。
- [ ] `refactorWorkflow`：强制先计划，分阶段修改，每阶段尽量可验证。
- [x] `runWorkflow` / `verifyWorkflow`：执行安全命令、收集输出、分析结果；无法执行时降级为静态检查并说明。（`RunVerifyWorkflow` 白名单执行 `node --version` / `npm run typecheck` / `npm test` 等安全命令；无匹配命令、无 shell 权限或预算不足时静态降级。）
- [x] `answerWorkflow` / `summarizeWorkflow` / `searchWorkflow`：只读回答、总结、定位，不做副作用操作。

## P3：隐式计划与状态管理

- [ ] 复杂任务即使未显式要求计划，也生成内部轻量计划。
- [ ] 内部计划不等于用户可见“计划模式”，只作为执行器稳定完成任务的步骤记录。
- [ ] 定义统一任务状态：`idle` / `planning` / `waiting_confirmation` / `executing` / `verifying` / `completed` / `failed` / `cancelled`。
- [ ] 扩展 Run/Task 记录：保存 `intent`、`workflowType`、`permissionPolicy`、内部计划、验证结果。
- [ ] 支持同一会话中自动切换工作流：问答 → 计划 → 修改 → 验证。

## P4：UI 与用户体验

- [ ] 默认入口改为“自动模式”，不要求用户理解对话/计划/Agent 三个入口。
- [ ] UI 上保留权限策略选择：只读、修改前确认、自动修改、命令前确认、自动执行。
- [ ] 在消息旁显示当前内部工作流状态，减少黑盒感。
- [ ] 保留高级用户显式 mode 参数，用于测试、调试与强制边界。

## P5：验收与回归

- [ ] 每个新工作流至少补 2 条网页用例，覆盖正常路径与权限/安全边界。
- [ ] 每个执行器补单元测试，覆盖 intent 识别、权限判断、工作流分发、失败降级。
- [ ] 更新 OpenAPI、架构文档、对话循环文档和自审核记录。
- [ ] 完成全部条目后归档到 `docs/completed/`，并保留 stub。
