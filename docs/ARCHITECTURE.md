# 技术架构

> 本文描述 Vessel 当前的架构事实。历史决策与「为什么」见 [ADR.md](ADR.md)。

---

## 1. 三层结构与依赖方向

> 本节描述**当前已实现**的结构；0.2 的 Kernel / Modules 分层（`Contracts ← Kernel ← Modules ← SDK ← Shells`）见 §14（已实现，未随版本发布），二者不混写。

```
apps/web                 网页控制台（v1）
    │
packages/serve           常驻服务 gateway（--serve）
packages/tui             终端界面：Ink REPL、流式渲染、slash 命令、权限确认
    │
packages/config          声明式 YAML 配置：加载、校验（未知键报错）、snake_case→camelCase 映射
    │
packages/core            运行时：tool-calling loop、provider 抽象、context、session、事件流、
                         权限策略、guardrail/hook 编排、PluginHost      ← 零 UI 依赖，可独立嵌入
packages/permission      共享权限原语（工具经事件流等用户授权）
```

**依赖方向单向**：`core` 不引用 `config` / `tui` / `serve` / `plugins`，也直接不引用任何厂商 SDK。`core` 的 `dependencies` 为空。

`plugins/` 与 `core` 的关系是**注入**而非依赖：插件在 `install(host)` 里往 `PluginHost` 注册工具 / provider / guardrail / hook。

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
    runId = uuid()
    重置 usage 统计
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

        output = toolCallingLoop(runId, sessionId, opts.signal)
        runState.status = 'completed'; runState.messages = context.messages
        session.save(runState)
        发 run.completed
        return output
    catch error:
        run OnError hooks
        runState.status = 'failed'
        runState.messages = context.messages   # 失败也保存真实上下文，不覆盖历史
        session.save(runState)
        发 run.failed
        throw
```

### 3.2 `toolCallingLoop()`：循环骨架

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
                tool = PluginHost.getTool(toolCall.function.name)   # 唯一工具来源
                未找到 → 抛错
                toolCtx = { run_id, session_id, messages: context.messages, events }
                await permissionPolicy.authorize(tool, args, toolCtx)   # allow / deny / ask
                result = invokeTool(tool, args, toolCtx)                # 统一入口，套 tool.timeout
                应用 ToolResult guardrail，被阻止 → 抛错
                finalResult = replacement 是字符串 ? replacement : result
                发 tool.call.completed
                await hooks.run(AfterTool, hookCtx)
                addContext({ role: 'tool', tool_call_id, content: finalResult })
            catch error:
                run OnError hooks
                发 tool.call.failed
                addContext({ role: 'tool', tool_call_id, content: `Error: ${msg}` })
                # 工具失败不中断循环——错误文本折回语言空间，模型自行决定下一步

    else:  # 例如 finish_reason == 'length'
        addContext(assistant 消息，带上 response.reasoning_content)
        return response.content
```

### 3.3 关键约束

- **工具只能从 `PluginHost` 拿。** 循环里没有第二张表。装配层要么在 `plugins` 里传 Plugin（插件 `install` 时 `registerTool`），要么直接注入 `pluginHost`。
- **工具调用统一走 `invokeTool()`**，由它套 `tool.timeout`——handler 直调会让 `timeout` 失效。
- **工具失败不终止 run**。错误变成 `role: tool` 消息回到上下文，模型自己纠。非法 tool arguments JSON 也走这条路径（解析一次、发 `tool.call.failed`、折回错误文本）。
- **发给 Provider 的消息始终是合法序列**：`buildRequestMessages` 在输出前丢弃孤儿 `role: tool`、把不完整 `tool_calls` 轮次降级为普通 assistant 文本，并在上下文缺 system 时补回基底 `systemPrompt`。归一化只影响本次请求，不改 `ContextManager` 的持久化记录。
- **Guardrail `replacement` 四阶段生效**：Input（改写持久化的用户消息）、Output（改写返回值与持久化 assistant 消息）、ToolCall（改写实际执行的调用，先于 assistant 消息写入）、ToolResult（改写事件、上下文与返回值）；非法类型按未改写处理。
- **thinking 模型的 `reasoning_content`**：Provider 返回后保存在 assistant 消息并随下一轮请求回传（含 `tool_calls` 轮次）；`llm.request` / `context.changed` 事件在发布前剥离该字段，TUI / 观测 / 回放看不到思维链，会话持久化保留（ADR-038）。
- **权限是执行期判定，不是注册期过滤**：`checkPermission` 返回 `'allow' | 'deny' | 'ask'`；`'ask'` 走事件流等用户决定（`tool.permission.request` → `waitFor('tool.permission.response')`，120s 超时）。未声明 `checkPermission` 的工具走 `RuntimePermissionConfig` 默认策略（库默认 `'allow'`，交互模式由装配层传 `'ask'`）。
- **`HookRunner` 丢弃 hook 返回值**（`Hook.run` 收窄为 `Promise<void>`）。跨 hook 通信的唯一通道是 `HookContext` 的字段（例如 `BeforeLlm` 的 `systemPrompt`）。

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

