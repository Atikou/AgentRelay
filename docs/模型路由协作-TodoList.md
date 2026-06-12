# 模型路由与单任务多模型协作 — TodoList

> **来源规范**：`Agent_Model_Router_Collaboration_Spec.md`  
> **扫描基准**：`model-router/` + `model-orchestrator/`、`Orchestrator.runChat`、`tests/draft-review.test.ts`  
> **生成日期**：2026-06-10  
> **关联索引**：[外部规范-TodoList索引](外部规范-TodoList索引.md)  
> **用途**：对照协作规范查漏补缺；**本文仅记录状态**

---

## 0. 模块目标（§1–§2）

- [x] 解决「用哪个模型 / 哪组模型」
- [x] 单任务协作 draft+review（非无限辩论）
- [x] 规则优先、配置驱动、中间结果不进 messages、高风险不静默降级

## 完成度概览

| 章节 | 已完成 | 部分 | 未开始 |
| --- | ---: | ---: | ---: |
| §3 必须实现 | 10 | 1 | 0 |
| §21 A–J TodoList | 62 | 8 | 6 |
| §22 验收标准 | 11 | 1 | 0 |
| **合计** | **83** | **10** | **6** |

**结论**：规范要求的 **single_model + local_draft_remote_review** 协作链已闭环；缺口：`rule_only`、启动 profile 校验、messages 污染集成测试、路由 HTTP 可观测、统一 FallbackManager。

---

## 1. 当前阶段范围（§3）

### 3.1 必须实现

| 项 | 状态 | 位置 |
| --- | --- | --- |
| ModelProfile 手动配置 | ✅ | `model-profiles.ts` |
| ModelRegistry | ✅ | `model-registry.ts` |
| RuleRouter | ✅ | `route-rules.ts` |
| DecisionEngine | ✅ | `decision-engine.ts` |
| ModelRouter 入口 | ✅ | `SmartModelRouter` |
| ModelOrchestrator | ✅ | `model-orchestrator.ts` |
| DraftReviewPipeline | ✅ | `pipelines/draft-review-pipeline.ts` |
| RouteLogStore | ✅ | `route-stores.ts` |
| ModelCallLogStore | ✅ | `model_call_logs` |
| CollaborationRunStore | ✅ | `model_collaboration_runs` |
| 基础测试 | ✅ | smart-router 10 + draft-review 4 |

### 3.2 暂不实现（规范 §3.2 / §23）

- [ ] RouterModel / 自动评测 / 动态能力分 — **按规范不做** ✅
- [ ] 多模型无限辩论 / 并行投票 — **不做** ✅
- [ ] 复杂 CostBudget — **不做** ✅

### 3.3 允许的策略

- [x] `single_model`
- [x] `local_draft_remote_review`
- [ ] `rule_only` — 类型有，`DecisionEngine` 抛 `RULE_ONLY_NOT_IMPLEMENTED`
- [ ] `strong_model_direct` — 升级路线图有，协作规范未强制；**未单独实现**

---

## 2. 规范 §21 TodoList

### A. 类型定义

- [x] `ExecutionStrategy`（含 `rule_only`）
- [x] `ModelRole`：primary / draft / review / final
- [x] `ModelProfile` 扩展：`allowedRoles`、`canDraft`、`canReview`、`canFinal`
- [x] `RuleRouteResult`：`preferCollaboration`、`preferredStrategy`
- [x] `RouterDecision`：`executionStrategy`、draft/review/final model ids
- [x] `model-orchestrator/types.ts`
- [x] `OrchestratorInput` / `OrchestratorResult`
- [x] `DraftReviewResult`

---

### B. 模型配置

- [x] 更新 `model-profiles.ts` / `buildModelProfiles`
- [x] local 档 `canDraft=true`、`canReview=false`
- [x] api-general / api-strong `canReview=true`
- [x] api-strong `supportsVision=true`
- [~] 配置校验：至少一个可用 final 模型 — `validateModelProfiles` 未在启动调用
- [~] 配置校验：启用协作时至少 draft + review — 同上

---

### C. RuleRouter

- [x] 架构 → `local_draft_remote_review`
- [x] 文档/TodoList/实现方案 → 协作
- [x] 普通聊天 → `single_model`
- [x] 记忆写入 → `single_model`（或低 level）
- [x] 图片 → `single_model` + requireVision
- [x] 高风险 → `single_model` + requireUserConfirmation + Level 3
- [x] `qualityMode=fast` 禁用协作
- [x] `qualityMode=deep` 更倾向协作

