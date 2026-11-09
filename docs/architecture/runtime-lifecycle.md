---
title: Run 生命周期
kind: current
triggers: [run, resume, finalize, execution, checkpoint, cancel, active run, run_already_running, lease, fencing, execution unit lifecycle]
paths: [packages/core/src/runtime/**, packages/core/src/types/run.ts]
---

# Run 生命周期
> Stage 4 已落地：`Runtime`（per-node 无状态工厂）→ `ExecutionUnit`（per-session）→ `Run`（瞬时）→ `ToolCallingLoop`。目标模型见 [0.34-target.md](0.34-target.md)，决策见 [ADR-098](../adr/ADR-098-terminology-and-layering-agent-session-runtime-loop-run.md)（accepted；tenant 部分已被 ADR-100/T0–T5 取代）。

<a id="run"></a>

## Runtime 与 Run 外壳

- `Runtime`（`packages/core/src/runtime/runtime.ts`）是每 node 一个的无状态工厂：只持有装配期注册的单 node profile 与 `(内部单 id, sessionId)` ExecutionUnit 目录，不持 Session / Run / WorkingContext / lease / RunRecordStore。
- `ExecutionUnit` 是 **per-session** 的长活执行单元：持 Session 引用、只读 EventLog、两级 lease、`activeRun` 与 abort。主执行面与成员两条路径都经 `Runtime.getOrCreateExecutionUnit` 取得 EU；同 `(内部单 id, sessionId)` 返回同一对象，`agentId` 不一致时抛 `execution_unit_binding_conflict`。
- `ExecutionUnit`（`packages/core/src/runtime/execution-unit.ts`）是唯一的循环实现。编排细节外推给了三个 runner：`PermissionPolicy`（权限）、`GuardrailRunner`（四阶段 guardrail）、`HookRunner`（五阶段 hook）——`ExecutionUnit` 只做协调。

### `run()`：一次请求的外壳

```
run(input, sessionId?, opts?):
    runId = opts?.runId ?? uuid()
    execution = beginExecution(runId, sessionId)   # run 级状态 + 同步占位
        # 已有 active run → 立即抛 run_already_running（RunAlreadyRunningError）
        # 占位发生在任何 await 之前；finally 里 endExecution 释放
        # Run 在此时经 contextFactory 新建自己的 WorkingContext（per-Run，不复用上一 Run 对象）

    # 从 SessionState 快照 + 事件日志增量播种本 Run 的窗口
    从 session.load(sessionId) 恢复历史 → addContext 每条
    若没恢复出历史且有 systemPrompt → addContext(system 消息)

    runState = { run_id, session_id, messages: [userMessage], status: 'running', branch }
    发 run.started

    try:
        # 本轮前置注入（见 runtime-api.md 的消息组装）：core 不解释语义，先于用户输入写入并持久化
        for msg of opts.messages ?? []:
            addContext(msg)              # 注入在前

        # Input guardrail 先于写用户消息：replacement 要成为持久化的用户消息（ADR-035）
        inputResult = 应用 Input guardrail
        被阻止 → 抛错（已写入的注入消息保留）
        effectiveUser = replacement 是字符串 ? 改写后的 userMessage : userMessage
        addContext(effectiveUser)        # 用户输入在后

        # 初始状态保存真实上下文（恢复历史 + 注入 + 用户输入），运行中崩溃不丢历史
        runState.messages = run.workingContext.messages
        journal.saveSessionState(runState)        # RunJournal 是唯一持久化写者
        journal.saveCheckpoint(runRecord)          # durable 开启时；发 run.checkpoint

        output = await toolCallingLoop(execution, signal)
        await finalizeRun(execution, runState, { status: 'completed', output })
        return output
    catch error:
        await finalizeRun(execution, runState, { status: 'failed', error, signal })
        throw

# run() / resumeRun() / resumeSession() 共用的唯一终态路径
finalizeRun(run, sessionState, outcome):
    if outcome.status == 'completed':
        journal.saveCheckpoint(runRecord, 'completed') → journal.saveSessionState(sessionState) → 发 run.completed
        return

    # 失败 / 取消 / 中断
    cancelled = signal 已 abort 且 reason 不属于 Host 中断集合
    sessionState.status = cancelled ? 'cancelled' : 'failed'
    sessionState.messages = run.workingContext.messages  # 失败也保存真实上下文，不覆盖历史
    OnError hook（best-effort；自己抛错只发 hook.error，不替换原始错误）
    journal.saveCheckpoint(runRecord, failed | cancelled | interrupted) → journal.saveSessionState(sessionState)
    发 run.cancelled（用户取消）或 run.failed（Host 中断 / 普通错误）
    # finalizeRun 自身失败（如磁盘写失败）→ 发 run.finalize.failed，原错误继续上抛
```

<a id="finalize"></a>

`resumeRun(record)` / `resumeSession()` 走同一条 `finalizeRun` 路径，因此用户取消同样发 `run.cancelled`，RunRecord 状态同样按 abort reason 映射为 `cancelled` / `interrupted`。`Run` 是 run 级瞬时状态的唯一来源（run id / session / branch / 计时 / usage / workingContext），可恢复进度在 `RunRecord`，见 [runtime-api.md](runtime-api.md#execution-unit)。

<a id="writer"></a>

## 写者（铁律 1）

- 事实事件、RunRecord checkpoint、SessionState 投影全部经 `RunJournal`（`packages/core/src/runtime/run-journal.ts`）。`ExecutionUnit` 只持只读 EventLog，不再直接 `eventLog.append` / `runStore.save` / `session.save`。
- 工厂由装配层按 node 构造（`createRunJournalFactory`，持有 `eventLog` / `session` / `runStore` / `fenceOf`），放进单 node profile 的 `journalFactory`；主 run 与成员 run 走同一条写路径。
- `RunJournal` 保留 `flush → cursor → saveCheckpoint` 顺序；fencing 校验只读 `fenceOf` 回调，Run 不持 `LeaseService`。
- `/compact` 等无 active Run 的写走 transient journal（`run_id='manual'`）；插件生命周期事件走 `run_id='plugin'`，均不在 Run 事实内。

<a id="lease"></a>

## ExecutionUnit 与两级租约（0.34）

- 每个需要执行的 body 持有两级租约：先获取 **binding lease**（同一 Agent binding 的排他写者），再获取 **session lease**（同一 Session 的排他写者）。释放顺序相反：先 session、后 binding。
- 租约由 `LeaseServicePort` 提供 `LeaseGrant`（lease id / fencing token / `expires_at`）。续租间隔 `lease.renewMs`、TTL `lease.ttlMs`（默认 10000 / 30000，见 [CONFIG](../operations/CONFIG.md)）；进程退出或 dispose 时停止续租。
- **fencing**：每次获取新租约 token 单调递增；ExecutionUnit 写 SessionEventLog / RunRecord 时携带 `fencing_token`，旧 token 的写入被拒绝（`stale_fence`）。读路径不带租约。
- **过期与接管**：持有者崩溃后租约在 TTL 后过期，下一个 ExecutionUnit 可获取更高 fence 的租约并接管同一 Session；旧 holder 若恢复，其写入因 fence 过期被拒。
- dispose 必须释放两级租约并清除续租定时器；不得残留租约文件或活跃定时器。