四个阶段任一 `allowed: false` 即短路并抛错（并发 `guardrail.blocked`）。`replacement` **真实生效**（ADR-035）：Input 改写持久化的用户消息；Output 改写返回值与持久化 assistant 消息；ToolCall 改写实际执行的调用（先于 assistant 消息写入）；ToolResult 改写事件、上下文与返回值。类型不符的 replacement 按未改写处理（Input/Output/ToolResult 只接受字符串，ToolCall 只接受合法 `ToolCall`）。

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

## 6. `AgentRuntime` 公开面

```ts
class AgentRuntime {
  static create(opts: AgentRuntimeOptions): Promise<AgentRuntime>;

  /** 事件流——headless / 外部订阅者的入口 */
  readonly events: EventStream;
  /** 工具与插件的唯一来源——TUI/装配层从这里读，不再经由 ToolRegistry */
  readonly pluginHost: PluginHost;

  run(input: string | Message, sessionId?: string, opts?: RunOptions): Promise<string>;
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
  systemPrompt?: string;
  permission?: RuntimePermissionConfig;
}
```

`create()` 是异步静态工厂（构造函数私有）——插件安装是异步的，且要求 fail-fast（ADR-023）。

## 7. 扩展模型

**一个机制：`Plugin` + `PluginHost`。** core 不为任何扩展类型新增接口。三类扩展内容：

| 类型 | 是什么 | 怎么投放 |
|---|---|---|
| **Plugin** | TypeScript 模块，自描述对象 | `plugins/<category>/<name>/`，见 §8 |
| **Skill** | 纯 markdown 文件 | **不是一条加载通道**——由前端读取，经 `RunOptions.messages` 作为消息注入（见 §4） |
| **Config** | YAML 声明 | 见 §9 |

插件能注册什么：**工具**（`registerTool`）、**Provider**（`registerProvider`）、**Guardrail**（`registerGuardrail`）、**Hook**（`registerHook`）。

**MCP 延后**：本期 core 与默认插件集里都没有 MCP 客户端。需要接外部系统时，先用 `bash`（`curl` / 厂商 CLI）顶；MCP 若回归，形态也是"一个插件"，不会给 core 加接口。

## 8. 插件发现

**唯一一套：运行时目录扫描**（`src/plugin-loader.ts`）。

```
plugins/
├── tools/basic-tools/       package.json + src/index.ts   → bash / read / edit
├── tools/delegate-task/     → delegate_task（工厂式）
├── tools/team/              → team_* 5 个（工厂式；默认不加载，team.enabled 才构造）
├── security/guardrail-pii/  → 输入输出 PII 脱敏
├── security/redact-secrets/ → 工具结果与输出里的密钥脱敏
├── security/tool-policy/    → ToolCall 阶段 allowlist / denylist
├── observability/hook-logging/
└── provider/{openai,anthropic}/
```

共 **9 个插件包**。规则：`plugins/<category>/<name>/package.json` + `src/index.ts` 存在即注册，**无需改代码、无需构建步骤**；`src/index.ts` 的默认导出须是 `Plugin`（含 `install()`）。目录形态不是 Plugin 的（例如默认导出是工厂函数、需要装配层注入依赖）列在 `FACTORY_PLUGINS` 里，由装配层自行构造——目前是 `delegate-task` 与 `team`。`team` 还要求 `team.enabled: true` 显式 opt-in；`PluginLoader` 的默认集与 `plugins:` 显式列表都会过滤它。

`PluginLoader` 的接口：

