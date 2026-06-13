# AGENTS.md

供任意 AI agent 快速理解本项目的入口文档。先读本文件，**并浏览 `docs/自审核记录.md`**（了解项目演进与已知缺口），再动手。

## 这是什么

**AgentRelay** — 本地优先的 **Agent 编排后端**：模型路由、工具系统、计划/任务与自主对话循环；后续可接入桌面端、STT/TTS。当前处于早期实现阶段。

- 设计目标与全量能力清单：`agent-todolist.md`
- 落地路线（技术选型 + 8 个里程碑 + 代码骨架）：`Agent_TS_实现指南_修订版.md`
- **模型路由升级待办**（V1→V9 扫描 + 下一阶段 P0/P1）：`docs/模型路由升级TodoList.md`（改 `model-router` / `model-orchestrator` 前必读）
- 可运行代码：`agent-relay/`（npm 包名 `agent-relay`，TypeScript / Node.js）

> 改动前请对照这两份设计文档，保持方向一致；如与文档冲突，应先更新文档再改代码。

## 仓库结构

```text
AgentRelay/
├─ AGENTS.md                      # 本文件
├─ agent-todolist.md              # 全量能力清单（19 节）
├─ Agent_TS_实现指南_修订版.md   # 实现指南（权威落地路线）
├─ docs/                          # 使用/操作说明文档（「项目整体架构」「接入本地模型」），由 /docs 自动渲染
│  ├─ completed/                  # **已全部完成** 的 TodoList 归档（便于整条链路复查）
│  └─ *-TodoList.md               # 进行中的查漏补缺清单（完成后按规范归档）
└─ agent-relay/                     # 实际项目（在此目录运行命令）
   ├─ config/                     # 多 profile 配置：default / local-only / cloud
   ├─ public/                     # 测试台网页（纯静态）
   └─ src/
      ├─ app/                     # AppContext DI 容器
      ├─ core/                    # RunKind、CorrelationContext
      ├─ orchestrator/            # Orchestrator + RunStore（统一 Run）
      ├─ policy/                  # Workspace / Shell / Permission 策略
      ├─ cli/
      ├─ config/
      ├─ model-router/          # SmartModelRouter / 规则路由 / 路由日志
      ├─ model-orchestrator/    # 单模型与草拟+审查流水线
      ├─ model/
      ├─ agent/
      ├─ plan/                    # AgentStepPlan / UserVisiblePlan / InternalTaskPlan / PlanStore / 编译、预览与审批
      ├─ background/
      ├─ scheduler/
      ├─ subagent/
      ├─ context/
      ├─ tools/
      ├─ trace/
      ├─ server/                  # createHttpServer + handlers/*（server.ts 仅入口）
      ├─ util/
      └─ types/
```

## 环境与命令

- Node.js >= 20（已在 v22 验证），包管理用 **npm**（未使用 pnpm）。
- 所有命令在 `agent-relay/` 目录下执行：

```bash
npm install
npm run typecheck      # 类型检查（提交前必跑）
npm run dev            # 框架自检：加载配置 + 列出模型客户端
npm run models:check   # 探测各模型可用性（加 -- --chat 发一条测试消息）
npm run serve          # 启动后端与测试台 http://localhost:18787
```

## 当前进度

