# 文档站

本目录由 `http://localhost:18787/docs` 自动渲染（扁平扫描 `*.md`，不含子目录）。

## 阅读顺序

1. [架构设计](架构设计.md) — 分层、模块、数据与安全
2. [执行流程](执行流程.md) — 请求链路、Agent 循环、计划与权限
3. [TodoList](TodoList.md) — 路线图、待办、验收清单
4. [自审核记录](自审核记录.md) — 演进审计（保留历史，最新在上）

## 维护约定

- 新增说明文档：在本目录新建 `标题.md`（一级 `# 标题`），保存后文档站侧边栏自动出现
- 图片放 `docs/assets/`，引用：`/docs/assets/xxx.png`
- 架构/流程/待办有变时同步更新对应文档，**不要**再散落多份 `*-TodoList.md`

## 相关入口

- 项目 README：`../README.md`
- Agent 约定：`../AGENTS.md`
- OpenAPI / Scalar：`http://localhost:18787/api-docs`
