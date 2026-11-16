---
title: 会话重放总架构
kind: current
triggers: [会话重放, 重放总架构, 刷新丢事件, 刷新后少了一段, 刷新只剩几条, 事件回填, 单游标, client_timeline_seq, timeline_seq, 区间回填, 按段续拉, 四条校验, timeline.hello, timeline_head, wal_head, published_head, holes, tainted, 污点条, timeline.gap_reported, sessions.events, event_cursor, 无洞, 重放幂等]
paths: [apps/web/src/gateway/timeline-protocol.ts, apps/web/src/gateway/subscription.ts, apps/web/src/state/event-store.ts, apps/web/src/domains/chat/TimelineGapBar.tsx, packages/serve/src/protocol.ts, packages/serve/src/gateway/timeline-protocol.ts, packages/serve/src/gateway.ts, packages/core/src/timeline/holes.ts, packages/core/src/timeline/writer.ts]
---

# 会话重放总架构

> 一句话：**一条读路径、一个游标、一个区间**。前端只持 `client_timeline_seq`，回填按**一个区间**
> `[after+1, wal_head]` 一次拿全，并按**四条硬校验**核对；对不上就挂污点条、重拉该区间一次。
> 旧的三源契约（`disk-replay` / `replay-source` / 时间截断 / 两阶段回填）已随 0.54 实现整段删除，
> 回放**只有这一条**路径，不存在可切换的第二条。

## 1. 唯一读路径（入口 → 落点）

| 环节 | 落点 |
|---|---|
| 协议适配：游标 → 区间声明 → 四条校验 | `apps/web/src/gateway/timeline-protocol.ts`：`readTimelineCursor:189`、`planBackfill:231`、`planRange:251`、`validateTimelineRange:298`、`collectTimelineRange:405` |
| 调度：读游标 → 拉区间 → **追平后**才订阅实时 | `apps/web/src/gateway/subscription.ts:12-27`（三步顺序写死，不许并行）、`runTimelineBackfill:297` |
| 落点：区间整批并入 / 服务端声明的段 | `EventStore#applyTimelineRange`（`apps/web/src/state/event-store.ts:509`）、`EventStore#beginTimelineEpoch`（`:352`） |
| 服务端声明与 `count` | `hello.timeline`（`packages/serve/src/protocol.ts:145-181`）、`count` 公式（`packages/serve/src/gateway/timeline-protocol.ts:13-30`）、能力位 `timeline.cursor`（`packages/serve/src/gateway.ts:1027`） |

区间与实时流共用**同一个** `timeline_seq` 空间（ADR-105 §7），所以既没有「负数带」，也没有内容 id 去重：
`entries` 天然升序，重复帧按「`seq <= client_timeline_seq`」记账拒绝、不再静默吸收（`event-store.ts:427-457`）。

## 2. 握手：服务端声明，客户端只核对

- `hello` 的时间线段**六字段**：`start_seq` / `end_seq` / `count` / `timeline_head` / `wal_head` / `holes`
  （`packages/serve/src/protocol.ts:145-181`；定义见 ADR-105 §6），pub-i2 再加 `published_head`。
- **两个事实两个字段，绝不合并**：`end_seq = wal_head` 是**可读性**（`[1..wal_head]` 每条可读或已声明成洞），
  `published_head` 是**推送**（`<= wal_head`）。`count` 只算有效右端 `min(end_seq, published_head)` 以内
  （`packages/serve/src/gateway/timeline-protocol.ts:20-30`；ADR-105 §11.1「落地后的精确口径」）。
- 只有 `timeline_source === 'timeline'` 的段做四条校验（`apps/web/src/gateway/timeline-protocol.ts:117-151`、
  `packages/serve/src/gateway.ts:1020-1027`）；`timeline_source` 缺省 = 老服务端，等价旧行为。
- 一次区间拉取 8 s 超时：超时按「缺失」处理，交给四条校验变成**可见**缺口（`subscription.ts:49-53`）。

## 3. 等式与四条校验（判据）

> **UI == timeline(seq ≤ timeline_head) ∪ WAL(timeline_head < seq ≤ wal_head)**，其中**只有
> `published_head` 以内的会被推送**（ADR-105 §7 + §11.1：`published_head < wal_head` 的那一小段
> 允许永远不推，客户端不得据它报缺口）。

四条校验全部**硬**（`validateTimelineRange`，`timeline-protocol.ts:287-359`）：① 首条 = 区间内第一个非洞
seq；② 末条 = 区间内最后一个非洞 seq；③ 实收条数 `=== count`；④ 无重复 seq。任一不成立 ⇒ **一条都不
合并** + 报缺口（`source: 'range'`，带 `rule` 编号）+ 重拉该区间**一次**（`subscription.ts:297-333`）。
洞是**声明**不是猜：`count` 与期望集合都先按 `holes` 减掉（`timeline-protocol.ts:202-219`、
`packages/core/src/timeline/holes.ts`）。

