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
- **工具调用统一走 `ToolPipeline`**（0.8.2，ADR-058）：`AgentRuntime`、workflow `type: tool` 与 delegate 共用同一阶段顺序；handler 只由管道调用，由它套 `tool.timeout` 与 `ctx.signal`——handler 直调会让 `timeout` 与权限判定失效。权限判定发生在 ToolCall guardrail / BeforeTool 的改写之后，针对最终工具与参数。
- **工具失败不终止 run**。错误变成 `role: tool` 消息回到上下文，模型自己纠。非法 tool arguments JSON 也走这条路径（解析一次、发 `tool.call.failed`、折回错误文本）。
- **发给 Provider 的消息始终是合法序列**：`buildRequestMessages` 在输出前丢弃孤儿 `role: tool`、把不完整 `tool_calls` 轮次降级为普通 assistant 文本，并在上下文缺 system 时补回基底 `systemPrompt`。归一化只影响本次请求，不改 `ContextManager` 的持久化记录。
- **Guardrail `replacement` 四阶段生效**：Input（改写持久化的用户消息）、Output（改写返回值与持久化 assistant 消息）、ToolCall（改写实际执行的调用，先于 assistant 消息写入）、ToolResult（改写事件、上下文与返回值）；非法类型按未改写处理。
- **thinking 模型的 `reasoning_content`**：Provider 返回后保存在 assistant 消息并随下一轮请求回传（含 `tool_calls` 轮次）；`llm.request` / `context.changed` 事件在发布前剥离该字段，TUI / 观测 / 回放看不到思维链，会话持久化保留（ADR-038）。
- **权限是执行期判定，不是注册期过滤**：`checkPermission` 返回 `'allow' | 'deny' | 'ask'`；`'ask'` 走事件流等用户决定（`tool.permission.request` → `waitFor('tool.permission.response')`，120s 超时）。未声明 `checkPermission` 的工具走 `RuntimePermissionConfig` 默认策略（库默认 `'allow'`，交互模式由装配层传 `'ask'`）。
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

工具的实际执行统一走 `ToolPipeline`（0.8.2，ADR-058）：`getTool` → ToolCall guardrail → BeforeTool hook → 权限（最终工具与参数）→ handler（timeout + signal）→ ToolResult guardrail → AfterTool hook（仅成功）。`ToolPipelineStages` 可关闭调用方已在外层处理的阶段；`AgentRuntime`（含 delegate 子 runtime）关闭 guardrail/BeforeTool/AfterTool，只复用 permission / handler / ToolResult，workflow 使用默认全开。

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

实现：`MemoryRunStore`（进程内）与 `FileRunStore({ dir, tenantId? })`（每 run 一个 JSON 文件，temp + rename，Windows best-effort）。从 `@vessel/core/session` 与根入口导出。**`RunStore` 是 module port，不是第 10 个扩展接口**；`SessionBackend`（会话对话持久化）与它正交（ADR-040）。

0.8 起（A5）：`FileRunStore` 接受可选的 `tenantId`。tenant 模式下 `delete(runId)` 先 `load()` 校验归属——缺失或属于其它 tenant 时直接 no-op，不 unlink 文件；与 `FileSessionBackend.delete` 的 foreign 会话语义对称。装配层在 `--resume-run`、单 agent 与 per-tenant runtime 三条路径都把 `tenantId` / `tenantRunsDir` 透传到 store。

0.8.1 起（ADR-056）：`list` 增加可选 `offset`（过滤、排序后切片，用于 `deleteSessionData` 的全量分页冲突检查）。tenant 模式下 `FileRunStore.load()` 把非 ENOENT 读取错误、JSON 解析失败与非法 checkpoint 形状视为损坏并抛 `SessionCorruptError`（`code: 'session_corrupt'`）；`delete()` 让该错误向上传播，绝不删除归属未知的文件。非 tenant 模式保持 0.3 的宽松语义（损坏 → `null`）。

0.4 增加 `pruneRuns(store, opts?)` helper（`PruneRunsOptions` / `PruneRunsResult`，从根入口与 `@vessel/core/session` 导出），按 `status` / `older_than_ms` / `keep_latest` 清理 run；**不修改 `RunStore` 接口**，也不自动调度（ADR-045）。

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

**MCP（0.3）**：`@vessel/mcp-client` 是**插件**，不是 core 模块。配置 `mcp_servers` 后由 asm 装配层构造；工具经 `PluginHost.registerTool` 进入语言空间。stdio 与 HTTP（Streamable HTTP）两种传输；工具名默认 `mcp__<server>__<tool>`；权限默认 `ask`；单 server 失败不影响其他 server（ADR-039）。

## 8. 插件发现

**唯一一套：运行时目录扫描**（`src/plugin-loader.ts`）。

```
plugins/
├── tools/basic-tools/       package.json + src/index.ts   → bash / read / edit
├── tools/delegate-task/     → delegate_task（工厂式）
├── tools/team/              → team_* 5 个（工厂式；默认不加载，team.enabled 才构造）
├── mcp/client/              → MCP client（工厂式；配置 mcp_servers 才构造）
├── workflow/engine/         → @vessel/workflow（工厂式；workflow.enabled 才构造）
├── evals/harness/           → @vessel/evals（工厂式；asm 直接调用库，不注册工具）
├── im/feishu/               → @vessel/feishu（工厂式；--feishu 才启动）
├── security/guardrail-pii/  → 输入输出 PII 脱敏
├── security/redact-secrets/ → 工具结果与输出里的密钥脱敏
├── security/tool-policy/    → ToolCall 阶段 allowlist / denylist
├── observability/hook-logging/
└── provider/{openai,anthropic}/
```

