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

同一 running 会话、同一窗口（UTC `02:51`）。注意这里有**两份不同的"磁盘"**：`S_session` = `sessions/<id>/events.ndjson`（会话事件日志，`sessions.events` 读它）；`S_trace` = `data/events/<run_id>.jsonl`（run trace，`events.list` 读它，见 §1d）；`S_ring` = `events.subscribe{since:0, session_id}` 回放；`S_rpc` = 前端收到的原始事件帧 ≈ `S_ring` 子集（前端只是把 subscribe 帧 push 进 `EventStore`，没有第二来源）。下表 `S_disk` 特指 `S_session`（即 `sessions.events` 的来源）。

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
2. 但存在**另一条不对称（修正上一版）**：chunk / `context.changed` / `run.checkpoint` / `hook.*` / `runtime.notice` **不在 session 日志**；其中 `context.changed` / `run.checkpoint` / `hook.*` / `runtime.notice` **确实落在 run trace**（`data/events/<run_id>.jsonl`，见 §1d），**只有 `llm.stream.chunk` 两处都不落**。所以「走 `sessions.events`（session 日志）回填」盖不住这些 trace-only 类型；要盖它们得走 `events.list`（run trace，逐 run）。这是修复选型的关键，不是"磁盘全缺"。
3. 决定性的不对称：`run.started` / `user.message` / `session.created` / `prompt.system_context` 是 **disk-only 且已被环淘汰**（S_disk 有、S_ring 无、S_rpc 无）⇒ 正好落在外部分支 **step 3「回填没回退磁盘」（D1/D2）**，与主结论一致：**缺的链路是「前端读磁盘事件日志」。**

### 1c. 三套 seq 空间：单一整数游标在**各自作用域**内是对的——错的是**混用**

| seq 空间 | 谁产生 | 形状 | 跨 run？ | 重启？ | 消费方 |
| --- | --- | --- | --- | --- | --- |
| **session 日志 seq** | `SessionEventLog`（`sessions/<id>/events.ndjson`） | 单一整数，**每会话全局单调** | **连续跨 run**（实测多 run：`run.started@[2,635]`、`[2,625,1474]`、`[2,1081,1825]`，`seq` 均 `1..N` 连续） | 持久 | `sessions.events`/`event_cursor`/消息投影 |
| **run trace seq** | `trace-recorder`（`data/events/<run_id>.jsonl`） | 单一整数，**每 run 从 1** | **不跨 run**（每 run 独立文件；实测 1177 文件全 `starts_at_seq1`） | 持久 | `events.list`（跑 run 详情/观测） |
| **hub/环 seq** | `SeqEventBuffer`（进程内） | 单一整数，**进程全局自增** | 跨 run（同一进程内连续） | **归零**（`nextSeq=1`） | `events.subscribe`/`until_seq`（聊天实时+回填） |

**结论：单一整数不是 bug。** `sessions.events(since_seq)` 用 session 全局 seq，**跨 run 正确**；`events.list(since_seq)` 用 per-run seq，只要**按 `run_id` 作用域**也正确。「切错」只会发生在把**某个空间的 seq 当另一个空间的游标**用：例如拿 hub seq 去 `sessions.events`、或拿 session 全局 seq 去 `events.list` 跨 run。真正危险的是 **hub seq 重启归零**（B1）：前端 `until_seq` 只对本 epoch 环有效，重启后再问就是空。

### 1d. 直接回应 main 真机事实（三条优先证据）

**① 类型直方图差集（盘=S_session，已补 环 与 RPC）**

