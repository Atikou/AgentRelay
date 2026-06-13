# 项目问题修复 TodoList

> 依据当前项目审阅结果整理，按优先级逐项推进。每次只完成一小块，完成后同步代码测试、网页用例、相关文档与自审核记录。

## P0：模型路由入口收口

目标：减少旧 `model/ModelRouter` 与新 `SmartModelRouter` 并存造成的行为差异，让不同入口在“任务级选模型”上逐步统一，同时保留指定 `clientName` 时的显式直连能力。

- [x] `POST /api/chat` 未指定 `clientName` 时走 `SmartModelRouter` + `ModelOrchestrator`。
- [x] `Planner` / `/api/plan` / `/api/plans/draft` 默认经 `createPlannerChatFn` 使用 `SmartModelRouter` + `ModelRegistry` 选模型，并强制单模型生成结构化计划。
- [x] `/api/agent` 未指定 `clientName` 时复用 `SmartModelRouter` 做模型选择，但保持 `AgentLoop` 的 ReAct JSON 单模型协议。
- [x] 子 Agent 默认模型选择接入 `SmartModelRouter`，继续保持只读角色边界。
- [x] 文档统一说明：`model/ModelRouter` 负责客户端级连通性 fallback 与显式 `clientName`；`SmartModelRouter` 负责任务级策略、等级与协作决策（见 `docs/模型路由与协作.md` 双轨边界章节）。

## P1：持久化与数据演进

目标：降低 SQLite / JSONL / LanceDB 多存储并存后的维护风险，避免后续表结构变化依赖隐式初始化。

- [x] 为 SQLite 表结构增加显式 schema version 与迁移记录（`schema_migrations` + `PRAGMA user_version`；`memory.db` v7、`tools.db` v1）。
- [x] 为路由、工具、任务、上下文等关键存储补充最小迁移测试（`tests/schema-migration.test.ts`）。
- [x] 梳理并文档化 JSONL 与 SQLite 的边界：哪些是审计流水，哪些是可查询业务状态（见 [数据存储边界](数据存储边界.md)）。

## P1：安全策略闭环

目标：把现有路径沙箱、ShellPolicy、确认门和脱敏能力组织成更清晰的策略层，方便后续插件、网络工具和子 Agent 写权限复用。

- [x] 定义任务级 / 用户级 / 项目级权限覆盖顺序。
- [x] 为未来网络工具预留域名 allowlist / denylist 策略。
- [x] 给高风险工具输出补充结构化风险字段，便于测试台与审计页统一展示。

## P2：可观测与复盘体验

目标：在已有 trace、routing logs、tool audit 的基础上，把“出了什么事、为什么这么选、怎么复现”做成更连续的调试体验。

- [x] 路由日志查询 API 与测试台「模型路由日志」面板。
- [x] 统一运行报告视图：Run、模型调用、工具调用、fallback、通知与任务状态按时间线展示。
- [x] trace replay 页面补充过滤、导出与问题复现入口。

## P2：评估与自适应路由

目标：在不提前实现完整 V8 自动路由的前提下，逐步接入评估器和运行统计。

- [x] `RouterModelEvaluator` / `AnswerEvaluator` 类型与 stub 预留。
- [x] V3：规则不确定时接入 `RouterModelEvaluator`，只作为建议，不直接覆盖高风险策略。
- [x] V4：将 `AnswerEvaluator` 接入答案质量 fallback。
- [x] V6：RuntimeStats 采集与只读建议 API（`GET /api/routing/stats`）。
- [ ] V7：EvalSetRunner 运行时（类型已预留，全量评测未启用）。

## 当前推进顺序

1. ~~P0 路由入口收口~~ → **已完成**
2. ~~P1 SQLite schema version + JSONL/SQLite 边界文档~~ → **已完成**
3. ~~P1 安全策略闭环（覆盖顺序 + 域名策略 + 结构化风险）~~ → **已完成**
4. ~~P2 运行报告时间线~~ → **已完成**
5. ~~P2 trace replay 过滤/导出~~ → **已完成**
6. ~~V3 RouterModelEvaluator + V4 AnswerEvaluator 运行时接入~~ → **已完成**
7. ~~V6 RuntimeStats~~ → **已完成**
8. 下一小块建议：V7 EvalSetRunner 离线评测，或其它里程碑项

## 本轮状态

- P0 模型路由入口与文档双轨边界 **已全部收口**。
- P1 安全策略闭环 **已全部完成**。
- P2 运行报告时间线 **已完成**。
- P2 trace replay 过滤/导出 **已完成**。
- P2 V3/V4 评估路由运行时接入 **已完成**。
- P2 V6 RuntimeStats **已完成**；V7 EvalSetRunner 类型已预留。
- 下一小块建议：V7 EvalSetRunner 离线评测。
