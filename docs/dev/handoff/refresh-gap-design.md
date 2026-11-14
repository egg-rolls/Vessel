---
title: 刷新/重连后前端丢失事件——丢失窗口界定与回填方案
kind: design
status: 待拍板
triggers:
  - 刷新丢事件
  - 刷新后少了一段
  - 刷新丢失流式内容
  - 刷新后运行状态没了
  - 重连回放缺口
  - gap 回填补不到
  - 环形缓冲淘汰
  - 事件序列游标
  - 会话事件日志回填
  - 已发出的消息显示两遍
  - 回来消息重复
  - 重连后消息重复
  - 消息身份 id
  - run_segment
  - 认领 miss
  - 重放整段历史不许多出第二条
  - 去重键必须是服务端稳定 id
  - 消息身份验收口径
paths:
  - packages/serve/src/event-buffer.ts
  - packages/serve/src/tenant-event-hub.ts
  - packages/serve/src/replay-budget.ts
  - packages/serve/src/gateway.ts
  - packages/serve/src/gateway/methods/sessions.ts
  - packages/serve/src/gateway/methods/observability.ts
  - packages/serve/src/gateway/methods/runs.ts
  - packages/serve/src/gateway/methods/schemas.ts
  - packages/serve/src/team-control.ts
  - packages/serve/src/agent-control.ts
  - packages/core/src/session/session-event-log.ts
  - packages/core/src/session/message-identity.ts
  - packages/core/src/session/project-messages.ts
  - packages/core/src/runtime/execution-unit.ts
  - packages/core/src/types/provider.ts
  - apps/web/src/gateway/connection-handlers.ts
  - apps/web/src/gateway/subscription.ts
  - apps/web/src/gateway/ConnectionProvider.tsx
  - apps/web/src/gateway/use-connection-controls.ts
  - apps/web/src/state/event-store.ts
  - apps/web/src/state/live-items.ts
  - apps/web/src/state/teams.ts
  - apps/web/src/stores/sessionStore.ts
  - apps/web/src/domains/chat/useChatTranscript.ts
  - apps/web/src/domains/chat/transcript-items.ts
  - apps/web/src/domains/chat/useChatSubmit.ts
  - apps/web/src/domains/chat/pending-strip.ts
  - apps/web/src/state/useResource.ts
---

# 0. 结论先行

1. **丢失窗口是「一段连续前缀」**：会话事件日志里 `seq ∈ [1, 环形缓冲最旧 seq − 1]`、且还没有变成消息的那一段。它可精确命名，而且**磁盘上一条不少**（`sessions/<session_id>/events.ndjson`）。
2. **真正原因是缺回填链路**：前端要历史事件只会向进程内的环形缓冲 `until_seq` 逐页回退，环里没有了就「停手」；从头到尾**没有一条路径去读会话事件日志**。窗口太小只是让这个洞高频出现，不是洞本身。
3. 三个方案里推荐 **B（`sessions.events` 磁盘回填 + `sessions.get` 暴露 `event_cursor`）**；**C（事件持久身份 `session_seq`）** 作为下一版收敛方向；**A（放大窗口）** 只能做缓解，因为它挡不住「进程重启」和「多会话争抢同一个全局环」。
4. 「已发出的用户消息渲染两遍」与刷新丢事件**是同一根因的两面**（§6）：同一条消息在事件侧和消息侧没有共同身份（chat **没有 message id**，只有 `run_id`，`run_segment` 只给 assistant 盖章）。所以事件侧要么缺席（刷新丢），要么多出来（回来两条）。修法也是同一处：**服务端生成 `input_message_id` 四站同值 + 事件流持久游标**，一个改动同时关掉两个症状 ⇒ 需要拍板。
5. **验收口径已由用户拍板（硬性，§4 的 H-1/H-2/H-3）**：「同一进程内即使 SSE 重放整段历史，也不允许多出第二条；**去重键必须是服务端稳定 id**」。据此 §6.2 把六站里**没有服务端稳定 id 的站全部标成阻塞项**（B1–B6），并把「先补齐这些 id」写成推荐方案的 **P0 前置步骤**；实现之前**不允许任何客户端 local id / 内容 hash / 位置下标当去重键**。

本轮结论全部由真实代码路径 + 一次确定性复算得出；**未改动任何产品代码**。

# 1. 丢失窗口到底在哪

## 1.1 刷新（F5）时客户端手里有什么

**消息侧（持久，能恢复）**：`sessions.get`

- `packages/serve/src/gateway/methods/sessions.ts` 的 `toSessionView`：返回 `messages`（尾部窗口，默认 100 / 上限 500）、`messages_total`、`next_before`（翻页游标锚定「未裁剪窗口的 timestamp/length/role」）、`context_usage`、`system_context`；消息身份 `run_id` / `run_segment` 原样透出。
- 工具内容统一按 8 KiB 口径裁（`capToolMessages`）：**刷新后工具输出本来就会被截短**（这是既有取舍，不是本 bug，但会让「刷新后内容变少」的观感更重）。
- **它不返回任何事件游标**：没有 `derived_upto_seq`、没有 `event_count`、没有「会话日志最新 seq」。会话索引里其实有这个字段（`packages/core/src/session/session-event-log.ts` 的 index：`event_count` / `derived_upto_seq`，`lastSeq()` 还能从文件尾定边界），只是没有对客户端开口。

**事件侧（易失，只能靠回放）**：`events.subscribe` over WS

- 刷新后是**首次连接**：`apps/web/src/gateway/connection-handlers.ts` 一律 `since: 0`（事件游标不落 `localStorage`/`sessionStorage`，刷新即归零）。重连才用本地最新 seq（≈`:264`）。
- 服务端 `packages/serve/src/gateway.ts` 的回放：`hub.since(since)` → 会话过滤（`eventSessionId` 先看 `event.data.session_id`）→ `tailReplayWindow`（`packages/serve/src/replay-budget.ts`）→ 先发 `gap` 帧、再发窗口帧。
- `gap` 帧**把两种缺口合并成一个区间**：`from_seq = ringGap?.from_seq ?? since + 1`，`to_seq = max(ringGap.to, skippedTo)`。也就是说「环已淘汰的前缀」与「预算丢掉的中间段」在协议上不可区分。
- 客户端 `apps/web/src/gateway/subscription.ts` 收到 gap 后 `startBackfill`：`upper = from_seq - 1`，用 `until_seq` 逐页回退，`MAX_BACKFILL_PAGES = 6`；先判 `hasNewestRunStart(sessionId)` 就直接不补；页空了或 `fromSeq > next` 就「更早的已被淘汰，停手」。

## 1.2 窗口的精确边界

三层窗口，逐一给数（`packages/serve/src/replay-budget.ts`）：

