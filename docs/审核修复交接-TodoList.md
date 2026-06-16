# 审核修复交接 TodoList

> **给接手 agent**：本文件是 `docs/项目审核报告.md`（独立定义基线审核）落地工作的**交接说明**。
> 先读「0. 5 分钟上手」，再按「3. 待办」挑一项推进。每完成一大项 = 一次 `git commit`（见「5. 工作纪律」）。
> 上下文与判定理由全部在 `docs/项目审核报告.md`（§4 建议、§6 修复进展）与 `docs/自审核记录.md`（最新两条）。

---

## 0. 5 分钟上手

- **项目**：`agent-relay/`（TypeScript ESM，NodeNext，导入路径带 `.js`，`strict` + `noUncheckedIndexedAccess`）。所有命令在 `agent-relay/` 下跑。
- **基线状态**：**全量 `npm test` 当前为绿（exit 0）**，可作为任何重构的安全网。改动后务必保持绿。
- **入口阅读顺序**：`AGENTS.md` → `docs/自审核记录.md`（最新在上）→ `docs/项目审核报告.md`（§4 + §6）→ 本文件。
- **核心命令**：

```bash
cd agent-relay
npm run typecheck     # 提交前必跑
npm test              # 全量自检，必须 exit 0
npx tsx tests/xxx.test.ts   # 跑单个测试文件（项目用 tsx，不用 vitest 命令）
```

- **环境注意**：Windows + PowerShell。**git commit 用 `-F 文件`**（PowerShell 不支持 bash heredoc，`&&` 也不可用，改用 `;`）。

---

## 1. 这次审核在解决什么

`docs/项目审核报告.md` 以「审核人独立定义」为基线，对 22 个 `src/` 模块逐一判定是否偏离定义，结论是：

- **出发点就错**：子 Agent 曾被当「角色」而非「工具」（**已在 `d29342e` 修复**）；`policy/` 权限层序倒置（**本轮 §4-4 已修**）。
- **中途漂移**（绝大多数）：双路由轨道未退役、god-object 群、跨层反向依赖、「承诺先行未落地」（lifecycle 声明了一堆未实现策略）。

§4 把修复建议排成 P0–P3 共 12 项。下面是逐项状态。

---

## 2. 已完成（7 项 + 1 前置，均已提交 & 全量测试绿）

| commit | 审核项 | 做了什么 |
|---|---|---|
| `9895d78` | 前置 / §4-6 / §4-7 / §4-10(部分) | 打破 `trace/` 控制流环（新增叶子 `src/trace/traceReplayTypes.ts`，`traceQuery`/`traceReader`/`traceCatalog` 改单向）→ **解锁全量测试**；修 `tools.test` 内置工具清单 + `Orchestrator.runAgentStream` 事件乱序；`ToolResultLayers` 迁到 `src/util/toolResultLayers.ts`（消除 `context→agent` 反向依赖）；`dispatch_subagent` `hasSideEffect:false→true`（诚实化）；删 `types/index.ts`、`traceCatalog.activeSegmentRel`、`handleContextSessionDelete`、`ModuleDependencyGraph` |
| `524ce7f` | §4-2 | 从 `Orchestrator` 抽出 `orchestrator/ChatService.ts`（`runChat`/`runChatStream`），2015→1643 行 |
| `d8f2662` | §4-4 | 权限词汇下沉 `core/permissions.ts`（删 `agent/permissions.ts`），消除 `policy→agent` 反向依赖；导入路径脚本批量改写 |
| `f564f39` | §4-5 | 迁移清单 `memoryDbMigrations.ts` 由 `storage/` 移到 `context/`（唯一消费者 `DatabaseManager`），消除 `storage→model-router` 依赖 |
| `696dabd` | §4-10(收尾) | 删 `util/patch.ts`（劣质重复，生产预览用 `buildUnifiedDiff`+`truncateDiff`）；`CleanupJournal.listRecent` 接线为 `GET /api/storage/cleanup/runs`（+ api-spec + 2 条网页用例）；修 `m10-storage-lifecycle.json` 非法 JSON |

> 结论：**所有「缺陷型 / 诚实性 / 分层倒置 / 死代码」类问题已修复并提交。** 剩下的是退役/重写类大件与结构性优化。

---

## 3. 待办（接手从这里开始）

### 优先级建议：先做风险低、收益清晰的 §4-12 → §4-11 → §4-8，最后碰 §4-9 / §4-1 / §4-3。

### 🟢 §4-12 统一模式词汇 + 合并意图正则（低风险，建议先做）
- **问题**：`src/agent/IntentRouter.ts` 与 `src/agent/WorkflowPlanner.ts` 各维护一套中英文意图/模式正则，词汇不统一、规则重复，易漂移。
- **第一步**：通读这两个文件，列出双方的正则与模式枚举，找出重叠项。
- **落地**：抽一个共享的「意图→模式」词表/规则模块（放 `agent/` 或 `core/`），两边复用；保持对外行为不变（用现有 `tests/` 中意图/工作流相关用例守护，必要时补用例）。
- **验收**：`npm test` 绿；意图识别结果不回退。