**已实现**（todolist 第 1 节大部分）：
- 统一 `ModelClient` 接口，屏蔽厂商差异。
- 本地接入：Ollama（原生 `/api/chat`）、LM Studio / vLLM（OpenAI 兼容端点）。
- 远程接入：OpenAI、DeepSeek 及任意 OpenAI-compatible 服务；Anthropic（Claude）原生 `/v1/messages` 协议。
- 模型路由（自主选择）：`model/ModelRouter` 客户端级 fallback；**规则路由** `SmartModelRouter`（`RuleRouter` → `DecisionEngine` → `ModelRegistry` 手动 `routerProfile`）+ **`ModelOrchestrator`**（`single_model` / `local_draft_remote_review`）；`POST /api/chat` 自动路由；**`Planner` 默认经 SmartModelRouter 选模型**（`createPlannerChatFn`）；路由/调用/协作/fallback 日志表；`GET /api/models/catalog`；`GET /api/routing/logs`；测试台「模型路由日志」面板。
- 调用指标：`MetricsRegistry`（延迟/token/失败率/成本）+ `TraceLogger`（`data/traces/trace.jsonl`）。
- Agent 模式（todolist 第 2 节）：`Planner` 计划模式（只读生成结构化计划）+ `PlanService`/`PlanStore`（AgentStepPlan / UserVisiblePlan / InternalTaskPlan 三类计划分离，`/api/plans/analyze` 生成用户计划文档，`/api/plans/:id/compile` 编译待审批内部计划，审批后执行）+ `TaskRunner` 任务模式状态机（确认/中断/重试/`rollbackOnFailure` 回滚/`fallbackToPlanOnUncertainty` 修订计划/权限边界），步骤执行器可插拔。
- 工具系统（todolist 第 3/10 节）：`ToolRegistry` + **16 个内置工具**（`read_file`/`list_files`/`search_text`/`write_file`/`apply_patch`/`diff_file`/`backup_file`/`rollback_change`/`shell_run`/`git_status`/`git_diff`/`project_scan`/`project_index_update`/`locate_relevant_files`/`symbol_search`/`context_pack`）；`ToolStorage`（备份、changeId、tool_logs）；路径沙箱 + 命令风险拦截 + 确认门；相关文件定位统计进入 `executionMeta.location`（含 `exploration` 与 `suggestedAction: continue_locating`）；`ExplorationProgressTracker` 去重与信息增益；测试辅助 `createMockTool` / `createMockRegistry` 支持 mock 工具。
- M1 主对话循环（todolist 第 11/19 节）：`AgentLoop` 用可移植的 ReAct JSON 协议让模型自主决定工具调用，迭代到最终答案；含 **`RunPolicyManager`**、**`IntentRouter`**（内部 `intent` / `workflowType` 识别 + 模式推断 + 工作流选择 + 用户侧 `permissionPolicy` 策略，工具权限由 `permissionPolicy` 推导而非由 `mode` 直接决定）、**`PermissionGuard`**（工具调用前输出 `allow` / `needsConfirmation` / `deny`，阻塞时生成结构化 `confirmationRequest`；自动策略下仍强制确认删除/清空、提交/推送、未知远程脚本、系统环境、全局依赖、密钥读写等高风险行为）、**`WorkflowPlanner`** + **`PlanWorkflow`** 只读预扫描、**`BudgetManager`** 分项硬限制与建议预算、**`Finalizer`** 预算耗尽部分收尾与复杂度估算、权限/确认、预算耗尽 `executionMeta`；**`RunStateStore`** 续跑（定位状态不重复 scan）；**`ToolResultLayers`** 三层 trace。**默认模型选型经 `createAgentChatFn` → SmartModelRouter**（显式 `clientName` 仍走 ModelRouter）。接口 `POST /api/agent`、`POST /api/agent/resume` 与 SSE `POST /api/agent/stream`，测试台「智能体」模式会展示当前内部处理状态（如计划生成中/正在验证结果/正在修改文件）。
- 文档站：`/docs` 自动渲染 `docs/*.md`（Mermaid + 截图，ChatGPT 配色 + 深色模式）；**API 参考**：`/api-docs`（本地 Scalar + `public/api-spec.json`），说明总览见 `docs/API参考.md`。
- 多 profile 配置、测试台网页（配置 / 可用性 / 调用统计 / 敏感开关 / 对话 / 计划 / 智能体 / **测试用例** / 工具系统）。
- M4 后台任务与通知队列：`BackgroundTaskManager`（spawn/查询/取消/`outputRules`/`triggerOnMatch`）+ `NotificationQueue`（JSONL 持久化）；`AgentLoop` 在安全点消费通知；`/api/background/*`、`/api/notifications/*`；测试台「后台任务」「通知队列」面板。
- M5 子 Agent（只读第一版）：`code_review` / `test_analyze` 角色；`SubAgentRunner` + `SubAgentCoordinator`（并行派生 + 结构化汇总 + 冲突检测）；**默认经 SmartModelRouter 选模型**；`/api/subagent/*`；测试台「子 Agent」面板。
- M6 上下文压缩与持久化：`ContextManager`（SQLite + FTS5 + LanceDB）；**`ProjectIndex`**（`project_files`/`project_symbols`/`project_imports`/`project_exports`）；**`ModuleDependencyGraph`** + **`ProjectSemanticIndexer`** + **`HistoryFileRecaller`** 模块依赖/语义/历史记忆文件召回；**`RunState.location`** 续跑定位上下文；`ContextRestorer` → `ContextPackage`；`SystemSectionBuilder` + `PromptBuilder` 动态注入；`MemoryRetriever` / `SemanticRetriever` 多路检索；`AgentLoop` 默认持久化；`/api/context/*`；测试台「上下文与记忆」面板。
- M7 安全与审计（第一版）：`util/redact` 日志脱敏 + 敏感信息检测；远程模型调用前提示脱敏；`sensitive` / `privacy-first` 本地优先隐私模式；`ToolStorage.tool_logs` 落盘前脱敏；HTTP 工具入口 `highRiskConfirmation` 确认门；`agent_decision` / `agent_model_turn` / `run_usage_summary` / `task_status_change` / `tool_audit` trace；`toolCallId` 串联 `agent_tool` / `task_step` / `tool_audit`；工具失败 `category` 分类；`ShellPolicy` 命令风险 + `security.shell.denyCommands/allowCommands`；`GET /api/trace/recent|export|replay`；测试台「安全与审计」面板。
- M8 定时与事件触发：`Scheduler`（once/interval/cron/event 含 file_changed、git_changed）；无人值守白名单、`daily_summary` cron；待办队列 UI；`/api/scheduler/*`。
- M7 补强：写文件 `patchPreview`、prompt injection 围栏、`GET /api/trace/replay` 审计回放（含 runId/toolCallId/category 过滤、`summary`/`timeline` 导出）。
- 集成测试：`tests/integration.test.ts`（任务链路、后台通知注入、子 Agent 并行）。
- 架构重构：`AppContext` + `Orchestrator`（统一 Run/Task）+ `policy/` + `server/handlers/*` 拆分；`GET /api/runs`；`GET /api/runs/:id/report` 运行报告导出。
- **架构审阅修复（P0–P3，2026-06-13）**：Windows 路径沙箱 / ToolStorage 竞态；全链路 Smart 路由对齐；V3 启发式；启动恢复；费用预算。归档见 `docs/completed/修复TodoList.md`。
- **SQLite 迁移（2026-06-13）**：`schema_migrations` + `PRAGMA user_version`；`memory.db` v8、`tools.db` v1；`GET /api/config.schemaVersions`。
- 自检：`npm test`（全量，含 `tests/plan.test.ts` 计划存储/执行边界 6 项）。