| 层 | 默认值 | 作用 |
| --- | --- | --- |
| 进程内环形缓冲 | **10 000 条**（`event-buffer.ts` 默认；`tenant-event-hub.ts` 的 `maxHistory`），**全局共享、不按会话** | 决定了「SSE 能回放多久的历史」 |
| 单帧回放预算 | `MIN_EVENTS 2000` / `MAX_EVENTS 10000`、`MIN_BUDGET_BYTES 1 MiB` / `MAX_BUDGET_BYTES 4 MiB`、安全系数 1.5 | 决定一次回放发多少 |
| 客户端 | `MAX_EVENTS_PER_RUN 5000` / `MAX_EVENTS_TOTAL 20000`（`state/event-store.ts`）、`MAX_LIVE_GROUPS 200`（`useChatTranscript.ts`） | 只截原始事件，item 已物化 ⇒ 不直接丢内容，但限制「服务端窗口再大也用得上多少」 |

锚点规则是关键：`floor = 最新一个 run.started`（没有就退到最新 `user.message`）；**环里找不到锚点 ⇒ 退回固定预算（2000 条 / 1 MiB）**。所以「锚点被淘汰」比「窗口小」更致命：一旦 `run.started` 出了环，服务端连「这个 run 从哪开始」都不知道，直接退化成尾部一小撮。

**丢失区间公式**（可核对）：

```
lost = [1, ring.oldestSeq - 1]  ∩  { 尚未变成 messages 的事件 }
```

`ring.oldestSeq` 是**全局**的：别的会话/teams 子 agent 的事件也会把它推高。所以**一个不长的 run 也可能丢头**。

### 确定性复算（用真实模块跑出来的，不是估）

用 `packages/serve/src/event-buffer.ts` 的 `SeqEventBuffer(10000)` + `replay-budget.ts` 的 `selectReplayBudgetWindow` 复算一条 12 200 条事件的会话（run A 尾部 200 条已结束，run B 正在跑：`user.message`@201、`run.started`@202、6 对 `tool.call.*`、其余全是 `llm.stream.chunk`）：

```
timeline events = 12200 | ring oldest = 2201 | ring latest = 12200
floorIndex = -1 | keptEvents = 2000 | keptBytes = 1.0MiB
              droppedEvents = 8000 | droppedStructureEvents = 0
replay window starts at seq = 10201
page 1: until_seq=10200 -> 2000 events, next upper=8200
page 2: until_seq=8200  -> 2000 events, next upper=6200
page 3: until_seq=6200  -> 2000 events, next upper=4200
page 4: until_seq=4200  -> 2000 events, next upper=0
--- verdict ---
never delivered after refresh: seq 1..2200 = 2200 events,
   incl run.started@202 / user.message@201 / tool.*
```

三条硬结论：

- 只需要 **12 200 条事件**（≈ 1.2 倍环容量）就能踩到：`run.started` 被淘汰 ⇒ `floorIndex = -1` ⇒ 回放退化成 2000 条尾巴。
- 客户端 4 页回填**确实补到了环的起点（2201）**，然后停手。也就是说：**环里还剩的那段，回填链路是好的；丢的恰好是「环已淘汰、磁盘还在」的连续前缀**。
- 复算里 `droppedStructureEvents = 0`：预算自检看不见「已经被淘汰掉的结构事件」。**诊断面本身对环淘汰是瞎的**，这解释了为什么这个问题长期被当成「窗口偏小」而不是「少一条链路」。

## 1.3 只存在于事件里、消息里没有的东西

`buildLiveItems`（`state/events.ts` / `state/live-items.ts` 一侧）产出的 item kind 只有这些：`run-input` / `run-text` / `run-reasoning` / `run-failure` / `runtime-notice` / `prompt-context` / `ask-answer` / `tool`（以及消息侧独立的 `message`）。对照消息侧能不能复现：

| UI item | 事件来源 | 刷新后靠 messages 能复现吗 |
| --- | --- | --- |
| `message` | `llm.response` / 落盘消息 | ✅ 能（`sessions.get` 分页） |
| `run-text`（流式正文） | `llm.stream.chunk`（**不落盘**） | ⚠️ 运行中不能 ⇒ **运行中刷新，正文消失到 run 结束** |
| `run-reasoning` | chunk 里的 reasoning | ⚠️ 同上；run 结束后由消息自带 `reasoning_content` 补回 |
| `tool` | `tool.call.*` | ✅ 能（但输出按 8 KiB 截断） |
| `run-input`（用户气泡） | `run.started.input` / `user.message` | ✅ 由消息侧兜底 —— **也正是 §6 重复渲染的来源** |
| `run-failure` | `run.failed` / `run.cancelled` / `limit.blocked` / `guardrail.blocked` | ❌ **永久丢**（失败/中止的 run 没有消息） |
| `runtime-notice` | 两种来源：① 消息型 `vessel:notice`（0.52 环境信息卡，**落盘**）② `hook.started/completed` 等运行过程行（键 `notice:<key>` / `ev-<seq>`） | ① ✅ 能 ② ❌ **永久丢** —— `state/live-items.ts` 的注释自己写着「`notice` / `ev-` 没有历史替身」 |
| `prompt-context` | `context.pressure` / `context.compacted`（**落盘**，但永远不会变成消息） | ❌ 丢（直到下一条同类事件） |
| `ask-answer` | `ask.user.answered` / `tool.permission.*` | ❌ 丢 |

所以：

- **不变量①（可见性对等）在「消息」维度仍成立**：UI 的消息来自落盘的 `sessions.get`，不依赖事件回放。
- 违反发生在**运行中**：assistant 正文/思考只存在 chunk 事件里，落盘发生在 run 收尾；这段时间刷新 = UI 比 agent 少一截（方向是「用户看得更少」，不是隐藏）。
- 而「永久丢」的四类（失败/提示/上下文压力/ask）对**长会话复盘**影响最大：它们永远不会变成消息，也就永远不会回来。

**磁盘侧其实已经为这件事准备好了**：`docs/architecture/event-log-policy.md` 规定 chunk 不落盘、但每个 text/reasoning 段落结束时落 `llm.stream.summary`（`segment_index` / `kind` / `chunk_count` / `bytes` / `first_seq` / `last_seq`）。也就是说「哪一段存在、有多长、对应 run 内哪些发布序号」在磁盘上可对账，**正文由消息补**。这条设计的存在本身就说明：事件与消息是两份互补真相，磁盘是唯一能同时喂饱两边的来源。

## 1.4 重连 vs 刷新 vs 进程重启

- **重连**（`reconnect.ts` / link-status）：`since = 事件存储里的最新 seq`，只丢 `[本地最新+1, ring.oldestSeq-1]`，通常为空或很短。
- **刷新**：`since = 0` ⇒ 每次都从环的起点开始，丢 §1.2 的整段。
- **进程重启 / `gateway.reload`**：`hub` 的 seq 是进程内自增（`event-buffer.ts` 的 `nextSeq`），环是进程内存 ⇒ 重启后 seq 归零、环清空；`hello.incarnation` 变化会让客户端重置游标。**任何窗口大小都救不了这个场景，只有磁盘能。**

# 2. 真正原因：窗口太小，还是缺链路

## 2.1 「窗口太小」的量级与代价（能算清）

一条长跑会产生多少发布事件？`docs/architecture/event-log-policy.md` 记着实测 177 轮 LLM 请求；chunk 按「一 delta 一条」发布（该文档同处：`run.checkpoint.event_cursor`、`llm.stream.summary` 用 `first_seq/last_seq` 标记 run 内 chunk 发布序号来对账）。按每轮 1000–2000 条 chunk 估：

