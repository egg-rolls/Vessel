---
title: 刷新后「本次 run 的事件只剩 4 个」——丢失所在跳的定位与可复现探针
kind: findings
status: 待拍板
date: 2026-11-15
author: replay-audit (contractor)
base_commit: 7eacfca9
triggers:
  - 刷新丢事件
  - 刷新后只剩 4 个
  - 刷新/切换后本次 run 事件丢失
  - 环回放缺 run.started
  - sessions.events 未接线
  - derived_upto_seq 冻结
  - 回填不读磁盘
---

# 刷新后「本次 run 的事件只剩 4 个」——丢失所在跳

> 本报告只读 `C:/Users/Lirui/.vessel/data`，未改任何产品代码。产物：本文件 + `scripts/probe-replay-gap.ts`。

## 0. 一句话结论

**丢失在「落盘事件日志 → 前端」这一跳：`apps/web` 从头到尾没有一条代码去读会话事件日志（`sessions.events`/`event_cursor` 在全仓 `apps/web` 里零引用）。前端刷新时实际只用两个来源——① `sessions.get.messages`（一个落后于 `derived_upto_seq` 的会话投影）与 ② 进程内环的 `events.subscribe` 回放（被未落盘的 `llm.stream.chunk` 占满、且进程重启即空）。本次 run 的十余条事实事件在磁盘 `events.ndjson` 里一条不少、`sessions.events(since_seq=derived_upto_seq)` 可以全量取回，但前端没调，所以刷新后只剩投影水位那 4 条。**

用户说的「只剩 4 个」不是巧合：**4 = `index.json` 的 `derived_upto_seq`**。首轮会话的 run 起点固定落在 seq 4（`session.created`/`run.started`/`message.injected`/`user.message`），普通 run 全程不推进 `derived_upto_seq`，所以「只剩 4」会稳定复现。

---

## 1. 三条（实为五条）事实源对照表

一次真实运行中会话 `289a0e6d-…`（`status: running`）的同一时刻抓取（UTC `2026-11-15T02:51:04Z`；磁盘仍在增长，数字只用于对照）：

| 事实源 | 条数 | seq / 范围 | 时间/水位 | 结论 |
| --- | --- | --- | --- | --- |
| 磁盘 `sessions/<id>/events.ndjson` | **366** | seq 1..366 | 文件尾 seq=366 | **唯一完整真相源**；本次 run 起点 `run.started`@2 |
| `sessions.get.messages` | **3** 条消息 | 由 `seq ≤ derived_upto_seq` 派生 | `messages_total=3`, `msgs_len=3` | **不是事件日志**，是投影；运行中只到 run 起点 |
| `sessions.get.event_cursor` | `{last_seq:366, derived_upto_seq:4, event_count:4}` | `last_seq` 文件尾（不依赖索引）；`derived` 来自 `index.json` | `derived=4 < last_seq=366` ⇒ 有 362 条没进投影 | 语义正确，但前端不用 |
| `sessions.events(since_seq=4)` | **362**（seq 5..366） | 排他游标、分页 | `latest_seq=366` | **能把缺的全拿回**（RPC ok） |
| 进程内环 `events.subscribe{since:0, session_id}` | **2000**（预算下限） | 只覆盖最近窗口 | `llm.stream.chunk` **1872/2000 = 93.6%**；`run.started` **不在窗口**（`hasRunStart=false`）；`gap {from_seq:1, to_seq:303686}` | 结构骨架被 chunk 挤出去 |
| 前端 `apps/web` | — | — | `sessions.events`/`event_cursor` **零引用** | **没有读磁盘事件日志的链路** |

对照：一个 `status: completed` 的会话（`6f58b881-…`）`derived_upto_seq=605 == last_seq=605`，`sessions.get.messages=263`、环回放只剩 15 条尾巴——**已完成 run 的刷新靠消息投影就够**（本 bug 只打「运行中」的 run）。