**未实现**（按里程碑推进）：并行投票、子 Agent 写权限/递归、多模态附件/OCR、V9 拖拽编排。

**路由覆盖面（2026-06-13）**：`/api/chat`、`Planner`、`/api/agent`、子 Agent 默认经 `SmartModelRouter`；显式 `clientName` 仍走 `ModelRouter`。

**V3 已落地**：`RouterModelEvaluator` 启发式接入 `DecisionEngine`（`source=evaluator`，高风险不覆盖）；**V4 已落地**：`AnswerEvaluator` 接入 `ModelOrchestrator` 答案质量 fallback；**V5 已落地**：`model-capabilities.ts` 任务能力矩阵 + `GET /api/routing/profiles`；**V6 已落地**：`RuntimeStatsCollector` + `GET /api/routing/stats`；**V7 已落地**：`EvalSetRunner` + `POST /api/routing/eval/run` 离线评测；**V8 P0 已落地**：`ContextAnalyzer` 多信号接入 `DecisionEngine`；**V8 P1 已落地**：`PromptStrategyBuilder` + `estimateRouterContextTokens` 接入 `/api/chat` Smart 路径与 Agent/Planner 路由输入；**V8 P2 已落地**：`RuntimeStatsFeedback` 只读运行指标降权候选（`source=runtime_stats`）；**V8 P3 已落地**：`/api/agent` 响应暴露首轮 `routerDecision` + `promptStrategy` 并应用提示策略；**V8 P4 已落地**：`CostBudgetManager` 成本友好候选排序（`source=cost_budget`）；**V8 P5 已落地**：`ModelProfileStore` 统一 profile 快照 + `reloadFromClients` 热更新（`modelProfileStoreV8`）。

