---
adr: 45
title: 0.4 可观测性与稳定性
status: accepted
date: null
related: [12, 17, 30, 36, 37, 40]
---

## ADR-045：0.4 可观测性与稳定性

- **上下文**：0.3 的长会话、事件历史、run 存储与 gateway 慢客户端缺少统一上限与快照。0.4 需要进程内 metrics、事件历史环形缓冲、run 清理 helper 与背压加固，但不能扩 core 接口、不能新增事件、不能改变 0.3 默认行为。
- **决策**：
  1. **Metrics**：`MetricsCollector` 订阅既有事件（`run.started` / `run.completed` / `run.failed` / `run.cancelled` / `tool.call.started` / `tool.call.failed` / `llm.response`），只做进程内聚合；`MetricsSnapshot` 按 DECISION-009 §5.4.1；**不新增事件、不改 runtime**；`duration_ms.avg` 以 completed + failed 为分母，无样本为 0；进程重启即清零，不持久化、不跨 Host 合并。**`runs.cancelled` 保持 0**：取消的 run 计入 `runs.failed`（core 现有取消路径发 `run.failed`）；resume 不计 `runs.started`，按终态计 completed/failed，文档写明 `completed` 可能大于 `started`。`observability.metrics: false` 彻底关闭 collector 注入与 gateway/TUI 控制面。导出：`MetricsCollector`、`MetricsSnapshot` 可从根入口与 `@vessel/core/observability` 导入。**不新增 `./observability` subpath**：0.3 已有该 subpath（当时指向 `src/events/index.ts`），0.4 将其**改指**到新的 `src/observability/index.ts` barrel，并继续 re-export 原 events 符号。
  2. **事件历史上限**：`MemoryEventStreamOptions.maxHistory?`（additive）；**未配置/缺省 = 1000（保持 0.3 实际默认）**；显式 `0` = 不限制；`>0` = 环形缓冲，`getHistory()` 不超过 N。`observability.event_history` 的缺省语义同上，0.4 不得把缺省改成无限。构造函数接受 `MemoryEventStreamOptions | number`，数字形式保持 0.3 语义；`MemoryEventBus` 增加可选 `MemoryEventStreamOptions` 构造参数。**不改变 `replayRun` / `FileEventStore` 语义**；`FileEventStore` 不自动轮转。导出：`MemoryEventStreamOptions` 可从根入口导入。
  3. **run 清理**：`pruneRuns(store, opts?)`（additive helper）。仅给 `status` → 删除全部匹配项；`older_than_ms` / `keep_latest` 至少一个才做年龄/保留裁剪；`keep_latest` 在 status 过滤后的集合内按 `updated_at` 倒序、`run_id` 升序；`keep_latest = 0` 删除全部匹配项；完全无条件 → 不删除。`kept` = 本次操作后仍保留的、符合 `status` 过滤的条目数；`RunStore.list` 的 200 上限不可精确统计，`keep_latest > 200` 不保证精确。**不修改 `RunStore` 接口**；不自动调度。导出：`pruneRuns`、`PruneRunsOptions`、`PruneRunsResult` 可从根入口导入。
  4. **gateway 背压**：gateway `SeqEventBuffer` 的 `maxHistory` 缺省 10000，**永不无界**，与 core `observability.event_history` 的 `0 = unlimited` 语义**独立**、不被覆盖。慢客户端：WS high 2 MiB / low 512 KiB / 硬关闭 4 MiB；SSE high 256 帧 / low 64 帧；超过阈值先丢事件并标记 `gap`，4 MiB 硬断开作为最后手段。单请求体仍限 1 MiB；远程 / 鉴权 / Host / Origin 规则不变。gateway `stop()` 不关闭 asm 注入的 collector / channel，生命周期归 asm。
  5. **加固**：`AgentRuntime` compact 后事件与消息不重复、不丢最后一条用户消息；`InProcessRuntimeHost` 关闭路径清理成员、排队 run、交互请求；大量成员 spawn/close（100 次循环）后内部 Map 无残留；`Scheduler` 队列满 / 并发取消 / 同成员串行不死锁。以测试固定，不改公开语义。
- **备选**：(a) 新增 metrics 事件或第 10 个接口——违反 ADR-012/017 的克制原则；(b) metrics 持久化 / 跨 Host 合并——0.4 只需要进程内快照；(c) 自动 prune 调度器——引入新的生命周期与并发问题；(d) gateway 无界缓冲——慢客户端会导致内存无界增长。均不取。
- **后果**：可观测性不增加扩展面；0.3 默认行为不变（事件历史缺省仍 1000）。metrics 是瞬时值；`runs.cancelled` 保持 0，取消计入 failed；`completed` 可能大于 `started`（resume 不计 started）。事件上限会丢旧事件（回放应使用 `FileEventStore`）；prune 需要显式调用；多 Host 不合并；gateway 缓冲与 core 事件历史相互独立。gateway 慢客户端会收到 `gap`，极端情况下被硬断开（4 MiB），这是刻意的背压。
- **关联**：ADR-030、ADR-036、ADR-037、ADR-040；DECISION-009 §5.4 / §5.7 / §9 / §10.2 / §10.3 / §11.4 / §12.1。

## Errata（0.27 统一 agent/body）

> 2026-10-26，只追加。上文正文保留当时结论；与 0.27 实现不一致处以本条为准，
> 当前模型见 [ADR-097](ADR-097-unified-agent-body-model.md)。

- `RuntimeHost` / `InProcessRuntimeHost` / `AgentHandle` 不在执行路径上：每个 tenant 一个
  `InProcessScheduler`，`AgentService` 注入它；run 只经 `scheduler.submit` 的 executor 调每 body
  的 `AgentRuntime.run`。
- 串行键是 `serialKey = body/session`（`perBodySerial`，默认 true）：同一 body 同时一个 running，
  不同 body 并发；`maxConcurrency` 默认无上限，只有显式正整数才限制。
- per-run session 由 body 决定（`session_id ≡ body_id`）；`ScheduledTask.sessionId` 仍是该 body，
  没有 Host 级成员注册表 / spawn / `AgentHandle` 这一层。
- 以 Host 为执行面的子系统（渠道 runner、workflow、resume 路由）经 `AgentService.admit` 或直接
  `scheduler.submit`；没有第二套 host 生命周期，也没有 Host 合成的 `agent.run.*` /
  `mirror_of_run_id`。
