---
title: 会话重放总架构
kind: current
triggers: [会话重放, 重放总架构, 刷新丢事件, 刷新后少了一段, 刷新只剩几条, 事件回填, 三条事实源, 事件游标, event_cursor, sessions.events, 不遗漏判据, 去重契约, 重放幂等, un-acked 队列, 未确认落盘, 全局单调 seq, 水印, gap 协议, 断线重连无洞, 截断]
paths: [packages/serve/src/event-buffer.ts, packages/serve/src/tenant-event-hub.ts, packages/serve/src/replay-budget.ts, packages/serve/src/gateway.ts, packages/serve/src/gateway/methods/sessions.ts, packages/core/src/session/session-event-log.ts, packages/core/src/runtime/run-journal.ts, apps/web/src/gateway/connection-handlers.ts, apps/web/src/gateway/subscription.ts, apps/web/src/state/event-store.ts, apps/web/src/stores/sessionStore.ts, apps/web/src/domains/chat/transcript-items.ts, apps/web/src/domains/chat/useChatTranscript.ts]
---

# 会话重放总架构

> 一句话：「此刻的事实」由三份来源拼出来 —— 磁盘事件日志 / 进程内环 / 实时流，消息另有一份 `SessionState.messages`。今天实际拼的是「磁盘消息 + 环的连续后缀」，**磁盘事件日志里「环已淘汰」的那一段没有接线**（§3 的 `D \ R`）。这是「刷新后这次 run 只剩几条」的结构性缺口，不是窗口偏小。

## 1. 三条事实源

| 源 | 写什么 | 保留多久 | 什么时候会缺 | 依据 |
|---|---|---|---|---|
| 磁盘 · 会话事件日志 | `sessions/<id>/events.ndjson`，一事件一行；`seq` 按**会话**自增、逐条 `sync` | append-only，只随 `deleteSession` 删除，无 TTL | 写盘失败时事件**仍然广播**（「磁盘缺、环有」，只上报一次 `session.log.failed`） | `session-event-log.ts:451-470`、`:625`、`:957`；`run-journal.ts:283-288`、`:304-330` |
| 磁盘 · `SessionState.messages` | `sessions.get` 读的那一份（尾部窗口 100 / 上限 500） | 随会话 | run 进行中本轮正文与工具卡整段不在（只在收尾 / checkpoint 落盘） | `sessions.ts:1096-1106`、`:330-332`、`:1128-1130`；`chunk-loss-measurement.md:170-172` |
| 进程内环 | 已广播事件的 `{seq, event}`，**全局一份**（每 tenant hub），FIFO 5 万条 | 进程内存；重启归零、seq 从 1 重编 | 淘汰（别的会话也在挤同一个 FIFO）、重启、并发会话摊薄 | `event-buffer.ts:37-44`、`:47-63`；`tenant-event-hub.ts:123` |
| 实时流 | 环的同一个 item 出站（会话归属补在出站副本上），单帧 8 MiB 硬断 | 不保留 | 背压丢帧转 `gap`、断线期间 | `gateway.ts:1426-1432`、`:1193`、`:475`、`:1236-1243` |

不落盘的份量必须先说清：`llm.stream.chunk` / `context.changed` / `run.checkpoint` / `session.*` / `plugin.*` **不落盘**（`run-journal.ts:56-66`），流式段落只落骨架 `llm.stream.summary`（`event-log-policy.md:31-45`）⇒ **在飞请求的正文与全部 reasoning 只存在于环里**，磁盘永远没有（`chunk-loss-measurement.md:209-218`）。

## 2. 刷新 / 切换时的重放序列