**V2 已落地**：`FallbackManager` + `fallback_logs` + `strong_model_direct` 升级路径；`POST /api/chat` 可回传 `fallbackCount` / `fallbackLogIds`。

## 关键约定（务必遵守）

- **语言/模块**：TypeScript ESM，导入路径带 `.js` 后缀（NodeNext 风格），严格模式（`strict` + `noUncheckedIndexedAccess`）。
- **分层边界**：`model/` 只负责与模型对话，不掺杂路由、任务、工具执行逻辑。新增能力按 `src/` 现有目录分层。
- **配置**：新增模型走 `config/*.json`，用 zod schema（`src/config/types.ts`）校验。远程 API Key 一律走环境变量（`apiKeyEnv`），**严禁写入配置文件或提交仓库**。
- **密钥安全**：不在代码、日志、提交中出现明文 key。`.env` 已被 gitignore。
- **MVP 纪律**：先保证最小闭环稳定，再扩展；M6 已引入 LanceDB 向量检索（本地优先）；勿提前堆叠多模态知识库、复杂调度（理由见实现指南第 2 节）。
- **安全默认**：高风险操作（删除文件、覆盖配置、安装依赖、`git push`、部署、联网执行脚本）默认需要确认，不可自动执行。
- **SQLite 迁移**：`memory.db` / `tools.db` 须经 `src/storage/sqliteMigration.ts` 递增迁移；新增表/列时 bump version 并追加 `memoryDbMigrations.ts` 或 `toolsDbMigrations.ts` 条目，禁止散落 `CREATE TABLE` 而无版本记录。
- **测试用例（强制，双轨）**：每实现一块功能，除 `tests/*.test.ts` 外，必须在对应**功能页 JSON**中 **新增不少于 2 条**网页用例（见 `agent-relay/public/test-cases/`）：
  - **一功能一页**：`index.json` 按里程碑顺序登记；文件如 `m1-tools.json`，**禁止**全部塞进单文件。
  - 每条必填：`id`、`title`、**`purpose`（测试目的）**、`method`、`path`、`input`、`expect`；格式见 `test-cases/SCHEMA.md`。
  - 测试台：侧栏按 M0→M4 进入各功能页；每页底部 **手动输入验证**（自选/自定义 API、运行看结果）；可 **复制单条/复制本页**。
  - 优先覆盖正常路径 + 边界/4xx/安全拦截；详 `docs/测试用例.md`。
- **文档同步（强制）**：**每次变更都必须同步更新对应文档**，与代码在同一次改动内完成，不得拖延。对照清单：
  - 改架构 / 新增模块 / 调整分层或调用链路 → 更新 `docs/项目整体架构.md`（含其中的图与目录树）。
  - 改使用方式 / 配置 / 接入流程 → 更新 `docs/` 下对应专题文档（如「接入本地模型」），新增专题时在 `docs/README.md` 文档列表登记。
  - 改能力进度 → 勾选 `agent-todolist.md`，并更新本文件「当前进度 / 仓库结构」。
  - 设计方向变化 → 先改 `Agent_TS_实现指南_修订版.md` 再改代码。
  - 自检：文档站 `npm run serve` 后访问 `/docs` 确认新增/修改的页面正常渲染。
