# Agent 执行策略问题 — TodoList

> **来源规范**：`Agent_Execution_Policy_Issues_Report.md`  
> **扫描基准**：`agent-relay/src/agent/`（`RunPolicy.ts`、`AgentLoop.ts`）、`Orchestrator`、`tests/loop.test.ts`  
> **生成日期**：2026-06-10  
> **关联索引**：[外部规范-TodoList索引](外部规范-TodoList索引.md)  
> **用途**：对照「计划模式测试失败」报告查漏补缺；**本文仅记录状态，不代表本轮需全部实现**

---

## 0. 观察现象对照（§1）

| # | 现象 | 状态 |
| --- | --- | --- |
| 1 | 只进行一次工具调用就停止 | [~] 低 budget 仍可能；已有 partial 收尾，计划/审阅类项目分析已先走 PlanWorkflow 预扫描 |
| 2 | 停止后无部分分析 | [x] 已修复 |
| 3 | list_files 参数不适合扫描 | [~] 默认值优化；PlanWorkflow 第一版已落地，仍缺可恢复扫描状态 |
| 4 | 日志缺运行元信息 | [x] executionMeta |
| 5 | 计划模式未落实执行层 | [x] 权限拦截 |

## 0b. 根因（§2）

- [x] 非单纯单一循环次数问题，缺 Mode→Policy→Budget→Finalization 完整链路
- [ ] BudgetManager 仍缺；RunStateStore 已落地；PlanWorkflow 第一版已落地

## 完成度概览

| 优先级 | 已完成 | 部分完成 | 未开始 | 合计 |
| --- | ---: | ---: | ---: | ---: |
| P0 | 3 | 0 | 0 | 3 |
| P1 | 3 | 1 | 0 | 4 |
| P2 | 2 | 0 | 1 | 3 |
| P3 | 0 | 1 | 1 | 2 |
| 验收测试 §7 | 4 | 0 | 1 | 5 |
| **合计** | **12** | **2** | **3** | **17** |

**结论**：报告 P0（executionMeta、部分收尾、计划模式写拦截）已落地；`project_scan` 已作为相关文件定位工具落地；PlanWorkflow 第一版已接入 AgentLoop；RunStateStore 续跑与工具结果三层 trace 已落地；仍缺独立 BudgetManager 类。

---

## 1. 核心设计问题对照（§3）

| 问题 | 状态 | 说明 |
| --- | --- | --- |
| 3.1 缺少 RunPolicy | [~] | `RunPolicy.ts` + `resolveRunPolicy` 已实现；无独立 `RunPolicyManager` 类 |
| 3.2 计划模式未落实执行层 | [x] | `MODE_PERMISSIONS.plan` 仅 read；`AgentLoop` 权限拦截 + 测试 |
| 3.3 单一循环次数与 tool/model turns 混用 | [x] | `RunBudget` 拆分模型轮次、工具总数、读/写/shell 与运行时长，循环按分项预算阻断 |
| 3.4 缺少 executionMeta | [x] | `AgentExecutionMeta` + API 返回 |
| 3.5 缺少 Finalization 收尾 | [x] | `buildPartialFinalAnswer()` 预算耗尽时输出部分结论 |
| 3.6 list_files 参数不合理 | [~] | 默认 `limit=500`、忽略目录已优化；无计划模式分步扫描策略 |
| 3.7 缺少 Project Scan Strategy | [x] | `PlanWorkflow` 固定执行 `project_scan` → `locate_relevant_files` → `context_pack` |
| 3.8 缺少 project_scan 工具 | [x] | 已实现 `project_scan`，并补 `locate_relevant_files` / `context_pack` |
| 3.9 缺少继续执行 RunStateStore | [x] | `run_states` 表 + `POST /api/agent/resume` |
| 3.10 工具结果 trace 分层 | [~] | `compactToolOutput` + 4k 截断；非 raw/model/user 三层 |
| 3.11 HTTP 单一循环次数为主调度 | [x] | HTTP 改为 `budget` 对象；省略时由 `RunPolicy` 按模式分配 |

### RunPolicy 接口字段对照（§3.1 建议）

| 字段 | 状态 | 说明 |
| --- | --- | --- |
| `mode` | [x] | `AgentRunMode` |
| `maxModelTurns` | [x] | 各模式默认模型轮次 |
| `maxToolCalls` | [x] | 已在 RunPolicy 类型中并强制 |
| `maxReadCalls` / `maxWriteCalls` / `maxShellCalls` | [x] | 已分项硬限制 |
| `maxRuntimeMs` | [x] | 已限制总运行时长 |
| `allowWrite` | [~] | 经 `allowedPermissions` 间接表达 |
| `allowDangerousShell` | [~] | plan 模式无 shell 权限 |
| `requireFinalAnswer` | [x] | 默认 true |
| `allowPartialAnswer` | [x] | 默认 true + partial 收尾 |

