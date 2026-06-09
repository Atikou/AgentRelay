# AgentRelay

本地优先的 **Agent 编排后端**：模型路由、工具系统、计划/任务与自主对话循环；规划接入桌面端、STT/TTS。

## 快速开始

```bash
cd agent-relay
npm install
npm run serve    # http://localhost:18787
```

文档站：启动服务后访问 http://localhost:18787/docs

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `agent-relay/` | 可运行代码（TypeScript / Node.js） |
| `docs/` | 使用说明与架构文档 |
| `AGENTS.md` | 供 AI Agent 快速上手的入口 |
| `agent-todolist.md` | 全量能力清单 |
| `Agent_TS_实现指南_修订版.md` | 实现指南与里程碑 |

## 许可证

本项目采用 [MIT License](LICENSE)（宽松许可，**保留版权声明与许可全文**即可再分发）。

使用、修改或分发本仓库代码时，请在副本中保留 `LICENSE` 文件及其中版权与许可声明，并注明来源为本项目 **AgentRelay** 仓库。
