# 完整 Agent 实现 Todolist

## 目标

实现一个可长期运行、可扩展、可观测的完整 Agent 系统，支持本地模型与远程模型协同使用，具备计划、执行、子任务派生、上下文管理、后台命令、通知队列和定时触发能力。

## 1. 模型接入与自主选择

- [x] 接入本地模型运行时，例如 Ollama、LM Studio、vLLM 或本地 OpenAI-compatible 服务。
- [x] 接入远程模型服务，例如 OpenAI、Anthropic、Gemini、DeepSeek 或其他兼容 API。
- [x] 统一模型调用接口，屏蔽不同厂商的请求、响应、流式输出和错误格式差异。
- [x] 支持本地模型和远程模型同时可用。
- [x] 探测本地端点已安装模型目录。（`GET /api/models/catalog`，基于已配置 local 客户端，不自动写 config）
- [x] 记录每次模型调用的延迟、价格、token 用量、失败率和上下文长度。
- [x] 根据任务类型自主选择模型：
  - [x] 低成本简单任务优先使用本地模型。（`RuleRouter` + `ModelRegistry` 等级/成本排序；闲聊/记忆 → Level 1 本地）
  - [x] 复杂推理、长上下文、代码生成优先使用远程强模型。（架构/文档/代码类规则 → Level 2–3 远程；`qualityMode=deep` 倾向协作）
  - [x] 敏感数据任务优先使用本地模型。（sensitive 标志）
  - [x] 远程模型失败或限流时自动降级到本地模型。（fallback）
- [x] 支持模型路由策略配置，例如 local-first、cloud-first、privacy-first、quality-first。
- [x] 支持单任务内多模型协作，例如本地模型草拟、远程模型审查。（`local_draft_remote_review` + `DraftReviewPipeline`；仅保存 finalAnswer）
- [x] 预留 V3/V4 路由/答案评估接口。（`RouterModelEvaluator` / `AnswerEvaluator` stub；当前不接入运行时）

## 2. Agent 模式

- [x] 实现计划模式。
  - [x] 只读分析当前任务、代码、文件和约束。
  - [x] 计划/审阅类项目分析先执行只读 `PlanWorkflow` 预扫描（`project_scan` → `locate_relevant_files` → `context_pack`），减少主循环探索轮次。
  - [x] 输出目标、范围、风险、依赖和执行步骤。
  - [x] 明确哪些步骤需要用户确认。
- [x] 实现任务模式。（控制流 + 工具真实执行 ToolStepExecutor 已就绪）
  - [x] 根据计划执行文件修改、命令运行、测试验证和结果汇报。（步骤绑定 tool 经注册表执行；dry-run 仍保留）
  - [x] 支持任务中断、继续、重试和回滚策略。（`rollbackOnFailure` 显式开启时逆序 `rollback_change`）
- [x] 支持模式切换。
  - [x] 从计划模式进入任务模式。
  - [x] 遇到不确定性时从任务模式回到计划模式。（`fallbackToPlanOnUncertainty` → `modeFallback.revisedPlan`）
  - [x] 支持用户强制切换模式。
- [x] 为不同模式设置不同权限边界。（`RunPolicy`：plan/review 在执行层只读，chat/implement/debug 保持任务权限边界）

## 3. 边界划分与权限控制

- [x] 定义 Agent 可访问资源边界。（`ToolPermission` + 路径沙箱 `resolveInsideWorkspace`）
  - [x] 工作区文件。（read/write 工具限定工作区内）
  - [x] Shell 命令。（shell 权限 + 风险拦截）
  - [x] 网络访问。（network 权限位，已预留）
  - [x] 模型 API。（经模型层/路由统一出口）
  - [ ] 本地数据库或缓存。（暂未引入）
- [x] 定义危险操作审批机制。（高风险权限确认门 + 命令风险分级拦截）
  - [x] 删除文件。（rm/del 归 caution/dangerous）
  - [x] 覆盖配置。（write 工具有副作用，需确认）
  - [x] 安装依赖。（npm install 归 caution）
  - [ ] 执行迁移。（无专门识别，归一般命令）
  - [x] 发布、部署、推送代码。（npm publish / git push --force 归 dangerous 拦截）
