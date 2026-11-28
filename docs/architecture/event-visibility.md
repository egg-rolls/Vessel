---
title: 事件可见性三档
kind: current
triggers: [event visibility, tier, content, internal, observe, 可见性, 三档, 默认隐藏, 折叠, 承接, 团队日志, 环境信息注入, event-visibility, 登记]
paths: [apps/web/src/state/event-visibility.ts, apps/web/src/state/error-visibility.ts]
---

# 事件可见性三档

> 事件命名与 payload 见 [event-catalog.md](event-catalog.md)；落盘口径见 [event-log-policy.md](event-log-policy.md)。

**判据只有一句：档位由内容性质决定，不由「默认想不想藏」决定。** 唯一真相源是
`apps/web/src/state/event-visibility.ts`（`EVENT_TIERS` + `EVENT_TIER_FAMILIES` +
`tierOf` / `eventSpecOf` / `isVisibleInChat`），不要在渲染层（`EventRow` / `StreamItems` /
`run-detail`）另写可见性判断。

| 档 | 含义 | 聊天时间线 | 团队日志 |
|---|---|---|---|
| `content` | 用户要读的对话内容（正文 / 工具 / 输入 / run 终态 / 真失败） | 恒可见 | 按 `teamLog` |
| `internal` | run 内部状态同步与过程信号（诊断、生命周期 notice） | 默认隐藏；`ui.showInternalEvents` 或 `verbosity: debug` 时可见（`ui.errorLevel: all` 另按旧语义放出 internal 级失败） | 按 `teamLog` |
| `observe` | 会话 / 成员元数据审计、交互卡与观察面诊断 | **恒不可见**（与开关无关，只在 Observe / Runs 看） | 按 `teamLog` |

## entry 级判据（载荷补类型）

档位表管「类型」，载荷谓词补「内容」：`message.injected` 本体仍 `internal`，但**带稳定
`message_id` 的 `vessel:*` 环境信息注入**（inbox 计数 / peer 状态 / PII 失效与容量 / 工具面 /
self-card / 来源行）经 `isEnvInjectionVisible` 统一恒可见，由 `buildLiveItems` 的
`injectedNoticeOfEvent` 投影成环境卡（与历史侧同一入口、按 id 让位不双出）。这是把消息 kind 层
（`ENV_MESSAGE_KINDS`）早已裁定的「环境信息恒可见」穿透到事件层：所有环境信息同级，不是
inbox/PII 的特例白名单。非 `vessel:*` 注入（skill / 附件等）与无 id 旧数据不放行。判据与
`transcript-items.ts#injectedNoticeOfEvent` 逐字同口径（闸门放行的每条都必须能投影成卡）。

## 三条硬约束

1. **未登记 ⇒ 按 `internal` 处理**，渲染成一条「未知事件类型 · 已折叠」notice（展开是原始载荷），
   **绝不落裸 JSON 卡**。这是对门禁管不到的边界（第三方插件 / 上游事件 / 旧 trace）的兜底。
2. **失败类永不进 `observe`**：任何集合都在 `ui.errorLevel` 之前过滤，塞进静默档等于静默真失败。
   `observe` 里出现 `isErrorEventType`，或 `run.` / `tool.` / `guardrail.` 前缀的失败类不是
   `content`，即违规。
3. **家族前缀必须显式登记**；不在表、也不在家族里的名字按未登记兜底。

`承接` 回答「这条事件藏掉之后，用户还能在哪看到它」：`notice` = typed notice 卡
（`EventRow.noticeView`）、`card` = 专用卡片 / 交互卡、`team-log` = 团队日志行、`dto` = 成员 /
插件页的 DTO、`raw-card` = 显式保留原始事件行（只有 `guardrail.blocked`）。`生产者` `legacy` =
本仓已无生产者、只读历史。**登记与文档-表一致性靠评审核对**（原 `check:event-visibility`
脚本已按宪法删除，见 [DOC-MANAGEMENT §3.4](../DOC-MANAGEMENT.md)）：新增事件先在
`EVENT_TIERS` 登记（`live: true`），再在下表写一行；键集与代码一一对应。

## 注册表（按 档 / 承接 / 团队日志 / 生产者 分组，键集与 `EVENT_TIERS` 一致）