`derived_upto_seq` 的推进点：`packages/core/src/runtime/run-journal.ts#saveSessionState`（第 204-209 行）只在**初始保存 / checkpoint / 终态 / 手动压缩**四路把它设成 `currentSeq`。普通 run 没有 checkpoint 时，它全程停在 run 起点。

---

### 1b. 三源类型差集（直接检验外部假设 A3「落盘层只存 message/response」）

同一 running 会话、同一窗口（UTC `02:51`）。`S_disk` = `events.ndjson`；`S_ring` = `events.subscribe{since:0, session_id}` 回放；`S_rpc` = 前端收到的原始事件帧 ≈ `S_ring` 子集（前端只是把 subscribe 帧 push 进 `EventStore`，没有第二来源）。

| 事件类型 | S_disk | S_ring(2000 条内) | 归属 |
| --- | ---: | ---: | --- |
| `tool.call.started` | 90 | 5 | **两边都有** |
| `tool.call.completed` | 89 | 4 | 两边都有 |
| `llm.request` | 70 | 4 | 两边都有 |
| `llm.response` | 70 | 5 | 两边都有 |
| `llm.stream.summary` | 114 | 8 | 两边都有 |
| `message.injected` | 2 | 1 | 两边都有 |
| `run.started` | 1 | **0** | **disk-only（环已淘汰）** |
| `user.message` | 1 | **0** | **disk-only（环已淘汰）** |
| `session.created` | 1 | **0** | **disk-only** |
| `prompt.system_context` | 1 | **0** | **disk-only** |
| `llm.stream.chunk` | 0 | 1910 | **ring-only（按策略不落盘）** |
| `context.changed` | 0 | 10 | ring-only |
| `run.checkpoint` | 0 | 4 | ring-only |
| `hook.started` / `hook.completed` | 0 | 24 / 24 | ring-only |
| `runtime.notice` | 0 | 1 | ring-only |

**结论：**

1. **A3 被数据否定**：磁盘**确实**落了 `tool.call.*`（90/89）、`llm.request`（70）、`llm.stream.summary`（114）——不是「只存 message/response」。写入侧没有类型白名单把结构事件丢掉。
2. 但存在**另一条（方向相反的）不对称**：chunk / `context.changed` / `run.checkpoint` / `hook.*` / `runtime.notice` **只在环、不在磁盘**（chunk 不落盘是 `event-log-policy` 的既有规定）。这些类型**方案 B 的磁盘回填盖不住**，重启即永久丢——这是本报告的**已知边界**，不是用户这次的「只剩 4」。
3. 决定性的不对称：`run.started` / `user.message` / `session.created` / `prompt.system_context` 是 **disk-only 且已被环淘汰**（S_disk 有、S_ring 无、S_rpc 无）⇒ 正好落在外部分支 **step 3「回填没回退磁盘」（D1/D2）**，与主结论一致：**缺的链路是「前端读磁盘事件日志」。**

### 1c. 「按全局 seq 对齐三源」今天做不到——两处结构性障碍

1. **两套 seq 空间**：磁盘 `events.ndjson` 的 `seq` 是**每会话单调**（1..N）；环/SSE 的 `seq` 是**进程内全局自增**（hub seq，重启归零）。两者无映射（`refresh-gap-design.md` §2.2-4）。所以外部决策树里「以全局 seq 对齐 S_disk/S_ring/S_rpc」当前无法执行：磁盘回填只能按**会话 seq** 翻页；跨源去重只能靠 `(run_id, ts, type)` 或服务端稳定 id（`input_message_id`）。方案 C（`session_seq`）正是为消除这条障碍。
2. **前端没有「unacked（未确认落盘）」队列**：服务端有内存 append 队列与 `lastPersistedSeq`（`run-journal.ts#currentSeq` 优先用它），文件尾 `lastSeq` 只反映**已 flush** 的部分，未 flush 的在途事件只在环里；前端 store 完全没有 unacked 概念。⇒ 外部验收等式的 `unacked(本run)` 右半边**当前无法枚举，需新增**（见 §5）。

---