- [x] 实现只读模式、受限写模式和完全任务模式。（plan 只读 / `allowedPermissions` 受限 / task 全集）
- [x] 对每次工具调用记录操作日志。（`TraceLogger`）
- [x] 支持按项目、任务、用户配置权限策略。（用户侧 `permissionPolicy` 枚举、`executionMeta` 元信息、策略推导工具权限、`PermissionGuard` 工具前置判定、结构化 `confirmationRequest` 与高风险强制确认清单已落地；项目/角色/用户显式授权仍按交集收窄）

## 4. 计划撰写与任务拆分

- [x] 将用户目标解析为结构化任务说明。（Plan：`goal` + `inputs`/`outputs`/`acceptanceCriteria` + `scope`）
- [x] 识别任务边界、输入、输出和验收标准。（`scope.inScope/outOfScope` + `inputs`/`outputs`/`acceptanceCriteria`）
- [x] 自动拆分主任务为子任务。（`Planner` 提示词要求 ≥2 步；`normalizePlan` + `sortSubtasksByPriority`）
- [x] 为每个子任务生成：
  - [x] 目标。（`PlanStep.objective`）
  - [x] 依赖。（`dependsOn`）
  - [x] 所需上下文。（`requiredContext`）
  - [x] 可用工具。（`availableTools`，缺省时按权限推断）
  - [x] 预期产物。（`expectedArtifacts`）
  - [x] 验证方式。（`acceptance`）
- [x] 支持任务优先级排序。（`priority` + `sortSubtasksByPriority`；持久化到 `task_steps`）
- [x] 支持任务状态流转：pending、in_progress、blocked、completed、failed、cancelled、skipped。（`aggregateTaskStatus` + `TaskStore` 持久化 + `GET /api/tasks/:id`）
- [x] 支持任务失败后的重试、跳过、降级和人工接管。（`TaskRunner.retryFrom/skipStep/confirmStep` + `POST /api/tasks/:id/resume`；降级仍走 `fallbackToPlanOnUncertainty`）
- [x] AgentStepPlan / UserVisiblePlan / InternalTaskPlan 三类计划分离；Executor 仅接受 approved planId + version（`AgentLoop` trace + `PlanStore` + `PlanCompiler` + `PlanValidator`）。

## 5. 子 Agent 派生

- [x] 支持从主 Agent 派生子 Agent。（`/api/subagent/run` / `batch`）
- [x] 子 Agent 拥有独立上下文窗口。（角色 system + 独立 AgentLoop 消息链）
- [x] 子 Agent 可被限制为只读、执行命令、代码审查、测试运行等角色。（第一版：`code_review` / `test_analyze` 仅 read）
- [x] 支持并行派生多个子 Agent。（`SubAgentCoordinator.runBatch`）
- [x] 支持子 Agent 结果汇总、冲突检测和合并。（`aggregate`：共同结论、冲突列表、mergedAnswer；保留 summary）
- [x] 支持子 Agent 超时、取消和失败上报。（超时；显式 cancel 待后续）
- [x] 子 Agent 不能默认继承全部权限，必须显式授予。（`resolveGrantedPermissions`）
- [x] 记录父子 Agent 的任务链路和决策过程。（trace `subagent_start/end` + `parentTaskId`）

## 6. 上下文管理与压缩

- [x] 建立上下文分层：（`SystemSectionBuilder` 动态 sections）
  - [x] 系统规则。（`response_rules` section）
  - [x] 用户目标。（`session_summary` / chunk 摘要）
  - [x] 当前计划。（`current_plan` section：从 `task_steps` 注入步骤标题/状态/依赖）
  - [x] 当前任务状态。（`task_state` section + tasks 表）
  - [x] 文件和代码片段。（`file_snippets` section：从近期 `read_file`/`search_text`/`git_diff` 等 tool 消息解析）
  - [x] 工具调用结果。（`recent_tool_results` 从 session tool 消息注入）
  - [x] 历史决策摘要。
