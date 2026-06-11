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
- 模型路由（自主选择）：`model/ModelRouter` 客户端级 fallback；**规则路由** `SmartModelRouter`（`RuleRouter` → `DecisionEngine` → `ModelRegistry` 手动 `routerProfile`）+ **`ModelOrchestrator`**（`single_model` / `local_draft_remote_review`）；`POST /api/chat` 自动路由；路由/调用/协作日志表；`GET /api/models/catalog`。
- 调用指标：`MetricsRegistry`（延迟/token/失败率/成本）+ `TraceLogger`（`data/traces/trace.jsonl`）。
- Agent 模式（todolist 第 2 节）：`Planner` 计划模式（只读生成结构化计划）+ `TaskRunner` 任务模式状态机（确认/中断/重试/`rollbackOnFailure` 回滚/`fallbackToPlanOnUncertainty` 修订计划/权限边界），步骤执行器可插拔。
- 工具系统（todolist 第 3/10 节）：`ToolRegistry` + **11 个第一阶段工具**（`read_file`/`list_files`/`search_text`/`write_file`/`apply_patch`/`diff_file`/`backup_file`/`rollback_change`/`shell_run`/`git_status`/`git_diff`）；`ToolStorage`（备份、changeId、tool_logs）；路径沙箱 + 命令风险拦截 + 确认门。
- M1 主对话循环（todolist 第 11/19 节）：`AgentLoop` 用可移植的 ReAct JSON 协议让模型自主决定工具调用，迭代到最终答案；含权限/确认/迭代上限。接口 `POST /api/agent` 与 SSE `POST /api/agent/stream`（`onStep` 逐步推送），测试台「智能体」模式。
- 文档站：`/docs` 自动渲染 `docs/*.md`（Mermaid + 截图，ChatGPT 配色 + 深色模式）；**API 参考**：`/api-docs`（本地 Scalar + `public/api-spec.json`），说明总览见 `docs/API参考.md`。
- 多 profile 配置、测试台网页（配置 / 可用性 / 调用统计 / 敏感开关 / 对话 / 计划 / 智能体 / **测试用例** / 工具系统）。
- M4 后台任务与通知队列：`BackgroundTaskManager`（spawn/查询/取消）+ `NotificationQueue`（JSONL 持久化）；`AgentLoop` 在安全点消费通知；`/api/background/*`、`/api/notifications/*`；测试台「后台任务」「通知队列」面板。
- M5 子 Agent（只读第一版）：`code_review` / `test_analyze` 角色；`SubAgentRunner` + `SubAgentCoordinator`（并行派生+汇总）；`/api/subagent/*`；测试台「子 Agent」面板。
- M6 上下文压缩与持久化：`ContextManager`（SQLite + FTS5 + LanceDB）；`ContextRestorer` → `ContextPackage`；`SystemSectionBuilder` + `PromptBuilder` 动态注入；`MemoryRetriever` / `SemanticRetriever` 多路检索；`AgentLoop` 默认持久化；`/api/context/*`；测试台「上下文与记忆」面板。
- M7 安全与审计（第一版）：`util/redact` 日志脱敏；`tool_audit` trace；`GET /api/trace/recent|export`；测试台「安全与审计」面板。
- M8 定时与事件触发：`Scheduler`（once/interval/cron/event 含 file_changed、git_changed）；无人值守白名单、`daily_summary` cron；待办队列 UI；`/api/scheduler/*`。
- M7 补强：写文件 `patchPreview`、prompt injection 围栏、`GET /api/trace/replay` 审计回放。
- 集成测试：`tests/integration.test.ts`（任务链路、后台通知注入、子 Agent 并行）。
- 架构重构：`AppContext` + `Orchestrator`（统一 Run/Task）+ `policy/` + `server/handlers/*` 拆分；`GET /api/runs`。
- 自检：`npm test`（全量 **167** 项）。

**未实现**（按里程碑推进）：**V2 FallbackManager**（见 `docs/模型路由升级TodoList.md`）、V3+ 模型自评/回答评估/RuntimeStats、并行投票、子 Agent 写权限/递归、多模态附件/OCR、模型 token 流式输出。

## 关键约定（务必遵守）

- **语言/模块**：TypeScript ESM，导入路径带 `.js` 后缀（NodeNext 风格），严格模式（`strict` + `noUncheckedIndexedAccess`）。
- **分层边界**：`model/` 只负责与模型对话，不掺杂路由、任务、工具执行逻辑。新增能力按 `src/` 现有目录分层。
- **配置**：新增模型走 `config/*.json`，用 zod schema（`src/config/types.ts`）校验。远程 API Key 一律走环境变量（`apiKeyEnv`），**严禁写入配置文件或提交仓库**。
- **密钥安全**：不在代码、日志、提交中出现明文 key。`.env` 已被 gitignore。
- **MVP 纪律**：先保证最小闭环稳定，再扩展；M6 已引入 LanceDB 向量检索（本地优先）；勿提前堆叠多模态知识库、复杂调度（理由见实现指南第 2 节）。
- **安全默认**：高风险操作（删除文件、覆盖配置、安装依赖、`git push`、部署、联网执行脚本）默认需要确认，不可自动执行。
- **验证**：改完代码必须 `npm run typecheck` 通过；涉及模型/网页时用 `npm run models:check` 或 `npm run serve` 自测。
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
- **自审核（强制）**：**每次结束任务前**，对照「是否符合当前框架 / 是否达到预定效果 / 是否缺失某个功能模块」做一次自审核，并写入 `docs/自审核记录.md`：
  - 标题格式：`### 时间_目标_模型_本次任务概括`（时间用 `YYYY-MM-DD HH:mm`）。
  - **写在文件头**（紧跟规范说明、置于旧记录之前），保持最新在上。
  - 正文至少覆盖：改动清单、是否合规、是否达预期、缺失/缺口与后续待办、自检结果。
  - 首次预览项目时必须先浏览该文件。

## 给 agent 的提示

- 不确定时，以 `Agent_TS_实现指南_修订版.md` 为准。
- **改模型路由/协作**时：先读 `docs/模型路由与协作.md`（已实现）与 `docs/模型路由升级TodoList.md`（下一阶段）；按 TodoList **P0 单轮推进**，不要一次性实现 V8 完整自动路由；完成后勾选 TodoList 并更新该文档。
- **任何改动都要同步对应文档**（见「关键约定 · 文档同步」），把它当作 Definition of Done 的一部分。
- **结束任务前必做自审核**并追加到 `docs/自审核记录.md`（见「关键约定 · 自审核」）。
- 添加新功能时，同步更新 `agent-todolist.md`、`public/test-cases/` 对应功能页（≥2 条，含 `purpose`）与 `index.json`（新功能页时），并更新本文件「当前进度」。
- 测试台网页的「规划中」按钮是占位，随对应里程碑落地再点亮。
