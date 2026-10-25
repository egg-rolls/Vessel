# 技术架构

> 本文描述 Vessel 当前的架构事实。历史决策与「为什么」见 [ADR 索引](adr/README.md)。

---

## 1. 三层结构与依赖方向

> 本节及下方「分层与模块边界」描述**当前已实现**的结构；Kernel / Modules 的决策见 [ADR-037](adr/ADR-037-modular-agent-runtime.md)。

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

**分层与模块边界（[ADR-037](adr/ADR-037-modular-agent-runtime.md)）**

- 分层：`Contracts ← Kernel ← Modules ← SDK ← Shells`；`Plugins` 只依赖 Contracts / 公开 API，经 `PluginHost` 在运行期 install。
- **Module ≠ Plugin**：Module 是编译期 / 构造期边界（provider / context / session / policy / transport / observability，一个 port 一个实现）；Plugin 仍是唯一运行期扩展机制；禁止 `ModuleHost` / `ModuleRegistry`。
- core 内只做 ports & adapters 与 `@vessel-agent/core/<port>` subpath exports，不拆包；`types/**` 不 import 实现，模块只经 port 交互。
- `AgentRuntime` 仍是单 agent tool-calling loop；Host / Scheduler 只提供注册、生命周期、调度与边界，不重写循环。

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

0.14.3（ADR-084）：限额判定拆成两个纯函数——`evaluateUsageLimits(stats, limits)` 与 `evaluateTermination(stats, policy)`，都返回 `LimitBlock | null`（`scope` / `key` / `current` / `max` / `source` / `hint` / `retryable: false`）；`MemoryLimitChecker.checkLimits` / `checkTermination` 分别复用它们。终止策略命中同样产生 `LimitBlock`（key `max_iterations` / `max_runtime`）。事件与 envelope 契约见 `docs/versions/0.14.3.md` 与 [ADR-084](adr/ADR-084-limit-visibility-and-provider-errors.md)。

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

**扫描只在进程启动时发生一次。** `PluginLoader` 把扫描结果缓存在实例上（插件目录在进程生命周期内视为不变），**这不是热加载**：新增或改动插件需要**重启进程**才生效，`/reload` 只重载配置、不重扫插件目录。0.6.1 已增加用户 / 项目插件目录与 `plugins[].config` 注入，见 `docs/versions/0.6.1.md`。

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
| `agent.enabled` / `ownerId` / `model` / `limits` / `termination` | AgentService 与内置 `agent` 工具；默认 true（0.24；显式 false 关闭） |
| `agent.defaultVisibility` / `permissionMode` / `readOnlyTools` | 成员可见性与权限模式：`bridge`（交互默认）/ `allow`（headless 默认）/ `deny`（保留 `readOnlyTools`，默认 `["read"]`）；0.17 |
| `agent.followReplies` / `cwd` / `systemPrompt` | 回复注入策略（不自动续跑父 turn）/ 默认工作目录 / 主 agent systemPrompt |
| `mcp_servers.<name>.*` | MCP server：`transport`（stdio/http）、`command`/`args`/`env`、`url`/`headers`、`enabled`、`connect_timeout_ms`、`tool_timeout_ms`、`tool_prefix`、`auto_approve_tools` |
| `durable.enabled` / `backend` / `path` / `checkpoint_every` | 默认 true（0.24；显式 false 关闭）；`backend: file \| memory`；0.5 起 `path` 默认 `<data_dir>/tenants/<tenant_id>/runs`，显式配置优先但可逃出 tenant（启动 warn）；0.3 只接受 `checkpoint_every: iteration` |
| `serve.hostname` / `port` / `allow_remote` / `tls.cert_file` / `tls.key_file` | 默认 `127.0.0.1:8642`、明文；非回环必须 `allow_remote: true`、token 非空**且 TLS cert/key 成对**（0.6 起强制） |
| `serve.allowed_origins` | 独立前端 Origin allowlist；绝对 http(s) origin，禁止 `*` / path / query；非回环必须 https；HTTP 与 WS 共用（0.6） |
| `connect.token` / `token_env` / `ca_file` | `--connect` 客户端 token 与 CA；token 优先级 CLI > env（`VESSEL_CONNECT_TOKEN`，缺失时回退 `VESSEL_GATEWAY_TOKEN`；`token_env` 由 loader 在 env 层解析）> config（0.6；0.8.1 统一经 loader，`--ca` 对应 `VESSEL_CONNECT_CA`） |
| `transport.kind` / `transport.token` | 只剩 `in-process`；`transport.token` 是 gateway token 的末位回退。`loopback` / `remote` / `transport.nodes[]` 已于 0.22.1 删除 |
| `serve.token` / `serve.token_env` / `serve.tokens` / `serve.admin_token` | 0.5：`serve.token` 为 default/admin 兼容单 token；`serve.tokens` 为 token → `{tenant_id, role}`；`serve.admin_token` 为 `*`/admin；解析顺序见 ADR-050 |
| `evals.enabled` / `dir` / `out_dir` / `allow_network` | 默认 true（0.24；显式 false 关闭）/ `./evals` / `~/.vessel/evals` / false；`allow_network: true` 仍需 CLI `--allow-network` |
| `feishu.enabled` / `app_id` / `app_secret` / `domain` / `allowed_chat_ids` / `session_prefix` / `reply_timeout_ms` / `max_reply_chars` / `max_members` | 默认 false；env `VESSEL_FEISHU_APP_ID` / `VESSEL_FEISHU_APP_SECRET` 优先；`max_members` 1..64（默认 8）；**`agent_id` 已删除，严格按未知键拒绝** |
| `observability.event_history` / `metrics` | `event_history` 缺省 1000，显式 0 = 不限制，>0 = 环形缓冲；块缺省时不注入 metrics，块存在时 `metrics` 默认 true |

