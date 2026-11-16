---
title: 会话事件日志落盘口径
kind: current
triggers: [event log, llm.request, stream summary, persist, resume, projection, ttft, chunk_count, 事件, 事件日志, 事件流, 落盘, 落盘策略, 裁剪, 回放, 体积上界, 投影, timeline, wal, 瞬时 chunk, 冻结, session_frozen_readonly, 旧格式, 迁移, events.ndjson]
paths: [packages/core/src/timeline/writer.ts, packages/core/src/timeline/blocks.ts, packages/core/src/timeline/freeze.ts, packages/core/src/runtime/run-journal.ts, packages/core/src/runtime/execution-unit.ts, apps/web/src/state/events.ts, apps/web/src/state/event-visibility.ts]
---

# 会话事件日志落盘口径

> 分两层看：**哪些事件成为事实**（写进哪份日志）与**每条事件留多少正文**。
> **落盘形态 ≠ 发布形态**：`ExecutionUnit` 发布的事件保持完整（live 订阅 / WS 广播 / trace），
> 写盘那一份由写者决定 —— 新格式是 `packages/core/src/timeline/writer.ts`，旧链路时代是
> `RunJournal` 的 `NON_PERSISTED_EVENT_TYPES` + `persistData` + `stripRequestContent`。

## 1. 会话只有两种格式，旧格式是过渡件

时间序（目标态 = **全库只有一种格式**）：

| 阶段 | 会话 | 事实源 | 怎么读 |
|---|---|---|---|
| 现状 | **新格式**（会话目录有 `timeline.manifest`） | 只有 timeline：`wal.log`（非 chunk 一事件一行）、`wal.blocks/`（chunk 块）、归档段 `timeline.ndjson` | 单游标 + 单区间（[session-replay.md](session-replay.md)） |
| 现状 | **旧格式**（只有 `events.ndjson`、无任何 timeline 标记） | `events.ndjson`（0.54 之前的唯一真相源） | **只读冻结**：写者开档即抛 `session_frozen_readonly` |
| 目标 | 旧格式会话**一次性迁移**成新格式 | 迁移后同上 | 迁移跑完 ⇒ **旧读路径删除，全库只有一种格式** |

旧格式的判据只有一处：`packages/core/src/timeline/freeze.ts#isLegacyFrozenSessionDir`（有 `events.ndjson` 且
`timeline.manifest` / `wal.manifest` / `wal.log` 三者皆无）；写前闸门 `assertTimelineWritable`（同文件 `:81`）抛
`session_frozen_readonly`。**它计划被删除**，删除前提是「旧会话一次性迁移」完成 —— 迁移入口计划为
`vessel session migrate`（**未实现**：`src/cli-help-spec.ts` 的 `CLI_HELP_COMMANDS` 里没有 `session` 组；
ADR-105 D4 记的是「不做迁移、只读冻结到 0.55.0」，本文按迁移后的目标态写，ADR 正文不改）。
迁移**不带来**流式增量：`llm.stream.chunk` 从不进 `events.ndjson`，只活在进程内环；正文与思考在
`llm.response` 里，所以旧会话**可读性不受影响**，只是没有逐字回放。

新格式下 `events.ndjson` **停止增长**：它不是事实源，也不再被任何写路径追加；留着只为旧格式的只读读路径，
随旧会话一起退出（判据同上，`TIMELINE_MARKERS` 三个标记任一存在即「有 timeline」；文件名常量见
`packages/core/src/timeline/types.ts:22-42` 的 `TIMELINE_LAYOUT`）。

<a id="not-persisted"></a>

## 2. 存档 / 不存档 / 只存骨架

| 事件 | 口径 |
|---|---|
| `llm.stream.chunk` | **新格式落盘**（块级二进制帧，`packages/core/src/timeline/blocks.ts`；封块即 fsync，fsync 之后才发布，ADR-105 §3 I2）。旧链路时代**不落**，所以旧会话没有流式增量 |
| `tool_call_delta` / `finish` | **瞬时 chunk**：不占 `timeline_seq`、不进块，只走实时通道（`blocks.ts:68` 的 `TRANSIENT_CHUNK_SUBTYPES`、`writer.ts:659-666`）；刷新后由 `tool.call.started` 的 `arguments` + `tool.call.completed` 的产物复原 |
| `context.changed` / `run.checkpoint` / `session.*` / `plugin.*` | 不进事件叙事：派生快照 / 已有 durable 副本（`RunRecord`）/ 进程内状态 / 进程生命周期 |

