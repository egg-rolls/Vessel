# Trace 留存与隐私

> 适用版本：0.5+。维护者：`gov`。
> 本文描述事件落盘、级别、留存、脱敏与重放。架构事实见
> [ARCHITECTURE §10.5 / §17.3](../ARCHITECTURE.md) 与
> [ADR-047](../adr/ADR-047-trace-first-observability.md)。

## 1. 位置与格式

```text
<data_dir>/tenants/<tenant_id>/events/<run_id>.jsonl
```

- 一行一个 `RunEvent`，append-only。
- 信封：`{ type, run_id, data, ts, seq?, tenant_id? }`。
- 缺失 `tenant_id` 视为 `default`。
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
  max_bytes: 1073741824  # 每 tenant；0 = 不限
```

| 级别 | 内容 |
|---|---|
| `full` | 完整 payload（消息、工具参数/结果等） |
| `metadata` | 只保留信封 `type/run_id/ts/seq/tenant_id`，以及 data 中 `status`、`tool_name`、`duration_ms`、`iterations`、`iteration`、`message_count`、`finish_reason`、`usage.prompt_tokens/completion_tokens/total_tokens/total_cost`；`error` 保留但截断 ≤500 字符，`reason` ≤200 字符；其余消息/参数/结果丢弃 |
| `off` | 不落盘 |

缺省：`enabled: true`、`level: full`、30 天 / 1000 runs / 1 GiB。全量档包含用户消息
与工具参数，部署方需自行评估访问控制与留存合规。

## 4. 留存与 prune

```bash
vessel trace prune [--dry-run] [--json] [--tenant <id>]
```

- 在启动时与命令执行时按 `retention_days` / `max_runs` / `max_bytes` 清理。
- **不删除** `running` / `interrupted` run 的 trace。
- 真实 prune 前获取 tenant 写锁；`--dry-run` 只读、不加锁。
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
`data_dir` / tenant 与操作系统权限。

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
| ext | `workflow.*` / `eval.*` / `feishu.*` / `mcp.*` / `subagent.*` |

事件名仍是开放字符串；新增事件不需要改 core 类型。所有事件应带 `tenant_id`。

## 10. 内置多租户执行（A-6）

- `--serve` 为每个 active tenant 构建独立 `EventStream`；runtime 事件先进入本 tenant 流，再桥接到 gateway 共享流（事件已带 `tenant_id`，供 SSE/WS 过滤）。
- trace recorder 只订阅本 tenant 的流，写入 `<data_dir>/tenants/<tenant_id>/events`；metrics collector 同样按 tenant 隔离。
- gateway 为每个 active tenant 持有 writer lock；启动失败回滚、shutdown 释放；冲突 `tenant_locked`；disabled / 未配置 tenant → `forbidden`。
- **状态**：插件侧 tenant 行为、web A-6.3 的 `trace.readEvents(filter, tenantId)` / `sessionData.deleteSessionData(sessionId, tenantId)` 与 asm 的 per-tenant 执行接线（独立 EventStream、trace 写入路由、writer lock）**均已实现**。两 tenant 的 trace / events / metrics 互不可见是 qa 验收项。
- **已知限制**：gateway 的 workflow / 飞书控制面仍只走 default tenant；其事件仍带 `tenant_id` 并进入对应 tenant 的 trace。

## 11. 运维建议

- 多租户部署优先用 `trace.level: metadata` 与较短留存；需要排障时临时切 `full`。
- 定期跑 `vessel trace prune --dry-run` 观察增长，再执行真实 prune。
- 不要把 trace 目录提交到版本库；不要跨 tenant 复制 trace。
- 事故取证时先确认没有 `trace.overflow`，再引用事件计数。
- 备份/归档 trace 时按 tenant 目录整体处理，避免跨租户混淆。
