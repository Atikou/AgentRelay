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

    "runsApi": true

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

响应含 `runId`、`routerDecision`、`executionStrategy`、`collaborationRunId`（如有）。仅 `content` 写入会话 assistant 消息。

指定 `clientName` 时仍走旧 `ModelRouter` 直连。详见 [模型路由与协作](./模型路由与协作.md)。



### 3. 自主 Agent（ReAct + 工具）



```http

POST /api/agent

Content-Type: application/json



{

  "message": "列出工作区根目录下的文件",

  "autoConfirm": false,

  "maxIterations": 8

}

```



`autoConfirm: true` 时允许写文件、`shell_run` 等副作用工具；默认需人工确认或走任务模式。响应含 `runId` 与 `taskId`。



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

| 计划与任务 | `/api/plan`、`/api/task/dry-run`、`/api/task/run` | 结构化计划与任务状态机 |

| 编排与 Run | `/api/runs`、`/api/runs/{id}` | 统一编排执行记录 |

| 工具 | `/api/tools`、`/api/tools/run` | 工具注册表与直接调用 |

| 后台与通知 | `/api/background/*`、`/api/notifications/*` | M4 长时间命令与通知队列 |

| 调度 | `/api/scheduler/triggers/*` | M8 定时/事件触发器 |

| 子 Agent | `/api/subagent/*` | M5 只读角色派生与汇总 |

| 上下文与记忆 | `/api/context/*` | M6 会话持久化、压缩与检索 |

| 安全与审计 | `/api/trace/recent`、`/export`、`/replay` | M7 脱敏 trace 与回放 |

| 文档 | `/api/docs`、`/api/docs/content` | Markdown 文档元数据（供 `/docs` 使用） |



## 错误格式



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


