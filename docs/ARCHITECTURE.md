# 技术架构

> 本文描述 Vessel 当前的架构事实。历史决策与「为什么」见 [ADR 索引](adr/README.md)。

---

## 1. 三层结构与依赖方向

> 本节描述**当前已实现**的结构；0.2 的 Kernel / Modules 分层（`Contracts ← Kernel ← Modules ← SDK ← Shells`）见 §14（已实现，未随版本发布），二者不混写。

```
apps/web                 网页控制台（v1；durable / MCP 面板）
    │
packages/serve           常驻服务 gateway（--serve；loopback / 远程 + TLS）
packages/tui             终端界面：Ink REPL、流式渲染、slash 命令、/mcp、/runs
    │
packages/config          声明式 YAML 配置：加载、校验（未知键报错）、snake_case→camelCase 映射
    │
packages/core            运行时：tool-calling loop、provider 抽象、context、session、事件流、
                         权限策略、guardrail/hook 编排、PluginHost、Kernel、RunStore
                         ← 零 UI 依赖，可独立嵌入
packages/permission      共享权限原语（工具经事件流等用户授权）
plugins/mcp/client       MCP client 插件（stdio + HTTP），经 PluginHost 注册工具
```

**依赖方向单向**：`core` 不引用 `config` / `tui` / `serve` / `plugins`，也直接不引用任何厂商 SDK。`core` 的 `dependencies` 为空。

`plugins/` 与 `core` 的关系是**注入**而非依赖：插件在 `install(host)` 里往 `PluginHost` 注册工具 / provider / guardrail / hook。MCP 是插件，不是 core 模块（ADR-039）。

`src/` 是装配层（`bootstrap.ts` 把 config → provider → plugins → runtime → ReplContext 串起来），不属于任何包。

## 2. 核心哲学：语言空间与两个适配器

**LLM 只活在语言空间里。** 它看不见文件系统、看不见终端、看不见网络。Vessel 的全部工作就是维护两个方向的折叠：

```
        ┌──────────────── 世界 ────────────────┐
        │  文件 / 命令 / 网络 / git / 用户       │
        └──────────────────────────────────────┘
                 ↑ ② 语言 → 世界              │ ① 世界 → 语言
                 │  tool_calls 解析 → 执行     │  system prompt + 消息 + 工具 schema
        ┌──────────────── 语言空间 ─────────────┐
        │            LLM（唯一的执行面）          │
        └──────────────────────────────────────┘
```

- **① 世界 → 语言**：`ContextManager` 里的消息 + 工具 schema（`PluginHost.listTools()`）+ system prompt，组成一次 `ChatRequest`。
- **② 语言 → 世界**：解析 `tool_calls` → 权限判定 → 执行 handler → 结果作为 `role: tool` 消息折回语言空间。

**两个插槽**是这套折叠的全部可扩展点：

| 插槽 | 实现 | 放什么 |
|---|---|---|
| **工具** | `PluginHost` | 语言 → 世界的能力。`PluginHost` 是**唯一的工具注册表**（core 里没有第二个） |
| **知识** | `ContextManager` | 世界 → 语言的输入。消息、system prompt、注入的文本 |

其余扩展点（guardrail、hook、provider、session backend）都挂在 `PluginHost` 上，不新增插槽。

**core 不认识业务概念。** core 里没有 skills、记忆、资产、附件这些词。任何要进语言空间的文本——技能文件、项目约定、引用材料——都经 `RunOptions.messages` 注入，**core 不解释它的来源与语义**（见 §4）。

## 3. tool-calling loop

`AgentRuntime`（`packages/core/src/runtime/agent-runtime.ts`）是唯一的循环实现。编排细节外推给了三个 runner：`PermissionPolicy`（权限）、`GuardrailRunner`（四阶段 guardrail）、`HookRunner`（五阶段 hook）——`AgentRuntime` 只做协调。

### 3.1 `run()`：一次请求的外壳

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
        # 本轮前置注入（见 §4）：core 不解释语义，先于用户输入写入并持久化
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

`resume()` 走同一条 `finalizeRun` 路径，因此用户取消同样发 `run.cancelled`，checkpoint 状态同样按 abort reason 映射为 `cancelled` / `interrupted`。`RunExecution` 是 run 级状态的唯一来源（run id / session / branch / 计时 / usage / context），见 §6。

### 3.2 `toolCallingLoop()`：循环骨架

签名 `toolCallingLoop(execution, signal)`；run id / session / usage 全部取自 `RunExecution`，不读实例字段。

```
loop:
    signal.aborted?                     → 抛错（Esc 中断）
    终止策略超限（maxIterations / maxRuntimeSeconds） → 抛错
    用量限制超限（request / tool_calls / token / cost） → 抛错

    # BeforeLlm hook 有唯一的注入位：hookCtx.systemPrompt
    hookCtx = { run_id, session_id, systemPrompt: this.systemPrompt }
    await hooks.run(BeforeLlm, hookCtx)

    messages = buildRequestMessages(hookCtx.systemPrompt)
    # 归一化只影响本次请求：丢弃孤儿 role:tool；不完整 tool_calls 轮次降级为普通 assistant 文本；
    # 上下文缺 system 时补回基底 systemPrompt（ADR-035）
    发 llm.request（messages 在发布前剥离 reasoning_content，ADR-038）
    response = provider.chat({ messages, tools: PluginHost 里全部工具, stream: true, on_chunk → 发 llm.stream.chunk })
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

### 3.3 关键约束

- **工具只能从 `PluginHost` 拿。** 循环里没有第二张表。装配层要么在 `plugins` 里传 Plugin（插件 `install` 时 `registerTool`），要么直接注入 `pluginHost`。
- **工具调用统一走 `ToolPipeline`**（0.8.2，ADR-058）：`AgentRuntime` 与 delegate 共用同一阶段顺序；handler 只由管道调用，由它套 `tool.timeout` 与 `ctx.signal`——handler 直调会让 `timeout` 与权限判定失效。权限判定发生在 ToolCall guardrail / BeforeTool 的改写之后，针对最终工具与参数。
- **工具失败不终止 run**。错误变成 `role: tool` 消息回到上下文，模型自己纠。非法 tool arguments JSON 也走这条路径（解析一次、发 `tool.call.failed`、折回错误文本）。
- **发给 Provider 的消息始终是合法序列**：`buildRequestMessages` 在输出前丢弃孤儿 `role: tool`、把不完整 `tool_calls` 轮次降级为普通 assistant 文本，并在上下文缺 system 时补回基底 `systemPrompt`。归一化只影响本次请求，不改 `ContextManager` 的持久化记录。
- **Guardrail `replacement` 四阶段生效**：Input（改写持久化的用户消息）、Output（改写返回值与持久化 assistant 消息）、ToolCall（改写实际执行的调用，先于 assistant 消息写入）、ToolResult（改写事件、上下文与返回值）；非法类型按未改写处理。
- **thinking 模型的 `reasoning_content`**：Provider 返回后保存在 assistant 消息并随下一轮请求回传（含 `tool_calls` 轮次）；`llm.request` / `context.changed` 事件在发布前剥离该字段，TUI / 观测 / 回放看不到思维链，会话持久化保留（ADR-038）。
- **权限是执行期判定，不是注册期过滤**：`checkPermission` 返回 `'allow' | 'deny' | 'ask'`；`'ask'` 走事件流等用户决定（`tool.permission.request` → `waitFor('tool.permission.response')`，0.13 起默认不超时，只有显式正数 `timeoutMs` 才超时）。未声明 `checkPermission` 的工具走 `RuntimePermissionConfig` 默认策略（库默认 `'allow'`，交互模式由装配层传 `'ask'`）。
- **`HookRunner` 丢弃 hook 返回值**（`Hook.run` 收窄为 `Promise<void>`）。跨 hook 通信的唯一通道是 `HookContext` 的字段（例如 `BeforeLlm` 的 `systemPrompt`）。
- **durable checkpoint 只由 `AgentRuntime` 写**（唯一写者）。Host 模式把 Host 的 `runStore` 注入成员 runtime；同时给 Host 与 runtime 两个 store 时 Host 优先，禁止双写（ADR-040）。
- **一个 runtime 同时只跑一个 run**（0.8，ADR-054）：`activeRun` 在任何 await 之前同步占位，已有 active run 时新的 `run()` / `resume()` 立即抛 `run_already_running`（`RunAlreadyRunningError`）。真正并行需要多个 runtime（Host 的“一 agent 一 runtime”模型）。
- **终态只有一条路径**：`run()` / `resume()` 都经 `finalizeRun()`；用户取消发 `run.cancelled`，Host 中断 / 普通错误发 `run.failed`，checkpoint 状态分别映射为 `cancelled` / `interrupted` / `failed`。终态持久化失败发 `run.finalize.failed`，不覆盖原始错误。
- **插件故障隔离**（0.8，ADR-054）：单个 Hook 抛错发 `hook.failed` + `hook.error` 并继续后续 hook；`OnError` 始终 best-effort；Guardrail 的 `check()` 抛错按 fail-closed 处理（`allowed:false` + `reason: 'guardrail_error'`，发 `guardrail.error`），不把原始异常冒泡成 run 失败。

## 4. 消息组装：`RunOptions.messages`

core 的通用注入位。调用方把**任何要进语言空间的文本**拼成消息传进来：

```ts
export interface RunOptions {
  signal?: AbortSignal;
  branch?: string;
  /**
   * 本轮请求前置注入的消息。core 不解释其来源与语义——
   * skill 内容、附件、引用文件、项目约定，任何要进语言空间的文本都走这里。
   * 写入顺序：注入消息在前，用户输入在后；两者都持久化进 ContextManager。
   */
  messages?: Message[];
}

run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string>;
```

语义边界：

- **顺序**：注入消息在前，用户输入在后。
- **持久化**：注入消息与用户输入一样进 `ContextManager`（是本轮真实对话历史的一部分，不是一次性遮罩）。
- **Input guardrail 先于写用户消息**：注入消息写入后、用户消息写入前执行；被阻断的输入不进入上下文（已写入的注入消息保留）。`replacement` 是字符串时，改写后的内容才是持久化的用户消息（PII 脱敏语义）。
- **会话标题**：取首轮最后一条 `user` 消息；注入消息在前，不抢标题。
- **core 不解释语义**：core 不知道哪条是 skill、哪条是附件。它只按序 `addContext`。
- **谁负责组装**：前端。REPL 发送前扫描输入里的 `@<路径>`：
  1. `@` 必须位于**行首或空白之后**（`a@b.com` 不触发）；
  2. 取其后**连续非空白字符**作为 token；
  3. 在该段**第一个全角标点处截断**，再**剥掉尾部的半角/全角标点**，得到路径。

  每个命中文件读为一条 user 注入消息（`<file path="...">内容</file>`，>100KB 截断并在末尾标注），读取失败则跳过并给一条 warning，**用户原文一字不改**。经 `RunOptions.messages` 传给 `run()`。headless 侧的对应入口是 `--run @file`。

  > **为什么要有「全角标点截断」这一步**：中文里路径与标点之间没有空白——`@skills/x.md，请按这个来` 的 token 尾字符是汉字，只剥尾部标点剥不掉 `，` 及其后面的句子；而半角标点**不能**当截断符（会把 `@skills/code-writing.md` 在第一个 `.` 处打断）。所以规则是：**全角标点截断，半角标点只剥尾部**。
- **skills 不是一条加载通道**：harness 不扫描、不解析、不注入 skills 目录。技能就是 markdown 文件，放两个位置——仓库 `skills/`（项目级，随仓库提交、团队共享）与 `~/.vessel/skills/`（用户级，跨项目复用）。这是纯约定，代码里零硬编码。前端负责查找与引用，core 只收消息。

`BeforeLlm` 的 system 注入是**另一件事**：它只影响本次请求的 system 消息，不改 `ContextManager` 的持久化内容。两者都由 `buildRequestMessages(...)` 在一处组装，避免散落的字符串 diff。

## 5. 9 个接口

签名取自 `packages/core/src/types/*.ts`（一个文件一组契约）。

### 5.1 `LLMProvider`（`types/provider.ts`）

```ts
interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>;
}

interface ChatRequest {
  messages: Message[];
  model: string;
  tools?: ToolSchema[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  session_id?: string;
  signal?: AbortSignal;
  on_chunk?: (chunk: StreamChunk) => void;
}

interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: FinishReason; // 'stop' | 'tool_calls' | 'length'
  usage?: Usage;
  /** thinking 模式思维链（可选；ADR-038） */
  reasoning_content?: string;
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** thinking 模式思维链（仅 assistant；保存并随下一轮请求回传，ADR-038） */
  reasoning_content?: string;
}
```

流式不是独立方法：`stream: true` + `on_chunk` 回调，loop 把增量发成 `llm.stream.chunk` 事件（ADR-007）。不支持的 Provider 忽略 `on_chunk` 即退化为整段返回。

`reasoning_content` 是 OpenAI 兼容 thinking 模型的可选扩展（DeepSeek 等）：Provider 返回后由 runtime 保存在 assistant 消息里，下一轮请求原样回传（含 `tool_calls` 轮次），否则 API 会拒绝。它**不进** `llm.request` / `context.changed` 事件，也不进 TUI；会话持久化保留。Anthropic 路径不使用该字段。

### 5.2 `ContextManager`（`types/context.ts`）

```ts
interface ContextManager {
  add(msg: Message): void;
  readonly messages: Message[];
  /** @returns 本次移除的消息数（0 = 未压缩） */
  compact(): number;
  clear(): void;
  readonly tokenCount: number;
  setSessionId(sessionId: string): void;
  getSessionId(): string;
  updateRealTokens(total: number): void; // 用 LLM 真实 token 数替代字符估算
}
```

`add()` 是**同步直接写**（关键路径，模型下一轮必读）；每次写入由 runtime 发一条 `context.changed` 事件供观测/回放。

### 5.3 `EventStream`（`types/event.ts`）

```ts
interface EventStream {
  subscribe(handler: EventHandler): Unsubscribe;
  publish(event: RunEvent): void;
  clear(): void;
  getHistory(runId?: string): RunEvent[];
  waitFor(name: string, opts?: { requestId?: string; timeout?: number }): Promise<unknown>;
}

interface RunEvent {
  type: string; // 开放字符串协议，无常量
  run_id: string;
  data: EventPayload | Record<string, unknown>;
  ts: number;
}
```

0.4 增加 `MemoryEventStreamOptions`：**缺省 `maxHistory = 1000`**；显式 `0` = 不限制；
`>0` = 环形缓冲，只保留最近 N 条。构造函数接受 `MemoryEventStreamOptions | number`，
数字形式保持 0.3 语义。`replayRun` / `FileEventStore` 语义不变，`FileEventStore` 不自动轮转（ADR-045）。

### 5.4 `ToolDefinition`（`types/tool.ts`）

```ts
interface ToolContext {
  session_id?: string;
  run_id: string;
  messages: Message[];
  events: EventStream;
}

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  /** 超时毫秒数；缺省或 0 = 不限时 */
  timeout?: number;
  /** 执行时权限判定（allow/deny/ask）；缺省走 runtime 默认策略 */
  checkPermission?(input: unknown, ctx: ToolContext): Promise<'allow' | 'deny' | 'ask'>;
}
```

工具是**自描述对象**：权限判定与超时随工具走，不集中在 runtime 的一张策略表里。core 里**没有 `ToolRegistry` 接口**——唯一的工具注册表是 `PluginHost` / `MemoryPluginHost`。

工具的实际执行统一走 `ToolPipeline`（0.8.2，ADR-058）：`getTool` → ToolCall guardrail → BeforeTool hook → 权限（最终工具与参数）→ handler（timeout + signal）→ ToolResult guardrail → AfterTool hook（仅成功）。`ToolPipelineStages` 可关闭调用方已在外层处理的阶段；`AgentRuntime`（含 delegate 子 runtime）关闭 guardrail/BeforeTool/AfterTool，只复用 permission / handler / ToolResult。

### 5.5 `SessionBackend`（`types/session.ts`）

```ts
interface SessionBackend {
  load(sessionId: string): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<string[]>;
  listRich(): Promise<SessionInfo[]>;
  close?(): void;
}
```

0.8.1（ADR-056）：`FileSessionBackend.load()` 只在主路径 `ENOENT` 时回退 legacy；文件存在但不可读或 JSON 损坏 → 抛 `SessionCorruptError`（`code: 'session_corrupt'`，含 `path`），不再静默当成“无会话”。`delete()` 同样先 `load()`，损坏时抛错不删除；`listRich()` 对损坏文件降级跳过，单文件损坏不拖垮列表。

### 5.6 `LimitChecker`（`types/limits.ts`）

```ts
interface LimitChecker {
  checkLimits(stats: UsageStats, limits: UsageLimits): boolean;
  checkTermination(stats: UsageStats, policy: TerminationPolicy): boolean;
  incrementRequest(stats: UsageStats): void;
  incrementToolCall(stats: UsageStats): void;
  addTokens(stats: UsageStats, input: number, output: number): void;
  addCost(stats: UsageStats, cost: number): void;
}

interface UsageLimits {
  requestLimit?: number;
  toolCallsLimit?: number;
  inputTokensLimit?: number;
  outputTokensLimit?: number;
  totalCostLimit?: number;
}

interface TerminationPolicy {
  maxIterations: number;
  maxRuntimeSeconds?: number;
}
```

0.14.3（ADR-084）：限额判定拆成两个纯函数——`evaluateUsageLimits(stats, limits)` 与 `evaluateTermination(stats, policy)`，都返回 `LimitBlock | null`（`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`）；`MemoryLimitChecker.checkLimits` / `checkTermination` 分别复用它们。终止策略命中同样产生 `LimitBlock`（key `max_iterations` / `max_runtime`）。事件与 envelope 契约见 §35。

### 5.7 `Guardrail`（`types/guardrail.ts`）

```ts
interface Guardrail {
  name: string;
  stage: GuardrailStage;
  check(value: unknown, ctx: GuardrailContext): Promise<GuardrailResult>;
  priority?: number;
}

enum GuardrailStage {
  Input = 'input',
  Output = 'output',
  ToolCall = 'tool_call',
  ToolResult = 'tool_result',
}

interface GuardrailResult {
  allowed: boolean;
  replacement?: unknown;
  reason?: string;
}
```

四个阶段任一 `allowed: false` 即短路（发 `guardrail.blocked`），随后沿用各阶段的 blocked 语义：Input / Output 终止 run，ToolCall 标记该调用被阻断，ToolResult 折回 tool 错误。`replacement` **真实生效**（ADR-035）：Input 改写持久化的用户消息；Output 改写返回值与持久化 assistant 消息；ToolCall 改写实际执行的调用（先于 assistant 消息写入）；ToolResult 改写事件、上下文与返回值。类型不符的 replacement 按未改写处理（Input/Output/ToolResult 只接受字符串，ToolCall 只接受合法 `ToolCall`）。

0.8 起（ADR-054）：`check()` 自身抛错按 **fail-closed** 处理——发 `guardrail.error`，返回 `{ allowed: false, reason: 'guardrail_error' }`，再走上述 blocked 语义；原始异常不再冒泡成 run 失败。

### 5.8 `Hook`（`types/hook.ts`）

```ts
interface HookContext {
  run_id: string;
  session_id?: string;
  /** BeforeLlm 注入位：hook 写这里，loop 在调用 LLM 前读取，作为本次请求的 system 消息 */
  systemPrompt?: string;
  [key: string]: unknown;
}

interface Hook {
  name: string;
  priority?: number;
  type: HookType;
  run(ctx: HookContext): Promise<void>;
}

enum HookType {
  BeforeLlm = 'before_llm',
  AfterLlm = 'after_llm',
  BeforeTool = 'before_tool',
  AfterTool = 'after_tool',
  OnError = 'on_error',
}
```

返回值被丢弃（`Promise<void>`）——跨 hook 通信只用 `HookContext` 字段。

0.8 起（ADR-054）：`HookRunner` 对每个 hook 独立 try/catch。某个 hook 抛错时发 `hook.failed`（兼容既有订阅方）与 `hook.error`（统一信号），继续执行后续 hook，不终止 run，也不丢弃已聚合的结果。

### 5.9 `Plugin` / `PluginHost`（`types/plugin.ts`）

```ts
interface Plugin {
  name: string;
  version?: string;
  description?: string;
  install(host: PluginHost): void | Promise<void>;
}

interface PluginHost {
  registerTool(def: ToolDefinition): void;
  registerProvider(name: string, factory: ProviderFactory): void;
  registerGuardrail(guardrail: Guardrail): void;
  registerHook(hook: Hook): void;
  getTool(name: string): ToolDefinition | undefined;
  getProvider(name: string): ProviderFactory | undefined;
  getGuardrails(): Guardrail[];
  getHooks(): Hook[];
  listTools(): ToolDefinition[];
  listProviders(): string[];
}
```

这是**唯一的扩展机制**。`AgentRuntimeOptions` 里的 `plugins?: Plugin[]` 在 `AgentRuntime.create()` 时逐个 `install`（install 失败即构造失败，fail-fast）；也可直接注入 `pluginHost?: PluginHost` 替换实现。

### 5.10 `RunStore`（`types/run-store.ts`，module port）

```ts
interface RunCheckpoint {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  messages: Message[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; total_cost?: number };
  iteration?: number;
  created_at: number;
  updated_at: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

interface RunStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  load(runId: string): Promise<RunCheckpoint | null>;
  list(opts?: {
    status?: RunCheckpoint['status'];
    session_id?: string;
    limit?: number;
    /** 跳过排序后的前 N 条（缺省 0）；0.8.1 全量分页 */
    offset?: number;
  }): Promise<RunCheckpoint[]>;
  delete(runId: string): Promise<void>;
  close?(): Promise<void>;
}
```

实现：`MemoryRunStore`（进程内）与 `FileRunStore({ dir, tenantId? })`（每 run 一个 JSON 文件，temp + rename，Windows best-effort）。从 `@vessel-agent/core/session` 与根入口导出。**`RunStore` 是 module port，不是第 10 个扩展接口**；`SessionBackend`（会话对话持久化）与它正交（ADR-040）。

0.8 起（A5）：`FileRunStore` 接受可选的 `tenantId`。tenant 模式下 `delete(runId)` 先 `load()` 校验归属——缺失或属于其它 tenant 时直接 no-op，不 unlink 文件；与 `FileSessionBackend.delete` 的 foreign 会话语义对称。装配层在 `--resume-run`、单 agent 与 per-tenant runtime 三条路径都把 `tenantId` / `tenantRunsDir` 透传到 store。

0.8.1 起（ADR-056）：`list` 增加可选 `offset`（过滤、排序后切片，用于 `deleteSessionData` 的全量分页冲突检查）。tenant 模式下 `FileRunStore.load()` 把非 ENOENT 读取错误、JSON 解析失败与非法 checkpoint 形状视为损坏并抛 `SessionCorruptError`（`code: 'session_corrupt'`）；`delete()` 让该错误向上传播，绝不删除归属未知的文件。非 tenant 模式保持 0.3 的宽松语义（损坏 → `null`）。

0.4 增加 `pruneRuns(store, opts?)` helper（`PruneRunsOptions` / `PruneRunsResult`，从根入口与 `@vessel-agent/core/session` 导出），按 `status` / `older_than_ms` / `keep_latest` 清理 run；**不修改 `RunStore` 接口**，也不自动调度（ADR-045）。

## 6. `AgentRuntime` 公开面

```ts
class AgentRuntime {
  static create(opts: AgentRuntimeOptions): Promise<AgentRuntime>;

  /** 事件流——headless / 外部订阅者的入口 */
  readonly events: EventStream;
  /** 工具与插件的唯一来源——TUI/装配层从这里读，不再经由 ToolRegistry */
  readonly pluginHost: PluginHost;

  run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string>;
  /** durable：从 checkpoint 恢复并继续；未配置 runStore 抛 run_store_required */
  resume(runId: string, opts?: RunOptions): Promise<string>;
  dispose(): void;
}

interface AgentRuntimeOptions {
  provider: LLMProvider;
  model: string;
  context: ContextManager;
  events: EventStream;
  limits: UsageLimits;
  termination: TerminationPolicy;
  plugins?: Plugin[];
  pluginHost?: PluginHost;      // 可选注入；缺省 new MemoryPluginHost()
  limitChecker?: LimitChecker;  // 可选注入；缺省 new MemoryLimitChecker()
  session?: SessionBackend;
  runStore?: RunStore;          // 可选注入；缺省不写 checkpoint
  agentId?: string;             // Host 模式用于 checkpoint.agent_id
  systemPrompt?: string;
  permission?: RuntimePermissionConfig;
}
```

`create()` 是异步静态工厂（构造函数私有）——插件安装是异步的，且要求 fail-fast（ADR-023）。

0.8（ADR-054）：run 级状态收敛在 `RunExecution`（`runId` / `sessionId` / `branch` / `createdAt` / `startedAt` / `stats` / `context`，从根入口导出）。`run()` / `resume()` 共用同一个 `activeRun` 槽位，在第一个 await 之前同步占位；已有 active run 时立即抛 `RunAlreadyRunningError`（`code: 'run_already_running'`，继承 `RunResumeError`）。公开签名与 `AgentRuntimeOptions` 不变。

Kernel 侧：`RunnableAgent.resume?(runId, opts?)` 返回 `RunHandle`；`RuntimeHost.resume?(runId)` 同样恢复，但**不经 Scheduler**（保持 run_id 不变）。resume 只接受 `running` / `interrupted`；同一 run 并发恢复首个成功，后续 `run_already_running`（ADR-040）。

## 7. 扩展模型

**一个机制：`Plugin` + `PluginHost`。** core 不为任何扩展类型新增接口。三类扩展内容：

| 类型 | 是什么 | 怎么投放 |
|---|---|---|
| **Plugin** | TypeScript 模块，自描述对象 | `plugins/<category>/<name>/`，见 §8 |
| **Skill** | 纯 markdown 文件 | **不是一条加载通道**——由前端读取，经 `RunOptions.messages` 作为消息注入（见 §4） |
| **Config** | YAML 声明 | 见 §9 |

插件能注册什么：**工具**（`registerTool`）、**Provider**（`registerProvider`）、**Guardrail**（`registerGuardrail`）、**Hook**（`registerHook`）。

**MCP（0.3）**：`@vessel-agent/mcp-client` 是**插件**，不是 core 模块。配置 `mcp_servers` 后由 asm 装配层构造；工具经 `PluginHost.registerTool` 进入语言空间。stdio 与 HTTP（Streamable HTTP）两种传输；工具名默认 `mcp__<server>__<tool>`；权限默认 `ask`；单 server 失败不影响其他 server（ADR-039）。

## 8. 插件发现

**唯一一套：运行时目录扫描**（`src/plugin-loader.ts`）。

```
plugins/
├── tools/basic-tools/       package.json + src/index.ts   → bash / read / edit
├── tools/delegate-task/     → delegate_task（工厂式）
├── tools/team/              → team_* 5 个（工厂式；默认不加载，team.enabled 才构造）
├── mcp/client/              → MCP client（工厂式；配置 mcp_servers 才构造）
├── evals/harness/           → @vessel-agent/evals（工厂式；asm 直接调用库，不注册工具）
├── im/feishu/               → @vessel-agent/feishu（工厂式；--feishu 才启动）
├── security/guardrail-pii/  → 输入输出 PII 脱敏
├── security/redact-secrets/ → 工具结果与输出里的密钥脱敏
├── security/tool-policy/    → ToolCall 阶段 allowlist / denylist
├── observability/hook-logging/
└── provider/{openai,anthropic}/
```

共 **12 个插件包**。规则：`plugins/<category>/<name>/package.json` + `src/index.ts` 存在即注册，**无需改代码、无需构建步骤**；`src/index.ts` 的默认导出须是 `Plugin`（含 `install()`）。目录形态不是 Plugin 的（例如默认导出是工厂函数、需要装配层注入依赖）列在 `FACTORY_PLUGINS` 里，由装配层自行构造——目前是 `delegate-task`、`team`、`mcp-client`、`evals` 与 `feishu`。`team` 还要求 `team.enabled: true` 显式 opt-in；MCP 要求至少一个 `mcp_servers` 条目；evals 由 CLI 直接调用；feishu 只有显式 `--feishu` 才启动。`PluginLoader` 的默认集与 `plugins:` 显式列表都会过滤它们。0.8.2（ADR-058）起，装配层给 delegate 注入父级 resolved 权限。

`PluginLoader` 的接口：

```ts
class PluginLoader {
  list(): PluginDescriptor[];
  getProviders(): string[];         // category === 'provider'
  getAvailablePlugins(): string[];  // 排除 provider 与工厂式插件
  load(name: string): Promise<Plugin | null>;
}
```

**扫描只在进程启动时发生一次。** `PluginLoader` 把扫描结果缓存在实例上（插件目录在进程生命周期内视为不变），**这不是热加载**：新增或改动插件需要**重启进程**才生效，`/reload` 只重载配置、不重扫插件目录。0.6.1 已增加用户 / 项目插件目录与 `plugins[].config` 注入，见 §18.4。

**来源与优先级（0.7.1）**：默认扫描根为 `repo`（仓库 `plugins/`）→ `project`（`./.vessel/plugins`）→ `user`（`~/.vessel/plugins`）→ `node_modules`（仓库根与 cwd 的 `node_modules/@vessel`）。同名插件**先出现者胜出**，因此仓库覆盖项目、项目覆盖用户。

**默认集与信任边界（0.7.1）**：`plugins` 配置缺省时，默认集加载全部可用插件——包括 project / user / node_modules 来源的外部插件。启动时由 `bootstrap` / `--tools` / `doctor` 向 **stderr** 打印一次外部插件告警（数量、名称、来源），告警不进入 stdout / JSON。设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`（或 `true`）后，默认集只加载 `source === 'repo'` 的插件；显式 `plugins:` 列表仍可加载指定外部插件（显式即信任）。外部插件以完整进程权限运行，且早于任何工具权限判定，因此 **P0-3 只做到缓解（MITIGATED），不是已关闭的信任边界**；不可信仓库应使用 opt-out。

**加能力就是放一个文件夹。** `bash` 工具在，写文件 + 跑命令本身就是模型能做的事——这就是不再需要「声明式工具」「用户目录工具扫描」「运行时注册表」的原因。

## 9. 配置模型

0.5 起按优先级从高到低为：

| 层 | 路径 | 用途 |
|---|---|---|
| CLI / env | 命令行 flag、`VESSEL_*` / `.env` | 操作者与部署覆盖；密钥首选 |
| tenant overlay | `tenant.tenants.<id>.config` | 单 tenant 覆盖；**不得覆盖 CLI/env** |
| 项目级 | `./vessel.yaml` | 项目行为：session、context、plugins、trace、tenant 覆盖；**禁止密钥** |
| 用户级 | `~/.vessel/config.yaml`（Windows `%USERPROFILE%/.vessel/`） | provider、默认模型、`data_dir`、`tenant.default` |
| 默认 | 代码 `DEFAULT_CONFIG` | 所有缺省值 |

优先级：**CLI > env > tenant overlay > project > user > default**。
tenant overlay 只叠加在项目/用户之上；`data_dir` 是全局键，tenant overlay 不得修改。

