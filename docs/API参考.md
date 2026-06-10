# API 参考

AgentRelay 测试台在 `npm run serve` 后暴露一组 **REST JSON API**，默认基址：

```text
http://localhost:18787
```

## 交互式文档（推荐）

项目内置基于 **OpenAPI 3.1** 的现代化 API 文档，由 [Scalar](https://github.com/scalar/scalar) 渲染，支持：

- 按标签分组浏览全部端点
- 全文搜索（快捷键 `K`）
- **Try it out**：在浏览器内直接发请求
- 明暗主题跟随系统偏好
- 请求示例（Fetch / JavaScript）

| 入口 | 说明 |
| --- | --- |
| [/api-docs](/api-docs) | 交互式 API 文档页 |
| [/openapi.json](/openapi.json) | 机器可读的 OpenAPI 规范 |
| [/docs](/docs) | Markdown 说明文档（本页所在站点） |

测试台侧边栏也有 **「API 文档 ↗」** 快捷入口。

## 快速开始

### 1. 探测能力与配置

```http
GET /api/config
```

响应中的 `capabilities` 标明当前进程是否启用 trace 审计、上下文持久化、子 Agent、调度器等模块，例如：

```json
{
  "capabilities": {
    "traceAudit": true,
    "traceReplay": true,
    "contextPersistence": true,
    "subAgent": true,
    "scheduler": true
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
  "sensitive": false
}
```

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

`autoConfirm: true` 时允许写文件、`shell_run` 等副作用工具；默认需人工确认或走任务模式。

## 端点分组

以下与 OpenAPI 中的 `tags` 一致，完整请求/响应字段以 **[/api-docs](/api-docs)** 为准。

| 分组 | 主要路径 | 用途 |
| --- | --- | --- |
| 配置与模型 | `/api/config`、`/api/models/check`、`/api/metrics` | Profile、路由策略、连通性与调用统计 |
| 对话与智能体 | `/api/chat`、`/api/agent` | 单次对话与自主循环 |
| 计划与任务 | `/api/plan`、`/api/task/dry-run`、`/api/task/run` | 结构化计划与任务状态机 |
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
- **API 文档**侧重人类阅读与临时调试；规范文件 `agent-relay/public/openapi.json` 随代码演进维护。
- 改 API 后请同步更新 `openapi.json`，并在 `/api-docs` 目测 Scalar 是否正常加载。

## 相关文档

- [项目整体架构](项目整体架构.md) — 分层与调用链路
- [工具系统](工具系统.md) — `/api/tools` 语义与安全边界
- [对话循环](对话循环.md) — `/api/agent` ReAct 协议
- [测试用例](测试用例.md) — 网页用例格式与运行方式