```
177 × 1000 ~ 2000 ≈ 1.8×10^5 ~ 3.5×10^5 条/长跑
```

对照现状：环 10 000 条 ⇒ 覆盖率 **约 3%**。要让「当前 run 一条不丢」，环至少得按「**所有活跃会话自各自 run.started 以来的事件总量**」配：

- 单会话 ≈ 2×10^5–3.5×10^5 条；
- 实测编码后最小 chunk 事件 153 B/条（`JSON.stringify` 长度，堆上按 2–3× 计）⇒ 100k 条约 30–45 MB，3.5×10^5 条约 100–150 MB；再乘并发会话/teams 子 agent；
- 还要同步放宽「单帧 4 MiB 硬断 / 2 MiB 背压」（`gateway.ts`）与 `MAX_BACKFILL_PAGES`，否则收不进去；
- 客户端 `MAX_EVENTS_TOTAL = 20000` 也要同比抬高（raw 事件虽只是对账用，但内存同样线性涨）。

⇒ **放大窗口是个「上不封顶 + 重启归零」的缓解**，不是修复。它能把短跑（< 1 万条）从丢线里捞回来，这正是它「看起来有效」的原因。

## 2.2 「缺链路」的证据（决定性）

1. **前端从不读磁盘**：`apps/web/src/gateway/subscription.ts` 的整条回填链路只有 `until_seq`（问环），没有任何 `sessions.*` / `events.*` 调用；`events.list` 在 `apps/web` 里只被 `gateway/node/runs.ts` 用（run trace 视图），与聊天无关。
2. **回填自己也承认取不到**：`subscription.ts` 的注释就直接写着「走不到就是真的取不到（更早的已被淘汰），停手」，`MAX_BACKFILL_PAGES` 上方那句「单次回放有界」也停留在一个过时口径（写的还是 1 MiB / 2000 条，实际已是 4 MiB / 10 000）。
3. **磁盘里明明有**：`packages/core/src/session/session-event-log.ts` 每条发布事件都落 `sessions/<id>/events.ndjson`（chunk 除外），`seq` 按 session 单调、`read(sinceSeq)` 是排他游标、`lastSeq()` 可从文件尾定边界。`docs/architecture/event-log-policy.md` 明说「会话事件日志是恢复的真相源」。
4. **两套 seq 是横在中间的真障碍**：SSE `seq` 来自进程内 `SeqEventBuffer`（全局自增、重启归零），磁盘 `seq` 按会话单调。**两者没有任何映射**，所以「拿磁盘补 SSE 缺口」不是加个调用就完事，得先决定游标归属（见 §3）。
5. **已有先例可抄**：`sessions.get` 的 `context_usage` / `system_context` 就是**读会话事件日志尾段**算出来的（`sessions.ts` 里 `contextUsageOf` / `systemContextOf`），注释甚至写明了「事件不是 message ⇒ 回放窗口淘汰 / 进程重启后只有重新派生才能把卡找回来」。也就是说「serve 侧读会话日志」这条管道已经通水，缺的是对客户端开口 + 前端用它。
6. **既有磁盘 RPC 不能直接用**：`observability.events.list` 读的是 **run trace**（`packages/core/src/observability/read-trace.ts`，按 `run_id`，seq 是 per-run 的），不是会话事件日志，无法当会话续传游标。

**结论**：主要矛盾 = 缺「会话事件日志 → 前端事件流」这一条链路。窗口太小是**诱因**（让 gap 频繁出现），缺链路是**原因**（gap 一出现就等于永久丢失）。任何只调窗口的方案都会在「重启」和「多会话争抢全局环」两处失效。

# 3. 三个候选方案

## 方案 A：放大窗口（只调参）

- **改动面**：`packages/serve/src/tenant-event-hub.ts`（`maxHistory`）、`replay-budget.ts`（`MAX_EVENTS` / `MAX_BUDGET_BYTES`）、`gateway.ts`（`MAX_BUFFERED_BYTES` 与背压水位）、`apps/web/src/state/event-store.ts`（`MAX_EVENTS_*`）、`subscription.ts`（`MAX_BACKFILL_PAGES`）。**无新 RPC、无协议变化、无 core 改动。**
- **不变量影响**：①②③ 全不动（hub seq 仍单调；消息仍来自磁盘）。
- **代价与风险**：
  - 内存线性且**全局共享**：要覆盖一条长跑 ≈ 3.5×10^5 条 + 并发会话，实测 153 B/条的编码体积 ⇒ 百 MB 级；
  - 重事件（`tool.call.completed` 输出、`llm.request` 摘要）单条可达 KB–MB，长尾不可控；
  - WS 单帧 4 MiB 硬断 / 2 MiB 背压 ⇒ 环再大也得靠 6 页分页，慢客户端更容易被推出 gap；
  - **进程重启 / 多会话争抢无解**；
  - 「`floorIndex = -1` 就退化」这个行为不变，只是更难触发。
- **判词**：只能在短期内把短跑捞回来，**不能作为修复**。

## 方案 B：`sessions.events` 磁盘回填（会话日志作后备回放源）

- **改动面**：
  - serve：新增 `sessions.events`（读会话事件日志：`since_seq` 排他 + `limit ≤ 1000` + 可选 `types` 白名单，返回 `{ events: [{ seq, ts, type, run_id, data }], latest_seq, has_more }`）；`sessions.get` 增加 `event_cursor`（= 会话日志最新 seq / `event_count`）。
  - 建议白名单（只补「会永久丢」的那几类，先把体积压到 KB 级）：`run.*`、`llm.stream.summary`、`tool.call.*`、`guardrail.*`、`limit.blocked`、`context.pressure`、`context.compacted`、`ask.user.*`、`tool.permission.*`，以及 `hook.*`。
  - web：`EventStore` 增加「权威帧」入口 + 回填编排（gap 之后，若本会话事件未覆盖到环起点，就按会话日志回补，直到 `latest_seq`）。
  - core：**不动**。
- **接缝怎么接（关键）**：live 帧不带磁盘 seq，所以跨源去重不能靠 seq。可行做法是**用 gap 已有的边界信息界定范围**：gap 告诉我们「环里没有 seq ≤ X」；客户端只要取「本会话 `ts < 我收到的第一条帧的 ts`」的那一段即可，重复只可能落在同毫秒并列事件上（可再用 `(run_id, type)` 收敛）。磁盘 seq 只用于**回填内部翻页**，保证翻页精确、不重不漏。
- **不变量影响**：①变好（事件派生 UI 也追平磁盘真相源）；②③不动（事件日志本来就 append-only、seq 单调）。
- **代价与风险**：
  - 首次/刷新多一次 RPC + 一次 ndjson 从尾扫描（有 `limit` 与 `types` 白名单，可控）；
  - 去重靠「时间水位」⇒ 时钟回拨/同 ms 并列有残余重复风险，需要 fold 对重复投递幂等（`runtime-notice` 这类是 append 到列表的，重复投递会翻倍 —— 必须一起改成按键幂等）；
  - chunk 不落盘 ⇒ 运行中的流式正文仍要靠环；B 只保证「结构骨架 + 已完成的正文」不丢。这是 B 的**明确边界**，要写进验收。

