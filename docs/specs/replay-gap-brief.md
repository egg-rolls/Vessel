---
title: 刷新后会话事件遗漏——给外部专家的调研简报
kind: design
status: 待外部输入
triggers:
  - 刷新丢事件
  - 刷新后只剩四个
  - 会话事件遗漏
  - 重放总架构
  - 外部专家调研
  - snapshot then delta
  - 断线重连无洞
  - 事件游标设计
  - un-acked 队列
  - 全局单调 seq
  - gap 协议
  - 截断不可观测
paths:
  - docs/architecture/session-replay.md
  - docs/specs/refresh-gap-design.md
  - packages/serve/src/event-buffer.ts
  - packages/serve/src/replay-budget.ts
  - packages/serve/src/gateway.ts
  - packages/serve/src/gateway/methods/sessions.ts
  - packages/core/src/session/session-event-log.ts
  - packages/core/src/runtime/run-journal.ts
  - apps/web/src/gateway/subscription.ts
  - apps/web/src/state/event-store.ts
  - apps/web/src/domains/chat/transcript-items.ts
---

# 刷新后会话事件遗漏 —— 给外部专家的简报

> **我们要的不是补丁，是可证明不漏的数据模型。**
> 请先读完 §1–§3（全是可核对的事实，每条带 `文件:行号` 或 commit），再回答 §4 的问题。
> 架构本身（不含判断）另见 [session-replay.md](../../architecture/session-replay.md)。

## 0. 一句话症状

用户在**流式 run 进行中按 F5**，回来发现「这次 run 的十几个会话事件只剩四个」。这不是偶发：实测 5–10 分钟的 run，**82%** 会在刷新时丢正文，一旦丢中位丢 9.8%、最坏整段 100%（§3.1）。

## 1. 症状与复现

### 1.1 用户原话与观察

- 「会话事件的展示，是由落盘事件、回放事件、新事件覆盖的；在刷新或者切换之后，会读取落盘事件 + 进行这次 run 的事件回放来获得此刻时间点前的所有事实事件，而不应该出现遗漏。」
- 「我刚才刷新时，发现这次 run 的**十几个会话事件丢了，只剩四个**。」

即：用户的心智模型是「三条来源按水位合并 = 此刻全部事实」。观察到的形态是**只剩尾部几条**，与实测的「环前缀淘汰 ⇒ 一段连续前缀消失」同形（0.53 期的 217 会话 / 1,048 run 刷新丢失实测），但**具体成因未真机核对**（§1.3）。这个差异正是本简报要外部专家回答的核心。

### 1.2 可控复现（1 分钟，不需要长跑）

摘自 `refresh-gap-design.md:282-291`，与代码核对一致：

1. 起 gateway；把环压小（`tenant-event-hub.ts` 的 `maxHistory` 临时改 200），或起 3 个并发会话把**全局**环冲掉（环是全局一份，见 §2.1）。
2. 在同一会话发一条会触发多轮工具调用 + 长输出的消息。
3. 跑到一半按 F5。
4. 观察：WS 收到 `hello`（`from_seq=1`）→ `gap{from_seq:1,to_seq:N}` → 最多 6 次 `until_seq` 回填**全部返回 0 条**或只补到环起点就停手 → 页面上本 run 的流式正文 / 工具卡 / 运行状态消失，只剩已落盘的消息。
5. 对照磁盘：`<data_dir>/sessions/<session_id>/events.ndjson` 里 `seq 1..N` 全在（含 `run.started`）。**这一步就是「丢的是内存窗口，不是记录」的直接证据。**

### 1.3 我们没法在真机上确定的那一步（诚实说明）

「十几个事件只剩四个」具体落在哪一段，**本轮没有真机核对**（见 §6 待核实）。候选机制有三条，代码上都可达：