- `S_session` / **RPC `sessions.events`**（实测，session 全局 seq）：`session.created, run.started, message.injected, user.message, prompt.system_context, llm.request, llm.stream.summary, llm.response, tool.call.started/completed, run.completed, context.cleared_tool_result`。**没有** `hook.*`/`context.changed`/`run.checkpoint`/`session.saved`/`agent.*`/`ask.*`/`runtime.notice`，**没有** chunk。
- `S_trace`（`data/events/<run_id>.jsonl`，1177 文件，`--trace-dir` 实测）：`hook.started/completed` 各 165958、`context.changed` 103612、`run.checkpoint` 36754、`tool.call.*` 39106/39087、`llm.request/response` 35867/35806、`llm.stream.summary` 19834、`session.saved` 1774、`message.injected` 1427、`agent.*`/`ask.*`/`tool.permission.*`、`run.started/user.message/run.completed` 894/894/817、`runtime.notice` 473、`run.cancelled/failed` 42/20、`tool.call.failed` 15。**`files_with_chunk=0`**（chunk 从不落 trace）。
- `S_ring`（实测 2000 窗口）：`llm.stream.chunk` 1910 + 最近全类型的尾巴。
- ⇒ **A3 再否定一次**：`tool.call.*` 在 session 日志、trace、环**三处都在**。**且不存在单一"磁盘超集"**：session 日志缺 trace-only 类型，trace 缺 chunk。

**② 水印形状**：`sessions.events`、`events.list`、`events.subscribe` 的 `since_seq` **全是单一整数**，差别只在**作用域**（session / run / hub，见 §1c 表）。`sessions.events` 的会话 seq 实测**跨 run 连续**，故单一游标**不是**根因；`events.list` 跨 run 必须按 `run_id` 分次；hub seq 重启归零才是隐患。

**③ 一个会话两个 run**：聊天刷新**不读任何 run trace 文件**——`apps/web` 里 `events.list`/`useRunTrace` 只出现在 `RunDetailPage`（run 详情），聊天走 `events.subscribe`（环）+ `sessions.get.messages`。所以「回填了几个 run 文件」= **0**。多 run 会话由 session 日志的全局 seq 串起来（`run.started@[2,635]`），因此走 `sessions.events` 的回填**天然跨 run 正确**，无需逐 run 文件——**漏的不是"选了哪个 run 文件"，是"根本没有磁盘路径"**。

> 另需注意：聊天时间线 `EventRow`/`StreamItems` 仍会渲染 `hook.*`/`context.changed`/`runtime.notice`（折叠成内部行）。这些是 **trace-only** 类型，`sessions.events` 补不回，要走 `events.list`（逐 `run_id`）。所以如果用户丢的"十几个"里混了这些内部行，方案 B 需要**两条回填**（session 日志 + trace），不是一条。

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
bun run scripts/probe-replay-gap.ts --trace-dir 'C:/Users/Lirui/.vessel/data/events'   # run trace 直方图 + per-run seq 证明
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
2. `apps/web/src/gateway/subscription.ts`：订阅 hello 后，若 `event_cursor.derived_upto_seq < last_seq`（或 `hasNewestRunStart(sessionId)` 为 false）：
   - **主回填 = session 日志**：先 `sessions.get` 取 `event_cursor`，再以 `since_seq = 已覆盖水位` 调 `sessions.events` 逐页补到 `latest_seq`。session seq 是**会话全局单调、跨 run 连续**（§1c 实测），**单个游标就够**，不需要 `(run_id, seq)` 复合游标。
   - **补回 trace-only 类型**（`hook.*` / `context.changed` / `run.checkpoint` / `runtime.notice`… 聊天 `EventRow` 会渲染）：需要 `events.list`，按 `run_id` **逐 run** 拉（其 `seq` 是 per-run，**不能用一个 since_seq 跨 run**——否则正好踩中外部担心的"切错"）。
   - `llm.stream.chunk` 两处磁盘都没有，**无法回填**；UI 应回落到 `llm.stream.summary` / `llm.response` 的聚合正文。
   与环回放共同去重；环回填仅作快速路径。
3. 去重键必须是**服务端稳定 id**（`input_message_id`），否则「补回一段」会变成「回来两条」（见 `refresh-gap-design.md` §6 的 B1–B6 阻塞项）。这部分是同一根因的另一面。

**必须带的、能拦住它的可执行断言（不是加日志）：**

