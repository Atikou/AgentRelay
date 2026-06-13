# Model Router Upgrade TodoList

> 依据 `Agent_Model_Router_Auto_Upgrade_Roadmap.md` 对当前仓库扫描生成。  
> **关联索引**：[外部规范-TodoList索引](外部规范-TodoList索引.md)  
> **当前阶段：V8 P3 Agent promptStrategy 暴露已落地 → 继续 CostBudget 等收尾，勿一次性做完 V8。**  
> 推进模型路由相关改动前，请先读 [模型路由与协作](模型路由与协作.md) 了解已实现能力；**不要一次性实现完整自动路由（V8）**。

---

## 当前项目完成度

### 阶段判定

**V2 FallbackManager 核心已完成** → 下一目标 **V8 完整自动路由**（V3–V7 已落地）

### 关键词扫描（`agent-relay/src`）

| 模块/能力 | 状态 | 位置 |
|-----------|------|------|
| ModelRegistry | ✅ | `model-router/model-registry.ts` |
| ModelProfile | ✅（简化结构） | `model-router/model-profiles.ts` + `config.routerProfile` |
| RuleRouter | ✅ | `model-router/route-rules.ts` |
| DecisionEngine | ✅ | `model-router/decision-engine.ts` |
| SmartModelRouter | ✅ | `model-router/smart-model-router.ts` |
| ModelOrchestrator | ✅ | `model-orchestrator/model-orchestrator.ts` |
| SingleModelPipeline | ✅ | `model-orchestrator/pipelines/single-model-pipeline.ts` |
| DraftReviewPipeline | ✅ | `model-orchestrator/pipelines/draft-review-pipeline.ts` |
| RouteLogStore | ✅ | `model_route_logs` |
| ModelCallLogStore | ✅ | `model_call_logs` |
| CollaborationRunStore | ✅ | `model_collaboration_runs` |
| `local_draft_remote_review` | ✅ | 类型 + 流水线 + 测试 |
| `single_model` | ✅ | 已接入 |
| `rule_only` | ✅ | Level 0 短问候规则直答（`rule-only-responses.ts` + `runRuleOnlyPipeline`） |
| FallbackManager | ✅ | `model-router/fallback-manager.ts` |
| FallbackLogStore / `fallback_logs` | ✅ | `route-stores.ts` |
| `strong_model_direct` | ✅ | V2 fallback 升级策略 |
| AnswerEvaluator | ✅ | V4 规则版已接入 `ModelOrchestrator` fallback |
| RouterModelEvaluator | ✅ | V3 启发式已接入 `DecisionEngine`（高风险不覆盖） |
| ContextAnalyzer | ✅ | `context-analyzer.ts`；V8 P0 多信号接入 DecisionEngine |
| PromptStrategyBuilder | [~] | `prompt-strategy-builder.ts`；V8 P1 接入 Orchestrator `/api/chat` |
| RuntimeStatsFeedback | ✅ | `runtime-stats-feedback.ts`；V8 P2 候选降权（不改配置） |
| RuntimeStats / EvalSetRunner | ✅ | V6/V7 已落地 |
| 拖拽编排 (V9) | ❌ | 终局可选 |

### V1 验收对照

| 验收项 | 状态 |
|--------|------|
| 加载模型配置 | ✅ |
| 规则判断任务类型 | ✅ `tests/smart-router.test.ts`（10 项） |
| 单模型回答 | ✅ |
| 本地草拟 + 远程审查 | ✅ `tests/draft-review.test.ts`（4 项） |
| draft/review 不污染 messages | ✅ |
| finalAnswer 正确保存 | ✅ |
| route/call 日志 | ✅ 写库；✅ `GET /api/routing/logs`；✅ 测试台「模型路由日志」面板 |

### V1 已知缺口（V2 前或并行收尾）