1. **环淘汰**：环是全局 FIFO，别的会话也在挤（`event-buffer.ts:37-44`、`:59-61`），本 run 的头部被挤出。
2. **客户端 item 折叠**：多条事件本来就折叠成一张卡（`transcript-items.ts:2003`），「事件数」与「卡片数」不是一回事，用户看到的条数天然更少。
3. **渲染窗口夹取**：`MAX_LIVE_GROUPS = 200`（`useChatTranscript.ts:44`）只渲染最近若干 run。

现成探针三个，1 分钟可判定：`claimStats`（`useChatTranscript.ts:568`）、`eventStore.droppedNoise`（`event-store.ts:232`）、`event_cursor.last_seq` 与实际 hub `currentSeq` 对照（`sessions.ts:1140`）。

## 2. 现有架构（文字版）

```
浏览器                                     gateway 进程                          磁盘
────────                                  ─────────────                         ────
EventStore  ←── WS 帧 {seq,event} ────  SeqEventBuffer（全局 FIFO 5 万条）
 (hub seq 去重)     ↑ hello/gap             ↑ 扇入时分配 seq（进程内自增，重启归零）
                    │                       │
              SubscriptionController ──> events.subscribe{since, until_seq}
              （≤6 页环内回填）                                  ←── RunJournal（先落盘后广播）
                                                                      ↓
transcriptMessages ←── RPC sessions.get ──── SessionState.messages   sessions/<id>/events.ndjson
                        （尾窗 100/500）      （run 收尾才写）          （seq 按会话自增，append-only）
```

### 2.1 三条事实源（各自写什么 / 留多久 / 何时会缺）

| 源 | 写什么 | 保留多久 | 什么时候会缺 |
|---|---|---|---|
| 磁盘 · 会话事件日志 | `events.ndjson` 一行一事件，`seq` 按**会话**自增、逐条 `sync`（`session-event-log.ts:451-470`） | append-only，只随 `deleteSession` 删（`:957`） | 写盘失败时事件**仍广播**（`run-journal.ts:283-288`），只上报一次 `session.log.failed`（`:304-330`） |
| 磁盘 · `SessionState.messages` | `sessions.get` 的返回（`sessions.ts:1096-1106`） | 随会话 | run 进行中本轮正文与工具卡整段不在（只在收尾/checkpoint 落盘） |
| 进程内环 | 已广播事件的 `{seq,event}`，**全局一份**（`event-buffer.ts:37-44`），容量 5 万（`:44`），seq 扇入时分配（`tenant-event-hub.ts:123`）、重启归零（`event-buffer.ts:49`） | 进程内存 | 淘汰 / 重启 / 并发会话摊薄 |
| 实时流 | 环的同一个 item 出站，会话归属补在**出站副本**（`gateway.ts:1193`），8 MiB 硬断 + 背压丢帧转 gap（`:475`、`:1236-1243`） | 不保留 | 慢客户端、断线期间 |

**关键不对称**：`llm.stream.chunk` / `context.changed` / `run.checkpoint` / `session.*` / `plugin.*` **不落盘**（`run-journal.ts:56-66`），流式段落只落骨架 `llm.stream.summary`（`event-log-policy.md:31-45`）。所以「在飞请求的正文 + 全部 reasoning」**只存在于环里**，磁盘永远没有。这也是为什么「放大窗口」永远不是修复 —— 窗口只是把洞推远。

### 2.2 刷新时的重放序列（今天实际发生的事）

