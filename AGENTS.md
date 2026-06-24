# AGENTS.md

供任意 AI agent 快速理解本项目的入口。**动手前先读本文，并浏览 `docs/自审核记录.md` 最新条目**（了解演进与已知缺口）。

## 这是什么

**AgentRelay** — 本地优先的 Agent 编排后端：

- **单一 Agent 入口**：用户表达任务即可；系统通过会话上下文 + 意图路由选择内部工作流
- **模型双轨**：`SmartModelRouter` 选模型；`ModelOrchestrator` 执行单模型或草拟+审查
- **工具与护栏**：17 个内置工具 + `PermissionGuard` / `WorkflowWriteGate` 硬边界
- **计划与执行**：结构化计划 API + 循环内 plan 模式 + `planHandoff` / JIT `permissionRequest`
- **可观测**：Run / Trace / Activity Timeline / `executionMeta`

权威设计说明见：

- [docs/架构设计.md](docs/架构设计.md)
- [docs/执行流程.md](docs/执行流程.md)
- [docs/TodoList.md](docs/TodoList.md)

## 环境与命令

所有命令在 `agent-relay/` 目录执行：

```bash
npm install
npm run typecheck      # 类型检查（提交前必跑）
npm run dev            # 加载配置 + 列出模型客户端
npm run models:check   # 探测模型（加 -- --chat 发测试消息）
npm run serve          # 启动后端与测试台 :18787
npm test               # 全量测试
```

## 源码目录（`agent-relay/src/`）

```text
app/              AppContext DI、启动恢复
orchestrator/     Orchestrator、RunStore、RunStateStore、统一 Run
agent/            AgentLoop、RunPolicy、工作流、入口路由、Timeline
  routing/        EntryIntentRouter、ContinuationDetector、LegacyIntentFallback
  task/           SessionTaskManager、TaskContext
  presentation/   ExecutionStatePresenter（userFacingLabel）
model/            ModelClient、messageBoundary、ModelRouter（显式客户端）
model-router/     SmartModelRouter、规则、DecisionEngine、Fallback
model-orchestrator/  单模型 / 草拟+审查流水线
plan/             三类计划、PlanService、编译/审批/执行
policy/           PermissionGuard、PlanHandoff、PermissionRequest、Shell/Network
tools/            ToolRegistry、沙箱、ToolStorage
context/          ContextManager、ProjectIndex、记忆与向量检索
server/handlers/  HTTP 路由（扁平表，无 Express）
trace/            JSONL 审计
lifecycle/        存储用量、清理 preview/apply
background/       后台任务、通知队列
scheduler/        定时与文件/git 事件
subagent/         dispatch_subagent 后端
```

## 核心原则（必须遵守）

### 1. 架构方向

```text
会话状态 → 意图判断 → 内部工作流 → 权限硬护栏 → AgentLoop → UI 自然状态
```

- **AI 理解意图**；**规则控制安全**（写/删/跑命令不由模型授权）
- `mode`（chat/plan/implement/…）为 **内部/调试字段**；用户侧展示 `userFacingLabel`
- `IntentRouter` 已降级为 `LegacyIntentFallback`，主路径是 `EntryIntentRouter`

### 2. 分层边界

- `model/` 只做厂商对话，不含任务/工具编排
- 导入路径带 `.js` 后缀（NodeNext ESM），`strict` + `noUncheckedIndexedAccess`
- 远程 API Key 仅环境变量 `apiKeyEnv`，**禁止**写入配置或提交仓库

### 3. 安全默认

高风险操作默认需确认：删文件、git push、装全局依赖、未知远程脚本等。`PermissionGuard` 在自动策略下仍强制拦截。

### 4. SQLite 迁移

`memory.db` / `tools.db` 变更必须走 `src/storage/sqliteMigration.ts` 递增版本（当前 memory v17）。禁止无版本记录的散落 `CREATE TABLE`。

### 5. 测试双轨

每块功能除 `tests/*.test.ts` 外，在 `public/test-cases/` 对应页 **新增 ≥2 条**用例：

- 一功能一页 JSON（见 `public/test-cases/index.json`）
- 必填：`id`、`title`、`purpose`、`method`、`path`、`input`、`expect`

### 6. 文档纪律

- 架构/流程/待办变更 → 同步更新 `docs/架构设计.md`、`docs/执行流程.md` 或 `docs/TodoList.md`
- 结束任务前写 `docs/自审核记录.md`（北京时间标题 + Agent 自称，见该文件「写入规范」）
- **仅当用户明确要求时才 git commit**

## 关键 API（Agent 路径）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent` | 统一 Agent 入口 |
| POST | `/api/agent/stream` | SSE：activity + 可选 token |
| POST | `/api/runs/:id/resume-permission` | JIT 工具权限批准后续跑 |
| POST | `/api/runs/:id/resume-plan-handoff` | 计划批准后执行 |
| GET | `/api/plan-handoffs/pending` | 待批准计划交接 |
| GET | `/api/permission-requests/pending` | 待批准工具权限 |

完整列表见测试台 `/api-docs` 或 `public/api-spec.json`。

## 给 agent 的提示

- 改 **模型路由** 前：读 `docs/架构设计.md` 双轨路由章节与 `docs/TodoList.md` 路由待办
- 改 **入口意图** 时：优先 `EntryIntentRouter` / `SessionTaskManager`，不要往 `IntentRouter` 堆关键词
- 计划审批 vs 工具权限：**planHandoff** 与 **permissionRequest** 分离，勿混用语义
- 不确定时以代码与 `docs/架构设计.md` 为准，勿恢复已删除的旧 TodoList 文档
