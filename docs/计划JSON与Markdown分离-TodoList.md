# 计划 JSON 与 Markdown 分离 — TodoList

> **来源规范**：`Agent_TaskPlan_JSON_Markdown_Separation_Spec.md`  
> **扫描基准**：仓库 `agent-relay/` 当前实现（`src/plan/`、`Orchestrator`、`DatabaseManager` SCHEMA v5、测试与 API）  
> **生成日期**：2026-06-10  
> **关联索引**：[外部规范-TodoList索引](外部规范-TodoList索引.md)（共 5 份规范）  
> **用途**：后续查漏补缺；**本文仅记录状态，不代表本轮需全部实现**

## 完成度概览

| 优先级 | 已完成 | 部分完成 | 未开始 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| P0 | 14 | 1 | 0 | 15 |
| P1 | 10 | 6 | 4 | 20 |
| P2 | 2 | 0 | 8 | 10 |
| P3 | 4 | 0 | 2 | 6 |
| 规范测试 §15 | 4 | 0 | 1 | 5 |
| **合计** | **34** | **7** | **15** | **56** |

**结论**：P0 主体已落地（类型分离、PlanStore、PlanRenderer、执行边界）；P1 审批与校验仍有缺口；P2 版本链与逐步审计、P3 前端拒绝/修订 UI 基本未做。  
> **验收**：计划体系是否通过以 [`项目验收清单.md`](项目验收清单.md) §3 为准（仅人类勾选），本 TodoList 只跟踪实现细节。

---

## 0. 目标与核心原则（§0–§2）

- [x] InternalTaskPlan 作为唯一内部执行源（`src/plan/types.ts`）
- [x] UserPlanMarkdown / PublicPlanJson 仅作展示（`PlanRenderer.ts`）
- [x] Executor 只接受 `planId + version`（`executeStoredPlan`、`POST /api/plans/:id/execute`）
- [x] Executor 拒绝 Markdown / PublicPlanJson 作为执行体（`rejectExecutablePreview`）
- [x] `POST /api/task/run` 拒绝 inline `plan`（`PLAN_BODY_NOT_EXECUTABLE`）
- [~] dry-run 仍兼容 inline legacy `plan`（`ingestLegacyPlanBody` + 系统 auto-approve）— **与规范「外部输入永不提升」存在例外，待收敛**

---

## 1. 三种计划对象（§3）

### 3.1 InternalTaskPlan

- [x] `kind: internal_task_plan`、`schemaVersion`、`planId`、`version`、`status`
- [x] `origin` / `goal` / `mode` / `scope`
- [x] `budget` / `permissions` / `steps` / `guards` / `rollback` / `audit`
- [x] `InternalPlanStep`：`stepId`、`type`、`toolName`、`args`、`dependsOn`、`riskLevel` 等
- [x] zod schema 校验（`InternalTaskPlanSchema`）
- [x] legacy `Plan` ↔ Internal 转换（`planConverter.ts`）

### 3.2 UserPlanMarkdown

- [x] 由 InternalTaskPlan 渲染（`renderPlanMarkdown`）
- [x] 人类可读、省略内部字段、不含完整 tool args
- [x] 预览可缓存（`task_plan_previews` 表）
- [ ] 独立类型名 `UserPlanMarkdown`（当前以 `RenderedPlanPreview` + 字符串内容表示）

### 3.3 PublicPlanJson

- [x] `kind: public_plan_preview`、`executable: false`（规范 §3.3 / §8.4；非 §2.3 示例中的 `type` 字段）
- [x] `title` / `summary` / `steps` / `warnings`
- [x] 脱敏：不含完整 args、敏感路径

---

## 2. 模块分工（§4）