1. 刷新 = 客户端事件状态清零：`eventStore.clear()` + 首次连接固定 `since: 0`（`connection-handlers.ts:95`、`:265`）。**游标不持久化**。
2. 服务端 `replayTo` → `planReplay` → `hello(from_seq, latest_seq)` → `gap` → 有界回放帧（`gateway.ts:1407-1412`、`:1393-1404`）。
3. 回放 = `hub.since(0)` → 会话过滤 → `tailReplayWindow` 取**有界连续后缀**；预算 = 最新锚点（`run.started` → `user.message`）起的地板 × 1.5，clamp 1–8 MiB / 2k–50k 条（`gateway.ts:1286-1331`、`replay-budget.ts:365-392`）。
4. **`gap` 把两种缺口压成一个区间**：环已淘汰的前缀 ∪ 预算跳过的中间段，协议上不可区分（`gateway.ts:1394-1399`）。
5. 客户端 6 页环内回填（`subscription.ts:40`、`:286-309`），收尾按 hub seq 升序并入（`event-store.ts:472-482`）。
6. 并行拉 `sessions.get` 拿消息尾窗，按**绝对下标窗口**拼前缀（`sessionStore.ts:195-215`）。
7. 消息 item 与 live item 按 **item.key 字面量**合并（`transcript-items.ts:2003`、`:1937-1990`）。

**水印今天只有一个**：hub seq（`event-store.ts:222-224`）。磁盘水位 `event_cursor.last_seq` 已经在 `sessions.get` 里返回（`sessions.ts:1142`、`:1159`），但 `apps/web` 全仓对它和 `sessions.events` **零引用**。

### 2.3 判据（外部补强后的可验证形态）与今天不满足的那一段

记 `D` = 磁盘 `events.ndjson` 中 `seq ≤ w` 的全部记录；`R` = 环内该会话保留事件；`U` = **已发生、尚未被磁盘确认（un-acked）**的事件；水印 `w` 为全局单调 seq。

> **判据**（三行必须同时成立）：
> ① `UI.count(s,t) == count(D(s,w)) + count(U(s,t))`；
> ② `seqSet(UI) == seqSet(D) ⊎ seqSet(U)` —— 无重复、无洞、无越界；
> ③ `w == max{seq | seq ∈ D}`。
> 早期写法 `UI_items(t) == fold(D ∪ R ∪ P)` 与此不等价，且**不可验证**（原因见下表）。

三个边界今天一个都不成立：

| 边界 | 要求 | 今天 | 依据 |
|---|---|---|---|
| `U` 可枚举 | 未 ack 队列：事件入环**前**入队、磁盘 ack 后才出队 | **缺失**。近似物只存 Promise，无事件身份与 seq、不跨进程、且不含非落盘类型（chunk 同步早退直接广播） | `run-journal.ts:109`、`:118-127`、`:281-290`；`session-event-log.ts:451-452` |
| 水印全局单调 | 跨类型、跨子 agent 统一分配、可持久 | 全局计数器只有 hub seq，**易失、重启归零**；磁盘 seq 每会话自增。`ts` / 分类编号 / 内容 hash 都不能当水位 | `event-buffer.ts:49`、`:57`；`session-event-log.ts:451-452` |
| 两侧带计数 | 回放帧回报 `{from_seq, to_seq, count}` | 没有。`hello` 只有 `from_seq` / `latest_seq` | `gateway/frames.ts:88-99` |

没有 `U` 就只能把它写成「环里那些没落盘的」，而环的淘汰顺序由**别的会话**决定（`event-buffer.ts:37-44`）⇒ 集合无界定，① 右半边悬空、② 无从比对 —— 这就是「不可验证」的准确含义。

**不满足的正是 `D \ R`**：磁盘有、环已淘汰。回填只问环（`subscription.ts:286-309`），磁盘读口只到服务端（`sessions.ts:1180`）为止，前端零调用。
次生问题：`D` 与 `R` 用**两个互不翻译的 seq**（§2.4），即使接线也判不了「补完没有」。

### 2.4 ID 与去重契约（今天）