```ts
class PluginLoader {
  list(): PluginDescriptor[];
  getProviders(): string[];         // category === 'provider'
  getAvailablePlugins(): string[];  // 排除 provider 与工厂式插件
  load(name: string): Promise<Plugin | null>;
}
```

**扫描只在进程启动时发生一次。** `PluginLoader` 把扫描结果缓存在实例上（插件目录在进程生命周期内视为不变），**这不是热加载**：新增或改动插件需要**重启进程**才生效，`/reload` 只重载配置、不重扫插件目录。

**加能力就是放一个文件夹。** `bash` 工具在，写文件 + 跑命令本身就是模型能做的事——这就是不再需要「声明式工具」「用户目录工具扫描」「运行时注册表」的原因。

## 9. 配置模型

两层，后者覆盖前者：

| 层 | 路径 | 用途 |
|---|---|---|
| 用户级 | `~/.vessel/config.yaml`（Windows `%USERPROFILE%/.vessel/`） | API Key、provider、默认模型。首启向导写这里 |
| 项目级 | `./vessel.yaml` | 项目级覆盖：agent system prompt、guardrails、hooks、limits、session、context |

优先级：**CLI flag > 环境变量（`VESSEL_*`）> `vessel.yaml` > `~/.vessel/config.yaml` > 安全默认**。

loader 把 YAML 的 snake_case 映射成 TS 的 camelCase（ADR-019）。校验器对未知键报错——配置写错要立刻知道，不静默忽略。

### 9.1 配置块（0.1.0）

| 键 | 说明 |
|---|---|
| `provider.timeout_ms` | LLM 请求超时（毫秒）；`<=0` 关闭。仅插件式 provider（openai / anthropic）生效 |
| `session.backend` | `sqlite`（默认）/ `file` / `memory`；`storagePath` 对应 sqlite 文件或 file 目录 |
| `update.autoCheck` / `channel` / `source` | 交互启动后台检查（默认 true）、`latest` / `beta`、自定义清单源 |
| `delegate.enabled` / `maxDepth` / `disallowed` / `model` / `limits` / `termination` | `delegate_task` 接线；`enabled: false` 时默认工具变为 3 |
| `delegate.permission_mode` | `bridge`（交互默认）/ `allow`（headless 默认）/ `deny`；`deny` 时保留 `read_only_tools`（默认 `["read"]`） |
| `team.enabled` / `maxMembers` / `ownerId` / `model` / `memberLimits` / `memberTermination` | 进程内 team 原型；默认 false，必须显式开启 |

- **顶层未知键是 error**（带编辑距离拼写建议），不是 warning——启动即失败，避免配置悄悄无效。
- 已知但 0.1.0 未消费的字段（`agent.name/temperature/maxTokens`、`session.maxHistory`、`guardrails`、`hooks`）给显式 warning，不静默。
- provider 默认 model 是 provider-aware：只有已登记 provider（当前 `openai`）有默认；未知 provider 必须显式配 `model`。
- `VESSEL_PROVIDER_API_KEY` 可回填顶层 `apiKey`。

**注意**：`vessel.yaml` 的 `tools:` 声明段已删除（连同 `ToolConfig` 类型）。从前"用户在配置里声明一个 shell/http 工具"这条路径没有了——有了 `bash` 之后，加能力就是写文件 + 跑命令。

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
| `context.changed` | `{ run_id, message, message_count, token_count }` | agent-runtime |
| `run.completed` | `RunCompletedPayload` | agent-runtime |
| `run.failed` | `RunFailedPayload` | agent-runtime |
| `replay.started` | `{ run_id, event_count }` | replayRun |
| `replay.completed` | `{ run_id, event_count, duration_ms }` | replayRun |

**约定事件名**（不在 `EventPayload` 联合类型里，按开放字符串协议使用）：

| 事件名 | 方向 | 用途 |
|---|---|---|
| `tool.permission.request` / `tool.permission.response` | 工具 → TUI → 工具 | 执行期权限确认（120s 超时） |
| `ask.user.requested` / `ask.user.answered` | 工具 → TUI → 工具 | ask_user 交互暂停 |

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

## 11. 工具集：三个能力工具，为什么这么少

默认运行期 **4 个**工具：`plugins/tools/basic-tools` 提供 **`bash` / `read` / `edit`** 三个**能力工具**，装配层注册 `delegate_task` 一个**接缝工具**。