---

### D. ModelRegistry

- [x] `findPrimaryCandidates(ruleResult)`
- [x] `findDraftCandidates(ruleResult)`
- [x] `findReviewCandidates(ruleResult)`
- [x] `findFinalCandidates` — **finalModelId 默认 = reviewModelId**
- [x] 草稿优先本地/低成本
- [x] 审查 `defaultLevel >= requiredLevel`
- [x] 审查优先 supportsJsonMode
- [x] vision 任务过滤

---

### E. DecisionEngine

- [x] 按 `preferredStrategy` 决策
- [x] `forceSingleModel` / `allowCollaboration=false` → single
- [x] single 选 `selectedModelId`
- [x] 协作选 draft/review/final ids
- [x] 无 review → 按风险降级或报错
- [x] 高风险不允许静默降级（无 review 时抛 `NO_REVIEW_MODEL_AVAILABLE`）
- [x] 完整 `RouterDecision`

---

### F. ModelOrchestrator

- [x] `model-orchestrator.ts`
- [x] 按 strategy 分发 pipeline
- [x] `SingleModelPipeline`
- [x] `DraftReviewPipeline`
- [x] 只返回 `finalAnswer`
- [x] draft/review 不进 assistant message（pipeline 层）

---

### G. DraftReviewPipeline

- [x] draft/review prompt 模板
- [x] draft 模型调用
- [x] review JSON 输出要求
- [x] `parseDraftReviewResult`
- [x] approve → draft 为 finalAnswer
- [x] revise → revisedAnswer
- [x] reject 高风险且无 revisedAnswer → 抛错
- [~] JSON 解析失败重试 1 次 — **pipeline 内部分处理，无独立测试**
- [x] 中高风险审查失败不得直接用 draft（reject 测试）

---

### H. 日志与审计

- [x] `model_route_logs` 含 execution_strategy、draft/review/final ids
- [x] `model_call_logs` 表
- [x] `model_collaboration_runs` 表
- [x] 记录 modelId、role、status、durationMs
- [x] 协作 verdict、confidence、issues（collaboration run finish）
- [x] Chat 响应 debug 含 routerDecision、collaborationRunId
- [ ] `GET /api/routing/logs` HTTP 查询

---

### I. Chat 流程集成

- [x] `Orchestrator.runChat` → SmartModelRouter.route
- [x] → ModelOrchestrator.run
- [x] 仅 finalAnswer 写入会话（chat 路径）
- [x] 不把 draft/review 写入 messages
- [~] debug preview draft/review — 部分字段在 routerDecision
- [ ] **端到端**断言 messages 表无 draft 行（无 DB 集成测试）

---

### J. 测试用例（规范 §21）

| 用例 | 状态 |
| --- | --- |
| 你好 → single Level 1 | ✅ smart-router |
| 记住… → single/rule | ✅ |
| TS 报错 → single L2 | ✅ |
| 完整架构 → draft_review | ✅ |
| 实现文档 TodoList → 协作 | ✅ |
| 图片 → vision single | ✅ |
| 批量删除 → L3 + 确认 | ✅ |
| fast 禁用协作 | ✅ |
| deep 启用协作 | ✅ |
| 无 review 中高风险 | ✅ 降级/报错测试 |
| approve 用 draft | ✅ draft-review |
| revise 用 revisedAnswer | ✅ |
| reject 不用低质量 draft | ✅ |
| draft/review 不在 messages | [ ] 无 DB 测试 |
| model_call_logs 两次调用 | [~] pipeline 返回 call ids，无 DB 断言 |
| collaboration_runs 记录 verdict | [~] mock store 测试 |

---

## 3. 验收标准（§22）

- [x] 1. 配置注册多模型
- [x] 2. 规则选单模型或协作策略
- [x] 3. 协作任务选 draft + review
- [x] 4. 架构/文档/TodoList 可走 draft_review
- [x] 5. 聊天/记忆不走协作
- [x] 6. 图片不用非 vision 模型
- [x] 7. 高风险不静默降级
- [x] 8. draft/review 不污染 messages（设计层 ✅，DB 测试 ❌）
- [x] 9. 路由与调用有日志
- [x] 10. Chat 只存 final assistant
- [x] 11. 不依赖模型自评
- [x] 12. 可扩展 RouterModel/Fallback

