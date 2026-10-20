---
adr: 67
title: 跨节点去重键与进程代际 incarnation
status: accepted
date: 2026-10-20
related: [36, 49, 52]
tags: [transport, dedup, multi-node, incarnation]
---

## ADR-067：跨节点去重键与进程代际 incarnation

- **上下文**：0.6 的跨节点 transport（ADR-052）用 `(node_id, seq)` 作为事件去重键。这个键假设“同一个 node 的 seq 单调且永不复用”，但两个现实场景会破坏它：(a) 对端进程重启后 seq 从 0 重新计数，本端仍保留旧键，新事件会被当成重复静默丢弃；(b) 同一节点并发或先后运行多个 run 时，每个 run 的 seq 都从局部起点开始，`(node_id, seq)` 会把不同 run 的同一 seq 误判为重复。消息面也有同类问题：入站消息与“本机 `/send`”此前不在同一去重集合，transport 与 gateway 各持一套键。修复时不能要求新旧对端同时升级，否则滚动升级期间会丢事件。去重集合也无法持久化——写入磁盘会引入清理、租户隔离与崩溃一致性问题，超出 0.9 的范围。

- **决策**：
  1. **事件键含代际与 run**：`${node}:${incarnation}:${run_id ?? '-'}` + `:${seq}`，即 `${node}:${incarnation}:${run_id ?? '-'}:${seq}`。`run_id` 缺失时用 `-`，避免空串导致键歧义；无 `seq` 的帧不参与键空间，直接投递。
  2. **代际由进程生成并随帧传播**：每个 gateway 进程启动时生成一个 `incarnation`，随 auth 帧发送；`hello` / `peers` 透出对端代际，transport 用最近一次观察到的值构造键。
  3. **只清该节点的键**：检测到对端代际变化或 seq 回退时，只作废该来源节点的去重键，不 `clear()` 全局集合——否则其它节点的正常事件会被重复投递。
  4. **旧对端兼容**：对端未提供 `incarnation`（旧网关 / 旧帧）时按固定占位 `-` 处理，行为退化为“同一代际内去重”，不因缺少字段而拒绝连接。
  5. **消息键统一维度**：transport 的消息键为 `${from}:${id}`，本机 `/send` 与入站共用同一去重集合；gateway 的消息键为 `${tenant}:${from}:${id}`；spawn 幂等键为 `${tenant}:${request_id}`（不同 tenant 的同名 id 互不影响）。
  6. **不持久化**：去重集合只活在单 gateway 进程内，语义明确降级为“单进程生命周期内 at-most-once”。

- **备选**：(a) 重启时全局清空——实现简单，但会重复投递其它节点的在途事件，且在网状拓扑下放大回声；(b) 持久化 seen 集合——需要磁盘格式、容量上限、租户隔离与崩溃恢复，0.9 不做；(c) 改用全局 UUID 事件 id——需要改事件生产端与所有对端的协议，破坏兼容；(d) 只加 `run_id` 不加 `incarnation`——仍无法区分同一 run 在重启后的 seq 复用。均不取。

- **后果**：同一节点重启、同一节点多 run、网状回声抑制都能正确去重；升级是向后兼容的，旧对端以 `-` 代际参与。代价是键更长、每个节点需要维护代际状态，且进程重启后可能重复投递已处理过的消息——消费端若要求跨重启 exactly-once，必须自行持久化幂等键。键里含 tenant / from 的约束也意味着不能再用“全局 clear”作为重连恢复手段。

- **关联**：ADR-036（Gateway 协议 v1）、ADR-049（多租户隔离）、ADR-052（跨节点 transport 与 team 调度）；`src/remote-transport.ts`、`src/node-registry.ts`、`packages/serve/src/gateway.ts`、`packages/serve/src/protocol.ts`。
