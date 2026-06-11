# Model Router Upgrade TodoList

> 依据 `Agent_Model_Router_Auto_Upgrade_Roadmap.md` 对当前仓库扫描生成。  
> **当前阶段：V1 已基本完成 → 建议进入 V2（FallbackManager）。**  
> 推进模型路由相关改动前，请先读 [模型路由与协作](模型路由与协作.md) 了解已实现能力；**不要一次性实现完整自动路由（V8）**。

---

## 当前项目完成度

### 阶段判定

**V1 规则路由 + 手动配置 + 单任务协作（约 85–90%）** → 下一目标 **V2：FallbackManager**

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
| `strong_model_direct` | ❌ | 路线图 V1 有，未实现 |
| `rule_only` | ⚠️ | 类型存在，DecisionEngine 抛 `RULE_ONLY_NOT_IMPLEMENTED` |
| FallbackManager | ❌ | 无独立模块 |
| RouterModelEvaluator | ❌ | V3 |
| AnswerEvaluator | ❌ | V4 |
| ContextAnalyzer | ❌ | 无独立模块 |
| RuntimeStats / EvalSetRunner | ❌ | V6/V7 |
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
| route/call 日志 | ✅ 写库；❌ 无查询 API / 测试台面板 |

### V1 已知缺口（V2 前或并行收尾）

1. **双轨路由**：`POST /api/chat` 走 SmartModelRouter；`/api/agent`、`/api/plan`、子 Agent 仍走 `model/ModelRouter`
2. **`strong_model_direct` 未实现**
3. **`validateModelProfiles` 未在启动时调用**
4. **协作内降级分散**在 `DraftReviewPipeline`，无统一 FallbackManager / `fallback_logs`
5. **无路由审计 HTTP**
6. 旧 `ModelRouter`「失败降级本地」与 Smart 路由「高风险不静默降级」语义未统一文档化

### 测试现状

- `tests/smart-router.test.ts` — 10 项
- `tests/draft-review.test.ts` — 4 项
- `tests/router.test.ts` — 13 项（客户端级 fallback）
- 全量 `npm test` — **165** 项

---

## 当前建议升级阶段

**V2：FallbackManager**

原因：V1 主干已闭环；协作流水线有零散 fallback 但不可追踪、不可复用；V2 收益高、范围可控，并为 V3/V4 打基础。

升级路线图概览：

| 阶段 | 名称 | 状态 |
|------|------|------|
| V1 | 规则路由 + 手动配置 | ✅ 基本完成 |
| V2 | FallbackManager | ⬅ **下一步** |
| V3 | RouterModelEvaluator | 未开始 |
| V4 | AnswerEvaluator | 未开始 |
| V5 | ModelProfile 能力矩阵 | 未开始 |
| V6 | RuntimeStats | 未开始 |
| V7 | EvalSetRunner | 未开始 |
| V8 | 完整自动路由 | 未开始 |
| V9 | 拖拽式可视化编排 | 终局可选 |

---

## TodoList

### P0：V2 核心 — FallbackManager（必须先完成）

- [ ] 新增 `src/model-router/fallback-manager.ts`（或 `fallback/` 子目录）
  - [ ] `FallbackTrigger`：`model_timeout` / `model_error` / `empty_output` / `json_parse_failed` / `review_rejected` / `review_failed` / `answer_too_short` 等
  - [ ] `FallbackPlan`：`fromModelId`、`toModelId`、`fromStrategy`、`toStrategy`、`maxAttempts`
  - [ ] 升级路径（V1→V2→V3；`local_draft_remote_review` → 强模型单路）
  - [ ] **硬限制**：单次请求最多 1–2 次 fallback，禁止无限递归
- [ ] 新增 `fallback_logs` 表 + `FallbackLogStore`
- [ ] 将 `DraftReviewPipeline` 内零散 catch/降级迁入 FallbackManager
- [ ] `SingleModelPipeline` 接入：失败/空输出 → fallback
- [ ] `ModelOrchestrator.run()` 作为统一 fallback 编排入口
- [ ] `RouterDecision` / `OrchestratorResult` 增加 `fallbackCount`、`fallbackLogIds`（debug）

### P0：V1 收尾（与 V2 并行，范围要小）

- [ ] 启动时调用 `validateModelProfiles()` 并警告（`createAppContext` / `npm run dev`）
- [ ] 实现或明确映射 **`strong_model_direct`**（架构/高风险默认强模型直答）
- [ ] 更新 [模型路由与协作](模型路由与协作.md) 标明 V1/V2 边界

### P1：V2 增强与可观测

- [ ] `GET /api/routing/logs`（route/call/collaboration/fallback 只读查询）
- [ ] 测试台「模型路由」面板（最近决策与 fallback 链）
- [ ] `public/test-cases/m2-routing.json` 增加 fallback 场景用例
- [ ] `tests/fallback-manager.test.ts`（mock，≥6 条）

### P1：路由覆盖面扩展（V1.x，不碰 V8 自动路由）

- [ ] 评估 `/api/agent` 未指定 `clientName` 时复用 SmartModelRouter（仅模型选择层）
- [ ] `Planner` 经 Registry 选模型（替代硬编码 `taskType: reasoning`）
- [ ] 文档统一：`model/ModelRouter` = 连通性 fallback；`SmartModelRouter` = 任务级策略

### P2：为 V3/V4 预留接口（类型 + stub，不调用）

- [ ] `router-model-evaluator.ts` — `RouterModelEvaluation` + stub
- [ ] `answer-evaluator.ts` — `AnswerEvaluation` + 规则版 stub
- [ ] `DecisionEngine` / `ModelOrchestrator` 注释扩展点

### P2：后续阶段（本清单阶段不做）

- [ ] V3 RouterModelEvaluator
- [ ] V4 AnswerEvaluator
- [ ] V5 ModelCapabilities 能力矩阵
- [ ] V6 RuntimeStats（只建议，不改配置）
- [ ] V7 EvalSetRunner
- [ ] V8 完整自动路由
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

- [ ] Level 1 超时/抛错 → 升级 Level 2，只保存一条 final assistant
- [ ] Level 2 失败 → 升级 Level 3
- [ ] `review reject` 且无 `revisedAnswer` → 强模型重生成，draft 不进 messages
- [ ] 审查 JSON 失败 → 最多重试 1 次后 fallback
- [ ] fallback 达上限 → 明确错误码，不写半成品 assistant
- [ ] `fallback_logs` 与 `model_route_logs` 可关联回放

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

*最后扫描：2026-06-12 · 基于 `agent-relay` 源码与测试计数 165*