<a id="summaries"></a>

## 3. 落骨架但不落正文的两条

**`llm.stream.summary`（流式段落摘要）** —— 每个 `text` / `reasoning` 段落**结束时发一条**（不是每个 delta），
字段定长、与 chunk 数无关：`segment_index`（本 run 内段号，0 起）、`kind`（`text` / `reasoning`）、
`chunk_count` / `bytes`（本段收到的增量条数 / UTF-8 字节数）、`first_seq` / `last_seq`（本 run 内
`llm.stream.chunk` 的**发布序号**，唯一能对账的号）、`started_at` / `ended_at`、`ttft_ms`（仅本次请求首个增量
所在段带）。段定义与 `apps/web/src/state/events.ts` 的 `buildGroup` 同源：`kind` 切换、`finish`、请求结束
（含中断 / 失败）收口；对账口径：纯段落满足 `last_seq - first_seq + 1 === chunk_count`，跨度更大说明段内有
工具增量。**不含任何正文** —— 留的是「思考 → 工具 → 正文」的交错骨架。

**`llm.request`（元信息版）** —— 日志副本只有：`content_omitted: true` + `model` / `message_count` /
`tools_count` / `estimated_tokens`（`WorkingContext.tokenCount` 缓存值，不重扫历史）/ `context_max`
（`workingContext.maxTokens` 运行时真值；未知时不写）/ `attempt`（overflow 重试链第几次，1 起）/ `stream`。
`messages` / `tools` 正文由写盘侧 `stripRequestContent` 兜底裁掉，producer 误传完整 payload 也写不进去。
`model` **不只在日志副本里**：发布副本同样带这个短字符串，因此 trace 的 `llm.request` 也有它，读侧（usage 插件）
只读字段、不去猜 —— Self Card 由 `composeRunSystemPrompt()` 拼进 system prompt，从不成为消息、不进事件。
老 trace（发布副本没有 `model`）只能归 `unknown` 或用显式配置兜底。不记 `prefix_hash`：「前缀变了」的叙事由
落盘的 `prompt.prefix_changed` 承担。

## 4. 两条硬约束

1. **摘要永不成为内容权威。** `projectMessages` / resume / 任何重建 messages 的路径都不读这两类事件；
   与正文冲突时以 `user.message` / `llm.response` / `tool.*` 为准（`projectMessages` 的分支只有
   `user.message` / `message.injected` / `session.rewound` / `message.compaction` / `llm.response` /
   `tool.call.*` / `run.completed`，没有 else）。
2. **只在写盘侧裁剪。** 发布副本不变，因此 live / WS 的 `summarizeBroadcastEvent` 与 trace 的全文策略都不受影响。

## 5. 时间序：`seq` 只保证单调

`timeline_seq` 在**写 WAL 的那一刻**分配（ADR-105 §3 I1：取号与追加在同一临界区），所以它表示**写入 / 持久顺序**，
**不表示事件的发生时间序**：`ts` 可以并列，也可以因封块窗口（`timeline.chunk_flush_ms`，ADR-105 §3 I2）而落在
同批其它事件之后。读侧一律按 `seq` 排、按 `seq` 截断，**不得按 `ts` 排或按 `ts` 截断**
（`apps/web/src/gateway/timeline-protocol.ts:221-230` 的注释即此口径）。体积上界因此与 prompt 大小解耦：
两条摘要都是定长记录（~350–480 B/条），177 轮的长 run 合计百 KB 量级。

<a id="visibility"></a>

## 6. 可见性与消费