- [x] 支持上下文隔离，避免不同任务互相污染。（scope: global/session/project/task）
- [x] 支持长期记忆与短期上下文分离。
- [x] 实现上下文压缩。
  - [x] 对历史对话生成摘要。
  - [x] 保留关键决策、文件变更和失败原因。
  - [x] 丢弃低价值日志和重复信息。（压缩后 `is_summarized=1`）
- [x] 压缩后支持恢复任务，不从头开始。
- [x] 为上下文片段打标签，便于检索和重组。（`contextTags.ts` 推断标签；`SystemSectionItem.tags` + `ContextPackage.taggedFragments`；向量索引带 tags；`/api/context/search?tags=`）
- [x] 支持向量检索或关键字检索找回历史上下文。

## 7. 后台线程与命令执行

- [x] 支持后台线程执行长时间命令。（`BackgroundTaskManager` + `/api/background/start`）
  - [x] 构建。（任意 shell 命令）
  - [x] 测试。
  - [x] 服务启动。
  - [ ] 数据处理。
  - [ ] 代码生成。
- [x] 每个后台任务独立记录 stdout、stderr、退出码、开始时间和结束时间。
- [x] 支持后台任务状态查询。
- [x] 支持后台任务取消。（Windows `taskkill /T /F`）
- [x] 支持命令超时配置。（`POST /api/background/start` 可选 `timeoutMs`；未设置则不自动超时）
- [x] 支持命令完成后注入通知到主 Agent。（经 `NotificationQueue`）
- [x] 支持命令输出匹配规则，例如错误关键字、服务 ready 日志、测试完成日志。（`outputRules` + `outputMatcher.ts`）
- [x] 支持根据命令结果自动触发下一步任务。（`triggerOnMatch` → `executeUnattendedTrigger`；调度器 `eventFilter.outputPattern`）

## 8. 定时触发与循环任务

- [x] 支持一次性定时任务。（`Scheduler` once）
- [x] 支持周期性任务。（interval）
- [x] 支持 cron 表达式。（croner + `cronMissPolicy`）
- [x] 支持基于事件的触发器：
  - [x] 文件变更。（`file_changed` + FileWatchHub）
  - [x] Git 状态变化。（`git_changed` + GitStatusHub）
  - [ ] CI 状态变化。
  - [x] 后台任务完成。（`background_completed`）
  - [ ] 外部 webhook。
- [x] 支持定时任务的暂停、恢复和取消。（`/api/scheduler/triggers/*`）
- [x] 支持错过执行时间后的补偿策略。（`cronMissPolicy`: skip / run_once）
- [x] 支持同一任务避免重复触发。（debounce + minGap + firing 锁）
- [x] 无人值守 goal 自动执行 Agent。（`unattendedGoalPatterns` → `Orchestrator.executeUnattendedTrigger`）
- [x] 触发时创建 scheduled Run。（非无人值守 `createScheduledRun` pending）

## 9. 通知队列

- [x] 实现线程安全的通知队列。（单进程 `NotificationQueue`）
- [x] 支持通知来源：
  - [x] 后台命令。
  - [ ] 子 Agent。
  - [x] 定时任务。（`source: scheduler`）
  - [ ] 文件监听器。
  - [ ] 外部 API。
- [x] 通知内容包含来源、等级、时间、关联任务和可执行动作。（payload 含 stdout 尾部等）
- [x] 支持通知优先级。（`priority` + 待处理列表排序）
- [x] 支持通知去重。（`dedupeKey` 合并未消费通知）
- [x] 支持通知合并，避免噪音过多。（`mergeKey` 折叠未消费通知，`payload.mergeCount` + `mergedMessages`；测试台 UI 仍只展示合并后条目）
- [x] 主 Agent 在安全点消费通知，而不是打断关键操作。（`AgentLoop` drain）
- [x] 支持通知持久化，进程重启后不丢失。（`data/notifications/*.jsonl`）

## 10. 工具系统

- [x] 定义统一工具调用协议。（`src/tools/types.ts` 的 `Tool` 接口）
- [x] 每个工具声明：
  - [x] 名称。
  - [x] 输入 schema。（zod）
  - [ ] 输出 schema。（当前为 TS 类型，未做运行时输出 schema）
  - [x] 权限需求。
  - [x] 是否有副作用。
  - [x] 超时策略。