0.8.1（ADR-057）：所有层只在 `loadConfig()` 合并一次。CLI 层由 `ConfigLoadOptions.cliOverrides` 传入（`Partial<VesselConfig>`，`source=cli`）；旧 `defaults` 为 deprecated 同义层，先应用、`cliOverrides` 后应用。`src/cli-overrides.ts` 只把**显式** flag 组装成该层（端口仅在显式给出时写入；`allowed_origins` 整体替换）。`resolveServeOptions(config)` 不再接收 argv，`bootstrapConnect` 也不再直接读 `process.env`。

loader 把 YAML 的 snake_case 映射成 TS 的 camelCase（ADR-019）。校验器对未知键报错——配置写错要立刻知道，不静默忽略。

### 9.1 配置块（当前）

| 键 | 说明 |
|---|---|
| `provider.timeout_ms` | LLM 请求超时（毫秒）；`<=0` 关闭。仅插件式 provider（openai / anthropic）生效 |
| `data_dir` | 全局数据根，默认 `~/.vessel/data`；`VESSEL_DATA_DIR` 覆盖；tenant overlay 不得修改 |
| `tenant.default` / `tenant.tenants.<id>.*` | `default` 缺省 tenant；`name` / `status`（`active`\|`disabled`）/ `quota`（`max_sessions` / `max_runs_per_day` / `max_concurrent_runs` / `max_storage_bytes`）/ `tools.allow|deny` / `config` overlay；白名单见 ADR-049 |
| `trace.enabled` / `level` / `retention_days` / `max_runs` / `max_bytes` | 缺省 true / `full` / 30 / 1000 / 1 GiB；`level` 为 `full`\|`metadata`\|`off`；`max_bytes: 0` = 不限 |
| `session.backend` | `file`（0.5 默认）/ `sqlite`（0.4 默认，仍可用）/ `memory`；`storagePath` 对应 sqlite 文件或 file 目录 |
| `update.autoCheck` / `channel` / `source` | 交互启动后台检查（默认 true）、`latest` / `beta`、自定义清单源 |
| `agent.enabled` / `ownerId` / `model` / `limits` / `termination` | AgentService 与内置 `agent` 工具；默认 false（0.17） |
| `agent.defaultVisibility` / `permissionMode` / `readOnlyTools` | 成员可见性与权限模式：`bridge`（交互默认）/ `allow`（headless 默认）/ `deny`（保留 `readOnlyTools`，默认 `["read"]`）；0.17 |
| `agent.followReplies` / `cwd` / `systemPrompt` | 回复注入策略（不自动续跑父 turn）/ 默认工作目录 / 主 agent systemPrompt |
| `mcp_servers.<name>.*` | MCP server：`transport`（stdio/http）、`command`/`args`/`env`、`url`/`headers`、`enabled`、`connect_timeout_ms`、`tool_timeout_ms`、`tool_prefix`、`auto_approve_tools` |
| `durable.enabled` / `backend` / `path` / `checkpoint_every` | 默认 false；`backend: file \| memory`；0.5 起 `path` 默认 `<data_dir>/tenants/<tenant_id>/runs`，显式配置优先但可逃出 tenant（启动 warn）；0.3 只接受 `checkpoint_every: iteration` |
| `serve.hostname` / `port` / `allow_remote` / `tls.cert_file` / `tls.key_file` | 默认 `127.0.0.1:8642`、明文；非回环必须 `allow_remote: true`、token 非空**且 TLS cert/key 成对**（0.6 起强制） |
| `serve.allowed_origins` | 独立前端 Origin allowlist；绝对 http(s) origin，禁止 `*` / path / query；非回环必须 https；HTTP 与 WS 共用（0.6） |
| `connect.token` / `token_env` / `ca_file` | `--connect` 客户端 token 与 CA；token 优先级 CLI > env（`VESSEL_CONNECT_TOKEN`，缺失时回退 `VESSEL_GATEWAY_TOKEN`；`token_env` 由 loader 在 env 层解析）> config（0.6；0.8.1 统一经 loader，`--ca` 对应 `VESSEL_CONNECT_CA`） |
| `transport.kind` / `transport.nodes[]` | `in-process` / `loopback` / `remote`；`remote` 时静态节点 `{ id, url, token?, token_env?, ca_file? }`，无自动发现（0.6） |
| `serve.token` / `serve.token_env` / `serve.tokens` / `serve.admin_token` | 0.5：`serve.token` 为 default/admin 兼容单 token；`serve.tokens` 为 token → `{tenant_id, role}`；`serve.admin_token` 为 `*`/admin；解析顺序见 ADR-050 |
| `evals.enabled` / `dir` / `out_dir` / `allow_network` | 默认 false / `./evals` / `~/.vessel/evals` / false；`allow_network: true` 仍需 CLI `--allow-network` |
| `feishu.enabled` / `app_id` / `app_secret` / `domain` / `allowed_chat_ids` / `session_prefix` / `reply_timeout_ms` / `max_reply_chars` / `max_members` | 默认 false；env `VESSEL_FEISHU_APP_ID` / `VESSEL_FEISHU_APP_SECRET` 优先；`max_members` 1..64（默认 8）；**`agent_id` 已删除，严格按未知键拒绝** |
| `observability.event_history` / `metrics` | `event_history` 缺省 1000，显式 0 = 不限制，>0 = 环形缓冲；块缺省时不注入 metrics，块存在时 `metrics` 默认 true |

0.6.1 已新增 `permission.auto_approve`（TS 字段 `autoApprove`）、`plugins[].config` 消费与 `VESSEL_PLUGINS` / `VESSEL_SESSION_BACKEND` / `VESSEL_MODEL` 覆盖，见 §18.4。

0.3 配置示例：

```yaml
mcp_servers:
  echo:
    transport: stdio
    command: bun
    args: ["run", "examples/mcp-echo-server.ts"]
    tool_prefix: true
    auto_approve_tools: []

durable:
  enabled: true
  backend: file
  path: ~/.vessel/runs
  checkpoint_every: iteration

serve:
  hostname: 127.0.0.1
  port: 8642
  allow_remote: false
  # tls:
  #   cert_file: /path/to/cert.pem
  #   key_file: /path/to/key.pem
```

- **顶层未知键是 error**（带编辑距离拼写建议），不是 warning——启动即失败，避免配置悄悄无效；`mcp_servers` 内未知名与 `serve.tls` 未知名同样报错。
- 已知但 0.1.0 未消费的字段（`agent.name/temperature/maxTokens`、`session.maxHistory`、`guardrails`、`hooks`）给显式 warning，不静默。
- provider 默认 model 是 provider-aware：只有已登记 provider（当前 `openai`）有默认；未知 provider 必须显式配 `model`。
- `VESSEL_PROVIDER_API_KEY` 可回填顶层 `apiKey`。

**注意**：`vessel.yaml` 的 `tools:` 声明段已删除（连同 `ToolConfig` 类型）。从前"用户在配置里声明一个 shell/http 工具"这条路径没有了——有了 `bash` 之后，加能力就是写文件 + 跑命令。

0.4 的四个新块**全缺省时行为与 0.3 一致**：CLI `eval` 不可用、不启动飞书、不注入 metrics；`event_history` 仍为 1000。严格校验：类型、范围、未知键；`feishu.enabled: true` 且（env + config）无凭据 → 启动失败；`evals.allowNetwork: true` 不自动开启 CLI flag。

0.5 新增 `data_dir` / `tenant` / `trace` 与 `serve.tokens` / `serve.admin_token`。缺省行为：`session.backend = file`、`durable.path = <tenant>/runs`、trace 默认开启 `full`（30 天 / 1000 runs / 1 GiB）、tenant 缺省 `default`。用户配置未知键仍是 error；legacy 白名单仅 `default_provider` / `default_model` / `providers`。项目 `vessel.yaml` 出现密钥、tenant overlay 出现禁止块或 `null`、`config show` 校验失败均直接报错（exit 1）。

## 10. 事件系统

事件流是**跨组件的唯一异步沟通总线**：runtime → 观测（TUI / 日志 / 审计 / 回放）、工具 ↔ TUI（权限确认、ask_user 交互暂停）。

### 10.1 命名约定

**事件名一律是开放字符串字面量**（ADR-030）：不定义 `EventType` / `PermissionEvent` 之类常量，生产者和消费者直接写字符串。**命名空间 `<domain>.<action>.<event>`**，防撞名。

- 加新事件 = 写字面量，零 import、零 core 变更。
- 代价：没有编译期拼写检查，靠命名空间约定 + 集成测试兜底（断言"发布 X 后订阅者收到"）。

### 10.2 核心事件名

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

### 10.3 三种机制的边界（防混用）

| 机制 | 职责 | 例子 | 混用的后果 |
|---|---|---|---|
| **直接调用** | core 内部 / 关键路径（必须可靠、有序、单消费者） | `context.add`、`provider.chat`、`pluginHost.getTool` | 把协作直接调用 → 耦合 |
| **事件流** | 跨组件异步沟通（可丢失、多消费者、要解耦） | runtime→观测、工具↔TUI | 把内部调用事件化 → 关键路径不可靠 |
| **Hook / Guardrail** | 同步生命周期拦截（阶段检查） | `BeforeLlm`、`ToolCall` guardrail | 用事件流实现拦截 → 竞态 |

**交互暂停的形态**：工具 `publish` 一个请求事件 → `await events.waitFor(回复事件, { requestId, timeout })` → 拿到答案继续。loop 不需要任何暂停/恢复机制——handler 本身就在 await。

### 10.4 事件回放

`MemoryEventStream` 之外，core 提供 `FileEventStore`（JSONL 一行一事件：`append` / `readRun` / `listRunIds` / `deleteRun`）与 `replayRun(store, runId, eventStream, { delayMs })`。回放经同一个 `publish()` 重新发布历史事件（保留原始 `ts`），订阅者用同一个 `subscribe()` 接收 live 与 replay，靠 `replay.started` / `replay.completed` 区分边界。

### 10.5 trace 落盘（0.5）

`RunEvent` 增加可选 `seq?` 与 `tenant_id?`；缺失 `tenant_id` 视为 `default`。`TraceRecorder` port 由 asm 接线，默认 `FileTraceRecorder` 把每个 run 写成 `<data_dir>/tenants/<tenant_id>/events/<run_id>.jsonl`（append-only，一行一事件）。

- **seq**：由 recorder 落盘时分配，以文件尾部最大 seq 为种子；内存实时事件允许无 seq，消费方按 `(seq ?? ts)` 回退。`events.list` 返回 trace seq；gateway 的 `events.subscribe.since` 是 wire seq，二者分层。
- **级别**：`full` 保留完整 payload；`metadata` 只留信封与白名单字段（`status` / `tool_name` / `duration_ms` / `iterations` / `iteration` / `message_count` / `finish_reason` / `usage.*`），`error` 截断 ≤500、`reason` ≤200；`off` 不落盘。
- **留存**：缺省 30 天 / 1000 runs / 1 GiB（每 tenant）；`vessel trace prune` 或启动时执行，不删除 `running` / `interrupted` run。
- **失败与溢出**：写失败发 `trace.write.failed` 并计数，不向事件投递路径抛错；每 run 队列上限 10000，溢出丢新事件并写一行 `trace.overflow { dropped }`，同一 run 最多一次 `trace.write.failed { reason: 'queue_overflow' }`。
- **脱敏**：trace 写入前与 gateway 出站前都过 `TraceRedactor`；默认按键名与 `sk-` 前缀替换，`app_id` 只留前 4 位 + `***`。0.5 **不**对 run checkpoint、eval 报告、飞书回复脱敏（resume / 展示需要完整内容）；POSIX 下 0600 best-effort。
- **读取与重建**：`readTraceEvents(traceDir, filter)` 默认 limit 50、最大 500，按 `(seq ?? ts)` 升序，跳过损坏行；`rebuildMetrics(traceDir)` 返回与实时 `MetricsSnapshot` 同形状，`updated_at = max(ts)`。
- **取消**：显式用户取消只发 `run.cancelled`，不再同时发 `run.failed`；Host 关闭/中断仍发 `run.failed`。0.8 起 `run()` 与 `resume()` 共用 `finalizeRun`，resume 的用户取消同样发 `run.cancelled`（ADR-054）。因此 `metrics.runs.cancelled` 在 0.5+ 可能非 0。
- **事件归属**：core 发 `session.saved/deleted`、`hook.*`、`run.cancelled`、`installPlugin` 的 `plugin.*`；asm 发 `config.loaded` 与 `PluginLoader` 的 `plugin.loaded/failed`；ext 发 `eval.*` / `feishu.*` / `mcp.*` / `subagent.*`。

## 11. 工具集：三个能力工具，为什么这么少

默认运行期 **3 个**工具：`plugins/tools/basic-tools` 提供 **`bash` / `read` / `edit`** 三个**能力工具**。`agent` 内置在 `packages/agent`，由 `agent.enabled: true` 注册（0.17）；`team_*` / `delegate_task` 已删除。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `agent` | `agent.enabled: true`；owner 动作 `new` / `send` / `close` / `list` / `rotate` / `post`（支持 batch；成员侧只暴露 `rotate` / `post` / `send` / `list`，`new` / `close` 只给 owner）；权限模式与成员配置见 `agent.*`（0.17；rotate 见 0.19 S2；Team 动作见 0.19 S3） |
| `ask_user` | 交互 REPL（stdin 是 TTY）或 `gateway start` / `--serve`；`--run` / headless / 管道不注册；`ui.askUser: false` 可关闭（0.14.1） |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功后注册；数量随 server 动态变化（ADR-039） |

口径：**默认 3 / `agent.enabled: true` 4 / 交互 REPL 或 gateway-serve 4（+`ask_user`）/ 交互 + agent 5**；配置 MCP 后为 **3 + N 个 MCP 工具**（N 由 server 提供）。`--tools` 一次性命令按 headless 口径列出，并注明 `ask_user (interactive REPL / gateway only)`；**`--tools` 不连接 MCP，因此不列出 MCP 工具**——需实际运行/连接后，经 REPL `/mcp` 或 gateway `GET /v1/mcp/servers` 查看。

| 工具 | inputSchema | 权限 | 行为 |
|---|---|---|---|
| `bash` | `{ command, cwd?, timeout_ms? }` | `ask`；cwd 命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `Bun.spawn(['bash','-c',command])`。超时默认 120s；输出超 2000 行时保留头 1000 + 尾 1000 并标注省略行数；超时返回明确错误文本而非抛异常 |
| `read` | `{ path, offset?, limit? }` | `allow`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | 带行号返回（从 1 开始）。`limit` 默认 2000 行；截断时标注总行数与继续读的方式 |
| `edit` | `{ path, old_string, new_string, replace_all? }` | `ask`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `old_string` 必须**精确匹配且唯一**；不唯一时报错并说明匹配次数，未匹配时报错；`replace_all: true` 才允许多处替换 |

**路径边界（0.8，ADR-055；0.15 覆盖 `edit`）**：`read` / `edit` / `bash cwd` 先按真实路径（`realpath`；不存在的路径取最近已存在祖先）判定，`..` 与 symlink 不能绕过。内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）命中即 `deny`；插件 `config.allowed_roots` 非空时越界为 `ask`，`config.deny_paths` 追加到内置列表。默认 `allowed_roots` 为空 = 不限制根，行为与 0.7 兼容。`bash` 只校验 `cwd`，命令本身仍可访问其它路径——这不是沙箱。

**被判死的工具，以及为什么**：

| 删掉的 | 因为 |
|---|---|
| `grep` / `ls` / `cat` / `find` | `bash` 就能干，且组合能力更强 |
| file-ops（`write_file` / `create_dir` / `path_exists` / …） | `edit` 写、`bash` 建目录与判定存在 |
| meta-tools（`register_tool` / `search_assets` / `inspect_asset` / …） | 写文件即等于建工具：模型用 `bash` 落一个插件目录，下次启动被 `PluginLoader` 扫到 |
| skills-loader（scanner + CRUD + 文件监听） | skills 就是文件；前端引用、core 只收消息 |
| memory 插件 | 项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown 文件，模型自己读写 |

> MCP 不是「能力工具」，而是把外部工具接进 `PluginHost` 的插件（ADR-039）；它不占基础工具名额，也不改变「三个能力工具」的判据。

**0.4 的 evals / feishu 不注册模型工具**，工具口径不变（默认 4 / 交互 5 / team 9 / 4 + N MCP）。

判据只有一条：**能被其他工具替代的工具，就不该存在**。工具越多，模型的选错空间越大；真正的通用原语只有"执行一条命令"，其余都是它的特化。

## 12. 装配层（`src/`）

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 入口分发：REPL（默认）/ `--run`（唯一 headless 入口：有参=文本或 `@file`，无参=stdin）/ `--serve` / `--resume-run` / `--version` / `--tools` / `update` / `eval` / `--feishu`；非交互且无 Key 时快速失败，不进首启向导。0.8：headless 只记录退出码，不提前 `process.exit`，统一走 gateway / tenantFactory / transport / shutdown 清理后再落 `process.exitCode` |
| `src/cli-args.ts` | 纯参数解析（语法与互斥），无副作用；`--serve` 默认端口 8642；`--resume-run` 与 `--run` / `--serve` / `--tools` / 位置式输入互斥；0.4 解析 `eval` 子命令与 `--feishu` 附加开关；0.6 解析 `--connect` / `--connect-token` / `--ca`（别名 `--connect-ca`）/ `--allowed-origin`（可重复，需 `--serve`） |
| `src/cli-overrides.ts` | 0.8.1：把**显式** CLI flag 组装成 `Partial<VesselConfig>`（serve / connect / TLS / allowed-origins），作为 loader 的最高优先级层；未给出的字段不写入 |
| `src/cli-update.ts` | `update [--check] [--channel latest\|beta] [--json] [--force]`：只读检查与提示 |
| `src/update/` | 更新清单解析、GitHub 通道选择、24h 缓存、后台检查、semver 比较；不自替换 |
| `src/bootstrap.ts` | config → provider → plugins → runtime → `ReplContext`；按配置构造 delegate / team / MCP，装配 session backend 与 RunStore；进程退出时关闭 MCP / Host / RunStore。0.8：`LocalRpcClient` 的 `onEvent` 订阅 `runtimeEvents`，以只读方式转发 `events.event`。0.8.1：接受 `cliOverrides` 并传给 loader；connect token / CA 只读 `config.connect` |
| `src/plugin-loader.ts` | 插件发现（见 §8） |
| `src/plugin-selection.ts` | bootstrap 与 `--tools` 共用的插件选择策略，避免默认集漂移 |
| `src/agent-service-wiring.ts` / `src/agent-owner-injection.ts` | 0.17：把父 provider / PluginHost / 限额 / 事件流交给 AgentService；owner 队列经 `BeforeLlm` 注入 |
| `src/agent-owner-server.ts` / `src/agent-owner-client.ts` | 0.17：REPL owner loopback 控制端点与 CLI attach；0.19 S3 增加 `team.list|get|post|members` 私有方法 |
| `src/team-command.ts` | 0.19 S3：`vessel team list|get|post|members [--json]` 的参数映射与渲染；成员名在 CLI 层解析为 agent id |
| `src/hub-command.ts` | 0.19 S5：`vessel hub start|directory|watch|pair|node|token|data-token` 的参数映射与渲染 |
| `src/hub/` | 0.19 S5：hub 独立前台进程（`runtime` / `server` / `registry` / `control-client` / `secret-store` / `token-broker` / `client-protocol` / `types`） |
| `src/hub-wiring.ts` / `src/node-token-store.ts` / `src/node-token-control.ts` / `src/hub-pairing.ts` | 0.19 S5：`HubControlLike` / `TeamScopeLike` 投影、节点 token 表（只存 hash）、`auth.exchange|revoke|tokens` 与一次性配对码 |
| `src/gateway-wiring.ts` | 0.15 / 0.19：`buildGatewayControlPlane` 透传 `teams` / `hubControl` / `teamScope` / `nodeTokens` |
| `src/tenant-runtime-factory.ts` | 构造单个 tenant 的独立执行面（config / provider / session / run store / context / PluginHost / trace / writer lock）；runtime 共用同一份 resolved 权限 |
| `src/session-factory.ts` | `session.backend` → sqlite / file / memory |
| `src/run-store-factory.ts` | `durable.backend/path` → `FileRunStore` / `MemoryRunStore`；未启用返回 null。0.8：透传 `tenantId`（归属校验）与 `tenantRunsDir` |
| `src/durable-wiring.ts` | checkpoint / resume 的装配适配：Host 成员优先，其次单 agent runtime |
| `src/mcp-wiring.ts` | 读取 `mcp_servers` → `createMcpPlugin`；构造 TUI / gateway 需要的状态适配器 |
| `src/serve-config.ts` | `serve.*` 默认值补全、远程/TLS 校验、证书文件检查；0.8.1 起不再接收 argv，CLI 层已由 loader 合并 |
| `src/rpc/http-client.ts` | `HttpRpcClient`：`POST /v1/rpc`、Bearer、可选 CA、WS 首帧 auth 与 `since` / `pong` / `gap` / 重连 |
| `src/node-registry.ts` | 0.6 静态节点表：URL / token / CA 解析、心跳与 `healthy` / `unreachable` 状态 |
| `src/remote-transport.ts` | 0.6 `kind:'remote'`：`send` / `request` / `peers`、远端事件订阅与 `(node_id, seq)` 去重 |
| `src/transport-factory.ts` | 按配置构造 in-process / loopback / remote transport；remote 节点与事件回灌接线（0.17 起不再有 team 生产装配） |
| `src/resume-command.ts` | `--resume-run` 无参：列出 interrupted run（只读，不需要 Key）。0.8：解析 tenant 后读 `<data_dir>/tenants/<id>/runs`（与执行面一致），并透传 `tenantId` |
| `src/tools-list.ts` | `--tools` 的工具清单（不构造 runtime、不需要 Key） |
| `src/headless-runner.ts` | headless 运行器 |

**0.4 CLI / TUI 入口**：

```text

vessel eval <suite-name-or-path> [--json] [--out <path>] [--filter <tag>] [--allow-network]

vessel --feishu
```

- `eval` 是位置 0 的子命令；未知子命令 → parse error（退出码 2）。
- `eval` 的报告写盘由 `@vessel-agent/evals/report.ts` 负责，asm 只传 `outDir` / `--out`。
- `--feishu` 是附加开关：TTY + 无 `--serve` → REPL + 渠道；非 TTY + 无 `--serve` →
  仅渠道前台；`--serve` → gateway + 渠道。与 `--run` / `--pipe` / `--resume-run` /
  `--tools` / `--version` / `--help` 互斥。
- TUI：`/metrics`、`/feishu`；启动横幅只在飞书已连接时追加一行。

**REPL 的职责边界**：`ReplContext` 携带 `runtime`、`pluginHost`、`session`、`events`、`context`，以及 0.3 的 `mcp` / `runs` 控制面适配器与 0.4 的 `metrics` / `feishu` 控制面适配器。`/tools` 与 `/plugins` 从 `runtime.pluginHost` 读——不再有第二个只为展示而存在的 host。`@路径` 的展开也发生在这里（见 §4）。

**用户可见行为（0.3.0；0.4 见上）**：

- `/clear` 只清屏，不清空 `ContextManager`；需要新会话用 `/new`。
- `@路径` 引用在发送前展开为注入消息，界面以引用块展示，用户原文不变。
- `/reload` 只重载配置文件并刷新 provider 信息，**不重扫插件目录**；新增插件需重启进程。
- `/mcp` 列出 server（name / status / 工具数）；`/mcp reconnect <name>` 显式重连。未配置 `mcp_servers` 时给明确提示。
- `/runs` 列出 running + interrupted（running 标注 live），按 `updated_at` 倒序、同值 `run_id` 升序，最多 20 条；`/runs resume <runId>` 恢复并继续 REPL。`durable.enabled: false` 时给明确提示。
- 启动横幅：仅当存在 MCP server 或 interrupted run 时追加一行提示；headless / serve 不输出。
- `--resume-run`：无参列出 interrupted run；有参恢复（headless 与 REPL 均支持）。与 `--run` / `--serve` / `--tools` / 位置式输入互斥。
- 自动更新：`vessel update [--check] [--channel latest|beta]` 读取 Release 的 `latest.json`，只提示版本与安装命令，不下载/不自替换。交互 REPL 启动时后台检查（24h 节流、失败静默、可关闭），有新版本时发布 `update.available`，由 TUI 渲染 banner。契约见 [operations/CI-CD.md](operations/CI-CD.md)。

## 13. Gateway 协议与 Web 控制台（0.1.0 起；0.3 扩展）

`packages/serve` 是 **EventStream 的消费者**（与 TUI 的 StreamRenderer 同构）：把 runtime 事件广播为 WS / SSE，并提供 `/v1` 控制端点；**不改 core、不经过 PluginHost**。0.18 起不再有共享事件流：gateway 只读取注入的 `TenantEventHub`，由 hub 对各 tenant 的运行时流 fan-in（见 ADR-089）。`apps/web` 是配套的浏览器控制台。

### 13.1 协议 `vessel.gateway/1`

- 服务端帧：`hello`（协议/节点信息 + `from_seq` / `latest_seq`）、`event`（带 `seq`、可选 `job_id` 与 `node_id`）、`gap`（历史被截断）、`res`（方法应答）、`ping`。
- `hello.from_seq` 是本次回放的**第一条** seq：空缓冲为 `0`；已追平时为 `since + 1`（下一条期望序号）。`latest_seq` 是当前最新 seq（空缓冲为 `0`）。
- 客户端帧：`auth`（首帧，`{ kind: 'auth', token, since?, tenant_id? }`）、`req`（`id` + `method` + `params`）、`pong`。
- **首帧鉴权（0.6 冻结）**：token 不进 WS URL / query；连接后 5s 内未收到合法 `auth` → 关闭码 4401。admin 可在 `auth` 指定 `tenant_id`；非 admin 指定其它 tenant → 4403。
- `seq` 由 gateway 分配；环形缓冲默认保留 10000 条。客户端记录 `lastSeq`，重连用 `?since=` 或 `auth.since` 续订；超出缓冲发 `gap`。
- **since / pong / seq 回退（0.6）**：客户端收到 `ping` 回 `pong`；收到 `gap` 用 `to_seq` 触发带 `since` 的重连；`hello.latest_seq < lastSeq` 时从 `since=0` 重新对齐。重连指数退避 1s → 30s 加 jitter；10s 未收到 `hello` 视为失败并重连；`close()` 清理全部定时器。
- **跨节点事件**：`event.node_id` 优先于顶层 `node_id`；远端事件由 `(node_id, wire seq)` 去重后回灌。wire seq 按各节点 / 连接分配，**没有全局序**。
- `RunStatus.run_id` 是网关级 id；`core_run_id` 在 `run.started` 后可知；事件帧的 `job_id` 用于把 core run 与网关 run 对齐。

### 13.2 端点

| 方法 / 路径 | 说明 |
|---|---|
| `GET /v1/health`（`/health` 兼容） | 开放探针；返回 clients / latest_seq / protocol / node |
| `GET /v1/events`（WS，`/ws` 兼容） | 事件流；query token 仅为兼容，0.6 客户端用首帧 `auth`，token 不进 URL |
| `GET /v1/events`（SSE，`/events` 兼容） | 只读事件流；`?token=` |
| `GET /v1/sessions`（`/sessions` 兼容） | 会话列表（`listRich`） |
| `GET /v1/tools` | 工具列表（不含 handler） |
| `GET /v1/runs?session_id=` | 当前进程运行列表 |
| `POST /v1/runs` | `{input, session_id?}` → 202 `{run_id, status, queue_position?}`；队列满 429 `busy` |
| `GET /v1/runs/:id` | 运行状态 |
| `POST /v1/runs/:id/cancel` | 取消（AbortController） |
| `POST /v1/permissions/:id` | `{decision:'allow'|'deny', remember?}` → 发布 `tool.permission.response` |
| `POST /v1/ask/:id` | `{answers:[]}` → 发布 `ask.user.answered`（空数组表示取消） |
| `GET /v1/durable/runs?status=&session_id=&limit=` | durable run 摘要列表；`status` 支持逗号分隔，缺省全部；默认 50、最大 200（0.3） |
| `POST /v1/durable/runs/:runId/resume` | 202 `{run_id, status:'queued'}`；未启用/不支持 resume → `durable_disabled`（0.3） |
| `GET /v1/mcp/servers` | `{servers:[{name,status,tools,error?}]}`；未注入 → `mcp_disabled`（0.3） |
| `GET /v1/metrics` | `{metrics: MetricsSnapshot}`；未注入 → `metrics_disabled`（0.4） |
| `GET /v1/channels/feishu` | `{channel: FeishuStatus}`；未注入 → `channel_disabled`（0.4） |
| `GET /v1/evals/latest?suite=` | `{report: EvalReport}`；无报告 → 404 `eval_not_found`（0.4） |
| `POST /v1/team/agents` | 跨节点 spawn；`request_id` 幂等去重（进程内 LRU 1000）；缺 spawn 注入 → `no_spawn`（0.6） |
| `GET /v1/team/agents` / `GET /v1/team/agents/:id` | 节点成员列表 / 单成员状态（0.6） |
| `GET /v1/team/inbox` | 成员 inbox（cursor 分页）（0.6） |
| `POST /v1/team/messages` | 跨节点消息投递；`node_id` 标识来源，按消息 `id` 入站去重（0.6） |
| `POST /run` | 0.1.0 兼容的阻塞式入口 |

WS 方法：`run.submit` / `run.cancel` / `run.get` / `sessions.list` / `tools.list` / `permission.respond` / `ask.respond`。`team.*` 在 0.1.0 返回 `method_not_allowed`（0.2 草案见 `protocol.ts`）。0.6 的跨节点 team 控制协议走 `Transport.request` → `/v1/team/*`，不进入 canonical RPC manifest。

0.3 新增稳定错误码：`run_not_found` / `run_not_resumable` / `run_already_running` / `durable_disabled` / `mcp_disabled`；`hello.features` 按实际启用增加 `durable-resume` / `mcp-status` / `tls`。

0.4 新增稳定错误码（additive）：`metrics_disabled` / `channel_disabled` / `eval_not_found`；`hello.features` 按实际启用增加 `evals` / `feishu` / `metrics`。HTTP 映射：404 `*_not_found`；503 `*_disabled`；400 `invalid_request`。

### 13.3 G1：权限与 ask_user 桥

- gateway 订阅 `tool.permission.request` 建立待答表；`POST /v1/permissions/:id` 或 WS `permission.respond` 发布 `tool.permission.response`。Web 弹窗支持 allow / deny / always（remember）。
- `ask.user.requested` 同理：`POST /v1/ask/:id` 或 `ask.respond` 发布 `ask.user.answered`。
- 不引入直接回调：工具与 UI 仍只通过事件流沟通（ADR-029）。

### 13.4 G2：会话切换

`GatewayOptions.context` 存在且目标 session 与当前不同时：先 `context.setSessionId(target)` 再 `context.clear()`，随后 `runtime.run` 从 `SessionBackend` 重载目标会话历史。没有 `context` 时无法保证隔离（需装配层传入）。

