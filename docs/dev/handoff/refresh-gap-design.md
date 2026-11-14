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
paths:
  - packages/serve/src/event-buffer.ts
  - packages/serve/src/tenant-event-hub.ts
  - packages/serve/src/replay-budget.ts
  - packages/serve/src/gateway.ts
  - packages/serve/src/gateway/methods/sessions.ts
  - packages/serve/src/gateway/methods/observability.ts
  - packages/core/src/session/session-event-log.ts
  - packages/core/src/runtime/execution-unit.ts
  - apps/web/src/gateway/connection-handlers.ts
  - apps/web/src/gateway/subscription.ts
  - apps/web/src/state/event-store.ts
  - apps/web/src/domains/chat/useChatTranscript.ts
  - apps/web/src/domains/chat/transcript-items.ts
---

# 0. 结论先行

1. **丢失窗口是「一段连续前缀」**：会话事件日志里 `seq ∈ [1, 环形缓冲最旧 seq − 1]`、且还没有变成消息的那一段。它可精确命名，而且**磁盘上一条不少**（`sessions/<session_id>/events.ndjson`）。
2. **真正原因是缺回填链路**：前端要历史事件只会向进程内的环形缓冲 `until_seq` 逐页回退，环里没有了就「停手」；从头到尾**没有一条路径去读会话事件日志**。窗口太小只是让这个洞高频出现，不是洞本身。
3. 三个方案里推荐 **B（`sessions.events` 磁盘回填 + `sessions.get` 暴露 `event_cursor`）**；**C（事件持久身份 `session_seq`）** 作为下一版收敛方向；**A（放大窗口）** 只能做缓解，因为它挡不住「进程重启」和「多会话争抢同一个全局环」。
4. 附带的「已发出的用户消息渲染两遍」与刷新洞**同源**：事件侧与消息侧没有共同身份，配对靠启发式认领（见 §6）。修它要动落盘消息语义 ⇒ 需要拍板。

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

新增 `scripts/check-refresh-gap.ts`（**新文件，不改既有 `check-*` 的判据与阈值**）：

1. 用可注入 tuning 把环压到 200 条（复用 `replay-budget.ts` 已有的 tuning 注入点），构造 1 个会话、2 个 run、共 1000 条事件（含 `run.started` / `user.message` / `tool.call.*` / `run.failed` / notice / `context.pressure`）。
2. 断言 **a（完整性）**：模拟「刷新」（`since = 0`）走完回填后，`EventStore`（按会话日志 seq）覆盖 `1..latest_seq`，**无洞**。
3. 断言 **b（等价性 / 不变量①的事件侧扩展）**：`buildTranscriptItems` 的输出与「从未刷新」的参照集合**逐项相等**（含 `run-failure` / `runtime-notice` / `prompt-context`）。
4. 断言 **c（幂等）**：同一批事件重复投递（live 与回填重叠）后，item 集合不变（`(run_id, kind, key)` 唯一）。
5. 断言 **d（重启）**：重建 hub（seq 归零、环清空）后再刷新，a/b/c 仍成立 —— 这一条是「不靠窗口」的证明。
6. 手工验收：长跑中 F5，页面上正在流式的正文、工具卡片、run 状态**仍在**；`gateway.reload` 后再 F5 仍能恢复；Network 里 `until_seq` 不再出现「0 条即停手」。

边界要写进验收：**运行中的 chunk 正文**仍依赖环（chunk 不落盘）。若要求连这段也不丢，只能走 C/A 之一。

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

# 6. 附带：已发出的用户消息渲染两遍（同一根因）

现象：同一条用户消息在 live 视图里出现两次，**刷新后变成一次**。这说明重复只发生在「事件侧 + 消息侧同时在内存里」的时候。

根因（`apps/web/src/domains/chat/transcript-items.ts`）：两侧的 item 键根本不同

