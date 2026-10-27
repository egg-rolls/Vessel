---
title: Scheduler 与执行面
kind: current
triggers: [host, scheduler, concurrency, serial, resume, snapshot, checkpoint, cancel, agent run, body serial, queue]
paths: [packages/core/src/kernel/**, packages/core/src/runtime/**]
---

# Scheduler 与执行面

> 执行面只有一层：每个 tenant 一个 `InProcessScheduler`，所有 agent / body 的 run 都经它排队。Scheduler 不知道 member / owner / visibility；成员能力层见 [member-team.md](member-team.md)。单 run 外壳见 [runtime-lifecycle.md](runtime-lifecycle.md#run)。

<a id="host"></a>

## 定位

- `packages/core/src/kernel/scheduler.ts` 提供 `Scheduler` / `ScheduledTask` / `InProcessScheduler`。装配层每 tenant 构造一个实例并注入 `AgentService`；run 路径上没有第二层执行壳（ADR-081 / ADR-097）。
- 执行事实在每 body 的 `AgentRuntime`：Scheduler 只负责排队、并发、取消与只读视图，不复制 `toolCallingLoop`，也不写第二套终态持久化路径。
- 入队形态固定：`admit` 组一个 `ScheduledTask`，`serialKey` 必填且等于 body / session id，`executor` 收到 runId 后调用该 body 的 `runtime.run`。

<a id="run-binding"></a>

## 串行键与取消

- `serialKey` 是唯一串行维度：`perBodySerial`（默认 true）保证同一 body 同时最多一个 running，不同 body 可并发。`ScheduledTask.sessionId` 与该 body 相同，`RunOptions.sessionId` 语义不变（= body id）；单 agent 的 `AgentRuntime.run(input, sessionId, opts)` 仍以显式参数为准，不读该字段（避免双来源）。
- 取消链路：`runs.cancel(runId)` → `scheduler.cancel(runId, reason?)` → 该 run 的 `AbortSignal.reason`；queued 取消由控制面补一条 `cancelled` checkpoint，running 取消由 `finalizeRun` 收口。
- reason 语义沿用 run 生命周期：`shutdown` / `timeout` 落 interrupted checkpoint，`user` 或未传落 cancelled。

<a id="resume"></a>

## resume 必经 Scheduler

- resume 没有旁路：`AgentService.resume(runId)` 加载 checkpoint → 解析 agent / body → 确保 body → 用 `ScheduledTask.runId` 固定 run id 再 `scheduler.submit`。因此 resume 与首次执行受同一份并发上限与 body 串行约束。
- `opts.signal` 可取消排队或运行；同一 run id 不得同时排队 / 运行，重复 submit 被拒绝。
- 不要绕过 Scheduler 直接调用 body runtime 的 resume——那会让并发上限与串行语义失效。

<a id="snapshot"></a>

## 可序列化快照

- `Scheduler.snapshot?()` 返回 `SchedulerSnapshot`：纯 JSON 的 `asOf` / `queued` / `running` / `stats`，不含函数、Runtime 实例或事件流引用；`RunSnapshot` 带 `runId` / `agentId` / `sessionId`（body）/ `state` / `queuePosition` / `waitReason`。
- 快照是可选能力：自定义 Scheduler 未实现时，调用方（`runs.list` / `queue_position`）降级处理，不抛错。
- 快照只读：不持久化、不从快照恢复、不是控制面 RPC，也不新增 canonical 方法；durable 视图另由 `runStore` 提供。

<a id="events"></a>

## 事件与配置

- 队列事件是 `agent.queue.entered` / `agent.queue.left`，带 `agent_id` + `session_id`、队列位置与等待原因（`capacity` / `per_body_serial`）。
- `SchedulerOptions`：`maxConcurrency` 缺省无上限（只有显式正整数才限制）、`maxQueueSize` 默认 100、`perBodySerial` 默认 true。队列满时 `submit` 抛错，不静默丢任务；缺省项由 Scheduler 自己兜底，装配层不传 `0` / 负数。
- `AgentRuntimeOptions`（`pluginConfigs` / `logger` / `includeReasoning` 等）由装配层构造 body runtime 时传入，Scheduler 只排队任务、不做覆盖。工具展示元数据 `ToolDefinition.display` 由 `PluginHost.listTools()` 透出，不进入 LLM schema（见 [tools.md](tools.md#tool-definition)）。

## 约束

- 同一个 `AgentRuntime` 同时只允许一个 active run；第二个 run 抛 `run_already_running`。`serialKey` 保证 Scheduler 不会为同一 body 并发起 run。
- 中断必须带原因（`interrupt('shutdown'|'timeout'|'user')`），不得只 abort signal。
- checkpoint / run store 写入仍走单一 `RunStore`，写者是 body 的 `AgentRuntime`，不得双写。
- 不在 Scheduler 里新增权限、tool pipeline 或 context 逻辑；这些属于 core 的单 run 路径。

## 指针

- [runtime-lifecycle.md](runtime-lifecycle.md#run) · [runtime-api.md](runtime-api.md#agent-runtime) · [state.md](state.md#run-store) · [assembly.md](assembly.md#assembly)
- 决策：[ADR-081](../adr/ADR-081-host-parity-and-serializable-snapshot.md) · [ADR-097](../adr/ADR-097-unified-agent-body-model.md) · [ADR-040](../adr/ADR-040-durable-run-store-checkpoint-resume.md) · [ADR-054](../adr/ADR-054-run-execution-and-failure-isolation.md)