| 模块 | 状态 | 代码位置 |
| --- | --- | --- |
| Planner | [x] 已有 | `src/agent/Planner.ts` |
| PlanValidator | [~] 基础版 | `src/plan/PlanValidator.ts` |
| PlanStore | [x] 已有 | `src/plan/PlanStore.ts` |
| PlanRenderer | [x] 已有 | `src/plan/PlanRenderer.ts` |
| PlanApprovalManager | [~] 缺 HTTP reject | `src/plan/PlanApprovalManager.ts` |
| TaskExecutor | [~] 经 Orchestrator | `Orchestrator.executeStoredPlan` → `TaskRunner` |
| PlanRunStore | [~] 仅 `task_plan_runs` | `PlanStore.createPlanRun`；**无** `task_plan_run_steps` |
| AuditLogger | [~] 泛型 `plan_event` | `PlanService.logPlanEvent` → `TraceLogger` |

---

## 3. 数据流（§5）

### 5.1 生成计划

- [x] Planner → InternalTaskPlan draft
- [x] PlanValidator 校验
- [x] PlanStore 保存（`awaiting_approval`）
- [x] PlanRenderer → Markdown + PublicPlanJson
- [x] API：`POST /api/plan`、`POST /api/plans/draft`

### 5.2 用户确认执行

- [x] PlanApprovalManager 写入 approval
- [x] 状态 → `approved`
- [x] TaskExecutor 按 planId + version 加载
- [x] 再次校验 planHash / status
- [x] API：`POST /api/plans/:planId/approve`、`POST /api/plans/:planId/execute`

### 5.3 用户修改 Markdown

- [x] 禁止「Markdown → Executor 直接执行」
- [x] 自然语言修订 → Planner 重生（`revise` / `import-preview` + `planId`）
- [x] 专用「plan revision request」流程（`POST /api/plans/:planId/revise`）
- [x] 同 `planId` 递增 version，旧版 `superseded`

### 5.4 用户导入 PublicPlanJson

- [x] 识别 `executable=false`，拒绝直接执行
- [x] 作为 Planner 上下文重新生成 InternalTaskPlan
- [x] API：`POST /api/plans/import-preview`
- [ ] ImportService 独立模块命名（当前合并在 `PlanService`）
- [ ] 导入后保留原 `planId` 版本链

---

## 4. Plan 状态机（§6）

- [x] 状态枚举齐全：`draft` … `rolled_back`（`PlanStatusSchema`）
- [x] Executor 仅允许 `approved` / `scheduled`（`ExecutablePlanStatuses`）
- [x] 状态转换表（`canTransition`）
- [ ] 运行时完整走 `draft → validated → awaiting_approval → approved`（当前 draft 经 validate 后直接 awaiting_approval）
- [ ] `scheduled` 状态接入调度触发执行
- [ ] `paused` / `rollback_required` / `rolled_back` 运行时流转

---

## 5. 执行器安全规则（§7）

- [x] 1. 只接受 planId + version（生产路径）
- [x] 2. 从 PlanStore 读取 InternalTaskPlan
- [x] 3. 校验 `kind === internal_task_plan`
- [x] 4. 校验 status 为 approved / scheduled
- [x] 5. 校验 planHash 未变化
- [~] 6. 校验权限和预算（PlanValidator 基础；执行期未再扣减预算）
- [~] 7. 校验 workspace 范围（forbiddenPaths；workspace 边界部分）
- [x] 8. 校验 forbiddenPaths
- [x] 9. 执行前记录 plan_run（`task_plan_runs`）
- [~] 10. 每个 step 执行前再次校验依赖和权限（TaskRunner DAG；非 InternalPlan step 级二次校验）
- [~] 11. 每个写操作走备份和 diff（工具层已有；非 Plan 层强制声明）
- [x] 12. 每个工具调用写 trace 审计（`ToolRegistry` + `TraceLogger`）

---

## 6. 数据库表（§9）

- [x] 9.1 `task_plans`
- [x] 9.2 `task_plan_versions`
- [x] 9.3 `task_plan_previews`
- [x] 9.4 `task_plan_approvals`
- [x] 9.5 `task_plan_runs`
- [ ] 9.6 `task_plan_run_steps`（规范建议；**未建表**）