0.6.1 已新增 `permission.auto_approve`（TS 字段 `autoApprove`）、`plugins[].config` 消费与 `VESSEL_PLUGINS` / `VESSEL_SESSION_BACKEND` / `VESSEL_MODEL` 覆盖，见 `docs/versions/0.6.1.md`。

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

默认运行期 **4 个**工具：`plugins/tools/basic-tools` 提供 **`bash` / `read` / `edit`** 三个**能力工具**，`packages/agent` 提供内置 `agent`（0.24 起默认注册；显式 `agent.enabled: false` 关闭）；`team_*` / `delegate_task` 已删除。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `agent` | 默认注册（0.24）；显式 `agent.enabled: false` 关闭。owner 动作 `new` / `send` / `close` / `list` / `rotate` / `post`（支持 batch；成员侧只暴露 `rotate` / `post` / `send` / `list`，`new` / `close` 只给 owner）；权限模式与成员配置见 `agent.*`（0.17；rotate 见 0.19 S2；Team 动作见 0.19 S3） |
| `ask_user` | 交互 REPL（stdin 是 TTY）或 `gateway start` / `--serve`；`--run` / headless / 管道不注册；`ui.askUser: false` 可关闭（0.14.1） |
| `mcp__<server>__<tool>` | 配置 `mcp_servers` 且 server 连接成功后注册；数量随 server 动态变化（ADR-039） |

口径：**默认 4 / 显式 `agent.enabled: false` 3 / 交互 REPL 或 gateway-serve 5（+`ask_user`）/ 交互且关闭 agent 4**；配置 MCP 后在基础上加 **N 个 MCP 工具**（N 由 server 提供）。`--tools` 一次性命令按 headless 口径列出，并注明 `ask_user (interactive REPL / gateway only)`；**`--tools` 不连接 MCP，因此不列出 MCP 工具**——需实际运行/连接后，经 REPL `/mcp` 或 gateway `GET /v1/mcp/servers` 查看。

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
| `src/transport-factory.ts` | gateway / connect token 解析；0.22.1 删除 loopback / remote transport 装配 |
| `src/hub/node-url.ts` | hub 节点 URL 归一化（非回环必须 https） |
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
| `POST /run` | 0.1.0 兼容的阻塞式入口 |

