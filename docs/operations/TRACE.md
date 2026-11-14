---
title: Trace 留存与隐私
kind: current
triggers: [trace, 追踪, 事件落盘, 事件日志, 留存, 保留期, 隐私, 脱敏, 重放, 级别, jsonl]
paths: [docs/operations/TRACE.md]
---

# Trace 留存与隐私

> 适用版本：0.5+。维护者：`gov`。
> 本文描述事件落盘、级别、留存、脱敏与重放。架构事实见
> [architecture/events.md](../architecture/events.md#trace) / [0.5.0](../versions/0.5.0.md) 与
> [ADR-047](../adr/ADR-047-trace-first-observability.md)。

## 1. 位置与格式

```text
<dataDir>/events/<run_id>.jsonl
```

- 一行一个 `RunEvent`，append-only。
- 信封：`{ type, run_id, data, ts, seq? }`；wire / DTO 不再有 `tenant_id`。
- 单公司根布局：trace 直接写 `<dataDir>/events/`，没有 `tenants/<id>` 层。非空 `<dataDir>/tenants/**` 或 `.t2-migrating-*` → 启动 fail-fast `non_root_layout`（不移动、不删除数据）。
- 写入前经过 `TraceRedactor`；写失败只计数并发 `trace.write.failed`，不阻塞事件投递。

## 2. seq 与 wire seq

- **`RunEvent.seq`**：由 `FileTraceRecorder` 落盘时分配，以 trace 文件尾部最大 seq
  为种子，保证同一 run 跨 resume 单调。内存实时事件允许无 seq。
- **消费方**：按 `(seq ?? ts)` 升序回退。
- **`events.list`**：返回 trace 中的 seq。
- **`events.subscribe.since`**：是 gateway 的 wire seq，与 `RunEvent.seq` 分层；
  不要把两者混用。

## 3. 级别

```yaml
trace:
  enabled: true
  level: full          # full | metadata | off
  retention_days: 30
  max_runs: 1000
  max_bytes: 1073741824  # 每 data_dir；0 = 不限
```

| 级别 | 内容 |
|---|---|
| `full` | 完整 payload（工具参数/结果、hook 输出、错误原文等）；**例外**：`llm.request` 的 `messages` 只落摘要（`message_count` / `token_count` / 末条消息 200 字符预览），完整副本不落盘（0.52） |
| `metadata` | 只保留信封 `type/run_id/ts/seq`，以及 data 中 `status`、`tool_name`、`duration_ms`、`iterations`、`iteration`、`message_count`、`finish_reason`、`usage.prompt_tokens/completion_tokens/total_tokens/total_cost`；`error` 保留但截断 ≤500 字符，`reason` ≤200 字符；其余消息/参数/结果丢弃 |
| `off` | 不落盘 |

缺省：`enabled: true`、`level: full`、30 天 / 1000 runs / 1 GiB。全量档包含用户消息
与工具参数，部署方需自行评估访问控制与留存合规。

**`llm.request` 摘要化**（0.52）：每轮请求的完整 prompt 是会话历史的副本，实测占
`events/` 字节的 98.6%，而 `events.list` 的消费者只查 error 类型。落盘时改用与 WS 广播
同一份摘要（`summarizeLlmRequestEvent`），目录从 GB 级回到几十 MB。需要 prompt 原文时
从会话存储（`sessions/<id>/events.ndjson`）或 `llm.response` 取。

## 4. 留存与 prune

```bash
vessel trace prune [--dry-run] [--json]
```

- 在启动时与命令执行时按 `retention_days` / `max_runs` / `max_bytes` 清理。
- **不删除** `running` / `interrupted` run 的 trace。
- 真实 prune 前获取 data-dir 写意图锁（`src/data-lock.ts`）；锁冲突返回 `data_locked`。`--dry-run` 只读、不加锁。
- 返回 `{ deleted_runs, kept_runs, deleted_bytes }`；`--json` 输出同一形状。
- 删除 session 时由 `deleteSessionData` 按 `session_id` 清理对应 `runs/` 与 `events/`；
  有 `running` / `interrupted` run 时返回 `conflict`。

## 5. 队列溢出

- 每 run 队列上限 10,000；溢出时丢新事件并计数。
- 同一 run 最多发一次 `trace.write.failed { reason: 'queue_overflow' }`。
- flush 时直接写一行 `trace.overflow { dropped }`（不经队列，避免自激），标记该 trace
  不完整。**绝不静默丢事件**。
- 看到 `trace.overflow` 时应视为该 run 的 trace 不完整，不能用于完整审计。

## 6. 脱敏

- trace 写入前与 gateway 出站前都经过 `TraceRedactor`。
- core 默认 redactor：键名匹配 `api_key|apikey|token|secret|password|authorization|app_secret`
  的值替换为 `***`；字符串匹配常见 key 前缀（如 `sk-`）。
- `app_id` 只允许前 4 位 + `***`。
- 插件可注入更严格 redactor；`redact-secrets` 提供 `createTraceRedactor(config?)`，
  与默认实现组合且幂等。
- **能力边界**：redactor 只能降低泄漏面，不是合规保证；新字段/新格式可能绕过默认规则。

### 0.5 明确不脱敏的内容

- run checkpoint（resume 需要完整上下文）
- eval 报告
- 飞书回复内容

POSIX 下文件权限 best-effort 0600；不是强制访问控制。需要更强隔离时，使用独立
`data_dir` 与操作系统权限。

## 7. 读取、重放与 metrics

- `readTraceEvents(traceDir, filter)`：默认 limit 50、最大 500；按 `(seq ?? ts)` 升序；
  跳过损坏行，不阻塞前序事件。
- `replayRun` / `FileEventStore` 的既有语义不变；trace 是 0.5 的默认落盘格式。
- `rebuildMetrics(traceDir)`：按 JSONL 重放聚合，返回与实时 `MetricsSnapshot` 同形状；
  `updated_at = max(event.ts)`（无事件为 0）。实时 collector 与重建结果必须一致。
- `metrics.get { source: 'trace' }` 返回重建结果；失败返回 `internal`。

## 8. 取消语义

- 显式用户取消：只发 `run.cancelled`，不再同时发 `run.failed`。
- Host 关闭/中断（`RUN_INTERRUPT_REASONS`）：仍发 `run.failed`。
- 因此 `metrics.runs.cancelled` 在 0.5 可能非 0；0.4 文档中的「恒 0」是历史行为。

## 9. 事件归属

| 发布方 | 事件 |
|---|---|
| core | `session.saved` / `session.deleted`、`hook.*`、`run.cancelled`、`installPlugin` 的 `plugin.*` |
| asm | `config.loaded`、`PluginLoader` 的 `plugin.loaded` / `plugin.failed` |
| ext | `eval.*` / `feishu.*` / `mcp.*` / `subagent.*` |

事件名仍是开放字符串；新增事件不需要改 core 类型。

## 10. 单 Node 单事件流

- 一个 node 恰好一条 bundle 级 `EventStream`；trace recorder 订阅该流并写入 `<dataDir>/events`，metrics collector 同源。
- 运行时不获取写者锁；trace prune 等写意图操作获取 data-dir 写意图锁（`data_locked`）。
- 插件侧不再有 tenant 维度：`plugins.list` / `plugins.catalog` / settings 为单视图。
- **已知限制**：`trace.readEvents` / `sessionData.deleteSessionData` 仍是单根读删；没有跨节点 trace 聚合。

## 11. 运维建议

- 单 Node 部署优先用 `trace.level: metadata` 与较短留存；需要排障时临时切 `full`。
- 定期跑 `vessel trace prune --dry-run` 观察增长，再执行真实 prune。
- 不要把 trace 目录提交到版本库。
- 事故取证时先确认没有 `trace.overflow`，再引用事件计数。
- 备份/归档 trace 时按 `<dataDir>/events` 整体处理。