## 方案 C：统一持久事件身份（`session_seq` 作唯一游标）

- **改动面**：
  - core：发布路径保证「先落盘取号、再广播」（`execution-unit.ts` 里 `persistObservedEvent` 现在是发布订阅者，顺序要翻过来，或者在 `publishEvent` 里同步取号）；
  - serve：live 帧与回放帧都带 `session_seq`；`sessions.events` 用同一个号；
  - web：`EventStore` 维护 `hub seq`（gap 检测）与 `session_seq`（续传/去重）双游标；
  - 协议 + 门禁都要跟着加字段/加用例。
- **不变量影响**：③从「进程内 hub seq 单调」升级为「会话持久 seq 单调」；①②不变；可见性最强（刷新/重连/重启同一套游标）。
- **代价与风险**：
  - 动的是发布热路径（每次事件多一次取号+赋值；fsync/排队语义要重新确认，不能把写盘延迟带进 broadcast）；
  - **chunk 不落盘** ⇒ 仍然只有 hub seq，双号并存必须在前端/协议文档里写死，否则很容易混用；
  - 改动横跨 core/serve/web + 协议，回归面最大，得配新的门禁用例；
  - 属于「改事件语义」⇒ 需要拍板。

# 4. 推荐方案与验收标准

## 推荐：B 先落地，C 作为下一版收敛

理由（按权重）：

1. **只有磁盘能覆盖三种丢失**（环淘汰 / 进程重启 / 长跑），B 是三者里代价最低的一条通路；A 一条都覆盖不了。
2. B **不碰发布热路径、不改 live 帧协议、不动任何不变量判据** —— 风险面可控，且可以先用 `types` 白名单只补「永久丢」的那几类（`run.*` / `hook.*` / `context.pressure` / `ask.*`），把最疼的部分先解决。
3. B 是 C 的**真子集**：将来把 `session_seq` 加到 live 帧上，B 的 RPC 与前端回填骨架原样复用，只是把「ts 水位」换成「seq」。迁移成本是加法，不是重写。
4. A 作为**同批的缓解**：把环从 1 万抬到 5 万（配合 `MAX_BACKFILL_PAGES` 提高）成本低、无协议风险，能显著降低 gap 命中率；但它不进验收标准 —— 验收必须能在「环被压到很小」的条件下通过，否则等于用调参冒充修复。

## 最小可验收标准（怎么证明「刷新不丢」）

> **✅ 用户已拍板的硬性口径（不满足即不通过；不许用调阈值 / 放宽计数 / 换比较口径的方式变绿）**
> 「必须：**同一进程内即使 SSE 重放整段历史，也不允许多出第二条**（**去重键必须是服务端稳定 id**）。」

### H 组：三条硬断言（先于实现细节，缺一不可）

**H-1 整段重放不增条（重放幂等）**
- 场景：列表已稳定（≥2 个 run、含工具结果）；把事件游标重置为 0 后**重放整段历史**（等价于 `since: 0` 的重连/重订）。
- 断言：`items.length` 与 item key 多重集**逐项不变**；任何 `(run_id, kind, key)` 出现次数 ≤ 1。
- 现状对照：§6.1 的 S3（`ClaimLedger` 的 `fresh` 把「事实为空时的空判定」固化）会让用户气泡 +1 ⇒ **现状红**。这条就是用户口径「重放整段历史不许多出第二条」的直接编码。

**H-2 双源同时到达只渲一条（且键是服务端 id）**
- 场景：同一条用户消息同时从「落盘消息」（`sessions.get.messages[]`）与「事件」（`run.started` / `user.message` / 磁盘回填帧）到达；必须覆盖两个变体：(a) 同 run 有多条 user 消息（注入 / inbox 投递 / hook 注入）；(b) guardrail 改写（`run.started.input` ≠ 落盘 content）。
- 断言：该消息渲染条数 === 1，且 `item.key` === `msg:<server_message_id>` —— **显式禁止**用内容 hash、客户端 local id、`absIndex` 位置键当去重键。
- 现状对照：`run:<runId>:input` 与 `msg:<absIndex>` 不同键 + 认领启发式 ⇒ **现状红**（S2：「同一句话两遍」）。

**H-3 刷新前后条数一致（允许流式中变态重建，不许丢消息/工具结果）**
- 场景：跑一个含 ≥1 次工具调用 + ≥1 段长输出的 run；在**流式中途**与 **run 结束后**各刷新一次。
- 断言：
  - **run 结束后刷新**：`items` 与刷新前**逐项相等**（消息、工具调用、工具结果、`run-failure`、`runtime-notice`、`prompt-context` 都在），条数相同；
  - **流式中途刷新**：允许「正在流式的正文 / 思考」重建（内容由落盘消息 + `llm.stream.summary` 对账：`segment_index` / `chunk_count` / `bytes`），但**已落盘消息条数与工具结果条数不得减少**（`messages_total` 与工具卡片计数逐一比对）。
- 现状对照：§1.2 的环淘汰 ⇒ **现状红**。

三条都必须在**两种环境**下各跑一遍：(a) 环被压到 200 条（复用 `replay-budget.ts` 已有的 tuning 注入点）；(b) 重建 hub（`seq` 归零、环清空）后 —— (b) 是「不依赖窗口」的证明。

### 支撑断言（实现细节，用来定位 H 组为什么红）

新增 `scripts/check-refresh-gap.ts`（**新文件，不改既有 `check-*` 的判据与阈值**）：

1. 构造 1 个会话、2 个 run、共 1000 条事件（含 `run.started` / `user.message` / `tool.call.*` / `run.failed` / notice / `context.pressure`）。
2. 断言 **a（完整性）**：模拟「刷新」（`since = 0`）走完回填后，`EventStore`（按会话日志 seq）覆盖 `1..latest_seq`，**无洞**。
3. 断言 **b（等价性 / 不变量①的事件侧扩展）**：`buildTranscriptItems` 的输出与「从未刷新」的参照集合**逐项相等**（含 `run-failure` / `runtime-notice` / `prompt-context`）。
4. 断言 **c（幂等）**：同一批事件重复投递（live 与回填重叠）后，item 集合不变（`(run_id, kind, key)` 唯一）。
5. 断言 **d（重启）**：重建 hub（seq 归零、环清空）后再刷新，a/b/c 仍成立 —— 这一条是「不靠窗口」的证明。
6. 手工验收：长跑中 F5，页面上正在流式的正文、工具卡片、run 状态**仍在**；`gateway.reload` 后再 F5 仍能恢复；Network 里 `until_seq` 不再出现「0 条即停手」。

边界要写进验收：**运行中的 chunk 正文**仍依赖环（chunk 不落盘）。若要求连这段也不丢，只能走 C/A 之一。