WS 方法：`run.submit` / `run.cancel` / `run.get` / `sessions.list` / `tools.list` / `permission.respond` / `ask.respond`。`team.*` 返回 `method_not_allowed`（legacy 0.2 草案保留在 `protocol.ts`）；跨节点 team 平面已于 0.22.1 删除。

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
- 0.6.1：Markdown 渲染、`sessions.search` 全文检索、工具事件 `args` / `result` 折叠，见 `docs/versions/0.6.1.md`。
- **接线（已完成）**：CLI 给 `startGateway` 传 `events` / `session` / `runtime` / `context` / `pluginHost` / `staticDir` / `durable` / `mcp`；`staticDir` 取 `VESSEL_STATIC_DIR`，否则仓库内 `apps/web/dist` 存在时使用。因此 G2、静态托管、durable/MCP 面板在 `--serve` 下生效。

### 13.7 统一 RPC 方法表（0.5）

- **信封**：请求 `{ v: 1, id, method, params? }`；成功 `{ v: 1, id, ok: true, result }`；失败 `{ v: 1, id, ok: false, error: { code, message, details? } }`。HTTP 入口 `POST /v1/rpc`；WS 复用 `req` / `res`。
- **canonical 方法（v1.1）**：`health.get`；`capabilities.list`；`config.get` / `config.sources` / `config.set`（0.15，write）；`sessions.list|get|search|delete|rename`；`runs.list|get|start|cancel|resume`；`agents.list|get`（0.14，read）/ `agents.tree`（0.15，read）/ `agents.create|update|close`（0.25，write，批量）/ `agents.send|dispatch|rotate`（0.26，write，批量）；`tasks.list|get`（0.15，read）；`events.list|subscribe`；`tools.list`；`plugins.list`；`metrics.get`（`source: live|trace`）/ `metrics.reset`；`trace.prune`；`tenants.list|get|create|update`；`permission.respond` / `ask.respond`；`interactions.list`（0.18，read）；`evals.run|latest`；`feishu.status`；`mcp.list|reconnect`；`gateway.reload`（0.12，admin-only，缺省 `not_supported`）；`teams.list|get|post|members|budget`（S3 / S4）/ `teams.create|update|archive`（0.24 S10.3）；`auth.exchange` / `auth.revoke` / `auth.tokens`（S5 hub 控制面）。

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
| `agents.create` | write |
| `agents.update` | write |
| `agents.close` | write |
| `agents.send` | write |
| `agents.dispatch` | write |
| `agents.rotate` | write |
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
| `teams.create` | write |
| `teams.update` | write |
| `teams.archive` | write |
| `auth.exchange` | write |
| `auth.revoke` | admin |
| `auth.tokens` | admin |
<!-- rpc-methods:end -->

0.26 新增 `agents.send` / `agents.dispatch` / `agents.rotate`（`write`，批量），canonical 方法总数 **57**（56 个 domain 方法 + `events.subscribe`）：三者与 `agents.create|update|close` 同形（`{ messages: [...] }` / `{ agents: [...] }` → `{ results: [...] }`，输入同序、逐条隔离）。发送者 / viewer 来自 principal：合成 owner principal 带 owner agent id，gateway / team token 无 `agent_id`，按 `human` 处理。team-scoped control token 可调用三者，但只能操作 `team_id` 与作用域相同的成员（否则逐条 `not_found`）；`agents.create` 仍禁止 team-scoped token。loopback owner 端点不再是第二套 action 表，而是用合成 owner principal 分发同一 canonical 方法表；`agent.*` / `team.*` wire 名已删除（pre-1.0 不保留别名）。

0.25 新增 `agents.create` / `agents.update` / `agents.close`（`write`，批量；单条调用 = 单元素数组），canonical 方法总数 **54**（53 个 domain 方法 + `events.subscribe`）：三者都由结构化 `AgentControlLike` 注入，未注入 / tenant 不匹配返回 `not_found`；`agents.create` 不允许 team-scoped control token（逐条 `forbidden`），`team_id` 只绑定已存在的 Team（经 `TeamControlLike.get` 解析 workspace，不隐式创建）；`agents.update` / `agents.close` 的 team-scoped token 只能操作 `team_id` 与作用域相同的成员（否则逐条 `not_found`）。结果统一为 `{ results: [...] }`，与输入同序、单条失败不影响其它条目；update 成功条目在 model / system_prompt 实际变化时带 `applies_to: 'next_body'`（不重建当前 Body）。service 发 `agent.updated` 只带变化字段名，不带 prompt 正文。

