---
title: Tool-Calling Loop
kind: current
triggers: [loop, tool call, iteration, guardrail, hook, tool_calls, reasoning]
paths: [packages/core/src/runtime/**, packages/core/src/types/tool.ts]
---

# Tool-Calling Loop

<a id="loop"></a>

### `toolCallingLoop()`：循环骨架

签名 `toolCallingLoop(execution, signal)`；run id / session / usage 全部取自 `RunExecution`，不读实例字段。

```
loop:
    signal.aborted?                     → 抛错（Esc 中断）
    80% 预算预警（每 key 每 run 一次）  → 事件 + `vessel:limit` 尾部消息
    终止 / 用量上限检查（maxIterations / maxRuntimeSeconds / request / tool_calls / token / cost）
    autoCompactAsync                    → 压缩时设 PrefixGuard reason=compaction
    # system 冻结：hook 只读 hookCtx.systemPrompt；动态注入只走 hookCtx.messages
    # 旧 additionalContext 自动转 vessel:hook
    hookCtx = { run_id, session_id, systemPrompt: <会话基底> }
    await hooks.run(BeforeLlm, hookCtx)
    appendInjectedMessages(hookCtx.messages)   # 每 run 去重
    messages = buildRequestMessages(<会话基底>)
    # 归一化：丢弃孤儿 role:tool；残缺 tool_calls 降级；缺 system 时补回基底（ADR-035）
    tools = pluginHost.listTools()
    PrefixGuard.check({ system, tools, messages, reason? })
    # 非纯追加且无 reason → prompt.prefix_changed；STRICT 抛 PromptPrefixChangedError
    发 llm.request（messages 在发布前剥离 reasoning_content，ADR-038）
    response = provider.chat({ messages, tools, stream: true, on_chunk → 发 llm.stream.chunk })
    # response.reasoning_content（thinking 模型）由 Provider 累积；不进 on_chunk / 事件流
    累计 token 用量；context.updateRealTokens(本次 prompt_tokens + completion_tokens)
    发 llm.response
    await hooks.run(AfterLlm, hookCtx)
    if finish_reason == 'stop':
        应用 Output guardrail，被阻止 → 抛错
        finalContent = replacement 是字符串 ? replacement : response.content
        addContext(assistant 消息，内容为 finalContent，带上 response.reasoning_content)
        return finalContent

    if finish_reason == 'tool_calls':
        # 先对全部调用过 ToolCall guardrail（replacement 可改写），再写 assistant 消息，
        # 保证上下文里的 tool_calls 与后续 role:tool 结果严格配对
        effectiveCalls = []
        for toolCall of response.tool_calls:
            incrementToolCall()
            应用 ToolCall guardrail，被阻止 → 抛错
            effectiveCalls.push(replacement 是合法 ToolCall ? replacement : toolCall)
        addContext(assistant 消息，含 effectiveCalls 与 response.reasoning_content)

        for toolCall of effectiveCalls:
            发 tool.call.started
            # 参数只解析一次；失败按工具失败折回，不终止 run（ADR-035）
            try: args = JSON.parse(toolCall.function.arguments)
            catch: 发 tool.call.failed; addContext(role:tool, `Error: Invalid JSON...`); continue
            await hooks.run(BeforeTool, hookCtx)
            try:
                # 统一工具执行管道（0.8.2，ADR-058）：getTool → permission → handler → ToolResult guardrail。
                # 外层已处理 ToolCall guardrail / BeforeTool / AfterTool，故在管道里关闭这三阶段。
                outcome = toolPipeline.execute({
                    runId, sessionId, toolCall, args, messages: context.messages, signal,
                    stages: { toolCallGuardrail: false, beforeToolHook: false, afterToolHook: false },
                })
                outcome.ok == false → 抛错（工具不存在 / 权限拒绝 / handler 超时 / 结果被阻断）
                finalResult = outcome.content
                发 tool.call.completed
                await hooks.run(AfterTool, hookCtx)
                addContext({ role: 'tool', tool_call_id, content: finalResult })
            catch error:
                OnError hooks（best-effort；HookRunner 已隔离，抛错只发 hook.error）
                发 tool.call.failed
                addContext({ role: 'tool', tool_call_id, content: `Error: ${msg}` })
                # 工具失败不中断循环——错误文本折回语言空间，模型自行决定下一步

        # 一轮 tool-call 全部处理完：写 checkpoint（durable 开启时；发 run.checkpoint）
        writeCheckpoint(execution, 'running')

    else:  # 例如 finish_reason == 'length'
        addContext(assistant 消息，带上 response.reasoning_content)
        return response.content
```
<a id="constraints"></a>

### 关键约束

- **工具只能从 `PluginHost` 拿。** 循环里没有第二张表。装配层要么在 `plugins` 里传 Plugin（插件 `install` 时 `registerTool`），要么直接注入 `pluginHost`。
- **工具调用统一走 `ToolPipeline`**（ADR-058）：`AgentRuntime` 与 delegate 共用同一阶段顺序；handler 只由管道调用，由它套 `tool.timeout` 与 `ctx.signal`——handler 直调会让 `timeout` 与权限判定失效。权限判定发生在 ToolCall guardrail / BeforeTool 的改写之后，针对最终工具与参数。
- **工具失败不终止 run**。错误变成 `role: tool` 消息回到上下文，模型自己纠。非法 tool arguments JSON 也走这条路径（解析一次、发 `tool.call.failed`、折回错误文本）。
- **发给 Provider 的消息始终是合法序列**：`buildRequestMessages` 在输出前丢弃孤儿 `role: tool`、把不完整 `tool_calls` 轮次降级为普通 assistant 文本，并在上下文缺 system 时补回基底 `systemPrompt`。归一化只影响本次请求，不改 `ContextManager` 的持久化记录。
- **Guardrail `replacement` 四阶段生效**：Input（改写持久化的用户消息）、Output（改写返回值与持久化 assistant 消息）、ToolCall（改写实际执行的调用，先于 assistant 消息写入）、ToolResult（改写事件、上下文与返回值）；非法类型按未改写处理。
- **thinking 模型的 `reasoning_content`**：Provider 返回后保存在 assistant 消息并随下一轮请求回传（含 `tool_calls` 轮次）；`llm.request` / `context.changed` 事件在发布前剥离该字段，TUI / 观测 / 回放看不到思维链，会话持久化保留（ADR-038）。
- **权限是执行期判定，不是注册期过滤**：`checkPermission` 返回 `'allow' | 'deny' | 'ask'`；`'ask'` 走事件流等用户决定（`tool.permission.request` → `waitFor('tool.permission.response')`，默认不超时，只有显式正数 `timeoutMs` 才超时）。未声明 `checkPermission` 的工具走 `RuntimePermissionConfig` 默认策略（库默认 `'allow'`，交互模式由装配层传 `'ask'`）。
- **Hook 注入只允许追加**：`Hook.run` 可返回 `HookResult`（`block` / `updatedInput`）；`additionalContext` 已弃用，动态上下文统一写 `HookContext.messages`。`systemPrompt` 只读，写入被忽略。
- **durable checkpoint 只由 `AgentRuntime` 写**（唯一写者）。Host 模式把 Host 的 `runStore` 注入成员 runtime；同时给 Host 与 runtime 两个 store 时 Host 优先，禁止双写（ADR-040）。
- **单 run 守卫与唯一终态路径**见 [runtime-lifecycle.md](runtime-lifecycle.md#run) 与 [#finalize](runtime-lifecycle.md#finalize)：`activeRun` 在 await 前同步占位，第二个 run 抛 `run_already_running`；终态只经 `finalizeRun`。
- **插件故障隔离**（ADR-054）：单个 Hook 抛错发 `hook.failed` + `hook.error` 并继续后续 hook；`OnError` 始终 best-effort；Guardrail 的 `check()` 抛错按 fail-closed 处理（`allowed:false` + `reason: 'guardrail_error'`，发 `guardrail.error`），不把原始异常冒泡成 run 失败。