共 **13 个插件包**。规则：`plugins/<category>/<name>/package.json` + `src/index.ts` 存在即注册，**无需改代码、无需构建步骤**；`src/index.ts` 的默认导出须是 `Plugin`（含 `install()`）。目录形态不是 Plugin 的（例如默认导出是工厂函数、需要装配层注入依赖）列在 `FACTORY_PLUGINS` 里，由装配层自行构造——目前是 `delegate-task`、`team`、`mcp-client`、`workflow`、`evals` 与 `feishu`。`team` 还要求 `team.enabled: true` 显式 opt-in；MCP 要求至少一个 `mcp_servers` 条目；workflow 要求 `workflow.enabled: true`；evals 由 CLI 直接调用；feishu 只有显式 `--feishu` 才启动。`PluginLoader` 的默认集与 `plugins:` 显式列表都会过滤它们。0.8.2（ADR-058）起，装配层给 delegate 注入父级 resolved 权限，并给 workflow 注入统一的 `ToolPipeline`——workflow 的 `type: tool` 不再直调 handler。

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
| `delegate.enabled` / `maxDepth` / `disallowed` / `model` / `limits` / `termination` | `delegate_task` 接线；`enabled: false` 时默认工具变为 3 |
| `delegate.permission_mode` | `bridge`（交互默认）/ `allow`（headless 默认）/ `deny`；`deny` 时保留 `read_only_tools`（默认 `["read"]`） |
| `team.enabled` / `ownerId` / `model` / `memberLimits` / `memberTermination` | 进程内 team 原型；默认 false，必须显式开启；0.3 删除 `maxMembers`（Host 必填后无效果） |
| `mcp_servers.<name>.*` | MCP server：`transport`（stdio/http）、`command`/`args`/`env`、`url`/`headers`、`enabled`、`connect_timeout_ms`、`tool_timeout_ms`、`tool_prefix`、`auto_approve_tools` |
| `durable.enabled` / `backend` / `path` / `checkpoint_every` | 默认 false；`backend: file \| memory`；0.5 起 `path` 默认 `<data_dir>/tenants/<tenant_id>/runs`，显式配置优先但可逃出 tenant（启动 warn）；0.3 只接受 `checkpoint_every: iteration` |
| `serve.hostname` / `port` / `allow_remote` / `tls.cert_file` / `tls.key_file` | 默认 `127.0.0.1:8642`、明文；非回环必须 `allow_remote: true`、token 非空**且 TLS cert/key 成对**（0.6 起强制） |
| `serve.allowed_origins` | 独立前端 Origin allowlist；绝对 http(s) origin，禁止 `*` / path / query；非回环必须 https；HTTP 与 WS 共用（0.6） |
| `connect.token` / `token_env` / `ca_file` | `--connect` 客户端 token 与 CA；token 优先级 CLI > env（`VESSEL_CONNECT_TOKEN`，缺失时回退 `VESSEL_GATEWAY_TOKEN`；`token_env` 由 loader 在 env 层解析）> config（0.6；0.8.1 统一经 loader，`--ca` 对应 `VESSEL_CONNECT_CA`） |
| `transport.kind` / `transport.nodes[]` | `in-process` / `loopback` / `remote`；`remote` 时静态节点 `{ id, url, token?, token_env?, ca_file? }`，无自动发现（0.6） |
| `serve.token` / `serve.token_env` / `serve.tokens` / `serve.admin_token` | 0.5：`serve.token` 为 default/admin 兼容单 token；`serve.tokens` 为 token → `{tenant_id, role}`；`serve.admin_token` 为 `*`/admin；解析顺序见 ADR-050 |
| `workflow.enabled` / `dir` / `path` / `max_parallel` / `step_timeout_ms` | 默认 false；`dir` 默认 `./workflows`、`path` 默认 `~/.vessel/workflows`；`max_parallel` 1..8（默认 2）；`step_timeout_ms` 1..86400000（默认 300000）。`enabled: true` 且 `dir` 不存在 → 启动失败 |
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

0.4 的四个新块**全缺省时行为与 0.3 一致**：不构造 workflow 引擎、CLI `eval` 不可用、不启动飞书、不注入 metrics；`event_history` 仍为 1000。严格校验：类型、范围、未知键；`feishu.enabled: true` 且（env + config）无凭据 → 启动失败；`workflow.enabled: true` 且 `dir` 不存在 → 启动失败（`path` 不存在则创建）；`evals.allowNetwork: true` 不自动开启 CLI flag。

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
| `tool.permission.request` / `tool.permission.response` | 工具 → TUI → 工具 | 执行期权限确认（120s 超时） |
| `ask.user.requested` / `ask.user.answered` | 工具 → TUI → 工具 | ask_user 交互暂停 |
| `mcp.server.connected` / `mcp.server.failed` / `mcp.server.disconnected` | MCP 插件 → 观测 | server 生命周期（失败隔离） |
| `mcp.tool.called` / `mcp.tool.failed` | MCP 插件 → 观测 | MCP 工具调用 |
| `workflow.started` / `workflow.step.started` / `workflow.step.completed` / `workflow.step.failed` / `workflow.completed` / `workflow.failed` / `workflow.cancelled` / `workflow.interrupted` / `workflow.resumed` | workflow 插件 → 观测 | 编排生命周期；**没有 `workflow.step.skipped`**，skipped 只在 run 详情与计数中 |
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
- **事件归属**：core 发 `session.saved/deleted`、`hook.*`、`run.cancelled`、`installPlugin` 的 `plugin.*`；asm 发 `config.loaded` 与 `PluginLoader` 的 `plugin.loaded/failed`；ext 发 `workflow.*` / `eval.*` / `feishu.*` / `mcp.*` / `subagent.*`。

## 11. 工具集：三个能力工具，为什么这么少

默认运行期 **4 个**工具：`plugins/tools/basic-tools` 提供 **`bash` / `read` / `edit`** 三个**能力工具**，装配层注册 `delegate_task` 一个**接缝工具**。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `delegate_task` | 默认注册；`delegate.enabled: false` 时关闭（工具变为 3 个）。权限模式：交互 `bridge`、headless `allow`、可配 `deny`（保留 `read_only_tools`） |
| `ask_user` | 仅「实际进入 REPL 且 stdin 是 TTY」；serve / headless / 管道不注册 |
| `team_*`（spawn / send / inbox / status / cancel） | 仅 `team.enabled: true`（默认关闭）。进程内原型；0.2 起共用 core Host |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功后注册；数量随 server 动态变化（ADR-039） |