### 13.5 静态托管与安全

- `staticDir` 存在时，GET/HEAD 的非 API 路径托管 `apps/web/dist`；无扩展名路径回落 `index.html`（SPA）；路径解析后校验 root 前缀，防穿越；API 路径永不托管。
- 默认绑定 `127.0.0.1`；Host 只接受 `127.0.0.1` / `localhost` / `[::1]` 或显式 `hostname`。
- **Origin allowlist（0.6）**：`serve.allowed_origins` / `--allowed-origin` 在启动时归一化为 `URL.origin`，拒绝 `*`、path、query；HTTP 与 WS upgrade 共用同一判定，无 Origin 放行（curl / peer），浏览器必须同源或在 allowlist。
- **CORS（0.6）**：预检命中 allowlist 返回 204，只回 `Access-Control-Allow-Origin` / `Methods` / `Headers` / `Max-Age`；永不使用 `*`，不使用 credentials。allowlist 非空时所有响应带 `Vary: Origin`。
- **CSP（0.6）**：移除裸 `ws:` / `wss:`；`connect-src` 由 Host 与 allowlist 动态生成，其余策略保持 `script-src 'self'`。独立静态站点自行下发 CSP。
- token 来源优先级：`config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`。生成值 32B 随机 base64url，恒定时间比较；WS 5s 未鉴权关闭 4401。
- 事件流是长连接：`Bun.serve` 的 `idleTimeout` 默认 `0`（禁用，可用 `GatewayOptions.idleTimeout` 覆盖）；heartbeat 默认 15s，SSE 发 `: ping` 注释、WS 发 `ping` 帧，用于穿透代理与检测死客户端。
- 请求体上限 1 MiB（RPC / legacy REST / 跨节点消息端点一致）；慢客户端 `bufferedAmount > 4 MiB` 断开（1013）。
- **0.4 背压**：gateway `SeqEventBuffer` 缺省 10000，**永不无界**，与 core `observability.event_history` 的 `0 = unlimited` 语义独立、不被覆盖。WS high 2 MiB / low 512 KiB / 硬关闭 4 MiB；SSE high 256 帧 / low 64 帧；超过阈值先丢事件并标记 `gap`，4 MiB 硬断开作为最后手段。gateway `stop()` 不关闭 asm 注入的 collector / channel，生命周期归 asm。

### 13.5.1 远程监听与 TLS（0.3；0.6 收紧为 TLS 强制）

- **默认不变**：`127.0.0.1:8642`、明文、token 来源优先级不变。
- **远程 opt-in**：`serve.allow_remote: true` 或 `--allow-remote`；非回环 hostname 未显式允许时启动失败。
- **远程必须 token**：非回环必须有非空 gateway token（配置 / `VESSEL_GATEWAY_TOKEN` / 自动生成）；不得匿名。
- **远程必须 TLS（0.6 行为变更）**：非回环监听在 0.6 起必须同时提供 `serve.tls.cert_file` + `key_file`（或 `--tls-cert` / `--tls-key`），否则启动失败；不再允许明文远程。回环仍可在无 TLS 下运行，也可显式启 TLS。
- **无逃生口**：不提供 `--insecure` / `-k`；证书、token、Origin 任一不满足即 fail-closed，不静默降级。
- **独立前端 Origin**：`serve.allowed_origins` 或重复 `--allowed-origin`；与 HTTP / WS 共用 allowlist，规则见 §13.5。
- **只做 HTTP/1.1**：不做 HTTP/2 / ALPN / mTLS / ACME；HTTPS 与 WSS 共用同一 server、token、Host/Origin 规则。
- `hello.features` 在启用 TLS 时增加 `tls`；不新增 `remote` feature。细节见 ADR-041 / ADR-051 / ADR-053。
- **已知行为**：监听 `0.0.0.0` 时，banner / `hello.node.endpoint` 仍显示 `http://0.0.0.0:<port>`；其它机器访问需替换为实际 IP / 域名，且证书 SAN 必须匹配。这是显示层行为，不改变监听/鉴权。

### 13.6 Web 控制台（`apps/web`）

- React + Vite；`GatewayClient` 用 WS 收事件，`seq` 去重、断线重连（`since`）、gap 提示。
- token 存 URL fragment，再转 `sessionStorage`；不写 `localStorage`、不进 URL query。
- **运行时 gateway URL（0.6）**：优先级 `localStorage['vessel.gateway-url']` > `VITE_GATEWAY_URL` > 同源；只接受 `http(s)://host[:port]` origin，拒绝 path / query / hash / userinfo / wildcard；非回环必须 https，HTTPS 页面拒绝 http/ws（mixed content）。换 URL 时重建 client 并重置 seq / 时间线 / 选中会话。
- **独立前端（0.6）**：可把 `apps/web/dist` 部署到任意静态站点；服务端配置 `serve.allowed_origins` 允许该 Origin（CORS + WS upgrade），浏览器需信任 gateway 证书。同源部署仍由 gateway 托管 `dist`。
- 功能：运行提交/取消、时间线、会话列表、工具端点、权限弹窗、ask_user 表单。
- 0.3：按 `hello.features` 显示 **MCP server 面板**（`mcp-status`）与 **interrupted run 面板**（`durable-resume`），可触发 durable resume；未启用的 feature 不显示面板。面板 10s 刷新。
- 0.4：按 `hello.features` 显示 **metrics 快照**与 **飞书状态**（`metrics` / `feishu`）；evals 只做 `GET /v1/evals/latest`，不做面板。
- 开发：`cd apps/web && npm run dev`（Vite 代理 `/v1` 与 `/health` 到 `127.0.0.1:8642`，`changeOrigin:false` 保持同源）；生产：gateway 托管 `dist`。
- 已知限制：单 runtime / 单 context，并发固定 1（队列上限 100）；运行与事件历史在内存，重启丢失；无自动化浏览器测试。
- 0.6.1：Markdown 渲染、`sessions.search` 全文检索、工具事件 `args` / `result` 折叠，见 §18.6。
- **接线（已完成）**：CLI 给 `startGateway` 传 `events` / `session` / `runtime` / `context` / `pluginHost` / `staticDir` / `durable` / `mcp`；`staticDir` 取 `VESSEL_STATIC_DIR`，否则仓库内 `apps/web/dist` 存在时使用。因此 G2、静态托管、durable/MCP 面板在 `--serve` 下生效。

### 13.7 统一 RPC 方法表（0.5）

- **信封**：请求 `{ v: 1, id, method, params? }`；成功 `{ v: 1, id, ok: true, result }`；失败 `{ v: 1, id, ok: false, error: { code, message, details? } }`。HTTP 入口 `POST /v1/rpc`；WS 复用 `req` / `res`。
- **canonical 方法（v1.1）**：`health.get`；`capabilities.list`；`config.get` / `config.sources` / `config.set`（0.15，write）；`sessions.list|get|search|delete|rename`；`runs.list|get|start|cancel|resume`；`agents.list|get`（0.14，read）/ `agents.tree`（0.15，read）；`tasks.list|get`（0.15，read）；`events.list|subscribe`；`tools.list`；`plugins.list`；`metrics.get`（`source: live|trace`）/ `metrics.reset`；`trace.prune`；`tenants.list|get|create|update`；`permission.respond` / `ask.respond`；`interactions.list`（0.18，read）；`evals.run|latest`；`feishu.status`；`mcp.list|reconnect`；`gateway.reload`（0.12，admin-only，缺省 `not_supported`）；`teams.list|get|post|members|budget`（S3 / S4）；`auth.exchange` / `auth.revoke` / `auth.tokens`（S5 hub 控制面）。

<!-- rpc-methods:begin -->
| 方法 | permission |
|---|---|
| `health.get` | read |
| `capabilities.list` | read |
| `config.get` | read |
| `config.sources` | read |
| `config.set` | write |
| `sessions.list` | read |
| `sessions.get` | read |
| `sessions.search` | read |
| `sessions.delete` | write |
| `sessions.rename` | write |
| `runs.list` | read |
| `runs.get` | read |
| `runs.start` | write |
| `runs.cancel` | write |
| `runs.resume` | write |
| `agents.list` | read |
| `agents.get` | read |
| `agents.tree` | read |
| `tasks.list` | read |
| `tasks.get` | read |
| `events.list` | read |
| `events.subscribe` | read |
| `tools.list` | read |
| `plugins.list` | read |
| `metrics.get` | read |
| `metrics.reset` | write |
| `mcp.list` | read |
| `mcp.reconnect` | write |
| `trace.prune` | admin |
| `tenants.list` | admin |
| `tenants.get` | read |
| `tenants.create` | admin |
| `tenants.update` | admin |
| `permission.respond` | write |
| `ask.respond` | write |
| `interactions.list` | read |
| `evals.latest` | read |
| `evals.run` | write |
| `feishu.status` | read |
| `gateway.reload` | admin |
| `teams.list` | read |
| `teams.get` | read |
| `teams.post` | write |
| `teams.members` | write |
| `teams.budget` | write |
| `auth.exchange` | write |
| `auth.revoke` | admin |
| `auth.tokens` | admin |
<!-- rpc-methods:end -->

0.19 S3 + S5 + S4 起 canonical 方法总数 **48**（47 个 domain 方法 + `events.subscribe`）；0.20 的 fork 与跨节点 federation 不新增 canonical，仍为 **48**。0.19 S3 新增 `teams.list` / `teams.get`（`read`）与 `teams.post` / `teams.members`（`write`，`add|remove`），由结构化 `TeamControlLike` 注入，未注入时返回 `not_found`；canonical 是复数 `teams.*`，与 legacy `team.*`（单数前缀）无关。0.19 S4 新增 `teams.budget`（`write`，`status|override`），同样由 `TeamControlLike` 注入；它**不在** team-scoped control token 白名单，未注入时返回 `not_found`。0.19 S5 新增 `auth.exchange`（`write`）、`auth.revoke` / `auth.tokens`（`admin`），用于 hub 控制面的短期 token 交换与吊销。0.18 移除 workflow 的 5 个方法（`workflow.list|start|get|resume|cancel`，ADR-090），并新增只读 `interactions.list`（`read`，tenant 作用域，返回 pending / answered / orphaned 权限与 ask；0.19 S4 起 ask 也持久化）。0.15 新增 `agents.tree` / `tasks.list` / `tasks.get` / `config.set`（0.14 时为 40；0.15 起为 44）。

- **legacy-only（不进 manifest）**：`team.*`、`durable.*`、WS `run.submit|get|cancel`。
- **HTTP 语义**：信封合法时方法成功或方法级失败都返回 200（失败体 `ok:false`）；400 `invalid_params`（旧路径 `invalid_request`）；401 `unauthorized`；403 `forbidden`；413 体过大；未知方法 200 `not_found`（`details.method`）；500 `internal`。旧 REST 适配器保留 0.4 路径、请求/响应体、状态码与错误码。
- **events**：`events.list` 支持 `run_id` / `since_seq` / `since_ts` / `types` / `type_prefix` / `limit`（默认 50、最大 500），按 `(seq ?? ts)` 升序。`events.subscribe` 支持 `since`（gateway wire seq）/ `since_ts` / `run_id` / `types` / `all_tenants`（仅 admin）。RPC 回调为 `{ method: 'events.event', params: RunEvent }`；WS 旧 `{ kind: 'event', event }` 不变。
- **manifest**：`capabilities.list` 返回 `{ version, config_schema_version: 1, methods: [{ name, params_schema?, result_schema?, permission }], tools, plugins }`；只含 canonical 方法。A-6.3：manifest 按 `ctx.tenantId` 生成，tools / plugins 取 `pluginHostFor` / `pluginsFor`（缺省回退全局）；`trace.readEvents(filter, tenantId)` 与 `sessionData.deleteSessionData(sessionId, tenantId)` 由 web 传入当前 tenant，asm 已按 tenant 路由到对应的 trace 目录与 session backend。
- **客户端**：`RpcClient` 有 `request()` + `subscribe()`；`LocalRpcClient` / `HttpRpcClient`。CLI/TUI 不绕开方法表。0.8：本地 `subscribe()` 由装配层桥接到 `runtimeEvents`（每条 `RunEvent` 包成 `{ method: 'events.event', params }`），是只读旁路，不写回事件流；`/runs resume` 因此能收到终态而不是挂起。`--connect <url>` / `VESSEL_CONNECT` 使用 `HttpRpcClient`、不取 tenant 写锁、不写本地 store / trace；回环可明文，非回环必须 HTTPS + token。未设置时用 `LocalRpcClient` 并取锁。
- **远程客户端（0.6）**：token 解析顺序 `--connect-token` > env（`VESSEL_CONNECT_TOKEN` / `connect.token_env`）> `connect.token`；CA 用 `--ca` / `connect.ca_file`。建连后 `health.get` 取远端 tenant / node；显式 `--tenant` 才把 `tenant_id` 合并进请求（admin 覆盖），否则由 token principal 决定。connect 模式下 `permission.respond` / `ask.respond` 经 RPC 回远端；TUI / headless 同路径。
- **tenant**：token → principal（`serve.token`→default/admin、`serve.tokens` 按条目、`serve.admin_token`→`*`/admin、回环无 token→default/admin）；非 admin 指定其它 tenant → `forbidden`；跨 tenant 读取 → `not_found`；一个 gateway 服务 N tenant（工厂缺省时非 default tenant `forbidden`）。0.8：durable REST 端点允许 admin 通过 query `tenant_id` 或 `X-Vessel-Tenant` 显式指定 tenant，两处同时出现且不一致 → 400；其余角色仍按 principal 作用域。
- **错误码**：方法级错误一律 `ok:false`，HTTP 200；冻结集合 `unauthorized` / `forbidden` / `not_found` / `invalid_params` / `tenant_locked` / `quota_exceeded` / `conflict` / `internal` / `not_supported`（0.12：可选能力未注入）。旧路径保留 0.4 错误码映射。

### 13.8 0.6 远程控制面与跨节点 transport

> 状态：已合入 `release/0.6`（未发布）；决策见 ADR-051 / ADR-052 / ADR-053。

**远程客户端（CLI / TUI / headless）**

- `--connect` / `VESSEL_CONNECT` 指向 gateway origin；非回环强制 HTTPS，token 缺失在发起网络请求前失败。
- WS 首帧 `auth` 带 token + `since`；解析 `hello` / `event` / `gap` / `ping`，`ping` → `pong`，`gap.to_seq` 触发 `since` 重连，`hello.latest_seq < lastSeq` 从 0 重新对齐；退避 1s → 30s + jitter，10s hello 超时。
- `health.get` 返回远端 `tenant_id` / `node_id`；CLI 在 stderr（headless）或 TUI 状态行展示；TUI 不污染 stdout。
- connect 模式不获取本地 tenant 写锁、不写本地 store / trace；交互回路由事件流转为 `permission.respond` / `ask.respond` RPC。

**0.6.1 的安全收紧**：durable 端点按 principal 的 tenant 过滤并校验 `write`；team REST 复用 `ROLE_RANK`；事件回灌丢弃本机来源帧；远端 spawn 复用 `buildChildHost`。见 §18.2 / §18.7。

**节点注册与远程 Transport（asm）**

- `transport.kind: remote` + 静态 `transport.nodes[]`（`id` / `url` / `token` / `token_env` / `ca_file`）；不做 mDNS / 自动发现。
- `src/node-registry.ts`：节点 URL 归一化（非回环必须 https），token 显式值 > env，CA 读取为 PEM；心跳 `GET /v1/team/agents`（失败回退 `/health`），状态 `healthy` / `unreachable`，默认心跳 5s、展示 TTL 15s。
- `src/remote-transport.ts`：`kind: 'remote'`；`send` 走 `POST /v1/team/messages`（Bearer + 可选 CA），`request` 走团队控制协议；错误统一 `RemoteTransportError`，冻结码 `transport_closed` / `peer_not_found` / `peer_unreachable` / `timeout` / `unauthorized` / `unsupported_protocol` / `invalid_request` / `agent_not_found` / `no_spawn`。
- **事件扇出**：按节点订阅 `ws(s)://<node>/v1/events`，按 `(node_id, wire seq)` 去重（LRU 上限 10000）后回灌，补 `RunEvent.node_id`；断线指数退避 + `since` 续放；`seq` 按 `(node_id, run_id)` 解释，无全局序。
- **投递语义**：入站消息按 `id` 去重（LRU 10000）；`spawn` 带 `request_id` 去重（gateway 进程内 Map，上限 1000），不自动重试；`status` / `inbox` 超时或不可达最多重试一次并复用 `request_id`；结果回投失败只发 `team.transport.error`。
- **tenant**：远端 tenant 由 token principal 派生，不从 `AgentMessage` 取；跨节点 team 控制面 default/admin-only（非 default tenant → 403）。

**已知限制（0.6）**

- 无全局事件序、无分布式锁、无跨机 durable、无 mTLS、无节点自动发现。
- `request_id` 去重不跨重启；同 key 不同参数返回首次结果。
- 远端事件缺 `tenant_id` 时回灌按 default 归属，需 gateway 保证租户字段。
- 自签证书 SAN 必须匹配目标 host/IP；浏览器无法按连接指定 CA。

### 13.9 Gateway 拆分第一阶段（0.8.1）

> 纯结构重构：公开导出、协议帧与运行时行为均不变；只把无状态辅助逻辑移出 `gateway.ts`。

- **新模块**（`packages/serve/src/gateway/`）：
  - `auth.ts`：回环 / 通配 host 判定、TLS cert/key 读取、Origin allowlist 归一化、CSP / CORS、Host 校验。均为无状态函数或只读文件操作。
  - `frames.ts`：`hello` / `event` / `gap` / `error` / `result` 帧构造，事件来源节点选择，以及 `agent.*` / `team.*` 的 wire snake_case 映射。
  - `sse.ts`：SSE 高 / 低水位（256 / 64 帧）、每次 pull 的回放批大小（64）、回放泵、gap 刷新与带背压的帧写入。连接状态仍由调用方持有。
  - `static.ts`：静态站点路径解析、越界 403、目录 → `index.html` 回退与缓存头；不再持有 `startGateway` 闭包。
- `gateway.ts` 从 4172 行降到 3886 行；保留 `startGateway`、`GatewayOptions`、`Gateway` 与既有 auth 辅助函数的公开导出。`gateway.ts` 继续负责路由、连接状态与编排。
- 新增纯函数测试（`packages/serve/__tests__/gateway.pure.test.ts`）覆盖帧构造、Origin / Host 判定与静态路径。
- **非目标**：本阶段不拆分路由与连接状态机，不改变 WS / SSE / RPC 的 wire 行为；后续阶段留给 Wave 2。

## 14. 0.2 Kernel 与模块边界（已实现，未发布）

> **状态：已实现（0.2 分支起），未随版本发布。** 本节描述 Kernel / Modules / Transport 的事实；0.3 的能力见 §14.6 与正文 §5/§8/§9/§13。当前发布行为以 §1–§13 为准。决策依据见 [ADR-037](adr/ADR-037-modular-agent-runtime.md)。
> 0.2 不重写 loop、不删除公开 API；新能力默认 off / opt-in。

### 14.1 定位与分层（已实现）

- **定位**：Vessel 是可嵌入的**多 agent 平台 runtime**；TUI / CLI / Web / Gateway 是参考 harness 外壳，只消费 runtime 的 SDK 与事件。
- **分层**：`Contracts ← Kernel ← Modules ← SDK ← Shells`；`Plugins` 只依赖 Contracts / 公开 API，经 `PluginHost` 在运行期 install。依赖方向单向，并由 CI 自动检查。
- **Module ≠ Plugin**：Module 是编译期/构造期边界（一个 port 一个实现）；Plugin 仍是唯一运行期扩展机制。**不引入 `ModuleHost` / `ModuleRegistry` / 第二套扩展机制。**
- **0.2 非目标（0.3–0.6 已部分重启）**：0.2 不做 durable execution / workflow / evals / MCP / 多租户 / 远程监听 / TLS / 跨机器调度 / 单二进制主分发。0.3 已实现 durable / MCP / 远程监听 / TLS；0.4 以插件实现 workflow / evals / 飞书（workflow 已于 2026-10-22 移除，ADR-090）；0.5 实现多租户；0.6 实现跨机器远程与跨节点 transport；单二进制仍非目标。

### 14.2 Kernel（已实现）

| 类型 | 职责 | 状态 |
|---|---|---|
| `RuntimeHost` | 成员注册、生命周期、发现；替换插件内 `InProcessRuntimeHost` | 已实现 |
| `AgentHandle` | 成员句柄：`status()` / `run()` / `send()` / `inbox()` / `cancel()` / `close()` | 已实现 |
| `RunHandle` | 一次 run 的句柄：`id` / `agentId` / `status()` / `result` / `cancel()` | 已实现 |
| `Scheduler` | 全局 FIFO、并发上限（默认 1）、同成员串行、排队/运行取消、限额 | 已实现 |
| `EventBus` | Host 级事件总线；实现 `EventStream`，增加按 agent/run/前缀过滤 | 已实现 |
| `Cancellation` / `Limits` | 父子取消传播；run + agent 两级限额（host 预算接口预留） | 已实现 |

`AgentRuntime` 继续是**单 agent loop**；Host 包在它外面，负责注册、生命周期、调度与消息，**不重写循环**。

### 14.3 模块与 subpath exports（已实现）

| 模块 | Port | 计划入口 |
|---|---|---|
| provider | `LLMProvider` | `@vessel-agent/core/provider` |
| context | `ContextManager` | `@vessel-agent/core/context` |
| session | `SessionBackend` | `@vessel-agent/core/session` |
| policy | `PermissionPolicy` / `GuardrailRunner` / `HookRunner` | `@vessel-agent/core/policy` |
| transport | `Transport`（新增） | `@vessel-agent/core/transport` |
| observability | `EventStore`（新增）+ `EventStream` | `@vessel-agent/core/observability` |
| kernel | Host / Scheduler / Handles | `@vessel-agent/core/kernel` |

0.2 **只在 `@vessel-agent/core` 内做 ports & adapters + subpath exports，不拆包**；根入口继续 re-export 全部现有符号。依赖规则：`types/**` 不 import 实现；模块之间只经 port 交互；`kernel` 只依赖 port 类型（默认实现允许 F5 白名单：`AgentRuntime` + `MemoryContextManager` / `MemoryEventStream` / `MemoryPluginHost`，且必须可经 options 覆盖）；模块不得反向依赖 `src/**` / `packages/serve` / `plugins/**`。

### 14.4 Transport（已实现）

- 0.2 只做 **in-process** 与 **loopback HTTP** 两种实现；loopback 只绑 `127.0.0.1`，复用 gateway v1 的 token 鉴权，禁止 `0.0.0.0`。
- 消息带 `protocol: 1`；in-process 失败不得影响本机路径；loopback 失败只降级该传输。
- **0.6 additive**：`kind` 扩为 `'in-process' | 'loopback' | 'remote'`；新增可选 `nodeId?` 与 `request?<T>(nodeId, { requestId?, method, params? })`；`RunEvent.node_id?` / `EventFilter.nodeId?`。`request` 是领域无关 port 能力，不含 team 语义。远程实现与节点注册见 §13.8。
- 远程监听 / TLS / 跨机器发现 / 消息持久化不在 0.2；跨机器传输在 0.6 以静态节点表实现，仍不做自动发现与消息持久化。

### 14.5 兼容与迁移（已实现）

- **冻结**：9 接口、`AgentRuntime` 公开面、`RunOptions` / `RunEvent`、事件名、插件机制、根导出面；0.2 只做加法与内部替换，不删除公开 API。
- `delegate_task` 改为 Host 上的**一次性临时成员**（工具名与语义不变）；`@vessel-agent/team` 改为**持久成员**；二者共用 `RuntimeHost`。
- `@vessel-agent/team` 的 `InProcessRuntimeHost` 在 0.2 标 `@deprecated` 并适配到 core Host；**0.3 已移除**该兼容路径与 `LegacyHostAdapter`。
- 事件：core TS 内部用 camelCase（`agentId`），gateway JSON 用 snake_case（`agent_id`），映射只在 gateway 边界做一次；事件名仍是开放字符串。
- 依赖方向由 CI 自动检查（`scripts/check-deps.ts`），不只写在文档里。

### 14.6 0.3 平台能力（已实现）

| 能力 | 落地位置 | 边界 |
|---|---|---|
| Durable run | `packages/core/src/types/run-store.ts` + `session/run-store.ts`；`AgentRuntime.resume` / `RuntimeHost.resume` | 本机 file/memory；resume 并发守卫 per-Host / per-store-instance（ADR-040） |
| MCP client | `plugins/mcp/client/`（`@vessel-agent/mcp-client`） | 插件，不是 core 模块；stdio + HTTP；默认 ask（ADR-039） |
| 远程 / TLS | `packages/serve/src/gateway.ts` + `src/serve-config.ts` | 显式 opt-in；非回环必须 token；HTTP/1.1（ADR-041） |
| 控制面 | `packages/serve/src/{durable,mcp}.ts`；TUI `/mcp` `/runs`；CLI `--resume-run` | 0.3 新增端点见 §13.2；命令见 §12 |
| 跨机器远程 / 跨节点 | `packages/serve/src/gateway.ts`；`src/rpc/http-client.ts`；`src/remote-transport.ts` / `src/node-registry.ts` | 显式 opt-in；非回环 TLS + token；静态节点表；ADR-051 / 052 / 053；见 §13.8 |

## 15. 0.4 能力层（release/0.4，未发布）

> 0.4 的主题是「可编排、可评测、可观测、可对话」。两个能力（evals / 飞书）全部是**插件**；workflow 已于 2026-10-22 移除（ADR-090）。
> core 只新增可观测性/稳定性原语；决策见 ADR-043 / 044 / 045（ADR-042 已由 ADR-090 取代）。
> 默认全部关闭；三个新配置块（evals / 飞书 / metrics）缺省时行为与 0.3 一致。

### 15.1 Evals（`@vessel-agent/evals`）

- **位置与形态**：`plugins/evals/harness/`；库 + 运行器，加入 `FACTORY_PLUGINS`
  仅为阻止被当作普通插件扫描；**不注册工具**；asm CLI 直接调用库函数。
- **默认离线**：只使用脚本化 mock provider。真实 provider 需要
  `config.evals.allowNetwork === true` **且** CLI `--allow-network` 同时成立；
  任一缺失 → `eval_network_required`，exit 2；报告 `network: true`。
- **Suite**：YAML/JSON；`defaults.timeout_ms` / `tags` / `session: fresh|shared`；
  `mock.responses` 按序回放，耗尽记 `mock_exhausted` 警告。
- **断言白名单**：`output_contains` / `output_matches` / `no_error` / `tool_called` /
  `tool_not_called` / `max_duration_ms` / `max_iterations` / `usage_under`；
  未知类型 = 配置错误，不执行任意代码。
- **报告**：**命名、写盘、latest 查找由 `report.ts` 负责**；文件名
  `<suite>-<YYYYMMDDTHHmmssSSSZ>.json`；`--out` 覆盖；`findLatestReport` 按
  `finished_at` 倒序取第一条，损坏文件跳过。asm 只传 `outDir` / `--out` 并处理
  `--json` 的 stdout，不重复实现写盘。
- **退出码**：0 全部 passed/skipped；1 存在 failed/error；2 suite 解析/配置错误；
  `evals.enabled: false` → `eval_invalid`（消息注明 disabled），exit 2。
- **入口**：CLI `vessel eval`；gateway 只读 `GET /v1/evals/latest`；不做面板。

### 15.2 飞书（`@vessel-agent/feishu`）

- **位置与形态**：`plugins/im/feishu/`，工厂式插件；官方 SDK 只在该插件包，
  core 依赖保持为空；所有网络交互藏在 `FeishuTransport` 后，测试/CI 用 mock。
- **专用 Host**：渠道自建专用 `InProcessRuntimeHost`（`maxMembers =
  feishu.max_members`，默认 8，范围 1..64）；per-chat 懒 spawn 成员，
  `sessionId = feishu:<chat_id>`，agent id `feishu_<sanitized chat_id>`；
  同一 chat 串行，不同 chat 并行；达到成员上限新 chat 回 `busy`，不逐出。
- **行为**：只处理 `im.message.receive_v1` 的 text；忽略机器人自己、非文本、重复
  `message_id`（LRU 1000，去重先于业务过滤，非文本也登记）。单 chat 队列 10
  （只计 pending）；`im.message.reply` 到原消息；超过 `max_reply_chars` 截断并追加
  `…(truncated)`；`reply_timeout_ms` 到期取消该 run。
- **配置**：`enabled / app_id / app_secret / domain / allowed_chat_ids /
  session_prefix / reply_timeout_ms / max_reply_chars / max_members`；
  env `VESSEL_FEISHU_APP_ID` / `VESSEL_FEISHU_APP_SECRET` 优先；
  **`agent_id` 已删除，严格按未知键拒绝**。
- **凭据**：`app_secret` 永不打印；`app_id` 只显示前 4 位 + `***`。
- **运行模式**：TTY + 无 `--serve` → REPL + 渠道；非 TTY + 无 `--serve` → 仅渠道
  前台（阻塞到 SIGINT/SIGTERM）；`--serve` → gateway + 渠道。`--feishu` 与
  `--run` / `--pipe` / `--resume-run` / `--tools` / `--version` / `--help` 互斥。
- **状态/错误**：`FeishuStatus` / `FeishuChannel`；`channel_disabled` /
  `channel_not_connected` / `channel_auth_failed`；事件 `channel.feishu.*`。
- **退出码**：配置错误 2；运行期连接/SDK 失败 1；SIGINT 130；SIGTERM 143。

### 15.3 边界

- 0.4 **不注册** 任何 eval/feishu 工具；工具口径不变。
- 不做多租户、跨机器编排、飞书富媒体/卡片/thread/多机器人/
  OAuth、个人微信。微信公众号/企业微信留 0.5 评估。
- 0.4 **不 tag、不 publish、不合并 `main`**；只做发布干跑。

## 16. 0.4 可观测性与稳定性

### 16.1 `MetricsCollector`

- 位置：`packages/core/src/observability/metrics.ts`；从根入口与
  `@vessel-agent/core/observability` 导出。
- **`./observability` subpath 不是 0.4 新增**：0.3 已存在（当时指向
  `src/events/index.ts`）；0.4 把它**改指**到新的 `src/observability/index.ts` barrel，
  继续 re-export 原 events 符号。
- 订阅既有事件：`run.started` / `run.completed` / `run.failed` / `run.cancelled` /
  `tool.call.started` / `tool.call.failed` / `llm.response`；**不新增事件、不改 runtime**。
- `MetricsSnapshot`：`runs` / `tool_calls` / `llm` / `duration_ms` / `updated_at`。
  `duration_ms.avg` 以 completed + failed 为分母；无样本为 0。
- **`runs.cancelled` 保持 0**：取消计入 `runs.failed`（core 取消路径发 `run.failed`）；
  resume 不计 `runs.started`，按终态计 completed/failed，因此 `completed` 可能大于
  `started`。
- 进程内聚合，不持久化、不跨 Host 合并；`observability.metrics: false` 彻底关闭
  collector 注入与 gateway/TUI 控制面。