---

## 4. 与升级路线图关系

| 能力 | 协作规范 | 升级路线图 |
| --- | --- | --- |
| V1 规则+协作 | ✅ 本文 | ✅ |
| V2 FallbackManager | 规范说「复杂 fallback 不做」 | **下一步** → [模型路由升级TodoList](模型路由升级TodoList.md) |
| V3+ RouterModel/AnswerEvaluator | 明确不做 | 后续阶段 |

---

## 5. 建议后续补齐（非本文规范 P0，但影响闭环）

- [ ] 实现或移除 `rule_only`（记忆 Level 0 规则直处理）
- [ ] `validateModelProfiles()` 启动校验
- [ ] `tests/collaboration-integration.test.ts`：messages 表仅 1 条 assistant
- [ ] FallbackManager 统一 DraftReview 内零散 catch
- [ ] `m2-routing.json` + 测试台协作场景用例

---

## 6. 相关索引

| 路径 | 说明 |
| --- | --- |
| `src/model-orchestrator/` | 流水线 |
| `tests/draft-review.test.ts` | 4 项 |
| `tests/smart-router.test.ts` | 10 项 |
| `docs/模型路由与协作.md` | 说明文档 |

---

*协作规范 V1 主体已完成；失败升级见升级 TodoList V2。*

---

## 7. 规则优先级（§11.1）

- [x] 1. 用户 qualityMode（fast/balanced/deep）
- [x] 2. 高风险工具操作
- [x] 3. 多模态附件
- [x] 4. 架构/复杂项目
- [x] 5. 代码/调试/文档
- [x] 6. 记忆写入/查询
- [x] 7. 普通聊天/陪伴
- [x] 8. 默认兜底

---

## 8. DraftReview 次数上限（§15.1）

- [x] 草拟最多 1 次
- [x] 审查最多 1 次
- [x] 最终整理可选 1 次（review 兼 final）
- [x] 无无限循环

---

## 9. 保存策略（§16）

- [x] 1. 用户消息 → messages
- [x] 2. 最终 assistant → messages
- [x] 3. draft 不进 messages
- [x] 4. review 不进 messages
- [x] 5. draft/review → model_call_logs / collaboration_runs
- [x] 6. renderedPrompt 不作主数据长期保存

---

## 10. Chat 集成九步（§18）

| 步骤 | 状态 |
| --- | --- |
| MessageStore.saveUserMessage | [x] |
| ContextRestorer.restore | [~] chat 路径 |
| ModelRouter.route | [x] |
| PromptBuilder.build | [~] |
| ModelOrchestrator.run | [x] |
| saveAssistantMessage(finalAnswer) | [x] |
| MemoryExtractor 后处理 | [~] |
| 返回 debug | [x] |

---

## 11. 错误处理（§19）

| 场景 | 状态 |
| --- | --- |
| 19.1 无单模型候选 → NO_AVAILABLE_MODEL | [x] |
| 19.2 无审查模型：按风险降级或报错 | [x] DecisionEngine |
| 19.3 草稿模型失败：降级 single 或 review 直出 | [~] pipeline 内处理 |
| 19.4 审查 JSON 失败：低风险用 draft；高风险重生成 | [~] `review_failed_*` 状态 |

---

## 12. 推荐路由场景（§20）

### 20.1 应 single_model

- [x] 普通聊天 / 陪伴 / 记忆 / 简单摘要
- [x] 图片（当前阶段单强 vision 模型）
- [x] 高风险工具前分析（强模型 single）

### 20.2 应 local_draft_remote_review

- [x] 架构 / 模块设计 / 实现文档 / TodoList
- [x] 中等复杂技术方案 / 长文整理

### 20.3 不建议协作

- [x] 一句话闲聊 / 极短问题 / 记忆保存 / 状态查询
- [x] 高风险自动执行 / 实时流式陪伴

---

## 13. 后续扩展（§23 — 规范说当前不做）

- [ ] RouterModel / AnswerEvaluator / FallbackEngine（→ 升级 TodoList V2+）
- [ ] ParallelComparePipeline / VisionPreprocess / ModelEvalSet / DynamicModelScore / CostBudgetManager

---
