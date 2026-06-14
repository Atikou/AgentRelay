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
  - [ ] `editWorkflow` / `generateFileWorkflow`：定位文件、生成修改方案、检查权限、执行修改、记录 diff。（真实写入仍由模型常规写工具触发；已具备写后验证与失败修正迭代，后续可继续收敛为更强的工作流闭环。）
  - [x] 首轮前只读预定位：`WorkflowPlanner` 按 intent 选择 `edit_locate` / `generate_file_locate`，`WorkflowExecutor` 通过 `PlanWorkflow` 执行 `locate_relevant_files` → `context_pack`。
  - [x] 写入前方案阶段：`EditProposalWorkflow` 注入 `targetFiles` / `changeSummary` / `permissionCheck` / `diffPlan` / `verificationPlan` 约束，要求模型先形成具体修改方案。
  - [x] 方案阶段可审计记录：`executionMeta.workflowProposals` 返回 `workflowType` / `phase` / `permissionPolicy` / `requiredFields` / `writeAllowedByPolicy` / `requiresConfirmationBeforeWrite`。
  - [x] 接入权限检查结果：`EditProposalWorkflow` 复用 `PermissionGuard` 对 `apply_patch` / `write_file` 做写入前预检，并在 prompt 与 `executionMeta.workflowProposals.permissionChecks` 中记录 `allow` / `needsConfirmation` / `deny`。
  - [x] 记录 diff：`write_file` / `apply_patch` 成功执行后，`AgentLoop` 从工具原始输出汇总 `path` / `changeId` / `beforeHash` / `afterHash` / `diff` 到 `executionMeta.workflowDiffs`。
  - [x] 执行阶段上下文：`EditExecutionWorkflow` 在写工具成功后注入 execution phase，要求下一轮基于真实 diff 做最小验证或最终总结，避免重复写入。
  - [x] 自动读回验证：`EditAutoVerificationWorkflow` 在写工具成功且有目标路径时规划只读 `read_file`，由 `AgentLoop` 通过既有权限、预算与工具链自动读回刚写入文件。
  - [x] 验证阶段上下文与记录：`EditVerificationWorkflow` 观察写入后的 `read_file` / `diff_file` / `shell_run` 等验证工具结果，注入 verification phase，并在 `executionMeta.workflowVerifications` 记录验证工具、状态、错误与输出预览。
  - [x] 验证失败后修正迭代与终止条件：`WorkflowCorrectionWorkflow` 按路径统计 attempt（默认最多 2 轮），注入 correction/termination phase，并在 `executionMeta.workflowCorrections` 记录 `limitReached`。
  - [ ] 将执行修改阶段进一步收敛为 edit/generate-file 工作流闭环（当前写入仍由模型常规写工具触发，并受 PermissionGuard、工具风险与预算约束）。
  - [ ] `debugWorkflow`：报错分析、定位文件、最小修复、验证失败后继续迭代。（修复写入仍由模型常规工具链触发；已共享 WorkflowCorrectionWorkflow 修正轮次与终止条件。）
  - [x] 首轮前只读定位：`WorkflowPlanner` 按 debug intent 选择 `debug_locate`，`WorkflowExecutor` 通过 `PlanWorkflow` 执行 `locate_relevant_files` → `context_pack`。
  - [x] 诊断分析阶段：`DebugAnalysisWorkflow` 注入 `errorSummary` / `suspectedFiles` / `rootCauseHypotheses` / `minimalFixPlan` / `verificationPlan` / `riskAndRollback` 约束，并在 `executionMeta.workflowDebugAnalyses` 返回可审计记录。
  - [x] 验证失败后修正迭代与终止条件：与 edit/generate-file 共用 `WorkflowCorrectionWorkflow`（`debugWorkflow` 类型、`executionMeta.workflowCorrections`）。
  - [ ] 最小修复执行进一步收敛到 debug 工作流闭环（当前仍由模型常规写工具触发）。
- [x] `refactorWorkflow`：强制先计划，分阶段修改，每阶段尽量可验证。
  - [x] 首轮前只读预扫描：`WorkflowPlanner` 选择 `refactor_locate`（`project_scan` → `locate_relevant_files` → `context_pack`）。
  - [x] 强制计划阶段：`RefactorPlanWorkflow` 注入 `scopeSummary` / `affectedModules` / `stagedChanges` / `perStageVerification` / `riskAndRollback`，并在 `executionMeta.workflowRefactorPlans` 返回可审计记录。
  - [x] 分阶段写入后验证：复用 `EditExecutionWorkflow` / `EditAutoVerificationWorkflow` / `EditVerificationWorkflow` / `WorkflowCorrectionWorkflow`（`refactorWorkflow` 类型），要求每阶段验证后再进入下一阶段。