| 身份 | 磁盘 | 环 / 实时 | 一致？ | 今天的去重键 |
|---|---|---|---|---|
| 事件 `seq` | 会话内自增（`session-event-log.ts:451-452`） | 进程内全局自增、重启归零（`event-buffer.ts:49`、`:57`） | ❌ 无映射 | 环内 `seq <= lastSeq` 丢弃（`event-store.ts:265`）；**跨源无键** |
| 消息身份 | **无 `message_id`**，只有 `run_id` / `run_segment`（后者只盖 assistant）（`provider.ts:74`、`:85`） | 事件里的 `data.message` 是同一对象 | ✅ 同值，但都不是消息 id | `msg:<绝对下标>` vs `run:<runId>:input`（`transcript-items.ts:8-19`）⇒ 靠 `ClaimLedger` 认领（`:1835`） |
| 工具 `tool_call_id` | `provider.ts:44` | `event.ts:214`、`:222` | ✅ | 共用 `tool:<callId>`（`transcript-items.ts:13`） |

**唯一三源同值的是 `tool_call_id` 与 `run_id`**；事件 seq 两套、消息 id 不存在。

### 2.5 断线重连的 gap 协议（今天）

今天重连**只传 cursor**：`client.connect(token, eventStore.currentSeq)`（`connection-handlers.ts:260`）。服务端回 `hello(from_seq, latest_seq)` + 有界回放 + `gap`，**不回条数、不保证连续**。

- 服务端会跳段：预算窗口（`gateway.ts:1286-1331`）与环淘汰都能跳过中间区间，两种原因还被压进同一个 `gap`（`:1394-1399`），协议上分不开「可恢复」与「不可恢复」。
- 客户端察觉不到：`push` 只丢 `seq <= lastSeq`（`event-store.ts:265`），洞与重复被静默吸收；`onGap` 注释原文是「静默处理，不重连、不提示。**页面感知不到截断**」（`connection-handlers.ts:221-237`），且 `gap.to_seq < currentSeq` 时直接 `return`（`:231`）。
- 回填同样会截断而不告知：页空 / `hasNewestRunStart` / 6 页上限（`subscription.ts:286-309`）。

**应有形态**：回放区间 `(cursor, head]` + 帧上 `{from_seq, to_seq, count}`（`count == to_seq - from_seq + 1`），客户端**先校验连续**（收到的 seq 集合恰好等于该闭区间且无重复）再合并；不连续就不合并、显式报错、按日志回填。

**原则**：**环只是日志的滑动缓存，重连必须以日志为准。** 今天职责是颠倒的 —— 环是唯一回放源（`gateway.ts:1407-1412` → `hub.since`），磁盘口 `sessions.events` 无人调用（`sessions.ts:1180`），于是「回放能拿到什么」取决于别的会话挤掉了多少。

## 3. 我们已经试过的 5 次修补，与为什么不够

| # | commit（日期） | 声称修了什么 | 实际盖住 | 没盖住 |
|---|---|---|---|---|
| 1 | `05209aca`（11-10） | hydrate 期间不隐藏 running run；出站补 `session_id` | 隐藏行为；增量能被挂回会话 | 事件本体不在环里时仍无内容；更早区间不补 |
| 2 | `20eba554`（11-11） | 按段回放 `until_seq` + 客户端 6 页回填，「长 run 的开头不再丢」 | 环内可回填到环起点 | 环外（提交信息自述「已知上限」）；`MAX_BACKFILL_PAGES=6` 与今天的 5 万条环已不匹配（推导已写进 `subscription.ts:35-55`：6 页 = 12000 条，环的 24%） |
| 3 | `2db7a727`（11-11，WIP） | 不产 item 的流式增量不进客户端缓冲 | 客户端 per-run 额度不再被 `tool_call_delta` 吃满（`event-store.ts:266-280`） | 只动客户端缓冲；serve 环与磁盘链路未动 |
| 4 | `c21d8c89`（11-12） | 回放预算「结构优先 + 动态」（1 MiB 固定 → clamp） | 单帧窗口变大，锚点更可能在窗口内 | 仍是**有界连续后缀**；锚点被淘汰时 `floorIndex=-1` 直接退化为最小预算（`replay-budget.ts:374-392`） |
| 5 | `473bfc4c`（11-14） | 新增 `sessions.events` + `event_cursor`，环 1 万 → 5 万 | 服务端有了读磁盘的口（`sessions.ts:1180`） | **前端零调用**；没有「刷新后无洞」的门禁 |