0.53 的 `D` / `R` / `U` 三边界判据、以及「`U` 是空集」的结案见
[unacked-queue-closure.md](unacked-queue-closure.md)：发布唯一出口在 WAL fsync 之后，等式右边两段都在磁盘上。
（该文 §6「契约 ≠ 现状」写于 publish 接线之前，现状以 `src/timeline-dual-write.ts:43-80` 为准。）

## 4. 缺口：污点条，不阻断渲染

- 落点：`EventStore#reportTimelineGap` 写 `timelineGap` 快照并**立即 flush**（`event-store.ts:319-338`），
  UI 由 `TimelineGapBar`（`apps/web/src/domains/chat/TimelineGapBar.tsx`，挂在 `ChatView.tsx:452`）渲染 ——
  **标记但不阻断渲染**（ADR-105 §6）。
- 上报：客户端连接帧 `{kind:'timeline_gap'}`（`packages/serve/src/protocol.ts:238-262`）→ 服务端记
  `timeline.gap_reported`（`packages/serve/src/gateway.ts:2609-2658`，可见性档 `observe`：
  `apps/web/src/state/event-visibility.ts:156`）。服务端**只记录**：不改 `holes`、不改读源。
- `tainted` 的语义是「**现在**有一段读不回来」：重拉补齐后 `clearTimelineGap` 收起
  （`event-store.ts:385-397`），累计计数 `reports` 只增不减；声明洞（`source: 'holes'`）不收起 ——
  除非洞被**退役**（`hole_retired` 声明 + 区间重读自证：`packages/core/src/timeline/holes.ts:365`、
  `packages/core/src/timeline/writer.ts:455`）。
- `gap` 帧对**时间线 epoch 永不发**（`packages/serve/src/protocol.ts:193-213` 自述「过渡期字段，B2 落地即删」）：
  时间线段用 `count` + `holes` 表达完整性，缺一条就是客户端自己算错。

## 5. 单区间封顶与按段续拉（实现中）

- 分页只在**区间内部**发生：每页 ≤ 500 条（`collectTimelineRange` 的 `pageLimit` 默认 500，
  `timeline-protocol.ts:405-409`），停止条件只有「游标不前进 / 已到区间右端 / `has_more !== true`」（`:432`）。
- 硬上界 `MAX_TIMELINE_RANGE_PAGES = 200`（`:388`）⇒ 单区间约 **100,000 条**（200 × 500）。触顶**不静默截断**：
  记 `error: 'range page cap reached'`（`:437-441`），调用方照走四条校验，于是它变成**可见**缺口。
- **实现中（web-b2）**：触顶后**按段续拉** —— 剩余区间重新声明成下一段继续拉，而不是整段变成缺口；
  目标口径是「区间可续、声明不撒谎」。落地前这一行不删。

## 6. 相关文档与未核实

- 落盘口径（新格式 / 旧格式 / 迁移目标）：[event-log-policy.md](event-log-policy.md)；事件命名与可见性：[events.md](events.md)
- 0.53 悬空项的结案（`U` 为何是空集、两指针不变式、chunk 的内存窗口）：[unacked-queue-closure.md](unacked-queue-closure.md)
- 0.53 三源形态的历史记录（只作历史引用）：[refresh-gap-design.md](../dev/handoff/refresh-gap-design.md)、
  [chunk-loss-measurement.md](../dev/handoff/chunk-loss-measurement.md)
- 迁移计划（A/B/C、受影响 9 项、回退）：[plan-054-timeline-migration.md](../dev/handoff/plan-054-timeline-migration.md)

**未核实**（不按已实现写）：

1. §5 的「按段续拉」：本分支 `collectTimelineRange` 触顶仍返回 `error`（`timeline-protocol.ts:437-441`）。
2. 「刷新不清零」的本地游标：`event-store.ts:210-216` 的注释指向 `apps/web/src/state/timeline-cursor.ts`，
   但该文件不存在；`clear(nextSeq = 0)` 仍把游标置为入参（`:804-810`）。
3. `events.list` 换源（`seq` → `timeline_seq`）：仍是 `trace.readEvents`
   （`packages/serve/src/gateway/methods/observability.ts:36-90` → `packages/core/src/observability/read-trace.ts:120`）。
4. 污点条的 UI 快照断言（plan-054 B-3 要求）：未核实。
5. 子 agent 事件归属未逐条核对（ADR-105 §10 第 2 项）。
