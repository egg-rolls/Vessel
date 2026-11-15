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
paths:
  - docs/architecture/session-replay.md
  - docs/dev/handoff/refresh-gap-design.md
  - docs/dev/handoff/chunk-loss-measurement.md
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

即：用户的心智模型是「三条来源按水位合并 = 此刻全部事实」。观察到的形态是**只剩尾部几条**，与实测的「环前缀淘汰 ⇒ 一段连续前缀消失」同形（`chunk-loss-measurement.md:51-53`），但**具体成因未真机核对**（§1.3）。这个差异正是本简报要外部专家回答的核心。

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
| 磁盘 · `SessionState.messages` | `sessions.get` 的返回（`sessions.ts:1096-1106`） | 随会话 | run 进行中本轮正文与工具卡整段不在（只在收尾/checkpoint 落盘，`chunk-loss-measurement.md:170-172`） |
| 进程内环 | 已广播事件的 `{seq,event}`，**全局一份**（`event-buffer.ts:37-44`），容量 5 万（`:44`），seq 扇入时分配（`tenant-event-hub.ts:123`）、重启归零（`event-buffer.ts:49`） | 进程内存 | 淘汰 / 重启 / 并发会话摊薄 |
| 实时流 | 环的同一个 item 出站，会话归属补在**出站副本**（`gateway.ts:1193`），8 MiB 硬断 + 背压丢帧转 gap（`:475`、`:1236-1243`） | 不保留 | 慢客户端、断线期间 |

**关键不对称**：`llm.stream.chunk` / `context.changed` / `run.checkpoint` / `session.*` / `plugin.*` **不落盘**（`run-journal.ts:56-66`），流式段落只落骨架 `llm.stream.summary`（`event-log-policy.md:31-45`）。所以「在飞请求的正文 + 全部 reasoning」**只存在于环里**，磁盘永远没有（`chunk-loss-measurement.md:209-218`）。这也是为什么「放大窗口」永远不是修复 —— 窗口只是把洞推远。

### 2.2 刷新时的重放序列（今天实际发生的事）

1. 刷新 = 客户端事件状态清零：`eventStore.clear()` + 首次连接固定 `since: 0`（`connection-handlers.ts:95`、`:265`）。**游标不持久化**。
2. 服务端 `replayTo` → `planReplay` → `hello(from_seq, latest_seq)` → `gap` → 有界回放帧（`gateway.ts:1407-1412`、`:1393-1404`）。
3. 回放 = `hub.since(0)` → 会话过滤 → `tailReplayWindow` 取**有界连续后缀**；预算 = 最新锚点（`run.started` → `user.message`）起的地板 × 1.5，clamp 1–8 MiB / 2k–50k 条（`gateway.ts:1286-1331`、`replay-budget.ts:365-392`）。
4. **`gap` 把两种缺口压成一个区间**：环已淘汰的前缀 ∪ 预算跳过的中间段，协议上不可区分（`gateway.ts:1394-1399`）。
5. 客户端 6 页环内回填（`subscription.ts:40`、`:286-309`），收尾按 hub seq 升序并入（`event-store.ts:472-482`）。
6. 并行拉 `sessions.get` 拿消息尾窗，按**绝对下标窗口**拼前缀（`sessionStore.ts:195-215`）。
7. 消息 item 与 live item 按 **item.key 字面量**合并（`transcript-items.ts:2003`、`:1937-1990`）。

**水印今天只有一个**：hub seq（`event-store.ts:222-224`）。磁盘水位 `event_cursor.last_seq` 已经在 `sessions.get` 里返回（`sessions.ts:1142`、`:1159`），但 `apps/web` 全仓对它和 `sessions.events` **零引用**。

### 2.3 判据（我们的形式化）与今天不满足的那一段

记 `D` = 磁盘 `events.ndjson` 中 `seq ≤ last_seq` 的全部记录；`R` = 环内该会话保留事件；`P` = 已发布未落盘。

> 判据：对任意时刻 `t`，`UI_items(s,t) == fold(D ∪ R ∪ P)`。弱形式：`fold(D \ R)` 中每条会产生 item 的记录，UI 上必须有对应 item。

**不满足的正是 `D \ R`**：磁盘有、环已淘汰。回填只问环（`subscription.ts:286-309`），磁盘读口只到服务端（`sessions.ts:1180`）为止，前端零调用。
次生问题：`D` 与 `R` 用**两个互不翻译的 seq**（§2.4），即使接线也判不了「补完没有」。

### 2.4 ID 与去重契约（今天）

