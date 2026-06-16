# 审核修复交接 TodoList

> **给接手 agent**：本文件是 `docs/项目审核报告.md`（独立定义基线审核）落地工作的**交接说明**。
> 上下文与判定理由见 `docs/项目审核报告.md` §6 与 `docs/自审核记录.md`（最新在上）。

---

## 0. 5 分钟上手

- **项目**：`agent-relay/`（TypeScript ESM，NodeNext）。所有命令在 `agent-relay/` 下跑。
- **基线状态**：**全量 `npm test` 绿（exit 0）**（含本轮新增专项测试）。
- **核心命令**：`npm run typecheck`；`npm test`；`npx tsx tests/smart-chat-redact.test.ts`；`npx tsx tests/trace-rotation.test.ts`
- **PowerShell**：`git commit -F 文件`（不用 heredoc）。

---

## 1. 已完成（§4 共 12 项）

| commit | 项 | 摘要 |
|---|---|---|
| `9895d78` | 前置/§4-6/7/10 | trace 环打破；全量测试解锁；ToolResultLayers 下沉；dispatch_subagent 诚实化；首批死代码 |
| `524ce7f` | §4-2 | ChatService 抽出 |
| `d8f2662` | §4-4 | 权限下沉 core/ |
| `f564f39` | §4-5 | memoryDbMigrations 迁 context/ |
| `696dabd` | §4-10 | 死代码收尾 + cleanup runs API |
| `ea5ea8d` | §4-12 | intentPatterns 共享模块 |
| `27c7b57` | §4-11 | locationTools 拆分为 tools/location/ |
| `f672b16` | §4-8 | ExecutableTaskPlan + toTaskRunnerPlan |
| `da70a9a` | §4-9 部分 | scheduler journal 压紧；loadPreviewsFromDisk |
| **工作区** | §4-1 第一步 | `prepareRemoteChatRequest` + Smart `create-model-chat` 脱敏 |
| **工作区** | §4-9 续 | trace `.jsonl.gz` + reader；cleanup 后 `runSqliteMaintenance` |

---

## 2. 剩余待办（2 类暂缓 + 1 类局部）

### 🔴 §4-1 退役 `ModelRouter` 双轨（脱敏已对齐，仍暂缓）

**已完成第一步**：远程 prompt 脱敏已接入 Smart 栈。后续：流式/fallback 对齐 → 显式 `clientName` 切换 → 删 `ModelRouter`。

### 🔴 §4-3 抽 `AgentLoop` 工作流编排（暂缓）

~1650 行执行核心，小步抽离，每步全量回归。

### 🟡 §4-9 lifecycle 局部剩余

- `delete_db_rows`（planner 尚未生成此类 action）
- trace 行级保留（`traceRaw*` / `toolArgs` / `routeDetails`）

**已做（工作区）**：gzip segment（`lifecycle.trace.compressOldSegments: true` 时生效）、`traceReader`/`traceQuery` 读 `.gz`、cleanup apply 后 WAL/VACUUM（`sqliteMaintenance.ts`）。

---

## 3. 工作区噪音

与审核无关的 `M` 文件（`package.json`、`plan/*`、`subagent/*` 等）请勿混入提交；勿用破坏性 git 命令替用户决定。

---

## 4. 一句话

> **§4-1 / §4-3 仍暂缓**；**§4-9 剩 db 行级删除 + trace 行级保留**；其余 §4 项（含脱敏与 gzip）已在工作区落地且全量测试绿，**待用户确认后分 commit 提交**。