- [x] 支持工具执行前校验参数。（注册表 zod safeParse）
- [x] 支持工具执行后结构化解析结果。（归一化 `ToolRunResult`）
- [x] 支持相关文件定位高级工具。（`project_scan` / `locate_relevant_files` / `context_pack`，减少低层探索消耗）
- [x] 支持工具失败分类：用户错误、环境错误、权限错误、临时错误、未知错误。（`ToolErrorCategory`：user/environment/permission/temporary/unknown）
- [x] 支持工具调用审计日志。（`TraceLogger` 记录 start/ok/error）
- [x] 支持 mock 工具，方便测试。（`createMockTool` / `createMockRegistry`：调用记录、静态/动态输出、失败注入）

> 已实现 16 个内置工具：`read_file` / `list_files` / `search_text` / `write_file` / `apply_patch` / `diff_file` / `backup_file` / `rollback_change` / `shell_run` / `git_status` / `git_diff` / `project_scan` / `project_index_update` / `locate_relevant_files` / `symbol_search` / `context_pack`。安全机制：路径沙箱 + 自动备份/changeId/回滚 + 命令风险分级 + 输出限制 + `ToolStorage` tool_logs；相关文件定位结果会汇总到 `executionMeta.location`（含 `exploration` 与 `suggestedAction`）；`ModuleDependencyGraph` + LanceDB `ProjectSemanticIndexer` + `HistoryFileRecaller` 语义/依赖/历史记忆扩展。自检：`npm run test:tools`。

## 11. 状态机与任务编排

- [x] 设计 Agent 主状态机。（`AgentLoop`：模型→解析→工具→回灌→迭代/终止）
- [x] 统一入口下暴露内部意图、工作流与用户侧权限策略元信息，并在测试台展示当前内部处理状态。（`IntentRouter`：`intent` / `modeSource` → `WorkflowRouter`：`workflowType` / 执行器标识 / answer-summarize-search 只读上限 → `RunPolicy`：`permissionPolicy` → `executionMeta` → Agent 结果卡；`RunVerifyWorkflow` 为 run/verify 安全命令先执行与静态降级）
- [x] 设计任务状态机。（`TaskRunner`：pending/running/blocked/completed/failed/cancelled）
- [x] 设计后台线程状态机。（running / completed / failed / cancelled）
- [x] 设计子 Agent 生命周期。（completed/failed/timeout + batch 汇总）
- [x] 支持任务依赖图 DAG。（`TaskRunner` + `taskGraph.ts` 校验环路与 dependsOn）
- [x] 支持并行任务和串行任务混合执行。（同波并行、依赖串行）
- [x] 支持任务阻塞时自动切换到其他可执行任务。（`blocked` 不 halt，`failed` 才停止新波次）
- [x] 防止死循环、自我重复和无限重试。（AgentLoop 分项 `RunBudget`：模型轮次/工具总数/读写 shell/运行时长 + 预算耗尽部分收尾 + `PlanWorkflow` 只读预扫描 + `executionMeta.stopReason`）
- [x] 计划展示与执行分离：AgentStepPlan 只进 trace，用户 Markdown/PublicPlanJson 不可直接执行；须 analyze/compile 或 draft → validate → approve → execute。（`src/plan/`、`SCHEMA_VERSION=6`）

## 12. 记忆与知识库

- [x] 支持项目级记忆。（`memoryType=project_note` + `scope=project`）
- [x] 支持用户偏好记忆。（`memoryType=preference` + `finalizeTurn` 规则抽取）
- [ ] 支持任务经验记忆。（`scope=task` 可用，未专门抽取流水线）
- [x] 对记忆做来源标注和可信度标记。（`source`/`sourceId`/`confidence`/`importance`）
- [x] 支持记忆过期和手动删除。（`expiresAt` + `deactivateMemory`）
- [ ] 避免把临时错误结论写入长期记忆。
- [ ] 支持从代码库、文档和历史对话构建知识索引。

## 13. 安全与隐私

