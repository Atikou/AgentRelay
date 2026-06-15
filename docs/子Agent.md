# 子 Agent（M5）

子 Agent 是主 Agent 在执行复杂任务时创建或调用的**独立任务执行模块**，不做专用人格或固定角色。它接收主 Agent 下发的任务目标、约束条件、上下文片段和可用工具，独立完成分析、搜索、编辑、验证等工作，并以结构化结果返回给主 Agent；主 Agent 负责判断是否采纳这些结果，并将多个子 Agent 的输出合并为最终响应。

核心能力：

1. **大任务拆小**：主 Agent 将可并行或可独立推进的步骤拆成多个 `DelegatedTask`。
2. **干净上下文**：每个子任务在**独立、最小必要上下文**中运行，不继承主 Agent 全量对话。
3. **只带回结果**：子 Agent 自行调用工具完成工作，经 `ResultCollector` 压缩为结构化结果（`summary` / `findings` / `risks` / `nextActions` …）交回主 Agent。

`ExecutionRouter` 辅助判断何时委派、用什么模型/工具/上下文/限制；不绑定具体模型名。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| `DelegatedTask` | 子任务包：`goal` / `instructions` / `input` / `context` / `limits` / `toolPolicy` / `modelPolicy` |
| `ExecutionRouter` | 执行策略：`direct` / `delegate` / `review` / … |
| `TaskSplitter` | 将复合目标拆成多个可并行 `DelegatedTask` |
| `ContextRouter` | 最小必要上下文，**不继承**主 Agent 全量对话 |
| `ToolRouter` | 按 `toolPolicy` 解析工具权限 |
| `SubAgentRunner` | `runDelegated(DelegatedTask)` |
| `ResultCollector` | 结构化结果回收 |

## 调用方式

### dispatch_subagent

```json
{
  "action": "tool",
  "tool": "dispatch_subagent",
  "input": {
    "tasks": [
      {
        "goal": "分析 src/auth.ts 与 src/api.ts 的调用关系",
        "instructions": "只读分析，列出关键 import 与风险",
        "toolPolicy": { "writeAllowed": false, "shellAllowed": false }
      }
    ]
  }
}
```

并行多个子任务：传多个 `tasks` 元素。用户明确要求 N 个子 Agent 时，主 Agent 应一次构造 N 个互相独立的 `DelegatedTask`，而不是把多个角色或多个目标塞进一个字符串。写操作须 `toolPolicy.writeAllowed: true` 且 `grantedPermissions` 含 `write`。

旧接口/旧思想已移除：不支持 `roles`、`role`、`task` 字符串，也不支持 `patch_worker` / `code_review` / `test_analyze` 等固定角色。收到这类参数时应视为错误并重新按 `tasks[]` 构造。

### HTTP

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/subagent/run` | `task: DelegatedTask` |
| `POST` | `/api/subagent/batch` | `tasks: DelegatedTask[]` |
| `GET` | `/api/subagent/running` | 运行中列表 |
| `POST` | `/api/subagent/cancel` | 取消 |

## 何时委派 vs 直接回答

主 Agent 系统提示约定：**能直接 `final` 的简单问题勿滥用委派**；适合拆分的局部步骤、需隔离上下文或并行推进时再 `dispatch_subagent`。非工程/非文件类子任务默认不读取项目文件，可将 `toolPolicy.allowedTools` 设为空数组；只有任务明确涉及当前项目、代码、文件、测试或命令时，才使用 `locate_relevant_files`、`context_pack`、`read_file` 等项目工具。

## 有界递归

`security.subagent.maxDispatchDepth`（默认 `1`）：子 Agent 内禁止无限 `dispatch_subagent`。

## 模型路由

`createDelegatedTaskChatFn` → `buildDelegatedTaskRouterInput` → `SmartModelRouter`；`modelUsed` / `structured.usedModel` 供审计。只读通用子任务不再默认要求 `code` / `tool_use` 能力，任务信号会先判断是否属于工程任务；写入或明确工程上下文的子任务才会携带代码/工具能力约束。

## 代码位置

```text
agent-relay/src/subagent/
├─ delegatedTask.ts
├─ ExecutionRouter.ts / TaskSplitter.ts
├─ ContextRouter.ts / ToolRouter.ts / ResultCollector.ts
├─ SubAgentRunner.ts / SubAgentCoordinator.ts
agent-relay/src/tools/subagentTool.ts
agent-relay/src/model-router/create-subagent-chat.ts
```

自检：`npm run test:subagent-execution-router`、`test:subagent-routing`、`test:dispatch-subagent`、`test:subagent`。
