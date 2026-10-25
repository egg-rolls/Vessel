---
title: Run 生命周期
kind: current
triggers: [run, resume, finalize, execution, checkpoint, cancel, active run, run_already_running]
paths: [packages/core/src/runtime/**, packages/core/src/types/run.ts]
---

# Run 生命周期

<a id="run"></a>

## Run 外壳

`AgentRuntime`（`packages/core/src/runtime/agent-runtime.ts`）是唯一的循环实现。编排细节外推给了三个 runner：`PermissionPolicy`（权限）、`GuardrailRunner`（四阶段 guardrail）、`HookRunner`（五阶段 hook）——`AgentRuntime` 只做协调。

### `run()`：一次请求的外壳

```
run(input, sessionId?, opts?):
    runId = opts?.runId ?? uuid()
    execution = beginExecution(runId, sessionId)   # run 级状态 + 同步占位
        # 已有 active run → 立即抛 run_already_running（RunAlreadyRunningError）
        # 占位发生在任何 await 之前；finally 里 endExecution 释放
    context.setSessionId(sessionId)

    # 只在 context 为空时初始化（同会话续聊时不重置，多轮记忆靠这个）
    if context.messages 为空:
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
        runState.messages = context.messages
        session.save(runState)
        writeCheckpoint(runState, 'running')      # durable 开启时；发 run.checkpoint

        output = await toolCallingLoop(execution, signal)
        await finalizeRun(execution, runState, { status: 'completed', output })
        return output
    catch error:
        await finalizeRun(execution, runState, { status: 'failed', error, signal })
        throw

# run() 与 resume() 共用的唯一终态路径
finalizeRun(execution, runState, outcome):
    if outcome.status == 'completed':
        runState = completed + usage + messages
        session.save → writeCheckpoint('completed') → 发 run.completed
        return

    # 失败 / 取消 / 中断
    cancelled = signal 已 abort 且 reason 不属于 Host 中断集合
    runState.status = cancelled ? 'cancelled' : 'failed'
    runState.messages = context.messages       # 失败也保存真实上下文，不覆盖历史
    OnError hook（best-effort；自己抛错只发 hook.error，不替换原始错误）
    session.save → writeCheckpoint(failed | cancelled | interrupted)
    发 run.cancelled（用户取消）或 run.failed（Host 中断 / 普通错误）
    # finalizeRun 自身失败（如磁盘写失败）→ 发 run.finalize.failed，原错误继续上抛
```

<a id="finalize"></a>

`resume()` 走同一条 `finalizeRun` 路径，因此用户取消同样发 `run.cancelled`，checkpoint 状态同样按 abort reason 映射为 `cancelled` / `interrupted`。`RunExecution` 是 run 级状态的唯一来源（run id / session / branch / 计时 / usage / context），见 [runtime-api.md](runtime-api.md#agent-runtime)。

