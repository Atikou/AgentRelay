# 审核修复交接 TodoList

> **给接手 agent**：本文件是 `docs/项目审核报告.md`（独立定义基线审核）落地工作的**交接说明**。

---

## 0. 5 分钟上手

- **项目**：`agent-relay/`（TypeScript ESM，NodeNext）。命令在 `agent-relay/` 下跑。
- **基线**：`npm run typecheck`；`npm test`；`npx tsx tests/smart-chat-stream.test.ts`
- **PowerShell**：`git commit -F 文件`

---

## 1. 已完成（§4 共 12 项，11 项 + §4-1 第二步）

| commit | 项 | 摘要 |
|---|---|---|
| `d61f54e` | §4-9 收尾 | delete_db_rows + trace 行级字段裁剪 |
| `7363090` | §4-1 第一步 | Smart 路径远程脱敏 |
| `640e605` | §4-9 续 | trace gzip + sqlite maintenance |
| … | §4-2~12 | 见 `docs/项目审核报告.md` §6 |
| `e022978` | §4-1 第二步 | `/api/chat/stream` Smart + onToken |

---

## 2. 剩余待办

### §4-1 退役 `ModelRouter` 双轨（进行中）

- ✅ 脱敏对齐；✅ 流式 Smart 路径（单模型管线透传 onToken；协作策略仍整段返回）
- 待做：显式 `clientName` 切换策略统一；删除 `ModelRouter` 与 `createAppContext` 双轨注入

### §4-3 抽 `AgentLoop` 工作流编排（暂缓）

~1650 行执行核心，小步抽离 + 全量回归。

### §4-9 可选

`quotas.traceRawBytes` 超配额删最旧 trace 段。

---

## 3. 一句话

> 审核 §4 **剩 §4-1 收尾（删 ModelRouter）与 §4-3**；lifecycle 主承诺已兑现。