1. 刷新 = 客户端事件状态清零：`eventStore.clear()` + 首次连接固定 `since: 0`（`connection-handlers.ts:95`、`:265`）。**事件游标不持久化**，每次刷新都从环的起点重新拉。
2. 连接级 epoch：服务端 `replayTo` → `planReplay` → `hello(from_seq, latest_seq)` → `gap` → 回放帧（`gateway.ts:1407-1412`、`:1393-1404`；帧形状 `gateway/frames.ts:88-99`）。
3. 过滤在前、预算在后：`hub.since(0)` → 会话/类型过滤 → `tailReplayWindow` 取**有界连续后缀**（`gateway.ts:1286-1331`）；预算 = 「最新锚点（`run.started`，退 `user.message`）起的地板 × 1.5」，clamp 到 1–8 MiB / 2k–50k 条（`replay-budget.ts:365-392`，常量 `:127`、`:139`、`:148`、`:159`）。
4. `gap` 把两种缺口压成一个区间：环已淘汰的前缀 ∪ 预算跳过的中间段 —— 协议上不可区分（`gateway.ts:1394-1399`）。
5. 订阅级 hello：`truncateAfter(from_seq-1)`；若 `from_seq > since+1` 且本会话最新 run 的起点不在缓冲里 → `startBackfill`（`connection-handlers.ts:204`、`subscription.ts:247-266`）。
6. 回填**只问环**：带 `until_seq` 重订阅 `events.subscribe`，最多 6 页；页空 / `hasNewestRunStart` / 页数到顶即停（`subscription.ts:40`、`:286-309`）。
7. 暂存与并入：`beginBackfill` 退游标 + 冻结物化面（`event-store.ts:456-462`），收尾按 **hub seq 升序**一次性 `push`；去重判据是 `seq <= lastSeq` 直接丢弃（`:472-482`、`:265`）。
8. 并行消息侧：`sessions.get`（`gateway/node/sessions.ts:146` → `sessions.ts:1096-1174`）返回尾窗 → `mergeTailPage` 按**绝对下标窗口**拼前缀（`sessionStore.ts:195-215`）→ `transcriptMessages`（`useChatTranscript.ts:423`）。
9. 合成单一 item 流：`buildTranscriptItems` 把消息 item 与 live item 按 **item.key 字面量**合并（`TranscriptWindow.tsx:303`、`transcript-items.ts:2003`、`:1937-1990`）。
10. 水印：**今天唯一在用的是 hub seq**（`event-store.ts:222-224`、`subscription.ts:325`）。`sessions.get` 已经回了磁盘水位 `event_cursor.last_seq`（`sessions.ts:1142`、`:1159`），但 `apps/web` 全仓对 `event_cursor` / `sessions.events` **零引用** ⇒ 两个水位之间不存在任何比较。

## 3. 不遗漏判据（可验证形式）

记 `D(s,w)` = 磁盘 `events.ndjson` 中 `seq ≤ w` 的全部记录；`R(s,t)` = 环内该会话的保留事件；`U(s,t)` = **已发生、尚未被磁盘确认（un-acked）**的事件。

> **判据**（外部补强后的可验证形态，水印 `w` 为全局单调 seq）：
> ① `UI.count(s,t) == count(D(s,w)) + count(U(s,t))`；
> ② `seqSet(UI) == seqSet(D) ⊎ seqSet(U)` —— 无重复、无洞、无越界；
> ③ `w == max{seq | seq ∈ D}`（磁盘最大已落盘 seq）。
> 弱形式（今天只能验这一条）：`fold(D \ R)` 中每条会产生 item 的记录，UI 上必须有对应 item；可执行化见 `refresh-gap-design.md:256-261` 的 H-3。
> **边界（0.53 回填的适用面）**：本机制只保证「**已落盘**事件可补回」，**不保证「未持久化事件不丢」** —— `llm.stream.chunk` 不在任何磁盘上，重启即永久丢弃；判据右半边（未落盘的 `U`）目前不可枚举。

三个边界今天**一个都不成立**，这才是判据不能当验收用的根因：

| 边界 | 要求 | 今天 | 依据 |
|---|---|---|---|
| `U` 可枚举 | 未 ack 队列：事件入环**前**入队，磁盘 ack 后才出队 | **缺失**。近似物 `pendingEventLogWrites` 只存 Promise：无事件身份与 seq（seq 在 `log.append` 内部才分配）、不跨进程可见、且**不含非落盘类型**（chunk 走同步早退分支直接 `publishRaw`，从不入队） | `run-journal.ts:109`、`:118-127`、`:281-290`；`session-event-log.ts:451-452` |
| 水印是全局单调 seq | 跨类型、跨子 agent 统一分配、可持久 | 唯一跨类型的全局计数器是 hub seq，**易失、重启归零**；磁盘 seq 是**每会话**自增，跨会话不可比。`ts` / 分类编号 / 内容 hash 都不能当水位（毫秒并列会重、hash 无序） | `event-buffer.ts:49`、`:57`；`session-event-log.ts:451-452` |
| 两侧带计数与首尾 seq | 回放帧回报 `{from_seq, to_seq, count}` | **没有条数**。`hello` 有边界 `from_seq` / `latest_seq`，但 `from_seq` 是**窗口首条**、不是「连续区间起点」（预算跳过与环淘汰都会在区间里留洞）；也没有任何 `count` 可与实收条数核对 | `gateway/frames.ts:88-99`；`gateway.ts:1393-1404` |