**为什么五次都不够（我们自己下的判断）**：三次在调「窗口多大 / 从哪儿往回调」（#2 #3 #4），一次只改显示与归属（#1），一次在服务端开了一个**没人调用的**磁盘口（#5）。没有一次把「`D` 与 `R` 放到同一个可判定的水位上」。所以每次调参在**短 run** 上都"看起来修好了"（短 run 不溢出环），一遇长 run 或多会话并发就复发。

### 3.1 实测数字（供你判断量级；基线 `235a40f8`，当时环 = 1 万，现在 5 万）

- 环被谁吃掉：正文 `text_delta` 只占 **1.7%** 的槽，reasoning **26.8%**，`tool_call_delta` **69.7%**，结构事件 1.8%。
- 1 万条 ≈ 一个 run 最后 **约 200 秒**（长 run 46–52 槽/秒）。
- 5–10 分钟 run：**82%** 刷新丢正文，丢者中位 **9.8%**、最坏 100%；>10 分钟：**94%** 丢、中位 **21.6%**；653 个 run 末尾刷新一次合计丢 **81.7 KB**。
- 9 个真·运行中样本（不是构造）：**7/9 丢 60.5%–100%**。
- **丢掉的正文 100% 已在磁盘 `llm.response`**（653 run：1.45 MB = 流式正文的 100.0%），屏幕丢 ≠ 数据丢。
- 单请求 chunk 峰值：中位 903 / p90 3165 / 最大 11154 条 —— **现役 1 万条已经装不下最长的单个请求**。

## 4. 请你回答的问题（17 条，越具体越好）

**A. 三个「不遗漏」的前提（外部补强的回应，本简报重点）**

1. **un-acked 队列**：我们认同「事件入环前先入队、磁盘 ack 后才出队」是 `U` 可枚举的唯一办法，而今天我们只有一组 write-in-flight Promise（`run-journal.ts:109`），无身份、无 seq、不跨进程。请给最小可用设计：队列里存什么（事件身份？seq？长度？）、谁持有（journal / gateway / 独立 WAL）、重启后怎么恢复、客户端能不能读到它（还是根本不该读）？只在 journal 内保留够不够？
2. **全局单调 seq**：要求跨类型、跨子 agent 统一分配且可持久。现状是「hub seq 全局但易失、磁盘 seq 持久但每会话」（`event-buffer.ts:57`、`session-event-log.ts:451-452`）。你会把全局 seq 放在哪一层（事件生产者 / 日志写入点 / hub 扇入点）、由谁持久、重启怎么续（`epoch + seq` 复合键？`incarnation` 已存在，够不够）？请顺手反驳「用 timestamp 当水位就行」。
3. **两侧计数是否足够**：`{from_seq, to_seq, count}` 能挡住「洞」但挡不住「错序/错内容」。要证明 ② 的集合相等，是否需要每页 / 每 epoch 的哈希（Merkle 根）？粒度选在哪最划算？
4. **gap 协议**：重连回放 `(cursor, head]` + 边界 seq + 条数 + 客户端先校验连续再合并 —— 这个设计还缺什么？今天「服务端跳段」与「前端截断」双方都无法察觉（`connection-handlers.ts:221-237`），你认为最小可观测信号是什么：显式 `truncated{reason}` 帧、每页 ack、还是别的？
5. **职责**：「环只是日志的滑动缓存，重连必须以日志为准」。这条落地后环还剩什么价值（只做低延迟推送）？两者如何分工而不出现两个真相？服务端在读日志做回放时的延迟预算（今天预算逻辑是给内存环设计的，`replay-budget.ts:365-392`）你怎么估？

**B. 边界与真相源**