### 16.2 事件历史上限

- `MemoryEventStreamOptions.maxHistory`：**缺省 1000**；显式 `0` = 不限制；
  `>0` = 环形缓冲，`getHistory()` 不超过 N。
- 构造函数接受 `MemoryEventStreamOptions | number`，数字形式保持 0.3 语义；
  `MemoryEventBus` 增加可选 `MemoryEventStreamOptions` 构造参数。
- `replayRun` / `FileEventStore` 语义不变；`FileEventStore` 不自动轮转。

### 16.3 `pruneRuns`

- `pruneRuns(store, opts?)`：仅给 `status` → 删除全部匹配项；
  `older_than_ms` / `keep_latest` 至少一个才做年龄/保留裁剪；`keep_latest` 在
  status 过滤后的集合内按 `updated_at` 倒序、`run_id` 升序；`keep_latest = 0`
  删除全部匹配项；完全无条件 → 不删除。
- `kept` = 操作后仍保留的、符合 `status` 过滤的条目数；`RunStore.list` 的 200
  上限不可精确统计，`keep_latest > 200` 不保证精确。
- **不修改 `RunStore` 接口**；不自动调度，由用户/运维显式调用。

### 16.4 Gateway 背压

- `SeqEventBuffer` 缺省 10000，**永不无界**；与 core `event_history` 独立。
- WS high 2 MiB / low 512 KiB / 硬关闭 4 MiB；SSE high 256 帧 / low 64 帧；
  超阈值先丢事件并标记 `gap`，4 MiB 硬断开作为最后手段。
- 单请求体仍限 1 MiB；鉴权 / Host / Origin 规则见 §13.5；0.6 起非回环强制 TLS。
- gateway `stop()` 不关闭 asm 注入的 collector / channel，生命周期归 asm。

### 16.5 加固

- `AgentRuntime` compact 后事件与消息不重复、不丢最后一条用户消息。
- `InProcessRuntimeHost` 关闭路径清理成员、排队 run、交互请求；100 次
  spawn/close 循环后内部 Map 无残留。
- `Scheduler` 队列满、并发取消、同成员串行不得死锁。

### 16.6 已知限制（0.4）

- 飞书只支持文本、单 chat 单 session；不做 thread 区分与富媒体。
- `MetricsCollector` 是进程内聚合，不持久化；多 Host 不合并。
- `pruneRuns` 是 helper，不自动调度。
- 事件历史上限只作用于 `MemoryEventStream`；`FileEventStore` 不自动轮转。
- 发布干跑通过不代表 npm 凭据、2FA、provenance 的线上配置已完成。

## 17. 0.5 文件优先存储、trace、RPC 与多租户

> 状态：0.5（`release/0.5`，未发布）。实现事实；决策依据见 [ADR-046](adr/ADR-046-file-first-storage.md) ~ [ADR-050](adr/ADR-050-yaml-first-config-and-secrets.md)。

### 17.1 数据根与 tenant 布局

```text
<data_dir>/tenants/<tenant_id>/
  .lock                         # pid + started_at + host
  sessions/<session_id>.json    # 会话快照（原子写）
  runs/<run_id>.json            # durable checkpoint
  events/<run_id>.jsonl         # append-only trace
  tenant.json                   # name / created_at / quota / status
```

`data_dir` 默认 `~/.vessel/data`（`VESSEL_DATA_DIR` 覆盖）；`tenant_id` 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，缺省 `default`，拒绝路径穿越。`RunState` / `SessionInfo` / `RunCheckpoint` 增可选 `tenant_id?`；SQLite backend 增 `tenant_id` 列；缺失视为 `default`。

### 17.2 原子写、单写者与删除

session 快照与 run checkpoint 使用同目录 temp + rename；Windows 失败重试 3 次，失败抛 `AtomicWriteError`。0.8.1 起 `atomicWrite` 默认 durable：temp 文件 `fsync` 后才 rename，rename 后尽力 `fsync` 目录；文件 fsync 失败抛 `AtomicWriteError` 且不 rename，目录 fsync 失败忽略（Windows 常不可用）。`durable: false` 恢复 0.5 的旧行为。

同一 tenant 同时只允许一个写者：`.lock` 存在且非 stale 时返回 `tenant_locked`（stale = pid 不存在或超过 24h）；gateway 是运行时唯一写者，CLI/TUI 取锁或走 gateway RPC。`deleteSessionData(sessionId, opts)` 返回 `{ sessions_deleted, runs_deleted, events_deleted }`；0.8.1 起冲突检查以 `limit: 200` + `offset` 全量分页遍历该 session 的 run（页数上限 10,000），有 `running` / `interrupted` 时 `conflict` 且零删除。文件存在但不可读 / JSON 损坏时抛 `SessionCorruptError`（`session_corrupt`），不得当成不存在覆盖或删除；`listRich` 对损坏项降级跳过。列表允许 O(N)，0.5 上限单 tenant 5,000 sessions / 20,000 runs。

### 17.3 trace 与重放

见 §10.5。默认 `full`、30 天 / 1000 runs / 1 GiB；`metadata` 白名单与截断；溢出写 `trace.overflow`；`readTraceEvents` 默认 50 / 最大 500、`(seq ?? ts)` 升序、跳过损坏行；`rebuildMetrics` 与实时 collector 一致。

### 17.4 RPC 方法表

见 §13.7。canonical v1.1 方法 + legacy-only 列表 + HTTP 语义 + capability manifest；CLI/TUI 走 `RpcClient`；旧 REST 端点保留为兼容别名。

### 17.5 tenant 隔离与 quota

解析顺序：显式 `RuntimeOptions.tenantId` → `--tenant` → `VESSEL_TENANT` → `tenant.default` → `default`。隔离覆盖存储、配置、工具、权限、quota、trace 与 RPC。tenant overlay 优先级 `CLI > env > tenant overlay > project > user > default`；允许块与禁止块见 ADR-049。quota 超限返回 `quota_exceeded` 且不落半成品；跨 tenant 读取 `not_found`；`status: disabled` 拒绝写，0.5 不做 `--purge`。一个 gateway 可服务 N 个 tenant，但非 default tenant 需要显式工厂。插件 tenant 行为已由 ext 合入（每 tenant 独立实例、不追加 `tenants/<id>`、`eval.run.*` 事件、按 tenant 合并插件配置）。A-6 的 web 接口增量（`pluginsFor`、per-tenant `capabilities.list` / `plugins.list`、`trace.readEvents(filter, tenantId)`、`sessionData.deleteSessionData(sessionId, tenantId)`）与 asm 的 `--serve` per-tenant 执行面（config / provider / session / run store / context / PluginHost / trace / metrics / redactor / sessionControl、独立 EventStream、per-tenant writer lock）**均已实现**。disabled / 未配置 tenant → `forbidden`，锁冲突 → `tenant_locked`。已知限制：gateway 的飞书控制面仍只走 default tenant。

0.8 补充（ADR-054 / ADR-055）：`FileRunStore` 的 `delete()` 在 tenant 模式下先校验 checkpoint 归属，foreign / 缺失一律 no-op，跨 tenant 删除不再可能；`--resume-run` 与执行面使用同一个 `<data_dir>/tenants/<id>/runs`；durable REST 让 admin 用 query `tenant_id` 或 `X-Vessel-Tenant` 显式跨 tenant（两者不一致 → 400）。工具路径边界与 tenant 无关，但同一 denylist 保护所有 tenant 的宿主凭据。

### 17.6 配置与密钥

见 §9 与 [ADR-050](adr/ADR-050-yaml-first-config-and-secrets.md)。用户 YAML / 项目 YAML / env / 默认四层；`_env` 按层解析；`config.get` / `config.sources` 只输出 `<set>` / `<unset>`；项目 YAML 禁止密钥；`VESSEL_TENANT` 不写入 config。

### 17.7 迁移

`vessel migrate --from sqlite|file-v1 --to file-v2 [--apply] [--tenant <id>]`；默认 dry-run、源只读、幂等。检测到 legacy 数据只提示迁移，不自动迁移；显式 sqlite 后端继续可用。缺省 `session.backend = file`、`durable.path = <tenant>/runs`。

### 17.8 已知限制（0.5）

- 不承诺多进程并发写同一 tenant；单写者锁是唯一保障。
- 列表为 O(N)；超过 5,000 sessions / 20,000 runs 建议改用 sqlite。
- trace `full` 档包含用户消息与工具参数；redactor 只降低泄漏面，不是合规保证。
- 队列溢出会产生不完整的 trace（`trace.overflow`）。
- 0.5 不脱敏 run checkpoint / eval 报告 / 飞书回复；POSIX 文件权限 best-effort 0600。
- 事件上历史中的 `runs.cancelled` 恒 0 是 0.4 行为；0.5 起显式取消发 `run.cancelled`，该值可能非 0。
- 显式 `session.storage_path` / `durable.path` 可以逃出 tenant，启动时只 warn。
- F5 跨机器远程已在 0.6 实现（`release/0.6`）；微信不做。

## 18. 0.6.1 对标修复（已实现）

> 状态：**已实现，未发布**；冻结契约见 DECISION-015。本节与 §8 / §9 / §13.6 / §13.7 / §13.8 同步。

### 18.1 多租户会话隔离（P0）

- `createSessionBackend` 的 file 分支也传 `{ tenantId }`，与 sqlite 分支一致。
- `FileSessionBackend.delete()` 在 tenant 模式先 `load()` 再 `isForeign()`；foreign 会话直接 no-op，不删除文件。
- 显式 `session.storage_path` 指到 tenant 目录之外时启动 warn（与 sqlite / durable 的 tenant escape 提示一致）；默认 `<data_dir>/tenants/<id>/sessions` 不变。
- 验收：共享 storagePath 下，tenant A 的 `listRich` / `load` / `delete` 对 tenant B 无可见、无效果。

### 18.2 durable 与 team 控制面（P0 / P1）

- `handleDurable` 接收 `principal`；list 按 `ctx.tenant_id` 过滤；非 default tenant 且没有 per-tenant store 时返回 `forbidden`。
- `/v1/durable/runs/:id/resume` 要求 `write` 及以上角色。
- team REST 复用 `ROLE_RANK`：`GET` 允许 `read`；spawn / send / cancel / close 要求 `write` / `admin`。RPC 路径与 REST 路径的判定必须一致。

### 18.3 CLI 会话参数

- 新增 `-c/--continue`（继续最近会话）与 `-r/--resume [id]`（恢复指定会话）。
- `-r` 不再作为 `--run` 的短别名；`--run` 保留（可另加 `-p/--print`）。
- 与 `--session` / `--resume-run` / `--serve` / `--connect` 的冲突在参数解析期报错，不静默择一。

### 18.4 配置与插件

- `permission.auto_approve: string[]`（TS 字段 `autoApprove`）：按工具名精确匹配；装配层读取，不再硬编码 `['ask_user']`。TUI 选 `always` 时写回用户 YAML。
- `Plugin.install(host, options?: { config?: Record<string, unknown> })`：`plugins[].config` 原样传入；旧 `install(host)` 继续合法。
- 插件扫描：仓库 `plugins/`、`~/.vessel/plugins/`、`./.vessel/plugins/`；启动时扫描一次，仍需重启生效。
- `vessel plugin list|install <path>|remove <name>`：只处理本地目录，不做远程市场。
- env 覆盖新增 `VESSEL_PLUGINS` / `VESSEL_SESSION_BACKEND` / `VESSEL_MODEL`。
- 插件选择：显式列表全为 `enabled: false` 时不得回退为全部；空数组语义写清。

### 18.5 运行时与 TUI

- `ContextManager` 可注入 `summarizer(messages, { maxTokens }) => Promise<string>`；无 summarizer 时保留占位符 fallback；`autoCompact` 按阈值触发。
- Guardrail 阻断折回 tool error，不 `throw`；run 继续，模型可改道。
- Provider 对 429 / 5xx / 网络错误做 3 次指数退避，尊重 `AbortSignal`。
- `bash` / `read` / `edit` 消费 `ToolContext.signal`；bash abort 时 kill 子进程。
- 可选 `ToolDefinition.concurrencySafe`：安全批次 `Promise.all`，结果按原顺序回写。
- `finish_reason === 'stop'` 但存在 `tool_calls` 时仍进入工具轮。
- `HookResult`（block / updatedInput / additionalContext）与 `HookContext.tool/input`；`void` 返回值继续兼容。
- TUI：edit diff 渲染、bash 输出 Ctrl+O 展开、`/compact` / `/context`、输入历史与运行中排队、`/permissions` 列表/移除。

### 18.6 Web 控制台

- 助手文本 Markdown（代码块 / 列表 / 表格 / 链接）；流式期间可先纯文本，完成后渲染。
- 新增 canonical RPC `sessions.search`（permission `read`）：
  - 参数 `{ query, limit? }`：`query` 去空白后 1..256 字符；`limit` 为 1..100 的整数，缺省 20；
  - 结果 `{ sessions: [{ session_id, title, preview, snippet, updated_at, message_count }] }`；
  - 匹配顺序：title / preview / session_id，然后逐消息 content；snippet 取命中前后各 60 字符；
  - 数据面只依赖 core `SessionBackend`（`listRich()` + `load()` 线性扫描），按 `updated_at` 倒序截断；
  - 前端 150ms 防抖，保留本地 title/preview/id 过滤作为降级。
- `tool.call.started` 带 `args`，`tool.call.completed` 带 `result`；上限 8 KiB，超出截断并标记；事件卡可折叠，失败默认展开。
- 会话时间分组与逐消息时间展示依赖 core `Message.timestamp?`，缺失时降级。

### 18.7 跨节点

- 事件回灌丢弃 `event.node_id === this.nodeId` 的帧，避免双向 / 网状拓扑回声。
- 远端 `team_spawn` 复用 `buildChildHost`（剔除 `team_*`）并传 `memberLimits` / `memberTermination`，与本机 spawn 一致。

### 18.8 扩展

- MCP client 增加 `resources/list|read` 与 prompts 列表（仍不做 OAuth）。
- basic-tools 超大结果落盘到 `VESSEL_TOOL_OUTPUT_DIR`（缺省 `VESSEL_DATA_DIR/tool-output`，再缺省 `~/.vessel/data/tool-output`）的 per-session 子目录，并回路径。

## 19. 0.7 CLI/TUI 前端对齐（已实现）

> 状态：**已实现，未发布**；冻结契约见 DECISION-016。本节只描述 CLI/TUI 的用户可见接口；
> runtime / RPC / 插件语义零改动（E9/E16）。

### 19.1 `VESSEL_INDICATOR`：思考指示器风格

环境变量，取值 `unicode` | `ascii` | `emoji` | `kaomoji`，缺省 `unicode`。
无效值、空值一律回退 `unicode`；实现为纯函数 `resolveIndicatorStyle`
（`packages/tui/src/components/indicator.ts`），消费者是 `SpinnerWithVerb`
（`packages/tui/src/components/SpinnerWithVerb.tsx`），组件实例挂载时读取一次，
运行中修改环境变量需重启 REPL 才生效。

| 取值 | 帧 | 帧间隔 |
|---|---|---|
| `unicode`（默认） | `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` | 80ms |
| `ascii` | `\|` `/` `-` `\` | 100ms |
| `emoji` | `⚙ 🌀 🤔 ✨ 🍵 🔮` | 600ms |
| `kaomoji` | 6 个颜文字帧（`(・_・)` 等） | 2500ms |

- 只影响 thinking / tool 态的前缀帧；`idle` 固定显示 `○ idle`。
- thinking 态文案仍按 2500ms 轮换动词（`thinking` / `reading` / `editing` / `running` /
  `planning` / `checking`），与 `VESSEL_INDICATOR` 无关。
- thinking 态最少显示 2 秒（ADR-022），风格切换不改变该规则。

### 19.2 `/details [hidden|collapsed|expanded]`

Tool trail 详细程度，默认 `collapsed`；实现在
`packages/tui/src/commands/details-command.ts`，取值写入 `ReplState.toolDetailMode`，
只影响当前进程的渲染，不写入配置文件。

- 无参数：打印当前值，例如 `Tool trail: collapsed (hidden | collapsed | expanded)`。
- 合法值：写入状态并回显 `Tool trail: <mode>.`。
- 非法值：回显 `Unknown mode: <value>. Usage: /details [hidden|collapsed|expanded]`，
  **不改变**当前状态。
- 语义（`packages/tui/src/components/ToolTrail.tsx`）：
  - `hidden`：不渲染 trail；
  - `collapsed`：渲染头行 + 最近 1 个工具调用；
  - `expanded`：渲染头行 + 最近至多 8 个工具调用，更早的折叠为 `…and N earlier`。
- 头行为 `✓` / `●` / `✗ tools (N) · <耗时>`（完成 / 运行中 / 失败），失败项附
  `FAILED` 摘要；只聚合一轮内连续的工具段，文本段顺序不变。

### 19.3 `ReplContext.version`

`ReplContext.version?: string` 为可选字段，由装配层 `src/bootstrap.ts` 注入根
`package.json` 的版本号；TUI 仅在启动头展示（`VESSEL · vX`），缺失时退化为 `VESSEL`，
不参与任何 runtime / RPC 语义。

## 20. 0.8 Wave 1 加固（已实现）

> 状态：已合入 `release/0.8`（未发布）。决策见 [ADR-054](adr/ADR-054-run-execution-and-failure-isolation.md) / [ADR-055](adr/ADR-055-tool-path-boundaries.md)；本节只写已实现行为。

### 20.1 run 执行态与终态（C1）

- `RunExecution` 收敛 run 级状态（run id / session / branch / `created_at` / `started_at` / usage / context），`run()` 与 `resume()` 在入口创建、`finally` 释放；loop 与 checkpoint 不再读实例字段。
- `activeRun` 单 run 守卫在第一个 await 前同步占位；已有 active run 时新的 `run()` / `resume()` 立即抛 `RunAlreadyRunningError`（`run_already_running`，继承 `RunResumeError`）。同一 `runId` 的并发 resume 仍由 `resuming` 集合拒绝。
- `finalizeRun()` 是唯一终态路径：completed → `run.completed`；用户取消 → checkpoint `cancelled` + `run.cancelled`；Host 中断 → checkpoint `interrupted` + `run.failed`；普通错误 → `failed` + `run.failed`。终态持久化自身失败发 `run.finalize.failed`，原始错误继续上抛。
- `resume()` 的用户取消现在与 `run()` 一致，不再发 `run.failed`。

### 20.2 Hook / Guardrail 失败隔离（C2）

- `HookRunner` 对每个 hook 独立 try/catch：抛错发 `hook.failed` + `hook.error`，继续后续 hook；`OnError` hook 始终 best-effort，失败不替换原始错误、不跳过 session / checkpoint 写入。
- `GuardrailRunner` 的 `check()` 抛错按 fail-closed：发 `guardrail.error`，返回 `{ allowed:false, reason:'guardrail_error' }`，再走各阶段既有的 blocked 语义；原始异常不冒泡。
- 工具执行失败路径的 OnError hook 同样兜底，工具失败仍折回 `role: tool` 错误文本，不升级为 run 失败。

### 20.3 装配与配置（A1–A5）

- **本地 RPC subscribe**：`src/bootstrap.ts` 给 `createLocalRpcClient` 传入 `onEvent`，订阅 `runtimeEvents` 并以 `{ method:'events.event', params }` 转发。只读旁路，不重复发布事件。`/runs resume` 不再挂起。
- **headless 清理**：`src/cli.ts` 的 headless 分支只记录退出码，不再提前 `process.exit`；跳出后统一执行 gateway / `tenantFactory.closeAll()` / transport / `result.shutdown()` 清理，最后设置 `process.exitCode`。`--serve --run` 退出后不残留 tenant 锁。
- **env provider 合并**：`packages/config/src/loader.ts` 只在显式 `VESSEL_PROVIDER` 时写 `provider.name`；`VESSEL_MODEL` / `VESSEL_BASE_URL` / `VESSEL_PROVIDER_API_KEY` 只合并对应字段，不再把项目里的 `provider.name` 覆盖成 `openai`。
- **`--resume-run` 目录**：读取 `<data_dir>/tenants/<id>/runs`，与执行面一致，并透传 `tenantId`。
- **FileRunStore tenant**：`createRunStore` 透传 `tenantId`；tenant 模式下 `delete()` 先 `load()` 校验归属，foreign / 缺失 no-op；`list` 的 tenant 过滤沿用既有实现。

### 20.4 Web 事件回放与 durable tenant（W1–W3）

- **seq 回退重放**：`hello.latest_seq < currentSeq` 时不再只 `reset(latest_seq)`，而是重置游标为 0、断开当前 WS、以 `since=0` 重连重放；旧 socket 的在途帧由 socket identity 检查丢弃。逻辑抽为纯函数 `planHelloSeq`（`apps/web/src/gateway/seq-replay.ts`），与 TUI `http-client` 的 seq 回退语义一致。
- **durable REST admin tenant**：admin 可通过 query `tenant_id` 或 `X-Vessel-Tenant` 显式指定 tenant，经 `restTenantScope` 校验；两者不一致返回 400 `invalid_request`；非 admin 仍按 principal 作用域。
- **`coreToJob` 清理**：run 进入终态（`execute` 的 finally）与 `trimRuns` 时删除 core run → gateway job 映射；终态事件本身仍带 `job_id` 出站，清理发生在其后。

### 20.5 工具路径边界（E1，ADR-055）

- 内置 denylist：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`；命中 `deny`（不可通过 ask 放行）。
- 插件配置 `allowed_roots`（越界 `ask`；空 = 不限制根，保持兼容）与 `deny_paths`（追加到内置列表）。
- `read` / `bash cwd` 均按 `realpath` 判定；不存在的路径对最近已存在祖先做 `realpath` 再拼回剩余段，`..` 与 symlink 不能绕过。
- `read` handler 与 `runBash` handler 各做一次防御性 denylist 检查；`allowed_roots` 越界只在 `checkPermission` 走 `ask`。

### 20.6 已知限制（0.8）

- 单 run 守卫是**进程内、每 runtime** 的；跨进程并发仍靠 tenant 写锁与 durable 唯一写者约定。
- `finalizeRun` 持久化失败只发 `run.finalize.failed`，不重试、不补偿。
- 路径边界不是沙箱：`bash` 只校验 `cwd`，命令本身可访问其它路径；`read` / `edit` 走 `evaluatePath`（0.15 起 `edit` 纳入）；内置 denylist 不能通过配置移除，只能追加。
- Web 的 seq 回放会清空本地事件存储并从头重放；大历史下重放成本随事件数增长。
- `coreToJob` 在 run 终态后才清理；终态事件与清理之间仍有短暂窗口。

## 21. 0.8.1 Wave 2A 加固（已实现）

> 状态：已合入 `release/0.8.1`（未发布）。决策见 [ADR-056](adr/ADR-056-persistence-durability-and-corruption.md) / [ADR-057](adr/ADR-057-config-single-resolver.md)。

### 21.1 持久化耐久性与损坏检测（ADR-056）

- `atomicWrite` 新增 `durable`（默认 true）：temp 文件 fsync → rename → 尽力 fsync 目录；文件 fsync 失败抛 `AtomicWriteError` 且不 rename，目录 fsync 失败忽略。`durable: false` 恢复 0.5 行为。
- `FileSessionBackend.load()`：主路径 `ENOENT` 才回退 legacy；非 ENOENT 读取错误 / JSON 解析失败 → `SessionCorruptError`（`session_corrupt`）。主路径存在（含 foreign tenant）不再回退 legacy。
- `FileSessionBackend.delete()`：先 `load()`；foreign / 缺失 no-op，损坏抛错不 unlink。`listRich()` 跳过损坏文件继续。
- `FileRunStore`（tenant 模式）：`load` 对读取错误 / JSON / 形状不符抛 `SessionCorruptError`，`delete` 不吞错；非 tenant 保持宽松 `null`。
- `deleteSessionData` 冲突检查改为 `limit: 200` + `offset` 全量分页（上限 10,000 页）；`RunStore.list` 新增可选 `offset`。

### 21.2 配置单一 resolver（ADR-057）

- 所有层只在 `loadConfig()` 合并：`CLI > env > tenant overlay > project > user > default`。
- `ConfigLoadOptions.cliOverrides` 为最高优先层；`defaults` deprecated（先应用，`cliOverrides` 后应用）。
- `src/cli-overrides.ts` 只组装显式 flag：显式端口、hostname、`--allow-remote`、成对 TLS、整体替换的 `allowed_origins`、connect token / CA。
- `resolveServeOptions(config)` 不再接收 argv；`bootstrapConnect` 不再直接读 `process.env`。connect token / CA 来自 `config.connect`（env：`VESSEL_CONNECT_TOKEN`，缺失时回退 `VESSEL_GATEWAY_TOKEN`；`VESSEL_CONNECT_CA`），`serve.token` / `transport.token` 仅作配置层旧版回退。

### 21.3 Gateway 拆分第一阶段（§13.9）

- 新增 `gateway/auth.ts`、`frames.ts`、`sse.ts`、`static.ts`；`gateway.ts` 4172 → 3886 行。
- 公开导出、协议帧与 wire 行为不变；新增纯函数测试。

### 21.4 已知限制（0.8.1）

- 每次 session / checkpoint 写入多一次 fsync；Windows 上目录 fsync 通常被跳过。
- 损坏文件只报错或跳过，不自动修复、不备份、不重试 fsync。
- 非 tenant 的 `FileRunStore` 仍把损坏当 `null`（0.3 兼容语义）。
- `deleteSessionData` 的冲突检查成本随 run 数增长；超过 10,000 页仍未结束会按已扫描结果判断。
- Gateway 只完成第一阶段拆分，路由与连接状态机仍在 `gateway.ts`。
- 新增 CLI flag 必须同时加入 `buildCliConfigOverrides()`，否则不会进入配置层。

## 22. 0.8.2 Wave 2B1 统一工具执行（已实现）

> 状态：已合入 `release/0.8.2`（未发布）。决策见 [ADR-058](adr/ADR-058-unified-tool-execution-pipeline.md)。

### 22.1 统一工具执行管道

- `packages/core/src/runtime/tool-pipeline.ts` 导出 `createToolPipeline` / `createToolPipelineFor` / `ToolPipeline` / `ToolPipelineOptions` / `ToolPipelineStages` / `ToolPipelineResult`（根入口与 `@vessel-agent/core/runtime`）。
- 阶段顺序：`getTool` → ToolCall guardrail → BeforeTool hook → **permission（最终工具与参数）** → handler（timeout + `ctx.signal`）→ ToolResult guardrail → AfterTool hook（仅成功）。guardrail 改写工具名/参数后重新查找工具并解析参数；BeforeTool 的 `updatedInput` 同样在权限判定前生效。
- `ToolPipelineStages` 可关闭调用方已在外层处理的阶段（默认全开）。`AgentRuntime`（包括 delegate 子 runtime）关闭 ToolCall guardrail / BeforeTool / AfterTool，仅复用 permission、handler 超时与 ToolResult guardrail。
- 管道不发布 `tool.call.*`；由 `AgentRuntime` 发布，避免重复。
- **delegate**：`DelegateTaskOptions.permission?`；子 runtime 继承父级 `default` + `autoApprove`，缺省仍 `{ default: 'allow' }`。`permissionMode: 'allow'` 继续显式覆盖（`withAutoAllow`），`deny` 在注册前过滤工具，`bridge` 保留工具自带 `checkPermission`。
- **装配**：`resolveRuntimePermission(config, headless)` / `buildDelegateTaskOptions()` 为纯函数；runtime / delegate 共用同一份 resolved 权限（交互 `ask`、headless `allow`，`ask_user` 始终 auto-approve）。

### 22.2 已知限制（0.8.2）

- 关闭阶段由调用方负责语义正确性；禁用 ToolResult guardrail 会让未检查的结果直接写回上下文。
- 管道只统一执行语义，不改变 `ToolDefinition` / `PermissionPolicy` / guardrail / hook 的接口。

## 23. 0.8.3 Wave 2B2A 结构拆分（已实现）

> 状态：已合入 `release/0.8.3`（未发布）。决策见 [ADR-059](adr/ADR-059-gateway-method-modules.md) / [ADR-060](adr/ADR-060-cli-command-registry.md)。本节只写已实现行为；两处拆分均不改变对外协议或运行时行为。

### 23.1 Gateway 方法模块（ADR-059）

- `packages/serve/src/gateway.ts` 从约 4000 行降到 3002 行，只负责选项校验、事件缓冲 / 连接状态、HTTP / WS 路由、SSE 与鉴权顺序。
- 方法表按 domain 移到 `packages/serve/src/gateway/methods/`，每个文件导出 `createXxxMethods(deps): RpcMethodDefinition[]`：
  - `config.ts`：`createConfigMethods` / `createToolMethods` / `createPluginsMethods`；
  - `sessions.ts` / `runs.ts` / `tenants.ts` / `interactions.ts` / `evals.ts` / `mcp.ts` / `feishu.ts`；
  - `observability.ts`：`createEventsMethods` / `createMetricsMethods` / `createTraceMethods`；
  - `common.ts`：`tenantParamSchema` / `stringParam` / `checkpointBelongsToTenant` 等共享纯函数与常量。
- `gateway.ts` 用 `...createXxxMethods(deps)` 按拆分前顺序展开，再 `defineMethods(rpcMethods)`；`events.subscribe` 仍留在 gateway（依赖连接类型与事件缓冲游标）。
- `MethodError` 移到 `gateway/errors.ts`：拆分后 handler 与 legacy 错误处理共享同一个类，`instanceof` 语义不变。
- 方法名、`params_schema`、返回形状、协议错误码与鉴权顺序不变；没有新增或删除 RPC 方法。

### 23.2 CLI 命令注册表（ADR-060）

- 新增 `src/commands/registry.ts`：`CliCommand`（`name` / `match(args)` / `run(args, ctx)`）、有序数组 `cliCommands`、`matchCommand(args)`（首个命中即停）。
- 覆盖 10 条一次性命令：`tools` / `update` / `resume-run-list` / `eval` / `config` / `tenant` / `migrate` / `trace` / `plugin` / `doctor`；顺序与迁移前 `if` 链的短路顺序一致。
- `src/cli.ts` 删除约 153 行顶层 `if` 链，只解析全局参数 → `matchCommand` → 执行 → 统一设置 `exitCode`；REPL / `--serve` / headless 路径不经过注册表，清理流程不变。
- 命令上下文 `CliCommandContext` 目前只含 `useMock`；一次性命令输出统一经 `printCommandResult({ exitCode, stdout, stderr })`。

### 23.3 已知限制（0.8.3）

- 拆分只改变文件组织：协议、错误码、鉴权顺序、CLI 输出与退出码都保持不变。
- 方法表不再能在一个屏幕内读完；domain 间共享逻辑必须放进 `common.ts`，否则会重复。
- 注册表顺序即语义：宽泛的 `match` 放在前面会遮蔽后面的命令；`--help` / `--version` 仍在入口处先行处理。
- 注册表只覆盖一次性命令；REPL / serve / headless 的入口选择未抽象。

## 24. 0.8.4 TUI 可见问题修复（已实现）

