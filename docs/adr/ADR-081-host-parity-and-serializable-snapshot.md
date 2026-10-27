---
adr: 81
title: Host 对等与可序列化快照
status: accepted
date: 2026-10-21
related: [26, 37, 40, 52, 54, 58]
tags: [runtime, host, scheduler, resume, snapshot, tools, display]
---

## ADR-081：Host 对等与可序列化快照

- **上下文**：多 agent Host 与单 agent `AgentRuntime` 在 0.14 前仍不对等：Host 成员只能使用构造期的默认 session，无法按 run 切换；`AgentHandle.cancel` 丢失 0.13 引入的 `RunInterruptReason`，`agent.run.cancelled` 没有原因；`Host.resume` 绕过 Scheduler 直接执行，不受 `maxConcurrency` / `perAgentSerial` 约束，也不占用成员串行位；Host 不向成员透传 `pluginConfigs` / `logger` / `includeReasoning`；外部无法在不读私有状态的情况下取得 agent / run / 队列的可序列化视图；Host 合成的 `agent.run.*` 事件与成员 runtime 的具体事件无法对应；`ToolDefinition` 没有展示元数据，UI 只能按工具名做启发式。

- **决策**：
  1. **per-run session**：`RunOptions.sessionId`（additive）由 `AgentHandle.run` 消费，覆盖成员默认 session；`ScheduledTask.sessionId` 仍可被自定义 Scheduler 改写。单 agent 的 `AgentRuntime.run(input, sessionId, opts)` 继续以显式参数为准，不读该字段，避免双来源。
  2. **取消原因透传**：`AgentHandle.cancel(runId?, reason?: RunInterruptReason)` 与 `RuntimeHost.cancel(id, runId?, reason?)`；reason 经 `AbortSignal.reason` 传给成员 runtime，`agent.run.cancelled` 仅当 reason 是字符串时写入 `reason`。语义沿用 0.13：`shutdown` / `timeout` → interrupted checkpoint，`user` 或未传 → cancelled。
  3. **resume 经 Scheduler**：`Host.resume(runId, opts?)` 构造 `ScheduledTask`，用 `ScheduledTask.runId` 固定 run id，经 `scheduler.submit` 排队，因此受并发上限与成员串行约束；`opts.signal` 可取消排队或运行。`resuming` 集合在 submit 失败、队列取消与 handle 结算时释放；重复 run id 的 submit 被拒绝。
  4. **可序列化快照**：新增 `HostSnapshot` / `AgentSnapshot` / `RunSnapshot` / `SchedulerSnapshot`，`RuntimeHost.snapshot?()` 返回纯 JSON（`asOf`、agents、runs、scheduler）。`Scheduler.snapshot?()` 为可选；自定义 Scheduler 未实现时，Host 降级为成员 active run 摘要，不抛错。
  5. **Host 配置透传**：`RuntimeOptions` 新增 `pluginConfigs` / `logger` / `includeReasoning`，创建成员 runtime 时原样透传。
  6. **合成事件可追溯**：Host 发布的 `agent.run.*` 事件带 `mirror_of_run_id`，值等于被镜像的具体 run id；用于把 Host 视角与成员 runtime 事件对齐。
  7. **工具展示元数据**：`ToolDefinition.display?: { label?: string; kind?: 'command'|'file'|'search'|'generic' }`（additive）。`PluginHost.listTools()` 原样透出；不进入 LLM 工具 schema，不参与权限或执行判定；未知 `kind` 由消费方按 `generic` 处理。

- **冻结契约**：
  - `RunOptions.sessionId`、`ScheduledTask.runId`、三个 `cancel` 参数、`RuntimeOptions` 三个透传字段、`mirror_of_run_id` 均为 additive，可省略。
  - `HostSnapshot` 字段名与嵌套结构固定；所有值必须是 JSON 可序列化类型，不含函数、Runtime 实例或事件流引用。
  - `Scheduler.snapshot` / `RuntimeHost.snapshot` / `RuntimeHost.resume` 保持可选，不破坏第三方实现。
  - `ToolDisplay` 的 `kind` 枚举固定；`display` 不进入 LLM schema。

- **非目标**：不做快照持久化、从快照恢复或跨进程迁移；快照不是控制面 RPC，不新增 canonical 方法；不做成员级 `pluginConfigs` 覆盖（Host 级统一透传）；不把 `display` 加入 `tools.list` / LLM schema（后续需要时单独发 addendum）；不改变 `agent.run.*` 既有字段。

- **验证**：`packages/core/__tests__/runtime-host.test.ts`（per-run session、cancel reason、resume 排队、透传、mirror 字段、snapshot）、`scheduler.test.ts`（固定 runId、队列快照）、`durable-host.test.ts`（resume 并发 / 串行约束）、`tool-display.test.ts`（listTools 透出、LLM schema 不含 display）；`bun run typecheck`、`bunx @biomejs/biome ci .`。

- **关联**：ADR-026（工具自描述）、ADR-037（模块化 runtime）、ADR-040（durable resume）、ADR-052（跨节点 team 调度）、ADR-054（RunExecution 与失败隔离）、ADR-058（统一工具执行管道）；`packages/core/src/kernel/runtime-host.ts`、`packages/core/src/kernel/scheduler.ts`、`packages/core/src/kernel/types.ts`、`packages/core/src/types/run.ts`、`packages/core/src/types/tool.ts`。

## Errata（0.27 统一 agent/body）

> 2026-10-26，只追加。上文正文保留当时结论；与 0.27 实现不一致处以本条为准，
> 当前模型见 [ADR-097](ADR-097-unified-agent-body-model.md)。

- per-run session 的消费者是 `admit` → `scheduler.submit` → `runtime.run(input, bodyId, opts)`；
  `RunOptions.sessionId` 语义不变（= body id），单 agent 的 `AgentRuntime.run` 仍以显式参数为准。
- 取消链路是 `runs.cancel(runId)` → `scheduler.cancel(runId, reason)` → `AbortSignal.reason`；
  reason 语义不变（`shutdown` / `timeout` → interrupted checkpoint，`user` → cancelled），
  执行面主语是 Scheduler 与 body。
- 可序列化视图在 `Scheduler.snapshot?()`（`RunSnapshot`：`runId` / `agentId` / `sessionId` /
  `state` / `queuePosition`）与 `runs.list|get`；`HostSnapshot` / `AgentSnapshot` /
  `mirror_of_run_id` 没有生产者。
- 决策 3 的结论继续有效：resume 受并发上限与 body 串行约束，执行者是 `AgentService.resume` +
  tenant Scheduler。
