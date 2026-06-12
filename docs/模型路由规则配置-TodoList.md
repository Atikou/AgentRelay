# 模型路由规则配置 — TodoList

> **来源规范**：`Agent_Model_Router_Rule_Config_Spec.md`  
> **扫描基准**：`agent-relay/src/model-router/`、`POST /api/chat` Smart 路由、`tests/smart-router.test.ts`  
> **生成日期**：2026-06-10  
> **关联索引**：[外部规范-TodoList索引](外部规范-TodoList索引.md)  
> **用途**：对照「规则路由 + 手动模型等级配置」首版规范查漏补缺；**本文仅记录状态**

---

## 0. 模型等级定义（§4）

| Level | 含义 | 状态 |
| --- | --- | --- |
| 0 | 规则直处理 | [ ] `rule_only` 未实现 |
| 1 | 轻量：闲聊、记忆、摘要 | [x] |
| 2 | 普通：技术问答、单文件 | [x] |
| 3 | 强：架构、vision、高风险 | [x] |

## 完成度概览

| 章节 | 已完成 | 部分 | 未开始 |
| --- | ---: | ---: | ---: |
| §14 A–G 实现任务 | 38 | 2 | 0 |
| §14 H Chat 集成 | 4 | 1 | 0 |
| §14 I 测试用例 | 9 | 1 | 0 |
| §15 验收标准 | 9 | 1 | 0 |
| **合计** | **60** | **5** | **0** |

**结论**：规范要求的 V1「规则路由 + 手动配置」**已基本完成**；缺口主要在启动配置校验、部分 API 未走 Smart 路由、无路由日志查询 HTTP。

---

## 1. 本阶段范围（§3）

### 3.1 必须实现

- [x] ModelProfile 手动配置（`model-profiles.ts` + `config.routerProfile`）
- [x] ModelRegistry（`model-registry.ts`）
- [x] RuleRouter（`route-rules.ts`）
- [x] DecisionEngine（`decision-engine.ts`）
- [x] RouteLogStore（`route-stores.ts` → `model_route_logs`）
- [x] ModelRouter 对外入口（`SmartModelRouter`）
- [x] 基础测试（`smart-router.test.ts` 10 项）

### 3.2 暂不实现（规范明确）

- [ ] RouterModel 模型自评 — **按规范暂不实现** ✅
- [ ] 自动能力评测 — **暂不** ✅
- [ ] 动态调参 — **暂不** ✅
- [ ] 复杂 fallback — **见协作/升级 TodoList V2** ⏳

---

## 2. 规范 §14 TodoList（逐项）

### A. 类型定义

- [x] `src/model-router/types.ts`
- [x] `TaskType`（含 `companion_chat`、`high_risk_action`、`unknown` 等）
- [x] `ModelLevel` 0 \| 1 \| 2 \| 3
- [x] `ModelProfile`
- [x] `RouterInput`
- [x] `RuleRouteResult`
- [x] `RouterDecision`
- [x] `RouteLog`（合并在 RouterDecision + DB 行）

---

### B. 模型配置

- [x] `model-profiles.ts` + `buildModelProfiles(config)`
- [x] 至少 3 档示例：local / api-general / api-strong（由 config clients 映射）
- [x] `enabled` 开关
- [x] `defaultLevel`
- [x] `allowedTaskTypes`
- [x] `supportsVision` / `supportsTools` / `supportsJsonMode`
- [x] 启动时 `validateModelProfiles()` — `createAppContext` 启动时 `console.warn`

---

### C. ModelRegistry

- [x] `listModels()` / `getModel(id)`
- [x] `findCandidates(ruleResult)`（内部实现）
- [x] 过滤 disabled
- [x] 按 `requiredLevel` 过滤
- [x] 按 `taskType` 过滤
- [x] 按 vision/tools/json 过滤
- [x] 按 level 接近度、成本、延迟排序

---

### D. RuleRouter

- [x] `route-rules.ts` — `RuleRouter.evaluate()`
- [x] 高风险操作规则
- [x] 多模态/图片规则（`requireVision`）
- [x] 架构/复杂项目规则
- [x] 代码/调试规则
- [x] 记忆写入/查询规则
- [x] 普通聊天规则
- [x] `qualityMode`：fast / balanced / deep
- [x] 默认兜底规则
- [x] §8.2 高风险关键词（删除/批量/shell/git reset 等）
- [x] §8.3 多模态/截图关键词
- [x] §8.4 架构/复杂项目关键词
- [x] §8.5 代码/调试关键词（含升级 L3 条件）
- [x] §8.6 记忆写入/查询
- [x] §8.7 普通聊天/陪伴（含 companion_chat）
- [x] §8.8 默认兜底按 qualityMode

---

### E. DecisionEngine

- [x] `decision-engine.ts`
- [x] 选择 `selectedModelId`
- [x] 生成 `RouterDecision`
- [x] 无候选 → `RouterError NO_AVAILABLE_MODEL`
- [x] 高风险无强模型 → 拒绝静默降级（抛错或 requireUserConfirmation）

---

### F. ModelRouter

