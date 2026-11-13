---
title: 事件系统
kind: current
triggers: [event, event stream, trace, replay, observability, seq, redaction, restart, create, session]
paths: [packages/core/src/types/event.ts, packages/core/src/events/**, src/trace-wiring.ts, src/observability-wiring.ts]
---

# 事件系统

<a id="events"></a>

## 事件系统

事件流是**跨组件的唯一异步沟通总线**：runtime → 观测（TUI / 日志 / 审计 / 回放）、工具 ↔ TUI（权限确认、ask 交互暂停）。

### 命名约定

**事件名一律是开放字符串字面量**（ADR-030）：不定义 `EventType` / `PermissionEvent` 之类常量，生产者和消费者直接写字符串。**命名空间 `<domain>.<action>.<event>`**，防撞名。

- 加新事件 = 写字面量，零 import、零 core 变更。
- 代价：没有编译期拼写检查，靠命名空间约定 + `bun run check:event-visibility` 兜底
  （扫全仓事件名的生产点 / 消费点，未登记即 FAIL；口径见[可见性三档](#event-visibility)）。

<a id="event-names"></a>

### 核心事件名

| 事件名 | payload | 发布方 |
|---|---|---|
| `run.started` | `RunStartedPayload` | execution-unit |
| `llm.request` | `LlmRequestPayload` | execution-unit |
| `llm.response` | `LlmResponsePayload` | execution-unit |
| `llm.stream.chunk` | `LlmStreamChunkPayload` | execution-unit |
| `llm.stream.summary` | `LlmStreamSummaryPayload`（段落骨架，无正文） | execution-unit |
| `llm.retry` | `LlmRetryPayload`（`attempt` / `backoff_ms` / `error_code` / `scope`；默认隐藏的内部事件） | execution-unit |
| `tool.call.started` | `ToolCallStartedPayload` | execution-unit |
| `tool.call.completed` | `ToolCallCompletedPayload` | execution-unit |
| `tool.call.failed` | `ToolCallFailedPayload` | execution-unit |
| `guardrail.blocked` | `GuardrailBlockedPayload` | guardrail-runner |
| `guardrail.error` | `{ run_id, guardrail_name, stage, error }` | guardrail-runner（0.8：`check()` 抛错，随后按 `guardrail_error` blocked） |
| `hook.failed` / `hook.error` | `{ hook_name, hook_type, run_id, duration_ms, error }` | hook-runner（0.8：单 hook 抛错后继续后续 hook） |
| `context.changed` | `{ run_id, message, message_count, token_count }` | execution-unit |
| `prompt.system_context` | `PromptSystemContextPayload`（模型这一轮看到的系统消息原文；同 hash 只发一次） | execution-unit |
| `run.completed` | `RunCompletedPayload` | execution-unit |
| `run.failed` | `RunFailedPayload` | execution-unit |
| `run.cancelled` | `RunCancelledPayload` | execution-unit（0.5：仅显式用户取消；Host 中断仍发 `run.failed`） |
| `replay.started` / `replay.completed` | `{ run_id, event_count, duration_ms? }` | replayRun |
| `run.checkpoint` | `{ run_id, session_id, status, iteration? }` | execution-unit |
| `run.resumed` | `{ run_id, session_id, from_status, iteration }` | execution-unit |
| `run.finalize.failed` | `{ run_id, session_id, error }` | execution-unit（0.8：终态持久化失败，保留原始 run 错误） |

**约定事件名**（不在 `EventPayload` 联合类型里，按开放字符串协议使用）：

| 事件名 | 方向 | 用途 |
|---|---|---|
| `tool.permission.request` / `tool.permission.response` | 工具 → TUI → 工具 | 执行期权限确认（0.13 起默认不超时） |
| `ask.user.requested` / `ask.user.answered` | 工具 → TUI → 工具 | ask 交互暂停 |
| `mcp.server.connected` / `mcp.server.failed` / `mcp.server.disconnected` | MCP 插件 → 观测 | server 生命周期（失败隔离） |
| `mcp.tool.called` / `mcp.tool.failed` | MCP 插件 → 观测 | MCP 工具调用 |
| `channel.feishu.connected` / `channel.feishu.disconnected` / `channel.feishu.message.received` / `channel.feishu.reply.sent` / `channel.feishu.error` | 飞书插件 → 观测 | 渠道生命周期与消息 |
| `session.saved` / `session.deleted` / `session.titled` | core / 装配层 → 观测 | 会话持久化（0.5）；`session.titled` payload `{ session_id, title }`，写前重读保留人工标题 |
| `agent.restarting` / `agent.restarted` / `agent.retired`；`agent.spawned`（带来源）/ `session.created` / `session.activated` / `agent.session.activated` / `agent.create.failed` | AgentService → 观测 | binding 生命周期（restart 0.34；有来源 create 0.39）；payload 带 agent / session / epoch；`agent.retired` payload `{ body_id, epoch, reason }`（rotate / restart / close / 回收共用）。**rotate 只发两条**：旧 body 退役的 `agent.retired`（在 rotate 工具内、旧 run 未结束时即发）与新 primary 的 `agent.session.activated`（切换与快照之后发），启动嘱托在其后 admit；ADR-092 设想的 `agent.rotating` / `agent.rotated` / `agent.rotate.failed` 从未实现，0.51 删除（见该 ADR 的 Errata）。旧 `agent.forked` / `agent.compact_forked` / `session.forked` 只读渲染 |
| `agent.message.queued` | AgentService → 观测 | 收件箱投递，一条事件三种模式：payload `{ delivery, message_id, from, state?, to?, wake?, conversation_id? }`；`delivery: 'input'` 会进 run 队列，也只有它带 `state`；`'wake'` 落盘时只追加 inbox（目标忙就到此为止，不打断在跑的那轮），空闲时 service 再把**队头**那条的正文直投成下一轮 run input（带 `to` / `wake`，`wake=false` 表示这一步什么都没做，`true` 表示真的投了：直投或退回摘要唤醒）；`'quiet'` 只落 inbox。从 `'wake'` 升级成直投时同一条消息会再发一次 `delivery: 'input'`（同 `message_id`），这才是它真的入队的那一刻；唤醒 / 只落盘都不写 `state`，观测面不得把这两类当成入队。旧 `agent.message.notified` 不再发布，落盘历史只读 |
| `config.loaded` | asm → 观测 | 只记来源与键名，不记密钥值（0.5） |
| `plugin.loaded` / `plugin.failed` | asm / core → 观测 | 插件加载（0.5） |
| `trace.write.failed` / `trace.overflow` | core trace → 观测 | 写失败/队列溢出，标记 trace 不完整（0.5） |
| `eval.run.started` / `eval.run.completed` | evals 插件 → 观测 | eval 运行与计数（0.5） |

插件可自定义任意 `<domain>.*` 事件名，无需改 core。

<a id="event-visibility"></a>

### 可见性三档（唯一分类表）

**判据只有一句：档位由内容性质决定，不由「默认想不想藏」决定。** 唯一真相源是
`apps/web/src/state/event-visibility.ts`（`EVENT_TIERS` + `EVENT_TIER_FAMILIES` +
`tierOf` / `isVisibleInChat`），不要在渲染层另写可见性判断。

| 档 | 含义 | 聊天时间线 | 团队日志 |
|---|---|---|---|
| `content` | 用户要读的对话内容（正文 / 工具 / 输入 / run 终态 / 真失败） | 恒可见 | 按 `teamLog` |
| `internal` | run 内部状态同步与过程信号（诊断、生命周期 notice） | 默认隐藏；`ui.showInternalEvents` 或 `verbosity: debug` 时可见（`ui.errorLevel: all` 另按旧语义放出 internal 级失败） | 按 `teamLog` |
| `observe` | 会话 / 成员元数据审计、交互卡与观察面诊断 | **恒不可见**（与开关无关，只在 Observe / Runs 看） | 按 `teamLog` |

三条硬约束：

1. **未登记 ⇒ 按 `internal` 处理**，并渲染成一条「未知事件类型 · 已折叠」notice
   （展开是原始载荷），**绝不落裸 JSON 卡**。这是对门禁管不到的边界（第三方插件 /
   上游事件 / 旧 trace）的兜底 —— 漏登记最坏只是一行折叠的内部提示。
2. **失败类永不进 `observe`**：任何集合都在 `ui.errorLevel` 之前过滤，塞进静默档等于
   静默真失败。`observe` 里出现 `isErrorEventType`，或 `run.` / `tool.` / `guardrail.`
   前缀的失败类不是 `content`，`check:event-visibility` 直接 FAIL。
3. **家族前缀必须显式登记**（`subagent.` / `tool.call.` / `mcp.` / `channel.feishu.` /
   `eval.run.`）；不在表、也不在家族里的名字由门禁拦下。

`承接` 列回答「这条事件藏掉之后，用户还能在哪看到它」：`notice` = typed notice 卡
（`EventRow.noticeView`）、`card` = 专用卡片 / 交互卡、`team-log` = 团队日志行、
`dto` = 成员 / 插件页的 DTO、`raw-card` = 显式保留原始事件行（只有 `guardrail.blocked`）。
`生产者` 列 `legacy` = 本仓已无生产者、只读历史（门禁据此做「表腐烂」的反向断言：
标了 `live` 却扫不到事件名就 FAIL）。本表的**键集**与代码一一对应
（`bun run check:event-visibility` 的 A6 断言，缺一边即 FAIL）。

<!-- event-visibility:begin -->
| 事件名 | 档 | 承接 | 团队日志 | 生产者 |
|---|---|---|---|---|
| `run.started` | content | card | none | live |
| `run.completed` | content | card | reply | live |
| `run.failed` | content | card | system | live |
| `run.cancelled` | content | card | system | live |
| `run.finalize.failed` | content | notice | none | live |
| `user.message` | content | card | none | live |
| `prompt.system_context` | content | card | none | live |
| `llm.stream.chunk` | content | card | none | live |
| `tool.call.started` | content | card | none | live |
| `tool.call.completed` | content | card | none | live |
| `tool.call.failed` | content | card | none | live |
| `guardrail.blocked` | content | raw-card | none | live |
| `guardrail.error` | content | notice | none | live |
| `agent.limit.warning` | content | notice | none | live |
| `agent.reply.stale` | content | notice | none | live |
| `error` | internal | — | none | legacy |
| `hook.failed` | internal | — | none | live |
| `hook.error` | internal | — | none | live |
| `hook.started` | internal | notice | none | live |
| `hook.completed` | internal | notice | none | live |
| `hook.system_prompt_ignored` | internal | notice | none | live |
| `hook.additional_context_deprecated` | internal | notice | none | live |
| `llm.request` | internal | — | none | live |
| `llm.response` | internal | — | none | live |
| `llm.stream.summary` | internal | — | none | live |
| `llm.retry` | internal | — | none | live |
| `run.checkpoint` | internal | — | none | live |
| `run.resumed` | internal | — | none | live |
| `context.changed` | internal | — | none | live |
| `context.pressure` | internal | notice | none | live |
| `context.compacted` | internal | notice | none | live |
| `context.cleared_tool_result` | internal | — | none | live |
| `message.injected` | internal | — | none | live |
| `message.compaction` | internal | — | none | live |
| `limit.blocked` | internal | — | none | live |
| `prompt.prefix_changed` | internal | — | none | live |
| `replay.started` | internal | — | none | live |
| `replay.completed` | internal | — | none | live |
| `session.saved` | internal | — | none | live |
| `session.log.failed` | internal | — | none | live |
| `process.error` | internal | — | none | live |
| `shutdown.failed` | internal | — | none | live |
| `trace.write.failed` | internal | — | none | live |
| `trace.overflow` | internal | — | none | live |
| `plugin.failed` | internal | — | none | live |
| `plugin.init.failed` | internal | — | none | live |
| `plugin.dispose.failed` | internal | — | none | live |
| `runtime.notice` | internal | — | none | live |
| `team.budget.warning` | internal | — | none | live |
| `team.budget.blocked` | internal | — | none | live |
| `team.budget.override` | internal | — | none | live |
| `agent.retired` | internal | notice | none | live |
| `agent.rotate.approved` | observe | — | none | live |
| `agent.rotate.denied` | observe | — | none | live |
| `agent.updated` | observe | dto | none | live |
| `agent.role.changed` | observe | dto | none | live |
| `agent.rejoined` | observe | dto | system | live |
| `agent.permission.cancelled` | observe | — | none | live |
| `agent.spawned` | observe | team-log | system | live |
| `agent.closed` | observe | team-log | system | live |
| `agent.message.queued` | observe | — | none | live |
| `agent.message.notified` | observe | — | none | legacy |
| `agent.message.sent` | observe | — | none | legacy |
| `agent.stale` | observe | — | none | live |
| `agent.permission.requested` | observe | — | none | legacy |
| `agent.permission.responded` | observe | — | none | legacy |
| `agent.session.activated` | observe | — | none | live |
| `agent.queue.entered` | observe | — | none | live |
| `agent.queue.left` | observe | — | none | live |
| `agent.compact_forked` | internal | notice | none | legacy |
| `agent.restarting` | internal | notice | none | live |
| `agent.restarted` | internal | notice | none | live |
| `agent.create.failed` | internal | — | none | live |
| `agent.forked` | observe | team-log | system | legacy |
| `session.created` | observe | — | none | live |
| `session.activated` | observe | — | none | legacy |
| `session.rewound` | observe | — | none | legacy |
| `session.forked` | observe | — | none | legacy |
| `session.titled` | observe | — | none | live |
| `session.deleted` | observe | — | none | live |
| `tool.permission.request` | observe | card | none | live |
| `tool.permission.response` | observe | card | none | live |
| `tool.permission.expired` | observe | card | none | legacy |
| `ask.user.requested` | observe | card | none | live |
| `ask.user.answered` | observe | card | none | live |
| `ask.user.timeout` | observe | card | none | live |
| `config.loaded` | observe | — | none | live |
| `plugin.loaded` | observe | — | none | live |
| `plugin.changed` | observe | — | none | live |
| `update.available` | observe | — | none | live |
| `rpc.result_invalid` | observe | — | none | live |
| `federation.received` | observe | — | none | live |
| `federation.rejected` | observe | — | none | live |
| `guardrail.modified` | observe | — | none | legacy |
| `mcp.server.connected` | observe | — | none | live |
| `mcp.server.disconnected` | observe | — | none | live |
| `mcp.resource.read` | observe | — | none | live |
| `mcp.tool.called` | observe | — | none | live |
| `mcp.warning` | observe | — | none | live |
| `mcp.server.failed` | internal | — | none | live |
| `mcp.tool.failed` | internal | — | none | live |
| `channel.feishu.connected` | observe | — | none | live |
| `channel.feishu.disconnected` | observe | — | none | live |
| `channel.feishu.message.received` | observe | — | none | live |
| `channel.feishu.reply.sent` | observe | — | none | live |
| `channel.feishu.error` | internal | — | none | live |
| `eval.run.started` | observe | — | none | live |
| `eval.run.completed` | observe | — | none | live |
| `delegate.started` | internal | — | none | legacy |
| `delegate_task.started` | internal | — | none | legacy |
| `delegate.completed` | internal | — | none | legacy |
| `delegate.failed` | internal | — | none | legacy |
<!-- event-visibility:end -->

> `delegate.*` / `delegate_task.*` 是 TUI 侧去掉 `subagent.` 前缀后的消费形态（线上名是
> `subagent.delegate.*`，由家族覆盖），本仓没有独立生产者。

> 0.51 删掉三条**死类型**：`agent.rotating` / `agent.rotated` / `agent.rotate.failed`。
> ADR-092 第 18 条要求过它们，实现从未发出（无生产者，Web 的 notice 分支与团队日志
> `rotate` 行都是永远走不到的路径）。rotate 的实际时序只有两条事件：旧 body 退役的
> `agent.retired` **在 rotate 工具内就发**（此时旧 run 可能还没结束，迟到轮随后由
> `agent.reply.stale` 解释），新 primary 的 `agent.session.activated` 在切换 + 快照之后发，
> 启动嘱托在其后 admit。详见 [ADR-092](../adr/ADR-092-agent-rotate-and-epoch-fencing.md) 文末的 0.51 Errata。

**思维链不进入事件流**：`llm.request` 的 messages 与 `context.changed` 的 message 在发布前剔除 `reasoning_content`（ADR-038）；`WorkingContext` 的持久化记录仍保留该字段，供下一轮请求回传。

<a id="event-log-policy"></a>
### 会话事件日志的落盘口径

落盘形态 ≠ 发布形态：正文见 [会话事件日志落盘口径](event-log-policy.md)。

### 三种机制的边界（防混用）

| 机制 | 职责 | 例子 | 混用的后果 |
|---|---|---|---|
| **直接调用** | core 内部 / 关键路径（必须可靠、有序、单消费者） | `context.add`、`provider.chat`、`pluginHost.getTool` | 把协作直接调用 → 耦合 |
| **事件流** | 跨组件异步沟通（可丢失、多消费者、要解耦） | runtime→观测、工具↔TUI | 把内部调用事件化 → 关键路径不可靠 |
| **Hook / Guardrail** | 同步生命周期拦截（阶段检查） | `BeforeLlm`、`ToolCall` guardrail | 用事件流实现拦截 → 竞态 |

**交互暂停的形态**：工具 `publish` 一个请求事件 → `await events.waitFor(回复事件, { requestId, timeout })` → 拿到答案继续。loop 不需要任何暂停/恢复机制——handler 本身就在 await。

**ask 的题是一等公民（0.51，只加字段）**：`ask.user.requested` 的每道题带 `id`（`q1`/`q2`/…，由工具按题序写；旧事件没有该字段时读侧按「下标 + 1」推出同一个值），所以「第 3 题答了没有」在协议里可判定。答案行增 `question_id` 与 `selected?: string[]`（多选的结构化选中项；`answer` 仍是给模型读的那段文本，模型侧零影响）。

`ask.user.answered` 增三个可选键，缺省即旧语义（一条事件 = 整条请求答完）：

| 键 | 含义 |
|---|---|
| `answers[].question_id` / `selected` | 这一行挂在哪道题上 / 多选选中项 |
| `final?: boolean` | 这条请求是否**全部**题都答完了（缺省 `true`） |
| `remaining?: string[]` | 仍未答的题 id，只在 `final === false` 时有意义 |
| `batch_id?: string` | 这次答案属于待批页的哪一次提交（与 `ask.respond` 的同名参数一致） |

由此三件事同时成立：**一次提交只落已答的那几题**（未答的题留在 `pending`，靠记录上的 `answered_questions` 记住进度，不新增状态档）；**同一题不得答两次**（重复提交回 `duplicate` + `skipped_questions`）；**首批答案到达即返回**——ask 工具只 `waitFor` 一次，未答的题写进工具结果正文，后续批次由装配层作为**一条** inbox 消息（来源 `ask`）补投给成员并起新 run。`ask.respond` 的返回体相应增 `answered_questions` / `remaining_questions` / `skipped_questions` / `final`（全部可选，旧客户端不看即旧行为），`interactions.list` 的 ask 条目带 `answered_questions`，`answer.batch_answers` 是「本批新增的答案」（投放正文只取这一批，累计全集仍在 `answer.answers`）。

### 事件回放

`MemoryEventStream` 之外，core 提供 `FileEventStore`（JSONL 一行一事件：`append` / `readRun` / `listRunIds` / `deleteRun`）与 `replayRun(store, runId, eventStream, { delayMs })`。回放经同一个 `publish()` 重新发布历史事件（保留原始 `ts`），订阅者用同一个 `subscribe()` 接收 live 与 replay，靠 `replay.started` / `replay.completed` 区分边界。

**事件是 spec，回放是 oracle**：同一 session 的事件重放必须产生相同状态与投影（`rebuildMetrics` 与订阅者状态一致）；SSE 断线重连的 `since` 续传、重复与缺口纳入回放等价探针，不只测“能连上”。

**gateway wire 回放**：WS/SSE 的单次回放有界——对过滤后的事件从最新往回取（≤ 1 MiB / 2000 条）；`hello.from_seq` 是本次 epoch 实际发送的第一条 seq；窗口之外更早的区间带 `until_seq` 逐页回退（能力位 `events.replay-range`，每页同样受同一预算约束），已经滑出环形缓冲的部分才由 `gap` 表示不可恢复，恢复走 RPC 快照而不是无限重放。历史正文以权威存储（`sessions.get` / `teams.get`）为准。

**出站归属补齐**：订阅按 `session_id` 过滤时，`llm.stream.chunk` / `tool.call.*` 这类事件本体不带该字段（只靠 gateway 的 `run_id → session_id` 映射判断该不该发）。gateway 会把归属补进**出站副本**的 `data.session_id`（`??` 语义：事件自报的值永远优先，缓冲里的原始事件不被改写）；映射未知时仍然 fail-closed 丢弃，不补字段、不改任何 `events.subscribe` 参数或 result schema。LRU 未命中时会同步读一次执行面快照回填，拿不到就继续丢（发送路径不因此变成异步等待）。所以消费方可以放心把 `data.session_id` 当作事件归属的回退依据。 **一条不变量**：判定「发给这个订阅者」与「出站副本带 session_id」必须用同一份归属解析（事件自报 > 回放期局部映射 > 全局 LRU > 执行面快照回填），且所有出站路径（实时广播 / WS 回放 / WS 回填页 / SSE 回放与窗口外 pull）走同一个序列化点，否则会出现「过滤放行、帧里却没有 session_id」的静默丢事件。

**事件不是 message：`sessions.get.system_context`（additive）**。`prompt.system_context`
（**模型这一轮看到的系统消息**：基底 system prompt + Self Card 原文；`hash` =
`sha256(system_prompt + '\0' + self_card)` 前 16 位，同一会话同一 hash 只发一次）只活在事件流里
—— `sessions.get.messages` 永远没有它，而 wire 回放又有界（见上）。因此进程重启 / 环形缓冲淘汰
之后，唯一读路径是**从会话事件日志重新派生**：`sessions.get` 透出可选字段
`system_context`（`src/system-context.ts` 用 `SessionEventLog.readTailMatches` 尾窗回读，
serve 侧按 session + **事件日志尾水位**缓存，与 `context_usage` 同一范式：水位不变 = 0 字节读盘）。
会话页把它投影成一张**默认折叠**的「模型上下文」卡，与事件流那张按 `hash` 去重（同 hash 只出一张）。
**已知限制（不是 bug）**：只回**最近一条**（与失败卡的「最近一次 run」粒度一致），更早轮次的卡刷新后
不会回来。

<a id="trace"></a>

### trace 落盘

`RunEvent` 增加可选 `seq?`。`TraceRecorder` port 由 asm 接线，默认 `FileTraceRecorder` 把每个 run 写成 `<data_dir>/events/<run_id>.jsonl`（append-only，一行一事件）。

- **seq**：由 recorder 落盘时分配，以文件尾部最大 seq 为种子；内存实时事件允许无 seq，消费方按 `(seq ?? ts)` 回退。`events.list` 返回 trace seq；gateway 的 `events.subscribe.since` 是 wire seq，二者分层。
- **级别**：`full` 保留完整 payload（例外：`llm.request` 的 `messages` 按 WS 广播同一份摘要落盘，0.52；会话事件日志另有一套更窄的元信息口径，见 [会话事件日志的落盘口径](#event-log-policy)）；`metadata` 只留信封与白名单字段（`status` / `tool_name` / `duration_ms` / `iterations` / `iteration` / `message_count` / `finish_reason` / `usage.*`），`error` 截断 ≤500、`reason` ≤200；`off` 不落盘。
- **留存**：缺省 30 天 / 1000 runs / 1 GiB（单 node）；`vessel trace prune` 或启动时执行，不删除 `running` / `interrupted` run。
- **失败与溢出**：写失败发 `trace.write.failed` 并计数，不向事件投递路径抛错；每 run 队列上限 10000，溢出丢新事件并写一行 `trace.overflow { dropped }`，同一 run 最多一次 `trace.write.failed { reason: 'queue_overflow' }`。
- **脱敏**：trace 写入前与 gateway 出站前都过 `TraceRedactor`；默认按键名与 `sk-` 前缀替换，`app_id` 只留前 4 位 + `***`。0.5 **不**对 run checkpoint、eval 报告、飞书回复脱敏（resume / 展示需要完整内容）；POSIX 下 0600 best-effort。
- **读取与重建**：`readTraceEvents(traceDir, filter)` 默认 limit 50、最大 500，按 `(seq ?? ts)` 升序，跳过损坏行；`rebuildMetrics(traceDir)` 返回与实时 `MetricsSnapshot` 同形状，`updated_at = max(ts)`。
- **取消**：显式用户取消只发 `run.cancelled`，不再同时发 `run.failed`；Host 关闭/中断仍发 `run.failed`。0.8 起 `run()` 与 `resumeRun()` 共用 `finalizeRun`，resume 的用户取消同样发 `run.cancelled`（ADR-054）。因此 `metrics.runs.cancelled` 在 0.5+ 可能非 0。
- **事件归属**：core 发 `session.saved/deleted`、`hook.*`、`run.cancelled`、`installPlugin` 的 `plugin.*`；asm 发 `config.loaded` 与 `PluginLoader` 的 `plugin.loaded/failed`；ext 发 `eval.*` / `feishu.*` / `mcp.*` / `subagent.*`。

