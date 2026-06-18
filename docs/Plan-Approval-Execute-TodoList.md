# Plan → Approval → Execute 工作流 — TodoList

> **来源**：`Plan_Approval_Execute_Workflow.md`（权限申请与恢复执行机制）  
> **关联**：[计划执行升级-TodoList.md](计划执行升级-TodoList.md)、[API参考.md](API参考.md)  
> **验收**：模块是否验收仍以 `项目验收清单.md` 人类勾选为准。

## 完成度概览

| 优先级 | 主题 | 状态 |
| --- | --- | --- |
| P0 | 复合 plan 意图（plan_only / plan_wait_approval / plan_then_execute） | 已落地 |
| P0 | 通用 PermissionRequest 固定 JSON + Store | 已落地 |
| P0 | Permission API（查询 / 响应）+ Run approve | 已落地 |
| P0 | 测试台右侧权限弹窗（允许 / 拒绝 / 本次会话都允许） | 已落地 |
| P1 | JIT（just-in-time）工具级权限：真要调用副作用工具时就地暂停 | 已落地 |
| P1 | 对话快照忠实续跑（同 Run 消息链恢复，非重新喊话） | 已落地 |
| P1 | PermissionGuard 接入 session scoped grants | 已落地 |
| P2 | TaskRunner DAG 与权限申请联动 | 未开始 |

## 链路约定（强制，第一性原则）

**核心**：权限暂停不是「结束本轮 + 下次重新喊话」，而是「就地冻结同一段对话」。用户批准后用对话快照**忠实续跑**——执行那个被批准的工具或按计划进入执行阶段，全程复用同一条 `messages` 链。

1. 模型在循环中真要调用副作用工具（write/shell/…）→ `PermissionGuard` 判定 needsConfirmation → `AgentLoop` **就地暂停**：把当前对话快照写入 `PausedRunStore`（含 messages、已完成步骤、工作流阶段产物、被阻塞的 `pendingAction`），返回**精确到该工具调用**（文件/命令）的 `permissionRequest` + 侧栏弹窗。
2. 用户点 **允许 / 本次会话都允许** → `POST /api/permission-requests/:id/respond`。
3. 测试台随即调用 `POST /api/runs/:runId/resume-permission` → `Orchestrator.resumeAfterPermission` 取出快照，构造带 `pausedRun` 的 `AgentLoop`：**先执行被批准的工具，再继续模型循环**，沿用原模式/策略 + 作用域授权。
4. 若执行中再次遇到副作用工具 → 再次 JIT 暂停 → 再次弹窗（多轮 JIT），与主流 agent 一致。

**计划→执行交接**（`plan_wait_approval` / `plan_then_execute`）：只读计划阶段产出计划后，冻结对话快照并申请「是否批准执行」。批准后 `resumeAfterPermission` 切到 `implement`，用快照里的计划上下文忠实续跑（系统提示同步换成执行阶段；本次会话都允许→`autoEdit`，仅一次→`confirmBeforeEdit` 即逐次 JIT），危险操作仍由 `PermissionGuard` 强制再确认。快照会保留 `workflowProposals` / `workflowDebugAnalyses` / `workflowRefactorPlans` / `workflowInternalPlans`；若计划阶段本身没有生成 edit/generate-file proposal，恢复时会基于“已批准计划交接”补一个最小 proposal artifact，避免 `WorkflowWriteGate` 误判缺少 proposal/analysis 阶段并拦截首次写入。

> 已删除的错误逻辑：① 用正则从计划 Markdown 猜权限（`planPermissionExtractor`）；② 批准后用合成「假用户消息」重新 prompt（`permissionResumeMessage`）；③ 靠检测「继续」短语推进。普通 `/api/agent` 新消息**不会**、也**不应**解析「继续」替代弹窗续跑。

---

- [x] `planExecutionVariant`：识别 plan_only / plan_wait_approval / plan_then_execute
- [x] `PermissionRequestPayload` schemaVersion=1 固定 JSON
- [x] `PermissionRequestStore` + `SessionPermissionGrants`
- [x] `GET/POST /api/permission-requests/*`、`POST /api/runs/:id/approve`
- [x] `app.js` 右侧权限弹窗三按钮

## P1（第一性原则重写，2026-06-18）

- [x] `PausedRunStore` + `PausedRunSnapshot`：对话快照按 runId 暂存
- [x] `PausedRunSnapshot` 保存并恢复工作流阶段产物；计划批准但无 proposal 时会生成 handoff proposal，首次写入不会被 proposal 门禁误拦截
- [x] `AgentLoop` JIT：副作用工具被阻塞时就地冻结对话并申请精确权限
- [x] `AgentLoop` 忠实续跑：从快照执行被批准工具 / 按计划进入执行阶段，复用同一 messages 链
- [x] `resumeAfterPermission` 基于快照续跑（去掉合成续跑消息与正则权限提取）
- [x] `parseAction` 兼容模型偶发返回的字符串化 JSON 动作，减少权限恢复后无效 parse_error 重试
- [x] 删除 `planPermissionExtractor.ts` 与 `permissionResumeMessage.ts`

## P2

- [ ] InternalTaskPlan DAG 逐步权限门控
- [ ] `PausedRunStore` 落盘持久化（当前为内存态，服务重启丢失，与权限申请一致）

## 落地文件索引

| 能力 | 路径 |
| --- | --- |
| 固定 JSON 类型 | `agent-relay/src/policy/permissionRequestTypes.ts` |
| 申请存储 | `agent-relay/src/policy/PermissionRequestStore.ts` |
| 会话授权 | `agent-relay/src/policy/SessionPermissionGrants.ts` |
| 作用域校验 | `agent-relay/src/policy/scopedPermissionCheck.ts` |
| plan 变体 | `agent-relay/src/agent/planExecutionVariant.ts` |
| **暂停快照** | `agent-relay/src/agent/PausedRunStore.ts` |
| **JIT 暂停 + 忠实续跑** | `agent-relay/src/agent/AgentLoop.ts`（`pauseForToolPermission` / `resumePendingAction` / `snapshotPausedRun`） |
| HTTP | `agent-relay/src/server/handlers/permission.handlers.ts` |
| 续跑 | `Orchestrator.resumeAfterPermission` |
| 测试台 UI | `agent-relay/public/app.js` + `styles.css` |
