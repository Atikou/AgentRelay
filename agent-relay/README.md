# AgentRelay

Agent 编排后端（npm 包名 `agent-relay`）：本地优先，支持本地/远程模型路由、工具系统、计划/任务与自主对话循环。后续规划接入桌面端、STT/TTS。

基于 `Agent_TS_实现指南_修订版.md` 与 `agent-todolist.md` 实现。

## 环境要求

- Node.js >= 20（已在 v22 验证）
- npm（仓库未用 pnpm，直接 `npm install` 即可）

## 安装

```bash
cd agent-relay
npm install
```

## 配置

配置位于 `config/`，通过 profile 切换：

- `default.json`：本地 + 远程混合，策略 `local-first`
- `local-only.json`：仅本地模型，策略 `privacy-first`
- `cloud.json`：以远程为主，策略 `cloud-first`

切换 profile：设置环境变量 `AGENT_PROFILE=local-only`。

远程模型的 API Key 通过环境变量提供（见 `.env.example` 的 `apiKeyEnv` 约定），不写入配置文件。

默认 HTTP 端口 **18787**（可用环境变量 `PORT` 覆盖）。

## 常用命令

```bash
npm run typecheck      # 类型检查
npm run dev            # 框架接线自检：加载配置 + 构建模型客户端
npm run models:check   # 探测各模型可用性
npm run models:check -- --chat   # 额外对默认可用模型发一条测试消息
npm run serve          # 后端与测试台 http://localhost:18787，文档站 /docs
npm run docs:screenshots  # 截取测试台界面到 docs/assets（需先 serve）
```

文档站内容来自仓库根 `docs/*.md`，新增 `.md` 即自动出现在 http://localhost:18787/docs 。

## 已实现（对应 todolist 第 1 节）

- [x] 接入本地模型运行时：Ollama（原生 `/api/chat`）、LM Studio / vLLM（OpenAI 兼容端点）
- [x] 接入远程模型服务：OpenAI、DeepSeek 及任意 OpenAI-compatible 服务
- [x] 接入 Anthropic（Claude）原生 `/v1/messages` 协议
- [x] 统一 `ModelClient` 接口，屏蔽厂商差异（请求/响应/工具调用/token 统计）
- [x] 模型可用性探测（启动检查与路由降级的基础）
- [x] 模型路由（自主选择）：local-first / cloud-first / privacy-first / quality-first + 失败降级 + 敏感任务仅本地
- [x] 调用指标：延迟 / token / 失败率 / 成本，并写入 `data/traces/trace.jsonl`

## 已实现（对应 todolist 第 2 节 · Agent 模式）

- [x] 计划模式：模型生成结构化计划（目标/范围/风险/依赖/步骤），只读，自动标注需确认步骤
- [x] 任务模式：`TaskRunner` 状态机（确认门 / 中断 / 重试 / 权限边界）+ `ToolStepExecutor` 真实执行（dry-run 仍保留）
- [x] 模式切换与按模式的权限边界（plan 只读 / task 全集，高风险需确认）

## 已实现（对应 todolist 第 3/10 节 · 工具系统）

- [x] 统一工具协议 `Tool` + `ToolRegistry`（zod 入参校验 / 权限边界 / 超时 / trace / 归一化结果）
- [x] 内置工具：`read_file`、`list_files`、`search_text`（只读）、`write_file`（写）、`shell_run`（命令）
- [x] 安全：路径沙箱（限定工作区内）+ 命令风险分级拦截 + 副作用确认门
- [x] HTTP 接口 `GET /api/tools`、`POST /api/tools/run`、`POST /api/task/run`，测试台「工具系统」面板

## 已实现（对应 todolist M1 · 主对话循环）

- [x] `AgentLoop`：可移植的 ReAct JSON 协议，模型自主决定调用哪个工具、看结果、迭代到最终答案
- [x] 安全：按权限暴露/校验工具、副作用工具需 `autoConfirm`、命令风险拦截、`maxIterations` 防死循环
- [x] HTTP 接口 `POST /api/agent`，测试台「智能体」模式（展示工具调用过程 + 最终回答）

### 验证

```bash
npm test               # 路由 + Agent 模式 + 工具系统 + 对话循环（36 项）
npm run test:loop      # 仅对话循环（工具→最终/迭代上限/限写阻塞，6 项）
npm run serve          # 测试台：对话 / 计划 / 智能体 / 工具系统
```

## 目录结构

```text
agent-relay/                 # 可运行代码（npm 包 agent-relay）
├─ config/
├─ public/
├─ src/
│  ├─ agent/              # AgentLoop / Planner / TaskRunner / ...
│  ├─ model/
│  ├─ tools/
│  ├─ server/
│  └─ ...
└─ tests/
```