> 状态：已合入 `release/0.8.4`（未发布）。决策见 [ADR-061](adr/ADR-061-tui-display-layer-fixes.md)。全部改动在展示层；core / 工具的原始返回值不变。

### 24.1 key / ANSI / Markdown / resize

- **列表 key**：`utils/text-layout.ts` 新增 `lineKey(index)`；`TextViewer` / `QuickHelp` / `QueuePreview` / `ToolTrail` 统一按行下标做 React key，连续空行与重复文本不再碰撞。
- **ANSI 清洗**：`utils/sanitize-terminal-text.ts` 的纯函数 `sanitizeTerminalText()` 去除 CSI（`ESC [` / C1 `0x9b`）、OSC（`ESC ]` / C1 `0x9d`，到 BEL 或 ST）、其它 ESC、C0（保留 `\n` / `\t`）、DEL、C1；`\r\n` 与 `\r` 归一为 `\n`。仅在展示层调用（`TextViewer`、`ToolTrail`、`StreamOutput`、命令输出归档）。
- **Markdown 归档**：TUI 历史从 `string[]` 改为 `HistoryItem[]`（`{ text, markdown? }`）；`appendHistory` / `appendHistoryLines` 支持 `markdown`。流式完成与 Ctrl+O flush 置 `markdown: true`，`<Static>` 用 `<MarkdownText>` 渲染；命令输出与用户输入仍为纯文本。
- **resize**：`packages/tui/src/repl/ink-repl.tsx` 用 Ink `useWindowSize()` 订阅 `columns` / `rows`（`useStdout()` 不订阅 resize）；`VIEW_MAX_WIDTH` 110→160；live 行数上限随终端高度增长（`MINIMAL_ROW_CAP = 5`，`<15` 行隐藏 live 并只提示一次）；弹窗 / 面板宽度随窗口即时变化。根布局不设固定 `height`，避免 Ink 每帧 `clearTerminal`。

### 24.2 已知限制（0.8.4）

- ANSI 清洗只在展示层，gateway / headless / web / 插件仍拿到工具的原始文本（含控制序列）；TUI 不再显示原始 ANSI 颜色。
- `sanitizeTerminalText()` 只做清洗，不做宽度重排。
- Markdown 历史项比纯文本更占内存与渲染成本；`<Static>` 已写入内容不重绘，窗口变宽后按原宽度换行。
- Windows 真终端的 resize 行为仍需人工验证；`<15` 行的终端不显示流式 live 区。
- i18n 在 0.8.4 未实现（0.8.5 已实现，见 §25）。

## 25. 0.8.5 TUI i18n（已实现）

> 状态：已合入 `release/0.8.5`（未发布）。决策见 [ADR-062](adr/ADR-062-tui-i18n.md)。默认 zh-CN 文案与 0.8.4 逐字一致；core / 工具语义不变。

### 25.1 catalog 与 `t()`

- `packages/tui/src/i18n/messages/zh-CN.ts` 与 `en.ts` 各导出 `Record<string, string>` 形式的 catalog，各 271 个 key、key 集合一致；key 形如 `<域>.<项>`（`startup.summary.model`、`error.classifier.timeout`）。
- `packages/tui/src/i18n/index.ts` 导出 `t(key, params?)`、`setLocale(locale)`、`getLocale()`、`resolveLocale(input)` 与类型 `Locale` / `MessageKey`。
- `t()` 查当前 catalog → 缺失回退 zh-CN → 再回退 key 本身；`{name}` 插值，缺失参数保留原文；不抛错、不打印。
- 不引入 i18n 运行时库；catalog 随 TUI 源码打包，无异步加载、无额外构建步骤。

### 25.2 locale 解析与回退

- 优先级：`VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`，每个候选值独立归一化，非法值跳过该层。
- 归一化：`zh` / `zh-*` / `zh_*`（可带 `.UTF-8` 等后缀）→ `zh-CN`；`en` / `en-*` → `en`；其它 → 未识别。
- REPL 在 `startInkRepl` 启动时解析一次并 `setLocale()`，进程内固定；运行中不切换。
- wizard 没有 `ReplContext`，只按环境变量（`VESSEL_LANG` / `LANG` / `LC_ALL`）解析，不读 `config.ui.language`。
- `VesselConfig.ui.language?: string`（`UiConfig`）由 config validator 接受为已知键；类型不枚举，非法值由解析层跳过。

### 25.3 适用范围与已知限制

- 覆盖：启动头 / 摘要、状态栏、确认与提问弹窗、队列预览、帮助、命令描述、错误分类文案、会话选择器、setup wizard、流式与工具显示的 chrome。
- 不覆盖：技术词、命令名、工具名、错误码、模型 / provider 名不翻译；命令的数据输出（会话 / trace / metrics / 成本等）仍为英文；CLI 一次性命令与 Web 前端未本地化。
- `en` catalog 缺失 key 时静默回退 zh-CN；测试只保证两份 key 集合一致，不校验翻译质量。
- 切换语言需重启进程；已归档的 Ink `<Static>` 历史不会重绘。
- wizard 与 REPL 的 locale 来源不同（wizard 仅 env），同一机器上可能出现 wizard 中文、REPL 英文的组合。

## 26. 0.8.6 mock 场景与 demo（已实现）

> 状态：已合入 `release/0.8.6`（未发布）。决策见 [ADR-063](adr/ADR-063-mock-scenarios-and-demo.md)。场景 provider 在 app 层 `src/mock/`；core 不出现场景概念，默认 mock 行为与 0.8.5 逐字一致。

### 26.1 场景 provider（`src/mock/scenarios.ts`）

- `resolveMockScenario(raw: string | undefined)` → `{ name, unknown? }`：未设置或空串 → `echo`；未知值 → `echo` 并带回原值（入口层打印一次警告）。
- `createScenarioProvider(name)` 返回 `LLMProvider`；场景名为冻结契约：`echo` / `tools` / `permissions` / `error` / `multi-turn`。
  - `echo`：返回 `Echo: <最后一条 user>`；最后一条是 tool 消息时回显其内容。文本、usage 与流式两段分片与 core `MemoryLLMProvider` 逐字一致。
  - `tools` / `permissions`：首轮返回一次 `bash` tool_call（`echo vessel-demo-ok`，不写文件、不联网），收到 role=tool 的消息后以固定文本收尾；两者共用实现，交互 REPL 下是否弹权限确认由权限层决定。
  - `error`：`chat()` 抛固定错误，用于演示错误路径。
  - `multi-turn`：返回 `Turn N: <输入>`，N 为消息历史中的 user 条数。
- provider factory：`createProvider(..., useMock, scenario?)` 在 `useMock` 时若收到 `scenario` 用 `createScenarioProvider()`，否则仍用 `MemoryLLMProvider`（eval 等未透传场景的调用方保持原行为）。

### 26.2 `VESSEL_MOCK_SCENARIO`

- 只在 `src/cli.ts` 读取一次；CLI 始终把解析后的场景经 bootstrap → tenant runtime factory 透传到 provider factory。未设置时解析为 `echo`，走场景 provider，输出与 `MemoryLLMProvider` 逐字一致。
- 未知值回退 `echo`，并向 stderr 打印一行 `Unknown VESSEL_MOCK_SCENARIO "..."` 警告；`VESSEL_MOCK` 的语义（放宽启动门禁、跳过 Key）不变。
- 不提供 `--scenario` flag，也不支持场景文件 / DSL。

### 26.3 `vessel demo` 与数据隔离

- `vessel demo` 是 CLI 模式而非一次性命令：`src/cli.ts` 解析后走现有 bootstrap / REPL 路径，固定 mock + `tools` 场景，忽略 `VESSEL_MOCK_SCENARIO`；`--help` 可见。
- 启动前打印英文引导（会看到工具调用、权限确认与最终回复，Ctrl+C 退出，下一步配 Key）；数据目录隔离到 `<dataDir>/demo`，不读用户已有 session。
- 非 TTY 时打印提示（改用 `VESSEL_MOCK=1 vessel --run "hello"`）并 exit 1。

### 26.4 已知限制（0.8.6）

- demo 需要交互式 TTY；CI 与非交互环境只能用 `VESSEL_MOCK=1 ... --run`。
- evals 未接入场景 provider，仍是各自固定的 mock 行为。
- web / gateway 没有 demo 入口；场景只在 CLI 装配路径可达。
- demo 引导与 CLI 输出保持英文，不在 0.8.5 i18n 范围内。

## 27. 0.8.7 上下文默认预算与 CI 前置（已实现）

> 状态：已合入 `release/0.8.7`（未发布）。决策见 [ADR-064](adr/ADR-064-context-budget-default-1m.md)。默认上下文预算提升到 1,000,000 token；provider 输出上限不变；`quality` / `cross-platform` 在 `bun test` 前安装 `apps/web` 依赖。

### 27.1 默认预算与来源

- `packages/config/src/defaults.ts` 的 `DEFAULT_CONFIG.context.maxTokens = 1_000_000`；`autoCompact` 仍默认 `true`，`compactThreshold` 仍默认 `0.8`。
- core `MemoryContextManager` 的三处 fallback 同步为 `1_000_000`：构造函数、summarizer 的 `{ maxTokens }` 预算、`shouldCompact()` 的 `maxTokens`。
- 调用方显式传入 `context.maxTokens` 时以其为准；显式传 `ContextConfig` 但未给 `maxTokens` 时使用默认 1,000,000。

### 27.2 provider 输出上限是两个概念

- `provider.maxTokens`（config 默认 4096）与请求里的 `max_tokens` 是**单次输出上限**，不随 `context.maxTokens` 改变。
- Anthropic provider 在 `max_tokens` 未指定时仍 fallback 4096（同步与流式两条路径）。
- 上下文预算只影响 `ContextManager` 的压缩判断与摘要预算，不直接写入 provider 请求。

### 27.3 自动压缩

- 阈值 = `context.maxTokens × compactThreshold`，默认 1,000,000 × 0.8 ≈ 800,000 **估算** token。
- 达到阈值后 `MemoryContextManager` 生成摘要（有 summarizer 时）或占位摘要，并保留 system 消息。
- token 计数是估算值，不等于 provider 的精确窗口 / 计费统计。

### 27.4 CI 前置（apps/web）

- 根 `workspaces` 只有 `packages/*`、`plugins/*/*`，不含 `apps/web`；`bun install` 不会安装 react 等前端依赖。
- 根 `bun test` 会扫 `apps/web/tests`，因此 `quality`（composite action）与 `cross-platform` 必须先执行 `actions/setup-node@v4`（Node 22）+ `apps/web` 下的 `npm ci`，再跑 typecheck / `bun test`。
- `web` job 的 `npm ci` 在独立 job 中，不与其他 job 共享 `node_modules`。

## 28. 0.9.0 Wave 2B2B（已实现）

> 状态：已合入 `release/0.9.0`（未发布）。决策见 [ADR-065](adr/ADR-065-plugin-lifecycle-v2.md)、[ADR-066](adr/ADR-066-rpc-result-schemas.md)、[ADR-067](adr/ADR-067-cross-node-dedup-keys.md)。三块改动都保持默认兼容：生命周期钩子是可选的，结果校验默认关闭，旧对端缺少 `incarnation` 时按 `-` 处理。

### 28.1 插件生命周期 v2

- **钩子**：`Plugin.init?(ctx: { host: PluginHost })`、`Plugin.dispose?()`；两者都是可选方法，现有插件不实现也能加载。
- **安装 → 初始化**：`AgentRuntime.create()` 先逐个 `install()`，全部成功后再按安装顺序调用 `init()`。`init` 抛错只发 `plugin.init.failed`（`{ name, error }`）并继续，不使 runtime 构造失败。
- **安装回滚**：`PluginHost.beginPluginInstall?(name)` 返回 `{ commit, rollback }`。安装成功 `commit()` 并发布 `plugin.loaded`（`{ name, version? }`）；失败 `rollback()` 该插件本次注册的 tool / provider / guardrail / hook，然后发布 `plugin.failed` 并重抛——安装阶段仍是 fail-fast。
- **释放**：`AgentRuntime.dispose()` 按逆安装顺序 best-effort 调用 `dispose()`，异常只发 `plugin.dispose.failed`；Promise 缓存保证幂等；最后关闭 session。
- **装配层**：bootstrap / CLI / serve 的 shutdown 链 `await` runtime 释放；MCP client 是工厂式插件，由装配层显式 close，自身 `dispose()` 幂等；其余仓库插件没有需要释放的资源。
- **包装**：`withPluginConfig` 保留 `init` / `dispose`，配置包装不会丢失生命周期钩子。

### 28.2 协议 result schema

- **覆盖**：canonical 方法全部带 `result_schema`（0.9 时 37 个 = 36 个 domain 方法 + `events.subscribe`；0.12 增加 `gateway.reload` 后为 38 个 = 37 个 domain 方法 + `events.subscribe`；0.14 增加 `agents.list` / `agents.get` 后为 40 个 = 39 个 domain 方法 + `events.subscribe`；0.15 增加 `agents.tree` / `tasks.list` / `tasks.get` / `config.set` 后为 44 个；0.18 增加 `interactions.list` 后为 45 个；2026-10-22 移除 workflow 的 5 个方法后为 40 个 = 39 个 domain 方法 + `events.subscribe`；0.19 S3 增加 `teams.list` / `teams.get` / `teams.post` / `teams.members`、S5 增加 `auth.exchange` / `auth.revoke` / `auth.tokens`、S4 增加 `teams.budget` 后为 **48** 个 = 47 个 domain 方法 + `events.subscribe`）；复用片段在 `packages/serve/src/gateway/methods/schemas.ts`（`runStatusSchema`、`runStateSchema`、`sessionInfoSchema`、`usageSchema`、`tenantInfoSchema`、`runEventSchema`、`metricsSnapshotSchema`、eval 片段）。
- **支持子集**：`object` / `array` / `string` / `number` / `integer` / `boolean` + `required` / `properties` / `items` / `enum` / `minLength` / `maxLength` / `minimum` / `maximum`；不使用 `oneOf` / `$ref` / `additionalProperties`，不新增依赖。
- **校验**：仅当 `VESSEL_VALIDATE_RESULTS=1` 时在 RPC 分发层校验；违反返回 `internal`（details 仅 `method` / `path`）并发布 `rpc.result_invalid`。默认关闭，生产热路径不变。
- **版本单源**：`PROTOCOL_VERSION`（`packages/serve/src/protocol.ts`）是唯一常量，`RPC_VERSION` 为兼容别名；HTTP / WS / `hello` / team / transport 不再硬编码 `1`。
- **可空字段**：`sessions.list` 的 `branch` / `tenant_id` / `ended_at` / `end_reason` 因真实值可为 `null` 或缺失、校验器不支持 union，声明为空 schema（任意值通过），`required` 与其余字段仍受约束。

### 28.3 去重键与 incarnation

- **事件键**：`${node}:${incarnation}:${run_id ?? '-'}:${seq}`。代际变化或 seq 回退时只清空该来源节点的键，不做全局 `clear()`；无 `seq` 的帧不参与去重。
- **代际传播**：每个 gateway 进程启动生成 `incarnation`，随 auth 帧发送，`hello` / `peers` 透出；transport 用最近观察到的对端代际构造键。
- **旧对端**：缺少 `incarnation` 时按固定占位 `-` 处理，行为退化为同一代际内去重，连接不被拒绝。
- **消息键**：transport `${from}:${id}`（本机 `/send` 与入站共用集合）；gateway `${tenant}:${from}:${id}`；spawn 幂等 `${tenant}:${request_id}`。
- **持久化**：去重集合只在单 gateway 进程内，语义为单进程生命周期内 at-most-once。

### 28.4 已知限制（0.9.0）

- 去重不持久化；重启后可能重复投递，跨重启 exactly-once 需消费端自行持久化幂等键。
- host 模式直接使用 `PluginHost` 装配时绕过生命周期 v2，不保证 `init` / `dispose`。
- 工厂式插件（MCP client）由装配层关闭，不走 `Plugin.dispose` 自动路径。
- `runs.get` 的 `result_schema` 是 `RunStatus` 与 durable checkpoint 的宽松超集，不是精确校验。
- 结果校验默认关闭，只在 `VESSEL_VALIDATE_RESULTS=1` 时生效；CI 的 Test step 固定开启。
- `sessions.list` 的四个可空字段只做存在性约束，不做类型校验。

## 29. 0.10.0 发版硬化（已实现）

> 状态：已合入 `release/0.10.0`（未发布）。决策见 [ADR-068](adr/ADR-068-config-and-first-run-hardening.md)、[ADR-069](adr/ADR-069-logging-port-and-observability.md)、[ADR-070](adr/ADR-070-shutdown-drain-and-interrupt-reasons.md)、[ADR-071](adr/ADR-071-distribution-vessel-agent-and-install-smoke.md)。四块改动都保留兼容路径：legacy 配置只读兼容，日志端口可替换，`interrupt()` 可选，发布包名变更不影响 bin。

### 29.1 配置与首启

- **Key 解析单源**：`resolveEffectiveApiKey()`（`packages/config/src/secrets.ts`）按 provider 级 `apiKey` / `*_env` → 顶层 `apiKey` 解析；bootstrap、eval、doctor 共用，不再各读一套。
- **provider 优先级**：新版 `provider:` 块优先于 legacy `default_provider` / `providers`；两者并存时对 legacy 键发 deprecation warning，legacy 只读、不参与写入。
- **未知 provider fail-fast**：未注册且无 `provider.baseUrl` → `ProviderConfigError`（`provider_invalid`）；有 `baseUrl` → OpenAI 兼容端点 + 一次性 stderr info。已知 provider 缺 model 也 fail-fast，不全局回退 `gpt-4`。
- **YAML 错误**：解析失败 / 重复键 / 根节点类型错误转为带文件路径（解析错误带行号）的 validation error；只有 ENOENT 与空文档视为缺省，不静默降级。
- **首启**：`config init` 模板可直接启动并输出下一步；`--json` 错误结构化；CLI 统一错误 formatter。
- **来源脱敏**：`config show --sources` 对 `serve.tokens.<token>.*` 输出 `<set>` / `<set#N>`，对 `*.apiKey` / `*.token` 的来源值输出 `<set>`。
- **默认值**：`context.maxMessages` 不再有默认值；缺省时 core 按 `context.maxTokens` 推导条数上限。`context.maxTokens` 仍默认 1,000,000（ADR-064）。

### 29.2 上下文与运行时

- **无硬截断**：删除 100 条消息硬上限；token 估算统一覆盖 `tool_calls` / `reasoning` / system 消息；超限先摘要，system 消息永不丢弃。
- **overflow 重试**：provider 返回 400 且命中 context-overflow 模式时，强制压缩一次并重试一次；压缩失败不覆盖 provider 原始错误。
- **interrupt 原因**：`AgentRuntime.interrupt(reason?: 'shutdown' | 'timeout' | 'user')`，与 `RunOptions.signal` 合并为同一取消信号；`shutdown` / `timeout` 落 `interrupted` checkpoint 并可 `--resume-run`，`user` 保持 `cancelled`。
- **网关关闭**：`gateway.stop()` 幂等；先 `interrupt('shutdown')`，最多 5s 等 active run，再关 WS / HTTP。
- **关闭顺序**：`await gateway.stop() → 取消共享流订阅 / 关闭 transport → beforeClose → closeAll → shutdown`；后两步传 `{ drain: false }`，serve 路径不重复 drain。顺序抽为 `shutdownServeStack()`（`src/shutdown-sequence.ts`）；无 gateway 的 headless / REPL 由 bundle 自己 drain。

### 29.3 日志与可观测

- **Logger 端口**（core）：`Logger` / `LogLevel` / `LogFields` / `LoggerOptions` 为纯类型；`createStderrLogger()` 输出一行一个 JSON 到 stderr，默认 `info`，message 与 fields 经 trace redactor，sink 失败静默；未注入时用 `noopLogger`。
- **级别**：`VESSEL_LOG_LEVEL`（debug|info|warn|error，非法回退 info）；`VESSEL_DEBUG` 非空等价 debug。stdout 只留命令结果 / JSON / UX 输出。
- **进程兜底**：`unhandledRejection` / `uncaughtException` → `logger.error` + `process.error`（只带 `kind` 与脱敏 message），设置退出码 1，限时 5s shutdown 后退出；重复触发只清理一次。shutdown 各步骤失败发 `shutdown.failed`（`step` / `error` / `tenant_id`）。
- **插件侧**：provider 默认 120s 超时（`timeout_ms`，`<=0` 关闭），超时抛 `ProviderTimeoutError`（`provider_timeout`），重试经 `onRetry`；MCP 告警写 stderr 并发 `mcp.warning`；hook-logging 默认 stderr。
- **trace**：文件以 `0600` 创建；`trace.includeStreamChunks` 默认 `false`，`llm.stream.chunk` 默认不落盘。

### 29.4 打包与分发

- **根包**：`package.json` 的 `name` 为 `vessel-agent`，bin 仍是 `vessel`；根 `files` 排除 `**/node_modules/**`、`__tests__`、`*.test.ts(x)`，并包含 `apps/web/dist`。
- **子包**：18 个可发布子包统一 `files: ["src"]` + `license` / `repository` / `engines`。
- **安装 smoke**：`scripts/smoke-install.ts` 对 18 个子包 + 根 tarball 执行 `npm pack`，用本地 `file:` `overrides` 安装并运行 `vessel --version` / `VESSEL_MOCK=1 vessel --tools`。根包打包前必须已有 `apps/web/dist/index.html`，且根 tarball 的文件清单必须包含它；CI 的 `install-smoke` job、`release.yml` 的 `verify` 与 `publish-npm` 都先构建 Web 控制台。POSIX / Node 22，Windows 默认跳过。
- **发布顺序**：`core → permission → config → serve → tui → plugins`，最后发布根包 `vessel-agent`；`verify` 失败则不进入 `publish-npm`。

### 29.5 CLI 本地化

- `src/i18n/` 提供 zh-CN / en 两份 catalog（各 85 个 key）与 `t(key, params?)`；优先级 `VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`。
- 覆盖 `--help`、一次性命令错误、默认空状态与 demo banner；命令的数据输出（会话 / trace / metrics / 成本等）保持英文，Web 前端未本地化。
- `--help` 在配置加载前短路，只能看到环境变量层；其余 UI 在 bootstrap 后用 `config.ui.language` 重新解析。

### 29.6 已知限制（0.10.0）

- host 模式（直接使用 `PluginHost` 装配）不经过 `AgentRuntime.interrupt()`；durable run 的 drain 语义未覆盖。
- 跨节点去重集合仍不持久化，只保证单 gateway 进程生命周期内 at-most-once。
- RPC 结果校验默认关闭，只有 `VESSEL_VALIDATE_RESULTS=1` 时生效；CI 的 Test step 固定开启。
- provider 插件没有事件总线，重试观测只能通过 `onRetry` 或 stderr，不发布 core 事件。
- 安装 smoke 只在 POSIX / Node 22 运行；Windows 安装未验证。
- CLI 本地化不覆盖命令数据输出；Web 前端未本地化。
- 0.10.0 仍未 tag、未 `npm publish`、未合并 `main`；根包与子包已 bump 到 `0.10.0`。

## 30. 0.11.0 UI 设置与包 scope（已实现）

> 状态：已合入 `release/0.11.0`（未发布）。决策见 [ADR-072](adr/ADR-072-ui-settings-and-terminal-polish.md)、[ADR-073](adr/ADR-073-npm-scope-vessel-agent.md)。两处改动都保留兼容路径：`/settings` 在未注入 `ctx.settings` 时只读，包 scope 变更不影响 bin 名 `vessel`。

### 30.1 TUI `/settings` 与语言持久化

- **命令**：`/settings [language <zh-CN|en>]`（`packages/tui/src/commands/settings-command.ts`）。不带参数显示当前语言与用法；非法值显示 `settings.invalid` 与用法。
- **持久化**：装配层把 `settings.setLanguage` 注入 `ReplContext`；该函数写用户配置 `ui.language`，成功后命令调用 `setLocale(locale)` 立即重渲染。TUI 包本身不读用户配置路径。
- **写回**：`src/ui-settings.ts` 的 `setUserLanguage()` 读取 YAML 根对象，只改 `ui.language`，同目录临时文件 + rename 原子写入，权限 `0600`；读取 / 解析 / 写入失败分别抛 `ui_settings_*` 错误，不回显文件内容。
- **CLI 等价入口**：`vessel config set ui.language <zh-CN|en> [--json]`，失败走统一错误 formatter。
- **未注入 / 失败**：无 `ctx.settings` 时只读并提示 `settings.readOnly`；写入失败输出 `error.command.settings` 与格式化错误。
- **优先级不变**：`VESSEL_LANG > config.ui.language > LANG > LC_ALL > zh-CN`；`VESSEL_LANG` 显式设置时，写入配置不会改变当前显示。

### 30.2 终端观感（清屏、全宽与面板）

- **`ui.clearOnStart`**：默认 `true`；仅 TTY 且值不为 `false` 时，进入 REPL 前写 `\x1b[2J\x1b[H` 清可视区并归位光标（`packages/tui/src/repl/clear-on-start.ts`）。非 TTY 不清屏；不用 alternate screen，保留滚动历史。
- **全宽**：删除 `VIEW_MAX_WIDTH = 160`；`viewWidth(columns)` 返回 `max(1, cols - VIEW_HORIZONTAL_MARGIN)`（水平边距 2），内容宽度再减边框与 padding。
- **统一 PanelFrame**：状态栏、启动头 + 会话摘要、队列预览改用单线 `PanelFrame`；标题嵌上边框、键位提示嵌下边框。
- **行数预算**：`STATUS_BAR_ROWS = 3`（上边框 + 1 行内容 + 下边框）；`viewCapacity()` 用 `height - STATUS_BAR_ROWS - chrome` 计算，minimal 封顶 `MINIMAL_ROW_CAP = 3`，避免矮终端抖动。

### 30.3 Web 壳层本地化

- **模块**：`apps/web/src/i18n/`（`index.ts` + `messages/{zh-CN,en}.ts`），无依赖、无 RPC。
- **范围**：导航、面包屑、Settings 六个 tab、Appearance、通用按钮；未收录 key 回退 zh-CN，再回退 key 本身。
- **locale 解析**：`localStorage['vessel.ui.language']` > `navigator.language`（`en*` → `en`，`zh*` → `zh-CN`，其余 `zh-CN`）；`setLocale` 同步写 localStorage 与 `<html lang>`，通知订阅者重渲染。
- **入口**：Settings → Appearance 提供语言选择。

### 30.4 包 scope：`@vessel-agent/*`

- **根包**：`name` 为 `vessel-agent`，bin 仍是 `vessel`。
- **子包**：18 个可发布子包（5 个库包 + 13 个插件包）统一为 `@vessel-agent/<name>`；import specifier、manifest 精确版本依赖与脚本前缀同步。
- **历史**：`docs/adr/` 历史 ADR 与 `CHANGELOG.md` 既往版本段落保留旧 scope（`@vessel`），不改写。
- **门禁**：`release-dry-run` 校验 18 个包名与版本；`smoke-install` 用 `@vessel-agent/*` 的本地 `file:` overrides 安装 root tarball；`check-deps` / `smoke-subpaths` 按新前缀运行。
- **发布顺序**：`core → permission → config → serve → tui → plugins → 根包 vessel-agent`。

### 30.5 已知限制（0.11.0）

- Web 只覆盖壳层与 Settings；功能页未收录文案回退中文，不是全量本地化。
- TUI 语言切换依赖 asm 注入 `ctx.settings`；只读宿主不能切换。
- `ui.clearOnStart` 仅影响 TTY REPL 启动，非 TTY / headless 不清屏。
- `VESSEL_LANG` 高于 `config.ui.language`；环境变量显式设置时设置命令不改变当前显示。
- 0.11.0 仍未 tag / `npm publish` / 合并 `main`；manifest 版本由 1 统一写入。

## 31. 0.12.0 Gateway 生命周期、热重载与 CLI 样式（已实现）

> 状态：已合入 `release/0.12.0`（未发布）。决策见 [ADR-074](adr/ADR-074-gateway-lifecycle-daemon-service.md)、[ADR-075](adr/ADR-075-gateway-reload-scope.md)、[ADR-076](adr/ADR-076-cli-style-and-self-update.md)；同版本并入的 0.11.1 修复见 [ADR-077](adr/ADR-077-permission-reasoning-cwd.md)。

### 31.1 `vessel gateway` 生命周期

- **命令**：`start [--daemon] [--port <n>] [--host <h>] [--log <path>]`、`stop [--timeout 10s]`、`status [--json]`、`restart [--daemon]`、`reload [--scope config,plugins]`、`install-service [--systemd|--launchd|--schtasks]`、`uninstall-service`（`src/cli-args.ts` 解析，`src/gateway-command.ts` 执行）。
- **入口统一**：前台 `start` / `restart` 映射到既有 `--serve` 装配管线；`--serve` 保留为前台别名。其余子命令由一次性命令注册表执行。
- **daemon**：`start --daemon` 由父进程 `Bun.spawn` 分离一个前台子进程；stdio 追加到 `<dataDir>/logs/gateway.log`（目录 `0700`、文件 `0600`）。子进程写出实际 host / port 后父进程退出；已有实例、spawn 失败、超时或提前退出返回非 0，并 tail 日志。
- **PID**：`<dataDir>/gateway.pid`，JSON `{pid, started_at, host, port, version, node_id?}`；同目录临时文件 + rename 原子写入，权限 `0600`。运行中 = PID 存活且命令行匹配 gateway / serve；死 PID、损坏文件、命令行不匹配按 stale 处理。退出时只删除本进程持有的文件。
- **stop / restart**：`stop` 默认等待 10s；Windows 用 `process.kill(pid)`，POSIX 用 `SIGTERM`；PID 指向自身时拒绝。`restart` 先 stop 再按前台 / `--daemon` 启动。
- **status**：人类输出为标题 + `label value`，包含运行状态、PID、URL、uptime、版本、node id 与服务注册状态；`--json` 输出 `running` / `pid` / `host` / `port` / `url` / `started_at` / `uptime_seconds` / `version` / `pid_file` / `service` 等字段，未运行返回 1。

### 31.2 用户级服务注册

- **Linux**：systemd user unit `~/.config/systemd/user/vessel-gateway.service`，`ExecStart=/usr/bin/env vessel gateway start`，`Restart=on-failure`，`WantedBy=default.target`；安装执行 `systemctl --user daemon-reload` + `enable --now`。
- **macOS**：LaunchAgent `~/Library/LaunchAgents/com.vessel.gateway.plist`，`RunAtLoad` / `KeepAlive`，日志写 `<dataDir>/logs/gateway.log`；安装执行 `launchctl load -w`。
- **Windows**：登录计划任务 `VesselGateway`（`schtasks /SC ONLOGON`），运行 `vessel gateway start`。
- **边界**：只支持当前平台，交叉指定与不支持平台返回明确错误；只在显式 `install-service` / `uninstall-service` 时写入定义并调用平台命令，不随启动或安装自动注册；不提供 root 级系统服务。服务定义生成是纯函数，测试通过注入 `runCommand` 断言形状，不修改开发机。

### 31.3 `gateway.reload`

