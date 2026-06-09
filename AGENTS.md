# AGENTS.md

供任意 AI agent 快速理解本项目的入口文档。先读本文件，**并浏览 `docs/自审核记录.md`**（了解项目演进与已知缺口），再动手。

## 这是什么

**AgentRelay** — 本地优先的 **Agent 编排后端**：模型路由、工具系统、计划/任务与自主对话循环；后续可接入桌面端、STT/TTS。当前处于早期实现阶段。

- 设计目标与全量能力清单：`agent-todolist.md`
- 落地路线（技术选型 + 8 个里程碑 + 代码骨架）：`Agent_TS_实现指南_修订版.md`
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
      ├─ cli/                     # main.ts（自检）、check-models.ts（连通性）
      ├─ config/                  # zod 配置类型 + 加载器
      ├─ model/                   # 模型层：clients / ModelRouter / MetricsRegistry / ModelFactory
      ├─ agent/                   # Agent：AgentLoop(主循环) / Planner / TaskRunner / ToolStepExecutor / permissions / types
      ├─ background/              # M4：BackgroundTaskManager / NotificationQueue
      ├─ tools/                   # 工具系统：ToolRegistry / 文件工具 / shell_run / 风险与路径沙箱
      ├─ trace/                   # TraceLogger（JSONL 事件日志）
      ├─ server/                  # 测试台后端（Node http，无框架）
      ├─ util/                    # 通用工具（env / timeout）
      └─ types/                   # 全局共享类型出口
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
- 模型路由（自主选择）：`ModelRouter` 支持 local-first / cloud-first / privacy-first / quality-first，失败自动降级，sensitive 任务仅本地。
- 调用指标：`MetricsRegistry`（延迟/token/失败率/成本）+ `TraceLogger`（`data/traces/trace.jsonl`）。
- Agent 模式（todolist 第 2 节）：`Planner` 计划模式（只读生成结构化计划）+ `TaskRunner` 任务模式状态机（确认/中断/重试/权限边界），步骤执行器可插拔。
- 工具系统（todolist 第 3/10 节）：`ToolRegistry`（zod 校验/权限边界/超时/trace）+ 内置工具 `read_file`/`list_files`/`search_text`/`write_file`/`shell_run`；路径沙箱 + 命令风险分级拦截 + 确认门；`ToolStepExecutor` 让任务模式真实执行。
- M1 主对话循环（todolist 第 11/19 节）：`AgentLoop` 用可移植的 ReAct JSON 协议让模型自主决定工具调用，迭代到最终答案；含权限/确认/迭代上限。接口 `POST /api/agent`，测试台「智能体」模式。
- 文档站：`/docs` 自动渲染 `docs/*.md`（Mermaid + 截图，ChatGPT 配色 + 深色模式）。
- 多 profile 配置、测试台网页（配置 / 可用性 / 调用统计 / 敏感开关 / 对话 / 计划 / 智能体 / **测试用例** / 工具系统）。
- M4 后台任务与通知队列：`BackgroundTaskManager`（spawn/查询/取消）+ `NotificationQueue`（JSONL 持久化）；`AgentLoop` 在安全点消费通知；`/api/background/*`、`/api/notifications/*`；测试台「后台任务」「通知队列」面板。
- 自检：`npm test`（路由 + Agent 模式 + 工具系统 + 对话循环 + 后台/通知，41 项）。

**未实现**（按里程碑推进，勿提前堆叠）：单任务多模型协作、流式逐步推送、通知去重/合并、定时触发、子 Agent、上下文压缩、安全审计增强。

## 关键约定（务必遵守）

- **语言/模块**：TypeScript ESM，导入路径带 `.js` 后缀（NodeNext 风格），严格模式（`strict` + `noUncheckedIndexedAccess`）。
- **分层边界**：`model/` 只负责与模型对话，不掺杂路由、任务、工具执行逻辑。新增能力按 `src/` 现有目录分层。
- **配置**：新增模型走 `config/*.json`，用 zod schema（`src/config/types.ts`）校验。远程 API Key 一律走环境变量（`apiKeyEnv`），**严禁写入配置文件或提交仓库**。
- **密钥安全**：不在代码、日志、提交中出现明文 key。`.env` 已被 gitignore。
- **MVP 纪律**：先保证最小闭环稳定，再扩展；不要提前引入向量库、子 Agent、复杂调度（理由见实现指南第 2 节）。
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
- **任何改动都要同步对应文档**（见「关键约定 · 文档同步」），把它当作 Definition of Done 的一部分。
- **结束任务前必做自审核**并追加到 `docs/自审核记录.md`（见「关键约定 · 自审核」）。
- 添加新功能时，同步更新 `agent-todolist.md`、`public/test-cases/` 对应功能页（≥2 条，含 `purpose`）与 `index.json`（新功能页时），并更新本文件「当前进度」。
- 测试台网页的「规划中」按钮是占位，随对应里程碑落地再点亮。
