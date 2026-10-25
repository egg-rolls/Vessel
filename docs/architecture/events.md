---
title: 事件系统
kind: current
triggers: [event, event stream, trace, replay, observability, seq, redaction]
paths: [packages/core/src/types/event.ts, packages/core/src/events/**, src/trace-wiring.ts, src/observability-wiring.ts]
---

# 事件系统

<a id="events"></a>

## 事件系统

事件流是**跨组件的唯一异步沟通总线**：runtime → 观测（TUI / 日志 / 审计 / 回放）、工具 ↔ TUI（权限确认、ask_user 交互暂停）。

### 命名约定

**事件名一律是开放字符串字面量**（ADR-030）：不定义 `EventType` / `PermissionEvent` 之类常量，生产者和消费者直接写字符串。**命名空间 `<domain>.<action>.<event>`**，防撞名。

- 加新事件 = 写字面量，零 import、零 core 变更。
- 代价：没有编译期拼写检查，靠命名空间约定 + 集成测试兜底（断言"发布 X 后订阅者收到"）。

<a id="event-names"></a>

### 核心事件名

| 事件名 | payload | 发布方 |
|---|---|---|
| `run.started` | `RunStartedPayload` | agent-runtime |
| `llm.request` | `LlmRequestPayload` | agent-runtime |
| `llm.response` | `LlmResponsePayload` | agent-runtime |
| `llm.stream.chunk` | `LlmStreamChunkPayload` | agent-runtime |
| `tool.call.started` | `ToolCallStartedPayload` | agent-runtime |
| `tool.call.completed` | `ToolCallCompletedPayload` | agent-runtime |
| `tool.call.failed` | `ToolCallFailedPayload` | agent-runtime |
| `guardrail.blocked` | `GuardrailBlockedPayload` | guardrail-runner |
| `guardrail.error` | `{ run_id, guardrail_name, stage, error }` | guardrail-runner（0.8：`check()` 抛错，随后按 `guardrail_error` blocked） |
| `hook.failed` / `hook.error` | `{ hook_name, hook_type, run_id, duration_ms, error }` | hook-runner（0.8：单 hook 抛错后继续后续 hook） |
| `context.changed` | `{ run_id, message, message_count, token_count }` | agent-runtime |
| `run.completed` | `RunCompletedPayload` | agent-runtime |
| `run.failed` | `RunFailedPayload` | agent-runtime |
| `run.cancelled` | `RunCancelledPayload` | agent-runtime（0.5：仅显式用户取消；Host 中断仍发 `run.failed`） |
| `replay.started` | `{ run_id, event_count }` | replayRun |
| `replay.completed` | `{ run_id, event_count, duration_ms }` | replayRun |
| `run.checkpoint` | `{ run_id, session_id, status, iteration? }` | agent-runtime |
| `run.resumed` | `{ run_id, session_id, from_status, iteration }` | agent-runtime |
| `run.finalize.failed` | `{ run_id, session_id, error }` | agent-runtime（0.8：终态持久化失败，保留原始 run 错误） |

**约定事件名**（不在 `EventPayload` 联合类型里，按开放字符串协议使用）：

| 事件名 | 方向 | 用途 |
|---|---|---|
| `tool.permission.request` / `tool.permission.response` | 工具 → TUI → 工具 | 执行期权限确认（0.13 起默认不超时） |
| `ask.user.requested` / `ask.user.answered` | 工具 → TUI → 工具 | ask_user 交互暂停 |
| `mcp.server.connected` / `mcp.server.failed` / `mcp.server.disconnected` | MCP 插件 → 观测 | server 生命周期（失败隔离） |
| `mcp.tool.called` / `mcp.tool.failed` | MCP 插件 → 观测 | MCP 工具调用 |
| `channel.feishu.connected` / `channel.feishu.disconnected` / `channel.feishu.message.received` / `channel.feishu.reply.sent` / `channel.feishu.error` | 飞书插件 → 观测 | 渠道生命周期与消息 |
| `session.saved` / `session.deleted` | core → 观测 | 会话持久化（0.5） |
| `config.loaded` | asm → 观测 | 只记来源与键名，不记密钥值（0.5） |
| `plugin.loaded` / `plugin.failed` | asm / core → 观测 | 插件加载（0.5） |
| `trace.write.failed` / `trace.overflow` | core trace → 观测 | 写失败/队列溢出，标记 trace 不完整（0.5） |
| `eval.run.started` / `eval.run.completed` | evals 插件 → 观测 | eval 运行与计数（0.5，含 `tenant_id`） |

插件可自定义任意 `<domain>.*` 事件名，无需改 core。

**思维链不进入事件流**：`llm.request` 的 messages 与 `context.changed` 的 message 在发布前剔除 `reasoning_content`（ADR-038）；`ContextManager` 的持久化记录仍保留该字段，供下一轮请求回传。

### 三种机制的边界（防混用）

| 机制 | 职责 | 例子 | 混用的后果 |
|---|---|---|---|
| **直接调用** | core 内部 / 关键路径（必须可靠、有序、单消费者） | `context.add`、`provider.chat`、`pluginHost.getTool` | 把协作直接调用 → 耦合 |
| **事件流** | 跨组件异步沟通（可丢失、多消费者、要解耦） | runtime→观测、工具↔TUI | 把内部调用事件化 → 关键路径不可靠 |
| **Hook / Guardrail** | 同步生命周期拦截（阶段检查） | `BeforeLlm`、`ToolCall` guardrail | 用事件流实现拦截 → 竞态 |

**交互暂停的形态**：工具 `publish` 一个请求事件 → `await events.waitFor(回复事件, { requestId, timeout })` → 拿到答案继续。loop 不需要任何暂停/恢复机制——handler 本身就在 await。

### 事件回放

`MemoryEventStream` 之外，core 提供 `FileEventStore`（JSONL 一行一事件：`append` / `readRun` / `listRunIds` / `deleteRun`）与 `replayRun(store, runId, eventStream, { delayMs })`。回放经同一个 `publish()` 重新发布历史事件（保留原始 `ts`），订阅者用同一个 `subscribe()` 接收 live 与 replay，靠 `replay.started` / `replay.completed` 区分边界。

<a id="trace"></a>

### trace 落盘

`RunEvent` 增加可选 `seq?` 与 `tenant_id?`；缺失 `tenant_id` 视为 `default`。`TraceRecorder` port 由 asm 接线，默认 `FileTraceRecorder` 把每个 run 写成 `<data_dir>/tenants/<tenant_id>/events/<run_id>.jsonl`（append-only，一行一事件）。

- **seq**：由 recorder 落盘时分配，以文件尾部最大 seq 为种子；内存实时事件允许无 seq，消费方按 `(seq ?? ts)` 回退。`events.list` 返回 trace seq；gateway 的 `events.subscribe.since` 是 wire seq，二者分层。
- **级别**：`full` 保留完整 payload；`metadata` 只留信封与白名单字段（`status` / `tool_name` / `duration_ms` / `iterations` / `iteration` / `message_count` / `finish_reason` / `usage.*`），`error` 截断 ≤500、`reason` ≤200；`off` 不落盘。
- **留存**：缺省 30 天 / 1000 runs / 1 GiB（每 tenant）；`vessel trace prune` 或启动时执行，不删除 `running` / `interrupted` run。
- **失败与溢出**：写失败发 `trace.write.failed` 并计数，不向事件投递路径抛错；每 run 队列上限 10000，溢出丢新事件并写一行 `trace.overflow { dropped }`，同一 run 最多一次 `trace.write.failed { reason: 'queue_overflow' }`。
- **脱敏**：trace 写入前与 gateway 出站前都过 `TraceRedactor`；默认按键名与 `sk-` 前缀替换，`app_id` 只留前 4 位 + `***`。0.5 **不**对 run checkpoint、eval 报告、飞书回复脱敏（resume / 展示需要完整内容）；POSIX 下 0600 best-effort。
- **读取与重建**：`readTraceEvents(traceDir, filter)` 默认 limit 50、最大 500，按 `(seq ?? ts)` 升序，跳过损坏行；`rebuildMetrics(traceDir)` 返回与实时 `MetricsSnapshot` 同形状，`updated_at = max(ts)`。
- **取消**：显式用户取消只发 `run.cancelled`，不再同时发 `run.failed`；Host 关闭/中断仍发 `run.failed`。0.8 起 `run()` 与 `resume()` 共用 `finalizeRun`，resume 的用户取消同样发 `run.cancelled`（ADR-054）。因此 `metrics.runs.cancelled` 在 0.5+ 可能非 0。
- **事件归属**：core 发 `session.saved/deleted`、`hook.*`、`run.cancelled`、`installPlugin` 的 `plugin.*`；asm 发 `config.loaded` 与 `PluginLoader` 的 `plugin.loaded/failed`；ext 发 `eval.*` / `feishu.*` / `mcp.*` / `subagent.*`。