**与 §6 是同一份验收**：H-1 / H-2 就是 §6 的「回来两条」（去重键必须服务端 id），H-3 就是 §1 的「丢一段」。所以 §6.5 的 `input_message_id` 必须在这三条里被断言（同一条用户消息在 ②③④⑤ 四站同值、UI 只渲一次、刷新前后条数不变），**一次改动一次验收**，不要拆成两个互不相干的补丁 —— 拆开做很容易出现「重复修好了、丢还在」或反之。

# 5. 最小复现

## 可控复现（不需要长跑，1 分钟）

1. dev 起 gateway；把环压小（`tenant-event-hub.ts` 的 `maxHistory` 临时改 200，或起 3 个并发会话把全局环冲掉）。
2. 在同一个会话里发一条会触发多轮工具调用 + 长输出的消息（例如「把这个大文件读一遍再总结」）。
3. 跑到一半按 **F5**。
4. 观察：
   - WS 收到 `hello`（`from_seq=1`）→ `gap { from_seq: 1, to_seq: N }`；
   - 随后 ≤6 次 `until_seq` 回填**全部返回 0 条**（或只补到环起点就停手）；
   - 页面上：当前 run 的**流式正文、工具卡片、运行状态**消失；`run.started` 缺失 ⇒ 该 run 连状态都没有；页面只剩「已落盘的消息」。
5. 对照磁盘：`<sessions_dir>/<session_id>/events.ndjson` 里 `seq 1..N` 全在（含 `run.started`）。**这一步就是「丢的是内存窗口，不是记录」的直接证据。**

## 我这次跑通/没跑通的

- ✅ 跑通：用真实 `SeqEventBuffer(10000)` + `selectReplayBudgetWindow` 复算了 §1.2 的 12 200 条事件场景（输出见上），确定性证明「`run.started` 一被淘汰 ⇒ 回放退化成 2000 条尾巴 ⇒ 客户端补到环起点就停手」。
- ⛔ 没跑：端到端起 gateway + 真实模型跑长会话（需要 provider 凭据与真实 LLM 调用），本轮按「只出设计、不动产品代码」的边界没有执行。上面第 1–5 步是可执行的手工核对清单。

# 6. 同一根因：事件侧与消息侧没有共同身份（「回来了两条」与「刷新丢一段」）

> **与 §1 的关系**：§1 的丢失窗口和这里的重复渲染是**同一个洞的两面**。同一条用户消息在「事件」和「消息」两份真相里没有共同身份，于是对着同一份真相，事件侧要么**缺席**（刷新丢事件），要么**多出来**（回来看到两条）。所以本节和 §1 共用一套验收（§4 的最小可验收标准），修法也是同一处：**给消息一个显式的、服务端生成的、四站同值的 id，并给事件流一个持久游标**。

## 6.1 两条症状链（都在模块级复现过）

现状是两个来源：

- **消息侧（权威、落盘）**：`apps/web/src/domains/chat/useChatTranscript.ts:423` 的 `transcriptMessages = sessionDetail?.messages` ← `sessions.get`（`packages/serve/src/gateway/methods/sessions.ts` 的 `toSessionView`）。
- **事件侧（易失、派生）**：`LiveItemStore` 物化出的 run 分组；`run-input` 气泡由 `apps/web/src/domains/chat/transcript-items.ts:1152-1185` 一带产出，来源 `run.started.input`，收到 `user.message` 时被覆盖成改写后文本（`apps/web/src/state/events.ts:441-444`）。

两侧 item 的键不同 ⇒ 键合并救不了：

| 侧 | item kind | key |
| --- | --- | --- |
| 事件 | `run-input` | `run:<runId>:input` |
| 消息 | `message` | `msg:<absIndex>` |

`buildTranscriptItems` 只按键合并（`transcript-items.ts` 的 `mergeByKey` / `mergeItem`），所以两边**永远合不上**；去重完全靠 `ClaimLedger` / `computeClaimCore` 的启发式认领，装配面再用 `claimedUserByRun.has(runId)` 决定删不删 `run-input`（`transcript-items.ts:2050-2057`，注释原文：「输入已被历史消息认领：历史那条负责渲染，run 侧那份丢弃（**绝不两个气泡** / 两张卡）…四种输入共用这条规则」）。—— 代码的目标是对的，坏在「认领」这个启发式本身。

于是：

- **「回来」两条**：认领 miss ⇒ 历史 `msg:0` 和 live `run:run_x:input` 同时渲染。
- **「刷新」一条**：不是修好了，是 live 那条**跟着事件一起丢了** —— `run.started` / `user.message` 不在回放窗口里（§1.2），`fact.input` 为空时 `run-input` 根本不产出（`transcript-items.ts:1142` 的注释：「run 的输入：历史里还没落盘时由它显示气泡；被历史消息认领后由 assemble 丢掉」）。**§1 的丢失窗口在这里帮了倒忙**，让人误以为刷新是解药。

模块级复现（真实 `ClaimLedger` + `buildTranscriptItems`，不依赖浏览器；会话 `s`，run `run_01`，历史里 user 文本 `read the file`、assistant 一条；原样贴输出）：

```
S3-1 claimed = ["run_01"] userMisses = 0 decisions = 1
S3-2 claimed = []         userMisses = 0 decisions = 2        ← epoch+1 且事实暂时为空
S3-3 claimed = []         userMisses = 0 decisions = 2        ← 事实回来了，但不再重判
S3-4 assemble | user bubbles = 2 [ "message:msg:0", "run-input:run:run_01:input" ]
```

（`decisions` 从 2 不再增长，说明空判定被固化；装配面于是把同一条话渲了两遍：历史一份 + live 一份。）

反证（同一脚本另一组）：`epoch+1` 但事实齐全时 —— `S4-1 claimed = ["run_01"] -> S4-2 epoch+1 事实齐全 claimed = ["run_01"] decisions = 2`，即**单纯重连不会丢认领**，所以「回来就重复」不成立，重复必须额外满足 6.4 里的条件。

另一组（无 id 的直接后果：同 run 两条 user 消息 + 落盘文本被改写）：

```
S2 同 run 两条 user + 文本不一致 | user bubbles = 3 [ "message:msg:0", "run-input:run:run_01:input", "message:msg:1" ]
```

即：`msg:0`（`read the file [redacted]`）与 `run-input`（`read the file`）**同一句话两遍**，另外注入那条 `msg:1` 独立一条。

## 6.2 ID 契约表（一条用户消息的身份，逐站回答）

结论：**chat 路径根本没有 message id**，六站有四个不同口径，**不一致、也不健壮**。按用户拍板的去重口径（去重键必须是**服务端稳定 id**），凡是没有服务端稳定 id 的站一律标记为 **🛑 阻塞项**，未补齐前不允许进入实现。

