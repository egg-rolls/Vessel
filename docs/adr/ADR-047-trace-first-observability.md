---
adr: 47
title: trace-first 可观测性
status: accepted
date: 2026-10-18
related: [7, 16, 27, 30, 32, 45]
tags: [trace, observability, privacy]
---

## ADR-047：trace-first 可观测性

- **上下文**：0.4 的 `MetricsCollector` 只在进程内聚合，事件历史是环形缓冲，`FileEventStore` 只用于显式回放。进程重启后 metrics 清零，事故现场不可追溯。0.5 要求所有关键事件默认留痕、可重放、可重建 metrics，同时不能把密钥写进 trace。
- **决策**：
  1. **事件信封增量**：`RunEvent` 增加可选 `seq?` 与 `tenant_id?`；缺失 `tenant_id` 视为 `default`。事件名仍是开放字符串，不新增常量/枚举。
  2. **TraceRecorder port**：`append(event)` 非阻塞入队、按 run 串行落盘；`flush(runId?)` 等待队列排空；`close()` 关闭。默认实现 `FileTraceRecorder`，每 run 一个 `events/<run_id>.jsonl`。
  3. **seq 分配**：由 `FileTraceRecorder` 落盘时分配并以 trace 文件尾部最大 seq 为种子，保证同一 run 跨 resume 单调。内存实时事件允许无 seq；所有消费方按 `(seq ?? ts)` 回退。`events.list` 返回 trace seq；`events.subscribe.since` 是 gateway wire seq，两者分层，不混用。
  4. **写失败与溢出**：`append` 不向事件投递路径抛错；写失败发 `trace.write.failed` 并计数。每 run 队列上限 10,000；溢出丢新事件，同一 run 最多发一次 `trace.write.failed { reason: 'queue_overflow' }`，flush 时直接写一行 `trace.overflow { dropped }` 标记该 trace 不完整，绝不静默。
  5. **级别与留存**：`trace.enabled` 缺省 true；`level` 为 `full` / `metadata` / `off`。`metadata` 只保留信封与白名单字段（`status`、`tool_name`、`duration_ms`、`iterations`、`iteration`、`message_count`、`finish_reason`、`usage.*`），`error` 截断 ≤500 字符、`reason` ≤200 字符，且先脱敏。缺省留存 30 天 / 1,000 runs / 1 GiB（每 tenant，0 = 不限）；prune 在启动时与 `vessel trace prune` 执行，不删除 `running` / `interrupted` run。
  6. **脱敏**：写入 trace 前与 gateway 出站前都必须经过 `TraceRedactor`。core 默认按键名（`api_key|apikey|token|secret|password|authorization|app_secret`）与常见 key 前缀（如 `sk-`）替换为 `***`；`app_id` 只允许前 4 位 + `***`。插件可通过 PluginHost 注入更严格 redactor；`redact-secrets` 提供 `createTraceRedactor(config?)` 与默认实现组合，幂等。
  7. **读取与重建**：`readTraceEvents(traceDir, filter)` 默认 limit 50、最大 500，按 `(seq ?? ts)` 升序返回，跳过损坏行。`rebuildMetrics(traceDir)` 按 JSONL 重放聚合，返回与实时 `MetricsSnapshot` 相同形状；`metrics.updated_at = max(event.ts)`（无事件为 0）。实时 collector 与重建结果必须一致。
  8. **取消语义**：显式用户取消只发 `run.cancelled`，不再同时发 `run.failed`；Host 关闭/中断（`RUN_INTERRUPT_REASONS`）仍发 `run.failed`。因此 `metrics.runs.cancelled` 在 0.5 首次可能非 0；0.4 的 cancel→failed 断言属于历史行为。
  9. **事件归属**：core 发 `session.saved/deleted`、`hook.*`、`run.cancelled`、`installPlugin` 的 `plugin.*`；asm 发 `config.loaded` 与 `PluginLoader` 的 `plugin.loaded/failed`；ext 发 `workflow.*` / `eval.*` / `feishu.*` / `mcp.*` / `subagent.*`。事件必须带 `tenant_id`（缺失视为 `default`）。
  10. **不脱敏的内容**：0.5 不对 run checkpoint、eval 报告、飞书回复做脱敏（resume / 展示需要完整内容）；POSIX 下文件权限 best-effort 0600。这是已知限制，不是“已脱敏”承诺。
- **备选**：(a) 只做进程内 metrics——重启即丢，无法审计；(b) trace 无上限——磁盘无界；(c) 全量脱敏所有落盘内容——会破坏 resume 所需上下文。均不取。
- **后果**：默认全量 trace 会带来磁盘增长，靠 30 天 / 1,000 runs / 1 GiB 与 `metadata` 档控制；溢出会产生不完整 trace，但不会被静默吞掉；redactor 只能降低泄漏面，不是合规保证。`full` 档包含用户消息与工具参数，部署方需自行评估留存与访问控制。
- **关联**：ADR-007 / ADR-016（流式事件）、ADR-027 / ADR-030（开放事件名）、ADR-032（文件回放）、ADR-045（0.4 metrics / prune）；DECISION-010 §2.2；Addendum A-3 §10.3 / §10.7；A-4 §11.1 / §11.2 / §11.3。