- **RPC**：canonical 方法 `gateway.reload`（admin-only），`params { scopes?: string[] }` → `{ reloaded: string[], requires_restart: string[] }`，带 `result_schema`；canonical 总数 38（37 个 domain 方法 + `events.subscribe`）。
- **plugins**：清空插件目录扫描缓存，下次 `list()` 重新扫描；已安装插件、已注册工具与 active run 不受影响。
- **config**：重新 `loadConfig()`；只有 `serve.allowed_origins` 变化会经 `Gateway.reconfigure({ allowedOrigins })` 生效，并计入 `reloaded`。provider（不含 model）/ model / agent / permission / TLS / token / port 变更一律进 `requires_restart`；gateway 未提供 `reconfigure()` 时 allowlist 也进 `requires_restart`。
- **错误**：未知 scope、配置读取失败、`reconfigure` 抛错都返回 RPC 错误，不假装成功。
- **CLI**：`vessel gateway reload` 从 PID 文件取地址、从配置解析 token，经本地 HTTP RPC 调用；未运行 / 无 token / 调用失败返回非 0，随后打印 `reloaded` 与 `requires_restart`。

### 31.4 `vessel update` 自更新

- **安装形态检测**（`src/update/install-detect.ts`）：入口在 `~/.bun/.../node_modules` → `bun`；在 `node_modules/vessel-agent`、Windows npm 前缀或 `/lib/node_modules` → `npm`；入口是仓库 `src/cli.ts` 或向上存在 `.git` → `dev`；其余 `unknown`。`VESSEL_INSTALL_FORM` 可显式覆盖。
- **动作**：npm → `npm i -g vessel-agent@latest`；bun → `bun add -g vessel-agent@latest`；dev / unknown → 只打印 `git pull && bun install`，不改工作区。
- **交互**：默认确认，`--yes` 跳过；非 TTY 且无 `--yes` 返回 1。安装失败返回 1，`--json` 输出形态、命令、退出码与末尾输出；成功提示重启。`--check` 保持只检查与提示。

### 31.5 CLI 暗金样式

- **模块**：`src/ui-style.ts`；暗金主色 `#c2a273`，亮色与主色同值（强调靠 `BOLD`），与 TUI `theme.brand` 一致；提供 `brand` / `title` / `section` / `ok|warn|err|info` / `symbol` / `rule` / `kv`；CJK 显示宽度按 2 列计算。
- **ANSI 条件**：stdout 为 TTY、`NO_COLOR` 未设置（含空串）、`TERM !== 'dumb'` 同时满足；否则全部返回原文。`--json` 与数据行保持纯文本。
- **范围**：全部一次性命令的人类可读输出；TUI 使用自己的 theme，不经过该模块。

### 31.6 0.11.1 修复（并入本版本）

> 0.13 起权限默认不超时、Web 权限改为 run 内联，以下超时 / 弹窗描述由 §32 与 ADR-079 修订；`ask_user` 仍沿用事件时间 TTL。

- **权限交互时效**：Web `expiresAt = event.ts + 120s`；重放旧请求直接丢弃；`requestId` 去重；`not_found` 移除弹窗并提示；同一请求只提交一次。
- **权限超时**：core 等待超时抛 `PermissionTimeoutError`（`permission_timeout`），run 失败，不交给模型重试。
- **思考流**：`ui.showReasoning` 默认 `false`；显式开启时 provider 的 `reasoning_content` 转 `reasoning_delta` 并经 `llm.stream.chunk` 发布；TUI / Web 折叠为思考块；`trace.includeStreamChunks` 仍默认 `false`。
- **默认工作目录**：`agent.cwd`（支持 `~`）；优先级 `工具参数 cwd > agent.cwd > process.cwd()`；`bash` 默认 cwd 与 `read` / `edit` 相对路径按它解析，denylist / `allowed_roots` 继续生效。
- **Web 实时显示**：`EventStore` 通知时复制 `entries` 数组，`useMemo(..., [snapshot.entries])` 在流式增量到达时重算，不再需要刷新。

### 31.7 已知限制（0.12.0）

- `gateway.reload` 只承诺 plugins 扫描缓存与 `serve.allowed_origins`；其余配置必须重启，已安装插件与 active run 不会被替换。
- 服务注册只覆盖当前平台与用户级；daemon 自身不做崩溃重启，需要常驻时交给服务管理器；PID 命令行不可读时按 stale 处理。
- 自更新只覆盖 npm / bun 全局安装；源码模式只提示；不提供独立二进制或二进制自替换。
- CLI 样式是可选的 TTY 装饰，不进入 `--json` / 数据输出；重定向时无 ANSI。
- 0.12.0 的 Windows 全量门禁为 `3126 pass / 2 skip / 0 fail`；POSIX CI 实跑仍待完成。
- 0.11.1 不单独发布，修复只随 0.12.0；0.12.0 仍未 tag / `npm publish` / 合并 `main`。

## 32. 0.13.0 状态栏与权限生命周期（已实现）

> 状态：已合入 `release/0.13.0`（未发布）。决策见 [ADR-078](adr/ADR-078-dual-status-bars-and-path-overflow.md)、[ADR-079](adr/ADR-079-permission-lifecycle-persistence.md)；同版本并入 0.12.1 的 TUI 小修（0.12.1 不单独发布）。

### 32.1 TUI 双状态栏

- **上栏**：模型、context 用量（`width >= 60` 显示；`>= 80` 追加 10 格进度条）、百分比、时长、压缩次数（`>= 60` 列）、路径 + branch。0.13 删除 `N sess` 与每帧 `session.list()`。
- **路径溢出**：宽度按终端显示列计算。放不下时先中间省略，保留根（`D:\` / `/` / `~/`）与末两级目录；空闲且路径自身仍溢出时用 marquee 窗口滚动（`MARQUEE_TICK_MS = 140`、`MARQUEE_PAUSE_MS = 1200`，往返循环）。branch 固定最右，超过 24 格才尾部截断。宽字符跨窗口边界时整字跳过，不打印半个字。
- **下栏 `BottomBar`**：与上栏同构（`PanelFrame`、`viewWidth(columns)`），单行字段 `perm` / `bash` / `sub` / `session` / `tenant` / `queue`。`perm` 默认显示 `perm ask · N auto`，有等待中的权限时改为 `waiting <tool>`；`session` 显示 `sess <短ID> · Ctrl+R`。宽度分级：`<40` 列不渲染；`40–59` perm / bash / sub；`60–99` 增加 session；`>=100` 增加 tenant（非 default）与 queue。超宽按 `tenant → queue → session → sub → auto` 从右到左丢弃，perm / bash 不丢。
- **行预算**：`STATUS_BAR_ROWS = 3`、`BOTTOM_BAR_ROWS = 3`。下栏显示时吸收底部 hint 行（`hintRows = 0`），净增 2 行；独占 overlay 打开时下栏让位；终端 `<40` 列时按未渲染计入预算。下栏默认在 `rows >= 18` 且非 minimal / hidden 时显示。
- **显隐与配置**：`Ctrl+T` 切换上栏、`Ctrl+G` 切换下栏、`Ctrl+R` 打开 `/resume` picker。初始值优先级 `VESSEL_STATUS_BARS > ui.statusBars > 自动规则`；手动切换立即生效并写回用户配置 `ui.status_bars`（YAML，原子写 / `0600` / 保留其它键），写回失败不回滚界面。`ui.statusBars` 只接受 `top|bottom|both|none`，非法值由 validator 拒绝。
- **快捷键副作用**：`ink-text-input` 会把 Ctrl 字符插入输入框，切换后必须用当前输入覆盖并重置光标。快捷键放在 overlay 早退之前，弹窗打开时也能恢复栏位。
- **品牌色**：TUI `theme.brand` 与 CLI `src/ui-style.ts` 主色统一为 `#c2a273`；CLI 亮色同值 + `BOLD`。

### 32.2 权限生命周期

- **默认不超时**：core `PermissionPolicy` 只有显式正数 `RuntimePermissionConfig.timeoutMs` 才计时；应用层不设置，因此 REPL / gateway 权限等待一直持续到应答、取消或 abort。只有显式超时才抛 `PermissionTimeoutError`（`permission_timeout`）并让 run 失败。
- **取消语义**：等待绑定 `ctx.signal`；abort 抛 `PermissionAbortedError`（`permission_cancelled`，`name: AbortError`），优先于超时判定，不误报 `permission_timeout`。
- **请求字段**：`tool.permission.request.data` 增加 `session_id` / `tool_call_id` / `deadline_at` / `source`（additive）；默认等待不写 `deadline_at`。
- **持久化**：`packages/serve/src/interactions-store.ts` 按 tenant 写 `<dataDir>/interactions-<tenant>.json`，记录 `pending` / `answered` / `orphaned`，`atomicWrite` + `0600`。gateway 启动时 `loadAllSync()`；本进程没有对应 run 的 `pending` 转 `orphaned`。文件损坏 / 不可读向 stderr 报错并按空集处理，不删除原文件；tenant 名只接受 `[A-Za-z0-9._-]`。
- **不按 TTL sweep**：pending 只由应答、run 终态或进程退出清理。run 的 `completed` / `failed` / `cancelled` 会把同 run 的 pending 持久化为 `orphaned`；迟到应答返回 `run_ended`。
- **幂等与冲突**：重复应答返回首次结果（`duplicate: true`）；不同决定重答返回 `conflict`；记录不存在返回 `not_found`；`orphaned` 返回 `run_ended`。有界记录（`MAX_RECORDS`）只淘汰最旧的 `answered` / `orphaned`，pending 不淘汰。
- **错误码**：RPC 新增 `expired` / `run_ended`；canonical 方法总数仍为 38（不新增 `interactions.pending`）。

### 32.3 Web 内联权限

- **权限**：删除全局权限遮罩，`PermissionCard` 内联在所属 `RunCard`；同一 run 的多个请求按 `requestedAt` 排序。跨 session 的待处理请求由 `PendingPermissionsBar` 提示。
- **收起条件**：其他端应答（`tool.permission.response`）、过期（`tool.permission.expired`）、run 终态，或应答返回 `expired` / `run_ended` 时移除卡片；`run_ended` toast「run 已结束」，`expired` toast 已过期。
- **不再用 TTL 丢权限**：`PermissionRequest` 不含 `expiresAt`，只保留 `requestedAt` 排序；权限等待由服务端生命周期决定。`ask_user` 仍是全局 `AskModal`，继续按 `event.ts + 120s` 计算有效期（本批未改）。

### 32.4 0.12.1 TUI 小修（并入本版本）

- **斜杠提示宽度**：`computeDialogWidth = max(1, columns - 4)`，移除 72 列上限；`InlineAutocomplete` 订阅 `useWindowSize`，resize 后重排。
- **品牌色**：启动头 / wordmark / tagline 使用 `theme.brand #c2a273`；CLI `ui-style` 同步为 `#c2a273` + `BOLD`。
- **`/exit`**：Ink unmount 并清理最后一帧后输出 `Goodbye!`；`Ctrl+C` 退出不打印（保持原行为），简单模式不变。

### 32.5 已知限制（0.13.0）

- core 只读取 `remember`（等价 `always`）；`allow session` 目前等同 `once`，session 级批准尚未生效。
- 没有 `interactions.pending` RPC；Web 刷新恢复依赖事件重放缓冲（默认 10000 条），超出缓冲的旧请求可能无法恢复。
- `ask_user` 仍是全局弹窗与 120s 事件时间 TTL；本版本只把权限请求改为 run 内联。
- 状态栏显隐写回失败不提示用户；`VESSEL_STATUS_BARS` 只是启动初值，不随手动切换改变。
- Windows 全量门禁 `3226 pass / 2 skip / 0 fail`（`VESSEL_VALIDATE_RESULTS=1`）；POSIX `3228 pass / 0 fail`，build / Web build 通过；0.13.0 仍未 tag / `npm publish` / 合并 `main`。

## 33. 0.14 / 0.14.1 可观察性、控制面与 Host 对等（已实现）

> 状态：已合入 `release/0.14.1`（未发布；0.14.0 不单独 bump，本节同时覆盖 0.14.0 P0 与 0.14.1 / 0.15 折叠内容）。决策见 [ADR-080](adr/ADR-080-observability-control-plane-and-gateway-instances.md)、[ADR-081](adr/ADR-081-host-parity-and-serializable-snapshot.md)、[ADR-082](adr/ADR-082-ask-user-registration-and-web-chat.md)。本节修订 §32.3 / §32.5 中「`ask_user` 仍是全局弹窗」的描述。

### 33.1 可观察性契约

- **trace 流式过滤**：`trace.includeStreamChunks` 默认 `false`；过滤同时匹配 `llm.stream.chunk` 与 `<prefix>.llm.stream.chunk`（如 `subagent.llm.stream.chunk`），带前缀的转发事件不能绕过 trace 策略。实时事件发布不受影响。
- **结构化错误 envelope**：`run.failed` / `tool.call.failed` 保留原 `error` 文本，并展开 `error_code` / `category` / `phase` / `retryable`，可识别时附 `http_status`，调用方可通过 `details` 补充非敏感信息。`category` ∈ `provider|tool|permission|config|gateway|internal`；`phase` ∈ `input|llm|tool|permission|finalize|checkpoint|shutdown|run`。envelope 不携带 prompt / reasoning / 完整工具结果。
- **可见性配置**：
  - `ui.verbosity: minimal|normal|debug`（默认 `normal`）——Web 信息层级，见 §33.7。
  - `ui.showInternalEvents: boolean`（默认 `false`）——TUI `/errors` 与 Web 的 L3 内部事件。
  - `ui.errorLevel: user|all`（默认 `user`）——TUI `/errors` 与 `vessel errors`；`all` 追加 internal / process 级。
  - `observability.showProcessErrors: boolean`（默认 `false`）——`process.error` / `shutdown.failed` 等进入 `vessel errors`。
  - 四个键都支持 `vessel config set`，YAML 分别为 `verbosity` / `show_internal_events` / `error_level` / `show_process_errors`；非法值由 validator 拒绝，不静默回退。

### 33.2 只读控制面 CLI

- **`vessel status [--json]`**：一屏输出本地配置、`<dataDir>` 下全部 gateway 实例（instance / running / pid / host / port / url / uptime / version / node_id / pid_file）与控制面 attach 状态（local / remote、tenant、clients、latest_seq、当前 run / session、queue）。只读：不 bootstrap、不取 tenant 写锁、不输出密钥。
- **`vessel agents [--json]`**：调用 canonical `agents.list`；本地优先 attach 运行中的 gateway，否则用 `--connect`。输出 agent 注册表字段，不启动 / 取消任何 agent。
- **`vessel errors [--json] [--limit N]`**：最近错误摘要，默认 20 条、上限 200。默认只含 `run.failed` / `tool.call.failed` / `agent.run.failed`；`ui.errorLevel: all` 或 `observability.showProcessErrors: true` 时追加 `process.error` / `shutdown.failed` / `hook.error` / `plugin.error`。本地读 trace，`--connect` 时走 `events.list`；不输出 stack 与密钥。
- 三者的人类输出走 `src/ui-style.ts`；`--json` 为纯 JSON、无 ANSI。

### 33.3 gateway 多实例 A

- **键**：`(dataDir, instance)`。`instance` 匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`；default 实例名为 `default`。
- **文件**：default → `<dataDir>/gateway.pid`、`logs/gateway.log`；命名实例 → `<dataDir>/gateway-<instance>.pid`、`logs/gateway-<instance>.log`。实例锁统一为 `<dataDir>/gateway-<instance>.lock`（JSON `{pid, started_at, host}`，`atomicWrite` + `0600`；目录 `0700`）。PID 记录新增可选 `instance`（additive）。
- **命令**：`vessel gateway list [--json]` 列出全部实例；`start` 接受 `--instance <name>` / `--port <n>`；`stop` / `status` / `reload` / `restart` 额外接受 `--all`。选择器三者互斥；`restart --all` 必须同时带 `--daemon`。`gateway start --port 0` 必须同时给 `--instance`。
- **选择器优先级**：显式 `--instance` > 显式 `--port`（用 PID 记录里的端口匹配）> default。无选择器时：0 个实例 → 空结果，1 个 → 该实例，≥2 个 → `multiple_instances`，不猜目标。
- **node_id**：显式 `host.nodeId` 与其它运行实例重复时，启动前拒绝（`duplicate_node_id` 并指出占用实例与 pid）；自动生成的 node_id 不参与检查。
- **`--serve`**：从 `--help` 移除，保留为 default 实例的前台隐藏兼容别名，启动时向 stderr 打印弃用提示；新入口统一为 `vessel gateway start`。

### 33.4 Host 对等与可序列化快照

- **per-run session**：`RunOptions.sessionId` 由 `AgentHandle.run` 消费，覆盖成员默认 session；`ScheduledTask.sessionId` 仍可由自定义 Scheduler 改写。单 agent `AgentRuntime.run(input, sessionId, opts)` 继续以显式参数为准，不读该字段。
- **取消原因**：`AgentHandle.cancel(runId?, reason?)` 与 `RuntimeHost.cancel(id, runId?, reason?)` 接受 `RunInterruptReason`；reason 经 `AbortSignal.reason` 传给成员 runtime，`agent.run.cancelled` 仅在 reason 为字符串时写入。语义同 0.13：`shutdown` / `timeout` → interrupted checkpoint，`user` / 未传 → cancelled。
- **resume 经 Scheduler**：`Host.resume(runId, opts?)` 用 `ScheduledTask.runId` 固定 run id，经 `scheduler.submit` 排队，受 `maxConcurrency` / `perAgentSerial` 约束；`opts.signal` 可取消排队或运行。`resuming` 集合在 submit 失败、队列取消与 handle 结算时释放；重复 run id 被拒绝。
- **快照**：`RuntimeHost.snapshot?()` 返回 `HostSnapshot { asOf, agents, runs, scheduler }`；`AgentSnapshot` 含 id / name? / state / sessionId / currentRunId? / toolNames / lastError? / startedAt? / queuePosition?；`RunSnapshot` 含 runId / agentId / sessionId / state / queuePosition? / queuedAt? / startedAt?；`SchedulerSnapshot` 含 asOf / queued / running / stats。全部为纯 JSON，可安全序列化；`Scheduler.snapshot` 可选，未实现时 Host 降级为成员 active run 摘要。
- **Host 透传**：`RuntimeOptions.pluginConfigs` / `logger` / `includeReasoning` 原样传给每个成员 runtime。
- **镜像事件**：Host 合成的 `agent.run.*` 事件带 `mirror_of_run_id`（等于被镜像的 run id），用于与成员 runtime 的具体事件对齐。

### 33.5 ToolDefinition.display

- `display?: { label?: string; kind?: 'command'|'file'|'search'|'generic' }`（0.14.1，additive）。`PluginHost.listTools()` 原样透出，供 UI 在通用回退之上增强展示。
- 不进入 LLM 工具 schema，不参与权限 / 执行判定；未知 `kind` 按 `generic` 处理。当前 `tools.list` RPC 的结果 schema 尚未包含该字段。

### 33.6 ask_user 注册策略

- **注册**：交互 REPL（stdin 为 TTY）与 `gateway start` / `--serve` 注册；`--run` / headless / 管道不注册。
- **关闭**：`ui.askUser: false`（YAML `ui.ask_user`）按入口与 tenant 关闭；显式 `true` 也不能让无客户端的 headless 入口注册（否则只能等 120s 超时）。
- **配置**：`vessel config set ui.askUser <true|false>`；validator 只接受布尔。未配置时保持入口默认，不写默认值。
- **Web**：提问内联到所属 `RunCard`（`AskCard`），删除全局 `AskModal`；提交走既有 `ask.respond`，不新增 RPC；其他端应答 / 过期 / run 终态时收起。提问有效期仍按事件时间 `event.ts + 120s`，不复用权限的无限等待。

### 33.7 Web 聊天渲染与信息层级

- **工具卡**：单行 header + 输入 / 输出 / 变更 / 错误分区；20 行或 8KB 折叠预览，200KB 分段加载，复制按钮；失败自动展开，并复用 `tool.call.failed` 的结构化 `errorMeta`。
- **思考气泡**：`reasoning_delta` 合并为独立可折叠块，记录起止时间；12 行上限；流式展开、结束后折叠；与正文严格分离。
- **流式性能**：`EventGroupCache` 只并入新增条目并只重建受影响的 `RunGroup`；`RunCard` 使用 `memo` 与稳定回调；渲染组上限 200；滚动跟随节流 100ms。截断 / reset / gap 或可见性设置变化时整表重建。
- **信息层级**：`minimal` 只保留正文、失败工具与 run 终态（隐藏成功工具卡、思考、时间元数据）；`normal` 为 L1 + 折叠 L2；`debug` 等同 `showInternalEvents: true` 且显示 L3 原始事件。`showInternalEvents` 与 `debug` 取“或”；`errorLevel: all` 放开 internal / process 级错误；缺失 / 非法值回退 `normal` / `false` / `user`。
- **i18n**：新增文案同时进入 zh-CN 与 en 两份 catalog。

### 33.8 已知限制（0.14 / 0.14.1）

- `HostSnapshot` 不持久化、不可用于跨进程恢复；不是 RPC 控制面。
- `ToolDefinition.display` 尚未进入 `tools.list` RPC，也未在 TUI / Web 全面消费；当前 UI 仍保留按工具名的回退。
- gateway 多实例只覆盖同机同 `dataDir` 的本地实例；不做跨实例调度、故障转移、日志轮转或每实例独立配置。
- `--serve` 仍可用但不保证长期保留；脚本应迁移到 `vessel gateway start`。
- 提问仍是 120s 事件时间 TTL，未接入权限的持久化交互记录。
- 0.14.0 不单独 bump：其 P0 内容与 0.14.1 / 0.15 一并写入 CHANGELOG 的 `0.14.1` 段；未 tag / `npm publish` / 合并 `main`。

## 34. 0.14.2 质量硬化：压缩摘要与 bash 凭据路径（已实现）

> 状态：已合入 `release/0.14.2`（未发布）。决策见 [ADR-083](adr/ADR-083-compaction-summary-and-bash-command-denylist.md)。

### 34.1 压缩摘要消息契约

- `Message.compaction_summary?: boolean`（additive）：core 用于识别压缩摘要，Provider 适配层忽略。
- 摘要消息写成 `role: 'system'` + `compaction_summary: true`，由 `MemoryContextManager.applyCompaction` 写入，位置固定在基底 system 消息之后、其它消息之前。
- 应用新压缩时按对象引用移除摘要范围内消息，并移除已有 `compaction_summary`；任意时刻最多一条摘要。
- 请求组装只把非摘要的 system 视为基底 system：上下文缺 system 时补回基底 system，hook 改写 system 也只改基底 system，摘要内容不被替换。
- 动机：thinking 模式（如 DeepSeek）要求历史 assistant 消息回传 `reasoning_content`；摘要没有思维链，写成 assistant 会让压缩后的下一轮请求 400。

### 34.2 Anthropic system 合并

- Anthropic 请求只有单个 `system` 字段。`AnthropicProvider` 收集全部 `role: 'system'` 消息的 content，用空行（`\n\n`）连接成一个字符串，流式与非流式共用；没有 system 消息时传 `undefined`。
- 单条 system 的输出与合并前逐字一致；OpenAI 兼容 provider 不合并（system 作为普通消息发送）。

### 34.3 bash 命令文本 denylist：边界与绕过面

- **检查点**：`checkPermission` 命中 denylist 直接返回 `deny`（不走用户 `ask`）；`runBash` 执行前复查，命中返回带错误码 `path_denied` 的拒绝文本。
- **匹配集合**：内置 denylist `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml` 加上配置的 `deny_paths`（0.15 起参与文本匹配）。每条按写法展开：`~/<suffix>`、`$HOME/<suffix>`、`${HOME}/<suffix>`、`<os.homedir()>/<suffix>`；`~` 展开为 `~` / `$HOME` / `${HOME}` / home 目录；绝对路径同时匹配原名与 `path.normalize`；相对路径按进程 cwd 解析。比较前把 `\` 视为 `/` 并统一小写。
- **边界判定**：命中后要求下一字符不是 `\w`、`.`、`-`，避免 `~/.sshd` 被当作 `~/.ssh`。
- **不是沙箱**：只做归一化字符串匹配，不做 shell 解析。`cd` 后的相对路径、变量赋值 / 拼接、引号拆分、通配符、符号链接、`~root`、`%USERPROFILE%`、子进程自行读取等仍可绕过；不能把它当隔离边界。自定义 `deny_paths` 同理，误报/漏报都可能。
- **realpath 边界覆盖 read / edit / bash cwd**（0.15）：`edit` 与 `read` 共用 `evaluatePath`（内置 denylist 硬 `deny`、`allowed_roots` 越界降级 `ask`，配置 `deny_paths` 只能追加）；`bash` 只校验 `cwd`。命令文本检查是另一道 best-effort 字符串匹配，不替代 realpath 边界。

## 35. 0.14.3 限额可见性与 provider 错误/重试（已实现）

> 状态：已合入 `release/0.14.3`（未发布）。决策见 [ADR-084](adr/ADR-084-limit-visibility-and-provider-errors.md)。

### 35.1 `LimitBlock` 与 `limit.blocked`

`LimitBlock` 是限额命中的冻结形状（使用量限额与终止策略共用），事件与 error envelope 共用：

```ts
type LimitBlockKey =
  | 'request_limit'
  | 'tool_calls_limit'
  | 'input_tokens_limit'
  | 'output_tokens_limit'
  | 'total_cost_limit'
  | 'max_iterations'
  | 'max_runtime';

