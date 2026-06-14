# Data Lifecycle & Retention TodoList

> 依据 `AgentRelay_Data_Lifecycle_Retention_Spec.md` 分阶段落地。  
> **原则**：本地优先、先预览再清理、自动只清低风险、删除会话联动关联数据。

## Phase 1：Inventory + Dry Run

- [x] `data/lifecycle/policy.json` 默认策略（`src/lifecycle/policy.ts`）
- [x] `StorageInventoryService`：统计 trace / timeline / SQLite / cache / temp / reports / notifications / scheduler
- [x] `CleanupPlanner`：生成候选动作、风险等级、预计释放空间
- [x] `CleanupJournal`：`cleanup-runs.jsonl` 审计日志
- [x] `GET /api/storage/usage`
- [x] `POST /api/storage/cleanup/preview`（默认 dry-run，不删文件）
- [x] 单元测试 `tests/data-lifecycle.test.ts`

**验收**：可见各类占用；可生成清理预览；preview 不修改磁盘。

## Phase 2：安全清理（Low Risk）

- [x] `CleanupExecutor` + `CleanupLock`（apply 互斥锁）
- [x] `POST /api/storage/cleanup/apply`（需 `cleanupRunId` + `confirm: true`）
- [x] 可清理：`temp`、`cache`、`reports/cache`、已消费通知（JSONL 压缩重写）
- [ ] 已完成调度 journal（当前 `triggers.jsonl` 为触发器状态，非完成日志 — 待调度器拆分 journal 后接入）
- [x] active run 永不进入候选

**验收**：safe cleanup 释放空间；active run 不受影响；动作写入 journal。

## Phase 3：Trace 轮转与索引

- [x] `trace-current.jsonl` + segments 目录
- [x] 轮转条件（大小 / 时间 / 退出前）
- [x] `traces/index.db` + `trace_index` 表
- [x] 旧 `trace.jsonl` 兼容读取与迁移任务
- [x] `TraceLogger` 改写为分段写入
- [x] `POST /api/trace/rotate` 手动轮转

**验收**：新事件写 active；超限自动 rotate；index 可按 runId/sessionId 查。

## Phase 4：Run / Session / Timeline 关联清理

- [x] 删除会话时联动 `.agent/runs/{runId}`、`data/runs/{runId}`
- [x] `tombstones.jsonl` 记录
- [x] Timeline `manifest.json` 写入（ActivityRunStore）
- [x] `DELETE /api/runs/{runId}` 联动 timeline
- [x] 过期 timeline `events.jsonl` 清理预览（medium risk；保留 summary）

**验收**：删会话/删 run 不遗留明显 timeline 目录；tombstone 可审计。

## Phase 5：隐私清除（Privacy Purge）

- [x] `POST /api/context/sessions/:id/purge`（需 `confirm: true`）
- [x] trace segment 重写（过滤 session 事件）
- [x] `tools.db` / routing 表关联字段清理
- [x] notifications 关联记录清理
- [ ] scheduler 关联记录清理（`triggers.jsonl` 待调度器拆分 journal 后接入）
- [x] DB checkpoint / VACUUM

**验收**：purge 后该 session 详细记录不可恢复；其他 session 不受影响。

## Phase 6：UI / CLI / 自动任务

- [x] 测试台「本地存储」面板（侧栏 + 用量/预览/apply）
- [x] CLI：`npm run storage:status` / `storage:cleanup -- --dry-run` / `--apply --cleanup-run-id`
- [x] 每日 safe cleanup（`policy.cleanup.autoEnabled` 时服务端定时 `runAutoSafeCleanup`）
- [x] policy 说明（编辑 `data/lifecycle/policy.json`，见专题文档）

**验收**：用户可见占用与预计释放空间；危险操作二次确认。

## 测试与文档（跨阶段）

- [x] `m10-storage-lifecycle.json` 网页用例 ≥2
- [x] `api-spec.json` 登记 storage API
- [x] `docs/数据生命周期与清理.md` 专题文档
- [x] `agent-todolist.md` §18 部分勾选
- [x] `docs/项目整体架构.md` 登记 `lifecycle/` 模块

## MVP 暂缓

- [ ] zstd 压缩（先用 gzip 或仅分段不压缩）
- [ ] pinned run/session
- [ ] quarantine 目录失败恢复
- [ ] 工具审计字段级 TTL 清理