口径：**默认 4 / 交互 REPL 5 / 启用 team 9**；配置 MCP 后为 **4 + N 个 MCP 工具**（N 由 server 提供，0.3 不写死总数）。`--tools` 一次性命令按 headless 口径列出 4 个，并注明 `ask_user (interactive only)`；**`--tools` 不连接 MCP，因此不列出 MCP 工具**——需实际运行/连接后，经 REPL `/mcp` 或 gateway `GET /v1/mcp/servers` 查看。

| 工具 | inputSchema | 权限 | 行为 |
|---|---|---|---|
| `bash` | `{ command, cwd?, timeout_ms? }` | `ask`；cwd 命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | `Bun.spawn(['bash','-c',command])`。超时默认 120s；输出超 2000 行时保留头 1000 + 尾 1000 并标注省略行数；超时返回明确错误文本而非抛异常 |
| `read` | `{ path, offset?, limit? }` | `allow`；命中 denylist → `deny`；配置 `allowed_roots` 后越界 → `ask` | 带行号返回（从 1 开始）。`limit` 默认 2000 行；截断时标注总行数与继续读的方式 |
| `edit` | `{ path, old_string, new_string, replace_all? }` | `ask` | `old_string` 必须**精确匹配且唯一**；不唯一时报错并说明匹配次数，未匹配时报错；`replace_all: true` 才允许多处替换 |

**路径边界（0.8，ADR-055）**：`read` / `bash cwd` 先按真实路径（`realpath`；不存在的路径取最近已存在祖先）判定，`..` 与 symlink 不能绕过。内置 denylist（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.vessel/config.yaml`）命中即 `deny`；插件 `config.allowed_roots` 非空时越界为 `ask`，`config.deny_paths` 追加到内置列表。默认 `allowed_roots` 为空 = 不限制根，行为与 0.7 兼容。`bash` 只校验 `cwd`，命令本身仍可访问其它路径；`edit` 未纳入该边界——这不是沙箱。

**被判死的工具，以及为什么**：

| 删掉的 | 因为 |
|---|---|
| `grep` / `ls` / `cat` / `find` | `bash` 就能干，且组合能力更强 |
| file-ops（`write_file` / `create_dir` / `path_exists` / …） | `edit` 写、`bash` 建目录与判定存在 |
| meta-tools（`register_tool` / `search_assets` / `inspect_asset` / …） | 写文件即等于建工具：模型用 `bash` 落一个插件目录，下次启动被 `PluginLoader` 扫到 |
| skills-loader（scanner + CRUD + 文件监听） | skills 就是文件；前端引用、core 只收消息 |
| memory 插件 | 项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown 文件，模型自己读写 |

> MCP 不是「能力工具」，而是把外部工具接进 `PluginHost` 的插件（ADR-039）；它不占基础工具名额，也不改变「三个能力工具」的判据。

**0.4 的 workflow / evals / feishu 不注册模型工具**，工具口径不变（默认 4 / 交互 5 / team 9 / 4 + N MCP）。workflow 的入口只有 CLI / TUI / gateway；模型不能触发任意路径的 workflow 定义（ADR-042）。

判据只有一条：**能被其他工具替代的工具，就不该存在**。工具越多，模型的选错空间越大；真正的通用原语只有"执行一条命令"，其余都是它的特化。

## 12. 装配层（`src/`）

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 入口分发：REPL（默认）/ `--run`（唯一 headless 入口：有参=文本或 `@file`，无参=stdin）/ `--serve` / `--resume-run` / `--version` / `--tools` / `update` / `workflow` / `eval` / `--feishu`；非交互且无 Key 时快速失败，不进首启向导。0.8：headless 只记录退出码，不提前 `process.exit`，统一走 gateway / tenantFactory / transport / shutdown 清理后再落 `process.exitCode` |
| `src/cli-args.ts` | 纯参数解析（语法与互斥），无副作用；`--serve` 默认端口 8642；`--resume-run` 与 `--run` / `--serve` / `--tools` / 位置式输入互斥；0.4 解析 `workflow` / `eval` 子命令与 `--feishu` 附加开关；0.6 解析 `--connect` / `--connect-token` / `--ca`（别名 `--connect-ca`）/ `--allowed-origin`（可重复，需 `--serve`） |
| `src/cli-overrides.ts` | 0.8.1：把**显式** CLI flag 组装成 `Partial<VesselConfig>`（serve / connect / TLS / allowed-origins），作为 loader 的最高优先级层；未给出的字段不写入 |
| `src/cli-update.ts` | `update [--check] [--channel latest\|beta] [--json] [--force]`：只读检查与提示 |
| `src/update/` | 更新清单解析、GitHub 通道选择、24h 缓存、后台检查、semver 比较；不自替换 |
| `src/bootstrap.ts` | config → provider → plugins → runtime → `ReplContext`；按配置构造 delegate / team / MCP，装配 session backend 与 RunStore；进程退出时关闭 MCP / Host / RunStore。0.8：`LocalRpcClient` 的 `onEvent` 订阅 `runtimeEvents`，以只读方式转发 `events.event`。0.8.1：接受 `cliOverrides` 并传给 loader；connect token / CA 只读 `config.connect` |
| `src/plugin-loader.ts` | 插件发现（见 §8） |
| `src/plugin-selection.ts` | bootstrap 与 `--tools` 共用的插件选择策略，避免默认集漂移 |
| `src/factory-plugins.ts` | 工厂式插件（delegate / team / mcp-client）的接线决策；0.3 删除 `delegate.viaHost` |
| `src/tenant-runtime-factory.ts` | 构造单个 tenant 的独立执行面（config / provider / session / run store / context / PluginHost / trace / writer lock）。0.8.2：`resolveRuntimePermission` / `buildDelegateTaskOptions` 纯函数，runtime / delegate / workflow 共用同一份 resolved 权限 |
| `src/workflow-wiring.ts` | 配置 → workflow 引擎；0.8.2 起总是注入 `createToolPipelineFor({ pluginHost, events, permission, tenantId })` |
| `src/session-factory.ts` | `session.backend` → sqlite / file / memory |
| `src/run-store-factory.ts` | `durable.backend/path` → `FileRunStore` / `MemoryRunStore`；未启用返回 null。0.8：透传 `tenantId`（归属校验）与 `tenantRunsDir` |
| `src/durable-wiring.ts` | checkpoint / resume 的装配适配：Host 成员优先，其次单 agent runtime |
| `src/mcp-wiring.ts` | 读取 `mcp_servers` → `createMcpPlugin`；构造 TUI / gateway 需要的状态适配器 |
| `src/serve-config.ts` | `serve.*` 默认值补全、远程/TLS 校验、证书文件检查；0.8.1 起不再接收 argv，CLI 层已由 loader 合并 |
| `src/rpc/http-client.ts` | `HttpRpcClient`：`POST /v1/rpc`、Bearer、可选 CA、WS 首帧 auth 与 `since` / `pong` / `gap` / 重连 |
| `src/node-registry.ts` | 0.6 静态节点表：URL / token / CA 解析、心跳与 `healthy` / `unreachable` 状态 |
| `src/remote-transport.ts` | 0.6 `kind:'remote'`：`send` / `request` / `peers`、远端事件订阅与 `(node_id, seq)` 去重 |
| `src/team-wiring.ts` / `src/transport-factory.ts` | 按配置构造 in-process / loopback / remote transport；remote 节点与事件回灌接线 |
| `src/resume-command.ts` | `--resume-run` 无参：列出 interrupted run（只读，不需要 Key）。0.8：解析 tenant 后读 `<data_dir>/tenants/<id>/runs`（与执行面一致），并透传 `tenantId` |
| `src/tools-list.ts` | `--tools` 的工具清单（不构造 runtime、不需要 Key） |
| `src/headless-runner.ts` | headless 运行器 |

**0.4 CLI / TUI 入口**：

```text
vessel workflow run <name-or-path> [--input key=value]...
vessel workflow list [--status <status>] [--limit <n>]
vessel workflow show <workflowRunId>
vessel workflow resume <workflowRunId>
vessel workflow cancel <workflowRunId>