### AgentBudget 拆分（§3.3 建议）

- [x] 独立 `RunBudget` 类型（`maxModelTurns` 等与单一循环次数分离）
- [x] `executionMeta.usedModelTurns` 统计（当前等同 iterations）
- [x] 循环内按 budget 类型分别阻断工具类别

---

## 2. 建议模块（§5）

| 模块 | 状态 | 代码位置 |
| --- | --- | --- |
| RunPolicyManager | [~] | `RunPolicy.ts`（函数式，非 Manager 类） |
| BudgetManager | [~] | 未抽独立类；分项预算已由 `RunPolicy` + `AgentLoop` 强制 |
| ExecutionMetaBuilder | [x] | `AgentLoop.buildExecutionMeta()` |
| Finalizer | [~] | `buildPartialFinalAnswer` 内联，非独立 `Finalizer` 类 |
| PlanWorkflow | [x] | `src/agent/PlanWorkflow.ts` |
| ProjectScanTool | [x] | `project_scan` / `locate_relevant_files` / `context_pack` |
| RunStateStore | [x] | `RunStateStore.ts` + `run_states` 表 + `POST /api/agent/resume` |
| IntentRouter | [~] | `inferRunMode()` + Orchestrator `parseRunMode` |
| WorkflowPlanner | [ ] | 未实现 |
| ToolPermissionManager | [x] | `AgentLoop` + `ToolRegistry` `allowedPermissions` |

---

## 3. 规范 §6 TodoList

### P0：必须先修

#### P0-1：添加 executionMeta

- [x] 响应含 `mode`、`budget`、`usage`、`budgetExhausted`
- [x] `usedIterations`、`usedToolCalls`、`usedReadCalls`、`usedWriteCalls`、`usedShellCalls`
- [x] `stopReason`、`needsMoreBudget`、`suggestedBudget`
- [x] 测试：`tests/loop.test.ts`、`tests/orchestrator.test.ts`

**验收**：✅

---

#### P0-2：预算耗尽时输出 partial final answer

- [x] 不再只返回「未得到最终答案」
- [x] 说明已完成步骤、缺失信息、建议预算、是否修改文件
- [x] `buildPartialFinalAnswer()` 在 `reachedLimit` 时调用
- [x] 测试：低预算 partial 答案（`loop.test.ts`）

**验收**：✅

---

#### P0-3：计划模式禁止写入工具

- [x] `plan` 模式 `allowedPermissions` 仅 read
- [x] `write_file` / `apply_patch` / shell 等在执行层 blocked
- [x] `mode=plan` 即使 `autoConfirm=true` 仍拒绝写入（测试覆盖）
- [ ] 显式拦截 delete / move 等未单独注册工具（若未来新增需补）

**验收**：✅（当前内置工具集）

---

### P1：当前阶段应做

#### P1-1：实现 RunPolicyManager

- [x] `chat` / `plan` / `implement` / `debug` / `review` 独立 policy
- [x] 各模式默认 `RunBudget`
- [x] 各模式 `allowedPermissions` 与 systemHint
- [x] 从消息推断 plan 模式（「计划模式」「只读」等）
- [ ] 独立 `RunPolicyManager` 类（当前为 `resolveRunPolicy` 函数）
- [x] `maxToolCalls` / `maxReadCalls` 等写入 RunPolicy 并在循环中强制

**验收**：⚠️ 策略已有，独立 Manager 类未抽出

---

#### P1-2：拆分预算类型

- [x] `executionMeta` 分别统计 model turns / tool / read / write / shell
- [x] 独立 `RunBudget` 类型与循环内硬限制
- [x] 达到 read 预算后停止 read 类工具并 partial 收尾

**验收**：✅

---

#### P1-3：优化 list_files 策略

- [x] 默认 `DEFAULT_LIST_LIMIT = 500`
- [x] 默认忽略 `node_modules`、`.git`、`dist`、`build`、`.cache`、`.lancedb` 等
- [x] 计划模式专用：由 `PlanWorkflow` 先执行 `project_scan`，替代模型临时决定根目录扫描参数
- [x] 计划模式第二步：由 `locate_relevant_files` 根据目标检索候选文件，替代手写 `list_files` 深度策略
- [x] 系统提示或 PlanWorkflow 约束模型 list_files 参数

**验收**：✅（模式化扫描由 PlanWorkflow 第一版覆盖）

---

#### P1-4：实现 PlanWorkflow

- [x] 固定只读扫描：`project_scan` → `locate_relevant_files` → `context_pack`
- [x] 替代模型临时决定 list_files 参数
- [x] 与 `AgentLoop` 计划/审阅模式集成（`Planner` 结构化计划入口仍保持原链路）

