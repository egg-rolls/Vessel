---
title: 会话事件日志落盘口径
kind: current
triggers: [event log, llm.request, stream summary, persist, resume, projection, ttft, chunk_count]
paths: [packages/core/src/runtime/run-journal.ts, packages/core/src/runtime/execution-unit.ts, packages/core/src/types/event.ts, apps/web/src/state/events.ts]
---

# 会话事件日志落盘口径

> 会话事件日志是恢复的真相源，只放**事实**（用户输入、LLM 响应、工具调用、权限、终态）。
> **落盘形态 ≠ 发布形态**：`ExecutionUnit` 发布的事件保持完整（live 订阅 / WS 广播 / trace），
> 写盘那一份由 `RunJournal` 决定（`NON_PERSISTED_EVENT_TYPES` + `persistData` + `stripRequestContent`，
> 见 `packages/core/src/runtime/run-journal.ts`）。

<a id="not-persisted"></a>

## 不落盘的

| 事件 | 理由 |
|---|---|
| `llm.stream.chunk` | 逐 token 增量，体量与 token 数同级。**流式正文不落，结构落摘要**（见下） |
| `context.changed` | 派生快照（注入上下文的全量镜像）；叙事已由 `context.pressure` / `context.compacted` 承担 |
| `run.checkpoint` | `RunRecord` 已有 durable checkpoint（含 `event_cursor`），日志里再写一遍是同一事实的第二份 |
| `session.saved` / `session.deleted` / `session.log.failed` | 进程内状态同步与写盘失败上报，落盘会递归 |
| `plugin.*` | 进程生命周期，不进会话叙事 |

<a id="summaries"></a>

## 落骨架但不落正文的两条

**`llm.stream.summary`（流式段落摘要）** —— 每个 `text` / `reasoning` 段落**结束时发一条**
（不是每个 delta），字段定长、与 chunk 数无关：

| 字段 | 语义 |
|---|---|
| `segment_index` | 本 run 内的段号（0 起） |
| `kind` | `text` / `reasoning` |
| `chunk_count` / `bytes` | 本段收到的增量条数 / UTF-8 字节数 |
| `first_seq` / `last_seq` | 本 run 内 `llm.stream.chunk` 的**发布序号**（chunk 不落盘，这是唯一能对账的序号） |
| `started_at` / `ended_at` | 段首/段尾时刻 |
| `ttft_ms` | 仅「本次请求首个增量所在段」带，首字延迟 |

段定义与 `apps/web/src/state/events.ts` 的 `buildGroup` 同源：`kind` 切换、`finish`、请求结束
（含中断 / 失败）收口；`tool_call_delta` 不断段但**占号**。对账口径：纯段落满足
`last_seq - first_seq + 1 === chunk_count`；跨度更大说明段内有工具增量 / `finish`；
段与段之间的空洞就是丢帧线索。**不含任何正文或思考文本** —— 它留的是
「思考 → 工具 → 正文」的交错骨架，不是内容。

**`llm.request`（元信息版）** —— 日志副本只有：

`content_omitted: true` + `model` / `message_count` / `tools_count` / `estimated_tokens`
（= `WorkingContext.tokenCount` 增量缓存值，不重扫历史）/ `context_max`（= `workingContext.maxTokens`
运行时真值，2026-11 起随事件落盘，让历史会话的「上下文窗口」自足、不必回推配置；`maxTokens`
未知时不写该字段）/ `attempt`（overflow 重试链第几次，1 起）
/ `stream`（+ 显式开启时的 `include_reasoning`）。`messages` / `tools` 正文由写盘侧
`stripRequestContent` 兜底裁掉，所以即使 producer 误传完整 payload 也写不进 `events.ndjson`。

目的：从落盘日志看出「这一轮发了几次请求、每次多大、带几个工具、是不是重试」，
而不必为每轮 prompt 付一份全量副本。不记 `prefix_hash`：core 没有现成前缀哈希
（`PromptPrefixGuard` 是逐条字符串比较），新造一套等于再加一份派生真相；
「前缀变了」的叙事由落盘的 `prompt.prefix_changed` 承担。

<a id="invariants"></a>

## 两条硬约束

1. **摘要永不成为内容权威。** `projectMessages` / resume / 任何重建 messages 的路径都不读这两类事件；
   与正文冲突时以 `user.message` / `llm.response` / `tool.*` 为准（`projectMessages` 的分支只有
   `user.message` / `message.injected` / `session.rewound` / `message.compaction` / `llm.response` /
   `tool.call.*` / `run.completed`，没有 else）。
2. **只在写盘侧裁剪。** 发布副本不变，因此 live / WS 的 `summarizeBroadcastEvent` 与 trace 的全文
   策略都不受影响。

## 体积上界

两条都是**定长**记录（键集固定，只有数字位数浮动，与 chunk 数 / 正文大小无关）：

- `llm.stream.summary` 最坏 ~480 B/条（含 36 字节 id 与 7 位数计数），典型 ~350 B；条数 = 段落数，
  典型 2/请求（思考 + 正文），177 轮的长 run ≈ 354 条 ≈ 170 KB。只有 provider 逐 delta 交替 kind
  这种病态流式才会退化到「段数 ≈ delta 数」。
- `llm.request` 最坏 ~480 B/条，典型 ~300 B；条数 = 真实请求数（含重试），177 轮 ≈ 178 条 ≈ 85 KB。
  对比发布副本的实测均值 1 MB/条（见 `summarize-event.ts` 的 0.52 数据），同一 run 从 178 MB
  量级降到百 KB 量级。

合计对 `events.ndjson` 是百 KB/长 run 级，且与 prompt 大小解耦。

<a id="visibility"></a>

## 可见性与消费

- `llm.stream.summary` 在 `apps/web/src/state/event-visibility.ts` 的三档表里归 `internal`
  （默认隐藏、打开「显示系统信息」/ `verbosity: debug` 才以原始行出现）；`llm.request`
  同理。三档口径（`content` / `internal` / `observe`）与「未登记 ⇒ 按 internal 折叠成
  notice」的兜底见 [事件系统](events.md#event-visibility)，门禁是
  `bun run check:event-visibility`。
- 历史回放的 `llm.request` 行只有 `tools_count` 可用于展示（`messages` 已被裁掉），
  `EventRow` 今天优先读 `message_count`、缺失时不渲染 msgs 数字，因此不会崩。