| 档 | 承接 | 团队日志 | 生产者 | 事件名 |
|---|---|---|---|---|
| content | card | none | live | `run.started` `user.message` `prompt.system_context` `llm.stream.chunk` `tool.call.started` `tool.call.completed` `tool.call.failed` |
| content | card | reply | live | `run.completed` |
| content | card | system | live | `run.failed` `run.cancelled` |
| content | notice | none | live | `run.finalize.failed` `guardrail.error` `agent.limit.warning` `agent.reply.stale` |
| content | raw-card | none | live | `guardrail.blocked` |
| internal | — | none | live | `hook.failed` `hook.error` `llm.request` `llm.response` `llm.stream.summary` `llm.retry` `llm.empty_response` `run.checkpoint` `run.resumed` `context.changed` `message.injected` `message.compaction` `limit.blocked` `prompt.prefix_changed` `replay.started` `replay.completed` `session.saved` `session.log.failed` `process.error` `shutdown.failed` `trace.write.failed` `trace.overflow` `plugin.failed` `plugin.init.failed` `plugin.dispose.failed` `runtime.notice` `team.budget.warning` `team.budget.blocked` `team.budget.override` `agent.create.failed` `mcp.server.failed` `mcp.tool.failed` `channel.feishu.error` |
| internal | — | none | legacy | `error` |
| internal | notice | none | live | `hook.started` `hook.completed` `hook.system_prompt_ignored` `hook.additional_context_deprecated` `context.pressure` `context.compacted` `agent.retired` `agent.restarting` `agent.restarted` |
| internal | notice | none | legacy | `agent.compact_forked` |
| internal | — | none | legacy | `delegate.started` `delegate_task.started` `delegate.completed` `delegate.failed` |
| observe | card | none | live | `context.cleared_tool_result` `context.archive_notice` `runtime.notice.injected` `tool.permission.request` `tool.permission.response` `ask.user.requested` `ask.user.answered` `ask.user.timeout` |
| observe | card | none | legacy | `tool.permission.expired` |
| observe | — | none | live | `context.projection_applied` `context.projection_degraded` `context.projection_pressure` `timeline.gap_reported` `agent.rotate.approved` `agent.rotate.denied` `agent.permission.cancelled` `agent.message.queued` `agent.inbox.changed` `bash.job.started` `bash.job.completed` `bash.job.failed` `agent.stale` `agent.session.activated` `agent.queue.entered` `agent.queue.left` `session.created` `session.titled` `session.deleted` `config.loaded` `plugin.loaded` `plugin.changed` `update.available` `rpc.result_invalid` `federation.received` `federation.rejected` `mcp.server.connected` `mcp.server.disconnected` `mcp.resource.read` `mcp.tool.called` `mcp.warning` `channel.feishu.connected` `channel.feishu.disconnected` `channel.feishu.message.received` `channel.feishu.reply.sent` `eval.run.started` `eval.run.completed` |
| observe | — | none | legacy | `agent.message.notified` `agent.message.sent` `agent.permission.requested` `agent.permission.responded` `session.activated` `session.rewound` `session.forked` `guardrail.modified` |
| observe | dto | none | live | `agent.updated` `agent.role.changed` |
| observe | dto | system | live | `agent.rejoined` |
| observe | team-log | system | live | `agent.spawned` `agent.closed` |
| observe | team-log | system | legacy | `agent.forked` |

`delegate.*` / `delegate_task.*` 是 TUI 侧去掉 `subagent.` 前缀后的消费形态（线上名是
`subagent.delegate.*`，由家族覆盖），本仓没有独立生产者。

## 前缀家族（`EVENT_TIER_FAMILIES`，先匹配者胜）

`subagent.` → internal · `tool.call.` → content · `mcp.` → observe · `channel.feishu.` →
observe · `eval.run.` → observe · `pii.` → observe（PII 脱敏审计面，用户可见提示走
`vessel:notice` 上下文消息，不走事件渲染）。家族里的失败类若要进 `internal` 必须写显式条目
（条目优先于家族，如 `mcp.server.failed` / `channel.feishu.error`）。插件自定 `<domain>.*`
由各插件自己在 `EVENT_TIERS` 登记，不在这里开家族。

## rotate 死类型（只读历史）

`agent.rotating` / `agent.rotated` / `agent.rotate.failed` 是死类型（ADR-092 第 18 条要求过，
实现从未发出），已从表里删除。rotate 实际只发两条：旧 body 退役的 `agent.retired`（在 rotate
工具内、旧 run 未结束时即发）与新 primary 的 `agent.session.activated`（切换 + 快照之后发），
启动嘱托在其后 admit。自己交棒的那一轮正常记账、不再 fence；只有外部退役的迟到轮由
`agent.reply.stale{ reason: epoch_fenced }` 解释，交棒轮没有收尾时是 `reason: handoff_no_reply`。
详见 [ADR-092](../adr/ADR-092-agent-rotate-and-epoch-fencing.md) 文末 Errata。