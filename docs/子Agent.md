# 子 Agent（M5）

M5 子 Agent：独立上下文、父 Agent 显式授权、结果汇总、冲突检测、完成通知与有界派生深度。只读角色 `code_review` / `test_analyze`；写权限角色 `patch_worker`（须 `grantedPermissions` 含 `write`）。**不支持无限递归派生**。

## 内置角色

| 角色 ID | 名称 | 权限 | 用途 |
| --- | --- | --- | --- |
| `code_review` | 代码审查 | `read` | 只读审查；任务含文件路径时预读 + 单次审查 |
| `test_analyze` | 测试分析 | `read` | 只读分析测试/日志输出 |
| `patch_worker` | 补丁执行 | `read` + `write`（须显式授予） | 父 Agent 授权下最小 `apply_patch` / `write_file`；无 shell |

父 Agent 通过 `grantedPermissions` 授权，**必须是角色允许集的子集**；`patch_worker` 必须显式传入 `["read","write"]`。

## 有界递归（`security.subagent.maxDispatchDepth`）

| 配置值 | 行为 |
| --- | --- |
| `1`（默认） | 仅主 Agent（depth=0）可 `dispatch_subagent` |
| `2` | 子 Agent（depth=1）可再派生一层 |
| `0` | 禁止一切派生 |

**不做无限递归**；`dispatch_subagent` 与 `AgentLoop` 双重门控。

## 完成通知

子 Agent 运行结束（含 timeout/failed）后，`SubAgentRunner` 向 `NotificationQueue` 写入 `source=subagent` 通知；主 `AgentLoop` 在安全点 `drain` 后回灌模型。测试台「通知队列」面板可查看。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/subagent/roles` | 列出角色与权限 |
| `POST` | `/api/subagent/run` | 运行单个子 Agent |
| `POST` | `/api/subagent/batch` | 并行派生多个角色并汇总 |
| `GET` | `/api/subagent/running` | 列出运行中的子 Agent（`subAgentId`、角色、父任务） |
| `POST` | `/api/subagent/cancel` | 显式取消运行中的子 Agent |

### POST /api/subagent/run

```json
{
  "role": "patch_worker",
  "task": "修复 src/foo.ts 的拼写错误",
  "grantedPermissions": ["read", "write"],
  "parentTaskId": "可选"
}
```

### POST /api/subagent/batch

```json
{
  "roles": ["code_review", "test_analyze"],
  "task": "检查最近一次改动的风险",
  "arbitrateConflicts": true,
  "autoMergeWrites": true,
  "writeFilePickStrategy": "arbitration"
}
```

`arbitrateConflicts: true` 时，若存在文本结论冲突或写入同一文件冲突，会在 `aggregate.arbitration` 附加模型仲裁建议。

`autoMergeWrites: true` 时，对 `writeConflicts` 尝试自动处理：

- **apply_patch**：以最早 `changeId` 备份为基线，顺序重放非重叠补丁
- **write_file**（多份全量覆盖）：`writeFilePickStrategy` 选版（默认 `arbitration`，无 `WRITE_PICK` 时回退 `latest`）

仲裁摘要末尾应含 `WRITE_PICK: path=... changeId=... role=...` 行，供自动选版解析；成功写入 `aggregate.writeMerges`，`write_file` 与 `apply_patch` 混用仍标记 `manual_required`。

`aggregate` 含 `conflicts`（结论层）、`writeConflicts`（未解决文件层）、`writeMerges`（合并尝试）、可选 `arbitration`。

## 主 Agent 调度工具

主 Agent 在 `/api/agent` 内通过 **`dispatch_subagent`** 派生（见 `docs/对话循环.md`）。

```json
{
  "action": "tool",
  "tool": "dispatch_subagent",
  "input": {
    "roles": ["code_review", "test_analyze"],
    "task": "审查最近改动",
    "arbitrateConflicts": true,
    "autoMergeWrites": true
  }
}
```

`patch_worker` 时 `grantedPermissions` 必填且须含 `write`。

模型调用容错：

- `dispatch_subagent` 会在校验前保守归一化常见模型错参：`task` 数组会被合并成字符串，空对象 `context: {}` 会转成 `context: ""`，`writeFilePickStrategy: null` 会被当作未传。
- 常见角色别名会映射到内置角色：学习计划/审查类 → `code_review`，时间/风险/测试分析类 → `test_analyze`，补丁/修改类 → `patch_worker`。
- 如果模型在只读分析任务里混入 `patch_worker` 但只授予 `read`，且同时还有只读角色，系统会移除未授权的 `patch_worker`，避免读任务被写权限角色阻断。
- 主 Agent 已成功收集 3 个 `dispatch_subagent` 结果后，再继续派生会被阻止，并提示直接汇总已有结果输出 `final`，避免预算耗尽。

### POST /api/subagent/cancel

```json
{ "subAgentId": "来自 run/batch 返回的 result.id" }
```

响应 `status: "cancelling"` 表示取消信号已发出；子 Agent 在模型轮次/工具步安全点结束后以 `cancelled` 状态收尾，并写入 `source=subagent` 通知。若 `subAgentId` 不在运行中返回 404。

`GET /api/subagent/running` 可查询当前运行列表，便于测试台或父 Agent 选取 `subAgentId`。

## 测试台

侧栏 **子 Agent (M5)**：选择单角色或并行多角色，填写任务与上下文后运行。

## 代码位置

```text
agent-relay/src/subagent/
├─ roles.ts
├─ notifyCompletion.ts     # 完成通知入队
├─ SubAgentRunner.ts
├─ SubAgentRunRegistry.ts   # 运行中登记与显式 cancel
├─ SubAgentCoordinator.ts
├─ SubAgentArbitrator.ts   # 模型仲裁复核
├─ writeConflictMerge.ts   # 写入同一文件冲突检测
├─ writeConflictAutoMerge.ts # apply_patch 三路合并 + write_file 选版
├─ writeFileVersionPick.ts  # WRITE_PICK 解析与选版策略
└─ types.ts

agent-relay/src/tools/subagentTool.ts
```

自检：`npm run test:subagent`（20 项）、`npm run test:dispatch-subagent`（10 项）。