| 站 | 谁生成 | 字段 | 是否同一值 | 服务端稳定 id |
| --- | --- | --- | --- | --- |
| ① 前端提交 | 客户端**不生成任何 id**：`useChatSubmit.ts:106-140` 只送 `{agent_id, session_id?, input, refs?}`；`runs.start` 参数表 `runs.ts:203-220`，响应表 `runs.ts:221-232` 只有 `run_id / status / queue_position / agent_id / session_id` | **无** | ❌ 无 id（响应里也不回 id） | 🛑 **阻塞项**：服务端受理时必须生成 id 并经 `runs.start` 响应回传；**客户端不得生成 local id 当去重键** |
| ② `user.message` 事件 | core：`execution-unit.ts:1662-1670` `publishEvent({ type:'user.message', run_id, data:{ run_id, session_id, message: effectiveUser, refs } })` | `data.run_id`、`data.message`（**整个 Message 对象，无 id**）、`data.refs[].path` | ⚠️ 唯一可用身份是 `run_id`，**它不是消息 id** | 🛑 **阻塞项**：事件 `data.message` 必须携带与 ③ 同值的服务端 id（`run_id` 不满足唯一性） |
| ③ 落盘消息 `sessions.get.messages[]` | core：`execution-unit.ts:3352` `addMessage(message, runId)`；`message-identity.ts` 的 `assignMessageIdentities` / `withRunIdentity` | `run_id`（user 也有）、`run_segment`（**只给 assistant**：`occupiesSegment = role==='assistant' && 正文非空`）。`Message` 类型见 `packages/core/src/types/provider.ts:39-75`，**没有 `message_id` 字段** | ⚠️ `run_id` 与 ② 同值；`run_segment` 对 user 恒缺省 | 🛑 **阻塞项（根）**：`Message` 必须新增服务端生成的 `message_id` 并落盘；`run_id + run_segment` 组合对 user 消息不唯一，不能当去重键 |
| ④ `events.list` 返回的磁盘事件 | 无：事件原样进 run trace | 同 ②；trace 另带 per-run `seq`（`packages/core/src/observability/read-trace.ts`） | ⚠️ 同 ②；per-run seq 当不了会话游标 | 🛑 **阻塞项（继承 ②）**：事件体没 id，磁盘回填也就没有 id；② 补齐后自动满足。**per-run seq 不得当去重键**（换 run 就撞号） |
| ⑤ SSE 回放重推 | gateway：`gateway.ts:1164-1170` `outboundEventFrame` = `{ seq, event }`，`event` 是同一个对象（`withSessionAttribution` 只补 session 归属） | hub `seq`（进程内自增、重启归零）+ 事件体原样 | ⚠️ 事件体一致；**游标与磁盘 seq 无关**（§2.2 第 4 点） | 🛑 **阻塞项（继承 ②）**：重推帧不带服务端消息 id ⇒ 「重放整段历史」时 UI 无法按键幂等（H-1 直接红）。**hub seq 不得当去重键**（重启归零、非会话级） |
| ⑥ team / 子 agent | serve：team 消息 `message_id` 由服务端生成（`team-control.ts` 追加消息处）；agent inbox 消息亦有 `message_id`（`agent-control.ts`） | `message_id` | ❌ **传不进 session**：`execution-unit.ts` 全文 `message_id` 零命中，团队消息变成 session 用户消息时只剩 `run_id` ⇒ 身份链在入 session 处断开 | 🛑 **阻塞项**：入 session 时必须携带可追溯的服务端 id（session 内 `Message.message_id` + 指向来源的 `source_message_id`，用于排查「同一条团队消息投给多个 agent」）；**不得把 inbox/team 的 id 当作 session 内去重键的唯一来源**（跨会话会撞） |

一句话：`run_id` 是唯一的桥，但它不是消息身份（一次 run 里可以有多条 user 消息）；而 hub seq / 会话日志 seq / `run_segment` / `message_id` 四套编号互不翻译。

**阻塞项清单（按依赖排序，未全部清掉不许进实现）**

| # | 阻塞项 | 补什么 | 哪一侧 | 是否改协议 |
| --- | --- | --- | --- | --- |
| B1 | ③ 落盘消息无 id（根） | `Message.message_id`：服务端生成的稳定 id（ULID），随消息一起落盘 | `packages/core`（类型 + 生成 + 落盘读写） | **改落盘 schema**（会话状态文件 + 投影） |
| B2 | ② 事件无 id | `user.message` / `run.started` 的 `data.message.message_id` 与 B1 同值 | `packages/core`（发布载荷） | **改事件 schema** |
| B3 | ① 提交侧拿不到 id | `runs.start` 响应新增 `input_message_id`（客户端只读服务端给的，**不生成 local id**） | `packages/serve`（`runs.start` result） | **改 RPC 协议**（加字段，向后兼容） |
| B4 | ⑤ 重放帧无 id / 跨源无键 | 三个来源（live / 回放 / 磁盘回填）都带 B1 的同一个 id | 随 B2 自动满足（同一事件对象）；磁盘回填需 `sessions.events`（§3 方案 B） | 事件协议已由 B2 覆盖；新 RPC 属 §7 第 1 项 |
| B5 | ④ 磁盘事件无 id | 同 B4（事件体自带） | `packages/core`（trace / 会话日志写入） | 随 B2 |
| B6 | ⑥ team / inbox → session 断链 | 入 session 时写入 B1 的 `message_id` + `source_message_id`（来源可追溯） | `packages/serve`（投递路径）+ `packages/core`（消息字段） | 改落盘 schema（同 B1） |

依赖顺序：**B1 → B2/B5 → B4 → B3 → B6**。前端 item 键（`msg:<server_message_id>`）在 B1/B2 落地后才能改，**在此之前不得引入任何「临时 id 当去重键」的过渡实现**（那正是现在这条 bug 的来路）。

## 6.3 去重点清单（所有把多来源并成列表的函数）

| 位置 | 去重键 | 同一消息从两个源到达会不会双显 |
| --- | --- | --- |
| `transcript-items.ts` `mergeByKey` / `mergeItem` | item.key | **会**：`run:<id>:input` vs `msg:<i>` 不同键，合不上 |
| `transcript-items.ts` `computeClaimCore`（`uniqueInputOfRun`） | ① 该 run **唯一**一条 user 消息 ② `trimText(content)` 全等 | **会**：①同 run 只要有多条 user 消息（注入 / inbox 投递 / hook 注入，`execution-unit.ts:3352` 全按当前 run_id 落盘）即失效；②guardrail 改写、refs 包装、空白差异即失效 |
| `transcript-items.ts` `ClaimLedger.decide` | 身份 `(sessionId, epoch, history, windowStart, windowEnd)`；`invalidated ⇒ fresh 替换`，否则只并集不撤销 | **会**：`fresh` 会把「事实没到齐时的空判定」固化成权威判定（6.1 的 S3） |
| `state/live-items.ts` `LiveItemStore`（`mergeGroupScalars:244`、`released` tombstone `:325-350`、`resume`/refold） | `runId` + 段锚点 seq（`release:495-515` 只收 segments） | **不会**（分段/分组幂等）；**但 user 气泡不在 tombstone 覆盖范围**，交棒后重折叠会把它长回来 |
| `state/event-store.ts` `push:256` / `truncateAfter:404` / `beginBackfill:456` | hub `seq` 单调 | **不会**（同源重复被 seq 守卫吃掉）；**跨源没有键** |
| `domains/chat/pending-strip.ts:252` | `entry.message_id`（inbox 待处理） | **不会**（与聊天气泡不同源；inbox 自带 id） |
| `state/teams.ts` `mergeMessages:60` / `mergeEarlierTeamPage:77` | `message_id` | **不会** —— 团队侧早就是按服务端 id 幂等合并，是 chat 的对照物 |
| `stores/sessionStore.ts` `mergeTailPage:195`（`loadDetail` 调用链） | 窗口起点 + `next_before` offset 裁剪 | 不会（前缀按 offset 裁掉重叠再拼尾页） |

