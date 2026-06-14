# API 参考



AgentRelay 测试台在 `npm run serve` 后暴露一组 **REST JSON API**，默认基址：



```text

http://localhost:18787

```



## 交互式参考（推荐）



项目内置 **AgentRelay API 参考**页（`/api-docs`），借鉴现代化 API 站点布局，由本地打包的 [Scalar](https://github.com/scalar/scalar) 组件渲染，支持：



- 按标签分组浏览全部端点

- 全文搜索（快捷键 `K`）

- **Try it out**：在浏览器内直接发请求

- 明暗主题跟随系统偏好

- 请求示例（Fetch / JavaScript）



| 入口 | 说明 |

| --- | --- |

| [/api-docs](/api-docs) | AgentRelay API 交互参考页 |

| [/api-spec.json](/api-spec.json) | 机器可读的 API 规范（供参考页与外部工具导入） |

| [/docs](/docs) | Markdown 说明文档（本页所在站点） |



> `/openapi.json` 为兼容别名，内容与 `api-spec.json` 相同。



测试台侧边栏也有 **「API 文档 ↗」** 快捷入口。



首次克隆或更新依赖后请执行 `npm install`（会自动复制 Scalar 到 `public/vendor/`），再 `npm run serve`。

> **注意**：Scalar 要求 `id="api-reference"` 写在带 `data-url` 的 `<script>` 标签上（见 `public/api-docs.html`），不能放在普通 `<div>` 上，否则页面会一直处于骨架屏加载状态。



## 快速开始



### 1. 探测能力与配置



```http

GET /api/config

```



响应中的 `capabilities` 标明当前进程是否启用 trace 审计、上下文持久化、子 Agent、调度器、编排层等模块，例如：



```json

{

  "capabilities": {

    "traceAudit": true,

    "traceReplay": true,

    "contextPersistence": true,

    "subAgent": true,

    "scheduler": true,

    "orchestrator": true,

    "runsApi": true,

    "sensitiveDetection": true,

    "modelPromptRedaction": true,

    "agentDecisionTrace": true,

    "taskStatusTrace": true,

    "toolCallTrace": true,

    "modelUsageTrace": true,

    "toolErrorCategory": true,

    "toolStorageRedaction": true,

    "highRiskConfirmation": true,

    "localFirstPrivacyMode": true

  }

}

```



若某能力为 `false` 或对应路由返回 404，请 **重启** `npm run serve` 并强制刷新浏览器（Ctrl+F5）。



### 2. 单次对话



```http

POST /api/chat

Content-Type: application/json



{

  "message": "你好",

  "sensitive": false,

  "taskType": "simple"

}

```



**自动路由**（省略 `clientName`）走 `SmartModelRouter` + `ModelOrchestrator`：

- `qualityMode`：`fast`（单模型、禁协作）/ `balanced` / `deep`（倾向 `local_draft_remote_review`）
- `allowCollaboration` / `forceSingleModel` / `hasAttachments` + `attachmentTypes`
- `sensitive`：仅本地 `routerProfile`
- 兼容 `taskType`（`simple`/`reasoning`/…）映射规则任务类型

响应含 `runId`、`routerDecision`、`executionStrategy`（含 `strong_model_direct`）、`collaborationRunId`（如有）、**`fallbackCount` / `fallbackLogIds`**（V2，仅发生模型升级时）。仅 `content` 写入会话 assistant 消息。

指定 `clientName` 时仍走旧 `ModelRouter` 直连。详见 [模型路由与协作](./模型路由与协作.md)。



### 3. 自主 Agent（ReAct + 工具）



```http

POST /api/agent

Content-Type: application/json



{

  "message": "列出工作区根目录下的文件",

  "mode": "plan",

  "permissionPolicy": "readOnly",

  "autoConfirm": false,

  "budget": {
    "maxModelTurns": 8,
    "maxToolCalls": 8,
    "maxReadCalls": 8,
    "maxWriteCalls": 0,
    "maxShellCalls": 0,
    "maxRuntimeMs": 120000
  }

}

```



`mode` 可选 `chat` / `plan` / `implement` / `debug` / `review`；省略时会根据用户消息推断。`mode` 主要决定工作流、默认预算与提示语。`workflowType` 由内部 `WorkflowRouter` 按 `intent` 映射，当前会随 `executionMeta` 返回，供 UI 与审计展示；其中 `answerWorkflow` / `summarizeWorkflow` / `searchWorkflow` 是工具层强制只读工作流。模型首轮前的确定性工作流由 `WorkflowExecutor` 统一调度：`PlanWorkflow` 可先做只读预扫描；`debugWorkflow` 会先执行 `locate_relevant_files` + `context_pack` 只读诊断定位，再由 `DebugAnalysisWorkflow` 注入 analysis phase（`errorSummary` / `suspectedFiles` / `rootCauseHypotheses` / `minimalFixPlan` / `verificationPlan` / `riskAndRollback`），并在 `executionMeta.workflowDebugAnalyses` 返回可审计诊断记录；`editWorkflow` / `generateFileWorkflow` 会先执行 `locate_relevant_files` + `context_pack` 只读预定位，再由 `EditProposalWorkflow` 注入写入前 proposal phase（`targetFiles` / `changeSummary` / `permissionCheck` / `diffPlan` / `verificationPlan`），并在 `executionMeta.workflowProposals` 返回可审计 proposal 记录（含 `workflowType`、`permissionPolicy`、`requiredFields`、`permissionSummary` 与 `permissionChecks` 写入前预检结果）；成功执行 `write_file` / `apply_patch` 后，`executionMeta.workflowDiffs` 会返回 `path`、`changeId`、hash 与截断 diff 审计摘要，`EditExecutionWorkflow` 会把执行阶段上下文注入下一轮模型，要求基于真实 diff 做最小验证或最终总结；当写工具返回目标路径时，`EditAutoVerificationWorkflow` 会规划只读 `read_file`，由 `AgentLoop` 通过既有权限、预算与工具链路自动读回刚写入文件；当验证工具完成后，`EditVerificationWorkflow` 会注入 verification phase，并在 `executionMeta.workflowVerifications` 记录验证工具、状态、错误与输出预览，指导模型验证通过则 final、失败则最小修正；`runWorkflow` / `verifyWorkflow` 会尝试识别白名单安全命令（`node --version`、`npm --version`、`npm run typecheck`、`npm test`、`npm run build`），在 shell 权限与预算允许时执行 `shell_run` 并把结果注入模型上下文；无法安全执行时会静态降级并说明原因。`permissionPolicy` 可选 `readOnly` / `confirmBeforeEdit` / `autoEdit` / `confirmBeforeRun` / `autoRun`，省略时按内部意图与 `autoConfirm` 保守推断；工具权限由该策略推导，而不是由 `mode` 直接决定。计划/审阅类请求默认推断为 `readOnly`，但显式 `permissionPolicy` 可以改变工具权限；显式 `allowedPermissions` 与项目/角色权限仍只能收窄。`budget` 是运行预算对象；省略时由 `RunPolicy` 按模式动态分配，支持 `maxModelTurns`、`maxToolCalls`、`maxReadCalls`、`maxWriteCalls`、`maxShellCalls`、`maxRuntimeMs`。

`autoConfirm: true` 时允许写文件、`shell_run` 等副作用工具；默认需人工确认或走任务模式。高风险行为仍会强制确认：删除/清空、提交或推送、执行未知远程脚本、修改系统环境、安装全局依赖、读取/写入疑似密钥等，即使 `permissionPolicy` 为 `autoEdit` / `autoRun` 也不会直接放行。响应含 `runId`、`taskId` 与 `executionMeta`：

```json
{
  "answer": "……",
  "reachedLimit": false,
  "executionMeta": {
    "mode": "plan",
    "modeSource": "inferred",
    "intent": "plan",
    "workflowType": "planWorkflow",
    "permissionPolicy": "readOnly",
    "permissionPolicySource": "explicit",
    "budget": {
      "maxModelTurns": 8,
      "maxToolCalls": 8,
      "maxReadCalls": 8,
      "maxWriteCalls": 0,
      "maxShellCalls": 0,
      "maxRuntimeMs": 120000
    },
    "usage": {
      "modelTurns": 2,
      "toolCalls": 1,
      "readCalls": 1,
      "writeCalls": 0,
      "shellCalls": 0,
      "runtimeMs": 420
    },
    "location": {
      "usedLocateSteps": 1,
      "usedSearchCalls": 1,
      "locatedFiles": ["src/agent/AgentLoop.ts"],
      "candidateFiles": ["src/tools/ToolRegistry.ts"],
      "needsContinue": false,
      "confidence": 0.82
    },
    "usedIterations": 2,
    "usedModelTurns": 2,
    "usedToolCalls": 1,
    "usedReadCalls": 1,
    "usedWriteCalls": 0,
    "usedShellCalls": 0,
    "stopReason": "completed",
    "needsMoreBudget": false
  }
}
```

如果预算耗尽，`stopReason` 为 `budget_exhausted`，`budgetExhausted` 会标明耗尽的是哪一类预算。若本轮使用了 `project_scan` / `locate_relevant_files` / `context_pack`，`executionMeta.location` 会返回已定位文件、候选文件、定位调用统计、置信度和是否需要继续定位。若本轮是 debug 请求，`executionMeta.workflowDebugAnalyses` 会给出 `debugWorkflow` 的 analysis phase 契约和当前权限策略判断，下一轮模型会收到 `DebugAnalysisWorkflow` 提示，先形成错误摘要、疑似文件、根因假设、最小修复与验证计划。若本轮成功执行 `write_file` / `apply_patch`，`executionMeta.workflowDiffs` 会给出写入工具、目标路径、`changeId`、hash 与 diff 摘要；完整变更仍以 `ToolStorage` / trace 为准，下一轮模型会收到 `EditExecutionWorkflow` 的 execution phase 提示以进入验证或最终总结。若写入结果包含目标路径，系统会自动追加一次只读 `read_file` 验证；若写入后执行了 `read_file` / `diff_file` / `shell_run` 等验证工具，`executionMeta.workflowVerifications` 会记录验证状态与输出预览，下一轮模型会收到 `EditVerificationWorkflow` 的 verification phase 提示以收尾或做最小修正。`answer` 会包含已完成步骤、缺失信息、建议继续预算和本轮是否修改文件，不再只返回空泛的“未得到最终答案”。

当工具调用被确认门阻塞或被策略拒绝时，对应 `steps[]` 项会包含 `confirmationRequest`，其中有 `status`、`message`、`affects.files`、`affects.commands`、`affects.networkTargets` 和结构化 `risk`，用于测试台展示“将要做什么、影响什么、为什么等待确认/被拒绝”。



#### 流式 Agent（SSE）



```http

POST /api/agent/stream

Content-Type: application/json

Accept: text/event-stream

```



请求体与 `POST /api/agent` 相同。校验失败（空 `message`、未知 `clientName`）仍返回 JSON `400`/`404`；成功时为 `text/event-stream`，事件类型：

| event | 说明 |
| --- | --- |
| `run_start` | `{ runId, taskId, sessionId? }` |
| `step` | `{ step: AgentToolStep }`（每步工具后） |
| `done` | 与 `/api/agent` 200 响应体相同（含 `answer`、`steps` 等） |
| `error` | `{ error, runId, taskId }` |



### 4. 查询 Run 记录



```http

GET /api/runs?limit=20

GET /api/runs/{runId}

```



## 端点分组



以下与 API 规范中的 `tags` 一致，完整请求/响应字段以 **[/api-docs](/api-docs)** 为准。



| 分组 | 主要路径 | 用途 |

| --- | --- | --- |

| 配置与模型 | `/api/config`、`/api/models/check`、`/api/models/catalog`、`/api/metrics` | Profile、路由策略、连通性、**本地已安装模型目录**与调用统计 |

| 对话与智能体 | `/api/chat`、`/api/agent`、`/api/agent/stream` | 单次对话、自主循环与 SSE 逐步推送 |

| 计划与任务 | `/api/plan`、`/api/plans/*`、`/api/task/*`、`/api/tasks/*` | 计划报告/草案/审批/执行；`GET /api/tasks/:id` 查步骤状态；`POST /api/tasks/:id/resume` 重试/跳过/确认 |
| 模型路由审计 | `/api/routing/logs`、`/api/routing/profiles`、`/api/routing/stats`、`/api/routing/eval/*` | 路由日志、V5 能力矩阵、V6 运行统计、V7 离线评测 |

| 编排与 Run | `/api/runs`、`/api/runs/{id}`、`/api/runs/{id}/report` | 统一编排执行记录与运行报告时间线 |

| 工具 | `/api/tools`、`/api/tools/run` | 工具注册表与直接调用 |

| 后台与通知 | `/api/background/*`、`/api/notifications/*` | M4 长时间命令与通知队列 |

| 调度 | `/api/scheduler/triggers/*` | M8 定时/事件触发器 |

| 子 Agent | `/api/subagent/*` | M5 只读角色派生、结构化汇总、共同结论与冲突检测 |

| 上下文与记忆 | `/api/context/*` | M6 会话持久化、压缩与检索 |

| 安全与审计 | `/api/trace/recent`、`/export`、`/replay` | M7 脱敏 trace 与回放 |

| 文档 | `/api/docs`、`/api/docs/content` | Markdown 文档元数据（供 `/docs` 使用） |


`/api/context/sessions/:id/restore` 返回的 `renderedPrompt.finalMessages` 是模型调用前的调试快照。历史 `role=tool` 消息会被渲染为普通 `user` 历史文本，而不会作为 OpenAI/DeepSeek 原生 `tool` 消息发送；真实持久化记录仍保留在 `contextPackage.messages`，供摘要、审计和文件片段提取使用。

`/api/tools/run` 中的 `shell_run` 与 `/api/background/start` 共享 `ShellPolicy`。除内置高风险命令拦截外，可通过 `config/*.json` 的 `security.shell.denyCommands` / `allowCommands` 正则进一步限制可执行命令；未配置时保持原有风险分级行为。

`/api/tools/run` 对 `write_file`、`apply_patch`、`shell_run` 等副作用工具启用确认门：未传 `confirm:true` 时返回 `needsConfirmation` 和预览，不执行工具；高风险 shell 即使确认后仍会被 `ShellPolicy` 拒绝。该能力可通过 `capabilities.highRiskConfirmation` 探测。

工具失败响应会包含 `category`，取值为 `user_error`、`environment_error`、`permission_error`、`temporary_error`、`unknown_error`；该能力可通过 `capabilities.toolErrorCategory` 探测。

工具持久化日志 `tool_logs.input_json` / `output_json` / `error_message` 写入前会进行深度脱敏，避免完整 API key、Bearer token、密码、私钥等进入 SQLite；该能力可通过 `capabilities.toolStorageRedaction` 探测。

`ModelRouter` 调用远程模型前会对 `messages.content` 做敏感信息检测与脱敏；本地模型调用保留原始内容。该能力可通过 `capabilities.sensitiveDetection` 与 `capabilities.modelPromptRedaction` 探测。

本地优先隐私模式通过两层约束实现：`sensitive=true` 的请求只允许本地模型候选，`config/local-only.json` 的 `routing.strategy=privacy-first` 会全局仅使用本地模型；智能路由和 fallback 会继承 `localOnly`，避免敏感任务升级到远程模型。该能力可通过 `capabilities.localFirstPrivacyMode` 探测。

AgentLoop 每轮模型动作会写入 `agent_decision` trace 事件；`/api/trace/replay` 会把它和工具审计事件一起返回，便于复盘模型为什么调用某个工具或为什么进入 final。

已审批计划的执行与 `POST /api/tasks/:id/resume` 续跑会先进入 `TaskExecutionWorkflow`，再由其统一装配 `TaskRunner`、真实工具执行器 `ToolStepExecutor` 或干跑 `DryRunExecutor`。Orchestrator 仍负责 Run/Task 持久化、回滚与 fallback。

TaskRunner 步骤与聚合任务状态变化会写入 `task_status_change` trace 事件；Orchestrator 创建的任务运行会带上 `runId`、`taskId`、`sessionId`，便于把任务状态、工具审计与运行记录对齐。

工具调用会通过 `toolCallId` 串联：AgentLoop 的 `agent_decision` / `agent_tool`、TaskRunner 的 `task_step`、ToolRegistry 的 `tool_audit` 会共享同一调用 id。该能力可通过 `capabilities.toolCallTrace` 探测。

AgentLoop 每轮模型调用会写入 `agent_model_turn` 摘要，运行结束会写入 `run_usage_summary`，包含 token、耗时、估算费用、错误数和预算使用。该能力可通过 `capabilities.modelUsageTrace` 探测。


## 错误格式

> 注意：`/api/plan` 只生成可持久化的机器计划草案。若请求体把 `goal` 写成 `# 计划模式分析结果` 这类 Markdown 报告模板，会返回 `code=PLAN_REPORT_REQUEST`，提示改用 `/api/agent` + `mode=plan`。

计划体系分离新增两个入口：

- `POST /api/plans/analyze`：通过 `PlanReportWorkflow` 生成并保存 `UserVisiblePlan`，只读、不可执行；HTTP handler 只做参数校验和模型选择。
- `POST /api/plans/{userVisiblePlanId}/compile`：通过 `PlanCompileWorkflow` 仅把已确认 Todo 编译成 `InternalTaskPlan` 草案，仍需审批后执行。
- `POST /api/plans/{planId}/reject`：拒绝内部任务计划草案（`rejected` 后不可 `loadExecutable`）。



多数 4xx/5xx 响应为：



```json

{ "error": "人类可读的错误说明" }

```



常见状态码：



| 状态码 | 含义 |

| --- | --- |

| 400 | 请求体或参数不合法 |

| 404 | 资源不存在或路由未启用 |

| 502 | 上游模型调用失败 |



## 与测试台的关系



- **测试用例**面板按 `public/test-cases/*.json` 对 API 做结构化断言，适合回归。

- **API 参考**侧重人类阅读与临时调试；规范文件 `agent-relay/public/api-spec.json` 随代码演进维护。

- 改 API 后请同步更新 `api-spec.json`，并在 `/api-docs` 目测交互页是否正常加载。



## 相关文档



- [项目整体架构](项目整体架构.md) — 分层与调用链路

- [编排与 Run 模型](编排与Run模型.md) — Run / Task 关联

- [工具系统](工具系统.md) — `/api/tools` 语义与安全边界

- [对话循环](对话循环.md) — `/api/agent` ReAct 协议

- [测试用例](测试用例.md) — 网页用例格式与运行方式
