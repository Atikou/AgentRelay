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
  "arbitrateConflicts": true
}
```

`arbitrateConflicts: true` 时，若存在文本结论冲突或写入同一文件冲突，会在 `aggregate.arbitration` 附加模型仲裁建议（非自动合并补丁）。

`aggregate` 含 `conflicts`（结论层）、`writeConflicts`（文件层）、可选 `arbitration`。

## 主 Agent 调度工具

主 Agent 在 `/api/agent` 内通过 **`dispatch_subagent`** 派生（见 `docs/对话循环.md`）。

```json
{
  "action": "tool",
  "tool": "dispatch_subagent",
  "input": {
    "roles": ["code_review", "test_analyze"],
    "task": "审查最近改动",
    "arbitrateConflicts": true
  }
}
```

`patch_worker` 时 `grantedPermissions` 必填且须含 `write`。

## 测试台

侧栏 **子 Agent (M5)**：选择单角色或并行多角色，填写任务与上下文后运行。

## 代码位置

```text
agent-relay/src/subagent/
├─ roles.ts
├─ notifyCompletion.ts     # 完成通知入队
├─ SubAgentRunner.ts
├─ SubAgentCoordinator.ts
├─ SubAgentArbitrator.ts   # 模型仲裁复核
├─ writeConflictMerge.ts  # 写入同一文件冲突检测
└─ types.ts

agent-relay/src/tools/subagentTool.ts
```

自检：`npm run test:subagent`（12 项）、`npm run test:dispatch-subagent`（7 项）。

## 暂未实现

- 冲突文件的**自动三路合并**（当前仅检测 + 仲裁建议，由父 Agent 或人工处理）