## 6.4 「回来」到底改了什么（触发点 + 行号，含被推翻的假设）

「回来」≠「刷新」，有三条独立触发点：

- `gateway/connection-handlers.ts:203-206`：任何非 `page` 的 hello 都先 `eventStore.truncateAfter(max(0, info.from_seq - 1))`；`subscribe` 型 hello（切会话 / 重订）到此 return，**不动 epoch**。
- `gateway/connection-handlers.ts:208-219`：**连接级 hello（自动重连）** → `setEpoch(v => v+1)` ⇒ 认领身份失效 ⇒ 下一次 `decide` 走 `fresh` 替换（`transcript-items.ts` 的 `ClaimLedger.decide`）；随后 `afterConnectionHello` → `recovery.onReconnected` → `ConnectionProvider.tsx:337-345` 强制 `sessionStore.refresh(force)` + `invalidateRouteSnapshot`。
- `state/useResource.ts:175-186`：轮询型资源（`useResource` 默认 `pauseWhenHidden = true`）在 `visibilitychange → visible` 时会立刻 `run()` 一次重新取数 ⇒ 若会话详情走这条路径，`sessions.get` 重取 ⇒ 新 `sessionDetail.messages` ⇒ 新 `historyIndex` ⇒ `claimIdentity.history` 变化 ⇒ 再 `fresh` 重判一次。

**被推翻的假设**：自动重连的 `epoch+1` 本身**不会**丢认领 —— 事实齐全时重判结论相同（6.1 的反证）。所以重复必须额外满足下面之一：

1. 该 run 的认领**本来就 miss**（6.3 第 2 行）：同 run 有多条 user 消息 **且** 文本不一致（guardrail 改写 / refs 包装 / `user.message` 事件没收到）。
2. `fresh` 重判发生在**事实暂时为空**的时刻（truncate 之后、重放之前）：空判定被固化，且 `needsRunRerun` 因为 `seen / fed / settled` 三个「一次性转换」都已发生过而返回 false ⇒ 不再重判（S3 的 `decisions` 停在 2）。

诚实说明：第 2 条的**具体交错**我在代码里没找到「必然发生」的入口 —— `connection-handlers.ts:204` 的 truncate 只在 `from_seq - 1 < currentSeq` 时才真的截断；`subscribe` 型 hello 会截断但**不升 epoch**（`:206` 提前 return）；连接级 hello 升 epoch 时 `from_seq = since + 1`、`since = currentSeq`（`:260`）⇒ 通常不截断。所以第 2 条是「机制可达、现实触发频率未证」，第 1 条才是可以从线上数据直接验证的（`userMisses`）。

现象与条件的对应（写清避免误导）：

- 「发送后立刻就是两条」⇒ 基本是条件 1（身份/内容 miss），「回来」只是你重新看了一眼。
- 「离开期间还正常、回来才两条」⇒ 需要在回来时把已有的认领丢掉（条件 2），或者在回来那次 `fresh` 重判时历史恰好不含该消息（`sessions.get` 时序），随后没有第三次重判把它修回来。
- **我没法凭代码断定用户这次属于哪一支** —— 6.4 末尾的探针（`claimStats`）能把两者区分开，这是下一步唯一需要真机做的事。

**真机复现的阻塞**：两条我都在模块级用真实 `ClaimLedger` / `buildTranscriptItems` 复现了，但**没有真机复现**（需要起 gateway + 真实模型跑一轮会触发 guardrail / 注入的会话）。1 分钟内可判定是哪一条：回来后读 `useChatTranscript.ts:568` 暴露的 `claimStats` ——
- `stats.userMisses > 0` ⇒ 第 1 条（身份路径失效）；
- `stats.decisions` 只涨 1 次而 `claimedUserByRun` 为空 ⇒ 第 2 条（空判定固化）。

## 6.5 修复方向（1 推荐 + 1 备选）

两条都必须同时满足：① 不重复渲染；② 刷新不丢消息（与 §4 的最小可验收标准 同一份验收）；③ **不依赖「客户端临时 id 恰好等于服务端 id」这个隐含假设**，要显式化。

**推荐：服务端稳定 id 贯穿四站，前端按 id 配对（去重键 = 服务端 id，硬约束）**

> 用户口径已经把这条钉死：**去重键必须是服务端稳定 id**。所以本方案的**前置步骤**是先把 §6.2 的阻塞项（B1–B6）补齐；在前置步骤完成之前，**不允许用客户端 local id / 内容 hash / 位置下标当去重键**（连「临时过渡」也不行 —— 现在的这条 bug 正是这么来的）。

**P0 前置步骤（必须先做，逐项对应 §6.2 阻塞项，全部在服务端/core，需拍板）**

1. **B1**：`Message` 新增 `message_id`（服务端生成的 ULID），消息落盘时写入、读盘时原样带回（`packages/core/src/types/provider.ts` + 落盘/投影路径）⇒ ③ 有稳定 id。
2. **B2/B5**：`user.message`（以及能在窗口内单独出现的 `run.started`）的事件载荷带同一个 `message_id` ⇒ ②④⑤ 三站自动同值（同一事件对象进 hub / trace / 会话日志）。
3. **B3**：`runs.start` 响应新增 `input_message_id`（= B1 的 id）⇒ ① 拿到 id；**客户端仍然不生成任何 id**。
4. **B6**：team / inbox 投递进 session 时写 `Message.message_id`（B1）+ `source_message_id`（traceability）⇒ ⑥ 不再断链。
5. **B4**：磁盘回填（`sessions.events`，§3 方案 B）返回同一事件体 ⇒ live / 回放 / 磁盘三源同 id，H-1 才能靠键幂等而非认领。

**P1 前端配对（P0 完成之后）**

- `run-input` 的 key 用 `msg:<server_message_id>`，历史 user item 的 key 也用 `msg:<server_message_id>` ⇒ `mergeByKey` 天然幂等，**不再依赖 `ClaimLedger` 认领**；`ClaimLedger` 降级为「老数据无 id」的兜底，并在 stats 里单独计数（便于观察老数据占比）。
- 键一旦是服务端 id，§6.4 的两条 miss 路径（唯一性失效 / 空判定固化）就都不影响用户气泡的渲染，H-1/H-2 同时成立。
- 收益叠加：`message_id` 同时是「这条消息在事件流里的锚点」，可作为磁盘回填水位（配合 §3 的 `event_cursor`），**一个改动同时关掉 §1 的洞和本节的重复**。

**备选：给 user 消息一个段身份（`run_segment = 0` 或 `input_of_run: true`）**