- [x] 敏感信息检测，例如 API key、token、密码、私钥。（`detectSensitiveString` / `hasSensitiveValue`）
- [x] 远程模型调用前过滤或脱敏敏感内容。（`ModelRouter` 调用 remote client 前脱敏 `messages.content`，本地模型保留原文）
- [x] 对命令执行做 allowlist 或 denylist。（`security.shell.denyCommands` / `allowCommands`，`shell_run` 与后台任务共用 `ShellPolicy`）
- [ ] 对网络请求做域名限制。
- [x] 用户确认后才能执行高风险操作。（HTTP 工具入口对 write/apply_patch/shell/network/dangerous 权限启用确认门；dangerous shell 确认后仍由 ShellPolicy 拒绝）
- [x] 日志中避免记录完整密钥和敏感数据。（TraceLogger / trace 查询 / ToolRegistry 审计预览 / ToolStorage.tool_logs / ContextManager 错误 JSONL 脱敏）
- [x] 支持本地优先的隐私模式。（`sensitive=true` / `routing.strategy=privacy-first` 仅本地；SmartModelRouter 与 FallbackManager 继承 `localOnly`）

## 14. 可观测性

- [x] 记录每轮 Agent 决策。（`agent_decision` trace：tool/final/parse_error，含 tool、thought、inputPreview、answerLength）
- [x] 记录模型路由原因。（`model_route_logs` + `GET /api/routing/logs`）
- [x] 提供模型路由调试视图。（测试台「模型路由日志」展示最近决策与 fallback 链详情）
- [x] 记录 token、耗时、费用和错误。（`agent_model_turn` + `run_usage_summary`：token/latency/cost/error/预算用量摘要）
- [x] 记录工具调用链路。（`toolCallId` 贯穿 `agent_decision` / `agent_tool` / `task_step` / `tool_audit`）
- [x] 记录任务状态变化。（`task_status_change` trace：步骤级 from/to + 聚合任务状态计数，附 runId/taskId/sessionId）
- [ ] 提供完整 trace 调试视图或 trace 文件浏览。
- [ ] 支持导出运行报告。
- [ ] 支持问题复盘：为什么选择某模型、为什么执行某命令、为什么任务失败。

## 15. 测试与验证

- [x] 单元测试模型路由。（`tests/router.test.ts` 含策略、降级、taskType）
- [ ] 单元测试任务拆分。
- [ ] 单元测试上下文压缩。
- [x] 单元测试通知队列。（`npm run test:background`）
- [ ] 单元测试权限边界。
- [x] 集成测试完整任务执行链路。（`tests/integration.test.ts`）
- [x] 集成测试后台命令完成后通知注入。（AgentLoop + NotificationQueue）
- [x] 集成测试子 Agent 并行执行和结果汇总。（SubAgentCoordinator.runBatch）
- [ ] 压力测试长上下文、多后台任务和高频通知。
- [ ] 回归测试失败重试、取消和恢复。

## 16. 配置与启动

- [x] 提供统一配置文件。（`config/*.json` + zod）
- [x] 支持环境变量覆盖配置。（`apiKeyEnv` 等）
- [x] 支持多 profile，例如 dev、local-only、cloud、ci。
- [ ] 提供模型配置、权限配置、工具配置和调度配置。（模型/调度/部分 shell 安全策略已进入 zod schema；完整工具/用户权限配置待补）
- [ ] 启动时检查必要依赖。
- [ ] 启动时检查模型可用性。
- [ ] 启动时恢复未完成任务和未消费通知。

## 17. 用户交互

- [ ] 支持自然语言输入任务。
- [ ] 支持展示当前计划。
- [ ] 支持展示任务列表和状态。
- [ ] 支持用户批准、拒绝、修改计划。
- [ ] 支持用户中断当前任务。
- [ ] 支持用户指定模型、模式或权限级别。
- [ ] 支持输出简洁总结和详细运行日志。

## 18. 容易漏掉的补充项