1. ~~**双轨路由覆盖面**~~ → **已统一**（见 [模型路由与协作 · 双轨边界](模型路由与协作.md#双轨路由边界必读)）：`/api/chat`、`Planner`、`/api/agent`、子 Agent 默认 Smart；显式 `clientName` 仍走 `ModelRouter`
2. **`strong_model_direct` 已作为 V2 fallback 升级策略落地**
3. **`validateModelProfiles` 已在启动时 warn**
4. ~~协作内降级分散~~ → **已迁入 FallbackManager + `fallback_logs`**
5. **路由审计 HTTP 已落地**：`GET /api/routing/logs` 提供只读查询
6. ~~旧 `ModelRouter` 与 Smart 语义未文档化~~ → **已统一**（同上双轨边界章节）

### 测试现状

- `tests/smart-router.test.ts` — 12 项
- `tests/rule-only.test.ts` — 5 项
- `tests/draft-review.test.ts` — 4 项
- `tests/router.test.ts` — 13 项（客户端级 fallback）
- 全量 `npm test` — 通过（含 plan 6、orchestrator 12、smart-router 10、draft-review 4 等）

---

## 当前建议升级阶段

**V2：FallbackManager** ✅ 核心已完成

下一步：**V3 RouterModelEvaluator** 或 P1 路由覆盖面扩展。

升级路线图概览：

| 阶段 | 名称 | 状态 |
|------|------|------|
| V1 | 规则路由 + 手动配置 | ✅ 基本完成 |
| V2 | FallbackManager | ✅ 核心完成 |
| V3 | RouterModelEvaluator | ✅ 启发式 + 高风险不覆盖 |
| V4 | AnswerEvaluator | ✅ 规则版 fallback |
| V5 | ModelProfile 能力矩阵 | ✅ |
| V6 | RuntimeStats | ✅ 只读建议 API |
| V7 | EvalSetRunner | ✅ 离线评测 API |
| V8 | 完整自动路由 | [~] P0–P2 已接入；Agent promptStrategy 暴露待续 |
| V9 | 拖拽式可视化编排 | 终局可选 |

---

## TodoList

### P0：V2 核心 — FallbackManager ✅

- [x] 新增 `src/model-router/fallback-manager.ts`
  - [x] `FallbackTrigger`：`model_timeout` / `model_error` / `empty_output` / `json_parse_failed` / `review_rejected` / `review_failed` / `answer_too_short`
  - [x] `FallbackPlan`：`fromModelId`、`toModelId`、`fromStrategy`、`toStrategy`、`maxAttempts`
  - [x] 升级路径（L1→L2→L3；`local_draft_remote_review` → `strong_model_direct`）
  - [x] **硬限制**：`MAX_FALLBACKS_PER_REQUEST = 2`
- [x] 新增 `fallback_logs` 表 + `FallbackLogStore`
- [x] `DraftReviewPipeline` 内 catch/降级迁入 FallbackManager
- [x] `SingleModelPipeline` + `ModelOrchestrator`：失败/空输出/过短答案 → fallback
- [x] `ModelOrchestrator.run()` 统一 fallback 编排入口
- [x] `OrchestratorResult` + `/api/chat` 响应增加 `fallbackCount`、`fallbackLogIds`

### P0：V1 收尾（与 V2 并行，范围要小）

- [x] 启动时调用 `validateModelProfiles()` 并警告（`createAppContext` / `npm run serve`）
- [x] **`strong_model_direct`** 作为 V2 fallback 升级策略（非 RuleRouter 默认出口）
- [x] 更新 [模型路由与协作](模型路由与协作.md) 标明 V1/V2 边界

### P1：V2 增强与可观测

- [x] `GET /api/routing/logs`（route/call/collaboration/fallback 只读查询）
- [x] 测试台「模型路由」面板（最近决策与 fallback 链）
- [x] `public/test-cases/m2-routing.json` 增加 V2 场景用例
- [x] `tests/fallback-manager.test.ts`（8 条）

### P1：路由覆盖面扩展（V1.x，不碰 V8 自动路由）

- [x] `Planner` 经 Registry 选模型（替代硬编码 `taskType: reasoning`；`createPlannerChatFn` + `forceSingleModel`）
- [x] 评估 `/api/agent` 未指定 `clientName` 时复用 SmartModelRouter（`createAgentChatFn` + `forceSingleModel`）
- [x] 文档统一：`model/ModelRouter` = 连通性 fallback + forceClient；`SmartModelRouter` = 任务级策略（见 `docs/模型路由与协作.md` **双轨路由边界**）

### P2：为 V3/V4 预留接口（类型 + stub，不调用）

- [x] `router-model-evaluator.ts` — `RouterModelEvaluation` + stub
- [x] `answer-evaluator.ts` — `AnswerEvaluation` + 规则版 stub
- [x] `DecisionEngine` / `ModelOrchestrator` 注释扩展点

### P0：V8 分步（勿一次性做完）

- [x] `ContextAnalyzer` + `applyRoutingContext`（复杂度/压力/等级 bump/协作建议）
- [x] `DecisionEngine` 多信号 + 无候选安全回退
- [x] `RouterDecision.contextSignals` + reason `V8 上下文`
- [x] `PromptStrategyBuilder` + `applyPromptStrategyToSystemText`（温度/风格/system 补充）
- [x] `estimateRouterContextTokens` 统一 token 估计（Orchestrator / Agent / Planner）
- [x] `/api/chat` Smart 路径应用 `promptStrategy` 并回传 `routerDecision.promptStrategy`
- [x] `RuntimeStatsFeedback` 只读反馈影响候选排序（`source=runtime_stats`，不改配置）
- [x] Agent `/api/agent` 响应暴露 `routerDecision` + `promptStrategy`（首轮 Smart 路由）

### P2：后续阶段（本清单阶段不做）

- [x] V3 RouterModelEvaluator 运行时接入（高风险不覆盖）
- [x] V4 AnswerEvaluator 运行时接入
- [x] V5 ModelCapabilities 能力矩阵
- [x] V6 RuntimeStats（只建议，不改配置）
- [x] V7 EvalSetRunner（离线评测 + model_eval_results）
- [ ] V8 完整自动路由（P0–P2 已落地；Agent promptStrategy 暴露待续）
- [ ] V9 WorkflowGraphRunner + 拖拽 UI

---

## 不建议当前实现

- RuntimeStats 自动改配置
- EvalSetRunner 全量评测
- RouterModelEvaluator 每次请求都调用
- 多模型并行投票 / 无限辩论
- CostBudgetManager
- 拖拽式可视化编排器（V9）

---

## 需要验证的测试（V2 完成后）

- [x] Level 1 超时/抛错 → 升级 Level 2，只保存一条 final assistant（`tests/fallback-verification.test.ts`）
- [x] Level 2 失败 → 升级 Level 3（`tests/fallback-verification.test.ts`）
- [x] `review reject` 且无 `revisedAnswer` → 强模型重生成，draft 不进 messages（`tests/draft-review.test.ts`）
- [x] 审查 JSON 失败 → 最多重试 1 次后 fallback（`tests/draft-review.test.ts`）
- [x] fallback 达上限 → 明确错误码，不写半成品 assistant（`tests/fallback-verification.test.ts`）
- [x] `fallback_logs` 与 `model_route_logs` 可关联回放（`tests/fallback-verification.test.ts` + `tests/routing-logs.test.ts`）

---

## 预计新增/修改文件（V2 实施时）

**新增**

- `src/model-router/fallback-manager.ts`
- `src/model-router/fallback-log-store.ts`
- `tests/fallback-manager.test.ts`
- `src/server/handlers/routing.handlers.ts`（P1）

**修改**

- `src/model-orchestrator/model-orchestrator.ts`
- `src/model-orchestrator/pipelines/*.ts`
- `src/model-router/route-stores.ts`（schema v4）
- `src/model-router/types.ts`
- `src/orchestrator/Orchestrator.ts`
- `docs/模型路由与协作.md`、`public/api-spec.json`、`m2-routing.json`

---

## Agent 执行纪律

1. **不要直接实现 V8 完整自动路由。**
2. 每轮优先 **P0 中离当前最近的一条**（与 `agent-todolist.md` 单轮纪律一致）。
3. 改动同步：本文档勾选进度、`docs/模型路由与协作.md`、`AGENTS.md`、测试与 `docs/自审核记录.md`。
4. 中间模型输出只进日志；**仅 `finalAnswer` 写入 messages**。

---

## V2 FallbackManager 触发条件（§5.2 规范逐项）

- [x] 模型调用超时（`model_timeout` 类型 + `FallbackManager.plan`）
- [x] 模型调用异常（`model_error` + `ModelOrchestrator` catch 升级）
- [x] 模型输出为空（`empty_output` / `detectOutputIssue`）
- [x] JSON 解析失败（`json_parse_failed` + draft-review 重试 1 次）
- [x] 远程 review 拒绝本地 draft（`review_rejected` + 强模型 fallback）
- [ ] 工具执行失败（规范 V2 可选，未接入路由 fallback）
- [ ] 用户要求重新认真分析（未单独实现触发器）
- [x] 回答低于最小长度且任务复杂（`answer_too_short` / V4 AnswerEvaluator）

---

## V2 升级路径（§5.3）

- [x] L1 single → L2 single → L3 strong_model_direct（`tests/fallback-verification.test.ts`）
- [x] local_draft_remote_review → strong_model_direct（`tests/draft-review.test.ts`）
- [x] L2 single → L3 strong_model_direct（`tests/fallback-verification.test.ts`）

---

## V2 fallback_logs 字段（§5.4）

- [x] id / route_id / from_model_id / to_model_id
- [x] from_strategy / to_strategy / trigger_type / reason / created_at
- [x] route_logs 关联 fallback_id（`routeLogId` + `GET /api/routing/logs?routeLogId=`）

---

## 进度判断规则（§15）

| 条件 | 当前判定 |
| --- | --- |
| 15.1 无 ModelRegistry | ✅ 已有 → 非此情况 |
| 15.2 有 RuleRouter 无 DecisionEngine | ✅ 两者都有 |
| 15.3 有 Single 无 DraftReview | ✅ 两者都有 |
| 15.4 V1 完整无 FallbackManager | ✅ 已完成 → 进 V2 |
| 15.5 有 Fallback 无 RouterModelEvaluator | ✅ stub 已有；运行时接入仍属 V3 |
| 15.6 有 RouterModel 无 AnswerEvaluator | ✅ 规则版 stub 已有；运行时接入仍属 V4 |

---

## 各阶段验收标准（§18–§22）

### V1（§18）

- [x] 加载配置 / 规则判断 / 单模型 / 草拟审查 / messages 不污染 / final 保存 / 日志

### V2（§19）— 核心已完成

- [x] 失败自动生成 fallback plan
- [x] fallback 后调用更高级模型
- [x] fallback 有日志（`fallback_logs`）
- [x] 最终回答只保存一次
- [x] 不无限递归升级（最多 2 次）

### V3（§20）— 核心已完成

- [x] RuleRouter 不确定时才调 RouterModelEvaluator
- [x] DecisionEngine 不盲信高风险策略（`risk=high` 不覆盖）
- [x] 路由日志记录评估建议（`source=evaluator` + reason）

### V4（§21）— 核心已完成

- [x] AnswerEvaluator 判断足够性
- [x] 不合格触发 fallback / 有日志（`fallback_logs` + `V4 评估` reason）
- [x] 规则版评估（空输出 / 复杂任务过短）

### V9 拖拽编排（§22）— 终局可选，不做

- [ ] UI 拖拽 / workflow JSON / WorkflowGraphRunner / 边校验 / taskType 绑定

---

## V3–V9 未来阶段摘要（§6–§12，均未开始）

| 阶段 | 关键交付 | 状态 |
| --- | --- | --- |
| V3 | RouterModelEvaluator + router_model_evaluations | [x] 启发式运行时接入 |
| V4 | AnswerEvaluator 规则版 | [x] 已接入 ModelOrchestrator |
| V5 | ModelCapabilities 能力矩阵 | [x] |
| V6 | RuntimeStats 指标回流（只建议不改配置） | [x] |
| V7 | EvalSetRunner + model_eval_results | [x] |
| V8 | ContextAnalyzer + PromptStrategyBuilder + RuntimeStatsFeedback | [~] P0–P2 已接入 |
| V9 | WorkflowGraphRunner / NodeRegistry / 拖拽 UI | [ ] |

---

## 最终模块结构缺口（§2 规范清单）

| 模块 | 状态 |
| --- | --- |
| ModelRegistry / RuleRouter / DecisionEngine / ModelOrchestrator | [x] |
| RouteLogStore / ModelCallLogStore | [x] |
| CollaborationLogStore | [~] 合并在 collaboration_runs + call_logs |
| FallbackManager | [x] |
| RouterModelEvaluator / AnswerEvaluator | [x] 运行时接入 |
| ContextAnalyzer / RuntimeStats / EvalSetRunner | [~] ContextAnalyzer ✅；RuntimeStats ✅；EvalSet ✅ |
| PromptStrategyBuilder / CostBudgetManager / ModelProfileStore | [~] PromptStrategyBuilder ✅；CostBudget / ProfileStore 待续 |

---

## Agent 执行指令十条（§23）

- [x] 1. 不直接实现完整自动路由
- [x] 2. 先扫描项目
- [x] 3. 判断 V1–V4 阶段
- [x] 4. 生成 TodoList（本文档）
- [x] 5. P0/P1/P2 分类
- [x] 6. 优先最近下一阶段（V2）
- [x] 7. RuntimeStats/EvalSet/拖拽 暂不实现
- [x] 8. 中间结果只进日志
- [x] 9. 仅 finalAnswer 写 messages
- [x] 10. 路由决策可解释、可追踪

---

> **最后扫描：2026-06-10** · 基于 `agent-relay` 源码与测试（orchestrator 12/12、plan 6/6、smart-router 10、draft-review 4）