| 接缝 / 可选工具 | 注册条件 |
|---|---|
| `delegate_task` | 默认注册；`delegate.enabled: false` 时关闭（工具变为 3 个）。权限模式：交互 `bridge`、headless `allow`、可配 `deny`（保留 `read_only_tools`） |
| `ask_user` | 仅「实际进入 REPL 且 stdin 是 TTY」；serve / headless / 管道不注册 |
| `team_*`（spawn / send / inbox / status / cancel） | 仅 `team.enabled: true`（默认关闭）。进程内原型，跨进程在 0.2 |

口径：**默认 4 / 交互 REPL 5 / 启用 team 9**。`--tools` 一次性命令按 headless 口径列出 4 个，并注明 `ask_user (interactive only)`。

| 工具 | inputSchema | 权限 | 行为 |
|---|---|---|---|
| `bash` | `{ command, cwd?, timeout_ms? }` | `ask` | `Bun.spawn(['bash','-c',command])`。超时默认 120s；输出超 2000 行时保留头 1000 + 尾 1000 并标注省略行数；超时返回明确错误文本而非抛异常 |
| `read` | `{ path, offset?, limit? }` | `allow` | 带行号返回（从 1 开始）。`limit` 默认 2000 行；截断时标注总行数与继续读的方式 |
| `edit` | `{ path, old_string, new_string, replace_all? }` | `ask` | `old_string` 必须**精确匹配且唯一**；不唯一时报错并说明匹配次数，未匹配时报错；`replace_all: true` 才允许多处替换 |

**被判死的工具，以及为什么**：

| 删掉的 | 因为 |
|---|---|
| `grep` / `ls` / `cat` / `find` | `bash` 就能干，且组合能力更强 |
| file-ops（`write_file` / `create_dir` / `path_exists` / …） | `edit` 写、`bash` 建目录与判定存在 |
| meta-tools（`register_tool` / `search_assets` / `inspect_asset` / …） | 写文件即等于建工具：模型用 `bash` 落一个插件目录，下次启动被 `PluginLoader` 扫到 |
| skills-loader（scanner + CRUD + 文件监听） | skills 就是文件；前端引用、core 只收消息 |
| MCP 客户端 | 本期不做 |
| memory 插件 | 项目约定写在 `AGENTS.md`，模型自己读；跨会话笔记是 markdown 文件，模型自己读写 |

判据只有一条：**能被其他工具替代的工具，就不该存在**。工具越多，模型的选错空间越大；真正的通用原语只有"执行一条命令"，其余都是它的特化。

## 12. 装配层（`src/`）

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 入口分发：REPL（默认）/ `--run`（唯一 headless 入口：有参=文本或 `@file`，无参=stdin）/ `--serve` / `--version` / `--tools` / `update`；非交互且无 Key 时快速失败，不进首启向导 |
| `src/cli-args.ts` | 纯参数解析（语法与互斥），无副作用；`--serve` 默认端口 8642 |
| `src/cli-update.ts` | `update [--check] [--channel latest\|beta] [--json] [--force]`：只读检查与提示 |
| `src/update/` | 更新清单解析、GitHub 通道选择、24h 缓存、后台检查、semver 比较；不自替换 |
| `src/bootstrap.ts` | config → provider → plugins → runtime → `ReplContext`；按配置构造 delegate / team，装配 session backend |
| `src/plugin-loader.ts` | 插件发现（见 §8） |
| `src/plugin-selection.ts` | bootstrap 与 `--tools` 共用的插件选择策略，避免默认集漂移 |
| `src/session-factory.ts` | `session.backend` → sqlite / file / memory |
| `src/tools-list.ts` | `--tools` 的工具清单（不构造 runtime、不需要 Key） |
| `src/headless-runner.ts` | headless 运行器 |

**REPL 的职责边界**：`ReplContext` 携带 `runtime`、`pluginHost`、`session`、`events`、`context`。`/tools` 与 `/plugins` 从 `runtime.pluginHost` 读——不再有第二个只为展示而存在的 host。`@路径` 的展开也发生在这里（见 §4）。

**用户可见行为（0.1.0）**：

