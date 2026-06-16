# 审核修复交接 TodoList

> **给接手 agent**：本文件是 `docs/项目审核报告.md`（独立定义基线审核）落地工作的**交接说明**。
> 上下文与判定理由见 `docs/项目审核报告.md` §6 与 `docs/自审核记录.md`（最新在上）。

---

## 0. 5 分钟上手

- **项目**：`agent-relay/`（TypeScript ESM，NodeNext）。所有命令在 `agent-relay/` 下跑。
- **基线状态**：**全量 `npm test` 绿（exit 0）**。
- **核心命令**：`npm run typecheck`；`npm test`；`npx tsx tests/xxx.test.ts`
- **PowerShell**：`git commit -F 文件`（不用 heredoc）。

---

## 1. 已完成（§4 共 12 项中 10 项已落地或部分落地）

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
| `da70a9a` | §4-9 部分 | scheduler journal 压紧；loadPreviewsFromDisk；compress 默认 false |

---

## 2. 剩余待办（仅 3 类）

### 🔴 §4-1 退役 `ModelRouter` 双轨（暂缓，需联调）

Smart 栈须先补齐：**远程 prompt 脱敏** → 流式/fallback 对齐 → 再切换显式 clientName → 最后删 `ModelRouter`。

### 🔴 §4-3 抽 `AgentLoop` 工作流编排（暂缓，需联调）

~1650 行执行核心，小步抽离，每步全量回归。

### 🟡 §4-9 lifecycle 剩余未接线项

- gzip/zstd trace 段压缩（**级联**：`traceReader` 须能读 `.gz`）
- `delete_db_rows` / `vacuum_db` 清理动作（executor 尚未支持）
- trace 行级保留（`traceRaw*` / `toolArgs` / `routeDetails` 等 retention 字段）

**已做**：scheduler journal compact、preview 磁盘恢复、policy 默认不再承诺 trace gzip。

---

## 3. 工作区噪音

与审核无关的 `M` 文件（`package.json`、`plan/*`、`subagent/*` 等）请勿混入提交；勿用破坏性 git 命令替用户决定。

---

## 4. 一句话

> 审核修复清单 **§4-1 / §4-3 暂缓**；**§4-9 剩 trace gzip + db 行级清理**；其余 §4 项已提交且全量测试绿。