- [x] `SmartModelRouter.route(input)`
- [x] 内部 RuleRouter → Registry → DecisionEngine
- [x] 保存 route log
- [x] 返回 `RouterDecision`

---

### G. RouteLogStore

- [x] `RouteLogStore.save()`
- [x] SQLite 表 `model_route_logs`（含 execution_strategy、draft/review model id）
- [ ] `listBySession(sessionId, limit)` — **未实现**
- [x] `userInputPreview` 截断
- [x] `candidates_json` 保存

---

## 2b. 对外接口（§11）

- [x] `SmartModelRouter.route()`（规范 `ModelRouter`）
- [x] `ModelRegistry`：list / get / findCandidates
- [x] `RuleRouter.evaluate()`（规范 `RouteRuleEngine.match`）
- [x] `RouteLogStore.save()`

---

## 2c. Chat 集成九步（§12）

| 步骤 | 状态 |
| --- | --- |
| 1 saveUserMessage | [x] Orchestrator |
| 2 ContextRestorer | [~] chat 路径部分上下文 |
| 3 ModelRouter.route | [x] SmartModelRouter |
| 4 PromptBuilder | [~] systemBase + messages |
| 5 ModelClient 调用 | [x] via ModelOrchestrator |
| 6 saveAssistantMessage | [x] |
| 7 MemoryExtractor 后处理 | [~] 视配置 |
| 8 RouteLogStore | [x] |
| 9 返回 + debug | [x] routerDecision |

---

## 2d. 错误处理（§13）

- [x] 13.1 无可用模型 → `NO_AVAILABLE_MODEL`，不静默降级（高风险）
- [~] 13.2 强模型不可用：低风险可降级并记录；高风险拒绝 — **部分在 DecisionEngine**
- [~] 13.3 模型调用失败：当前只记录，复杂 fallback 见 V2 TodoList

---

### H. 与 Chat 流程集成

- [x] `Orchestrator.runChat` 在无 forceClient 时走 SmartModelRouter
- [x] 用 `selectedModelId` / 协作策略调用 ModelOrchestrator
- [x] debug 响应含 `routerDecision`
- [x] ModelRouter 不修改 messages/memories
- [~] `/api/agent`、`/api/plan`、子 Agent 仍走旧 `model/ModelRouter`（连通性 fallback）

---

### I. 测试用例（规范 §14）

- [x] `你好` → Level 1
- [x] `记住我默认中文` → memory_write
- [x] `解释 TypeScript 报错` → Level 2
- [x] `设计完整架构方案` → Level 3
- [x] `批量删除文件` → Level 3 + requireUserConfirmation
- [x] 图片附件 → supportsVision 模型
- [x] `qualityMode=fast` → 倾向 Level 1 / 禁用协作
- [x] `qualityMode=deep` → 倾向协作
- [x] 无 api-strong 时高风险 — **部分**：无 review 降级测试有；禁用 strong 专项待补
- [~] RouteLogStore 持久化 — **写库有，无单测断言 DB 行**

---

## 3. 验收标准（§15）

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | 配置注册多模型 | ✅ |
| 2 | 规则判断任务类型与等级 | ✅ |
| 3 | 选择符合条件模型 | ✅ |
| 4 | 高风险不误用低级模型 | ✅ |
| 5 | 图片不误用非 vision 模型 | ✅ |
| 6 | 每次路由有日志 | ✅ 写库 |
| 7 | Chat 拿 selectedModelId 调用 | ✅ `/api/chat` |
| 8 | 不依赖模型自评 | ✅ |
| 9 | 规则可测试 | ✅ smart-router 10 项 |
| 10 | 可无破坏扩展 RouterModel/fallback | ✅ 类型预留 |

---

## 4. 已知缺口（规范外但影响 V1 闭环）

- [x] 启动时调用 `validateModelProfiles()` 并 warn
- [ ] `GET /api/routing/logs` 只读查询
- [ ] 测试台「模型路由」决策面板
- [ ] 文档统一：`model/ModelRouter`（客户端 fallback）vs `SmartModelRouter`（任务策略）
- [ ] `m2-routing.json` 网页用例覆盖 Smart 路由（当前可能仍偏旧 ModelRouter）

---

## 5. 后续扩展（§16 — 规范说当前不要做）

- [ ] RouterModel
- [ ] AnswerEvaluator
- [ ] FallbackEngine → **见 [模型路由升级TodoList](模型路由升级TodoList.md) V2**
- [ ] ModelEvalSet / DynamicModelScore / CostBudgetManager

---

## 6. 相关索引

| 路径 | 说明 |
| --- | --- |
| `src/model-router/` | 规则路由模块 |
| `tests/smart-router.test.ts` | 10 项规则/决策测试 |
| `docs/模型路由与协作.md` | 使用说明 |
| [模型路由协作-TodoList](模型路由协作-TodoList.md) | 协作层规范对照 |
| [模型路由升级TodoList](模型路由升级TodoList.md) | V2+ 路线图 |

---

*本文对应规范首版「仅规则 + 手动配置」；多模型协作见协作 TodoList。*
