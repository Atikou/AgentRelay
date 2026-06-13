# 说明文档（docs）

本目录集中存放项目的使用说明 / 操作指南类文档，并由内置文档站点自动渲染成网页。设计类文档（能力清单、实现指南）仍在仓库根目录。

## 在线查看

启动测试台后访问文档站：

```bash
cd agent-relay
npm run serve
```

打开 http://localhost:18787/docs （或测试台左侧「说明文档 ↗」）。

**AgentRelay API 参考**（本地 Scalar 交互页）：

- http://localhost:18787/api-docs
- 机器可读规范：http://localhost:18787/api-spec.json

文档站与 API 参考页采用固定顶栏/侧栏布局：正文区域内部滚动，便于长文档阅读时保留导航入口。

## 如何新增一篇文档

1. 在本目录新建一个 `.md` 文件（文件名即页面 slug，建议用中文标题）。
2. 文件开头写一个一级标题 `# 标题`，它会作为侧边栏与页面标题。
3. 保存即可——文档站会**自动**扫描 `docs/` 并在侧边栏列出，无需改任何代码。

> `README.md`（本文件）不会出现在文档站侧边栏，仅作仓库内索引。

## 文档里可用的能力

- **流程图 / 时序图**：用 Mermaid 代码块，例如：

  ```mermaid
  flowchart TD
      A[开始] --> B[结束]
  ```

- **代码高亮**：普通代码块自动按语言高亮。
- **表格、引用块、列表**：标准 GitHub 风格 Markdown。
- **截图**：图片放到 `docs/assets/`，在文档中用绝对路径引用：

  ```markdown
  ![说明文字](/docs-assets/你的截图.png)
  ```

## 自动截取测试台截图

```bash
npm run serve            # 先启动测试台
npm run docs:screenshots # 用无头浏览器截图到 docs/assets/
```

## 文档列表

### 已完成 TodoList 归档

进行中的任务清单在 `docs/*-TodoList.md`；**已全部结案**的见 [`completed/`](completed/README.md)（含登记表与复查指引）。

- [修复 TodoList（已完成归档）](completed/修复TodoList.md)
- [项目问题修复 TodoList（已完成归档）](completed/项目问题修复TodoList.md)

### 进行中的 TodoList

- [自动工作流模式-TodoList](自动工作流模式-TodoList.md)：统一 Agent 入口、内部意图路由、权限策略与工作流解耦。

- [外部规范-TodoList索引](外部规范-TodoList索引.md)：**6 份外部规范**对应的完成度清单总览。
- [Agent执行策略问题-TodoList](Agent执行策略问题-TodoList.md)：RunPolicy / executionMeta / PlanWorkflow 等。
- [相关文件定位优化-TodoList](相关文件定位优化-TodoList.md)：TaskQueryAnalyzer、RelevantFileLocator、context_pack 与定位预算。
- [计划JSON与Markdown分离-TodoList](计划JSON与Markdown分离-TodoList.md)：InternalTaskPlan 与执行边界。
- [模型路由规则配置-TodoList](模型路由规则配置-TodoList.md)：规则路由 V1。
- [模型路由协作-TodoList](模型路由协作-TodoList.md)：draft_review 协作 V1。
- [模型路由升级TodoList](模型路由升级TodoList.md)：V2 FallbackManager 及后续路线图（V5/V8 等）。

### 说明文档

- [API 参考](API参考.md)：REST 接口总览、能力探测与交互式文档入口（`/api-docs`）。
- [项目整体架构](项目整体架构.md)：分层设计、模块职责、关键调用链路、目录结构与里程碑路线图。
- [数据存储边界](数据存储边界.md)：SQLite / JSONL / LanceDB 职责划分与 `data/` 目录说明。
- [编排与Run模型](编排与Run模型.md)：Orchestrator、统一 Run/Task、`GET /api/runs`。
- [计划JSON与Markdown分离](计划JSON与Markdown分离.md)：InternalTaskPlan、PlanStore、预览与执行边界。
- [计划体系分离](计划体系分离.md)：AgentStepPlan、UserVisiblePlan、ExecutableTaskPlan 三类计划边界与 analyze/compile 流程。
- [计划JSON与Markdown分离-TodoList](计划JSON与Markdown分离-TodoList.md)：对照规范的完成度清单（查漏补缺用）。
- [工具系统](工具系统.md)：工具协议、内置工具、权限/风险/沙箱安全机制与 HTTP 接口。
- [对话循环](对话循环.md)：M1 自主对话循环（ReAct JSON 协议、工具调用闭环、安全边界）。
- [后台任务与通知队列](后台任务与通知队列.md)：M4 长时间命令后台运行、完成通知与安全点消费。
- [子 Agent](子Agent.md)：M5 只读子 Agent 角色、派生、权限与汇总。
- [上下文压缩与持久化](上下文压缩与持久化.md)：M6 SQLite + FTS5 + LanceDB、摘要压缩与会话恢复。
- [安全与审计](安全与审计.md)：M7 日志脱敏、工具审计 trace、导出 API。
- [定时与事件触发](定时与事件触发.md)：M8 触发器调度、通知队列投递与后台完成事件。
- [测试用例](测试用例.md)：测试台内置/自定义 API 用例，输入·期望·实际三列比对。
- [接入本地模型](接入本地模型.md)：本地模型（Ollama / LM Studio / vLLM）的接入流程、配置与使用。
- [模型路由与协作](模型路由与协作.md)：规则路由、`routerProfile` 等级、单任务草拟+审查协作与日志表；**含双轨路由边界**（`ModelRouter` vs `SmartModelRouter`）。
- [模型路由升级 TodoList](模型路由升级TodoList.md)：**V1→V9 升级路线图扫描结论**与下一阶段任务清单；改路由前必读。
- [自审核记录](自审核记录.md)：每次任务结束后的自审核结论（最新在上），首次预览项目必读。