interface LimitBlock {
  scope: 'run';
  key: LimitBlockKey;
  current: number;
  max: number;
  source: string;      // 配置键路径，如 limits.inputTokensLimit
  hint: string;        // 一句可执行建议
  retryable: false;
}
```

- 判定由两个 core 纯函数完成：`evaluateUsageLimits(stats, limits)`（顺序固定 request → tool calls → input tokens → output tokens → total cost）与 `evaluateTermination(stats, policy)`（先 `max_iterations`，再 `max_runtime`），各自返回首个命中的 `LimitBlock`；`MemoryLimitChecker.checkLimits` / `checkTermination` 复用这两个函数。
- 命中时 `AgentRuntime` **发布一次** `limit.blocked`（开放字符串事件名），data 为 `{ error_code: 'limit_blocked', ...LimitBlock, run_id, session_id }`，随后抛 `LimitExceededError`（`code: 'limit_blocked'`，`details` 为同一 `LimitBlock`）。两者走同一路径，先终止策略、后使用量限额。
- 错误文本保留既有前缀，并携带 `current` / `max` / `source`：
  - 使用量限额：`Usage limits exceeded: <key> (current N >= max M, <source>)`。
  - 终止策略：`Termination policy triggered: <key> (current N >= max M, <source>)`；`max_iterations` 的 `current` 是 `requestCount`，`max_runtime` 的 `current` 是已运行秒数（保留到毫秒精度，可能为小数）。
- `run.failed` 保留原 `error` 文本，附加 `error_code: 'limit_blocked'` / `category: 'internal'` / `phase: 'run'` / `retryable: false` / `details: <LimitBlock>`；envelope 规则见 §33（只增不改）。
- 事件与 envelope 都使用同一 `LimitBlock`，不区分使用量 / 终止来源；调用方按 `key` / `source` 区分。

### 35.2 默认限额与终止值

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `limits.requestLimit` | 100 | 单 run 的 LLM 请求次数上限 |
| `limits.toolCallsLimit` | 50 | 单 run 的工具调用次数上限 |
| `limits.inputTokensLimit` | 1,000,000 | 单 run 累计输入 token 上限（0.14.3 由 100,000 提高，与 `context.maxTokens` 对齐） |
| `limits.outputTokensLimit` | 50,000 | 单 run 累计输出 token 上限 |
| `limits.totalCostLimit` | 未设置 | 单 run 累计成本上限；缺省不限制 |
| `termination.maxIterations` | 50 | 迭代上限（0.14.3 由 20 提高） |
| `termination.maxRuntimeSeconds` | 300 | 单 run 墙钟超时 |

- `termination.maxIterations` 与 `limits.requestLimit` 都按 `stats.requestCount` 计数，但语义与判定顺序不同：每轮先判终止策略（`max_iterations` / `max_runtime`，同样发布 `limit.blocked`），再判使用量限额。默认 `maxIterations` 50 < `requestLimit` 100，因此默认配置下先命中 `max_iterations`；只有把 `maxIterations` 调高或把 `requestLimit` 调低时才会命中 `request_limit`。
- 无新增配置键；tenant overlay 仍可覆盖 `limits` / `termination`。

### 35.3 `ProviderHttpError`、`Retry-After` 与 402

- core 导出 `ProviderHttpError`（`status` / `body` / `retryAfterMs?`）与 `parseRetryAfterMs(header)`。message 保持 `<Provider> API error: <status> - <body>`，不破坏既有日志与文本分类。
- OpenAI 兼容与 Anthropic 的流式 / 非流式共 4 处非 2xx 全部改抛该错误；`retryAfterMs` 从 `retry-after` 头解析（纯数字按秒、HTTP date 按当前时间差，非法 / 空值返回 `undefined`）。
- `run.failed` 的 envelope 从错误对象的 `status` 读取 `http_status`；`retryAfterMs` 不进入 envelope。
- `provider-openai` / `provider-anthropic` 的 `withRetry` 分类：
  - 可重试：429、500–599、网络类错误（`fetch failed` / `ECONNRESET` / `ETIMEDOUT` 等）。
  - 不重试：402（额度耗尽）、其它 4xx、`AbortError`；流式已输出分片后也不重试。
  - 429 且能读到建议值时，按 `retryAfterMs` / `retry_after_ms`（毫秒）→ `retryAfter` / `retry_after`（秒）→ `retry-after` 头的顺序取值，结果受 `retry_max_delay_ms` 截断、不加抖动。
  - 无建议值或非 429 时保持原指数退避 + 抖动（`retry_base_delay_ms`、`retry_max_delay_ms`、`retry_jitter`）。

### 35.4 已知限制（0.14.3）

- `max_runtime` 的 `current` 是已运行秒数（毫秒精度小数），不是整数；依赖整数展示的调用方需自行取整。
- `run.failed` 不透出建议退避时间，`retryAfterMs` 只在 provider 适配层可见。
- 第三方 provider 若既无 `status` 字段也不匹配 `... API error: <status>` 文本，仍按原有文本分类。
- `Retry-After` 只影响 429；402 直接失败，不尝试等待后重试。

## 36. 0.14.4 上下文压缩质量：保留边界与分块摘要（已实现）

> 状态：已合入 `release/0.14.4`（未发布）。决策见 [ADR-085](adr/ADR-085-compaction-retention-and-chunked-summary.md)。

### 36.1 压缩触发

- `MemoryContextManager.autoCompactAsync`：`tokenCount > maxTokens × compactThreshold`（默认 `0.8`）或消息条数超过 `messageCap` 时触发；`autoCompact: false` 时条数超限仍强制压缩。
- `messageCap`：显式 `context.maxMessages` 优先；缺省 `max(100, floor(maxTokens / 100))`，只为兜住接近零 token 的短消息，不应先于 token 阈值触发。
- 非 system 消息少于 3 条时不压缩（至少保留 2 条，没有可摘要内容）。

### 36.2 保留边界算法

`planCompaction` 同时计算两个边界，取更靠后的一个（保留更少）：

1. **token 边界**：从最新非 system 消息向前累计 `estimateMessageTokens`（content + `reasoning_content` + name + 所有 `tool_calls` 的名称与参数），预算 `maxTokens × 0.3`。累计超预算即停止；最新 2 条非 system 消息无论如何保留。
2. **条数边界**：`maxKept = max(2, messageCap - systemCount - 1)`。`systemCount` 是当前 system 消息数（旧摘要被新摘要替换，净数不变），`-1` 计入新摘要。
3. 最终 `keepFrom = min(max(tokenBoundary, capBoundary), nonSystem.length - 2)`。`keepFrom === 0` 表示全部可容纳且未超条数上限，不压缩。
4. `compactThreshold` / `autoCompact` / `summarizer` / `onCompact` 的形状不变。

### 36.3 tool 配对保护

- 保留区第一条是 `tool` 消息时，向前找到持有对应 `tool_call_id` 的 `assistant(tool_calls)`，把边界回退到该条；重复直到边界不是 `tool`。
- 目的是避免压缩后出现孤立 `tool` 消息（provider 会拒绝）。**配对完整性优先于条数上限**，回退后保留数可能略超 `maxKept`。
- 历史本身不完整（找不到 owner）时保持原边界，不继续前移。
- 压缩后的消息顺序不变：`system` 消息在前，新摘要插在基底 system 之后、其它消息之前；旧摘要一并移除（ADR-083）。

### 36.4 摘要 transcript 渲染

摘要输入由 `renderSummarizerMessage` 逐条渲染后按空行拼接：

| 角色 | 渲染 |
|---|---|
| `assistant` | `[assistant] <content>`，随后每条工具调用一行 `[tool_call:<name>] <arguments>` |
| `tool` | `[tool:<tool_call_id>] <content>` |
| 其它 | `[<role>] <content>` |

- `reasoning_content` 不进入摘要（与事件流一致）。
- 单条渲染超过 12,000 字符时截断为前 12,000 字符并追加 `\n[truncated]`，避免单条工具结果独占分块预算。

### 36.5 分块与摘要调用

- **块预算**：`min(48_000, max(2_000, floor(context.maxTokens / 8)))`，按渲染后文本的 `estimateTokens` 分组；单条超预算时独占一块。
- **单块**：一次摘要调用，输出上限 `max(128, min(context.maxTokens, 2048))`。
- **多块**：每块一次 partial 摘要（输出 ≤1024），partial 按块序拼接后一次 reduce（输出上限同上，≤2048）。
- **失败回退**：
  - partial 失败 → 写入 `[partial summary unavailable: chunk N]` 并继续后续块。
  - reduce 失败 → 按序拼接 partial，截断到 reduce 的输出 token 预算。
  - 全部 partial 失败或单块失败 → 返回空串，由 core 回退占位摘要 `[Auto Compact: N older messages summarized. Continuing...]`。
  - 摘要失败不中断 run。

### 36.6 已知限制

- token 估算是字符近似（ASCII 0.25 / CJK 0.5 token 每字符），不是 provider 精确计数；保留量与块边界会有偏差。
- 配对回退可使保留数略超 `maxMessages`。
- 摘要质量仍是 best-effort：不跨块重试，不延后补摘要，不评估摘要质量。

## 37. 0.15.0 透明化与多实例安全（已实现）

> 状态：已合入 `release/0.15.0`（未发布）。决策见 [ADR-086](adr/ADR-086-transparency-and-multi-instance-safety.md)。

### 37.1 透明化事件

三个事件名都是开放字符串（不新增常量 / 枚举），payload 为冻结形状：

| 事件 | data | 发布时机 |
|---|---|---|
| `context.compacted` | `{ run_id, session_id, removed, remaining, reason }` | 压缩实际移除消息后；`removed > 0` 才发。`reason` 取 `auto` / `overflow` / `manual` |
| `agent.limit.warning` | `{ scope, key, current, max, source, threshold, hint }` | 每 run 每 key 一次；`current >= max × 0.8` 且 `< max` |
| `agent.queue.entered` / `agent.queue.left` | `{ agent_id, run_id, position, wait_reason, since }` | Scheduler 入队 / 出队且配置了事件流 |

- **`context.compacted`**：`auto` 来自每轮请求前的 `autoCompactAsync`；`overflow` 来自 provider 400 context-overflow 后的一次强制压缩；`manual` 来自 `AgentRuntime.compactContext()`（TUI `/compact` 使用）。`remaining` 是压缩后的 `context.messages.length`，不是 token 数。压缩失败或 `removed === 0` 时不发事件。
- **`agent.limit.warning`**：判定由纯函数 `evaluateLimitWarnings(stats, limits, termination, threshold)` 完成，`threshold` 固定 `0.8`；已达到硬上限的 key 不再预警（交给 `limit.blocked`）。`source` 是 camelCase 配置路径（如 `limits.inputTokensLimit`），`hint` 是一句可执行建议。预警不改变执行，不带 `retryable`。
- **`agent.queue.entered/left`**：`position` 从 1 起（core 队首为 1）；`wait_reason` core 只产出 `capacity` / `per_agent_serial`，`paused` / `dependency` / `quota` 预留给上层调度实现。直接启动（未在队列停留）的任务没有 `entered`，也就不发 `left`。事件仅在 `SchedulerOptions.events` 注入时发布，缺省不发、不改变调度；`tenantId` 只用于盖章。

### 37.2 快照与队列

- `RunSnapshot.waitReason?: WaitReason`；`SchedulerSnapshot.queued[].waitReason`；`WaitReason = 'capacity' | 'per_agent_serial' | 'paused' | 'dependency' | 'quota'`。
- `AgentSnapshot` additive 字段：`nodeId?`、`sessionId`、`task?: { id, title? }`、`waitReason?`、`contextUsed?`、`contextMax?`、`childrenCount?`、`lastSeen?`。`InProcessRuntimeHost` 从 `transport.nodeId`、成员 `context.tokenCount` / `context.maxTokens`、`spec.metadata.task` 与 `lastSeen` 填充；不维护父子关系时 `childrenCount` 缺省。
- 快照仍是纯 JSON；`AgentSnapshot.task` 在 RPC 边界只输出标题（`hostTaskOf`），不泄漏完整 metadata。
- `SchedulerSnapshot` 由 `scheduler.snapshot?()` 提供；自定义 Scheduler 缺省时 Host 降级为成员 active run 摘要。

### 37.3 Self Card

- `AgentRuntimeOptions.selfCard?: SelfCardOptions`：`{ role, parent_id?, depth, model, tools, limits, context, how_to_ask? }`。`AgentSpec.selfCard` 由 Host 透传给成员 runtime（additive）。
- 渲染发生在 run 开始（`composeRunSystemPrompt`）与 resume 开始，每次 run 生成一次；文本以 `[Self Card]` 开头，逐行 `role` / `parent` / `depth` / `model` / `tools` / `limits` / `context` / `how to ask for help`。
- 上限按 `estimateTokens` 截断到 **400 tokens**（二分截断，不报错）。Card 追加在注入的 `systemPrompt` 之后；`before_llm` hook 仍以「基底 + Card」为基底，改写时整体替换且 Card 只出现一次。Card 不写入持久化 session（run 结束后清空 `runSystemPrompt`）。
- 主 agent 的 Card 由装配层构造：只描述已知会注册的工具（`bash` / `read` / `edit`，按配置补 `delegate_task` / `ask_user` / `team_*`）；MCP 工具在连接前不可知，不写入。`delegate_task` 的 child 由 ext 构造 `role: 'delegate'`，`limits` / `termination` 原样继承、不放大。

### 37.4 多实例锁与交互记录

- **tenant 双层锁**（`src/tenant-lock.ts`）：
  - `exclusive`：`tenants/<t>/.lock`，单写者；sqlite 后端、`--exclusive`、migrate / tenant / trace prune 使用。
  - `shared`：`tenants/<t>/.members/<pid>-<nonce>.json`，每进程一个租约；file / memory 后端默认。
  - 发布后必须复查另一侧（shared 查 `.lock`，exclusive 扫 `.members/`），保证晚发布方被看见；stale 规则统一（死 pid、不可解析超过 5s、跨主机超过 24h；回收守卫超过 10s），释放要求 `pid + started_at + host` 全等。
- **session / run 写锁**（`src/session-lock.ts`）：`tenants/<t>/.locks/sessions/<sha16(session_id)>.lock` 与 `.locks/runs/<sha16(run_id)>.lock`，内容 `{ pid, started_at, host, session_id | run_id }`，`0600` 原子发布。同进程重复获取用引用计数消化；跨进程冲突抛 `SessionLockedError`，RPC 主码 `conflict`，消息前缀 `session_locked:` / `run_locked:`。
  - `run()` 取 session 锁，`resume()` 取 run 锁（`withSessionWriteLock`）；bootstrap 的 Host resume 另外直接取 run 锁。显式指定 session 的 REPL / headless 持进程级 session 锁；`--serve` 不在空闲时持长锁，gateway 每次 run 取锁。
- **interactions 按实例隔离**：default 实例仍写 `<dataDir>/interactions-<tenant>.json`；命名实例写 `<dataDir>/instances/<instance>/interactions-<tenant>.json`（目录 `0700`）。同一 dataDir 的多实例不再互相覆盖 PID / 交互记录。
- **数据根与端口**：全局 `--data-dir <path>` 覆盖 `data_dir`（CLI > env > config）；端口被占用时 gateway 以 `port_in_use` 退出 1，且不写 PID 文件。

### 37.5 delegate 关联与嵌套

- delegate 事件（`subagent.delegate.started/completed/failed`，以及转发的 `subagent.*` 与 bridge 交互事件）补充关联字段：`tool_call_id`、`parent_session_id`、`parent_delegate_id`、`delegate_path`。`delegate_path` 是从根到当前 delegate 的 id 数组；嵌套转发保留自带 path，不被外层覆盖。
- `subagent.delegate.completed/failed` 的 data 带 `result_ref: { kind: 'run', id }`（失败路径在能拿到 child run id 时也带）。`result_ref` 只指回 child run，不内联结果正文。
- **孙 agent opt-in**：`delegate.allow_nested`（默认 `false`）/ `delegate.max_descendants`（默认 `16`，正整数）。`allow_nested: false` 时 child host 不注册 `delegate_task`；开启后为 child 新建独立 delegate 工具实例（独立 `baseDepth` / path / 后代计数），且 **child 新建 Host**——父 run 正占用注入 Host 的调度槽，复用会死锁。`max_descendants` 按根 delegate 树计数，根 delegate 本身不计入；达到上限返回错误文本。`permissionMode: 'deny'` 或显式把 `delegate_task` 写进 `disallowed` 时，即使 `allow_nested: true` 也不放开。
- child 继承父级 resolved 权限与限额，不放大；bridge 模式事件补 `delegate_path`。
- **路径边界**：`edit` 与 `read` 共用 `evaluatePath`（内置 denylist 硬 `deny`、`allowed_roots` 越界降级 `ask`）；`bash` 命令文本同时匹配内置 denylist 与配置 `deny_paths`（仍为 best-effort）。

### 37.6 RPC 与前端消费

- canonical 方法 40 → **44**：新增 `agents.tree`、`tasks.list`、`tasks.get`（read）与 `config.set`（write）。
  - `agents.tree`：`{ nodes: [AgentCard & { children_ids, children_count }], as_of }`；按 depth / started_at / id 排序，`children_ids` 只指向同一次结果中存在的节点。
  - `tasks.list` / `tasks.get`：只读派生自 `task.*` / `agent.task.*` / `team.task.*` 与 delegate 事件，不持久化；状态收敛为 `queued|running|completed|failed|cancelled`，未知 id 返回 `not_found`。
  - `config.set`：只接受白名单键（`ui.language` / `ui.statusBars` / `ui.verbosity` / `ui.errorLevel` / `ui.showReasoning` / `ui.showInternalEvents` / `ui.askUser` / `observability.showProcessErrors` / `agent.cwd`）；非 default tenant 返回 `forbidden`，未知键/值返回 `invalid_params`。
- `health.get` 增加 `runtime: { active_run_id?, scheduler: { as_of, queued[], running[], stats } }`；Host 快照优先，否则由 run 引擎派生。
- `runs.list` / `runs.get` 透出错误 envelope 字段（`error_code` / `category` / `phase` / `retryable` / `http_status?` / `details?`）与 `started_at`；durable checkpoint 缺 `started_at` 时用 `created_at`，envelope 可从 `metadata.error_meta|error_envelope|envelope` 归一。
- `events.list` 读路径与实时流一致：先 redactor，再按 8 KiB 裁剪工具参数 / 结果（`capToolEvent`）。
- 前端：TUI `/status` 展示队列 / 预警 / 最近压缩，`/agents tree` 树形视图，`/settings errorLevel|verbosity` 写回，`/compact` 走 `runtime.compactContext()`；Web 新增 Diagnostics / Tasks / Display 页，使用 canonical `agents.tree` / `tasks.*` / `config.set`。

### 37.7 已知限制

- `agent.limit.warning` 的 `max_runtime` 用 wall clock 估算，run 结束后不再更新；同一 key 只预警一次，阈值变化不会重发。
- `childrenCount` 依赖上层建立父子关系；core Host 不维护时缺省。`tasks.*` 只在进程内派生，重启丢失，不是持久任务账本。
- shared tenant 锁允许多进程共存（file 后端），它保证的是「每 session 单写者」，不是整个 tenant 的单写者；需要独占时用 `--exclusive` 或 sqlite。
- Self Card 是估算 token 截断，不保证 provider 精确 400 tokens；MCP 工具名不进入 Card。
- 孙 agent 仍受 `maxDepth` 与 `max_descendants` 双重约束；不使用注入 Host 的嵌套实例会额外创建一个进程内 Host。

## 38. 0.16.0 统一 agent 工具（Phase A）（已实现）

> 状态：已合入 `release/0.16.0`（未发布）。决策见 [ADR-087](adr/ADR-087-unified-agent-tool-phase-a.md)。
> 0.17 起本节描述的 `team_*` / `delegate_task` 工具面与 `team.*` / `delegate.*` 配置已删除；当前实现见 [§39](#39-0170-agentservice-与成员能力层已实现)。

### 38.1 工具面与装配

- 模型侧只保留**一个** `agent` schema，动作固定 `spawn` / `send` / `close`：
  - `spawn` 创建 session 并注册成员，返回成员状态；`name` / `model` / `system_prompt` / `visibility` 可选。
  - `send` 入队即返回 `{ queued: true, message_id }`，不阻塞、不等待结果；消息上限 64 KiB（UTF-8）。
  - `close` 释放成员，返回 `{ state: 'closed' }`，重复调用幂等。
- **没有** `wait` / `inbox` / `status` / `cancel` 模型工具。等待的语义是「结束这一轮，回复作为新 turn 到达」；`agents.tree` / `agents.list` 与取消路径属于 UI / CLI / 控制面。
- 装配决策在 `src/agent-wiring.ts`（纯函数）：
  - 交互 REPL / serve 默认 `agent.enabled: true`；headless / `--run` 默认 `false`。显式 `agent.enabled` 覆盖入口默认。
  - `agent` 可用 = `agent.enabled` 生效 **或** `team.enabled: true`（team 插件构造时总会注册 `agent`）；可用时不注册 `delegate_task`，避免模型同时看到两个 schema。`team_*` 只受 `team.legacyTools` 控制（默认 `true`，保留一个版本）。
  - `agent` 可用时 `delegate_task` 旧配置名在 `permission.autoApprove` 与 `delegate.disallowed` 中映射为 `agent`；未启用时不映射。
  - `agent` 依赖 team 引擎，因此交互默认会构造 team 插件；`team.enabled: true` 仍可单独开启 legacy team。
- 实测工具数（Phase A 现状）：
  - `--tools`（非 TTY，headless 口径）默认 **4**：`bash` / `read` / `edit` / `delegate_task`（team 未构造）。
  - `--tools` + `team.enabled: true` 或 `agent.enabled: true` **9**：3 + `agent` + 5 个 `team_*`；同条件 + `team.legacyTools: false` **4**：3 + `agent`。
  - 真交互 REPL（TTY）在以上结果上再 +`ask_user`，对应 **5 / 10 / 5**。

### 38.2 session 即成员

- `spawn` 新建的成员与 session 1:1（`session_id === agent_id`）；`send` 的 `to` 与 `close` 的 `member` 都可用成员 id 或 session id 寻址。
- `MemberRegistry`（`plugins/tools/team/src/registry.ts`）记录：`id` / `session_id` / `name?` / `parent_id?` / `parent_session_id?` / `owner` / `visibility` / `permission_mode` / `tenant_id?` / `state` / `current_tool?` / `last_seen?` / `usage?`。注册表只存身份与状态，不持有 runtime 对象；执行仍走 `TeamHostPort`。
- 对外成员状态（`MemberStatus`）使用 snake_case：`id` / `session_id` / `name?` / `parent_id?` / `visibility` / `state` / `current_tool?` / `last_seen?` / `usage?`。与 `agents.tree` / `agents.list` 的 `state` 同名同义。
- 可见性：`private`（默认，仅 owner）/ `team` / `tenant`；跨 tenant 不可寻址，`private` 只允许 owner。Phase A 中 `team` 与 `tenant` 在本机同一 tenant 内等价。
- 只有注册成员可被 `agent.send` 寻址；未注册 session 仍是普通本地会话。`close` 只关闭注册成员，不删除 session 数据。

### 38.3 生命周期与事件

状态机：

| 状态 | 进入条件 |
|---|---|
| `created` | `spawn` 接受，成员写入注册表 |
| `idle` | `port.spawn` 完成 |
| `running` | `send` 入队，或收到成员 turn 开始 |
| `waiting_permission` | 成员工具调用进入权限等待（bridge） |
| `completed` / `failed` / `cancelled` | 成员上一轮 run 终态 |
| `closed` | `agent.close`；先取消当前 turn，再释放成员 |
| `stale` | 定义位：进程 / owner 不可达（Phase A 不自动产生） |

- 成员事件为开放字符串：`agent.spawned`、`agent.message.queued`、`agent.turn.started` / `completed` / `failed` / `cancelled`、`agent.permission.requested` / `responded`、`agent.closed`。事件的 `run_id` 固定为成员 id。
- `send` 先发 `agent.message.queued`（`{ agent_id, message_id, from, to, kind }`）；成员 run 开始时发 `agent.turn.started`（`{ agent_id, run_id, session_id }`）；终态发对应 `agent.turn.*`（`failed` 附 `error`）。
- `close` 后到达的 run 终态不得把 `closed` 覆盖掉；未知 / 已关闭 / 不可见成员返回错误文本，不静默丢弃。

### 38.4 父 turn 注入

- core：`HookContext.messages?: Message[]`（additive）。runtime 在 `BeforeLlm` hook 之后、组装请求之前调用 `appendInjectedMessages()`，按返回顺序把消息写入上下文一次；后续迭代直接从上下文可见。
- 去重：有 `name` 或 `timestamp` 时按稳定键（`name` / `timestamp` / `role` / `tool_call_id` / `tool_calls[].id` / `content`）去重；两者都缺失时按对象引用去重。集合按 run 重置。未写 `messages` 时请求形状不变。
- 装配层：`createOwnerReplyInjector()` 注册 `BeforeLlm` hook，从 owner inbox 排空未消费回复：
  - 映射为 `role: 'user'`、`name: 'agent:<id>'`、内容 `[agent <id>] <content>`、`timestamp` 取原消息时间；过滤 owner 自己发出的消息。
  - 游标由注入器持有并随排空推进；同一回复跨轮只注入一次。注入成功发 `agent.reply.injected`（`{ owner_id, count, message_ids, follow_replies }`）。
  - inbox 读取失败发 `agent.reply.inject_failed`（`{ owner_id, error }`）并返回空数组，父 turn 继续。
- `followReplies` 目前只是配置与事件字段：回复在父会话下一次 `BeforeLlm` 时注入；它不主动开启新的父 turn。

### 38.5 权限 bridge

- 成员 `permission_mode` 是注册表一等属性：`bridge` / `allow` / `deny`。缺省交互 `bridge`、headless `allow`；显式 `delegate.permissionMode` 优先。
- `bridge`：成员权限请求在 Host 聚合流上补 `request_id` / `agent_id` / `session_id` / `parent_session_id` / `delegate_path` / `state: 'waiting_permission'`（`tool` / `input` / `source` 沿用原字段），发 `agent.permission.requested` 到父事件流；父窗口用既有内联权限卡应答（`permission.respond` / `ask.respond`），应答回灌后成员回到 `running` 并发 `agent.permission.responded`。父流与 Host 流是同一条时不重复转发原始请求，避免两张卡。
- `allow`：成员复制到的工具一律自动放行（`checkPermission: 'allow'`）。headless 成员使用该模式，不会等待无人应答的桥接请求。
- `deny`：只向成员复制 `delegate.readOnlyTools`（默认 `['read']`）。
- 成员宿主不再复制 `team_*` 与 `agent` 工具，避免成员继续 spawn / 发消息；Phase A 不支持嵌套成员。

### 38.6 兼容、配置与限制

- 配置键：`agent.enabled` / `agent.defaultVisibility`（`private|team|tenant`，默认 `private`）/ `agent.followReplies`（默认 `false`）；`team.legacyTools`（默认 `true`）。均做类型与枚举校验，非法值拒绝而不是静默回退。
- 兼容：`team_*` 5 个工具默认仍注册；`delegate_task` 代码保留，`agent` 可用时只做配置别名映射。`team_*` 创建的 legacy 成员不进入新注册表，`agent.send` 不能寻址它们。
- canonical RPC 仍为 **44**，本版本不新增方法。
- 已知限制：跨节点 `close` 不支持；`stale` 未自动产生；`followReplies` 不自动续跑父 turn；`allow` 模式是整工具放行，不是白名单逐项判定。

## 39. 0.17.0 AgentService 与成员能力层（已实现；0.19 S1/S2 修订见 §40，S3 修订见 §41）

> 状态：已合入 `release/0.17.0`（未发布）。决策见 [ADR-088](adr/ADR-088-agent-service-package.md)。
> 本节描述 0.17 当时的行为；0.19 S3 起成员 `agent` 动作扩为 `rotate|post|send|list`、owner `send` 走 dispatch，以 §41 为准。

### 39.1 分层与包边界

```text
入口（tui / src CLI / serve / apps/web）
  → 能力层 packages/agent（AgentService）
    → 执行内核 packages/core（AgentRuntime / Host / ToolPipeline / Permission）