### 🟢 §4-11 拆分 `locationTools` + 外置启发式（中等）
- **问题**：`src/tools/locationTools.ts`（~1374 行）混了多个工具实现 + 仓库特定启发式（硬编码路径/扩展名偏好）。
- **第一步**：`Read` 该文件，按工具边界（`locate_relevant_files` / `context_pack` / `symbol_search` 等）切分职责。
- **落地**：按工具拆成多文件；把「仓库特定启发式」抽成可配置数据（避免散落 if/正则）。注意保留 `executionMeta.location`（含 `exploration` / `suggestedAction`）的对外结构。
- **验收**：定位相关测试（见 `docs/相关文件定位优化-TodoList.md` 对应用例）绿。

### 🟡 §4-8 收敛计划模型（中等）
- **问题**：存在 `agent/types.Plan` 与 `plan/` 下多种计划表示之间的转换垫片（`planConverter.ts` 等），表示分散。
- **第一步**：梳理 `src/plan/types.ts`、`planConverter.ts` 与 `agent/types.ts` 的 `Plan`，画出转换链。
- **落地**：确立单一可执行表示，逐步弃用 `agent/types.Plan` 垫片（分步，别一次性删）。
- **验收**：`tests/plan*.test.ts` 全绿；analyze/compile/execute 链路不变。

### 🟡 §4-9 `lifecycle/` 兑现或删除已声明策略（较大，会级联）
- **问题**：`src/lifecycle/types.ts` / `policy.ts` 声明了一批**未实现**的策略，属「承诺先行」：
  - gzip/zstd **trace 段压缩**（注意：实现后 **`trace/traceReader` 必须能解压 `.gz` 段**，是级联点）；
  - `delete_db_rows` / `vacuum_db` 动作；
  - `traceRaw*` / `toolArgs` / `routeDetails` 等**行级保留**；quotas；scheduler journal 保留；
  - `DataLifecycleService.loadPreviewsFromDisk()` 是空桩。
- **两种合规收尾**（择一，别留半成品）：
  - **A 实现**：先做**不级联**的（db 行级保留 + vacuum、scheduler journal 清理），gzip 压缩单独一提交并同步改 reader；
  - **B 删承诺**：把 `policy`/`types` 中确实不打算做的字段删掉，让模块停止过度承诺。
- **验收**：`tests/` lifecycle / storage 相关绿；`GET /api/storage/*` 行为与文档一致。

### 🔴 §4-1 退役遗留 `ModelRouter` 双轨（高风险，**当前暂缓**）
- **为什么暂缓**：`src/model-router/create-model-chat.ts`（Smart 栈）**绕过了 `src/model/ModelRouter.ts` 在远程调用前做的 prompt 脱敏**（安全特性），且流式 / fallback 未在 Smart 路径对齐。**盲删 = 静默安全回退**。
- **安全落地顺序**：① 在 Smart 路径补齐「远程调用前 prompt 脱敏」并加 mock 测试守护 → ② 补齐流式 / fallback 对齐 → ③ 再把显式 `clientName` 路径切到 Smart → ④ 最后删 `ModelRouter`。**没有活动后端联调能力时不要做第 ③④ 步。**

### 🔴 §4-3 抽 `AgentLoop` 工作流编排（高风险，**当前暂缓**）
- **为什么暂缓**：`src/agent/AgentLoop.ts`（~1650 行）是执行核心，重写回归面大、微妙行为（预算/确认/恢复/timeline 时序）难在无联调下验证。
- **建议**：等有联调环境，**小步抽离**（一次抽一个职责，如先抽「工作流路由」再抽「预算/收尾」），每步全量回归并单独提交。

---

## 4. 已知的「非本任务」工作区噪音

`git status --short` 里有一批**与审核修复无关**的既有改动（自会话起点起就是 `M`）：`agent-relay/package.json`、`public/test-cases/m2-routing.json`/`m3-plan-store.json`/`m5-subagent.json`、`src/plan/*`、`src/subagent/*`、若干 `tests/*` 与部分 `docs/*` 的行尾归一化类 diff。

- **本次审核修复的所有提交都没有混入这些文件。**
- 接手前请先和用户确认这些改动如何处理；**不要**用 `git reset --hard` / `git clean -fd` 等破坏性命令替人决定。

---

## 5. 工作纪律（来自 AGENTS.md，务必遵守）

1. **每完成一大项就提交一次**：提交前至少 `npm run typecheck`，跨模块跑 `npm test`；commit 用 `git commit -F 临时消息文件`（PowerShell）。
2. **只提交本轮相关文件**，别把第 4 节的噪音混进去。
3. **文档同步是 DoD 的一部分**：改架构/模块 → 更新 `docs/项目整体架构.md`；改进度 → 更新 `agent-todolist.md` + `AGENTS.md`「当前进度」；同步在 `docs/项目审核报告.md` §6 勾掉对应项。
4. **测试用例双轨**：新增/改功能要在 `public/test-cases/` 对应功能页加 **≥2 条**用例（含 `purpose`）。
5. **结束任务前写自审核**：追加到 `docs/自审核记录.md`（最新在上），标题时间用**北京时间（Asia/Shanghai）**。
6. **安全默认**：删文件/覆盖配置/装依赖/`git push`/联网执行脚本默认需确认，不可自动执行。

---

## 6. 一句话总结

> 缺陷型问题已全部修复并提交（全量测试绿）；接手请按 **§4-12 → §4-11 → §4-8** 推进结构性优化，**§4-9** 二选一收尾，**§4-1 / §4-3** 等联调环境再小步落地。每完成一项提交一次并同步文档与自审核。