**为什么 `U` 是不遗漏的前提**：没有 `U` 就只能把它写成「环里那些没落盘的」，而环的淘汰顺序由**别的会话**决定（`event-buffer.ts:37-44`）⇒ 集合本身没有界定，① 右半边悬空、② 无从比对。不可枚举的集合无法断言，也无法在测试里构造反例 —— 这类 bug 就只能靠用户按 F5 去发现。**今天不满足的那一段**：`D \ R`（磁盘有、环已淘汰）**没有任何一条代码路径把它送进 UI** —— 回填只问环（`subscription.ts:286-309`），磁盘读口只到服务端为止（`sessions.ts:1180`），前端零调用。次生：`D` 与 `R` 用两个互不翻译的 seq（§5），缺共同水位，只能退回 `ts` 比较。

## 4. 断线重连的 gap 协议

今天：重连**只传 cursor**（`connection-handlers.ts:260` 拿 `eventStore.currentSeq` 当 `since`），服务端回 `hello(from_seq, latest_seq)` + 有界回放 + `gap`，**不回条数、不保证连续**。

- 服务端会跳段：预算窗口（`gateway.ts:1286-1331`）与环淘汰都能跳过中间区间，两种原因还被压进同一个 `gap`（`:1394-1399`），协议上分不开「可恢复」与「不可恢复」。
- 客户端察觉不到：`push` 只丢 `seq <= lastSeq`（`event-store.ts:265`），洞与重复被静默吸收；`onGap` 注释明确「静默处理，不重连、不提示。**页面感知不到截断**」（`connection-handlers.ts:221-237`），且 `gap.to_seq < currentSeq` 时直接 `return`（`:231`）。
- 回填同样会截断而不告知：页空 / `hasNewestRunStart` / 6 页上限（`subscription.ts:286-309`）。

**应有形态**：重连回放区间 `(cursor, head]`，帧上带 `{from_seq, to_seq, count}`（`count == to_seq - from_seq + 1`）；客户端**先校验连续**（收到的 seq 集合恰好等于该闭区间、无重复），通过才合并，不通过就不合并、显式报出来并按日志回填。**原则**：**环只是日志的滑动缓存，重连必须以日志为准。** 今天职责是颠倒的 —— 环是唯一回放源（`gateway.ts:1407-1412` → `hub.since`），磁盘口 `sessions.events` 无人调用（`sessions.ts:1180`），于是「回放能拿到什么」取决于别的会话挤掉了多少，而不是日志里有什么。

## 5. ID 与去重契约

| 身份 | 磁盘 | 环 / 实时 | 一致 | 今天的合并 / 去重键 |
|---|---|---|---|---|
| 事件 `seq` | 会话内自增（`session-event-log.ts:451-452`） | 进程内全局自增，hub 扇入时分配，重启归零（`event-buffer.ts:49`、`:57`；`tenant-event-hub.ts:123`） | ❌ 两套计数器，无映射 | 环内靠 hub `seq` 单调丢弃（`event-store.ts:265`）；**跨源无任何键** |
| 消息身份 | **无 `message_id`**：`Message` 只有 `run_id` 与 `run_segment`（`run_segment` 只盖 assistant 正文）（`provider.ts:74`、`:85`） | 事件 `user.message.data.message` 是同一个对象 | ✅ 两侧同值（但都不是消息 id） | 历史 `msg:<绝对下标>` vs live `run:<runId>:input`，两个键合不上（`transcript-items.ts:8-19`、`:979-1022`、`:1164-1198`）⇒ 只能靠 `ClaimLedger` 认领（`:1835`） |
| 工具调用 `tool_call_id` | 落盘消息（`provider.ts:44`） | 事件载荷（`event.ts:214`、`:222`） | ✅ 同值 | 共用 item 键 `tool:<callId>`（`transcript-items.ts:13`） |
| `run_id` | 消息与事件都带 | 同 | ✅ | run 分组键（`live-items`） |

一句话：**只有工具调用 id 与 run id 是三源同值的**；事件 seq 有两套，消息 id 根本不存在 ⇒ 跨源去重今天只能靠 key 字面量或启发式认领。

## 6. 已知的五次修补