扩展层 plugins/**（tools / providers …）
```

- `packages/agent` 是成员能力的**唯一实现**：registry、生命周期、消息队列、可见性、owner 队列、回复投递、权限 bridge、snapshot 与内置 `agent` 工具。
- `packages/core` 仍是领域无关执行内核，不知道 member / owner / visibility；成员执行经 `MemberRuntimePort` 注入。
- 入口只做输入解析、AgentService 调用与事件渲染；不得复制 registry 或另写生命周期。
- 依赖方向：入口 → agent → core；插件 → core / agent；core 不依赖 agent 或入口。`packages/agent` 只依赖 `@vessel-agent/core` 的公开入口。
- `InProcessMemberRuntime` 是 Phase A 的执行内核适配：每个 **Body** 独占 `AgentRuntime` / `Context` / `EventStream`（entries 以 `session_id` 为键；rotate 窗口内同一成员可暂时同时存在旧 / 新两个 Body runtime，但不并发 run），工具从父 `PluginHost` 按白名单复制（默认 `bash` / `read` / `edit` / `agent`），hooks / guardrails 一并继承；成员侧 `agent` schema 只保留 `rotate`（只能 rotate 自己），`delegate_task` 与 `team_*` 永久排除，成员不能 spawn / send / dispatch。

### 39.2 契约与 session 即成员

- `AgentService`：`new` / `send` / `dispatch` / `rotate` / `close` / `list`；另有 `subscribe`、`reply`、`takeMessages`、`notePermissionState`、`noteMemberEvent`、`isMemberBody`、`flushSnapshot` 供入口与执行内核使用。`dispatch` 是统一投递入口（0.19，见 §40.4）；`rotate` 见 §40.5。权限请求的活路径是 `InProcessMemberRuntime.attachBridge`（0.19 S4；`requestPermission` / `permissionBridge` 已删除，见 §44）。
- `MemberStatus`（snake_case）：`id` / `session_id` / `name?` / `parent_id?` / `owner` / `visibility` / `state` / `presence?` / `membership?` / `epoch?` / `current_tool?` / `last_seen?` / `usage?`。
- `new` 创建的成员**初始**与 session 1:1（`session_id === id`）；rotate 后 `MemberStatus.session_id` 为当前 Body 的 session，旧 Body 保留在 `body_history`。`send.to`、`close.member` 可用成员 id 或**当前 Body** 的 session；退役 Body 的 session 不再作为投递目标。未注册 session 不是成员。名字只由 `membership === 'present'` 的成员占用，`left` 后可复用（0.19）。
- `send` 入队即返回 `{queued: true, message_id, state}`，不等待一轮结束；同一成员同时只有一轮在跑，其余消息 FIFO 排队。strict `send` 对 `presence === 'gone'` 返回 `member_stale`，不自动 resume。
- 消息内容上限 64 KiB（UTF-8）；空 `to` / 空 `content` / 未知成员 / 已关闭 / gone / 不可见成员返回错误码或错误文本。
- `close` 幂等：先取消当前轮，再释放执行内核；session 数据保留，后到的 run 终态不得覆盖 `closed`。
- `visibility`：`private`（默认，仅 owner）/ `team` / `tenant`；跨 tenant 不可寻址。
- 内置 `agent` 工具是唯一模型 schema，owner 动作 `new` / `send` / `close` / `list` / `rotate`；成员侧只暴露 `rotate`，且只能 rotate 自己。`new` / `close` 接受 `members`、`send` 接受 `messages` 批处理，条目并行、按输入顺序返回逐条结果，单条失败不影响其它条目。工具调用者的 owner / parent 固定为 owner，模型不能伪造。

### 39.3 状态机、队列与快照

| 状态 | 进入条件 |
|---|---|
| `created` | `new` 接受，成员写入注册表 |
| `idle` | 执行内核 `spawn` 完成；owner attach 后 |
| `running` | 一轮开始 |
| `waiting_permission` | bridge 权限等待 |
| `completed` / `failed` / `cancelled` | 上一轮终态 |
| `closed` | `close`；不可再进入其它状态 |
| `stale` | 仅旧数据只读兼容，0.19 起不再写入；只允许 `stale → closed` |

- 消息队列只在内存；状态变化经节流合并原子写入 `<dataDir>/agents/<tenant>.json`（`0600`，0.19 起写 `version: 2`）。
- 快照形状（v2）`{version: 2, tenant_id, updated_at, members: PersistedAgentRecord[]}`；持久化 `membership` / `model` / `system_prompt` / `current_body` / `body_history`（≤20，只记已退役 Body）/ `forked_from`，不存 `presence` / `rotation` / 消息队列。读取兼容 v1，首次写 v2 前备份 `<tenant>.json.v1.bak`，备份失败则放弃写。未知版本 / 损坏 / 单条非法不阻塞启动，非法条目跳过并记录。
- 重启后非 `left` 成员统一 `state='idle'` + `presence='gone'`；`left` / `closed` 成员保持 `closed + left + gone`。未处理消息丢失。
- 成员事件为开放字符串：`agent.spawned`、`agent.resumed`、`agent.message.queued`、`agent.turn.started` / `completed` / `failed` / `cancelled`、`agent.permission.requested` / `responded`、`agent.closed`、`agent.rotating` / `agent.rotated` / `agent.rotate.failed`、`agent.retired`、`agent.reply.stale`；`agent.stale` 仅作兼容事件（payload `{state:'idle', presence:'gone'}`）。事件 `agent_id` 为成员 id。rotate 后的旧 Body 终态是配对的 `agent.turn.*`，带 `stale: true`，不写 Agent state / usage，也不投递父队列。

### 39.4 owner、外部队列与 CLI

- REPL 启动 AgentService 后监听 `127.0.0.1:0` 的最小 HTTP 控制端点；记录原子写入 `<dataDir>/agent-owner.json`（`0600`）：`{pid, host, port, token, started_at, tenant_id}`。
- 端点只接受 loopback Host（防 DNS rebinding）与 Bearer token；方法固定 `agent.new` / `agent.send` / `agent.dispatch` / `agent.rotate` / `agent.close` / `agent.list`，全部委托同一 AgentService。端点只是传输，不是第二套实现。
- 同一 `dataDir` 已有 owner 时，第二个 REPL 仍可用进程内工具；CLI attach 保持原 owner。owner 记录按 pid / token 清理，避免误删后继 owner。
- `vessel agent new|send|dispatch|close|list|rotate [--json]` 读取 owner 记录并连接；无 owner 返回 `agent_owner_unavailable`，tenant 不一致返回 `agent_owner_tenant_mismatch`。`dispatch <to> <content...>` 输出 `DispatchResult`，`queued` 退出 0、`rejected` 退出 1；`rotate <to> --startup <text> [--handoff <path>]` 输出 `RotateResult`，`rotated` 退出 0、`failed` 退出 1。
- REPL 主 agent 通过 `attachOwner` 注册为 **external owner**：它的队列只由父 turn 的 `BeforeLlm` 调 `takeMessages(ownerId)` 排空，`pump` 永不执行 owner 队列；成员 runtime 也不得消费。注入消息固定 `role: 'user'`、`name: 'agent:<id>'`、`timestamp` 取原消息时间，内容原样。

### 39.5 权限 bridge

- 成员 `permissionMode`：`bridge` / `allow` / `deny`；缺省交互 `bridge`、headless `allow`。
- `bridge`：成员的 `tool.permission.request` / `ask.user.requested` 补 `request_id` / `agent_id` / `session_id` / `parent_session_id` / `team_id` / `delegate_path` 后转发到父事件流；父窗口用既有 `PermissionCard` / `AskCard` 应答（`permission.respond` / `ask.respond`），应答只回灌该成员挂起过的 `requestId`，成员回到 `running`。0.19 S4 起 `InProcessMemberRuntime.attachBridge` 是唯一活路径；`AgentService.requestPermission` / `permissionBridge` / `PermissionBridge` 已删除。
- 没有 `parentEvents` 时 bridge 退化为 `ask → deny`，不会永久等待无人应答的请求。
- `allow`：成员复制到的工具一律放行。`deny`：只保留 `readOnlyTools`（默认 `['read']`）。0.19 S4 起有非空 `team_id` 的成员强制 bridge（忽略全局 `allow`），`deny` 保持只读工具不放宽。
- `waiting_permission` 由执行内核回调 `notePermissionState` 维护；AgentService 只接受**当前运行 Body**（`queue.activeBodySession === session_id`）的回调，旧 Body 的迟到回调以及 `closed` / `presence === 'gone'` 上的回调都会被忽略。`attachBridge` 的每成员 pending 集合按 Body session fencing，旧 Body 的迟到请求不会把 Agent 拉回 `waiting_permission`（见 §44.1）。

### 39.6 入口适配

- **tui**：`/agents` 只读消费 `ctx.events.getHistory()`，成员事件来自 AgentService；不启动 / 取消 agent。成员有效限额读 `config.agent.limits` / `config.agent.termination`。
- **Web**：权限 / ask 仍内联在所属 `RunCard`；没有匹配 `RunCard` 的当前会话请求显示在 Composer 上方兜底，其他会话或无 `sessionId` 的请求进入顶部非模态面板，复用同一张卡片，不恢复全局遮罩。面包屑显示 `agent` / `run` / `session` 短 id。`RunCard` 运行中显示 `liveText` / `liveReasoning`，没有内容时显示运行中空态占位。
- **CLI**：一次性命令 `vessel agent ...` 只做参数映射与渲染，生命周期全部在 owner。
- **ask_user**：交互 REPL（TTY）或 gateway/serve 注册；headless / `--run` / 管道不注册，`ui.askUser: false` 可关闭。

### 39.7 删除清单与兼容

- 删除 `plugins/tools/team`、`plugins/tools/delegate-task` 及 `team_*`（spawn / send / inbox / status / cancel）与 `delegate_task` 模型工具。
- 删除 `TeamConfig` / `DelegateConfig`、`team.*` / `delegate.*` 配置键、team / delegate 装配、`team-wiring` 与 `team.legacyTools` 兼容开关；tenant overlay 不再接受 `team` / `delegate` 块。
- 删除旧 owner inbox 轮询路径；owner 回复统一经 `takeMessages` + `BeforeLlm` 注入。
- `/v1/team/*` 传输协议文件与 gateway 方法保留，但 0.17 没有生产装配，也没有模型工具入口；Phase B 可复用。
- canonical RPC 仍为 **44**，本版本不新增方法；owner 端点是本地控制传输，不进入 RPC 方法表。

### 39.8 配置与限制

- `agent.enabled`（默认 `false`）是唯一开关：启用后注册内置 `agent` 工具、启动 AgentService 并尝试启动 owner 端点。
- 成员配置：`agent.defaultVisibility` / `agent.permissionMode` / `agent.readOnlyTools` / `agent.limits` / `agent.termination` / `agent.followReplies` / `agent.ownerId`。非法值与枚举拒绝，不静默回退。
- 工具数：默认 3（`bash` / `read` / `edit`）；`agent.enabled: true` 4；交互 REPL / serve 默认 4（+`ask_user`）；交互 + `agent.enabled: true` 5。
- 已知限制：Phase B 未做 Gateway attach / Web 跨 owner 代理 / durable outbox / 跨节点写路径；CLI 依赖本机 REPL owner；消息队列只在内存；`presence === 'gone'` 的成员不能严格 `send`（`member_stale`），但 dispatch 会先 resume；`followReplies` 不自动开启新的父 turn；`close` 只支持本机成员。

## 40. 0.19.0 Agent / Body 内核（S1+S2，已实现）

> 状态：S1 分支 `0.19-s1-agent-body`、S2 分支 `0.19-s2-rotate`，均未随版本发布。S1 决策见 [ADR-091](adr/ADR-091-agent-body-and-presence.md)，S2 见 [ADR-092](adr/ADR-092-agent-rotate-and-epoch-fencing.md)。rotate 已实现（§40.5）；Team / hub / Web Team / S4 权限与预算 / S5.1 出站分别见 §41 / §42 / §43 / §44 / §42.3。**未实现**：fork、S7 跨节点 A2A。

### 40.1 节点身份

- `<dataDir>/node.json` 固定 `{node_id, created_at}`，0600 原子写；`src/node-identity.ts` 的 `resolveNodeId()` 是唯一入口。
- 优先级：`config.host.nodeId` > 文件 > 首次生成 `randomUUID()` 并写回。配置优先时只比较并在不一致时告警，不改写文件。
- 文件损坏 / 字段非法抛 `node_identity_corrupt`，不静默换身份；首次写后重读，磁盘值优先（并发首启）。
- `incarnation` 仍每进程独立，只用于事件去重（ADR-067）；同一 `dataDir` 的多个 `--instance` 共用 `node_id`。

### 40.2 Agent 记录与快照 v2

- 持久化记录 `PersistedAgentRecord`：`id` / `session_id` / `name?` / `parent_id?` / `owner` / `visibility` / `state` / `membership` / `model?` / `system_prompt?` / `current_body?` / `body_history?` / `forked_from?` / `current_tool?` / `last_seen?` / `usage?`。`session_id` 仍是第一具 Body 的兼容字段，当前 Body 看 `current_body.session_id`。
- `body_id ≡ session_id`；`epoch` 只在 `current_body` 内，DTO 的 `epoch` 由它派生。首具 Body `epoch = 0`。
- 写 `version: 2`；读 v1 / v2。v1 缺省 `membership = state === 'closed' ? 'left' : 'present'`，`current_body` 由 service 补齐。首次写 v2 前备份 `<tenant>.json.v1.bak`。
- `presence` / `rotation` 不持久化；消息队列只在内存。

### 40.3 三层状态

| 层 | 值 | 写入者 | 持久化 |
|---|---|---|---|
| membership | `present` / `left` | `new` / `close`；0.19 S3 起 Team roster 的 `members add/remove` 也写入（`reinstate` / `close`） | 是 |
| presence | `live` / `gone` | spawn / 重启加载 / close / dispose | 否 |
| engine | `created` / `idle` / `running` / `waiting_permission` / `completed` / `failed` / `cancelled` / `closed` | AgentService + engine | 加载时重置 |

- 派生不存储：`canAccept = present && live && stable`、`needsResume = present && gone`、`rotating = present && rotation === 'rotating'`。
- 重启规则：`left` / `closed` → `closed + left + gone`；其余 → `idle + present + gone`。`stale` 不再写入。
- `attachOwner` 与 0.19 S3 的 `AgentService.reinstate`（roster add 专用，保留当前 Body、`presence='gone'`、不 spawn）是仅有的两条 `left → present` 人力路径；`closed → idle` 不得走普通 `setState`。
- `rotation` 由 `AgentService.rotate` 写入：切换期间为 `rotating`，所有出口恢复 `stable`；`pump` 在 rotating 时不启动新 run，`dispatch` / `send` 入队等待。

### 40.4 Body 存储与 dispatch

- 成员 engine 注入 tenant `SessionBackend` 与 `eventLog`（`packages/agent/src/runtime.ts` → `src/agent-service-wiring.ts` → `src/bootstrap.ts`）；同一 `session_id` 跨进程续接历史。S1 不做 `AgentSessionScope`，成员会话会出现在 `sessions.list`。
- `dispatch({to, content, from?})` 的 `to` 解析 id → session_id → 唯一 name；同名多个 present 返回 `invalid_input`。
- 分支：`left` / `closed` / closing → `rejected agent_left`；`rotating` → 入队 `rotating`；`live` → 入队 `live`；`gone` → single-flight resume 后入队 `resumed`；resume 失败 `resume_failed`；不可见 `not_visible`。
- strict `send` 不 resume：`left` → `member_closed`，`gone` → `member_stale`。0.19 S3 起 `agent` 工具的 `send` 走 dispatch（成员走 `TeamService.send`）；strict `service.send` 只保留给 owner 端点 / CLI。

### 40.5 rotate 与 epoch fencing

- **入口**：`AgentService.rotate`；owner 端点 `agent.rotate`；CLI `vessel agent rotate <to> --startup <text> [--handoff <path>] [--json]`；`agent` 工具 `action: rotate`（成员只能自换）。S2 不新增 canonical 方法；当前方法表见 §13.7。
- **前置**：只换活身体（`presence !== 'live'` → `body_not_live`）；`left` / `closed` / closing → `agent_left`；并发 rotate → `rotating`；external owner → `owner_not_rotatable`；工具路径 `from_session_id` 必须等于当前 Body session，否则 `not_current_body`。
- **切换**：新 Body 新 `session_id`、`epoch + 1`，按 Agent 配置 spawn。顺序：spawn → 旧指针进 `body_history`（≤20）→ `setCurrentBody` → `scheduleSnapshot()` → `await flushSnapshot()`（返回 boolean，无 snapshot 时 `true`）→ 启动嘱托 `unshift` → `rotated` → `rotation = stable` → `pump`。
- **失败**：spawn 失败 / 快照写失败 → 指针与 `body_history` 回滚、dispose 新 engine、`rotation` 回 `stable`、不插入启动嘱托、返回 `rotate_failed`；不 fork、不自动重试。flush 已提交后的 close 竞态不回滚指针。
- **排队**：rotating 期间 `dispatch` / `send` 入队；切换后顺序为启动嘱托 → rotate 前队列 → rotating 期间新队列，全部由新 Body 处理。
- **epoch fencing**：`pump` 捕获 `activeBodySession`；旧轮结束后若不再是当前 Body，发带 `stale: true` 的配对 `agent.turn.*`、`agent.reply.stale`，dispose 旧 engine、发 `agent.retired`；不写 Agent state / usage，不 `deliverToParent`。
- **寻址与快照**：`entries` 按 `session_id` 键；`bySession` 跟随 `current_body`；`MemberStatus.session_id` / 默认事件 session 报当前 Body；`body_history` 有界持久化，快照仍 v2。
- **成员工具**：`agent` 在成员默认工具白名单内，schema 暴露 `rotate` / `post` / `send` / `list`（0.19 S3；`rotate` 只能自换，`new` / `close` 只给 owner）；成员 `permission.autoApprove` 追加 `agent`，service 的 `from_session_id` 比较是 rotate 的最终闸门。
- **预警与权限**：`agent.limit.warning` 经 `onMemberEvent` 回到 service，按当前 Body session 去重后作为下一轮系统消息；`notePermissionState` 与 `attachBridge` 的每成员 pending 按当前运行 Body session fencing（0.19 S4；`requestPermission` 已删除）。

## 41. 0.19.0 Team（S3，已实现）

> 状态：分支 `0.19-s3-team`，未随版本发布。决策与 Addendum 见 [ADR-091](adr/ADR-091-agent-body-and-presence.md)。

### 41.1 存储与数据模型

- 实现位于 `packages/agent`：`team-store.ts`（元数据）、`team-log.ts`（只追加日志）、`team-slug.ts`（workspace 归一化 / slug）、`team-service.ts`（编排）。
- `<dataDir>/teams/<tenant>/<team_id>/team.json`：`{v:1, team_id, name, tenant_id, workspace, handoff_path?, policy, created_at}`，`atomicWrite` 0600。`team_id` 由 workspace 目录名生成 slug，创建后不可变；同 slug 不同 workspace 追加 hash 后缀。
- `<dataDir>/teams/<tenant>/<team_id>/log.ndjson`：每行一条 `TeamLogEntry`（`message_id` / `team_id` / `from` / `to[]` / `mentions[]` / `content` / `ts` / `kind` / `system_event?`），串行只追加、有界读（尾部窗口）、坏行跳过；**不是消息队列**。
- `team_id` 在 Agent 记录上 additive 持久化；roster 不单独落盘，由 `team_id + membership === 'present'` 从 Agent 记录派生。`online_count` 由 `present && presence === 'live'` 派生；`body_history` 直接透传 Agent 记录（≤20）。
- 绑定：显式 `--workspace` 或配置 `teams:` 声明（归一化后精确匹配）才会绑定；默认绑定只对带 `name` 的 Agent 生效。绑定后未显式指定时 visibility 缺省 `team`；unbound 保持 `private`。Agent 不支持跨 Team 迁移。

### 41.2 消息与投递

- **无 `@` 的 post / reply / system 绝不产生 run**：TeamService 不持有 AgentService 队列，`pump` 仍是唯一 run 起点。
- `@` 使用结构化 `mentions: string[]`（agent id），不从正文解析；先写日志再逐条 `dispatch`，日志写失败不产生任何 run。逐条结果以 `delivered[]` 返回（`queued` / `rejected` / `error`），一条失败不影响其它条目，也不回滚日志。
- 系统消息 `join` / `leave` / `archive` / `rotate` 由 TeamService 订阅 `agent.*` 写入；TeamService 是唯一写入点。`TeamService.subscribe` 只对外发 `{team_id, kind, message_id?}`，**不含正文**（供 hub 投影指针）。
- 成员完成一轮、有最终文本且 `team_id` 非空时，AgentService 发 `agent.reply.posted`；TeamService 追加 `kind:'reply'` 日志（≤64 KiB，超限截断标记），**不 dispatch**；`message_id` 与事件一致。`agent.turn.completed` 仍不带正文。

### 41.3 生命周期、可见性与 RPC

- `teams.members action=add` 调用 `AgentService.reinstate`：`left` / `closed` → `present + idle + gone`，保留 `current_body` / `body_history` / 原 session，不 spawn；下一次 dispatch 才 resume。`action=remove` 复用 `close`：dispose 当前 Body、保留 session 与历史（归档不删）。
- private 成员 fail-closed：`onAgentEvent` 只接受 `visibility === 'team' | 'tenant'`；private 成员的 id / 名字 / 回复不写日志、不可被 `@`（owner 路径 `team_private_member`，canonical 路径 `unknown_member`）。根 owner（`owner === id`）例外。
- canonical `teams.list` / `teams.get`（read）与 `teams.post` / `teams.members`（write）由 `TeamControlLike` 结构化注入；`packages/serve` 不依赖 `@vessel-agent/agent`。未注入 / tenant 不匹配返回 `not_found`；0.19 S3 只有 default tenant 的 AgentService 注入 `teams.*`，其他 tenant 返回 `not_found`。canonical 是复数 `teams.*`，与 legacy `/v1/team/*`（单数前缀）无关。
- `vessel team list|get|post|members [--json]` 经 owner 端点；owner 端点是 `from = ownerId`、`viewer = ownerId`（private 可见），canonical 为 `from = 'human'`、无 viewer。

## 42. 0.19.0 Hub 控制面（S5 / S5.1，已实现）

> 状态：S5 分支 `0.19-s5-hub`、S5.1 分支 `0.19-s5.1-node-outbound`，均未随版本发布。决策见 [ADR-093](adr/ADR-093-hub-control-plane.md)。

### 42.1 形态与协议

- hub 是 app 层独立前台进程：`vessel hub start [--host] [--port] [--data-dir] [--allow-remote] [--tls-cert/--tls-key]`，实现位于 `src/hub/`，不新增 package、不启动 runtime / AgentService / TenantEventHub。
- 两个方向共存，共用同一套 `vessel.hub/1` 帧；帧统一带 `dialer: 'hub' | 'node'`，表示**连接发起方**：
  - **hub → node（S5）**：节点侧 `POST /v1/hub/pair`（一次性配对码）与 WSS `/v1/hub/control`；节点收到 `dialer !== 'hub'` 以 4400 关闭。
  - **node → hub（S5.1）**：节点 gateway 配置 `hub.direction: node` 后主动拨号 `${hub.url}/v1/hub/node-control`；hub 作为 acceptor，只接受 `dialer: 'node'`（错配 4400）。节点无需开放入站端口，可只监听回环。
- hub 侧：`GET /health`、`GET /v1/hub/directory`、`GET|DELETE /v1/hub/nodes/:pairing_id`、`POST /v1/hub/nodes`（配对 / 移除节点只接受回环 peer）、`POST /v1/hub/join`（node 用一次性 join code 换 `scope:'node'` token）、WSS `GET /v1/hub/node-control`、`GET /v1/hub/events`（WS：`hello` / `snapshot` / `pointer` / `ping`）、`POST /v1/hub/data-token`。
- 节点侧状态：`<gatewayDataDir>/hub-node.json`（URL / `hub_id` / `node_id` / `tenant_id` / `pairing_id` / `token_id` 等非秘密状态）与 `<gatewayDataDir>/hub-node-status.json`（运行状态）。hub 侧 `<hubDataDir>/hub-join.json` 只存 join code 的 `sha256`，`<hubDataDir>/node-tokens.json` 只存 node token 的 `sha256` 与绑定元数据。
- hub 与节点必须使用不同 `data_dir`，相同则 `hub_data_dir_conflict`；该检查只适用于 hub 进程，node 状态位于 gateway 的 data dir。

### 42.2 目录、指针与不代理正文

- 目录持久化 `<hubDataDir>/registry.json`（0600 原子写、250ms debounce），主键 `pairing_id = node_id:tenant_id`；记录 `status`（`connecting|healthy|unreachable|incompatible|unauthorized`）、`last_seen`、`incarnation` / `revision`、计数与 Team / Agent 元数据。上限 500 teams / 2000 agents，超限置 `truncated: true`。记录另补 `direction`（旧文件缺省按 `hub` 读）、`public_url?` 与 `data_plane`。
- `data_plane: 'direct' | 'unreachable'` 由 `public_url ?? url` 派生，只描述正文可达性，不影响控制面 `status`。NAT 节点没有浏览器可达地址时，聊天 / 事件 / 权限正文需要用户提供隧道或反向代理；hub 不做正文中继。
- 指针固定 `{node_id, team_id, request_id?, reason, ts}`；只在线推送、不持久化、不排队，消费方按 `ts` 超过 60 秒丢弃。客户端收到指针后**直连节点**拉取正文。
- hub **不代理、不落盘**消息正文 / transcript / system prompt / workspace / session 内容 / 事件 payload / tool 结果。`HubControlLike.snapshot` 只返回白名单投影；`TeamService.subscribe` 只带 id。
- 快照按 `(incarnation, revision)` 比较：incarnation 变化无条件接受并重置 revision；同一 incarnation 下旧 revision 丢弃。node → hub 方向沿用同一判定；同一 pairing 只保留一条活动连接，新连接接管，旧连接的 close 不覆盖新状态。

### 42.3 配对、scope 与密钥

- 一次性配对码只存 `sha256`、默认 300 秒、消费时先原子写 `used_at`；配对签发 `view` + `exchange` 两枚 token（默认 30 天、可吊销）。节点侧 `<dataDir>/hub-tokens.json` 只存 `sha256(token)` 与元数据，明文只在签发响应出现一次。
- scope 为 `view | exchange | control | admin`，映射既有 `read / write / admin` rank，不新增 role。`view` 只读目录 / 健康；`exchange` 只能调用 `auth.exchange`；`control` 走节点控制面白名单（events / interactions / permission / ask / teams read + post）；`admin` 走既有 admin 面。
- token 记录绑定 `hub_id`；`/v1/hub/control` 首帧 `hub_id` 必须与记录一致。吊销 `auth.revoke` 关闭匹配 `token_id` 的已建 WS，新 HTTP 请求重新鉴权。
- hub 的 `view` / `exchange` token 走 `SecretStore`（Windows DPAPI / macOS Keychain / Linux libsecret）；仅当 `hub.allow_file_secrets: true` 才退到 AES-256-GCM 文件适配器，否则 fail-closed。不写明文 YAML / `registry.json`。
- S5.1 join：hub 生成一次性 join code（`vessel hub join-code`，只存 `sha256`、默认 300 秒），node 用 `vessel hub join <hub-url> --code` 经 `POST /v1/hub/join` 换取 hub 签发的 `scope: 'node'` token（默认 30 天）。hub 只存 token 的 `sha256`，node 把明文存 SecretStore；token 绑定 `hub_id` / `node_id` / `tenant_id`，任一不匹配 4401，且只被 `/v1/hub/node-control` 接受（不进 `PrincipalScope` / canonical RPC）。
- canonical 新增 `auth.exchange`（write）/ `auth.revoke` / `auth.tokens`（admin）；workflow 移除后 40，S3 + S5 + S4（`teams.budget`）合并后 canonical 总数 **48**；S5.1 不新增 canonical。

### 42.4 team-scoped token 收窄

- `control` token 的 `team_id` 由 principal 携带；`teams.*` handler 在调用前比对，不匹配一律 `not_found`（不泄漏跨 team 存在性）。
- `teams.list` 只返回 token 自己的 team；`teams.list` / `teams.get.team` 的 scoped 响应剔除 `workspace` / `handoff_path` / `policy`，只保留展示元数据。`teams.get` 的 `members` / `messages` 属 data plane，不脱敏。
- 事件订阅先按 `event.data.team_id` 匹配 principal；没有 team_id 才回退 `session_id → teamForSession`；两者都无法判定 → 丢弃（fail closed）。S4 的 `team.budget.*` 没有 session，必须带 `team_id` 才能通过 team-scoped 过滤。

## 43. 0.19.0 Web Team 群聊（S6，已实现）

> 状态：分支 `0.19-s6-web-team`，未随版本发布。只改 `apps/web/**`，消费 S3 / S5 契约。

- 路由：`#/team`（列表）、`#/team/<teamId>`（群聊 + 成员侧栏）、`#/team/<teamId>/members/<memberId>`（成员详情 / Body 历史）、`?body=<sessionId>`（旧 Body 只读 transcript）。
- 数据源：`teams.list` / `teams.get` / `teams.post`（HTTP RPC）；`teams.get` 只有 `limit`（默认 100、最大 1000），没有游标；Web 通过增大 `limit` “加载更早”，并明确显示截断上限。
- 群聊：`post` / `mention` / `system` / `reply` 四类；系统消息按 `system_event` 渲染灰条；`kind:'reply'` 与轮询结果按 `message_id` 去重，事件只做即时插入 / 刷新，轮询仍是权威源。
- `@` 补全只从当前 Team `present` roster 取，提交结构化 `mentions: [agent_id]`；正文里的 `@` 不解析。private 成员不在 canonical roster 中，不可 `@`。
- 成员侧栏 / 详情：`presence`（`live|gone`）、engine state（`waiting_permission` 映射为「等批准」）、epoch、当前 Body 与 `body_history`。Body 历史优先消费服务端 `body_history`；字段缺失才回退事件观察并标注“本次页面会话”。
- `TeamSummary.online_count` 直接用服务端派生字段；缺失显示 `—`，不客户端反推。attention 只做权限 / ask 计数与跳转，权限卡片仍在所属 `RunCard`，不恢复全局遮罩。
- Web 只暴露 `teams.list|get|post`；`teams.members` add / remove 仍走 CLI / owner 端点。Web 当前不消费 hub 目录 / data token，跨节点 Team 属 S7。

## 44. 0.19.0 S4 权限 only-human 与 conversation 预算（已实现）

> 状态：分支 `0.19-s4-permission-budget`，未随版本发布。决策见 [ADR-079](adr/ADR-079-permission-lifecycle-persistence.md) 与 [ADR-091](adr/ADR-091-agent-body-and-presence.md) 的 S4 Addendum。

### 44.1 权限 / 提问 only-human

- 唯一活桥是 `InProcessMemberRuntime.attachBridge`：成员 `tool.permission.request` / `ask.user.requested` 补 `request_id` / `agent_id` / `session_id` / `parent_session_id` / `team_id` / `delegate_path` 后转到父 `parentEvents`；父流应答只回灌该成员挂起过的 `requestId`。
- `AgentService.requestPermission`、`AgentServiceOptions.permissionBridge`、`PermissionBridge` 已删除（生产从未接线）；`notePermissionState` 保留，仍按当前 Body session fencing。
- 应答入口只有：TUI / Web / RPC（`answered_by: 'human'`）、team 显式 `deny-after` 与 headless root auto-allow（`answered_by: 'policy'`）。agent 工具、TeamService、owner 端点没有应答入口；`answered_by` 不接受 `agent`。
- Team 成员强制 bridge：有非空 `team_id` 时忽略 `agent.permissionMode: 'allow'`；显式 `deny` 保持只读工具；无 `parentEvents` 时走既有 `permission_ask_denied` → deny，不挂起、不自动 allow。
- 默认 `hold`：不建定时器，gateway pending 持久化，重启后转 `orphaned`，迟到应答 `run_ended`。只有 team policy `permission.unattended: 'deny-after'` + `deny_after_seconds` 才建一次性 deadline；到期以 policy deny / 空 answers 应答。没有 `allow-after`，没有全局 TTL。

### 44.2 交互审计与 ask 持久化

- interaction record additive：`kind: 'permission' | 'ask'`、`agent_id?`、`team_id?`、`parent_session_id?`；answer 带 `answered_at` / `answered_by` / `answered_via?` / `policy?` / `latency_ms` / `answers?`。
- `permission.respond` / `ask.respond` 先到先得：同决定 `duplicate: true`，不同决定 `conflict`，已 orphaned `run_ended`，未知 requestId `not_found`。RPC handler 强制 `answered_by: 'human'` / `answered_via: 'rpc'`；TUI 直接事件记 `answered_via: 'tui'`；旧记录缺 `answered_by` 按 legacy human 读。
- ask 与 permission 共用 interaction store，删除内存 `pendingAsks`；`interactions.list` 的 `answer.required` 只保留 `answered_at`，`kind: 'ask'` 用 `questions` 回显。
- 成员 pending 在 `agent.turn.completed|failed|cancelled` / `agent.closed` 按 `agent_id + session_id` 转 `orphaned`；root run 终态仍按 `run_id` 清理。`interactions.list` 的 team 过滤先看 `record.team_id`，缺失才回退 session 映射。

### 44.3 `conversation_id`

- 格式 `conv_<uuid>`；`dispatch` / `send` / Team `post` / 成员 `send` / `reply` / `deliverToParent` / rotate startup / limit warning 都 additive 携带；Team log 与 `teams.get` message 保留该字段。
- 人类入口无 id 时生成；Team post 一次生成、所有 mention 共用；成员 send / reply 继承当前 turn；rotate startup 继承触发轮。不按名字 / 正文分组。
- 一个 conversation 的 `team_id` 是 origin team；跨 Team 复用另一 team 的 conversation 拒绝 `conversation_team_mismatch`。成员 send 的本机 A2A 保留 id；跨节点 A2A 属 S7。

### 44.4 conversation 预算

- 预算挂在 `teams[].policy.budget`，**不复用** `limits.*`（后者是 per-run、只在 tool loop 判定）。
- 维度：`max_hops` / `max_turns` / `max_tokens` / `max_wall_clock_seconds`；`max_cost` 不实现（`Usage` 没有 cost 字段）。`warning_threshold` 默认 0.8；`cycle.max_repeats` 默认 2、`cycle.cooldown_seconds` 默认 60。环检测默认开启、不可关闭；其它维度只在配置后生效。
- 发送侧入队前检查（hops / cycle / wall-clock / 已耗尽 turns、tokens）；接收侧 `pump` 起轮前再查一次（turns / tokens / wall-clock / blocked）。被接收侧挡下的消息留在队列（hold），不静默丢；人工 override 或新会话解除。**无预算轮询 / 后台定时器**。
- 唯一写者是 `AgentService` 的 `ConversationBudget`；token 取成员 turn 完成的 `total_tokens ?? prompt + completion`，失败 / 取消无 usage 不计。

### 44.5 持久化与重启

- `<dataDir>/conversations/<tenant>.json`（v1，0600，`atomicWrite`，debounce；turn 完成 / blocked / override 强制落盘）。有界：1000 条按 `last_activity` 淘汰；带 override / blocked 的额外保留 ≤50；每 conversation 边表 ≤32。
- 损坏 → `conversation_budget_corrupt` / `budget_unavailable`，该 tenant 预算 fail-closed，不静默重置、不覆盖文件。
- 重启保留计数 / overrides / blocked；未消费消息队列丢失；崩溃中的 turn 可能少记一次 tokens / 完成计数（不宣称精确）。告警去重只在进程内，重启可能重发一次。

### 44.6 override、事件与 scope

- 人工 override：canonical `teams.budget`（`write`，`status | override`）+ owner 端点 `team.budget` + CLI `vessel team budget`。只能抬高当前限额或 `max: null` 清除，只对已存在 conversation 生效；不能修改 team policy 本身。审计写 Team 日志 `system_event: 'budget_override'` 并发布 `team.budget.override`。
- `teams.budget` **不在** `CONTROL_SCOPE_METHODS`：team-scoped control token 调用返回 `forbidden`，不能给自己续命。`permission.respond` / `ask.respond` 仍在 control scope，归属按 `record.team_id` 优先、session 回退、都无法判定则 `forbidden`。
- 事件（开放字符串、必带 `team_id`）：
  - `team.budget.warning`：`conversation_id` / `dimension` / `current` / `max` / `threshold` / `phase: enqueue|turn_start`。
  - `team.budget.blocked`：再加 `reason: budget_exceeded|cycle_detected|budget_unavailable`；cycle 带 `retry_after_ts?`。
  - `team.budget.override`：`dimension` / `previous_max` / `max` / `by: 'human'` / `via: 'cli'|'api'`。
- WS team-scoped 过滤：`data.team_id` 优先匹配 principal；没有 team_id 才回退 `session_id → teamForSession`；两者都没有 → 丢弃。预算事件没有 session，必须靠 `team_id` 放行。
- hub 不投影预算；Web S4 只收事件不渲染（S6 预算 UI 未实现）。

## 45. 0.20.0 fork 与跨节点 federation（已实现）

### 45.1 fork

- `AgentService.dispatch` 在 `presence === 'gone'` 且 resume 失败后，按
  `teams[].policy.allowFork`（缺省 false）或显式 `allow_fork`（仅 owner / CLI）执行 fork。
  不新增 `agent` 工具动作、不新增 canonical RPC；rotate 失败不自动 fork。
- 新 Agent：新 id / name / session，`epoch = 0`、`body_history = []`、`forked_from = 源`；
  继承 owner / parent / visibility / team / model；prompt = 源 prompt + 绝对 handoff 路径；
  不带历史。原 Agent 保持 `present + gone`。
- private 源、无 Team、无 `handoff_path`、`already_forked` → `resume_failed` 且零写入；
  spawn 失败 → `fork_failed`；spawn 期间源被关闭 → 回收并 `agent_left`。
- 事件：`agent.forked {from,to,team_id}` + Team `system_event: 'fork'`。父级已
  left / closed / gone 时回复发 `agent.reply.dropped`，不入队。
- 快照仍 v2；`DispatchResult.resolution` 增加 `'forked'`。详见
  [ADR-091 Addendum](adr/ADR-091-agent-body-and-presence.md)。

### 45.2 跨节点 federation（team ↔ team）

- 默认关闭；全局 `federation.peers[]` 显式 allowlist，wire 只含 `(node_id, team_id)`。
  入站 `POST /v1/federation/messages`，出站 `vessel federation post|peers`；
  hub 不在数据面。详见 [ADR-094](adr/ADR-094-federation-team-to-team.md)。
- 严格解析、peer bearer（`tokenEnv`）、非回环 https、hop 上界、自指环拒绝、进程内去重。
- 入站默认只写 Team 日志（0 run）；`teams[].policy.federation.accept = 'members'`
  才对本机 present 非 private 成员 fan-out。
- v1 固定 default tenant；不新增 canonical RPC；legacy `/v1/team/*` / `RemoteTransport` /
  `NodeRegistry` 冻结，禁止新增调用方。

### 45.3 canonical 与边界

- 0.20 新增 fork 与 federation 传输面，但**不新增 canonical 方法**，方法表仍 **48**
  （47 个 domain 方法 + `events.subscribe`）。
- `packages/serve` 仍不依赖 `@vessel-agent/agent`；`packages/core` 不出现 Team / federation 概念。
