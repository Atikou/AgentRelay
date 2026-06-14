# Agent Activity Timeline TodoList

> 依据 `Agent_Activity_Timeline_Implementation_Spec.md` 落地，适配 AgentRelay 现有 Orchestrator / AgentLoop / SSE 架构。  
> **原则**：Timeline 展示 Agent 公开工作记录，不展示模型真实 Chain-of-Thought。

## 阶段一：基础数据结构 ✅

- [x] `AgentRunStatus` / `AgentStepStatus` / `AgentStepType`
- [x] `ActivityAgentRun` / `ActivityAgentStep` / `AgentActivityEvent`（`src/agent/timeline/types.ts`）
- [x] 工具参数脱敏 `sanitizeToolArgs`

## 阶段二：事件总线与持久化 ✅

- [x] `AgentEventBus`：`publish` / `subscribe` / `replay`
- [x] `ActivityRunStore`：`.agent/runs/{runId}/run.json` + `events.jsonl` + `summary.md` + `raw-tool-calls.jsonl`

## 阶段三：TimelineService ✅

- [x] `AgentTimelineService`：`createRun` / `startStep` / `completeStep` / `failStep` / `completeRun` / `failRun` / `cancelRun`
- [x] `mapToolToActivityStep`：工具名 → 公开 step 类型与标题

## 阶段四：AgentLoop 接入 ✅

- [x] 任务开始 → `analysis` step
- [x] 工作流计划 → `plan` step（有 proposal 时）
- [x] 每次工具调用 → start/complete/fail step（含 blocked）
- [x] 最终答案 → `summary` + `run_completed`
- [x] 用户取消 / 预算耗尽 → `run_failed` / `run_cancelled`

## 阶段五：SSE 与 API ✅

- [x] `POST /api/agent/stream` 推送 `activity_event`（与现有 SSE 合并）
- [x] `GET /api/agent/runs/:runId` 读取 `run.json` 快照
- [x] `GET /api/agent/runs/:runId/events` SSE 重放 + 实时订阅（断线重连）

## 阶段六：测试台 Timeline UI ✅

- [x] `createActivityTimelinePanel`（vanilla JS，非 React）
- [x] 步骤图标 / running·success·failed·skipped 状态
- [x] shell / 工具参数可折叠详情
- [x] 默认与「思考过程」面板并存，Activity Timeline 为主展示

## 阶段七：测试与文档 ✅

- [x] `npm run test:activity-timeline`
- [x] `m1-agent.json` 网页用例 ≥2
- [x] `api-spec.json` + `docs/对话循环.md` + `docs/项目整体架构.md`
- [x] `agent-todolist.md` 勾选

## MVP 暂缓（规格 §16）

- [ ] 完整日志清理策略（retention cron）
- [ ] 历史任务搜索 / 高级过滤
- [ ] diff 可视化
- [ ] Timeline 断点恢复执行
- [ ] `POST /api/agent/runs` 独立创建接口（当前复用 `/api/agent/stream` 创建 run）

## 验收对照（规格 §15）

| # | 标准 | MVP |
|---|------|-----|
| 1 | 唯一 AgentRun | ✅ 绑定 orchestrator runId |
| 2 | 关键动作 AgentStep | ✅ 工具 + 分析 + 总结 |
| 3 | 前端实时 Timeline | ✅ activity_event SSE |
| 4 | 多状态展示 | ✅ |
| 5 | 文件/工具/shell/错误 | ✅ |
| 6 | 折叠详情 | ✅ collapsible metadata |
| 7 | 不展示 CoT | ✅ 不用 model thought |
| 8 | 参数脱敏 | ✅ sanitizeToolArgs |
| 9 | summary.md | ✅ |
| 10 | `.agent/runs/{id}` | ✅ |
| 11–12 | 日志清理策略 | 暂缓 |
| 13 | 刷新后历史恢复 | ✅ GET run + events |
| 14 | SSE 重连 | ✅ GET events + Last-Event-ID |
| 15 | Runner 不直接操作 UI | ✅ 仅事件流 |