0.24 S10.3 新增 `teams.create` / `teams.update` / `teams.archive`（`write`），当时 canonical 方法总数 **51**（50 个 domain 方法 + `events.subscribe`）：create 只允许 human / admin，team-scoped token 返回 `forbidden`；update / archive 在 team-scoped control 白名单内，只能操作自己的 team；archive 有 present 成员时返回 `conflict`（`team_not_empty`），归档后 post / members / budget override 返回 `conflict`（`team_archived`），日志与会话历史保留。0.19 S3 + S5 + S4 起 canonical 方法总数为 48（0.24 起 51）；0.20 的 fork 与跨节点 federation 不新增 canonical，仍为 **48**。0.19 S3 新增 `teams.list` / `teams.get`（`read`）与 `teams.post` / `teams.members`（`write`，`add|remove`），由结构化 `TeamControlLike` 注入，未注入时返回 `not_found`；canonical 是复数 `teams.*`，与 legacy `team.*`（单数前缀）无关。0.19 S4 新增 `teams.budget`（`write`，`status|override`），同样由 `TeamControlLike` 注入；它**不在** team-scoped control token 白名单，未注入时返回 `not_found`。0.19 S5 新增 `auth.exchange`（`write`）、`auth.revoke` / `auth.tokens`（`admin`），用于 hub 控制面的短期 token 交换与吊销。0.18 移除 workflow 的 5 个方法（`workflow.list|start|get|resume|cancel`，ADR-090），并新增只读 `interactions.list`（`read`，tenant 作用域，返回 pending / answered / orphaned 权限与 ask；0.19 S4 起 ask 也持久化）。0.15 新增 `agents.tree` / `tasks.list` / `tasks.get` / `config.set`（0.14 时为 40；0.15 起为 44）。

- **legacy-only（不进 manifest）**：`team.*`、`durable.*`、WS `run.submit|get|cancel`。
- **HTTP 语义**：信封合法时方法成功或方法级失败都返回 200（失败体 `ok:false`）；400 `invalid_params`（旧路径 `invalid_request`）；401 `unauthorized`；403 `forbidden`；413 体过大；未知方法 200 `not_found`（`details.method`）；500 `internal`。旧 REST 适配器保留 0.4 路径、请求/响应体、状态码与错误码。
- **events**：`events.list` 支持 `run_id` / `since_seq` / `since_ts` / `types` / `type_prefix` / `limit`（默认 50、最大 500），按 `(seq ?? ts)` 升序。`events.subscribe` 支持 `since`（gateway wire seq）/ `since_ts` / `run_id` / `types` / `all_tenants`（仅 admin）。RPC 回调为 `{ method: 'events.event', params: RunEvent }`；WS 旧 `{ kind: 'event', event }` 不变。
- **manifest**：`capabilities.list` 返回 `{ version, config_schema_version: 1, methods: [{ name, params_schema?, result_schema?, permission }], tools, plugins }`；只含 canonical 方法。A-6.3：manifest 按 `ctx.tenantId` 生成，tools / plugins 取 `pluginHostFor` / `pluginsFor`（缺省回退全局）；`trace.readEvents(filter, tenantId)` 与 `sessionData.deleteSessionData(sessionId, tenantId)` 由 web 传入当前 tenant，asm 已按 tenant 路由到对应的 trace 目录与 session backend。
- **客户端**：`RpcClient` 有 `request()` + `subscribe()`；`LocalRpcClient` / `HttpRpcClient`。CLI/TUI 不绕开方法表。0.8：本地 `subscribe()` 由装配层桥接到 `runtimeEvents`（每条 `RunEvent` 包成 `{ method: 'events.event', params }`），是只读旁路，不写回事件流；`/runs resume` 因此能收到终态而不是挂起。`--connect <url>` / `VESSEL_CONNECT` 使用 `HttpRpcClient`、不取 tenant 写锁、不写本地 store / trace；回环可明文，非回环必须 HTTPS + token。未设置时用 `LocalRpcClient` 并取锁。
- **远程客户端（0.6）**：token 解析顺序 `--connect-token` > env（`VESSEL_CONNECT_TOKEN` / `connect.token_env`）> `connect.token`；CA 用 `--ca` / `connect.ca_file`。建连后 `health.get` 取远端 tenant / node；显式 `--tenant` 才把 `tenant_id` 合并进请求（admin 覆盖），否则由 token principal 决定。connect 模式下 `permission.respond` / `ask.respond` 经 RPC 回远端；TUI / headless 同路径。
- **tenant**：token → principal（`serve.token`→default/admin、`serve.tokens` 按条目、`serve.admin_token`→`*`/admin、回环无 token→default/admin）；非 admin 指定其它 tenant → `forbidden`；跨 tenant 读取 → `not_found`；一个 gateway 服务 N tenant（工厂缺省时非 default tenant `forbidden`）。0.8：durable REST 端点允许 admin 通过 query `tenant_id` 或 `X-Vessel-Tenant` 显式指定 tenant，两处同时出现且不一致 → 400；其余角色仍按 principal 作用域。
- **错误码**：方法级错误一律 `ok:false`，HTTP 200；冻结集合 `unauthorized` / `forbidden` / `not_found` / `invalid_params` / `tenant_locked` / `quota_exceeded` / `conflict` / `internal` / `not_supported`（0.12：可选能力未注入）。旧路径保留 0.4 错误码映射。