---

## 7. API（§10）

- [x] 10.1 `POST /api/plans/draft`
- [x] 10.2 `GET /api/plans/:planId/preview?format=markdown|json`
- [x] 10.3 `POST /api/plans/:planId/approve`
- [x] 10.3b `POST /api/plans/:planId/reject`
- [x] 10.4 `POST /api/plans/:planId/execute`（拒绝 internalPlan / publicPlanJson / plan body）
- [x] 10.5 `POST /api/plans/import-preview`
- [x] 兼容 `POST /api/plan`（返回 preview，非完整 InternalTaskPlan）
- [x] `public/api-spec.json` 登记上述端点
- [x] 网页用例 `public/test-cases/m3-plan-store.json`（4 条边界用例）

---

## 8. Markdown 与 JSON 关系（§11）

- [x] 11.1 允许 InternalTaskPlan → Markdown / PublicPlanJson
- [x] 11.2 禁止 Markdown / PublicPlanJson → Executor
- [~] 11.3 用户修改后生成 version 2 + 重新确认（import-preview / revise 已支持同 planId 版本链）

---

## 9. 防混淆命名（§12）

- [x] 使用 `InternalTaskPlan` / `PublicPlanJson` / `RenderedPlanPreview`
- [x] 字段：`previewMarkdown`、`publicPlanJson`、`sourcePlanHash`、`executable`
- [ ] 全面清理历史模糊命名（如部分 API/测试仍用 legacy `plan` 对象指代）
- [ ] 避免使用 `planJson` / `planMarkdown` / `planData` 等模糊名（§12 禁止清单）
- [x] 推荐命名：`internalPlanJson`（内部）、`previewMarkdown`、`publicPlanJson`、`sourcePlanHash`

---

## 9b. TypeScript 类型建议（§8）

- [x] §8.1 `InternalTaskPlan` 主要字段（见 `types.ts`）
- [x] §8.2 `InternalPlanStep`（含 `stepId`、`type`、`toolName`、`args`、`riskLevel` 等）
- [x] §8.3 `RenderedPlanPreview`（planId、version、format、content、sourcePlanHash）
- [x] §8.4 `PublicPlanJson`（`executable: false` 字面量）
- [ ] `UserPlanMarkdown` 独立类型（当前为渲染字符串）

---

## 9c. InternalTaskPlan 用途清单（§3.1）

- [x] 任务调度 / 工具编排（经 TaskRunner）
- [x] 权限控制（`permissions` + step permissions）
- [~] 文件锁定（`guards.writeSet/readSet`，未运行时强制锁）
- [x] 回滚策略字段（`rollback`；执行依赖工具层 backup）
- [x] 审计（`audit.planHash`）
- [ ] 恢复执行 / 失败重试（plan 级续跑未做）

---

## 9d. 给 Agent 的实施指令（§17）— 8 条核心要求

- [x] 1. InternalTaskPlan 唯一可执行源
- [x] 2. Markdown/PublicPlanJson 不可被 TaskExecutor 执行
- [x] 3. TaskExecutor 只接受 planId + version（生产路径）
- [x] 4. PublicPlanJson 含 executable=false
- [x] 5. 用户改 Markdown/导入 JSON 仅作重生输入（import-preview）
- [x] 6. 须经 PlanValidator
- [~] 7. 高风险写/shell 须审批与审计（审批链有；dry-run auto-approve 例外）
- [~] 8. 计划执行须 trace（泛型 plan_event，非 §14 全量事件名）

---

## 9e. 规范 §17 扫描清单（实施前）

- [x] PlanStore
- [x] TaskExecutor（Orchestrator.executeStoredPlan）
- [x] PlanRenderer
- [~] PlanValidator（基础）
- [~] ApprovalManager（reject 无 HTTP）
- [~] PlanRunStore（无 run_steps 表）

---

## 10. PlanValidator 校验规则（§13）

