---
title: gateway 事件订阅与出站口径
kind: current
triggers: [events.subscribe, allow_global, 全局流, 出站归属, session_id 补齐, wire 回放, replay-range, system_context, 模型上下文卡, acceptOwner, droppedForeign, 串会话]
paths: [packages/serve/src/gateway.ts, packages/serve/src/gateway/methods/observability.ts, src/session/system-context.ts, apps/web/src/state/event-store.ts]
---

# gateway 事件订阅与出站口径

> 时间线单游标 epoch / 四条校验 / 尾部窗口与结趟的完整契约见 [session-replay.md](session-replay.md)
> （本页不复制）；core 回放与 trace 见 [event-trace.md](event-trace.md)。

## gateway wire 回放（有界）

WS/SSE 的单次回放有界——对过滤后的事件从最新往回取（≤ 1 MiB / 2000 条）；`hello.from_seq`
是本次 epoch 实际发送的第一条 seq；窗口之外更早的区间带 `until_seq` 逐页回退（能力位
`events.replay-range`，每页同样受同一预算约束），已经滑出环形缓冲的部分才由 `gap` 表示不可恢复，
恢复走 RPC 快照而不是无限重放。历史正文以权威存储（`sessions.get` / `teams.get`）为准。

**时间线单游标 epoch**（能力位 `timeline.cursor`）：`hello` 时间线段六字段 + `published_head`、
`count` 只覆盖到 `min(end_seq, published_head)`、`holes` 只描述可读性、`gap` 帧对时间线 epoch
永不发——完整口径与四条硬校验见 [session-replay.md](session-replay.md)。客户端按 ADR-105 §6
四条校验发现实收与 `hello.count` 对不上时发 `{kind:'timeline_gap'}` 帧，服务端只记录成
`timeline.gap_reported`（`recordTimelineGapReport`），不改事实源。

## 出站归属补齐

订阅按 `session_id` 过滤时，`llm.stream.chunk` / `tool.call.*` 这类事件本体不带该字段（只靠
gateway 的 `run_id → session_id` 映射判断该不该发）。gateway 把归属补进**出站副本**的
`data.session_id`（`??` 语义：事件自报的值永远优先，缓冲里的原始事件不被改写）；映射未知时
仍然 fail-closed 丢弃，不补字段、不改任何 `events.subscribe` 参数或 result schema。LRU 未命中时
同步读一次执行面快照回填，拿不到就继续丢（发送路径不因此变成异步等待）。

**一条不变量**：判定「发给这个订阅者」与「出站副本带 session_id」必须用同一份归属解析
（事件自报 > 回放期局部映射 > 全局 LRU > 执行面快照回填），且所有出站路径（实时广播 / WS 回放 /
WS 回填页 / SSE 回放与窗口外 pull）走同一个序列化点，否则会出现「过滤放行、帧里却没有
session_id」的静默丢事件。

## 全局流缺省拒绝

没有会话作用域的事件订阅（既不给 `session_id`、也不给 `run_id` / `types`）默认**一条都不发**——
那是进程级全局流，等于把所有会话的正文与工具结果灌给这个连接。理由是一类实测事故：漏传
`session_id` 的订阅（旧客户端、代理丢了 query、降级路径，以及「连上了还没 `events.subscribe`」
的那段时间）会让「打开 A 会话却看到 B 的事件」成为可能。三档口径：

1. `run_id` / `types` 是显式作用域，原语义不变；
2. 两者都没给 ⇒ 必须显式 opt-in（WS/RPC `allow_global: true`，SSE/连接级回放 `?allow_global=1`），否则零帧；
3. 显式 opt-in 的连接按原语义全发（运维探针）。

被拒**不静默**：服务端首次打一条 warn（只有 seq 与条数，无正文、无会话 id），`events.subscribe`
的 `stream_url` 也把本次订阅的过滤条件（`session_id` / `run_id` / `types` / `allow_global`）原样
带给 SSE 客户端——旧实现只回 `since`，照着它连就是一条串会话的全量流。

**客户端还有一道同样的校验**（`EventStore#acceptOwner`）：会话订阅下，帧自报或 `runSessions`
已知的归属与当前会话不符 ⇒ 丢弃并计数（`droppedForeign`，首次 warn，不打印正文），这条同时覆盖
实时帧与时间线回填页；回填页显式带 `expectedSessionId`，所以页里那些不自报归属的增量仍然挂得回
会话（不会因为校验变成「刷新后什么都不显示」）。

## 事件不是 message：`sessions.get.system_context`（additive）

`prompt.system_context`（**模型这一轮看到的系统消息**：基底 system prompt + Self Card 原文；
`hash` = `sha256(system_prompt + '\0' + self_card)` 前 16 位，同一会话同一 hash 只发一次）只活在
事件流里——`sessions.get.messages` 永远没有它，而 wire 回放又有界（见上）。因此进程重启 /
环形缓冲淘汰之后，唯一读路径是**从会话事件日志重新派生**：`sessions.get` 透出可选字段
`system_context`（`src/session/system-context.ts:createSystemContextSource` 用
`TimelineEventLog.readTailMatches` 尾窗回读，首窗 64 KiB、命中即停，无命中按 64K→256K→1M→4M
扩窗、累计 ≈5.3 MiB 后返回「不知道」，不回退全量扫盘；serve 侧按 session + **事件日志尾水位**
缓存，与 `context_usage` 同一范式：水位不变 = 0 字节读盘）。会话页把它投影成一张**默认折叠**的
「模型上下文」卡，与事件流那张按 `hash` 去重（同 hash 只出一张）。增量索引 `changed` /
`previous_hash` 原样透传，**缺省 = 不知道**（首份快照 / 旧日志），客户端退回全量快照卡，不渲成
「0 项变更」。**已知限制（不是 bug）**：只回**最近一条**（与失败卡的「最近一次 run」粒度一致），
更早轮次的卡刷新后不会回来。