- [x] `runWorkflow` / `verifyWorkflow`：执行安全命令、收集输出、分析结果；无法执行时降级为静态检查并说明。（`RunVerifyWorkflow` 白名单执行 `node --version` / `npm run typecheck` / `npm test` 等安全命令；无匹配命令、无 shell 权限或预算不足时静态降级。）
- [x] `answerWorkflow` / `summarizeWorkflow` / `searchWorkflow`：只读回答、总结、定位，不做副作用操作。

## P3：隐式计划与状态管理

- [x] 复杂任务即使未显式要求计划，也生成内部轻量计划。
  - [x] `ImplicitPlanWorkflow`：复杂副作用任务（edit/debug/generate_file/run/verify）注入 `goalSummary` / `internalSteps` / `successCriteria` / `stopConditions`；`executionMeta.workflowInternalPlans` 记录 `userVisiblePlanMode: false`。
- [x] 内部计划不等于用户可见“计划模式”，只作为执行器稳定完成任务的步骤记录。
  - [x] prompt 与元信息明确 `userVisiblePlanMode: false`，不写入 `/api/plans` 用户计划文档。
- [x] 定义统一任务状态：`idle` / `planning` / `waiting_confirmation` / `executing` / `verifying` / `completed` / `failed` / `cancelled`。
  - [x] `WorkflowTaskState.resolveWorkflowTaskState` 在 `executionMeta.workflowTaskState` 返回；测试台优先展示任务状态标签。
- [x] 扩展 Run/Task 记录：保存 `intent`、`workflowType`、`permissionPolicy`、内部计划、验证结果。
  - [x] `RunState` 续跑快照扩展 `intent` / `workflowType` / `permissionPolicy` / `workflowTaskState` / `workflowInternalPlans` / `workflowSwitch`；`resultJson.executionMeta` 已含验证/修正元信息。
- [x] 支持同一会话中自动切换工作流：问答 → 计划 → 修改 → 验证。
  - [x] `WorkflowSessionSwitch` + `WorkflowSessionStore`：按 `sessionId` 记录上一轮 `intent` / `workflowType` / `workflowTaskState`；新消息意图变化时注入切换上下文，并在 `executionMeta.workflowSwitch` 返回 `from/to` 记录。

## P4：UI 与用户体验

- [x] 默认入口改为“自动模式”，不要求用户理解对话/计划/Agent 三个入口。
  - [x] 测试台主输入区统一走 `handleUnifiedAgent` → `POST /api/agent`；移除对话/计划/智能体三分模式与 `autoConfirm` 勾选。
- [x] UI 上保留权限策略选择：只读、修改前确认、自动修改、命令前确认、自动执行。
  - [x] `#permission-policy-select` 五档策略；选择持久化到 `localStorage`。
- [x] 在消息旁显示当前内部工作流状态，减少黑盒感。
  - [x] 用户消息气泡下附加 `msg-workflow-badge`（`renderWorkflowStatus`）；助手结果卡保留工作流/任务状态标签。
- [x] 保留高级用户显式 mode 参数，用于测试、调试与强制边界。
  - [x] `高级选项` 折叠区提供 `explicit-mode-select`（chat/plan/implement/debug/review）。

## P5：验收与回归

- [x] 每个新工作流至少补 2 条网页用例，覆盖正常路径与权限/安全边界。
  - [x] `m1-agent.json` 覆盖 correction/refactor/implicit-plan/session-switch 等；`m1-auto-workflow-ui.json` 覆盖 P4 UI。
- [x] 每个执行器补单元测试，覆盖 intent 识别、权限判断、工作流分发、失败降级。
  - [x] `workflow-correction-workflow` / `refactor-plan-workflow` / `implicit-plan-workflow` / `workflow-session-switch` / `workflow-executor` / `loop` 已覆盖主路径。
- [x] 更新 OpenAPI、架构文档、对话循环文档和自审核记录。
  - [x] P0–P4 相关文档与 `api-spec.json` 已同步；P2 非阻塞闭环项仍开放。
- [ ] 完成全部条目后归档到 `docs/completed/`，并保留 stub。
  - [ ] 待 P2「更强工作流闭环」子项关闭或明确延期后归档。
