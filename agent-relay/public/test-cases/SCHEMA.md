# AgentRelay 网页测试用例格式（供 AI / 维护者）

## 目录约定

- `index.json`：功能页清单，**顺序与里程碑一致**（M0 → M1 → M2 → …）
- 每个功能**单独一个 JSON 文件**，勿合并到单文件
- 命名：`{里程碑小写}-{功能短名}.json`，如 `m1-tools.json`

## 功能页 JSON 顶层

```json
{
  "milestone": "M1",
  "feature": "工具系统",
  "featureId": "m1-tools",
  "summary": "本页验收目标的一句话概括",
  "cases": [ ... ]
}
```

## 单条用例必填字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 页内唯一，建议 `{featureId}-{简述}` |
| `title` | string | 用例标题（UI 展示） |
| `purpose` | string | **测试目的**：验证什么行为、为什么需要这条用例 |
| `method` | `"GET"` \| `"POST"` | HTTP 方法 |
| `path` | string | API 路径，可含 query |
| `input` | object \| null | POST body；GET 写 `null` |
| `expect` | object | 期望，见下表 |

> **模型**：测试台面板顶部可选当前可用模型；对 `/api/chat`、`/api/agent`、`/api/plan`、`/api/subagent/*` 会自动注入 `clientName`（`input` 已含 `clientName` 时优先用 JSON）。

## expect 常用断言

| 键 | 说明 |
| --- | --- |
| `status` | HTTP 状态码，如 `200`、`400` |
| `body` | 与响应 body 深度部分匹配 |
| `bodyHasKeys` | body 必须包含的顶层字段名数组 |
| `bodyPaths` | 点路径断言，如 `"task.status": "running"`；类型用 `"string"` / `"array"` / `"number"` / `"object"` |
| `contentTypeIncludes` | 响应 `Content-Type` 须包含的子串，如 `"text/html"`（非 JSON 接口） |
| `bodyType` | 响应 body 根类型，如 `"array"`（用于直接返回数组的接口） |
| `itemHasKeys` | body 为数组时，首项须含的字段 |
| `bodyContainsNames` | `body.tools[].name` 须包含的工具名列表 |

## 新增功能时

1. 在对应里程碑功能页 JSON **追加 ≥2 条**（正常 + 边界/错误）
2. 每条必须写清 `purpose`
3. 若新建功能页，在 `index.json` 的 `features` 中按里程碑顺序登记