6. 流式增量（live）与会话历史（history）的**边界**应该以什么作为单一真相？是「持久事件 id」、「消息 id」、还是「快照 + 序号」？给出你认为唯一不歧义的定义。
7. 一台 gateway 同时服务多会话，全局一个 FIFO 是否从根本上就错？按会话分片 + 全局序（每会话一个持久游标、全局一个单调计数器）的取舍是什么？
8. 未落盘的流式 chunk 是否本身就不该算「事实」？如果 UI 在运行中必须自足，**最小持久化单位**是什么（段级骨架 / 256 B 聚合 / WAL）？代价如何量化？

**C. 游标与「无洞」的证明**

9. 增量拉取应该用 `seq`、`timestamp`，还是单调游标（Lamport / hybrid logical clock）？跨**进程重启**后游标凭什么继续有效（我们把 `incarnation` 放在 `hello` 里，但它不参与编号）？
10. 环与磁盘双写是否需要 `(source, seq)` 的全局序？还是应该让**落盘先取号、广播用同一个号**（我们今天是「先落盘后广播」，`run-journal.ts:281-289`，但 chunk 同步广播 ⇒ 两者不保序）——这条你会怎么设计？
11. `gap` 是否应该区分「已淘汰（不可恢复）」与「预算跳过（可恢复）」两种原因？今天它们被压成一个区间（`gateway.ts:1394-1399`）。如果拆开，客户端的状态机应该长什么样？
12. 服务端是否应该提供「快照（含水位）+ 增量」两段式（snapshot-then-delta）？快照的水位语义你会怎么定义（`last_seq` / `derived_upto_seq` / 双水位）？

**D. 前端合并策略**

13. 前端合并是否应该**禁止部分更新**、改为「重建快照」？如果重建，如何避免整页闪烁与滚动位置丢失（我们为此专门做过一次修补，`71b27cf3`）？
14. 我们的消息侧没有 `message_id`（只有 `run_id` + `run_segment`，`provider.ts:74`、`:85`），跨源去重只能靠「position key + 启发式认领」。你会怎么补：ULID？`(run_id, segment)`？还是别的东西能在 Output guardrail 改写正文后仍然稳定？

**E. 测试与形式化**

15. 这类 bug 的**可执行断言**你会怎么写？请给一条你认为最强的属性测试（例如：任意前缀截断 + 任意重连序列 ⇒ UI 集合等于未中断参照集合）。它要能拦住「只有按 F5 才出现」的 bug，而不是手工点刷新。
16. 「不遗漏」你会用什么不变量表述成**机器可检查**形式？我们现在写的是 `UI.count == disk(seq≤w).count + unacked.count` ∧ `seqSet(UI) == seqSet(D) ⊎ seqSet(U)` ∧ `w == max(D)`（§2.3），你觉得还缺哪一项（子 agent？跨会话？compaction / rewind 这类会改历史的操作？）。
17. **竞品机制**：请联网查证并对比（OpenAI ChatGPT 的流式恢复、Claude Code / Codex CLI 的 session resume、Cursor 的 agent transcript、以及任何公开做过 "resumable event stream" 的产品）。我们要的是**具体机制**：它们的游标是什么、un-acked 与快照怎么拼、重连怎么证明无洞。不要泛泛说「用 WebSocket + 重试」。

## 5. 约束（请在这些约束内给方案）

- **不要建议「再加一层缓存」。** 缓存不产生新的真相，只会多一份会过期的副本 —— 我们已走过的路就是两次调大窗口（回放预算 `c21d8c89`、环 1 万 → 5 万 `473bfc4c`），洞每次都只是被推远。
- 我们要的是**可证明不漏**的数据模型：给出不变量、给出判据、给出反例构造法。
- 允许改协议（additive 优先）、允许改落盘 schema、允许改前端合并策略；**不允许**用「调大阈值 / 放宽计数 / 换比较口径」让指标变绿 —— 验收必须在「环压到 200 条」与「重建 hub（seq 归零）」两种环境下都通过（`refresh-gap-design.md:263`、`:244-274`）。
- 同理，为 `U` 引入的任何队列**必须能在进程重启后重新界定**，否则它只是又一个内存窗口（我们今天已经有一个 `pendingEventLogWrites`，重启即蒸发）。