| 身份 | 磁盘 | 环 / 实时 | 一致？ | 今天的去重键 |
|---|---|---|---|---|
| 事件 `seq` | 会话内自增（`session-event-log.ts:451-452`） | 进程内全局自增、重启归零（`event-buffer.ts:49`、`:57`） | ❌ 无映射 | 环内 `seq <= lastSeq` 丢弃（`event-store.ts:265`）；**跨源无键** |
| 消息身份 | **无 `message_id`**，只有 `run_id` / `run_segment`（后者只盖 assistant）（`provider.ts:74`、`:85`） | 事件里的 `data.message` 是同一对象 | ✅ 同值，但都不是消息 id | `msg:<绝对下标>` vs `run:<runId>:input`（`transcript-items.ts:8-19`）⇒ 靠 `ClaimLedger` 认领（`:1835`） |
| 工具 `tool_call_id` | `provider.ts:44` | `event.ts:214`、`:222` | ✅ | 共用 `tool:<callId>`（`transcript-items.ts:13`） |

**唯一三源同值的是 `tool_call_id` 与 `run_id`**；事件 seq 两套、消息 id 不存在。

## 3. 我们已经试过的 5 次修补，与为什么不够

| # | commit（日期） | 声称修了什么 | 实际盖住 | 没盖住 |
|---|---|---|---|---|
| 1 | `05209aca`（11-10） | hydrate 期间不隐藏 running run；出站补 `session_id` | 隐藏行为；增量能被挂回会话 | 事件本体不在环里时仍无内容；更早区间不补 |
| 2 | `20eba554`（11-11） | 按段回放 `until_seq` + 客户端 6 页回填，「长 run 的开头不再丢」 | 环内可回填到环起点 | 环外（提交信息自述「已知上限」）；`MAX_BACKFILL_PAGES=6` 与今天的 5 万条环已不匹配（`subscription.ts:36-40`） |
| 3 | `2db7a727`（11-11，WIP） | 不产 item 的流式增量不进客户端缓冲 | 客户端 per-run 额度不再被 `tool_call_delta` 吃满（`event-store.ts:266-280`） | 只动客户端缓冲；serve 环与磁盘链路未动 |
| 4 | `c21d8c89`（11-12） | 回放预算「结构优先 + 动态」（1 MiB 固定 → clamp） | 单帧窗口变大，锚点更可能在窗口内 | 仍是**有界连续后缀**；锚点被淘汰时 `floorIndex=-1` 直接退化为最小预算（`replay-budget.ts:374-392`） |
| 5 | `473bfc4c`（11-14） | 新增 `sessions.events` + `event_cursor`，环 1 万 → 5 万 | 服务端有了读磁盘的口（`sessions.ts:1180`） | **前端零调用**；没有「刷新后无洞」的门禁 |

**为什么五次都不够（我们自己下的判断）**：三次在调「窗口多大 / 从哪儿往回调」（#2 #3 #4），一次只改显示与归属（#1），一次在服务端开了一个**没人调用的**磁盘口（#5）。没有一次把「`D` 与 `R` 放到同一个可判定的水位上」。所以每次调参在**短 run** 上都"看起来修好了"（短 run 不溢出环），一遇长 run 或多会话并发就复发。

### 3.1 实测数字（供你判断量级；基线 `235a40f8`，当时环 = 1 万，现在 5 万）

- 环被谁吃掉：正文 `text_delta` 只占 **1.7%** 的槽，reasoning **26.8%**，`tool_call_delta` **69.7%**，结构事件 1.8%（`chunk-loss-measurement.md:73-84`）。
- 1 万条 ≈ 一个 run 最后 **约 200 秒**（长 run 46–52 槽/秒，`chunk-loss-measurement.md:86-97`）。
- 5–10 分钟 run：**82%** 刷新丢正文，丢者中位 **9.8%**、最坏 100%；>10 分钟：**94%** 丢、中位 **21.6%**；653 个 run 末尾刷新一次合计丢 **81.7 KB**（`chunk-loss-measurement.md:31-43`）。
- 9 个真·运行中样本（不是构造）：**7/9 丢 60.5%–100%**（`chunk-loss-measurement.md:135-155`）。
- **丢掉的正文 100% 已在磁盘 `llm.response`**（653 run：1.45 MB = 流式正文的 100.0%），屏幕丢 ≠ 数据丢（`chunk-loss-measurement.md:157-172`）。
- 单请求 chunk 峰值：中位 903 / p90 3165 / 最大 11154 条 —— **现役 1 万条已经装不下最长的单个请求**（`chunk-loss-measurement.md:174-182`）。

## 4. 请你回答的问题（13 条，越具体越好）

**边界与真相源**

1. 流式增量（live）与会话历史（history）的**边界**应该以什么作为单一真相？是「持久事件 id」、「消息 id」、还是「快照 + 序号」？给出你认为唯一不歧义的定义。
2. 一台 gateway 同时服务多会话，全局一个 FIFO 是否从根本上就错？按会话分片 + 全局序（每会话一个持久游标、全局一个单调计数器）的取舍是什么？
3. 未落盘的流式 chunk 是否本身就不该算「事实」？如果 UI 在运行中必须自足，**最小持久化单位**是什么（段级骨架 / 256 B 聚合 / WAL）？代价如何量化？

**游标与「无洞」的证明**

