---
title: Host 与 Scheduler
kind: current
triggers: [host, runtime host, scheduler, concurrency, serial, resume, snapshot, checkpoint, cancel, agent run, per-run session]
paths: [packages/core/src/kernel/**, packages/core/src/runtime/**]
---

# Host 与 Scheduler

> 多 agent 执行面：`RuntimeHost` 在同一个 core 内核之上调度多个 `AgentRuntime`。Host 不知道 member / owner / visibility；成员能力层见 [member-team.md](member-team.md)。单 run 外壳见 [runtime-lifecycle.md](runtime-lifecycle.md#run)。

<a id="host"></a>

## 定位

- `packages/core/src/kernel/runtime-host.ts` 提供 `RuntimeHost` / `AgentHandle`；`scheduler.ts` 提供 `Scheduler` 与 `ScheduledTask`。Host 负责 run 的排队、取消、resume 与可序列化视图，不复制 `toolCallingLoop`（ADR-081）。
- 执行事实仍在成员 `AgentRuntime`：Host 只镜像事件与状态，不写第二套终态持久化路径。

<a id="run-binding"></a>

## per-run session 与取消

- `RunOptions.sessionId` 是 additive 字段，由 `AgentHandle.run` 消费，覆盖成员默认 session；`ScheduledTask.sessionId` 仍可被自定义 Scheduler 改写。单 agent 的 `AgentRuntime.run(input, sessionId, opts)` 继续以显式参数为准，不读该字段（避免双来源）。
- 取消链路：`AgentHandle.cancel(runId?, reason?: RunInterruptReason)` → `RuntimeHost.cancel(id, runId?, reason?)` → 成员 `AbortSignal.reason`。`agent.run.cancelled` 只在 reason 是字符串时写 `reason`。
- reason 语义沿用 run 生命周期：`shutdown` / `timeout` 落 interrupted checkpoint，`user` 或未传落 cancelled。

<a id="resume"></a>

## resume 必经 Scheduler

- `Host.resume(runId, opts?)` 构造 `ScheduledTask`，用 `ScheduledTask.runId` 固定 run id，再 `scheduler.submit`。因此 resume 受 `maxConcurrency` 与 `perAgentSerial` 约束，并占用成员串行位。
- `opts.signal` 可取消排队或运行；`resuming` 集合在 submit 失败、队列取消与 handle 结算时释放；重复 run id 的 submit 被拒绝。
- 不要绕过 Scheduler 直接调用成员 runtime resume——那会让并发上限与串行语义失效。

<a id="snapshot"></a>

## 可序列化快照

- `RuntimeHost.snapshot?()` 返回 `HostSnapshot`：纯 JSON 的 `asOf` / `agents` / `runs` / `scheduler`，不含函数、Runtime 实例或事件流引用。
- `Scheduler.snapshot?()` 是可选能力；自定义 Scheduler 未实现时，Host 降级为成员 active run 摘要，不抛错。
- 快照只读：不持久化、不从快照恢复、不是控制面 RPC，也不新增 canonical 方法。

<a id="events"></a>

## 事件与配置透传

- Host 合成的 `agent.run.*` 事件带 `mirror_of_run_id`，值是被镜像的具体 run id；用于把 Host 视角与成员 runtime 事件对齐。
- `RuntimeOptions` 的 `pluginConfigs` / `logger` / `includeReasoning` 原样透传给成员 runtime；Host 不做成员级覆盖。
- 工具展示元数据 `ToolDefinition.display` 由 `PluginHost.listTools()` 透出，不进入 LLM schema（见 [tools.md](tools.md#tool-definition)）。

## 约束

- 同一个 `AgentRuntime` 同时只允许一个 active run；第二个 run 抛 `run_already_running`，Host 也不得为同一成员并发起 run。
- 中断必须带原因（`interrupt('shutdown'|'timeout'|'user')`），不得只 abort signal。
- checkpoint / run store 写入仍走单一 `RunStore`；Host 成员优先、单 agent runtime 其次，不得双写。
- 不在 Host 里新增权限、tool pipeline 或 context 逻辑；这些属于 core 的单 run 路径。

## 指针

- [runtime-lifecycle.md](runtime-lifecycle.md#run) · [runtime-api.md](runtime-api.md#agent-runtime) · [state.md](state.md#run-store) · [assembly.md](assembly.md#assembly)
- 决策：[ADR-081](../adr/ADR-081-host-parity-and-serializable-snapshot.md) · [ADR-033](../adr/ADR-033-dependency-injection-and-orchestration.md) · [ADR-040](../adr/ADR-040-durable-run-store-checkpoint-resume.md) · [ADR-054](../adr/ADR-054-run-execution-and-failure-isolation.md)