- **TodoList 归档（强制，清单全部完成后）**：`docs/*-TodoList.md` 一类**任务型查漏补缺清单**，在全部可勾选项落地后必须归档，便于后续按整条链路复查；**不适用**于长期演进文档（`agent-todolist.md`、`Agent_TS_实现指南_修订版.md`、进行中的 `模型路由升级TodoList.md` 等路线图）。
  - **完成判定**：清单内 P0/P1/… 可执行项均已 `[x]`，或用户明确要求「整单结案」；路线图类文档仅当**整份清单宣告结束**时归档，阶段进行中不得提前移动。
  - **归档目录**：`docs/completed/`（禁止把已完成全文留在原路径占侧栏）。
  - **归档正文**（写入 `docs/completed/{原名}.md`）须含：
    - 文首 **✅ 已完成** 标记 + **完成时间**（`YYYY-MM-DD`）+ 一句话来源/目标；
    - 全部条目保持 `[x]` 勾选状态；
    - **落地文件索引**表（能力 → 主要源码路径）；
    - 自检结论（typecheck / 测试 / 网页用例）。
  - **原路径 stub**：`docs/{原名}.md` 仅保留简短跳转，指向 `completed/{原名}.md`（参考现有 `docs/修复TodoList.md`）。
  - **索引同步**（同一次改动内）：更新 `docs/completed/README.md` 登记一行；`docs/README.md` 文档列表改为「已完成归档」链接；若属外部规范扫描清单则更新 `docs/外部规范-TodoList索引.md` 状态列。
  - **自审核**：归档动作写入 `docs/自审核记录.md`，注明归档路径与复查入口。
- **提交与工作区清理（强制）**：实现一个完整功能模块、完成一份任务型 TodoList 归档、或执行清理/归档类任务后，必须在验证通过后 **提交一次 git commit**，并在最终回复给出 commit hash、提交说明、验证结果与 `git status` 状态；保持工作区干净作为 Definition of Done 的一部分。
  - **提交前检查**：至少运行 `npm run typecheck`；涉及代码行为时运行相关专项测试，跨模块或归档整单时运行 `npm test`。
  - **提交范围**：只提交本轮确认完成且相关的源码、测试、文档、测试用例与锁文件；不得把无关用户改动混入提交。若工作区已有无关改动，先说明并与用户确认处理方式。
  - **清理任务同理**：移动/归档/删除/整理文件后，也必须验证、提交，并确认 `git status --short` 干净；禁止用 `git reset --hard`、`git clean -fd` 等破坏性命令替代人工判断。
  - **最终回复**：若已提交，列出提交哈希与摘要；若因测试失败或存在无关改动无法提交，明确说明阻塞原因和当前未提交文件。
- **自审核（强制）**：**每次结束任务前**，对照「是否符合当前框架 / 是否达到预定效果 / 是否缺失某个功能模块」做一次自审核，并写入 `docs/自审核记录.md`：
  - 标题格式：`### 时间_目标_模型_本次任务概括`（时间用 `YYYY-MM-DD HH:mm`）。
  - **写在文件头**（紧跟规范说明、置于旧记录之前），保持最新在上。
  - 正文至少覆盖：改动清单、是否合规、是否达预期、缺失/缺口与后续待办、自检结果。
  - 首次预览项目时必须先浏览该文件。

## 给 agent 的提示

- 不确定时，以 `Agent_TS_实现指南_修订版.md` 为准。
- **改模型路由/协作**时：先读 `docs/模型路由与协作.md`（**双轨路由边界**章节）与 `docs/模型路由升级TodoList.md`（下一阶段）；按 TodoList **P0 单轮推进**，不要一次性实现 V8 完整自动路由；完成后勾选 TodoList 并更新该文档。
- **TodoList 全部完成后**：按「关键约定 · TodoList 归档」移入 `docs/completed/` 并在原路径留 stub；登记 `docs/completed/README.md`。
- **任何改动都要同步对应文档**（见「关键约定 · 文档同步」），把它当作 Definition of Done 的一部分。
- **结束任务前必做自审核**并追加到 `docs/自审核记录.md`（见「关键约定 · 自审核」）。
- 添加新功能时，同步更新 `agent-todolist.md`、`public/test-cases/` 对应功能页（≥2 条，含 `purpose`）与 `index.json`（新功能页时），并更新本文件「当前进度」。
- 测试台网页的「规划中」按钮是占位，随对应里程碑落地再点亮。
