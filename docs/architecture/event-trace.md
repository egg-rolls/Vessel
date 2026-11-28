---
title: 事件回放与 trace 落盘
kind: current
triggers: [trace, replay, FileEventStore, replayRun, FileTraceRecorder, seq, redaction, prune, rebuildMetrics, readTraceEvents, 回放, 落盘, 脱敏, 留存, 重建]
paths: [src/observability/trace-wiring.ts, src/observability/observability-wiring.ts, packages/core/src/observability/trace-recorder.ts, packages/core/src/observability/read-trace.ts, packages/core/src/observability/rebuild-metrics.ts, packages/core/src/events/file-event-store.ts, packages/core/src/events/replay.ts]
---

# 事件回放与 trace 落盘

> 事件命名见 [event-catalog.md](event-catalog.md)；gateway 出站订阅与 wire 回放见
> [event-subscribe.md](event-subscribe.md)；会话事件日志落盘口径见 [event-log-policy.md](event-log-policy.md)。

## core 回放

`MemoryEventStream` 之外，core 提供 `FileEventStore`（JSONL 一行一事件：`append` / `readRun` /
`listRunIds` / `deleteRun`，`packages/core/src/events/file-event-store.ts`）与
`replayRun(store, runId, eventStream, { delayMs })`（`replay.ts`）。回放经同一个 `publish()`
重新发布历史事件（保留原始 `ts`），订阅者用同一个 `subscribe()` 接收 live 与 replay，靠
`replay.started` / `replay.completed` 区分边界。

**事件是 spec，回放是 oracle**：同一 session 的事件重放必须产生相同状态与投影
（`rebuildMetrics` 与订阅者状态一致）；SSE 断线重连的 `since` 续传、重复与缺口纳入回放等价
探针，不只测「能连上」。

## trace 落盘

`RunEvent` 带可选 `seq?`。`TraceRecorder` port 由 asm 接线（`src/observability/trace-wiring.ts:installTrace`），
默认 `FileTraceRecorder` 把每个 run 写成 `<data_dir>/events/<run_id>.jsonl`（append-only，一行一事件）。
`trace.enabled === false` 或 `trace.level === 'off'` → 零副作用（返回 undefined）。

- **seq**：由 recorder 落盘时分配，以文件尾部最大 seq 为种子；内存实时事件允许无 seq，消费方按
  `(seq ?? ts)` 回退。`events.list` 返回 trace seq；gateway 的 `events.subscribe.since` 是 wire seq，二者分层。
- **级别**：`full` 保留完整 payload（例外：`llm.request` 的 `messages` 按 WS 广播同一份摘要落盘；
  会话事件日志另有一套更窄的元信息口径，见 [event-log-policy.md](event-log-policy.md)）；
  `metadata` 只留信封与白名单字段（`status` / `tool_name` / `duration_ms` / `iterations` /
  `iteration` / `message_count` / `finish_reason` / `usage.*`），`error` 截断 ≤500、`reason` ≤200；
  `off` 不落盘。`includeStreamChunks` 默认 false（流式分片默认不落盘）。
- **留存**：缺省 30 天 / 1000 runs / 1 GiB（单 node）；`vessel trace prune` 或启动时执行，
  不删除 `running` / `interrupted` run。dryRun 把 jsonl 硬链接（跨卷回退复制）到临时目录算删除集合，原目录零改动。
- **失败与溢出**：写失败发 `trace.write.failed` 并计数（只 warn，不写回 trace 避免递归），不向事件
  投递路径抛错；每 run 队列上限 10000，溢出丢新事件并写一行 `trace.overflow { dropped }`，同一 run
  最多一次 `trace.write.failed { reason: 'queue_overflow' }`。
- **脱敏**：trace 写入前与 gateway 出站前都过 `TraceRedactor`（core 默认 → 注入的 ext redactor 组合，
  后者看到的是已脱敏事件）；默认按键名与 `sk-` 前缀替换，`app_id` 只留前 4 位 + `***`。**不**对
  run checkpoint、eval 报告、飞书回复脱敏（resume / 展示需要完整内容）；POSIX 下 0600 best-effort。
- **读取与重建**：`readTraceEvents(traceDir, filter)` 默认 limit 50、最大 500，按 `(seq ?? ts)` 升序，
  跳过损坏行；`rebuildMetrics(traceDir)` 返回与实时 `MetricsSnapshot` 同形状，`updated_at = max(ts)`。
- **取消**：显式用户取消只发 `run.cancelled`，不再同时发 `run.failed`；Host 关闭 / 中断仍发
  `run.failed`。`run()` 与 `resumeRun()` 共用 `finalizeRun`，resume 的用户取消同样发 `run.cancelled`
  （ADR-054）。因此 `metrics.runs.cancelled` 可能非 0。
- **事件归属**：core 发 `session.saved/deleted`、`hook.*`、`run.cancelled`、`installPlugin` 的
  `plugin.*`；asm 发 `config.loaded` 与 `PluginLoader` 的 `plugin.loaded/failed`；ext 发
  `eval.*` / `feishu.*` / `mcp.*` / `subagent.*`。