### 13.7.1 canonical agent 生命周期契约（0.25 / 0.26）

> 当前契约；历史背景见 `docs/versions/0.25.0.md` 与 `0.26.0.md`。

- `agents.create`：`{ agents: [{ name?, model?, system_prompt?, team_id?, visibility? }] }`；成功条目带 `agent`。
- `agents.update`：`{ agents: [{ agent_id, name?, model?, system_prompt? }] }`（每项至少一个字段）；成功条目带 `agent` / `changed` / `applies_to: 'next_body'`（仅 model / system_prompt 实际变化时）。
- `agents.close`：`{ agents: [{ agent_id }] }`；成功条目 `{ ok: true, agent, agent_id, closed: true }`。
- 统一结果 `{ results: [...] }`，与输入同序；单条失败 `{ ok: false, code, error }`，不影响其它条目。team-scoped control token 不能 create（逐条 `forbidden`）；update / close 只能操作同 `team_id` 成员，否则逐条 `not_found`。
- `agents.send`：`{ messages: [{ to, content, conversation_id? }] }` → 成功 `{ ok: true, queued: true, message_id, state }`（strict send，不 resume）。
- `agents.dispatch`：`{ messages: [{ to, content, conversation_id?, allow_fork? }] }` → 成功 `{ ok: true, status: 'queued', message_id, resolved_to, resolution, conversation_id? }`；业务拒绝逐条 `{ ok: false, code, error }`（`agent_left` / `resume_failed` / `not_visible` / `budget_*` / `conversation_team_mismatch`）。
- `agents.rotate`：`{ agents: [{ to, startup_prompt, handoff_path?, from_session_id? }] }` → 成功 `{ ok: true, status: 'rotated', agent_id, from_session_id, to_session_id, epoch }`。
- 三者 permission 都是 `write`；结构错误整体 `invalid_params`；team-scoped token 逐条校验 `team_id`。`principal.agent_id` 只由合成 owner 传输填 root owner id；handler 以 `ctx.principal.agent_id ?? 'human'` 作为 `from` / `viewer`。
- owner 端点只做传输：用 `defineMethods([...createAgentMethods, ...createTeamMethods])` 组装与 gateway 同源的方法表，wire 名即 canonical；HTTP 状态映射 `invalid_params` 400、`forbidden` 403、`not_found` 404、`conflict` 409、`internal` 500。

### 13.8 0.6 远程控制面与跨节点 transport

> 状态：已合入 `release/0.6`（未发布）；决策见 ADR-051 / ADR-052 / ADR-053。

**远程客户端（CLI / TUI / headless）**

- `--connect` / `VESSEL_CONNECT` 指向 gateway origin；非回环强制 HTTPS，token 缺失在发起网络请求前失败。
- WS 首帧 `auth` 带 token + `since`；解析 `hello` / `event` / `gap` / `ping`，`ping` → `pong`，`gap.to_seq` 触发 `since` 重连，`hello.latest_seq < lastSeq` 从 0 重新对齐；退避 1s → 30s + jitter，10s hello 超时。
- `health.get` 返回远端 `tenant_id` / `node_id`；CLI 在 stderr（headless）或 TUI 状态行展示；TUI 不污染 stdout。
- connect 模式不获取本地 tenant 写锁、不写本地 store / trace；交互回路由事件流转为 `permission.respond` / `ask.respond` RPC。