## 2. 丢失发生在哪一跳

**答案：前端合并/取数前的「落盘→前端」链路缺失（不是磁盘、不是 RPC、不是渲染）。**

逐条回答任务问题：

- **磁盘上有没有？有。** `events.ndjson` 有本次 run 的全部事件（seq 1..366），bad-line 容错读可全解。⇒ 不在写入侧。
- **`sessions.events` 能拉回来吗？能。** 实测 `sessions.events({session_id, since_seq:4, limit:500})` 返回 `ok:true, events:362, next_seq:366, latest_seq:366`。⇒ 不在 RPC 的 `since_seq`/分页/过滤（`scripts/check-session-events.ts` 已覆盖 F1-F8）。
- **前端刷新到底调了什么？** `apps/web/src/gateway/subscription.ts`：Chat 订阅 `events.subscribe{since:0, session_id}`，拿到 hello/gap 后走 `until_seq` **只问内存环**逐页回退（`MAX_BACKFILL_PAGES=6`），「环里没有了就停手」；**没有任何 `sessions.*` 调用**。`apps/web/src/state/events.ts#buildGroup` 用 `entry.sessionId`（含 `scopeSession` 兜底）填分组归属；`event-store.ts` 的裁剪只动传输窗口、不动已物化 item（所以**不是客户端裁剪丢内容**）。
- **有没有「部分更新覆盖整体」的写法？** 有且危险：`EventStore.beginBackfill` 先 `sink.freeze()` + `truncateAfter(floor)`（`floor=0` 时会 `sink.reset()` 清空物化面），回填若中止（环空 / `pendingHello` 漏消费），时间线停在「刚 reset 完」的空状态，只剩历史消息。这与本次根因同源：回填的数据源是**易失的内存环**，不是磁盘。

### 分岔假设与证据强度

用户「刚才刷新」那一刻的环状态无法从磁盘重建，故把主力根因拆成两个子分岔（**落在同一跳、同一修法**）：

| 分岔 | 机制 | 证据强度 | 判别方法（下次现网） |
| --- | --- | --- | --- |
| **B1 环空**（网关/平台重启、或回填被中止） | 环是进程内存、`seq` 重启归零；刷新 `since:0` 回放为空 ⇒ 只有 `messages`（=derived 水位 4） | **高**：代码 + `probe --selftest` + `restart` 模式实测 **应有 366 / 实际 4 / 丢 362** | 刷新时对比 `hello.incarnation` 与 `node.started_at` 是否变过；`gap` 是否存在 |
| **B2 环饱和/淘汰**（长 run 的 chunk 洪水 + 多会话抢全局环） | `llm.stream.chunk` 不落盘但占环额度，把 `run.started`/结构事件挤出 2000 条回放窗口；或全局环把前缀淘汰 | **高**：live 实测回放 2000 条里 1872 条是 chunk、`run.started` 不在窗口、`gap 1..303686`；`window` 模式复现 **应有 360 / 实际 164 / 丢 196** | `events.subscribe` 的 `hasRunStart`（`buildGroup` 拿不到 run 起点）与 `gap.to_seq` |

> 两者都不需要「磁盘也丢了」——磁盘是好的。这也解释了为什么它长期被误判为「窗口太小」：窗口调大只是让 B2 更难触发，对 B1（重启）完全无效。

---

## 3. 可复现：`scripts/probe-replay-gap.ts`

离线、只读磁盘、不接 gates、不依赖网络；`--window` 模式复用**真实**的 `packages/serve/src/replay-budget.ts` 预算函数。模型对齐前端真实取数：投影 = `seq ≤ derived_upto_seq`；环回放 = 连续后缀预算；磁盘回填 = `seq > derived_upto_seq`。

用法：

```
bun run scripts/probe-replay-gap.ts                 # 默认取最近一个 running 会话
bun run scripts/probe-replay-gap.ts --session <id>
bun run scripts/probe-replay-gap.ts --window --drop-prefix 200 --chunks-per-structure 7
bun run scripts/probe-replay-gap.ts --selftest
```

