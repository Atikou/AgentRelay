# 子 Agent 与动态路由重写 TodoList

依据：`子Agent与动态路由重写设计.md`（用户提供的重写设计）。

**目标**：子 Agent = 通用子任务执行工具（`runSubAgent(DelegatedTask)`）；动态路由 = 主 Agent 执行策略选择器（`ExecutionRouter`），决定何时委派、用什么模型/工具/上下文/限制及结果如何回收。禁止「角色 → 固定模型」静态映射。

## P0 — 类型与核心数据结构（必做）

- [x] **P0-1** 新增 `DelegatedTask` / `ExecutionRoute` / `SubAgentStructuredResult` 类型（`delegatedTask.ts`、`executionRoute.ts`）
- [x] **P0-2** 定义 `TaskLimits` / `ToolPolicy` / `ModelPolicy` / `OutputContract` 与默认预算
- [x] **P0-3** `SubAgentRunOptions` 以 `DelegatedTask` 为主；**已移除** `role` 兼容字段

## P1 — ExecutionRouter（执行策略路由，必做）

- [x] **P1-1** 实现 `ExecutionRouter.route()`：`taskState` → `ExecutionRoute`（direct / delegate / tool / review / ask_user）
- [x] **P1-2** 实现 `TaskSplitter`：复杂任务拆成多个 `DelegatedTask`（并行 batch 入口）
- [x] **P1-3** 委派判断：复杂度、上下文污染、是否可独立执行、是否需干净上下文

## P2 — ContextRouter / ToolRouter（必做）

- [x] **P2-1** `ContextRouter.buildMinimalContext()`：仅组装 goal/instructions/input/files/snippets/logs，不继承主 Agent 全量历史
- [x] **P2-2** `ToolRouter.resolveToolPolicy()`：按任务策略决定 allowedTools / write / shell / approval
- [x] **P2-3** `SubAgentRunner` 按 `toolPolicy` 过滤 `ToolRegistry` 与 `roleAllowedPermissions`

## P3 — ModelRouter 对接（必做）

- [x] **P3-1** `buildDelegatedTaskRouterInput(task)` 替代 `buildSubAgentRouterInput(role, …)`
- [x] **P3-2** `createDelegatedTaskChatFn` 替代 `createSubAgentChatFn`（按 `modelPolicy` + 任务信号选型）
- [x] **P3-3** `analyzeTaskRoutingSignals(task)` 去除对 `SubAgentRoleDefinition` 的依赖

## P4 — SubAgentRunner 重写（必做）

- [x] **P4-1** 主入口 `runDelegated(task)`；干净上下文 + 独立预算（limits）
- [x] **P4-2** 系统提示由 `goal` + `instructions` + `toolPolicy` 生成，非人格角色 prompt
- [x] **P4-3** **已删除** `legacyRoleAdapter` / `roles.ts`；无角色预设兼容
- [x] **P4-4** trace `subagent_start` 记录 `executionRoute` / `modelPolicy` / `toolPolicy`（非 role）

## P5 — ResultCollector（必做）

- [x] **P5-1** `ResultCollector.collect()`：从模型输出解析结构化 `SubAgentStructuredResult`
- [x] **P5-2** `SubAgentRunResult.structured` 暴露 status/summary/findings/evidence/risks/nextActions/confidence/usedModel/usedTools
- [x] **P5-3** `dispatch_subagent` 与 batch aggregate 输出 `structured` 字段

## P6 — 调用入口与 API（必做）

- [x] **P6-1** `dispatch_subagent`：仅 `tasks: DelegatedTask[]`（无 `roles`/`task` 兼容）
- [x] **P6-2** HTTP `POST /api/subagent/run|batch` 仅 `task` / `tasks` 对象；**已移除** `/roles` 与 `/presets`
- [x] **P6-4** `createAppContext` 注入 `createChatForDelegatedTask`

## P7 — 测试、用例与文档（必做）

- [x] **P7-1** `tests/subagent-execution-router.test.ts` + 更新 `dispatch-subagent-tool.test.ts` / `subagent.test.ts`
- [x] **P7-2** `m5-subagent.json` 全面改为 `DelegatedTask` / `tasks[]` 用例
- [x] **P7-3** 重写 `docs/子Agent.md`；更新 `docs/模型路由与协作.md`、`docs/项目整体架构.md`、`AGENTS.md`
- [x] **P7-4** `npm run typecheck` + 专项测试通过

## P8 — 归档旧清单（收尾）

- [ ] **P8-1** `docs/子Agent动态路由修正-TodoList.md` 归档至 `docs/completed/`（可与本轮一并归档）

## 验收标准（摘自设计 §11）

1. ✅ 子 Agent 不再是固定角色（API 以 `DelegatedTask` 为主）
2. ✅ 子 Agent 不绑定具体模型（`modelPolicy` → SmartModelRouter）
3. ✅ 调用入口是通用任务包 `runSubAgent(DelegatedTask)`
4. ✅ 主 Agent 可委派任意明确小任务
5. ✅ 子 Agent 使用独立干净上下文（`ContextRouter`）
6. ✅ 只返回压缩结构化结果（`ResultCollector`）
7. ✅ 动态路由是执行策略路由（`ExecutionRouter`）
8. ✅ 模型选择由 ModelRouter 负责
9. ✅ 工具权限由 `ToolRouter` / route policy 控制
10. ✅ 上下文范围由 `ContextRouter` 控制
11. ✅ 主 Agent 保持全局目标与最终决策权
12. ✅ 子 Agent 不直接回复用户
13. ✅ 不继承完整主上下文
14. ✅ 不无限递归（沿用 `maxDispatchDepth`）
15. ✅ 复杂任务可拆成多个干净上下文子任务并行执行
