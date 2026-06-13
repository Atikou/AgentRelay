# 相关文件定位优化 TodoList

> **来源规范**：`Agent_Relevant_File_Location_Optimization_Spec.md`  
> **扫描基准**：`agent-relay/src/tools/locationTools.ts`、`agent-relay/src/agent/AgentLoop.ts`、`tests/tools.test.ts`、`tests/loop.test.ts`  
> **用途**：跟踪“相关文件定位阶段消耗过多主 Agent 预算”的优化进度。未完整实现的能力保持未勾选。

---

## 0. 问题与目标

- [x] 明确问题不是简单调大单一迭代次数，而是定位阶段使用过多低层工具。
- [x] 引入高级定位工具，减少 `list_files` / `search_text` / `read_file` 连续试探。
- [x] 定位结果进入 `executionMeta.location`，便于区分普通运行预算耗尽与定位阶段不足。
- [ ] 支持完整继续定位与恢复，不从头重新扫描。

---

## 1. P0：先解决当前问题

### P0-1：增加 executionMeta 中的定位统计

- [x] `executionMeta.location.usedLocateSteps`
- [x] `executionMeta.location.usedSearchCalls`
- [x] `executionMeta.location.usedListCalls`
- [x] `executionMeta.location.usedReadForLocationCalls`
- [x] `executionMeta.location.locatedFiles`
- [x] `executionMeta.location.candidateFiles`
- [x] `executionMeta.location.stopReason`
- [x] `executionMeta.location.needsContinue`
- [x] 测试覆盖：`tests/loop.test.ts`

**验收**：已覆盖。Agent 使用 `locate_relevant_files` 后，响应会汇总定位统计与已定位文件。

### P0-2：预算耗尽时输出 partial result

- [x] 预算耗尽 partial answer 不再只说未得到最终答案。
- [x] 如果已有定位结果，partial answer 会列出已定位文件与候选文件。
- [x] 如果定位仍不足，会提示需要继续定位或扩大定位预算。
- [x] 结构化 `suggestedAction: continue_locating` 作为顶层字段返回（`locate_relevant_files` 与预算耗尽 `executionMeta`）。

**验收**：部分完成核心行为；结构化继续动作待补。

### P0-3：优化 list_files 默认策略

- [x] `list_files` 默认 `recursive=false`。
- [x] `list_files` 默认 `limit=500`，不是低限额 10。
- [x] 默认忽略 `node_modules`、`.git`、`dist`、`build`、`coverage`、`.cache` 等目录。
- [x] 计划/审阅类项目分析已通过 `PlanWorkflow` 先执行 `project_scan` / `locate_relevant_files` / `context_pack`，减少模型临时决定 `list_files` 参数。

**验收**：工具默认策略已满足当前 P0；计划/审阅模式已有第一版模式化预扫描流程。

---

## 2. P1：相关文件定位模块

### P1-1：TaskQueryAnalyzer

- [x] 实现 `analyzeTaskQuery()`。
- [x] 从用户目标提取 `keywords`。
- [x] 提取可能的 `possibleSymbols`。
- [x] 根据关键词推断 `possiblePaths`。
- [x] 生成默认 `exclude`。
- [x] 推断粗粒度 `taskType`。
- [ ] 尚未接入模型生成高级搜索计划。

**验收**：规则版 SearchPlan 已可用。

### P1-2：RelevantFileLocator

- [x] 实现工具 `locate_relevant_files`。
- [x] 合并目标、关键词、符号、路径线索。
- [x] 返回 `primaryFiles`、`candidateFiles`、`unresolvedHints`、`confidence`。
- [x] 返回 `needsMoreSearch` 与 `stopReason`。
- [x] 返回定位统计 `locateStats`。
- [x] 已接入持久化 ProjectIndex（`project_scan` 写入、`locate_relevant_files` 复用）。
- [x] 尚未接入独立 symbol_search 工具。

**验收**：已可一次性定位相关文件；索引与符号搜索待补。

### P1-3：CandidateRanker

- [x] 按路径命中评分。
- [x] 按文件名/关键词命中评分。
- [x] 按内容关键词命中评分。
- [x] 按符号命中评分。
- [x] 重要配置/入口文件加权。
- [x] 输出可解释 `reason` 与 `matchTypes`。
- [x] 纳入 recentUse / projectMemory（`HistoryFileRecaller` + `historyFileHits`）。
- [ ] 尚未纳入文件依赖图中心性。

