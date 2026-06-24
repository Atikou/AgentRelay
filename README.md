# AgentRelay

本地优先的 **Agent 编排后端**：统一 Agent 入口、模型路由、工具系统、计划/任务执行、权限护栏与可观测运行链路。可独立运行，也可作为桌面端 / IDE 插件的后端。

## 快速开始

```bash
cd agent-relay
npm install
npm run typecheck   # 提交前建议执行
npm run serve       # http://localhost:18787
```

| 入口 | 地址 |
| --- | --- |
| 测试台 | http://localhost:18787 |
| 文档站 | http://localhost:18787/docs |
| API 文档 | http://localhost:18787/api-docs |

## 文档

| 文档 | 说明 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | 供 AI / 维护者快速上手（约定、命令、目录） |
| [docs/架构设计.md](docs/架构设计.md) | 分层、模块、数据与安全边界 |
| [docs/执行流程.md](docs/执行流程.md) | 请求链路、Agent 循环、计划与权限 |
| [docs/TodoList.md](docs/TodoList.md) | 路线图、待办与验收清单 |
| [docs/自审核记录.md](docs/自审核记录.md) | 历史演进与自审（保留，只增不改旧条目） |

## 仓库结构

```text
AgentRelay/
├─ README.md / AGENTS.md
├─ docs/                 # 文档站自动渲染（扁平 *.md）
└─ agent-relay/          # 可运行代码（TypeScript / Node.js ≥20）
   ├─ config/            # 多 profile：default / local-only / cloud
   ├─ public/            # 测试台静态页与测试用例 JSON
   └─ src/               # 源码（见 docs/架构设计.md）
```

## 许可证

[MIT License](LICENSE) — 再分发时保留版权声明与 `LICENSE` 全文。