- 事件侧：`run-input`，键 `run:<runId>:input`（`transcript-items.ts` 里 `run:${group.runId}:input`），文本来自 `run.started.input`（**guardrail 改写前**），并在收到 `user.message` 事件时被覆盖成改写后文本（`state/events.ts`）。
- 消息侧：`message`，键 `msg:<absIndex>`。
- 两者靠 `ClaimLedger` / `computeClaimCore` **启发式认领**去重：认领到 user，就 `claimedUserByRun.add(runId)`，装配面据此**删掉 `run-input`**。认领失败 ⇒ 两条都渲染 ⇒ 两遍。

认领的身份路径有个结构性缺口：

- `uniqueInputOfRun(runId)` 要求「该 run 恰好一条 user 消息」；但 `packages/core/src/session/message-identity.ts` 的 `occupiesSegment` **只给 assistant 盖章**（`role === 'assistant' && 正文非空`），user 消息只有 `run_id`、没有段身份。
- 而 `execution-unit.ts` 里每条消息都按「当前 run_id」落盘（`addMessage(message, runId)` / `withRunIdentity`），**注入消息 + 真实输入会共享同一个 `run_id`** ⇒ `inputsByRun.get(runId)` 长度 ≥ 2 ⇒ 身份路径必然失效。
- 于是退回**内容全等**比较（`history.userByContent` + `trimText`）。任何一处不一致就 miss：guardrail 改写（`run.started.input` 是改写前）、附件/前缀包装、空白差异、`user.message` 事件没收到（另一客户端/另一 tab 发起）。
- 老数据（`run_id` / `run_segment` 缺失）也走内容比较 —— `sessions.ts` 里就有这条注释：「缺这两个字段 = 旧数据 / 旧 gateway，客户端退回内容比较」。

刷新为什么「好了」：事件侧随内存消失，只剩消息侧一份。所以这不是「刷新修复了它」，而是**两条渲染路径里死了一条**。

候选修法（都要拍板，见 §7）：

- **修法 1（推荐，最小）**：给用户输入一个结构化身份位——落盘时在「本 run 的第一条 user 消息」上盖 `run_segment = -1`（或 `input_of_run: true`）。`inputsByRun` 直接取这一条，不再要求「唯一」，也不再依赖内容全等。
- **修法 2**：`user.message` 事件携带 `message_id`，live 侧直接用消息身份建键（`msg:` 命名空间），两侧同键即天然幂等。代价：事件要引用一个落盘消息 id（写入顺序耦合）。
- **修法 3（不推荐）**：继续加强内容规范化（去空白/去前缀）—— 仍是启发式，guardrail 改写场景永远补不齐。

诊断探针（复现时先看这个）：`useChatTranscript.ts:568` 已经把 `claimStats` 暴露出来，认领 miss 会累计在 `stats.userMisses`；同时看 `inputsByRun.get(runId).length` 是否 > 1。

# 7. 需要拍板（拿到批准前不动产品代码）

1. **新增 RPC `sessions.events`**（读会话事件日志，`since_seq` + `limit` + `types`），并给 `sessions.get` 增加 `event_cursor`。→ 属于「新增 RPC」，需批准；批准后还要在 `scripts/check-rpc-methods.ts` 登记（只登记，不改判据）。
2. **方案 A 的调参是否同批做**：环 1 万 → 5 万、`MAX_EVENTS`/`MAX_BUDGET_BYTES`/`MAX_BACKFILL_PAGES` 同步。纯调参但会抬高常驻内存，需要你点头。
3. **是否接受「运行中 chunk 正文仍依赖环」这个边界**：若不可接受，则必须走 C（事件持久身份），那是改事件语义 + 改 core 发布热路径，需单独批准。
4. **用户消息重复渲染的修法选型**（§6 的修法 1 / 2）：两者都改落盘消息语义（`run_segment = -1` 或事件带 `message_id`），需批准。
5. **新门禁脚本 `scripts/check-refresh-gap.ts`** 是否允许与既有 `check-*` 并列（只新增用例，不改任何既有阈值）。

# 附：本轮没做的事

- 没有任何产品代码改动（`apps/web/**`、`packages/serve/**`、`packages/core/**` 全未动）。
- 没有改 `scripts/check-*.ts`、没有改 `docs/architecture/message-invariants.md`。
- 复算用的临时脚本已删除，未入库。
