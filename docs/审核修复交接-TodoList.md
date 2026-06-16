# 审核修复交接 TodoList

> **给接手 agent**：本文件是 `docs/项目审核报告.md`（独立定义基线审核）落地工作的**交接说明**。
> 上下文与判定理由见 `docs/项目审核报告.md` §6 与 `docs/自审核记录.md`（最新在上）。

---

## 0. 5 分钟上手

- **项目**：`agent-relay/`（TypeScript ESM，NodeNext）。所有命令在 `agent-relay/` 下跑。
- **基线状态**：**全量 `npm test` 绿（exit 0）**。
- **核心命令**：`npm run typecheck`；`npm test`；`npx tsx tests/data-lifecycle-retention.test.ts`
- **PowerShell**：`git commit -F 文件`（不用 heredoc）。

---

## 1. 已完成（§4 共 12 项，11 项已落地）

| commit | 项 | 摘要 |
|---|---|---|
| `9895d78` | 前置/§4-6/7/10 | trace 环打破；ToolResultLayers；dispatch_subagent；死代码 |
| `524ce7f` | §4-2 | ChatService 抽出 |
| `d8f2662` | §4-4 | 权限下沉 core/ |
| `f564f39` | §4-5 | memoryDbMigrations 迁 context/ |
| `696dabd` | §4-10 | 死代码收尾 + cleanup runs API |
| `ea5ea8d` | §4-12 | intentPatterns |
| `27c7b57` | §4-11 | locationTools 拆分 |
| `f672b16` | §4-8 | ExecutableTaskPlan |
| `da70a9a` | §4-9 部分 | scheduler journal；loadPreviewsFromDisk |
| `7363090` | §4-1 第一步 | Smart 路径远程脱敏 |
| `640e605` | §4-9 续 | trace gzip + sqlite maintenance |
| **待提交** | §4-9 收尾 | delete_db_rows + trace 行级字段裁剪 |

---

## 2. 剩余待办（仅 2 类暂缓）

### §4-1 退役 `ModelRouter` 双轨（脱敏已对齐，仍暂缓）

后续：流式/fallback 对齐 → 显式 `clientName` 切换 → 删 `ModelRouter`。

### §4-3 抽 `AgentLoop` 工作流编排（暂缓）

~1650 行执行核心，小步抽离，每步全量回归。

### §4-9 可选后续（非阻塞）

- `quotas.traceRawBytes` 等配额超限时删最旧 trace 段（当前仅字段裁剪 + 文件级 safe 清理）

---

## 3. 工作区噪音

与审核无关的 `M` 文件（`package.json`、`plan/*`、`subagent/*` 等）请勿混入提交。

---

## 4. 一句话

> 审核 §4 **仅剩 §4-1 全量退役与 §4-3 AgentLoop 抽取**；§4-9 lifecycle 承诺已基本兑现。
