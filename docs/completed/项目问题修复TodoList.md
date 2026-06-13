# ✅ 已完成：项目问题修复 TodoList

> **状态：已全部完成**  
> **完成时间：2026-06-14**  
> **归档位置：`docs/completed/`**（便于整条链路复查）  
> 依据当前项目审阅结果整理，按 P0→P2 逐项推进；每次一小块，同步代码、测试、网页用例与文档。

---

## P0：模型路由入口收口

目标：减少旧 `model/ModelRouter` 与新 `SmartModelRouter` 并存造成的行为差异，让不同入口在「任务级选模型」上逐步统一，同时保留指定 `clientName` 时的显式直连能力。

- [x] `POST /api/chat` 未指定 `clientName` 时走 `SmartModelRouter` + `ModelOrchestrator`。
- [x] `Planner` / `/api/plan` / `/api/plans/draft` 默认经 `createPlannerChatFn` 使用 `SmartModelRouter` + `ModelRegistry` 选模型，并强制单模型生成结构化计划。
- [x] `/api/agent` 未指定 `clientName` 时复用 `SmartModelRouter` 做模型选择，但保持 `AgentLoop` 的 ReAct JSON 单模型协议。
- [x] 子 Agent 默认模型选择接入 `SmartModelRouter`，继续保持只读角色边界。
- [x] 文档统一说明：`model/ModelRouter` 负责客户端级连通性 fallback 与显式 `clientName`；`SmartModelRouter` 负责任务级策略、等级与协作决策（见 `docs/模型路由与协作.md` 双轨边界章节）。

## P1：持久化与数据演进

目标：降低 SQLite / JSONL / LanceDB 多存储并存后的维护风险，避免后续表结构变化依赖隐式初始化。

- [x] 为 SQLite 表结构增加显式 schema version 与迁移记录（`schema_migrations` + `PRAGMA user_version`；`memory.db` v7→v8、`tools.db` v1）。
- [x] 为路由、工具、任务、上下文等关键存储补充最小迁移测试（`tests/schema-migration.test.ts`）。
- [x] 梳理并文档化 JSONL 与 SQLite 的边界：哪些是审计流水，哪些是可查询业务状态（见 [数据存储边界](../数据存储边界.md)）。

## P1：安全策略闭环

目标：把现有路径沙箱、ShellPolicy、确认门和脱敏能力组织成更清晰的策略层，方便后续插件、网络工具和子 Agent 写权限复用。

- [x] 定义任务级 / 用户级 / 项目级权限覆盖顺序。
- [x] 为未来网络工具预留域名 allowlist / denylist 策略。
- [x] 给高风险工具输出补充结构化风险字段，便于测试台与审计页统一展示。

## P2：可观测与复盘体验

目标：在已有 trace、routing logs、tool audit 的基础上，把「出了什么事、为什么这么选、怎么复现」做成更连续的调试体验。

- [x] 路由日志查询 API 与测试台「模型路由日志」面板。
- [x] 统一运行报告视图：Run、模型调用、工具调用、fallback、通知与任务状态按时间线展示。
- [x] trace replay 页面补充过滤、导出与问题复现入口。

## P2：评估与自适应路由

目标：在不提前实现完整 V8 自动路由的前提下，逐步接入评估器和运行统计。

- [x] `RouterModelEvaluator` / `AnswerEvaluator` 类型与 stub 预留。
- [x] V3：规则不确定时接入 `RouterModelEvaluator`，只作为建议，不直接覆盖高风险策略。
- [x] V4：将 `AnswerEvaluator` 接入答案质量 fallback。
- [x] V6：RuntimeStats 采集与只读建议 API（`GET /api/routing/stats`）。
- [x] V7：EvalSetRunner 离线评测（`POST /api/routing/eval/run` + `model_eval_results`）。

---

## 落地文件索引（复查用）

| 能力 | 主要文件 |
| --- | --- |
| 双轨路由收口 | `src/model-router/create-smart-single-model-chat.ts`、`create-planner-chat.ts`、`docs/模型路由与协作.md` |
| SQLite 迁移 | `src/storage/sqliteMigration.ts`、`memoryDbMigrations.ts`、`toolsDbMigrations.ts` |
| 数据存储边界文档 | `docs/数据存储边界.md` |
| 权限覆盖顺序 | `src/policy/PermissionPolicy.ts` |
| 域名策略 | `src/policy/NetworkPolicy.ts`、`src/config/types.ts` |
| 结构化工具风险 | `src/policy/ToolRiskAssessment.ts`、`src/tools/ToolRegistry.ts` |
| 路由日志 / 运行报告 | `src/server/handlers/routing.handlers.ts`、`src/trace/runReport.ts`、`src/server/handlers/runs.handlers.ts` |
| trace replay 过滤 | `src/trace/traceQuery.ts`、`src/server/handlers/trace.handlers.ts` |
| V3 路由评估 | `src/model-router/router-model-evaluator.ts`、`decision-engine.ts` |
| V4 答案评估 | `src/model-router/answer-evaluator.ts`、`model-orchestrator.ts` |
| V6 运行统计 | `src/model-router/runtime-stats.ts`、`GET /api/routing/stats` |
| V7 离线评测 | `src/model-router/eval-set-runner.ts`、`eval-set-store.ts`、`eval-set-defaults.ts` |

## 自检记录

- `npm run typecheck` 通过（归档时）
- 专项测试：`test:permission-policy`、`test:network-policy`、`test:tool-risk`、`test:trace-replay`、`test:run-report`、`test:router-evaluators`、`test:answer-evaluator`、`test:runtime-stats`、`test:eval-set-runner`
- 网页用例：`m0-config.json`、`m1-tools.json`、`m2-routing.json`、`m7-security.json`、`m9-orchestrator.json`

---

> 原路径 `docs/项目问题修复TodoList.md` 已归档至本文件；后续路由升级见 `docs/模型路由升级TodoList.md`（V8 前不宜推进完整自动路由）。