## 6. 我们的待核实清单（这些我们没敢当结论）

1. 「十几个事件只剩四个」的具体成因段（环淘汰 / item 折叠 / 渲染窗口）—— 未真机核对，§1.3 给了 1 分钟探针。
2. hub seq 与磁盘 seq 是否严格保序 —— 机制上可达不保序（chunk 同步广播 vs 落盘异步广播），影响面未评估。
3. 会话事件日志除 `deleteSession` 外是否还有目录级 GC / 配额 —— 本 worktree 内无证据。
4. ~~`subscription.ts:34-39` 的「6 页足够」是按环 10000 条推的~~ **已复算并写进注释**（`subscription.ts:35-55`）：保守上界 25 页（50000 / 2000），6 页只覆盖 12000 条（环的 24%），真实需求是「本 run 起点→尾部」的条数（单请求 chunk 峰值 11154 条已超 6 页）；上调属行为变更，待立项。
5. §3.1 的所有数字是**环 = 1 万**时测的；抬到 5 万后未重新实测（预期「≤10 分钟不丢」，但「长 run + 并发」两档必然复发）。
6. **子 agent 的事件是否在同一会话日志内编号** —— 决定全局 seq 要不要跨子 agent 分配；本 worktree 内未逐条核对 subagent 的事件归属。
7. `pendingEventLogWrites`（`run-journal.ts:109`）之外，是否还有第二条「已发布但未落盘」的路径 —— 本次只核对了 `appendFact` / `appendObserved` 两个入口，未排查所有 `publish` 调用点。

## 7. 附录：证据索引

| 结论 | 出处 |
|---|---|
| 丢失窗口公式 `lost = [1, ring.oldestSeq-1] ∩ {尚未变成 messages 的事件}` | `refresh-gap-design.md:96-100` |
| 确定性复算（12200 条事件 ⇒ 2200 条永久不送达） | `refresh-gap-design.md:102-124` |
| 方案 A/B/C 对比与推荐顺序 | `refresh-gap-design.md:186-237` |
| 硬验收 H-1/H-2/H-3 | `refresh-gap-design.md:244-274` |
| 环槽构成 / 丢失分布 / 已落盘副本占比 | 0.53 期刷新丢失实测（217 会话 / 1,048 run；数字见 §6 清单） |
| 会话日志落盘口径（哪些不落、骨架对账式） | `event-log-policy.md:13-45` |
| 三条事实源与重放序列（本仓口径） | [session-replay.md](../../architecture/session-replay.md) |
| 未 ack 队列的今天近似物（只是 Promise 集合） | `run-journal.ts:109`、`:118-127`、`:281-290` |
| gap 被静默处理（「页面感知不到截断」是代码注释原文） | `connection-handlers.ts:221-237`、`:231` |
| 回放帧没有条数（只有 `from_seq` / `latest_seq`） | `gateway/frames.ts:88-99` |

## 8. 附：三个 1 分钟探针（audit 直接照做，不需要改代码）

**前置：定位会话事件日志。** `<data_dir>` 默认 `~/.vessel`（`packages/config/src/loader.ts:125`），日志在 `<data_dir>/sessions/<session_id>/events.ndjson`（`packages/core/src/tenant/tenant-paths.ts:79-81`）：

```bash
ls -lt ~/.vessel/sessions/ | head -5          # 最近活跃的会话目录
export SID=<会话 id>
export D=~/.vessel/sessions/$SID
```

### 探针 1：缺口是否落在 `D \ R`（磁盘有、环已淘汰）

```bash
wc -l $D/events.ndjson                                  # 磁盘总条数
tail -1 $D/events.ndjson | jq -r .seq                   # 磁盘最大 seq（会话内编号）
jq -c 'select(.type=="run.started") | {seq, run_id:.data.run_id}' $D/events.ndjson | tail -3
```