vessel eval <suite-name-or-path> [--json] [--out <path>] [--filter <tag>] [--allow-network]

vessel --feishu
```

- `workflow` / `eval` 是位置 0 的子命令；未知子命令 → parse error（退出码 2）。
- `workflow list` / `show` / `cancel` 允许 controls-only（无 host/runtime）；
  `start` / `resume` 缺后端 → `workflow_disabled`，exit 2。
- `eval` 的报告写盘由 `@vessel/evals/report.ts` 负责，asm 只传 `outDir` / `--out`。
- `--feishu` 是附加开关：TTY + 无 `--serve` → REPL + 渠道；非 TTY + 无 `--serve` →
  仅渠道前台；`--serve` → gateway + 渠道。与 `--run` / `--pipe` / `--resume-run` /
  `--tools` / `--version` / `--help` 互斥。
- TUI：`/workflows [list|run|show|resume|cancel]`、`/metrics`、`/feishu`；
  启动横幅只在存在 interrupted workflow run 或飞书已连接时追加一行。

**REPL 的职责边界**：`ReplContext` 携带 `runtime`、`pluginHost`、`session`、`events`、`context`，以及 0.3 的 `mcp` / `runs` 控制面适配器与 0.4 的 `workflows` / `metrics` / `feishu` 控制面适配器。`/tools` 与 `/plugins` 从 `runtime.pluginHost` 读——不再有第二个只为展示而存在的 host。`@路径` 的展开也发生在这里（见 §4）。

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

`packages/serve` 是 **EventStream 的消费者**（与 TUI 的 StreamRenderer 同构）：把 runtime 事件广播为 WS / SSE，并提供 `/v1` 控制端点；**不改 core、不经过 PluginHost**。`apps/web` 是配套的浏览器控制台。

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
| `GET /v1/workflows?status=&limit=` | `{workflows: WorkflowRunSummary[]}`；未注入 → `workflow_disabled`（0.4） |
| `GET /v1/workflows/:id` | `{workflow: WorkflowRunDetail}`；不存在 → 404 `workflow_not_found`（0.4） |
| `POST /v1/workflows/run` | `{name, inputs?}` → 202 `{workflow_run_id, status:'queued'}`；name 只在 `workflow.dir` 下解析（0.4） |
| `POST /v1/workflows/:id/resume` | 202 `{workflow_run_id, status:'queued'}`（0.4） |
| `POST /v1/workflows/:id/cancel` | 202 `{workflow_run_id, status:'cancelled'}`；已完成/失败 → 409 `workflow_invalid`；已取消幂等 202（0.4） |
| `GET /v1/channels/feishu` | `{channel: FeishuStatus}`；未注入 → `channel_disabled`（0.4） |
| `GET /v1/evals/latest?suite=` | `{report: EvalReport}`；无报告 → 404 `eval_not_found`（0.4） |
| `POST /v1/team/agents` | 跨节点 spawn；`request_id` 幂等去重（进程内 LRU 1000）；缺 spawn 注入 → `no_spawn`（0.6） |
| `GET /v1/team/agents` / `GET /v1/team/agents/:id` | 节点成员列表 / 单成员状态（0.6） |
| `GET /v1/team/inbox` | 成员 inbox（cursor 分页）（0.6） |
| `POST /v1/team/messages` | 跨节点消息投递；`node_id` 标识来源，按消息 `id` 入站去重（0.6） |
| `POST /run` | 0.1.0 兼容的阻塞式入口 |

WS 方法：`run.submit` / `run.cancel` / `run.get` / `sessions.list` / `tools.list` / `permission.respond` / `ask.respond`。`team.*` 在 0.1.0 返回 `method_not_allowed`（0.2 草案见 `protocol.ts`）。0.6 的跨节点 team 控制协议走 `Transport.request` → `/v1/team/*`，不进入 canonical RPC manifest。

0.3 新增稳定错误码：`run_not_found` / `run_not_resumable` / `run_already_running` / `durable_disabled` / `mcp_disabled`；`hello.features` 按实际启用增加 `durable-resume` / `mcp-status` / `tls`。

0.4 新增稳定错误码（additive）：`metrics_disabled` / `workflow_disabled` / `workflow_not_found` / `workflow_invalid` / `workflow_already_running` / `workflow_not_resumable` / `channel_disabled` / `eval_not_found`；`hello.features` 按实际启用增加 `workflow` / `evals` / `feishu` / `metrics`。HTTP 映射：404 `*_not_found`；409 `*_already_running` / `*_not_resumable` / not cancellable；503 `*_disabled`；400 `invalid_request`。`queued` 只是 gateway 接受态，不是 `WorkflowRunStatus`。`workflow_cancelled` 不加入协议错误码，控制面抛该码时映射为 409 `workflow_invalid`。

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
- 0.4：按 `hello.features` 显示 **workflow 面板**（列表 / 详情 / 启动 / resume / cancel）、**metrics 快照**与 **飞书状态**（`workflow` / `metrics` / `feishu`）；evals 只做 `GET /v1/evals/latest`，不做面板。
- 开发：`cd apps/web && npm run dev`（Vite 代理 `/v1` 与 `/health` 到 `127.0.0.1:8642`，`changeOrigin:false` 保持同源）；生产：gateway 托管 `dist`。
- 已知限制：单 runtime / 单 context，并发固定 1（队列上限 100）；运行与事件历史在内存，重启丢失；无自动化浏览器测试。
- 0.6.1：Markdown 渲染、`sessions.search` 全文检索、工具事件 `args` / `result` 折叠，见 §18.6。
- **接线（已完成）**：CLI 给 `startGateway` 传 `events` / `session` / `runtime` / `context` / `pluginHost` / `staticDir` / `durable` / `mcp`；`staticDir` 取 `VESSEL_STATIC_DIR`，否则仓库内 `apps/web/dist` 存在时使用。因此 G2、静态托管、durable/MCP 面板在 `--serve` 下生效。

### 13.7 统一 RPC 方法表（0.5）

- **信封**：请求 `{ v: 1, id, method, params? }`；成功 `{ v: 1, id, ok: true, result }`；失败 `{ v: 1, id, ok: false, error: { code, message, details? } }`。HTTP 入口 `POST /v1/rpc`；WS 复用 `req` / `res`。
- **canonical 方法（v1.1）**：`health.get`；`capabilities.list`；`config.get` / `config.sources`；`sessions.list|get|search|delete|rename`；`runs.list|get|start|cancel|resume`；`events.list|subscribe`；`tools.list`；`plugins.list`；`metrics.get`（`source: live|trace`）/ `metrics.reset`；`trace.prune`；`tenants.list|get|create|update`；`permission.respond` / `ask.respond`；`workflow.list|start|get|resume|cancel`；`evals.run|latest`；`feishu.status`；`mcp.list|reconnect`。

<!-- rpc-methods:begin -->
| 方法 | permission |
|---|---|
| `health.get` | read |
| `capabilities.list` | read |
| `config.get` | read |
| `config.sources` | read |
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
| `workflow.list` | read |
| `workflow.get` | read |
| `workflow.start` | write |
| `workflow.resume` | write |
| `workflow.cancel` | write |
| `evals.latest` | read |
| `evals.run` | write |
| `feishu.status` | read |
<!-- rpc-methods:end -->

- **legacy-only（不进 manifest）**：`team.*`、`durable.*`、WS `run.submit|get|cancel`。
- **HTTP 语义**：信封合法时方法成功或方法级失败都返回 200（失败体 `ok:false`）；400 `invalid_params`（旧路径 `invalid_request`）；401 `unauthorized`；403 `forbidden`；413 体过大；未知方法 200 `not_found`（`details.method`）；500 `internal`。旧 REST 适配器保留 0.4 路径、请求/响应体、状态码与错误码。
- **events**：`events.list` 支持 `run_id` / `since_seq` / `since_ts` / `types` / `type_prefix` / `limit`（默认 50、最大 500），按 `(seq ?? ts)` 升序。`events.subscribe` 支持 `since`（gateway wire seq）/ `since_ts` / `run_id` / `types` / `all_tenants`（仅 admin）。RPC 回调为 `{ method: 'events.event', params: RunEvent }`；WS 旧 `{ kind: 'event', event }` 不变。
- **manifest**：`capabilities.list` 返回 `{ version, config_schema_version: 1, methods: [{ name, params_schema?, result_schema?, permission }], tools, plugins }`；只含 canonical 方法。A-6.3：manifest 按 `ctx.tenantId` 生成，tools / plugins 取 `pluginHostFor` / `pluginsFor`（缺省回退全局）；`trace.readEvents(filter, tenantId)` 与 `sessionData.deleteSessionData(sessionId, tenantId)` 由 web 传入当前 tenant，asm 已按 tenant 路由到对应的 trace 目录与 session backend。
- **客户端**：`RpcClient` 有 `request()` + `subscribe()`；`LocalRpcClient` / `HttpRpcClient`。CLI/TUI 不绕开方法表。0.8：本地 `subscribe()` 由装配层桥接到 `runtimeEvents`（每条 `RunEvent` 包成 `{ method: 'events.event', params }`），是只读旁路，不写回事件流；`/runs resume`、`/workflows run|resume` 因此能收到终态而不是挂起。`--connect <url>` / `VESSEL_CONNECT` 使用 `HttpRpcClient`、不取 tenant 写锁、不写本地 store / trace；回环可明文，非回环必须 HTTPS + token。未设置时用 `LocalRpcClient` 并取锁。
- **远程客户端（0.6）**：token 解析顺序 `--connect-token` > env（`VESSEL_CONNECT_TOKEN` / `connect.token_env`）> `connect.token`；CA 用 `--ca` / `connect.ca_file`。建连后 `health.get` 取远端 tenant / node；显式 `--tenant` 才把 `tenant_id` 合并进请求（admin 覆盖），否则由 token principal 决定。connect 模式下 `permission.respond` / `ask.respond` 经 RPC 回远端；TUI / headless 同路径。
- **tenant**：token → principal（`serve.token`→default/admin、`serve.tokens` 按条目、`serve.admin_token`→`*`/admin、回环无 token→default/admin）；非 admin 指定其它 tenant → `forbidden`；跨 tenant 读取 → `not_found`；一个 gateway 服务 N tenant（工厂缺省时非 default tenant `forbidden`）。0.8：durable REST 端点允许 admin 通过 query `tenant_id` 或 `X-Vessel-Tenant` 显式指定 tenant，两处同时出现且不一致 → 400；其余角色仍按 principal 作用域。
- **错误码**：方法级错误一律 `ok:false`，HTTP 200；冻结集合 `unauthorized` / `forbidden` / `not_found` / `invalid_params` / `tenant_locked` / `quota_exceeded` / `conflict` / `internal`。旧路径保留 0.4 错误码映射。

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
- **0.2 非目标（0.3–0.6 已部分重启）**：0.2 不做 durable execution / workflow / evals / MCP / 多租户 / 远程监听 / TLS / 跨机器调度 / 单二进制主分发。0.3 已实现 durable / MCP / 远程监听 / TLS；0.4 以插件实现 workflow / evals / 飞书；0.5 实现多租户；0.6 实现跨机器远程与跨节点 transport；单二进制仍非目标。

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
| provider | `LLMProvider` | `@vessel/core/provider` |
| context | `ContextManager` | `@vessel/core/context` |
| session | `SessionBackend` | `@vessel/core/session` |
| policy | `PermissionPolicy` / `GuardrailRunner` / `HookRunner` | `@vessel/core/policy` |
| transport | `Transport`（新增） | `@vessel/core/transport` |
| observability | `EventStore`（新增）+ `EventStream` | `@vessel/core/observability` |
| kernel | Host / Scheduler / Handles | `@vessel/core/kernel` |

0.2 **只在 `@vessel/core` 内做 ports & adapters + subpath exports，不拆包**；根入口继续 re-export 全部现有符号。依赖规则：`types/**` 不 import 实现；模块之间只经 port 交互；`kernel` 只依赖 port 类型（默认实现允许 F5 白名单：`AgentRuntime` + `MemoryContextManager` / `MemoryEventStream` / `MemoryPluginHost`，且必须可经 options 覆盖）；模块不得反向依赖 `src/**` / `packages/serve` / `plugins/**`。

### 14.4 Transport（已实现）

- 0.2 只做 **in-process** 与 **loopback HTTP** 两种实现；loopback 只绑 `127.0.0.1`，复用 gateway v1 的 token 鉴权，禁止 `0.0.0.0`。
- 消息带 `protocol: 1`；in-process 失败不得影响本机路径；loopback 失败只降级该传输。
- **0.6 additive**：`kind` 扩为 `'in-process' | 'loopback' | 'remote'`；新增可选 `nodeId?` 与 `request?<T>(nodeId, { requestId?, method, params? })`；`RunEvent.node_id?` / `EventFilter.nodeId?`。`request` 是领域无关 port 能力，不含 team 语义。远程实现与节点注册见 §13.8。
- 远程监听 / TLS / 跨机器发现 / 消息持久化不在 0.2；跨机器传输在 0.6 以静态节点表实现，仍不做自动发现与消息持久化。

### 14.5 兼容与迁移（已实现）

- **冻结**：9 接口、`AgentRuntime` 公开面、`RunOptions` / `RunEvent`、事件名、插件机制、根导出面；0.2 只做加法与内部替换，不删除公开 API。
- `delegate_task` 改为 Host 上的**一次性临时成员**（工具名与语义不变）；`@vessel/team` 改为**持久成员**；二者共用 `RuntimeHost`。
- `@vessel/team` 的 `InProcessRuntimeHost` 在 0.2 标 `@deprecated` 并适配到 core Host；**0.3 已移除**该兼容路径与 `LegacyHostAdapter`。
- 事件：core TS 内部用 camelCase（`agentId`），gateway JSON 用 snake_case（`agent_id`），映射只在 gateway 边界做一次；事件名仍是开放字符串。
- 依赖方向由 CI 自动检查（`scripts/check-deps.ts`），不只写在文档里。

### 14.6 0.3 平台能力（已实现）

| 能力 | 落地位置 | 边界 |
|---|---|---|
| Durable run | `packages/core/src/types/run-store.ts` + `session/run-store.ts`；`AgentRuntime.resume` / `RuntimeHost.resume` | 本机 file/memory；resume 并发守卫 per-Host / per-store-instance（ADR-040） |
| MCP client | `plugins/mcp/client/`（`@vessel/mcp-client`） | 插件，不是 core 模块；stdio + HTTP；默认 ask（ADR-039） |
| 远程 / TLS | `packages/serve/src/gateway.ts` + `src/serve-config.ts` | 显式 opt-in；非回环必须 token；HTTP/1.1（ADR-041） |
| 控制面 | `packages/serve/src/{durable,mcp}.ts`；TUI `/mcp` `/runs`；CLI `--resume-run` | 0.3 新增端点见 §13.2；命令见 §12 |
| 跨机器远程 / 跨节点 | `packages/serve/src/gateway.ts`；`src/rpc/http-client.ts`；`src/remote-transport.ts` / `src/node-registry.ts` | 显式 opt-in；非回环 TLS + token；静态节点表；ADR-051 / 052 / 053；见 §13.8 |

## 15. 0.4 能力层（release/0.4，未发布）

> 0.4 的主题是「可编排、可评测、可观测、可对话」。三个能力全部是**插件**，
> core 只新增可观测性/稳定性原语；决策见 ADR-042 / 043 / 044 / 045。
> 默认全部关闭；四个新配置块缺省时行为与 0.3 一致。

### 15.1 Workflow（`@vessel/workflow`）

- **位置与形态**：`plugins/workflow/engine/`，工厂式插件（`FACTORY_PLUGINS` 短名
  `workflow`），由 asm 构造；**不是 core 模块**。
- **定义**：YAML/JSON；步骤 `type: agent | tool`，`depends_on` 形成 DAG；
  模板只做字符串插值（`{{inputs.*}}`、`{{steps.<id>.output|status}}`、
  `{{workflow.name}}`），不做表达式/脚本求值。环依赖、未知依赖/变量/工具/成员 = 定义错误。
- **执行**：依赖满足的步骤并行，上限 `min(定义值, workflow.max_parallel)`；
  单 agent 回退强制串行。`type: agent` 调 `host.get(agent).run(prompt)`。
  0.8.2 起（ADR-058）`type: tool` 走统一的 `ToolPipeline`：ToolCall guardrail →
  BeforeTool hook → 权限（最终工具与参数）→ handler（timeout + signal）→
  ToolResult guardrail → AfterTool hook，并发布
  `tool.call.started|completed|failed`（`run_id` 为 workflow run id）；权限 `ask`
  经 `tool.permission.request` 等待应答（120s 无应答按失败处理），`deny` 拒绝。
  未注入 `toolPipeline` 的旧嵌入路径仍直接调 handler（deprecated）。
- **状态与持久化**：run id `wf_<uuid>`；workflow 状态 `pending | running |
  completed | failed | cancelled | interrupted`；step 状态 `pending | running |
  completed | failed | skipped | cancelled`。一 run 一 JSON（`workflow.path`），
  temp + rename 原子写；检查点：workflow 开始、每 step 开始/结束、workflow 结束；
  run JSON 保存完整定义快照。**只要有 step 最终 failed，workflow 终态为 failed**
  （即使 `on_error: continue`）。
- **resume**：允许 `interrupted | failed | running`；`completed | cancelled` →
  `workflow_not_resumable`。跳过 `completed` / `skipped`；`running` / `pending` /
  `failed` 重置为 `pending` 并重跑；**不保证 step 幂等**。
- **cancel / interrupt**：`cancel()` → `cancelled`（running step `cancelled`、
  pending step `skipped`），不可 resume；SIGINT/SIGTERM → `interrupted`，可 resume。
  0.4 `workflow cancel` 只支持同进程，对非本进程 run 返回 `workflow_not_found`。
- **controls-only**：`workflow list` / `show` / `cancel` 允许只构造 store 侧引擎，
  `host` / `runtime` 缺省；`start` / `resume` 两者都缺省 → `workflow_disabled`，exit 2。
- **会话**：agent step 使用 Host 中已存在的成员，不为每个 run 新建成员；同一成员的
  多次 workflow run 共享 session，Host 默认 `perAgentSerial` 串行化。单 agent 回退
  由 asm 为每次 run 生成 `workflow:<run_id>`。workflow 级会话隔离不在 0.4 承诺。
- **入口**：CLI / TUI `/workflows` / gateway `/v1/workflows*`；**不注册模型工具**。
- **错误码**：`workflow_not_found` / `workflow_invalid` / `workflow_already_running` /
  `workflow_not_resumable` / `workflow_cancelled` / `workflow_disabled`。
- **事件**：`workflow.*`（开放字符串）；**没有 `workflow.step.skipped`**。
- **退出码**：0 成功；1 workflow failed；2 参数/配置错误 / `workflow_disabled`；
  130 用户 cancel / SIGINT；143 SIGTERM。

### 15.2 Evals（`@vessel/evals`）

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

### 15.3 飞书（`@vessel/feishu`）

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

### 15.4 边界

- 0.4 **不注册** `run_workflow` 或任何 workflow/eval/feishu 工具；工具口径不变。
- 不做 workflow 可视化编辑器、多租户、跨机器编排、飞书富媒体/卡片/thread/多机器人/
  OAuth、个人微信。微信公众号/企业微信留 0.5 评估。
- 0.4 **不 tag、不 publish、不合并 `main`**；只做发布干跑。

## 16. 0.4 可观测性与稳定性

### 16.1 `MetricsCollector`

- 位置：`packages/core/src/observability/metrics.ts`；从根入口与
  `@vessel/core/observability` 导出。
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

- workflow resume 不保证 step 幂等，重跑可能重复副作用。
- workflow `type: tool` 在 0.4 绕过 runtime 的 guardrail / hook；0.8.2 起已统一到工具执行管道（ADR-058），详见 §15.1。
- workflow agent step 共享 Host 成员 session，无 workflow 级会话隔离。
- workflow 单 agent 回退时并行退化为串行；`cancel` 只支持同进程。
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

解析顺序：显式 `RuntimeOptions.tenantId` → `--tenant` → `VESSEL_TENANT` → `tenant.default` → `default`。隔离覆盖存储、配置、工具、权限、quota、trace 与 RPC。tenant overlay 优先级 `CLI > env > tenant overlay > project > user > default`；允许块与禁止块见 ADR-049。quota 超限返回 `quota_exceeded` 且不落半成品；跨 tenant 读取 `not_found`；`status: disabled` 拒绝写，0.5 不做 `--purge`。一个 gateway 可服务 N 个 tenant，但非 default tenant 需要显式工厂。插件 tenant 行为已由 ext 合入（每 tenant 独立实例、不追加 `tenants/<id>`、`eval.run.*` 事件、按 tenant 合并插件配置）。A-6 的 web 接口增量（`pluginsFor`、per-tenant `capabilities.list` / `plugins.list`、`trace.readEvents(filter, tenantId)`、`sessionData.deleteSessionData(sessionId, tenantId)`）与 asm 的 `--serve` per-tenant 执行面（config / provider / session / run store / context / PluginHost / trace / metrics / redactor / sessionControl、独立 EventStream、per-tenant writer lock）**均已实现**。disabled / 未配置 tenant → `forbidden`，锁冲突 → `tenant_locked`。已知限制：gateway 的 workflow / 飞书控制面仍只走 default tenant。

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

- **本地 RPC subscribe**：`src/bootstrap.ts` 给 `createLocalRpcClient` 传入 `onEvent`，订阅 `runtimeEvents` 并以 `{ method:'events.event', params }` 转发。只读旁路，不重复发布事件。`/runs resume`、`/workflows run|resume` 不再挂起。
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
- 路径边界不是沙箱：`bash` 只校验 `cwd`，命令本身可访问其它路径；`edit` 未纳入边界；内置 denylist 不能通过配置移除，只能追加。
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

- `packages/core/src/runtime/tool-pipeline.ts` 导出 `createToolPipeline` / `createToolPipelineFor` / `ToolPipeline` / `ToolPipelineOptions` / `ToolPipelineStages` / `ToolPipelineResult`（根入口与 `@vessel/core/runtime`）。
- 阶段顺序：`getTool` → ToolCall guardrail → BeforeTool hook → **permission（最终工具与参数）** → handler（timeout + `ctx.signal`）→ ToolResult guardrail → AfterTool hook（仅成功）。guardrail 改写工具名/参数后重新查找工具并解析参数；BeforeTool 的 `updatedInput` 同样在权限判定前生效。
- `ToolPipelineStages` 可关闭调用方已在外层处理的阶段（默认全开）。`AgentRuntime`（包括 delegate 子 runtime）关闭 ToolCall guardrail / BeforeTool / AfterTool，仅复用 permission、handler 超时与 ToolResult guardrail；workflow 使用默认全开。
- 管道不发布 `tool.call.*`；由 `AgentRuntime` / workflow 引擎各自发布，避免重复。
- **workflow**：`WorkflowEngineOptions.toolPipeline?`；asm 的 `createWorkflowFromConfig` 总是注入 `createToolPipelineFor({ pluginHost, events, permission, tenantId })`。`type: tool` 走管道并发布 `tool.call.started|completed|failed`（payload 含 `workflow_run_id` / `tool_call_id` / `tool_name`）；未注入时保留旧直接 handler 路径（deprecated）。
- **delegate**：`DelegateTaskOptions.permission?`；子 runtime 继承父级 `default` + `autoApprove`，缺省仍 `{ default: 'allow' }`。`permissionMode: 'allow'` 继续显式覆盖（`withAutoAllow`），`deny` 在注册前过滤工具，`bridge` 保留工具自带 `checkPermission`。
- **装配**：`resolveRuntimePermission(config, headless)` / `buildDelegateTaskOptions()` 为纯函数；runtime / delegate / workflow 共用同一份 resolved 权限（交互 `ask`、headless `allow`，`ask_user` 始终 auto-approve）。

### 22.2 已知限制（0.8.2）

- 直接构造 workflow 引擎且不注入 `toolPipeline` 的第三方嵌入方仍走旧直接 handler 路径，需要自行迁移。
- workflow 中的权限 `ask` 会发布 `tool.permission.request` 并等待 120s；若无应答方，步骤失败，不会静默放行。
- 关闭阶段由调用方负责语义正确性；禁用 ToolResult guardrail 会让未检查的结果直接写回上下文。
- 管道只统一执行语义，不改变 `ToolDefinition` / `PermissionPolicy` / guardrail / hook 的接口。

## 23. 0.8.3 Wave 2B2A 结构拆分（已实现）

> 状态：已合入 `release/0.8.3`（未发布）。决策见 [ADR-059](adr/ADR-059-gateway-method-modules.md) / [ADR-060](adr/ADR-060-cli-command-registry.md)。本节只写已实现行为；两处拆分均不改变对外协议或运行时行为。

### 23.1 Gateway 方法模块（ADR-059）

- `packages/serve/src/gateway.ts` 从约 4000 行降到 3002 行，只负责选项校验、事件缓冲 / 连接状态、HTTP / WS 路由、SSE 与鉴权顺序。
- 方法表按 domain 移到 `packages/serve/src/gateway/methods/`，每个文件导出 `createXxxMethods(deps): RpcMethodDefinition[]`：
  - `config.ts`：`createConfigMethods` / `createToolMethods` / `createPluginsMethods`；
  - `sessions.ts` / `runs.ts` / `tenants.ts` / `interactions.ts` / `workflow.ts` / `evals.ts` / `mcp.ts` / `feishu.ts`；
  - `observability.ts`：`createEventsMethods` / `createMetricsMethods` / `createTraceMethods`；
  - `common.ts`：`tenantParamSchema` / `stringParam` / `checkpointBelongsToTenant` 等共享纯函数与常量。
- `gateway.ts` 用 `...createXxxMethods(deps)` 按拆分前顺序展开，再 `defineMethods(rpcMethods)`；`events.subscribe` 仍留在 gateway（依赖连接类型与事件缓冲游标）。
- `MethodError` 移到 `gateway/errors.ts`：拆分后 handler 与 legacy 错误处理共享同一个类，`instanceof` 语义不变。
- 方法名、`params_schema`、返回形状、协议错误码与鉴权顺序不变；没有新增或删除 RPC 方法。

### 23.2 CLI 命令注册表（ADR-060）

- 新增 `src/commands/registry.ts`：`CliCommand`（`name` / `match(args)` / `run(args, ctx)`）、有序数组 `cliCommands`、`matchCommand(args)`（首个命中即停）。
- 覆盖 11 条一次性命令：`tools` / `update` / `resume-run-list` / `workflow` / `eval` / `config` / `tenant` / `migrate` / `trace` / `plugin` / `doctor`；顺序与迁移前 `if` 链的短路顺序一致。
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
- provider factory：`createProvider(..., useMock, scenario?)` 在 `useMock` 时若收到 `scenario` 用 `createScenarioProvider()`，否则仍用 `MemoryLLMProvider`（eval / workflow 等未透传场景的调用方保持原行为）。

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
- evals 与 workflow 未接入场景 provider，仍是各自固定的 mock 行为。
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
- **装配层**：bootstrap / CLI / serve 的 shutdown 链 `await` runtime 释放；MCP client 与 workflow engine 是工厂式插件，由装配层显式 close，二者自身 `dispose()` 幂等；其余 11 个仓库插件没有需要释放的资源。
- **包装**：`withPluginConfig` 保留 `init` / `dispose`，配置包装不会丢失生命周期钩子。

### 28.2 协议 result schema

- **覆盖**：37 个 canonical 方法（36 个 domain 方法 + `events.subscribe`）全部带 `result_schema`；复用片段在 `packages/serve/src/gateway/methods/schemas.ts`（`runStatusSchema`、`runStateSchema`、`sessionInfoSchema`、`usageSchema`、`tenantInfoSchema`、`runEventSchema`、`metricsSnapshotSchema`、eval / workflow 片段）。
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
- 工厂式插件（MCP client、workflow engine）由装配层关闭，不走 `Plugin.dispose` 自动路径。
- `runs.get` 的 `result_schema` 是 `RunStatus` 与 durable checkpoint 的宽松超集，不是精确校验。
- 结果校验默认关闭，只在 `VESSEL_VALIDATE_RESULTS=1` 时生效；CI 的 Test step 固定开启。
- `sessions.list` 的四个可空字段只做存在性约束，不做类型校验。