**0.6.1 的安全收紧**：durable 端点按 principal 的 tenant 过滤并校验 `write`；事件回灌丢弃本机来源帧。见 `docs/versions/0.6.1.md`。

**跨节点 Agent 传输（0.6，0.22.1 删除）**

- 删除 `src/node-registry.ts`、`src/remote-transport.ts`、`src/deferred-transport.ts`。
- 现状：`transport.kind` 只接受 `in-process`；`loopback` / `remote` 与
  `transport.nodes[]` 都是显式 validation error。
- 现状：跨节点能力只有 federation 平面（`POST /v1/federation/messages`，见 `docs/versions/0.20.0.md` 与 [ADR-094](adr/ADR-094-federation-team-to-team.md)）；
  `--connect` 客户端连远端 gateway 的能力不变。

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


## 14. 历史索引（0.1–0.26）

> 当前架构只保留 §1–§13。以下是已合入版本的实现记录，只追加、不改写；
> 为什么这样定见 [ADR 索引](adr/README.md)，每个版本落了什么见 `docs/versions/`。

| 版本段 | 主题 | 版本记录 |
|---|---|---|
| 0.1–0.3 | 最小内核 / Kernel 与模块边界 / durable / MCP / TLS | [0.1.0](versions/0.1.0.md) · [0.2.0](versions/0.2.0.md) · [0.3.0](versions/0.3.0.md) |
| 0.4 | 能力层 / evals / 飞书 / metrics | [0.4.0](versions/0.4.0.md) |
| 0.5 | 文件优先存储 / trace / RPC / 多租户 | [0.5.0](versions/0.5.0.md) |
| 0.6–0.7 | 远程控制面 / 独立前端 / CLI-TUI 对齐 | [0.6.0](versions/0.6.0.md) · [0.6.1](versions/0.6.1.md) · [0.7.0](versions/0.7.0.md) · [0.7.1](versions/0.7.1.md) |
| 0.8 | Wave 1–2B2B 加固 | [0.8.0](versions/0.8.0.md) – [0.8.7](versions/0.8.7.md) |
| 0.9–0.12 | 生命周期 / schema / 日志 / gateway | [0.9.0](versions/0.9.0.md) · [0.10.0](versions/0.10.0.md) · [0.11.0](versions/0.11.0.md) · [0.12.0](versions/0.12.0.md) |
| 0.13–0.15 | 状态栏 / 权限 / 压缩 / 可观测 | [0.13.0](versions/0.13.0.md) · [0.14.0](versions/0.14.0.md)–[0.14.4](versions/0.14.4.md) · [0.15.0](versions/0.15.0.md) · [0.15.1](versions/0.15.1.md) |
| 0.16–0.18 | agent 工具 / AgentService / tenant hub | [0.16.0](versions/0.16.0.md) · [0.17.0](versions/0.17.0.md) · [0.18.0](versions/0.18.0.md) |
| 0.19 | Agent/Body / Team / Hub / Web Team / 权限预算 | [0.19.0](versions/0.19.0.md) · [0.19.1](versions/0.19.1.md) |
| 0.20–0.23 | fork / federation / 寻址 / attention | [0.20.0](versions/0.20.0.md) · [0.21.0](versions/0.21.0.md) · [0.22.0](versions/0.22.0.md) · [0.22.1](versions/0.22.1.md) · [0.23.0](versions/0.23.0.md) |
| 0.24–0.26 | 默认全开 / hub / Team CRUD / Web IA / canonical | [0.24.0](versions/0.24.0.md) · [0.24.1](versions/0.24.1.md) · [0.25.0](versions/0.25.0.md) · [0.26.0](versions/0.26.0.md) · [0.26.1](versions/0.26.1.md) · [0.26.2](versions/0.26.2.md) |

- 历史只进 `docs/versions/`（版本快照）与 `docs/adr/`（决策）；不新建第二个历史目录。
- 当前契约以 §1–§13 与 `AGENTS.md` 为准；历史段落不再保留在当前文档。