`--selftest`（稳定、不依赖真实数据）：合成 15 条（4 条 run 前 + 11 条 run 中）、`derived_upto_seq=4`，断言 `应有=15 / 实际=4 / 丢失=11`：

```
[selftest] restart: should=15 actual=4 lost=11 backfill=11 -> PASS
[selftest] window : run.started-in-window=false droppedStructure=0 lost=0 -> PASS
```

真实运行中会话（`restart` 模式，环空）——**就是用户看到的现象**：

```
should-be N    : 348   (all session events on disk)
actual   M     : 4     (rebuildable: projection 4 + ring 0 (empty))
lost     K     : 344   seq = [5,6,7,8,9,10,11,12,13,14,15,16] ... (+332)
  structure    : 235 lost (run.* / tool.* / session.* / ask.* / limit.* / error ...)
  disk-backfill: 344 recoverable via sessions.events(since_seq=4)
lost subset disk: YES  => data is on disk, lost only in the pipe
```

环饱和/淘汰（`--window --drop-prefix 200 --chunks-per-structure 7`）——**live 实测的同一形态**：

```
should-be N    : 360
actual   M     : 164   (rebuildable: projection 4 + ring 160)
lost     K     : 196   seq = [5,6,7,8,9,10,11,12,13,14,15,16] ... (+184)
  disk-backfill: 356 recoverable via sessions.events(since_seq=4)
lost subset disk: YES  => data is on disk, lost only in the pipe
ring window    : kept=1280 dropped=0 droppedStructure=0 floorTruncated=false
  run.started   : inside window: NO  => client grouping loses the run start
```

已完成会话对照（`--session 6f58b881-…`）：`derived=last_seq=605` ⇒ `实际 605 / 丢 0`，证明**只有「运行中（derived < last_seq）」会中招**。

---

## 4. 为什么前 5 次修补没盖住它（带 commit）

全部修补只落在两个方向：**调内存窗口** 与 **服务端加 RPC**；没有一处让前端读磁盘的事件日志。

| commit | 日期 | 做了什么 | 为什么不解决 |
| --- | --- | --- | --- |
| `55d0c3f0` | 2026-10-19 | 引入有界 EventStore | 限的是内存窗口 |
| `71b27cf3` | 2026-11-10 | 重连不再清空/重挂时间线 | 只避免闪烁，不补数据 |
| `76d467ad` | 2026-11-11 | 长 run 不再丢最早的思考 | 客户端淘汰策略微调 |
| `2db7a727` | 2026-11-11 | 活跃 run 不被 chunk 挤出缓冲 | 仍靠内存环 |
| `20eba554` | 2026-11-11 | 刷新/重连按段回放（`until_seq` 回填） | **只问内存环**，环里没有了就停手 |
| `2fa1c413` | 2026-11-12 | 客户端缓冲 2000/10000 → 5000/20000 | 抬上限，重启仍归零 |
| `27440815` + `473bfc4c` | 2026-11-14 | 新增 `sessions.events` + `event_cursor`；环 1万→5万、预算 4→8 MiB | **只做了方案 B 的 serve 侧**；`git show --stat 473bfc4c` = `packages/serve`+`src`+`scripts`，**零 `apps/web`**。前端从不调用 ⇒ 新 RPC 对 UI 是死码 |

`docs/dev/handoff/refresh-gap-design.md` 早已把「方案 B = `sessions.events` 磁盘回填 + 前端 EventStore 权威帧入口」写清楚（§3、§4、§2.2「前端从不读磁盘」）；`473bfc4c` 只落地了服务端一半，**前端那一半从未实现**，所以每次「修好」都只是把短跑从环淘汰里捞回来，重启 / 长 run / chunk 洪水一出现就复发。

---

## 5. 修复方案（需 main 批准后再动产品代码）

**根因修法（方案 B 收尾）：把前端接到磁盘事件日志上。**