- `/clear` 只清屏，不清空 `ContextManager`；需要新会话用 `/new`。
- `@路径` 引用在发送前展开为注入消息，界面以引用块展示，用户原文不变。
- `/reload` 只重载配置文件并刷新 provider 信息，**不重扫插件目录**；新增插件需重启进程。
- 自动更新：`vessel update [--check] [--channel latest|beta]` 读取 Release 的 `latest.json`，只提示版本与安装命令，不下载/不自替换。交互 REPL 启动时后台检查（24h 节流、失败静默、可关闭），有新版本时发布 `update.available`，由 TUI 渲染 banner。契约见 [operations/CI-CD.md](operations/CI-CD.md)。

## 13. Gateway 协议与 Web 控制台（0.1.0）

`packages/serve` 是 **EventStream 的消费者**（与 TUI 的 StreamRenderer 同构）：把 runtime 事件广播为 WS / SSE，并提供 `/v1` 控制端点；**不改 core、不经过 PluginHost**。`apps/web` 是配套的浏览器控制台。

### 13.1 协议 `vessel.gateway/1`

- 服务端帧：`hello`（协议/节点信息 + `from_seq` / `latest_seq`）、`event`（带 `seq`、可选 `job_id`）、`gap`（历史被截断）、`res`（方法应答）、`ping`。
- `hello.from_seq` 是本次回放的**第一条** seq：空缓冲为 `0`；已追平时为 `since + 1`（下一条期望序号）。`latest_seq` 是当前最新 seq（空缓冲为 `0`）。
- 客户端帧：`auth`（首帧）、`req`（`id` + `method` + `params`）、`pong`。
- `seq` 由 gateway 分配；环形缓冲默认保留 10000 条。客户端记录 `lastSeq`，重连用 `?since=` 续订；超出缓冲发 `gap`。
- `RunStatus.run_id` 是网关级 id；`core_run_id` 在 `run.started` 后可知；事件帧的 `job_id` 用于把 core run 与网关 run 对齐。

### 13.2 端点

| 方法 / 路径 | 说明 |
|---|---|
| `GET /v1/health`（`/health` 兼容） | 开放探针；返回 clients / latest_seq / protocol / node |
| `GET /v1/events`（WS，`/ws` 兼容） | 事件流；query token 兼容，推荐首帧 `auth` |
| `GET /v1/events`（SSE，`/events` 兼容） | 只读事件流；`?token=` |
| `GET /v1/sessions`（`/sessions` 兼容） | 会话列表（`listRich`） |
| `GET /v1/tools` | 工具列表（不含 handler） |
| `GET /v1/runs?session_id=` | 当前进程运行列表 |
| `POST /v1/runs` | `{input, session_id?}` → 202 `{run_id, status, queue_position?}`；队列满 429 `busy` |
| `GET /v1/runs/:id` | 运行状态 |
| `POST /v1/runs/:id/cancel` | 取消（AbortController） |
| `POST /v1/permissions/:id` | `{decision:'allow'|'deny', remember?}` → 发布 `tool.permission.response` |
| `POST /v1/ask/:id` | `{answers:[]}` → 发布 `ask.user.answered`（空数组表示取消） |
| `POST /run` | 0.1.0 兼容的阻塞式入口 |

WS 方法：`run.submit` / `run.cancel` / `run.get` / `sessions.list` / `tools.list` / `permission.respond` / `ask.respond`。`team.*` 在 0.1.0 返回 `method_not_allowed`（0.2 草案见 `protocol.ts`）。

### 13.3 G1：权限与 ask_user 桥

- gateway 订阅 `tool.permission.request` 建立待答表；`POST /v1/permissions/:id` 或 WS `permission.respond` 发布 `tool.permission.response`。Web 弹窗支持 allow / deny / always（remember）。
- `ask.user.requested` 同理：`POST /v1/ask/:id` 或 `ask.respond` 发布 `ask.user.answered`。
- 不引入直接回调：工具与 UI 仍只通过事件流沟通（ADR-029）。

### 13.4 G2：会话切换

`GatewayOptions.context` 存在且目标 session 与当前不同时：先 `context.setSessionId(target)` 再 `context.clear()`，随后 `runtime.run` 从 `SessionBackend` 重载目标会话历史。没有 `context` 时无法保证隔离（需装配层传入）。

### 13.5 静态托管与安全

