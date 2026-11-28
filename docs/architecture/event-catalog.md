---
title: 事件命名与 payload 目录
kind: current
triggers: [event, event name, payload, 命名, 事件名, 核心事件, 约定事件, 开放字符串, 命名空间, 交互暂停, ask, waitFor, 机制边界]
paths: [packages/core/src/types/event.ts, packages/core/src/events/**]
---

# 事件命名与 payload 目录

> 事件流是**跨组件的唯一异步沟通总线**：runtime → 观测（TUI / 日志 / 审计 / 回放）、
> 工具 ↔ TUI（权限确认、ask 交互暂停）。可见性三档见 [event-visibility.md](event-visibility.md)；
> 回放与 trace 见 [event-trace.md](event-trace.md) / [event-subscribe.md](event-subscribe.md)。

## 命名约定

**事件名一律是开放字符串字面量**（ADR-030）：不定义 `EventType` / `PermissionEvent` 之类常量，
生产者和消费者直接写字符串。**命名空间 `<domain>.<action>.<event>`**，防撞名。

- 加新事件 = 写字面量，零 import、零 core 变更。
- 代价：没有编译期拼写检查，靠命名空间约定 + 评审核对兜底（新增事件先在
  `event-visibility.ts` 登记，见 [event-visibility.md](event-visibility.md)）。

## 核心事件名（`EventPayload` 联合类型，`packages/core/src/types/event.ts`）

| 事件名 | payload | 发布方 |
|---|---|---|
| `run.started` | `RunStartedPayload`（`input` / 可选 `input_name`） | execution-unit |
| `llm.request` | `LlmRequestPayload` | execution-unit |
| `llm.response` | `LlmResponsePayload` | execution-unit |
| `llm.stream.chunk` | `LlmStreamChunkPayload` | execution-unit |
| `llm.stream.summary` | `LlmStreamSummaryPayload`（段落骨架，无正文） | execution-unit |
| `llm.retry` | `LlmRetryPayload`（`attempt` / `backoff_ms` / `error_code` / `scope`；默认隐藏的内部事件） | execution-unit |
| `llm.empty_response` | `LlmEmptyResponsePayload`（`action: seamless/nudge/exhausted`；seamless/nudge 是内部过程信号，exhausted 标 `run.failed{empty_response_exhausted}` 并经 peer 链路通知 parent） | execution-unit |
| `tool.call.started` | `ToolCallStartedPayload` | execution-unit |
| `tool.call.completed` | `ToolCallCompletedPayload` | execution-unit |
| `tool.call.failed` | `ToolCallFailedPayload`（含 `ErrorEnvelope`） | execution-unit |
| `guardrail.blocked` | `GuardrailBlockedPayload` | guardrail-runner |
| `guardrail.error` | `{ run_id, guardrail_name, stage, error }`（`check()` 抛错，随后按 `guardrail_error` blocked） | guardrail-runner |
| `hook.failed` / `hook.error` | `{ hook_name, hook_type, run_id, duration_ms, error }`（单 hook 抛错后继续后续 hook） | hook-runner |
| `context.changed` | `{ run_id, message, message_count, token_count }` | execution-unit |
| `prompt.system_context` | `PromptSystemContextPayload`（模型这一轮看到的系统消息原文；同 hash 只发一次） | execution-unit |
| `context.projection_applied` | `{ schema_version, mode, effective_mode, declaration_id, plan_hash, ids_count, basis, reason, steps, at }`（**决策变更**的 run 起点一条，落盘审计 `context_projection_audit` 的可见镜像，ADR-104 §5.1/§5.2） | execution-unit |
| `context.projection_degraded` | `{ schema_version, mode, effective_mode, reason, basis, steps }`（运行期 fail-open 到 `passthrough` 的留痕；`reason` 用 §6.4 冻结码） | execution-unit |
| `context.projection_pressure` | `{ used, max, ratio, basis, threshold_ratio, total_count, retained_tokens, max_tokens, retained_ratio, top_result_bytes, effective_mode }`（`passthrough` 下体积触顶**只告警不压缩**；`basis: 'all_tool_results'`） | execution-unit |
| `timeline.gap_reported` | `{ session_id?, expected?, received?, start_seq?, end_seq?, after_timeline_seq?, check?, at }`（客户端按 ADR-105 §6 四条校验发现实收与 `hello.count` 对不上时发 `{kind:'timeline_gap'}` 帧，服务端只记录、不改事实源；`check` = 1 首条 / 2 末条 / 3 条数 / 4 集合闭区间。不含事件正文） | serve gateway（`recordTimelineGapReport`） |
| `run.completed` | `RunCompletedPayload` | execution-unit |
| `run.failed` | `RunFailedPayload`（含 `ErrorEnvelope`） | execution-unit |
| `run.cancelled` | `RunCancelledPayload`（仅显式用户取消；Host 中断仍发 `run.failed`） | execution-unit |
| `replay.started` / `replay.completed` | `{ run_id, event_count, duration_ms? }` | replayRun |
| `run.checkpoint` | `{ run_id, session_id, status, iteration? }` | execution-unit |
| `run.resumed` | `{ run_id, session_id, from_status, iteration }` | execution-unit |
| `run.finalize.failed` | `{ run_id, session_id, error }`（终态持久化失败，保留原始 run 错误） | execution-unit |

## 约定事件名（不在 `EventPayload` 联合里，按开放字符串协议使用）

| 事件名 | 方向 | 用途 |
|---|---|---|
| `tool.permission.request` / `tool.permission.response` | 工具 → TUI → 工具 | 执行期权限确认（默认不超时） |
| `ask.user.requested` / `ask.user.answered` | 工具 → TUI → 工具 | ask 交互暂停（题级协议见下） |
| `mcp.server.connected` / `mcp.server.failed` / `mcp.server.disconnected` | MCP 插件 → 观测 | server 生命周期（失败隔离） |
| `mcp.tool.called` / `mcp.tool.failed` | MCP 插件 → 观测 | MCP 工具调用 |
| `channel.feishu.connected` / `.disconnected` / `.message.received` / `.reply.sent` / `.error` | 飞书插件 → 观测 | 渠道生命周期与消息 |
| `session.saved` / `session.deleted` / `session.titled` | core / 装配层 → 观测 | 会话持久化；`session.titled` payload `{ session_id, title }`，写前重读保留人工标题 |
| `agent.restarting` / `agent.restarted` / `agent.retired`；`agent.spawned`（带来源）/ `session.created` / `session.activated` / `agent.session.activated` / `agent.create.failed` | AgentService → 观测 | binding 生命周期；payload 带 agent / session / epoch；`agent.retired` payload `{ body_id, epoch, reason }`（rotate / restart / close / 回收共用）。rotate 时序与死类型见 [event-visibility.md](event-visibility.md#rotate-死类型只读历史)。旧 `agent.forked` / `agent.compact_forked` / `session.forked` 只读渲染 |
| `agent.message.queued` | AgentService → 观测 | 收件箱投递，一条事件三种模式：payload `{ delivery, message_id, from, state?, to?, wake?, conversation_id? }`；`delivery: 'input'` 会进 run 队列，也只有它带 `state`；`'wake'` 落盘时只追加 inbox（目标忙就到此为止），空闲时 service 再把**队头**那条正文直投成下一轮 run input（`wake=false` 表示这一步什么都没做，`true` 表示真的投了）；`'quiet'` 只落 inbox。从 `'wake'` 升级成直投时同一条消息再发一次 `delivery: 'input'`（同 `message_id`），那才是它真的入队的那一刻；唤醒 / 只落盘都不写 `state`，观测面不得当成入队。旧 `agent.message.notified` 不再发布，落盘历史只读 |
| `agent.inbox.changed` | AgentInboxStore onChange → AgentService → 观测 | agent 级 inbox 状态机变更信号：payload `{ reason: appended/held/unheld/released/consumed/claimed/discarded, message_ids, delivery? }` + emitForSession 恒带的 agent/session/visibility/name/ts。store 每个 mutation 口落状态后一条（no-op / 纯读不发）；**只是触发器**，面板数据仍来自 `agents.inbox` RPC。会话订阅按服务端派生的归属 agent 放行（fail-closed）；`agent.message.queued` 保留不动 |
| `bash.job.started` / `bash.job.completed` / `bash.job.failed` | bash 消费者 → 观测 | 异步 bash 作业生命周期；用户可见表示是 inbox 通用占位回调卡（AsyncJobCard）+ run 徽标，聊天 / 团队时间线永不出现。收口收集失败的 catch 兜底同样发 `bash.job.failed`（`collect_failed=true`）；进程重启遗留的 running 占位卡由启动对账回写 failed（`reconcileAsyncJobs`，不发时间线事实——上一进程的 run 已不可考） |
| `config.loaded` | asm → 观测 | 只记来源与键名，不记密钥值 |
| `plugin.loaded` / `plugin.failed` | asm / core → 观测 | 插件加载 |
| `trace.write.failed` / `trace.overflow` | core trace → 观测 | 写失败 / 队列溢出，标记 trace 不完整 |
| `eval.run.started` / `eval.run.completed` | evals 插件 → 观测 | eval 运行与计数 |

插件可自定义任意 `<domain>.*` 事件名，无需改 core。

**思维链不进入事件流**：`llm.request` 的 messages 与 `context.changed` 的 message 在发布前剔除
`reasoning_content`（ADR-038）；`WorkingContext` 的持久化记录仍保留该字段，供下一轮请求回传。

## 三种机制的边界（防混用）

| 机制 | 职责 | 例子 | 混用的后果 |
|---|---|---|---|
| **直接调用** | core 内部 / 关键路径（必须可靠、有序、单消费者） | `context.add`、`provider.chat`、`pluginHost.getTool` | 把协作直接调用 → 耦合 |
| **事件流** | 跨组件异步沟通（可丢失、多消费者、要解耦） | runtime→观测、工具↔TUI | 把内部调用事件化 → 关键路径不可靠 |
| **Hook / Guardrail** | 同步生命周期拦截（阶段检查） | `BeforeLlm`、`ToolCall` guardrail | 用事件流实现拦截 → 竞态 |

**交互暂停的形态**：工具 `publish` 一个请求事件 → `await events.waitFor(回复事件, { requestId, timeout })`
→ 拿到答案继续。loop 不需要任何暂停 / 恢复机制——handler 本身就在 await。

## ask 题级协议（一等公民，只加字段）

`ask.user.requested` 的每道题带 `id`（`q1`/`q2`/…，由工具按题序写；旧事件没有该字段时读侧按
「下标 + 1」推出同一个值），所以「第 3 题答了没有」在协议里可判定。答案行增 `question_id` 与
`selected?: string[]`（多选的结构化选中项；`answer` 仍是给模型读的那段文本，模型侧零影响）。

`ask.user.answered` 增三个可选键，缺省即旧语义（一条事件 = 整条请求答完）：

| 键 | 含义 |
|---|---|
| `answers[].question_id` / `selected` | 这一行挂在哪道题上 / 多选选中项 |
| `final?: boolean` | 这条请求是否**全部**题都答完了（缺省 `true`） |
| `remaining?: string[]` | 仍未答的题 id，只在 `final === false` 时有意义 |
| `batch_id?: string` | 这次答案属于待批页的哪一次提交（与 `ask.respond` 的同名参数一致） |

由此三件事同时成立：**一次提交只落已答的那几题**（未答的题留在 `pending`，靠记录上的
`answered_questions` 记住进度，不新增状态档）；**同一题不得答两次**（重复提交回 `duplicate` +
`skipped_questions`）；**首批答案到达即返回**——ask 工具只 `waitFor` 一次，未答的题写进工具结果
正文，后续批次由装配层作为**一条** inbox 消息（来源 `ask`）补投给成员并起新 run。`ask.respond`
的返回体相应增 `answered_questions` / `remaining_questions` / `skipped_questions` / `final`
（全部可选，旧客户端不看即旧行为），`interactions.list` 的 ask 条目带 `answered_questions`，
`answer.batch_answers` 是「本批新增的答案」（投放正文只取这一批，累计全集仍在 `answer.answers`）。