- [ ] 版本化协议：模型接口、工具接口、任务 schema 都要有版本，避免后续升级破坏旧任务。
- [ ] 幂等性设计：重复执行同一任务不会造成重复写入、重复提交或重复部署。
- [ ] 锁机制：防止多个线程同时修改同一文件、同一任务或同一状态文件。
- [ ] 事务或补偿机制：多步骤操作失败后可以恢复到一致状态。
- [ ] 资源限制：限制并发数、内存、CPU、token、费用和磁盘日志大小。
- [ ] 沙箱执行：高风险命令在隔离环境中运行。
- [ ] 人工接管点：Agent 不确定、风险过高或权限不足时主动暂停并请求用户决策。
- [ ] 评估体系：用固定任务集评估模型选择、执行质量和成本。
- [ ] Prompt 管理：系统提示词、工具提示词和任务模板需要版本管理。
- [ ] 结果验收：每个任务必须有 done definition，而不是只看模型是否回答完成。
- [ ] 错误分类与恢复策略：不同错误对应不同处理方式。
- [x] 审计与回放：trace 回放 API + 测试台审计回放面板（过滤、导出、时间线、跳转运行报告）。
- [ ] 多平台兼容：Windows、macOS、Linux 的 shell、路径和权限差异需要处理。
- [ ] 插件系统：后续可以增加新工具、新模型和新触发器。
- [ ] 数据迁移：状态文件、数据库 schema 和记忆存储升级时要有迁移机制。
- [ ] 灰度开关：新能力先在部分任务或 profile 中启用。
- [x] 防 prompt injection：工具只读输出扫描 + `_untrusted` 围栏回灌（第一版）。
- [ ] 成本预算：单任务、单日、单用户设置费用上限。
- [ ] 质量门禁：代码变更后自动运行 lint、test、typecheck 或自定义验证。
- [ ] 最小可用版本 MVP：先做单 Agent、模型路由、任务状态、工具调用、后台任务和通知，再逐步扩展。

## 19. 建议里程碑

- [x] M1：基础 Agent 循环。（`AgentLoop`，ReAct JSON 协议）
  - [x] 用户输入。
  - [x] 模型调用。
  - [x] 工具调用。
  - [x] 简单任务状态。（步骤记录 + 分项运行预算 + reachedLimit + executionMeta）
  - [x] 工具步骤 SSE 流式推送。（`POST /api/agent/stream` + `Orchestrator.runAgentStream`）
- [x] M2：模型路由。
  - [x] 本地和远程模型统一接口。
  - [x] 策略选择。
  - [x] 失败降级。
- [x] M3：计划模式与任务模式。
  - [x] 计划生成。
  - [x] 用户确认。
  - [x] 执行状态追踪。
  - [x] InternalTaskPlan / PublicPlanJson 分离与 PlanStore 审批执行链。
- [x] M4：后台任务和通知队列。
  - [x] 后台命令。
  - [x] 完成通知。
  - [x] 主 Agent 消费通知。
- [x] M5：子 Agent 与上下文隔离。
  - [x] 子 Agent 派生。
  - [x] 独立上下文。
  - [x] 结果汇总。
- [x] M6：上下文压缩和持久化。
  - [x] 历史摘要（chunk/session，超 20 条自动压缩）。
  - [x] 状态恢复（ContextRestorer + SQLite 持久化）。
  - [x] 记忆检索（FTS5 + LanceDB 向量接口）。
- [x] M7：安全、审计和测试。（第一版）
  - [x] 权限控制。（工具 permission + shell denylist，已有）
  - [x] 敏感信息保护。（`redact` + TraceLogger 脱敏）
  - [x] Trace 和回放。（`tool_audit` + `/api/trace/*` 导出）
  - [x] 自动化测试。（`tests/m7-integration.test.ts` 6 项：AgentLoop/TaskRunner + 审计断言）
- [x] M8：定时与事件触发。（第一版）
  - [x] 定时任务（一次性、周期、cron）。（`Scheduler` + croner）
  - [x] 事件触发：后台完成 + 文件变更 + Git。（`background_completed` / `file_changed` / `git_changed`）
  - [x] cron 错过补偿、无人值守白名单、待办队列 UI、`daily_summary` cron。
  - [x] 触发任务仍走权限检查，不绕过确认。（仅写通知队列 + `requiresConfirmation`）
  - [x] 触发器暂停/恢复/取消与 JSONL 持久化。