- **A1 静态链路门（最便宜、正好拦住 473bfc4c 这种半截修复）**：新增 `scripts/check-refresh-gap.ts`，断言「若 `packages/serve` 暴露了 `sessions.events`，则 `apps/web/src` 必须至少有一处 `sessions.events` 调用，且 `subscription.ts` 的回填编排存在」。服务端单方面加 RPC ⇒ 立即红。
- **A2 行为门（H-3 编码）**：用 fixture 造 `derived_upto_seq=4 < last_seq=20` 的会话，模拟「刷新 `since:0` + 环空」走完前端回填，断言前端恢复的事件集覆盖闭区间 `[1..last_seq]` 且**零洞**；同时用 spy 断言 `sessions.events` 至少被调用一次、`since_seq` 从 `derived_upto_seq` 起、翻页到 `latest_seq`。若仍只读消息投影 ⇒ 红。
- **A3 幂等门**：同一批事件（live + 回填重叠）重复投递后 item 多重集不变（`(run_id, kind, key)` 唯一）——防止补回变重复。

复用 `scripts/probe-replay-gap.ts` 的口径：把 `lost ⊆ disk-recoverable` 升级为硬断言 `lost == 0`（在 A2 的 fixture 上）。

- **A4 覆盖等式（按外部验收形状，补上缺失的右半边）**：`UI.seq集 == disk(seq ≤ watermark).seq集 ∪ unacked(本run).seq集`，且 `watermark == 磁盘最大已落盘 seq`。**但 `unacked` 集合今天无人维护**：需要新增一个「入环前先入队、磁盘 ack 后才出队」的未确认队列（服务端 `lastPersistedSeq` 目前只到「已 flush 水位」，不含在途；前端无任何 unacked 概念）。在没有这个队列之前，A4 的右半边是悬空的——**把它写进修复范围，而不是拿一个凑不出的等式当绿**。

**边界（修正上一版）**：`context.changed` / `run.checkpoint` / `hook.*` / `runtime.notice` 在 **run trace** 有、session 日志没有（见 §1d），所以**两条回填都要做**（`sessions.events` + `events.list` 逐 run）；`llm.stream.chunk` **两处都没有**，方案 B 盖不住——要「流式中途刷新正文完全不丢」必须走方案 C（`session_seq` 持久身份）或继续放大环。不要用 A4 去要求任何日志回填 chunk。

---

## 6. 边界与未做

- 未改 `packages/**`、`src/**`、`apps/**`、`scripts/check-*.ts`、`package.json`、`docs/adr/**`、`docs/architecture/**`；默认 data 目录只读。
- 「运行中的逐 delta 正文」`llm.stream.chunk` **不落盘**，方案 B 只能保证结构骨架 + 已完成正文。要让「流式中途刷新正文完全不丢」需要方案 C（`session_seq` 持久身份）或扩大环。
- live RPC 取证用本地 gateway（`127.0.0.1:8644`，`serve.token`），只读调用 `sessions.get`/`events.subscribe`/`sessions.events`，未改动任何状态。
- 部署注意：`gateway.pid.version` 写的是 `0.52.0`，但实测 `sessions.get` 已返回 `event_cursor`、`sessions.events` 可用（0.53 能力已在跑）。版本号是陈旧标签，不影响结论。

---

## 7. 真机会话三类拆分（`16d265ec-2d6d-44ea-8e81-5f2ea30c4731`，最后 6 个 run）

该会话现状态 `failed`、42 个 run、2483 条 session 事件。用户"刚才"的批次 = 最近这串失败/取消的 run（最后 6 个）。逐 run 拆三类：

| run(start@seq) | session 日志（可回填） | trace-only（需 events.list） | chunk（磁盘全无） | session seq 区间 | 只做 session 回填 → 补不回 |
| --- | ---: | ---: | ---: | --- | --- |
| d5fbf4cf(2403) | 23 | 68 | 0 | 2403..2425 | 68/91 = 75% |
| fbc9d0a0(2426) | 13 | 36 | 0 | 2426..2438 | 36/49 = 73% |
| 6db3bbd4(2439) | 25 | 79 | 0 | 2439..2463 | 79/104 = 76% |
| 1068d703(2465) | 7 | 547 | 0 | 2464..2470 | 547/554 = 99% |
| 7e5ad4b4(2471) | 7 | 19 | 0 | 2471..2477 | 19/26 = 73% |
| 0ec68b07(2478) | 5 | 18 | 0 | 2478..2482 | 18/23 = 78% |
| **合计** | **80** | **767** | **0** | — | **767/847 = 90.6%** |

