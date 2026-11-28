---
title: 会话重放总架构
kind: current
triggers: [会话重放, 重放总架构, 刷新丢事件, 刷新后少了一段, 刷新只剩几条, 事件回填, 单游标, client_timeline_seq, timeline_seq, 区间回填, 按段续拉, 四条校验, timeline.hello, timeline_head, wal_head, published_head, holes, tainted, 污点条, timeline.gap_reported, sessions.events, event_cursor, 无洞, 重放幂等, 尾部窗口, timeline-epoch-end, has_more, 结趟]
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
- 只有带时间线段的 hello 做四条校验（`apps/web/src/gateway/timeline-protocol.ts:117-151`、
  `packages/serve/src/gateway.ts:1020-1027`）；0.55 起判据是**形状**（`hello` 上这六个键在不在），
  `timeline_source` 帧字段已删除；没有这几个键 = 老 epoch，等价旧行为。
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
（该文 §6「契约 ≠ 现状」写于 publish 接线之前，现状以 `src/session/timeline-dual-write.ts:43-80` 为准。）

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

## 5. 单段封顶与按段续拉

- 回填按**段**声明：单段上限 `TIMELINE_SEGMENT_MAX_EVENTS = 2000`（`apps/web/src/gateway/timeline-protocol.ts`），段数上界 `MAX_TIMELINE_SEGMENTS = 200`。分页只在段内部发生，页数上界由区间长度算出（`count / pageLimit + 2`），停止条件只有「游标不前进 / 已到段右端 / `has_more !== true`」。
- 触顶**不静默截断**：记 `error: 'page bound hit'`，调用方照走四条校验，于是它变成**可见**缺口；剩余区间重新声明成下一段继续拉（「区间可续、声明不撒谎」），收口点在客户端两侧，见 §7。

## 6. 相关文档与未核实

- 落盘口径（新格式 / 旧格式 / 迁移目标）：[event-log-policy.md](event-log-policy.md)；事件命名：[event-catalog](event-catalog.md)；可见性：[event-visibility](event-visibility.md)
- 0.53 悬空项的结案（`U` 为何是空集、两指针不变式、chunk 的内存窗口）：[unacked-queue-closure.md](unacked-queue-closure.md)
- 0.53 三源形态的历史记录与刷新丢失实测（历史引用，细节不在本仓）：[refresh-gap-design.md](../specs/refresh-gap-design.md)

**未核实**（不按已实现写）：

1. §5 的「按段续拉」：**段级已落地（0.55，见 §7）**；单区间内部的页上限触顶仍返回
   `error: 'page bound hit'`（`timeline-protocol.ts` 的 `collectTimelineRange` 尾部）—— 那是
   「一个区间读不齐」的如实报错，续拉由调用方按**下一段**重新声明，不在页循环里偷偷扩区间。
2. 「刷新不清零」的本地游标：`event-store.ts:210-216` 的注释指向 `apps/web/src/state/timeline-cursor.ts`，
   但该文件不存在；`clear(nextSeq = 0)` 仍把游标置为入参（`:804-810`）。
3. `events.list` 换源（`seq` → `timeline_seq`）：仍是 `trace.readEvents`
   （`packages/serve/src/gateway/methods/observability.ts:36-90` → `packages/core/src/observability/read-trace.ts:120`）。
4. 污点条的 UI 快照断言（plan-054 B-3 要求）：未核实。
5. 子 agent 事件归属未逐条核对（ADR-105 §10 第 2 项）。

## 7. 尾部窗口与显式结趟（客户端）

三件事同时改了「首屏拉多少」与「一趟什么时候算发完」，它们共用同一个预算口径：

- **首屏只取尾部窗口**：`TIMELINE_TAIL_WINDOW_EVENTS = 2000`（`apps/web/src/gateway/timeline-protocol.ts`），
  刷新只回填 `[target - 1999 .. target]`（`target = min(wal_head, published_head)`），更早的段由滚动到顶的
  `loadEarlier()` 一段一段往前要，`hasEarlier` 由 `EventStore#earliestLoadedSeq` 表达。
  **回填失败也不从 0 回放**：chat 订阅的 `after_timeline_seq` 同样夹到 `tailWindowStart(target) - 1`
  （`SubscriptionController#tailWindowFloor`），否则单游标停在 0 时服务端会从 seq 1 回放最老的那一批。
- **一趟结束是帧，不是时钟**：服务端整趟发完后补 `timeline-epoch-end {end_seq, count, has_more}`
  （能力位 `timeline.epoch-end`，帧口径见 [gateway-rpc](gateway-rpc.md)）；客户端收到就结趟，并按
  `has_more` 决定续不续拉。0.54 的「400ms 没新帧 = 这趟发完了」(`EPOCH_IDLE_MS`) **已删除** ——
  网络慢 / 一次 GC 停顿就会误判成「停」并按前缀收口续拉（用户看到的是那条假缺口）。
- **没有结束帧时的兜底也是显式事实**：老服务端（0.54）与「服务端撞背压提前停」都不发结束帧，
  此时订阅 `res` 已回就是「这一趟不会再发帧」的证据，客户端按**连续前缀**收口、按实收末 seq 续拉
  （`EventStore#settleTimelineEpochIfOpen`）。线上序列固定为
  `hello → event×N → timeline-epoch-end → res`，两个判据都在同一条事件流里排好序，不需要等待任何时间。
- `has_more` 由服务端按「后面还有**可读**的」算：尾部只剩写者声明的洞时为 `false`，所以客户端的续拉
  不会原地打转；客户端自己那半边的 stall 保护（连续两趟没有前进就停手）仍在。