- `staticDir` 存在时，GET/HEAD 的非 API 路径托管 `apps/web/dist`；无扩展名路径回落 `index.html`（SPA）；路径解析后校验 root 前缀，防穿越；API 路径永不托管。
- 默认绑定 `127.0.0.1`；Host 只接受 `127.0.0.1` / `localhost` / `[::1]` 或显式 `hostname`。
- Origin：无 Origin 放行（curl / peer）；浏览器必须同源或在 `allowedOrigins`。默认不返回 CORS 头。
- token 来源优先级：`config > VESSEL_GATEWAY_TOKEN > gateway 自动生成`。生成值 32B 随机 base64url，恒定时间比较；WS 5s 未鉴权关闭 4401。
- 事件流是长连接：`Bun.serve` 的 `idleTimeout` 默认 `0`（禁用，可用 `GatewayOptions.idleTimeout` 覆盖）；heartbeat 默认 15s，SSE 发 `: ping` 注释、WS 发 `ping` 帧，用于穿透代理与检测死客户端。
- 请求体上限 1 MiB；慢客户端 `bufferedAmount > 4 MiB` 断开（1013）；HTML 带 CSP；无 `*` CORS。

### 13.6 Web 控制台（`apps/web`）

- React + Vite；`GatewayClient` 用 WS 收事件，`seq` 去重、断线重连（`?since=`）、gap 提示。
- token 存 URL fragment，再转 `sessionStorage`。
- 功能：运行提交/取消、时间线、会话列表、工具端点、权限弹窗、ask_user 表单。
- 开发：`cd apps/web && npm run dev`（Vite 代理 `/v1` 与 `/health` 到 `127.0.0.1:8642`，`changeOrigin:false` 保持同源）；生产：gateway 托管 `dist`。
- 0.1.0 已知限制：单 runtime / 单 context，并发固定 1（队列上限 100）；运行与事件历史在内存，重启丢失；无自动化浏览器测试。
- **接线（已完成）**：CLI 给 `startGateway` 传 `events` / `session` / `runtime` / `context` / `pluginHost` / `staticDir`；`staticDir` 取 `VESSEL_STATIC_DIR`，否则仓库内 `apps/web/dist` 存在时使用。因此 G2 与静态托管在 `--serve` 下生效。

## 14. 0.2 Kernel 与模块边界（已实现，未发布）

> **状态：已实现（0.2 分支起），未随版本发布。** 本节描述 Kernel / Modules / Transport 的事实；0.3 的 durable / MCP / 远程 TLS 尚未写入本节，待合入 `release/0.3` 后由正文收口。当前发布行为以 §1–§13 为准。决策依据见 [ADR-037](ADR.md)。
> 0.2 不重写 loop、不删除公开 API；新能力默认 off / opt-in。

### 14.1 定位与分层（已实现）

- **定位**：Vessel 是可嵌入的**多 agent 平台 runtime**；TUI / CLI / Web / Gateway 是参考 harness 外壳，只消费 runtime 的 SDK 与事件。
- **分层**：`Contracts ← Kernel ← Modules ← SDK ← Shells`；`Plugins` 只依赖 Contracts / 公开 API，经 `PluginHost` 在运行期 install。依赖方向单向，并由 CI 自动检查。
- **Module ≠ Plugin**：Module 是编译期/构造期边界（一个 port 一个实现）；Plugin 仍是唯一运行期扩展机制。**不引入 `ModuleHost` / `ModuleRegistry` / 第二套扩展机制。**
- **非目标**：durable execution / workflow / evals / MCP / 多租户 / 远程监听 / TLS / 跨机器调度 / 单二进制主分发。

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
- 远程监听 / TLS / 跨机器发现 / 消息持久化不在 0.2。

### 14.5 兼容与迁移（已实现）

- **冻结**：9 接口、`AgentRuntime` 公开面、`RunOptions` / `RunEvent`、事件名、插件机制、根导出面；0.2 只做加法与内部替换，不删除公开 API。
- `delegate_task` 改为 Host 上的**一次性临时成员**（工具名与语义不变）；`@vessel/team` 改为**持久成员**；二者共用 `RuntimeHost`。
- `@vessel/team` 的 `InProcessRuntimeHost` 在 0.2 标 `@deprecated` 并适配到 core Host，0.3 才移除。
- 事件：core TS 内部用 camelCase（`agentId`），gateway JSON 用 snake_case（`agent_id`），映射只在 gateway 边界做一次；事件名仍是开放字符串。
- 依赖方向由 CI 自动检查（biome `noRestrictedImports` 或等价脚本），不只写在文档里。