trace-only 明细（last 6 runs）：`context.changed` 562、`hook.started/completed` 84/84、`run.checkpoint` 20、`session.saved` 12、`agent.queue.entered/left` 2/2、`runtime.notice` 1。其中 `hook.*`/`run.checkpoint`/`session.saved`/`agent.queue.*` 默认隐藏（204 条），`context.changed`+`runtime.notice` 可能可见（563 条）。

**一句话回答 main：只做 session 日志回填，last-6-run 这 847 条里还剩 767 条（90.6%）补不回；即便只算非隐藏的，仍有 563 条（几乎全是 `context.changed`）补不回。所以方案 B 必须两条回填都做——阶段一（session 日志）对这批失败 run 是杯水车薪。**

> 说明：这批 run 都是失败/取消的短 run，`chunk=0`；真正成功流式的长 run 的 chunk 才两处磁盘都没有（§1d）。"chunk 类=0" 不代表 chunk 不重要，而是这批没有成功流式正文。若用户当时看的是「聊天时间线的可见卡片」而非原始事件，`context.changed`/`hook` 多在内部/折叠行，session 日志占比会更高——但 `runtime.notice` 与折叠的 hook 行照样丢。结论方向不变：**只做一条回填不足以"可证明不漏"**。

## 8. 最小适配器接口（给 replay-wire，`check-replay-merge.ts` 已按此断言）

```ts
export interface ReplayEvent { seq: number; type: string; run_id?: string; ts: number; }
export interface ReplayCursor { last_seq: number; derived_upto_seq: number; }

export interface ReplaySource {
  getCursor(): Promise<ReplayCursor>;                                          // sessions.get.event_cursor
  fetchSessionLogSegment(sinceSeq: number, limit: number): Promise<ReplayEvent[]>;             // 阶段一：sessions.events（session 全局 seq）
  fetchTraceSegment?(runId: string, sinceRunSeq: number, limit: number): Promise<ReplayEvent[]>; // 阶段二：events.list（per-run seq）
  fetchRingSegment(): Promise<ReplayEvent[]>;                                  // 快速路径：events.subscribe{since:0}
}
export interface ReplaySink {
  apply(events: ReplayEvent[]): number;   // 幂等，按稳定 id 去重，返回 distinct 总数
  warn(message: string): void;            // fail-open
}
export interface RecoverOptions { runs?: string[]; }   // 缺省 = 只做阶段一
export function stableEventId(e: ReplayEvent): string { return `${e.run_id ?? ''}|${e.type}|${e.ts}`; }
```

**契约要点**

1. **阶段一 = session 日志**：单一 session 游标（session 全局 seq，跨 run 正确）。
2. **阶段二 = run trace**：必须按 `run_id` **逐 run**（per-run seq，**不能用一个 since_seq 跨 run**）。
3. **跨源去重用 `stableEventId`（内容 id：`run_id|type|ts`），禁止用 seq**——三套 seq 空间不可混。
4. **所有源 fail-open**：报错/超时只 `warn`、不抛、不清空已渲染数据。
5. `derived_upto_seq` 是投影水位：`[1..derived]` 由消息投影覆盖，`[derived+1..last]` 由阶段一覆盖。
6. 稳定 id 三源必须一致（同一逻辑事件的 `run_id/type/ts` 在磁盘与环里相同），否则去重会漏——需服务端保证。

**阶段一 vs 阶段二 验收差异**