刷新**之后**在 DevTools → Network → WS → Messages 里搜 `"hello"`，读 `from_seq` / `latest_seq`（`gateway/frames.ts:88-99`）。

**判定**：最新 `run.started` 的 `seq` **≤** `hello.from_seq - 1` ⇒ 本 run 的起点已被环淘汰，缺口正是 `D \ R`（§2.3 的不可恢复那一段）。若反过来（`run.started` 的 seq ≥ `from_seq`），缺口在环内，本来就该被回填补上 —— 那就是回填的 bug，不是淘汰。

> ⚠️ 不要拿 `hello.latest_seq` 与磁盘 `.seq` 比大小：两个编号空间不同（§2.4 第一行）。这段对照只在**两侧都换算到会话内 seq** 时才有意义。

### 探针 2：丢的是不是「本来就不产 item 的噪声」

Sources 面板里对 `apps/web/src/state/event-store.ts:278`（`this.droppedNoiseCount += 1`）加 **logpoint**（右键行号 → *Add logpoint*，不改代码）：

```js
{ seq: meta.seq, type: event.type }
```

刷新一次，看命中：

- 全是 `llm.stream.chunk` / `tool_call_delta` ⇒ 只在丢不可见噪声，屏上条数少是 fold 的结果（§1.3 候选 b），**不是**本 bug。
- 出现 `run.started` / `user.message` / `tool.call.*` / `run.completed` ⇒ 真丢可见事件。

### 探针 3：认领/去重是否吃掉了内容

对 `apps/web/src/domains/chat/useChatTranscript.ts:568`（`claimStats: claimLedger.stats`）加 logpoint：

```js
claimLedger.stats
```

刷新一次，读 `ClaimStats` 的五个字段（定义见 `transcript-items.ts:1481-1498`）：

| 字段 | 非 0 的含义 |
|---|---|
| `userMisses` | run 有输入，但历史里找不到可认领的同文消息 ⇒ 输入卡可能重复或被藏 |
| `assistantMisses` | run 有输出，但一条 assistant 都没认领上 ⇒ 终态后正文有两份或让位失败 |
| `unclaimedSegments` | 终态 run 里没让位的正文段（潜在重复渲染） |
| `rewrittenSegments` | 按身份让位、但落盘正文 ≠ 流式原文（guardrail 打码被识别）⇒ 屏上是打码那份，**内容变了但没丢** |
| `decisions` | 账本重判次数（粘住期间不涨；只作参照） |

`unclaimedSegments` / `assistantMisses` 持续非 0 ⇒ 「少了几条」可能是 §2.4 的消息身份问题，不是 `D \ R`。

### 探针 4（可选，30 秒）：磁盘水位 vs 线上水位

DevTools → WS 帧里搜 `event_cursor`（`sessions.get` 的响应里就有，`sessions.ts:1142`、`:1159`；`apps/web` 今天不读它，只当证据面），记下 `event_cursor.last_seq`，与本会话事件数对账。

> ⚠️ 它与 `eventStore.currentSeq`（hub seq）**不同编号空间**（§2.4）。只能比「是否单调前进」「是否等于磁盘 `.seq`」，**不能比大小** —— 要真正对账就得先有 `hub seq ↔ 磁盘 seq` 的映射，那正是 §3 表格第二行缺失的东西。

### 探针结果怎么记

三条探针合起来只有四种结论，请直接落到 §6 的待核实第 1 条：

1. 探针 1 命中 ⇒ 环淘汰（`D \ R`），走磁盘回填那条路。
2. 探针 1 未命中 + 探针 2 只命中共噪声 ⇒ 只是 fold，用户观感问题。
3. 探针 1 未命中 + 探针 2 命中可见事件 ⇒ 回填/合并 bug（在前端接线单 `replay-wire` 范围内）。
4. 探针 3 非 0 ⇒ 消息身份/认领问题，与重放链路正交。