- 只改 `message-identity.ts` 的盖章规则 + `uniqueInputOfRun` 取「本 run 最小 segment 的 user 消息」。
- **不满足用户拍板口径**：它不是服务端稳定 id，去重仍然是「两侧各自算身份」的启发式；也不满足 ②（没有可用作回填游标的 id）。⇒ 只能作为老数据的兼容补丁，**不能作为达标方案**。

**明确不采纳**：继续加强内容规范化（trim / 去前缀 / 去 refs）。它是启发式，guardrail 改写场景永远补不齐 —— 0.52 给 assistant 加 `run_id` + `run_segment` 就是为了摆脱它（`docs/versions/CURRENT.md` 里记着：本机 652 run 中 7 个命中 Output guardrail 改写，症状正是「结尾正文重复」）。

## 6.6 回归测试建议（本轮不新增断言）

优先复用已有探针，不新建门禁（目的都是把 §4 的 H-1/H-2/H-3 变成可执行断言）：

- `scripts/check-live-items.ts`：G-F「历史先到不重复」、G-F2「认领粘性」、G-C「回放幂等」已有同类用例，加两个场景（用例就是 §6.1 的 S2 / S3，脚本可直接搬进去）：
  - 同 run 两条 user 消息（注入）+ 落盘文本与 `run.started.input` 不一致 ⇒ 断言 user 气泡计数 === 1、`userMisses === 0`、`item.key === msg:<server_message_id>`（现状会红，对应 S2 / **H-2**）；
  - `epoch+1` 且中间一次 `decide` 的事实为空、随后事实补回 ⇒ 断言 `claimedUserByRun` 不被空判定覆盖；再等价于「`since:0` 重放整段历史后 item 条数不变」（对应 S3 / **H-1**）。
- `scripts/check-chat-visibility.ts`（不变量①）：断言「UI 消息集合 ⊇ 存档消息集合」，覆盖「刷新后 live 侧丢失不减少消息」（对应 **H-3**）。
- `scripts/check-refresh-gap.ts`（按 §4 的最小可验收标准新建）：H-1/H-2/H-3 三条 + 一条 id 贯通断言（同一条用户消息在 ②③④⑤ 四站的 `message_id` 相同），并在「环压到 200 条」与「重建 hub」两种环境各跑一遍。
- 现成探针（零代码）：`claimStats`（`useChatTranscript.ts:568`）+ `eventStore.hasNewestRunStart`。

# 7. 需要拍板（拿到批准前不动产品代码）

1. **新增 RPC `sessions.events`**（读会话事件日志，`since_seq` + `limit` + `types`），并给 `sessions.get` 增加 `event_cursor`。→ 属于「新增 RPC」，需批准；批准后还要在 `scripts/check-rpc-methods.ts` 登记（只登记，不改判据）。
2. **方案 A 的调参是否同批做**：环 1 万 → 5 万、`MAX_EVENTS`/`MAX_BUDGET_BYTES`/`MAX_BACKFILL_PAGES` 同步。纯调参但会抬高常驻内存，需要你点头。
3. **是否接受「运行中 chunk 正文仍依赖环」这个边界**：若不可接受，则必须走 C（事件持久身份），那是改事件语义 + 改 core 发布热路径，需单独批准。
4. **消息稳定 id（§6.2 阻塞项 B1–B6，推荐方案的前置步骤）** —— 这是唯一能让用户拍板口径（「去重键必须是服务端稳定 id」）达标的东西，改动面按仓拆开列清楚：

   | 阻塞项 | 仓 / 模块 | 改什么 | 是否改协议 |
   | --- | --- | --- | --- |
   | B1 落盘消息无 id（**根**） | `packages/core`：`types/provider.ts`、`session/file-backend.ts`、`session/project-messages.ts`、`runtime/execution-unit.ts` | `Message` 增 `message_id`（服务端生成 ULID）+ 生成点 + 落盘/读盘/投影带出 | **改落盘 schema**（会话状态文件、投影），非 RPC |
   | B2 事件无 id | `packages/core`：`runtime/execution-unit.ts` 发布载荷 | `user.message` / `run.started` 的 `data.message.message_id` 与 B1 同值 | **改事件 schema** |
   | B5 磁盘事件无 id | `packages/core`：trace / 会话日志写入 | 随 B2 自动满足（同一事件对象） | 随 B2 |
   | B3 提交侧拿不到 id | `packages/serve`：`gateway/methods/runs.ts` + `schemas.ts` | `runs.start` 响应新增 `input_message_id` | **改 RPC 协议**（加字段，向后兼容） |
   | B4 三源无共同键 | `packages/serve`（回放/回填）+ `apps/web`（P1 键） | 磁盘回填走 `sessions.events`（第 1 项）后同一事件体；前端 item 键改 `msg:<server_message_id>` | 事件协议随 B2；新 RPC 见第 1 项；前端属 UI 契约 |
   | B6 team/inbox → session 断链 | `packages/serve`（投递）+ `packages/core` | 入 session 时写 B1 的 `message_id` + `source_message_id` | 改落盘 schema（同 B1） |

   批准边界：**本轮只出设计，不写实现**；批准后按 B1 → B2/B5 → B4 → B3 → B6 → 前端键的顺序落地，且必须在 §4 的 H-1/H-2/H-3 三条硬断言下验收（含「环压到 200 条」与「重建 hub」两种环境）。
5. **新门禁脚本 `scripts/check-refresh-gap.ts`** 是否允许与既有 `check-*` 并列（只新增用例，不改任何既有阈值）。
6. **老数据兼容口径**（需拍板）：B1 之前落盘的消息没有 `message_id`，前端只能退回位置键 + 认领兜底。是否接受「老会话仍可能出现一次重复」这个**过渡期例外**？（若不接受，需要在打开会话时做一次「派生补 id」的迁移，那是另一件改动。）

> 拍板建议：第 1 项（`sessions.events` + `event_cursor`）与第 4 项（B1–B6 消息稳定 id）是同一处改动的两面（消息身份 = 回填游标），建议一次批准、一次验收（§4 的 H-1/H-2/H-3）。第 2 项（放大窗口）即使批准，也不列入验收 —— 验收必须在「环压到 200 条」与「重建 hub」两种环境下过。


# 附：本轮没做的事

- 没有任何产品代码改动（`apps/web/**`、`packages/serve/**`、`packages/core/**` 全未动）。
- 没有改 `scripts/check-*.ts`、没有改 `docs/architecture/message-invariants.md`、没有新增断言。
- 本轮把用户拍板的去重验收口径写成 §4 的 H-1/H-2/H-3（硬），并把 §6.2 的六个站点里**缺服务端稳定 id 的站标成阻塞项 B1–B6**；这些是设计约束，**不是实现**。
- 复算 / 复现用的临时脚本（环淘汰复算、`ClaimLedger` S2/S3/S4 复现）跑完即删，未入库；输出的原始数值已原样贴进 §1.2 与 §6.1。
- **没做**：真机端到端复现（需起 gateway + 真实模型跑长会话 / guardrail 场景），见 §5 与 §6.4 的「阻塞说明」与 1 分钟探针方案。