| | 覆盖 session 日志类型 | 覆盖 trace-only（hook/context.changed/run.checkpoint/runtime.notice） | 覆盖 chunk |
| --- | --- | --- | --- |
| 只做阶段一（session 日志） | ✅ | ❌（本会话 last-6-run 下 767/847 = 90.6% 补不回） | ❌ |
| 阶段一 + 阶段二（+ trace） | ✅ | ✅ | ❌（磁盘两处都无） |

门禁里用 `[phase1 vs phase1+2]` 一行钉死这个差异（`p1=0 / p1+2>=2`）。

## 9. 已知边界（不阻塞本次修复，但影响「可证明不漏」的完整性）

1. **unacked 队列缺失**：服务端 `lastPersistedSeq` 只到「已 flush 水位」，在途未 flush 事件只在环；前端无 unacked 概念。⇒ 验收等式 `UI.seq集 == disk(seq ≤ watermark) ∪ unacked(本run)` 的右半边当前**无法枚举**。不阻塞方案 B（只补已落盘部分），但做不到「可证明不漏」。
2. **chunk 不落盘**：`llm.stream.chunk` 磁盘两处都无（trace `files_with_chunk=0`），只能从环拿，重启即永久丢。方案 B（含阶段二）都不覆盖；要「流式中途刷新正文不丢」需方案 C（`session_seq` 持久身份）或放大环。
3. **三套 seq 无映射**：session 全局 / run per-run / hub 进程全局，互不映射。跨源只能按内容 id 去重，不能按 seq；`events.list` 必须逐 run 作用域。

> 以上三条：**不阻塞本次修复、会影响「可证明不漏」的完整性**。

## 10. 两条防复发门禁（新建，不改既有 `scripts/check-*.ts`）

- `scripts/check-replay-wiring.ts`（A1 静态链路门，三条并列规则、无白名单）：
  - **F 逐方法接线**：`sessions.events` 与 `events.list` **各自**断言 `serveHas && webRealCall`（真实 `this.request/rpc('m',…)`，注释/字符串常量不算）；serve 有 web 无 = 半截修复；web 有 serve 无 = 调了不存在的 RPC。
  - **F1 禁本地文件系统**：`apps/web` 不得出现 `node:fs`/`fs`/`node:path`/`path` 的 import/require，或 `.vessel/…`、`events.ndjson`、`/sessions/<id>/events.ndjson` 这类本地路径**字符串常量**（注释不算、字符串算）。命中打印 `file:line`。
  - **F2 必须走封装层**：裸 `fetch(`/`WebSocket(` 打网关地址（`127.0.0.1`/`localhost`/`:8644`/`/v1/`、`ws://`）且**不在既定传输封装层**内 ⇒ FAIL；封装层 = `gateway/node/{protocol,rpc}.ts`、`gateway/nodes.ts`、`gateway/platform/{client,hub}.ts`。
  - `--selftest` 覆盖 F/F1/F2 正反例（16 例全 PASS），证明不误判/漏判。
  - **当前 = FAIL**（设计如此）：① `sessions.events` web 零调用（`473bfc4c` 半截态，`replay-wire` 落地后该项转 ok）；② **F1 命中 `apps/web/src/domains/observe/doctorChecks.ts:44` 的字符串常量 `~/.vessel/data`**（既有、注释称"仅展示用"）——按"字符串常量也算"规则命中，建议改为从 `config.get` 取值而非硬编码本地路径；本轮不改 `apps/web`，交 main 决策。
- `scripts/check-replay-merge.ts`（A2 行为 + A3 幂等 + fail-open）：用真实 `replay-budget.ts` + 夹具，断言 覆盖 `[1..366]` 零洞 / 确实调 `sessions.events` / 重叠去重（distinct=366）/ fail-open（不抛+警告+保数据）/ 阶段一补不回 trace-only、阶段一+二能补回。**当前 = PASS（12/12）**。
- **退出码**：本环境 `bun run <file>` 的退出码可被捕获（本次 FAIL 观测到 `1`）；但历史上 `bun -e`/经管道时 `$?` 曾为 0，故 CI 仍建议同时校验 stdout 的 `result: PASS/FAIL`；Linux/原生 CI 上 `process.exit` 正常生效。