- [x] schemaVersion 是否支持
- [x] kind 是否为 internal_task_plan
- [x] steps 是否有 stepId（经 InternalPlanStepSchema）
- [x] dependsOn 是否有效（`validateTaskGraph`）
- [x] 工具是否存在
- [ ] 工具参数是否符合各工具 zod schema
- [~] 路径是否在 workspace 内（forbiddenPaths 黑名单；非完整 workspace 白名单）
- [x] forbiddenPaths 检查
- [ ] 写操作是否有 backup/rollback 策略声明校验
- [ ] shell 命令是否允许（PlanValidator 未校验 shell 内容）
- [x] 预算是否合理（maxSteps / maxToolCalls）
- [ ] 高风险步骤是否 requiresApproval 强制规则
- [x] planHash 是否正确

---

## 11. 审计日志（§14）

- [~] `plan.created` / `validated` / `preview_rendered` / `approved` / `rejected` / `execution_*`（经 `plan_event` + `eventType` 字段，**非规范独立 event type 名**）
- [x] `plan.superseded`（经 `plan_event` + `eventType=plan.superseded`）
- [ ] `plan.step_started` / `plan.step_completed` / `plan.step_failed`
- [ ] `plan.rollback_started` / `plan.rollback_completed`
- [ ] trace 事件结构与规范 §14 示例完全一致

---

## 12. 关键测试用例（§15）

- [x] **15.1** Executor 拒绝 PublicPlanJson（`tests/plan.test.ts`；错误码 `EXECUTABLE_PREVIEW_REJECTED`，非规范示例 `INVALID_PLAN_KIND`）
- [x] **15.2** Executor 拒绝未审批计划（`PLAN_NOT_APPROVED`）
- [ ] **15.3** 修改 Markdown 不改变 InternalTaskPlan v1（`plan.test.ts` 修订链用例覆盖 supersede，非 Markdown 专属）
- [x] **15.4** 执行 API 拒绝 internalPlan 字段（orchestrator + plan-store 用例）
- [x] **15.5** PublicPlanJson 永远 `executable=false`

---

## 13. 规范 §16 TodoList（逐项对照）

### P0：建立计划对象边界

- [x] 定义 `InternalTaskPlan` 类型
- [x] 定义 `PublicPlanJson` 类型
- [x] 定义 `RenderedPlanPreview` 类型
- [x] 明确 Executor 只接受 `planId + version`
- [x] 禁止 Executor 接受用户传入完整计划 JSON（生产路径）
- [~] 禁止 dry-run 以外一切 inline plan 通道（dry-run legacy 仍开放）

**验收**：InternalTaskPlan 与 PublicPlanJson 已分离；PublicPlanJson 不可直接执行。✅

---

### P0：实现 PlanStore

- [x] 新增 `task_plans` 表
- [x] 新增 `task_plan_versions` 表
- [x] 保存 InternalTaskPlan
- [x] 保存 planHash
- [x] 支持按 planId/version 读取

**验收**：内部执行 JSON 存 PlanStore，预览非执行源。✅

---

### P0：实现 PlanRenderer

- [x] InternalTaskPlan → Markdown
- [x] InternalTaskPlan → PublicPlanJson
- [x] PublicPlanJson 必须 `executable=false`
- [x] 预览内容不包含敏感内部字段

**验收**：用户可见 Markdown/展示 JSON，拿不到完整内部参数。✅

---

### P1：实现 PlanValidator

- [x] 校验 schema
- [ ] 校验工具参数（args zod）
- [x] 校验路径范围 / forbiddenPaths
- [ ] 校验风险等级与 requiresApproval 联动
- [~] 校验权限和预算（基础）
- [ ] 校验 rollback 策略

**验收**：不合法计划无法进入 approved。⚠️ 部分达成

---

### P1：实现审批流程