- `llm.stream.summary` / `llm.request` 在 `apps/web/src/state/event-visibility.ts` 的三档表里归 `internal`
  （默认隐藏，打开「显示系统信息」才以原始行出现）；三档口径（`content` / `internal` / `observe`）与
  「未登记 ⇒ 按 internal 折叠成 notice」的兜底见 [事件系统](events.md#event-visibility)，门禁是
  `bun run check:event-visibility`。
- 历史回放的 `llm.request` 行只有 `tools_count` 可用于展示（`messages` 已被裁掉），`EventRow` 优先读
  `message_count`、缺失时不渲染 msgs 数字，因此不会崩。

<a id="open-tail-only"></a>

## 7. 打开会话：只读尾部

写者 `open()`（`packages/core/src/timeline/writer.ts#initialize`）是**启动路径**：进程启动、会话打开、
idle 压缩、adopt 每一次都付一遍。0.55 之前它整份读 `wal.log` + 归档副本 + 全部块文件再逐帧解析 ——
19/20 万 seq 的会话（`d813eaea`）实测 `wal.log` 6.9 MB + 归档 6.9 MB + 12,900 个块 ≈ 88 MB ≈ 340 MB 解码，
**中位 4484 ms**（冷缓存首次 8531 ms）。第十一条（增量、按需、有界）禁止启动路径出现 O(会话大小)。

现在 `initialize()` 是两条路径，产出**同一份状态**（`next_seq` / 两个 head / `published` / 洞 / 污点 /
索引 / 下一个块号）：

| 路径 | 何时 | 读什么 |
|---|---|---|
| 增量（缺省，`tryIncrementalRecovery`） | 每次 open | `timeline.idx` 打底（`loadIndexSnapshot`，32 MiB 预算）+ `wal.log` / 归档 / `timeline.manifest` **尾窗**（`wal.readNdjsonTail`，首窗 256 KiB、上限 4 MiB，可从尾部展开）+ 只解**最后一个块** + `holes.ndjson` 全读 |
| 全量（`fullRecovery`） | 增量路径任何一条自洽检查不成立 | 老路径一条判定不改；它同时是**显式修复入口** |

同一份盘上状态、before/after 各 3 次交错跑：**4484 ms → 87.6 ms**（中位，约 −98%，51×），
`heads` 逐字段一致（`wal_head` / `timeline_head` / `published_head` / `holes` / `tainted`）。

**判据没有放松**：索引算术（`first_seq = 1` 且 `count = last_seq`，`count` 是不同 seq 的个数）
+ 尾窗实测 `tailMax >= last_seq` 且 `(last_seq, tailMax]` 逐号齐全 ⇒ 记录集恰好是 `[1..tailMax]`；
恢复洞用 `findGaps` 同一个判据的区间版，`knownMax` 仍然含 `manifest.archivedTo` ——
「manifest 说已归档、盘上却读不回来」照样声明成洞、照样顶 `wal_head`。
坏行 / 坏帧 / manifest 说写完但帧缺 / 撕裂尾帧**一个字没省**：尾窗里见到就整份退回、让全量路径登记。

**语义变更（写在这里，别当 bug 追）**：**历史中段**（早已封好的老块、更早的 `wal.log` 行）的**外部**损坏
不再每次 open 重扫 —— 那是修复路径的职责，不是启动路径的职责。判据与代价：

- 症状：某次刷新 / 重启后更早的一段读不回来，而 `open()` 没报错、`heads` 也正常（因为尾窗是好的）。
- 显式修复路径：**删 `<sessionDir>/timeline.idx/` 整个目录再 open** = 整份重读 + 重建索引 + 重新声明洞
  （索引本就可重建，ADR-105 §5 的不变式「删掉索引 ⇒ 所有读 RPC 返回逐字节相同的结果，只有耗时变长」）。
  运维步骤见 [operations/GATEWAY.md §8](../operations/GATEWAY.md)。
- 尾部损坏的判定**一个字节都没退**：尾窗逐条校验、撕裂残行照旧截断、缺帧照旧退全量。

**读放大（同一台机器实测，`sessions.events` 的 `since_seq` 与 `limit` 见回报）：** 单次 `sessions.events` 仍是
「整份读时间线」的成本（19/20 万 seq 的会话 `limit=100` ≈ 17.5 s、`limit=500` ≈ 31.6–35.3 s），与 `since` 落在
哪一段几乎无关 —— 因为读面一次整份读，`limit` 只决定截多少条回来。所以**读放大的直接后果是超时，不是缺数据**：
客户端的 `TIMELINE_REQUEST_TIMEOUT_MS = 8 s` / 订阅 `REQUEST_TIMEOUT_MS = 30 s` 在这种会话上必然先超时，
随后 `timeline_gap_reported`（rule 3）与「退回 `since: 0`」都是**超时触发的假缺口**，不是盘上真的少了一段 ——
排查时先看这一节的口径，别当成写者丢事件。


