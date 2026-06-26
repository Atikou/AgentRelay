# TodoList

项目路线图、进行中的架构迁移与验收清单。**实现进度以此为准**；勾选验收仅人类执行（见 §验收清单）。

---

## 一、架构纠偏（当前主线）

> 方向：**上下文驱动的 Agent 执行系统**，而非关键词 mode 机。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 会话连续性：`TaskContext`、`SessionTaskManager`、`EntryIntentRouter` | [x] |
| P1 | `planHandoff` 与 `permissionRequest` 分离 | [x] |
| P2 | `AIIntentClassifier` 结构化意图 + 双轨 diff 日志 | [x] |
| P3 | `LegacyIntentFallback` 仅兜底，缩小关键词主路径 | [x] |
| P4 | UI 完全隐藏 mode，仅 `userFacingLabel` + 权限策略 | [x] |
| P5 | 收敛 `mode` / `intent` / `workflowType` 词汇 | [ ] |
| P6 | 清理遗留路由规则与重复正则 | [ ] |

### P0 验收（会话连续性）

| 场景 | 预期 |
| --- | --- |
| 上轮 edit，粘贴工具失败输出 | 继续 edit，不掉 chat |
| 上轮失败，补充日志 | 延续原任务 |
| 上轮 plan，「继续」 | 走 planHandoff，不自动 execute |
| 上轮 implement，「再好看壮观一点」 | task_continuation → edit |
| 「换个问题」 | 新任务 |
| 活跃任务 + 模糊输入 | 不因 answer fallback 只读化 |

### P2 待办（AI 意图）

- [x] 模型输出 JSON：`intent`、`isContinuation`、`isNewTask`、`confidence`
- [x] 与 legacy 并行记录差异（`recordIntentClassifierDiff` / `getLastIntentClassifierDiff`）
- [x] 超时/低置信 → fallback
- [x] **禁止** AI 输出权限授权结论

### P4 待办（UI）

- [x] 默认隐藏 `explicit-mode-select`（`?dev=1` 可见）
- [x] 详情区折叠内部字段（非 dev 仅显示等待/权限）
- [x] `m1-agent.json` 增补连续性用例（文档 + contextTrust 恢复预览）

---

## 二、能力里程碑

### M0 基础

- [x] 配置多 profile、测试台、文档站 `/docs`
- [x] `ModelClient` 统一接口（Ollama / OpenAI 兼容 / Anthropic）
- [x] SQLite 版本迁移框架

### M1 Agent 循环

- [x] `AgentLoop` ReAct JSON 协议
- [x] `ToolRegistry` 17 内置工具
- [x] `RunPolicy` + 分项预算 + `Finalizer`
- [x] 自动工作流（edit/debug/plan/verify…）
- [x] `WorkflowWriteGate` + 写后验证闭环
- [x] `POST /api/agent` + SSE stream + cancel
- [x] Activity Timeline
- [x] 入口架构纠偏 P0/P1

### M2 模型路由

- [x] `SmartModelRouter` + 规则 + DecisionEngine
- [x] `FallbackManager`、路由/调用/协作日志
- [x] V3–V8 部分（evaluator、prompt strategy、cost、availability…）
- [x] V9 路由管线可视化（`pipelineGraph` + 测试台面板）
- [x] 并行投票（`parallel_vote` + deep 模式架构/文档类任务）

### M3 计划与任务

- [x] 三类计划分离
- [x] Plan analyze / compile / approve / execute API
- [x] `TaskRunner` 状态机 + resume
- [x] planHandoff（循环内 plan → execute）
- [ ] 计划模型进一步收敛（退役遗留 `Plan` 转换）

### M4 后台与通知

- [x] `BackgroundTaskManager` + `NotificationQueue`
- [x] Agent 安全点消费通知

### M5 子 Agent

- [x] `dispatch_subagent` + `DelegatedTask`
- [x] Smart 路由子 Agent
- [ ] 子 Agent 动态路由增强（按需）