- [x] 新增 `task_plan_approvals` 表
- [x] 支持 approve/reject（代码 + HTTP）
- [x] approved 前不能执行
- [ ] 高风险步骤必须人工审批（dry-run / autoConfirm 仍可系统审批）

**验收**：未审批不能执行。✅；高风险强制人工审批 ❌

---

### P1：改造 TaskExecutor

- [x] Executor 入参只允许 planId/version（生产）
- [x] Executor 从 PlanStore 加载 InternalTaskPlan
- [x] Executor 校验 planHash
- [x] Executor 校验 status
- [x] Executor 记录 PlanRun（`task_plan_runs`）
- [ ] Executor 不依赖任何前端 JSON（dry-run legacy plan 例外）

**验收**：生产路径不再依赖用户 Markdown/JSON。✅

---

### P2：实现版本修订

- [x] 用户修改建议 → Planner 重生（`revise` / `import-preview` + `planId`）
- [x] 同 planId 递增 version
- [x] 旧版本标记 superseded
- [x] 新版本重新预览、校验、审批（版本链完整流程）

**验收**：用户改 Markdown 只触发新版本，不直接改 v1。✅（经 revise / import-preview）

---

### P2：实现执行审计

- [~] 记录 plan 生命周期事件（泛型 trace）
- [ ] 记录每个 step 执行状态（`task_plan_run_steps`）
- [ ] 记录工具输入输出到 plan run
- [ ] 记录失败原因和回滚信息到 plan 专用 trace

**验收**：任意计划执行可经 plan 专用 trace 复盘。❌

---

### P3：实现前端展示分层

- [x] 前端展示 Markdown（`public/app.js` `renderPlanPreview`）
- [x] 前端展示 PublicPlanJson
- [x] 前端不展示 InternalTaskPlan
- [x] 前端执行按钮只传 planId/version（approve + execute）
- [x] 前端拒绝 / 修订计划 UI（测试台「计划工作流」全流程面板）

**验收**：界面只能看预览，不能把预览当执行体。✅（执行路径）；拒绝/修订 UI ✅

---

## 14. 给 Agent 的实施指令（§17）— 现状扫描

| 扫描项 | 存在 | 说明 |
| --- | --- | --- |
| PlanStore | ✅ | `src/plan/PlanStore.ts` + SQLite 5 表 |
| TaskExecutor | ✅ | `Orchestrator.executeStoredPlan` + `TaskRunner` |
| PlanRenderer | ✅ | `src/plan/PlanRenderer.ts` |
| PlanValidator | ⚠️ | 基础校验，缺 args/shell/rollback 深度校验 |
| ApprovalManager | [x] | approve / reject HTTP 均已暴露 |
| PlanRunStore | ⚠️ | 仅有 `task_plan_runs`，无 step 级表 |

---

## 15. 建议后续补齐顺序（仅供参考，本轮不实施）

1. **P1 收口**：`POST /api/plans/:id/reject`；高风险步骤非 dry-run 禁止系统 auto-approve  
2. **P1 校验**：工具 args zod、shell 允许性、rollback 策略  
3. **P2 版本链**：同 planId version++、superseded、§15.3 测试  
4. **P2 审计**：`task_plan_run_steps` + `plan.step_*` 专用 trace  
5. **P3 UI**：拒绝/修订/版本对比  
6. **兼容收敛**：逐步移除 dry-run inline `plan`，统一 planId 路径  

---

## 16. 相关文档与测试索引

- 说明文档：[计划JSON与Markdown分离.md](计划JSON与Markdown分离.md)
- 单元测试：`agent-relay/tests/plan.test.ts`（6 项）
- 编排测试：`agent-relay/tests/orchestrator.test.ts`（含 `PLAN_BODY_NOT_EXECUTABLE`）
- 网页用例：`agent-relay/public/test-cases/m3-plan-store.json`
- API 规范：`agent-relay/public/api-spec.json`（`/api/plans/*`）

---

*本文随规范落地进度更新；勾选状态以代码与测试为准，不以规范原文 §16 默认为准。*
