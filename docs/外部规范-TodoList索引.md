# 外部规范 TodoList 索引

> 本页汇总仓库外设计/报告 Markdown 对应的**完成度 TodoList**（仅扫描勾选，不代替实现）。  
> 原始规范文件位于用户 Downloads；项目内以 `docs/*-TodoList.md` 维护进度；**已全部结案**的清单归档至 [`completed/`](completed/README.md)（规范见 `AGENTS.md` · TodoList 归档）。

## 规范章节覆盖清单

| 规范 | 主要章节 | TodoList 对应节 |
| --- | --- | --- |
| 计划 JSON/Markdown 分离 | §0–§18 全篇 | §0–§16 + §8 类型 + §17 指令 |
| 执行策略问题报告 | §1–§9 全篇 | §1–§6 + §0 现象 + §7 指令 |
| 模型路由规则配置 | §1–§17 全篇 | §1–§6 + §7 等级 + §8 规则 + §12–§13 |
| 模型路由协作 | §1–§24 全篇 | §1–§6 + §7–§10 设计节 |
| 模型路由升级路线图 | §0–§24 全篇 | 完成度 + V1–V9 + §15 判断 + §18–§22 验收 |
| 相关文件定位优化 | §0–§18 全篇 | §0–§7 + 工具接口 + 验收测试 |

---

## 规范 ↔ TodoList 对照

| 原始规范 | 项目 TodoList | 当前阶段 | 完成度概要 |
| --- | --- | --- | --- |
| `Agent_TaskPlan_JSON_Markdown_Separation_Spec.md` | [计划JSON与Markdown分离-TodoList](计划JSON与Markdown分离-TodoList.md) | P0 主体 ✅ / P1 部分 | 类型/Store/Renderer/执行边界 + reject API 已落地；版本链、step 审计待补 |
| `Agent_Execution_Policy_Issues_Report.md` | [Agent执行策略问题-TodoList](Agent执行策略问题-TodoList.md) | P0–P2 主体 ✅ | executionMeta、PlanWorkflow、RunStateStore、ToolResultLayers、BudgetManager、RunPolicyManager 已落地 |
| `Agent_Model_Router_Rule_Config_Spec.md` | [模型路由规则配置-TodoList](模型路由规则配置-TodoList.md) | V1 ✅ | 规则路由 + 手动配置 + 启动 `validateModelProfiles` 已完成；路由 HTTP 查询待补 |
| `Agent_Model_Router_Collaboration_Spec.md` | [模型路由协作-TodoList](模型路由协作-TodoList.md) | V1 ✅ | single_model + draft_review 已闭环；rule_only、DB 集成测试待补 |
| `Agent_Model_Router_Auto_Upgrade_Roadmap.md` | [模型路由升级TodoList](模型路由升级TodoList.md) | **V8 下一步** | V2–V7 已完成（含 V5 能力矩阵）；V8 完整自动路由未开始 |
| `Agent_Relevant_File_Location_Optimization_Spec.md` | [相关文件定位优化-TodoList](相关文件定位优化-TodoList.md) | P0/P1 主体 ✅ / P2 ProjectIndex ✅ / symbol_search ✅ | project_scan、locate、context_pack、symbol_search、RunStateStore 续跑已落地 |
| （架构审阅修复，非外部规范） | [修复TodoList（归档）](completed/修复TodoList.md) | ✅ 已结案 | P0–P3 已全部落地；原路径 [修复TodoList.md](修复TodoList.md) 为 stub |

## 规范章节 ↔ TodoList 节速查

| 规范 | 规范内必查章节 | 项目 TodoList 对应 |
| --- | --- | --- |
| 计划 JSON/Markdown 分离 | §16、§7、§15、§17 | §13–§16、§5、§12、§9d |
| 执行策略问题报告 | §3、§6、§7、§8、§9 | §1、§3、§4、§4b–§4c |
| 模型路由规则配置 | §4、§8、§12–§15、§14 A–I | §0、§2 D、§2b–§2d、§2 |
| 模型路由协作 | §11、§15–§22、§21 A–J | §7–§13、§2 |
| 模型路由升级路线图 | §15、§17–§23、§18–§22 | V2 触发/路径、§15 判定、各阶段验收 |
| 相关文件定位优化 | §5、§8、§15–§17 | §1–§5、§6–§7 |

## 推荐阅读顺序

1. **执行策略** — 若 Agent 计划模式/预算/收尾有问题，先看 [Agent执行策略问题-TodoList](Agent执行策略问题-TodoList.md)
2. **计划存储** — 若 plan/Markdown/执行混淆，看 [计划JSON与Markdown分离-TodoList](计划JSON与Markdown分离-TodoList.md)
3. **模型路由 V1** — [模型路由规则配置-TodoList](模型路由规则配置-TodoList.md) + [模型路由协作-TodoList](模型路由协作-TodoList.md)
4. **模型路由 V2+** — [模型路由升级TodoList](模型路由升级TodoList.md)
5. **相关文件定位** — 若 Agent 在找文件阶段耗尽预算，看 [相关文件定位优化-TodoList](相关文件定位优化-TodoList.md)

## 说明文档（非 TodoList）

- [计划JSON与Markdown分离](计划JSON与Markdown分离.md)
- [模型路由与协作](模型路由与协作.md)
- [对话循环](对话循环.md)
- [工具系统](工具系统.md)

## 扫描方法（Agent 复用）

```text
1. 读规范 §16 / §21 / TodoList 章节
2. grep 关键词 + 读 src/ 对应模块 + tests/
3. [x] 已实现且有测试  [~] 部分  [ ] 未开始
4. 更新对应 *-TodoList.md，不写代码（除非用户明确要求实现）
```

---

*最后更新：2026-06-12（新增相关文件定位优化规范；共六份规范）*

---

## 本次核对说明（2026-06-10）

已对五份 Downloads 规范做**章节级**对照，补全此前遗漏：

| 补全项 | 涉及文件 |
| --- | --- |
| §0–§2 现象/根因/原则 | 执行策略、计划分离 |
| §8 类型 / §17 八条指令 / §12 命名 | 计划分离 |
| §4 等级 / §8 八类规则 / §11–§13 接口与错误 | 规则配置 |
| §11 优先级 / §15–§20 / §16 保存 / §19 错误 | 协作 |
| §5.2–5.4 V2 细节 / §15 判定 / §18–§22 验收 / §23 十条 | 升级路线图 |
| 章节速查表 | 本索引 |

**仍 intentionally 未展开为逐项 checkbox 的内容**（规范中为叙述/示例，非 TodoList）：

- 各规范中的 JSON/SQL/TS **示例代码块**（实现已用等价结构）
- 升级路线图 **V9 拖拽节点类型清单**（已汇总为 V9 一行 + 验收五条）
- 计划分离 **§18 总结**架构图（已在说明文档覆盖）

若规范原文增删章节，请同步更新对应 `*-TodoList.md` 与本索引。