**验收**：✅（第一版）

---

### P2：后续增强

#### P2-1：新增 project_scan 工具

- [x] 只读工具 `project_scan`
- [x] 返回 projectType、package.json scripts、源码根、配置文件、重要目录和关键文件
- [x] 减少计划模式工具轮次（计划/审阅项目分析在模型首轮前固定预扫描）

**验收**：✅（计划/审阅类项目分析已强制优先使用）

---

#### P2-2：实现 RunStateStore

- [x] `RunState`：runId、completedSteps、pendingSteps、scannedPaths、readFiles、toolResultRefs
- [x] 用户「继续上次计划扫描」从 pendingSteps 续跑
- [x] HTTP/API 传 runId 恢复（`POST /api/agent/resume`）

**验收**：✅（`npm run test:run-state-store`）

---

#### P2-3：工具结果 trace 分层

- [x] raw：完整结果在 trace `agent_tool.rawOutput` / `tool_logs`
- [x] model-visible：`compactToolOutput` + `clipModelToolJson` 4k 截断
- [x] user-visible display 独立层 `userDisplay` + `truncated=true` 标记
- [x] 规范三层结构显式类型 `ToolResultLayers` + `AgentToolStep.resultLayers`

**验收**：✅（`npm run test:tool-result-layers`）

---

### P3：长期优化

#### P3-1：自动预算预估

- [x] `suggestedBudget` 按模式给出
- [ ] 按任务复杂度估算 `suggestedToolCalls`
- [ ] `completedSteps` / `missingSteps` 结构化返回（报告 §3.11 示例）

**验收**：⚠️

---

#### P3-2：前端根据模式自动传运行配置

- [x] 测试台选「计划模式」自动 `mode=plan`，预算由 `RunPolicy` 或显式 `budget` 控制
- [~] `/api/agent` 支持 `mode` 入参；前端是否默认传 plan 待确认

**验收**：⚠️

---

## 4. 推荐验收测试（§7）

- [x] **测试 1** 计划模式低 budget → 部分扫描 + 建议预算 + 未改文件（`loop.test.ts`）
- [x] **测试 2** 计划模式禁止写入（`loop.test.ts`）
- [x] **测试 3** 不传 budget → plan 默认 `budget.maxModelTurns=16` 且写/shell 预算为 0（`orchestrator.test.ts`）
- [x] **测试 4** list_files 大量结果 → raw trace 完整 + model summary + truncated 标记（`tool-result-layers.test.ts`）
- [x] **测试 5** runId 续跑 pendingSteps（`run-state-store.test.ts`）

---

## 4b. 给 Agent 的实施指令（§8）— 测试要求

规范要求实现后必须验证：

- [x] 计划模式不会写文件
- [x] 预算耗尽仍能输出部分分析
- [x] executionMeta 能准确显示停止原因
- [x] 不同模式使用不同预算策略（`loop.test.ts` / `orchestrator.test.ts`）
- [x] 禁止「只调大单一循环次数」作为唯一修复：接口已删除单一循环次数，改为分项预算

---

## 4c. 最终结论优先项（§9）

规范列出的最优先模块：

| 模块 | 状态 |
| --- | --- |
| RunPolicyManager | [~] `resolveRunPolicy` |
| BudgetManager | [~] 分项预算已强制，尚未抽独立类 |
| executionMeta | [x] |
| partial final answer | [x] |
| PlanWorkflow | [x] |
| tool result trace 分层 | [x] `ToolResultLayers` + `resultLayers` on steps |

---

## 5. 推荐修复架构（§4）落地情况

```text
用户输入 → IntentRouter(inferRunMode) ✅
  → RunPolicy(resolveRunPolicy) ✅
  → BudgetManager ❌
  → ToolPermissionManager ✅
  → WorkflowPlanner/PlanWorkflow ✅
  → AgentLoop ✅
  → TraceRecorder ✅
  → Finalizer(内联 partial) ✅
  → RunStateStore ✅
```

---

## 6. 相关代码与测试索引

| 路径 | 说明 |
| --- | --- |
| `src/agent/RunPolicy.ts` | 模式、预算默认值、权限、executionMeta 类型 |
| `src/agent/AgentLoop.ts` | 循环、partial 收尾、权限拦截、meta 构建 |
| `src/orchestrator/Orchestrator.ts` | `/api/agent` 解析 mode 与 policy |
| `tests/loop.test.ts` | P0/P1 核心行为 |
| `public/test-cases/m1-agent.json` | 网页验收（plan 模式、非法 mode） |
| `docs/对话循环.md` | 已文档化 executionMeta 与只读 plan |

---

*本文随执行策略落地进度更新；勾选以代码与测试为准。*