1. `apps/web/src/state/event-store.ts`：新增「权威帧」入口（可 `push` 带磁盘 `seq` 的帧，与现有 `push` 共用去重）。
2. `apps/web/src/gateway/subscription.ts`：订阅 hello 后，若 `event_cursor.derived_upto_seq < last_seq`（或 `hasNewestRunStart(sessionId)` 为 false），**先调 `sessions.get` 取 `event_cursor`，再以 `since_seq = 已覆盖水位` 调 `sessions.events` 逐页补到 `latest_seq`**，与环回放共同去重；环回填仅作快速路径。
3. 去重键必须是**服务端稳定 id**（`input_message_id`），否则「补回一段」会变成「回来两条」（见 `refresh-gap-design.md` §6 的 B1–B6 阻塞项）。这部分是同一根因的另一面。

**必须带的、能拦住它的可执行断言（不是加日志）：**

- **A1 静态链路门（最便宜、正好拦住 473bfc4c 这种半截修复）**：新增 `scripts/check-refresh-gap.ts`，断言「若 `packages/serve` 暴露了 `sessions.events`，则 `apps/web/src` 必须至少有一处 `sessions.events` 调用，且 `subscription.ts` 的回填编排存在」。服务端单方面加 RPC ⇒ 立即红。
- **A2 行为门（H-3 编码）**：用 fixture 造 `derived_upto_seq=4 < last_seq=20` 的会话，模拟「刷新 `since:0` + 环空」走完前端回填，断言前端恢复的事件集覆盖闭区间 `[1..last_seq]` 且**零洞**；同时用 spy 断言 `sessions.events` 至少被调用一次、`since_seq` 从 `derived_upto_seq` 起、翻页到 `latest_seq`。若仍只读消息投影 ⇒ 红。
- **A3 幂等门**：同一批事件（live + 回填重叠）重复投递后 item 多重集不变（`(run_id, kind, key)` 唯一）——防止补回变重复。

复用 `scripts/probe-replay-gap.ts` 的口径：把 `lost ⊆ disk-recoverable` 升级为硬断言 `lost == 0`（在 A2 的 fixture 上）。

- **A4 覆盖等式（按外部验收形状，补上缺失的右半边）**：`UI.seq集 == disk(seq ≤ watermark).seq集 ∪ unacked(本run).seq集`，且 `watermark == 磁盘最大已落盘 seq`。**但 `unacked` 集合今天无人维护**：需要新增一个「入环前先入队、磁盘 ack 后才出队」的未确认队列（服务端 `lastPersistedSeq` 目前只到「已 flush 水位」，不含在途；前端无任何 unacked 概念）。在没有这个队列之前，A4 的右半边是悬空的——**把它写进修复范围，而不是拿一个凑不出的等式当绿**。

**边界**：方案 B 只能补**落盘类型**（见 §1b：chunk / `context.changed` / `run.checkpoint` / `hook.*` / `runtime.notice` 只在环、磁盘没有）。要让「流式中途刷新正文也不丢」必须走方案 C（`session_seq` 持久身份）或继续放大环——不要用 A4 去要求磁盘回填它根本没有的类型。

---

## 6. 边界与未做

- 未改 `packages/**`、`src/**`、`apps/**`、`scripts/check-*.ts`、`package.json`、`docs/adr/**`、`docs/architecture/**`；默认 data 目录只读。
- 「运行中的逐 delta 正文」`llm.stream.chunk` **不落盘**，方案 B 只能保证结构骨架 + 已完成正文。要让「流式中途刷新正文完全不丢」需要方案 C（`session_seq` 持久身份）或扩大环。
- live RPC 取证用本地 gateway（`127.0.0.1:8644`，`serve.token`），只读调用 `sessions.get`/`events.subscribe`/`sessions.events`，未改动任何状态。
- 部署注意：`gateway.pid.version` 写的是 `0.52.0`，但实测 `sessions.get` 已返回 `event_cursor`、`sessions.events` 可用（0.53 能力已在跑）。版本号是陈旧标签，不影响结论。