4. 增量拉取应该用 `seq`、`timestamp`，还是单调游标（Lamport / hybrid logical clock）？跨进程重启后，游标凭什么继续有效？
5. 断线重连如何**证明**「无洞」？请给出协议层面可验证的性质（而不是「看起来连上了」）。你见过哪些实现把这条做成机器可检查的？
6. 环与磁盘双写是否需要 `(source, seq)` 的全局序？还是应该让**落盘先取号、广播用同一个号**（我们现在的顺序是「先落盘后广播」，`run-journal.ts:281-289`，但 chunk 同步广播，两者不保序）——这条你会怎么设计？
7. `gap` 是否应该区分「已淘汰（不可恢复）」与「预算跳过（可恢复）」两种原因？今天它们被压成一个区间（`gateway.ts:1394-1399`），你认为这个协议设计有什么长期后果？

**前端合并策略**

8. 前端合并是否应该**禁止部分更新**、改为「重建快照」？如果重建，如何避免整页闪烁与滚动位置丢失（我们为此专门做过一次修补，`71b27cf3`）？
9. 服务端是否应该提供「快照（含水位）+ 增量」两段式（snapshot-then-delta）？快照的水位语义你会怎么定义（`last_seq` / `derived_upto_seq` / 双水位）？
10. 我们的消息侧没有 `message_id`（只有 `run_id` + `run_segment`，`provider.ts:74`、`:85`），跨源去重只能靠「position key + 启发式认领」。你会怎么补：ULID？`(run_id, segment)`？还是别的东西能在 Output guardrail 改写正文后仍然稳定？

**测试与形式化**

11. 这类 bug 的**可执行断言**你会怎么写？请给一条你认为最强的属性测试（例如：任意前缀截断 + 任意重连序列 ⇒ UI 集合等于未中断参照集合）。
12. 「不遗漏」你会用什么不变量表述成**机器可检查**形式？我们现在的判据是 `UI_items(t) == fold(D ∪ R ∪ P)`（§2.3），你觉得它缺了哪一项。
13. **竞品机制**：请联网查证并对比（OpenAI ChatGPT 的流式恢复、Claude Code / Codex CLI 的 session resume、Cursor 的 agent transcript、以及任何公开做过 "resumable event stream" 的产品）。我们要的是**具体机制**：它们的游标是什么、快照和增量怎么拼、重连怎么证明无洞。不要泛泛说「用 WebSocket + 重试」。

## 5. 约束（请在这些约束内给方案）

- **不要建议「再加一层缓存」。** 缓存不产生新的真相，只会多一份会过期的副本 —— 我们已走过的路就是两次调大窗口（回放预算 `c21d8c89`、环 1 万 → 5 万 `473bfc4c`），洞每次都只是被推远。
- 我们要的是**可证明不漏**的数据模型：给出不变量、给出判据、给出反例构造法。
- 允许改协议（additive 优先）、允许改落盘 schema、允许改前端合并策略；**不允许**用「调大阈值 / 放宽计数 / 换比较口径」让指标变绿 —— 验收必须在「环压到 200 条」与「重建 hub（seq 归零）」两种环境下都通过（`refresh-gap-design.md:263`、`:244-274`）。

## 6. 我们的待核实清单（这些我们没敢当结论）

1. 「十几个事件只剩四个」的具体成因段（环淘汰 / item 折叠 / 渲染窗口）—— 未真机核对，§1.3 给了 1 分钟探针。
2. hub seq 与磁盘 seq 是否严格保序 —— 机制上可达不保序（chunk 同步广播 vs 落盘异步广播），影响面未评估。
3. 会话事件日志除 `deleteSession` 外是否还有目录级 GC / 配额 —— 本 worktree 内无证据。
4. `subscription.ts:36-40` 的注释仍按「环最多 10000 条」推导「6 页足够」；环已是 50000，未复算。
5. §3.1 的所有数字是**环 = 1 万**时测的；抬到 5 万后未重新实测（预期「≤10 分钟不丢」，但「长 run + 并发」两档必然复发）。

## 7. 附录：证据索引

| 结论 | 出处 |
|---|---|
| 丢失窗口公式 `lost = [1, ring.oldestSeq-1] ∩ {尚未变成 messages 的事件}` | `refresh-gap-design.md:96-100` |
| 确定性复算（12200 条事件 ⇒ 2200 条永久不送达） | `refresh-gap-design.md:102-124` |
| 方案 A/B/C 对比与推荐顺序 | `refresh-gap-design.md:186-237` |
| 硬验收 H-1/H-2/H-3 | `refresh-gap-design.md:244-274` |
| 环槽构成 / 丢失分布 / 已落盘副本占比 | `chunk-loss-measurement.md:71-182` |
| 会话日志落盘口径（哪些不落、骨架对账式） | `event-log-policy.md:13-45` |
| 三条事实源与重放序列（本仓口径） | [session-replay.md](../../architecture/session-replay.md) |