| # | commit（日期） | 声称修了什么 | 实际盖住 | 没盖住 |
|---|---|---|---|---|
| 1 | `05209aca`（11-10） | hydrate 期间不隐藏 running run；出站补 `session_id` | 隐藏行为与归属（增量能被挂回会话） | 事件本体不在环里时仍无内容可显示；更早区间不补 |
| 2 | `20eba554`（11-11） | 按段回放 `until_seq` + 客户端 6 页回填，「长 run 的开头不再丢」 | 环内可回填到环起点（提交信息自述「已知上限」：环外取不回来） | 环外；且 `MAX_BACKFILL_PAGES = 6`（`subscription.ts:40`）与今天的 5 万条环已不匹配 |
| 3 | `2db7a727`（11-11，WIP） | 不产 item 的流式增量不进客户端缓冲 | 客户端 per-run 额度不再被 `tool_call_delta` 吃满（`event-store.ts:266-280`） | 只动客户端缓冲；serve 环淘汰与磁盘链路未动（提交标题即 WIP，下一步验收未跑完） |
| 4 | `c21d8c89`（11-12） | 回放预算「结构优先 + 动态」（1 MiB 固定 → clamp） | 单帧窗口变大，锚点更可能在窗口内 | 仍是**有界连续后缀**；锚点被淘汰时 `floorIndex = -1` 直接退化为最小预算（`replay-budget.ts:374-392`） |
| 5 | `473bfc4c`（11-14） | 新增 `sessions.events` + `event_cursor`，环 1 万 → 5 万 | 服务端有了读磁盘的口（`sessions.ts:1180`），环更大 | **前端零调用**（`apps/web` 对二者 0 命中）；也没有「刷新后无洞」的门禁 |

旁证（同族但只解决单点）：`e50ee7a7` 让 `system_context` 从磁盘派生（只补一张卡）、`d0511b31` 消息身份 `run_id + run_segment`（只改认领，不加消息 id）、`71b27cf3` 重连不再整表重挂时间线（只改闪烁）。

## 7. 待核实

1. 「这次 run 十几个事件刷新后只剩四个」**具体丢在哪一段**未在真机核对。候选：(a) 环淘汰（§1）、(b) 客户端 item 折叠把多条事件并成一个 item（`transcript-items.ts:2003`）、(c) 渲染窗口夹取（`useChatTranscript.ts:285-290`）。现成探针：`claimStats`（`useChatTranscript.ts:568`）、`eventStore.droppedNoise`（`event-store.ts:232`）、`event_cursor.last_seq` 与实际 `currentSeq` 对照（`sessions.ts:1140`）。
2. hub seq 与磁盘 seq 的**保序性**：落盘成功后才广播（`run-journal.ts:281-289`），而 `llm.stream.chunk` 走同步早退分支立刻广播（`:120-127`）⇒ 同一会话内两者可能不保序；影响面未评估。
3. 会话事件日志除 `deleteSession` 外是否还有数据目录级 GC / 配额 —— 本 worktree 内没找到证据。
4. ~~`subscription.ts:34-39` 的「6 页足够」是按环 10000 条推的~~ **已复算并写进注释**：保守上界 25 页（50000 / 2000），6 页只覆盖 12000 条（环的 24%）；上调属行为变更，待立项（`subscription.ts:35-55`）。
5. **子 agent 的事件是否在同一会话日志内编号** —— 决定「全局单调 seq」要不要跨子 agent 分配（§3 表格第二行）；本 worktree 内未逐条核对 subagent 的事件归属。

## 8. 0.54 结案：`unacked` 是空集，不需要队列

§3 的 `U(s,t)`（已发布、未落盘）在 0.54 **恒为空集**：发布唯一出口在 WAL fsync 之后（ADR-105 §3 I2），等式退化为
`UI == timeline(seq ≤ timeline_head) ∪ WAL(timeline_head < seq ≤ wal_head)`，右半边两段都在磁盘上 —— **WAL 本身就是那个队列**。
两指针的语义与不变式、I2 的三条落点、0.53 四问的答案、chunk 的 150 ms 内存窗口边界、A5 断言探针与「契约 ≠ 现状」：
[unacked-queue-closure.md](unacked-queue-closure.md)。

## 9. 相关文档

- 丢失窗口公式、方案对比与验收口径：[refresh-gap-design.md](../dev/handoff/refresh-gap-design.md)
- 量化实测（环容量 / 丢失比例 / 已落盘副本占比）：[chunk-loss-measurement.md](../dev/handoff/chunk-loss-measurement.md)
- 落盘口径：[event-log-policy.md](event-log-policy.md)；事件命名与可见性：[events.md](events.md)
- 给外部专家的调研简报：[replay-gap-brief.md](../dev/handoff/replay-gap-brief.md)
