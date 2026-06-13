# 已完成 TodoList 归档

本目录存放 **已全部结案** 的任务型 TodoList 正文，便于后续按整条链路复查（改了什么、测了什么、源码在哪）。

> 进行中的清单仍在 `docs/*-TodoList.md`；归档规范见仓库根目录 `AGENTS.md` → **关键约定 · TodoList 归档**。

## 登记表

| 归档文件 | 完成时间 | 来源 / 目标 | 原路径 stub |
| --- | --- | --- | --- |
| [修复TodoList.md](修复TodoList.md) | 2026-06-13 | 架构审阅后续 P0–P3 修复 | [../修复TodoList.md](../修复TodoList.md) |
| [项目问题修复TodoList.md](项目问题修复TodoList.md) | 2026-06-14 | 审阅问题 P0/P1/P2 逐项修复（路由/安全/可观测/评估） | [../项目问题修复TodoList.md](../项目问题修复TodoList.md) |

## 复查时建议顺序

1. 读归档文首 **✅ 已完成** 与「落地文件索引」
2. 对照 `docs/自审核记录.md` 同时间段条目
3. 跑归档文中列出的测试命令 / 网页用例页

## 新增归档时

1. 将完整勾选版写入 `docs/completed/{原名}.md`
2. 原 `docs/{原名}.md` 改为跳转 stub
3. 在本表追加一行
4. 更新 `docs/README.md` 与（若适用）`docs/外部规范-TodoList索引.md`