### M6 上下文与记忆

- [x] `ContextManager` + FTS5 + LanceDB
- [x] `ProjectIndex` / 语义召回 / `RunState.location`
- [x] 上下文去污：`contextTrust` + `RunFactsLookup` + `ContextRestorer` 过滤/纠偏 + 记忆 `trustLevel`
- [ ] 上下文层与 agent 格式化彻底解耦

### M7 安全与审计

- [x] 脱敏、Shell 风险、trace 回放
- [x] JIT 权限 + 会话 grant 持久化
- [ ] trace 段 gzip

### M8 调度

- [x] Scheduler cron/interval/event
- [ ] scheduler journal 与 lifecycle purge 关联

### 未开始 / 远期

- [ ] 多模态附件 / OCR
- [ ] policy 在线编辑 UI
- [ ] 桌面端 / STT / TTS 接入

---

## 三、代码质量与重构

| 项 | 状态 |
| --- | --- |
| 拆分 `AgentLoop` god-object | [ ] |
| `RunPolicyManager` 职责拆分（预算 vs 展示） | [ ] |
| 合并 `IntentRouter` / `WorkflowPlanner` 重复正则 | [ ] |
| 退役遗留 `AgentMode plan\|task` 词汇 | [ ] |
| `locationTools` 项目专属启发式外置 | [ ] |
| `api-spec.json` 与 handler 自动同步 | [~] |

---

## 四、测试要求

每功能模块：

1. `tests/*.test.ts` 单元/集成测试
2. `public/test-cases/{feature}.json` ≥2 条（含 `purpose`）

```bash
npm run typecheck
npm test
```

常用专项：`test:entry-intent-router`、`test:plan-handoff`、`test:loop`。

---

## 五、验收清单（仅人类勾选）

> **模块是否可验收以本节为准**；TodoList 的 `[x]` 不代表验收通过。

### 总闭环

- [ ] 测试台可完成：提问 → 计划 → 批准 → 改文件 → 确认 → 验证
- [ ] 服务重启后 permission / planHandoff 可恢复
- [ ] 会话内粘贴失败日志不掉进只读 chat

### 大模块

- [ ] **Agent 模式**：统一入口、流式、取消、续跑、Timeline
- [ ] **计划模式**：只读分析、planHandoff、不越权执行
- [ ] **工具系统**：沙箱、确认门、审计、回滚
- [ ] **模型路由**：本地+远程、fallback、日志可查
- [ ] **上下文**：会话持久化、压缩、项目索引
- [ ] **安全**：高风险默认确认、脱敏、trace 回放
- [ ] **子 Agent**：并行派生、结果回收
- [ ] **后台/调度**：任务与 cron 可观测

### 架构纠偏（产品体验）

- [ ] 用户无需理解 chat/plan/implement/debug
- [ ] 主界面展示自然状态（非 mode 字符串）
- [ ] 计划批准与工具授权 UI 语义分离

---

## 六、文档维护

| 变更类型 | 更新 |
| --- | --- |
| 架构/模块 | `docs/架构设计.md` |
| 链路/协议 | `docs/执行流程.md` |
| 进度/验收 | 本文 |
| 自审 | `docs/自审核记录.md`（保留历史） |
| Agent 约定 | `AGENTS.md` |

---

## 七、落地文件索引（纠偏相关）

| 能力 | 路径 |
| --- | --- |
| 入口路由 | `agent/routing/EntryIntentRouter.ts` |
| 会话任务 | `agent/task/SessionTaskManager.ts` |
| 延续检测 | `agent/routing/ContinuationDetector.ts` |
| UI 状态 | `agent/presentation/ExecutionStatePresenter.ts` |
| 计划交接 | `policy/PlanHandoffStore.ts` |
| JIT 权限 | `policy/PermissionRequestStore.ts`、`agent/PausedRunStore.ts` |
| 主循环 | `agent/AgentLoop.ts` |
| HTTP 入口 | `orchestrator/Orchestrator.ts` |