**验收**：规则评分已落地，可解释排序已返回。

### P1-4：ContextPackBuilder

- [x] 实现工具 `context_pack`。
- [x] 支持一次读取多个文件。
- [x] 支持 `maxFiles` / `maxTokens`。
- [x] 返回 per-file `summary`、`importantSections`、`truncated`。
- [x] 返回 `combinedSummary` 与 `tokenEstimate`。
- [ ] 尚未接入更精细的 AST 片段抽取。

**验收**：主 Agent 可用一个工具调用拿到 top files 上下文。

### P1-5：project_scan

- [x] 实现工具 `project_scan`。
- [x] 返回 `projectType`、`sourceRoots`、`configFiles`、`scripts`、`importantDirs`、`importantFiles`。
- [x] 默认轻量扫描，不递归深扫全项目。
- [ ] 尚未建立持久化索引。

**验收**：可作为定位前置扫描工具。

---

## 3. P2：索引和续跑

### P2-1：ProjectIndex

- [x] SQLite 表 `project_files`。
- [x] SQLite 表 `project_symbols`。
- [x] 文件 mtime/hash 增量更新。
- [x] 文件摘要缓存（`summary` 列，预留）。
- [x] 第二次定位复用索引，避免重新全量扫描（`locate_relevant_files.indexSource=project_index`）。

### P2-2：RunStateStore

- [x] 保存 `runId`、`mode`、`goal`（`run_states` 表 + `state_json`）。
- [x] 保存 `scannedPaths`、`readFiles`（从 PlanWorkflow 步骤提取）。
- [x] 保存 `completedSteps` / `pendingSteps`（PlanWorkflow 三步）。
- [x] 支持预算耗尽后 continue run（`POST /api/agent/resume`）。
- [x] 保存 `searchPlan`、`visitedFiles`、`visitedDirs`、`candidateFiles`（完整定位状态，ProjectIndex 联动 `indexFileCount`）。

### P2-3：ExplorationProgressTracker

- [x] 记录每步 `newInformation`。
- [x] 记录 `duplicate`。
- [x] 记录 `contributesToGoal`。
- [x] 记录 `informationGain`。
- [x] 区分有效探索和低收益循环探索（`lowYieldLoop`）。

---

## 4. P3：高级能力

- [x] 独立 `symbol_search` 工具。
- [x] 模块依赖图。
- [x] import/export 关系分析。
- [x] 基于 LanceDB 的语义文件定位。
- [x] 结合历史任务/项目记忆的相关文件召回。

---

## 5. 工具接口落地情况

| 工具 | 状态 | 说明 |
| --- | --- | --- |
| `project_scan` | [x] | 轻量扫描项目结构与配置 |
| `locate_relevant_files` | [x] | 生成 SearchPlan、候选排序、定位统计；含模块依赖图扩展与 LanceDB `semanticHits` |
| `context_pack` | [x] | 多文件上下文打包 |
| `symbol_search` | [x] | 优先查 ProjectIndex，回退文件系统符号提取 |
| `project_index_update` | [ ] | 尚未实现（`project_scan` 已会增量写入索引） |

---

## 6. 验收测试

- [x] 小项目定位：`tests/tools.test.ts` 覆盖 `locate_relevant_files` 能找到 `PlanCompiler`。
- [x] 上下文打包：`tests/tools.test.ts` 覆盖 `context_pack` 一次打包多个文件。
- [x] executionMeta 定位统计：`tests/loop.test.ts` 覆盖 `executionMeta.location`。
- [x] 测试台执行元信息展示 `executionMeta.location` 的定位步数、已找到文件和是否需要继续。
- [x] 定位预算不足返回结构化 `suggestedAction`。
- [x] 避免重复探索的 `visitedFiles` 去重与 `duplicate` 标记。
- [ ] 大项目 ProjectIndex 增量索引。

---

## 7. 下一步建议

1. 实现 ProjectIndex SQLite 表，先索引路径、mtime、hash、language、tags。
2. 抽独立 `symbol_search`，复用 TypeScript/正则符号提取。
3. 增加 RunStateStore，保存定位状态并支持 continue。
4. 再考虑 LanceDB 语义文件定位和历史任务 recentUse 加权。
