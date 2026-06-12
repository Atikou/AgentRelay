# 子 Agent（M5）

M5 引入**只读子 Agent**：独立上下文、受限工具权限、父 Agent 显式授权、结果汇总、冲突检测与超时控制。第一版不做写文件、不递归派生。

## 内置角色

| 角色 ID | 名称 | 权限 | 用途 |
| --- | --- | --- | --- |
| `code_review` | 代码审查 | `read` | 只读审查；任务含文件路径时会**预读**并走**单次审查**（免 JSON 协议）；否则 ReAct 循环，默认 `maxModelTurns=16`、`maxReadCalls=20`、**180s** 超时 |
| `test_analyze` | 测试分析 | `read` | 只读分析测试/日志输出；默认 `maxModelTurns=8`、`maxReadCalls=10`、**120s** 超时 |

父 Agent 通过 `grantedPermissions` 授权，**必须是角色允许集的子集**（第一版均为 `["read"]`）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/subagent/roles` | 列出角色与权限 |
| `POST` | `/api/subagent/run` | 运行单个子 Agent |
| `POST` | `/api/subagent/batch` | 并行派生多个角色并汇总 |

### POST /api/subagent/run

```json
{
  "role": "code_review",
  "task": "审查 src/agent/AgentLoop.ts",
  "context": "父 Agent 附加上下文（可选）",
  "parentTaskId": "可选，用于 trace 链路",
  "grantedPermissions": ["read"],
  "budget": {
    "maxModelTurns": 16,
    "maxToolCalls": 20,
    "maxReadCalls": 20,
    "maxWriteCalls": 0,
    "maxShellCalls": 0,
    "maxRuntimeMs": 180000
  },
  "timeoutMs": 180000,
  "sensitive": false
}
```

### POST /api/subagent/batch

```json
{
  "roles": ["code_review", "test_analyze"],
  "task": "检查最近一次改动的风险",
  "context": "可选"
}
```

返回 `summary` 字段为父 Agent 可消费的汇总文本，同时返回结构化 `aggregate`：

```json
{
  "aggregate": {
    "status": "completed | partial | conflict | failed",
    "completed": 2,
    "failed": 0,
    "timedOut": 0,
    "commonFindings": ["多个角色重复提到的结论"],
    "conflicts": [
      {
        "topic": "login",
        "roles": ["code_review", "test_analyze"],
        "reason": "同一主题出现相反结论",
        "excerpts": [
          { "role": "code_review", "text": "login 模块通过 ok" },
          { "role": "test_analyze", "text": "login 模块失败 error" }
        ]
      }
    ],
    "mergedAnswer": "父 Agent 可直接消费的合并文本"
  }
}
```

冲突检测为确定性启发式：按结论句切分，识别共享主题词，并在同一主题出现“通过/正常/ok”和“失败/错误/error”等相反极性时标记 `conflict`。它不替代模型仲裁，但能让父 Agent 或测试台知道需要复核。

## 测试台

侧栏 **子 Agent (M5)**：选择单角色或并行多角色，填写任务与上下文后运行。

## 代码位置

```text
agent-relay/src/subagent/
├─ roles.ts              # 角色定义与权限校验
├─ taskContext.ts        # 从任务提取路径并预读文件
├─ SubAgentRunner.ts     # 单个子 Agent（复用 AgentLoop）
├─ SubAgentCoordinator.ts # 并行派生 + 结构化汇总
└─ types.ts
```

自检：`npm run test:subagent`（8 项）。

## 与主 AgentLoop 的关系

子 Agent 内部复用 `AgentLoop`（ReAct JSON 协议），但：

- 使用角色专属 system prompt（独立上下文）
- `allowedPermissions` 仅 `read`
- `autoConfirm: false`，且写/shell 工具不在允许集
- `TraceLogger` 记录 `subagent_start` / `subagent_end` 与 `parentTaskId`

## 暂未实现

- 子 Agent 写文件或执行命令
- 无限递归派生
- 写权限子 Agent 的补丁级冲突合并
- 模型仲裁式冲突复核
