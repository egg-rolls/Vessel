# 技术规范（SPEC）

> 本文档定义 Vessel **怎么建**：架构、模块、接口契约、执行模型、扩展与配置模型。
> 决策的"为什么"见 [ADR.md](ADR.md)；产品"做什么"见 [PRD.md](PRD.md)；分期见 [ROADMAP.md](ROADMAP.md)；术语见 [GLOSSARY.md](GLOSSARY.md)。
> 状态：pre-MVP。标注 `[plan]` 的为待实现契约。下列 TS 接口为草图，供实现锚定。

## 1. 系统架构

三层，依赖单向向下：

```
┌─────────────────────────────────────────────┐
│  @vessel/tui    交互终端（REPL/slash/权限/向导）│  应用层
├─────────────────────────────────────────────┤
│  @vessel/config 声明式配置（YAML→对象/校验）   │
├─────────────────────────────────────────────┤
│  @vessel/core   运行时（loop/provider/context/ │  内置
│                  session/events/tools/limits/  │
│                  guardrail/hooks/plugin宿主）  │
└─────────────────────────────────────────────┘
        │ 依赖只向下；core 不依赖 tui/config/plugins
```

- `@vessel/core`：纯运行时库，零 UI 依赖，可独立嵌入。
- `@vessel/config`：解析/校验 YAML，产出 core 可消费的配置对象。
- `@vessel/tui`：调用 core + config，提供终端交互。

### 1.1 核心哲学：语言空间与两个适配器

Vessel 的核心假设：**Agent 的一切能力都可以还原为两类适配器，不需要动核心循环。**

```
现实世界 ──→ [适配器 A] ──→ 语言 ──→ Agent ──→ 语言 ──→ [适配器 B] ──→ 现实世界
             世界→语言                      语言→世界
```

- **适配器 A**（世界→语言）：文件、网页、数据库、MCP 返回值 → 变成 context 里的文本。= 工具。
- **适配器 B**（语言→世界）：agent 输出 → 文件写入、shell 执行、API 调用。= 工具。

Core 的 9 个接口全部服务于**维护语言空间**——不关心空间外面是什么世界：

| 接口 | 语言空间中的角色 |
|------|----------------|
| `LLMProvider` | 进出语言空间的大脑 |
| `ContextManager` | 语言空间当前的内容 |
| `ToolRegistry` | 适配器注册目录 |
| `EventStream` | 语言空间的运行轨迹（trace/replay/TUI 共用） |
| `Guardrail`（四阶段） | 语言空间的进出边界 |
| `UsageLimits` / `TerminationPolicy` | 语言空间的预算和止损 |
| `Hook`（五阶段） | 语言空间的钩子点 |
| `PluginHost` | 适配器挂载点 |

**循环的通用性**（ADR-015）：工具调用循环不随 Agent 范式变化。所有"看起来不同"的范式都是**同一个 while 循环挂不同的工具/Hook/Guardrail**：

| 范式 | 实际是什么 |
|------|-----------|
| A2A / 多 agent / 树搜索 | 工具（handler spawn 子 runtime） |
| Self-correction | Guardrail 或 Hook 注入修正提示 |
| Plan-then-execute | Agent 自身的推理 + 逐轮工具调用 |
| 并行 / 流式 / 打断 | 工具内部优化 / EventStream / signal.aborted——循环骨架不变 |

**结论**：Harness Engineering、Loop Engineering、树搜索、甚至未来还没命名的 Agent 范式——只要还在语言空间里运算，9 个 core 接口不用长大。

## 2. 包结构

```
vessel/
├── packages/
│   ├── core/       # @vessel/core
│   ├── config/     # @vessel/config
│   └── tui/        # @vessel/tui
├── plugins/        # 官方插件（memory/mcp/...），各自独立包
├── docs/           # 本文档集
├── legacy/         # 旧项目遗产（背景）
└── CLAUDE.md
```

monorepo（bun workspaces）。core 不引用 plugins/tui/config。

## 3. 核心执行模型

### 3.1 tool-calling loop

```
run(userInput):
  start Run, emit run.started
  apply INPUT guardrail
  context.add(userInput)
  loop (≤ maxIterations, ≤ limits, ≤ runtime budget):
    emit llm.request
    response = provider.chat(context.messages, tools, model)
    emit llm.response
    if response.finish == "stop":
      apply OUTPUT guardrail
      context.add(assistant)
      emit run.completed
      return finalText
    if response.finish == "tool_calls":
      context.add(assistant with tool_calls)
      for each tool_call:
        apply TOOL_CALL guardrail
        emit tool.call.started
        result = pluginHost.invoke(tool_call)   # 内置与插件工具统一入口
        apply TOOL_RESULT guardrail
        emit tool.call.completed
        context.add(tool result)
      persist RunState
    else: break
  emit run.completed(max iterations)
```

### 3.2 Run / Session 分离
- **Run**：一次 `run()` 调用，有 run_id，发一组事件，可持久化 RunState。
- **Session**：跨多轮的会话，持有 context 历史。Run 在 Session 内执行。

### 3.3 统一事件流
- 所有中间过程发 `RunEvent`；trace / replay / TUI 流式渲染订阅同一流。
- **流式 = 订阅事件流**，不是另一个 runtime（ADR-007）。
- 事件类型枚举化，payload 按 type 有 schema（ADR-008）。

## 4. 模块契约（`@vessel/core`）

### 4.1 LLMProvider
```ts
interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>;
  // 流式通过事件流增量输出，非独立方法（ADR-007）
}
interface ChatRequest { messages: Message[]; model: string; tools?: ToolSchema[]; }
interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: "stop" | "tool_calls" | "length";
  usage?: Usage;
}
```
Provider 适配器是**插件/参考实现**，不内置默认厂商 Key/BaseURL/价格；但可有 provider 预设列表方便选择（ADR-005）。

### 4.2 ToolRegistry / Tool
```ts
type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>;
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: ToolHandler;
  timeout?: number;
}
interface ToolRegistry {
  register(def: ToolDefinition): void;
  invoke(call: ToolCall, ctx: ToolContext): Promise<string>;
  schemas(): ToolSchema[];
}
```
工具用**声明式注册**（见 §5），与 provider/hook/guardrail 同构。

### 4.3 ContextManager
```ts
interface ContextManager {
  add(msg: Message): void;
  readonly messages: Message[];
  compact(): void;   // auto-compact 可作插件增强
}
```

### 4.4 EventStream / RunEvent
```ts
enum EventType {
  RunStarted, LlmRequest, LlmResponse,
  ToolCallStarted, ToolCallCompleted, ToolCallFailed,
  GuardrailBlocked, GuardrailModified,
  RunCompleted,
}
interface RunEvent {
  type: EventType;
  run_id: string;
  data: EventPayload;   // 按 type 对应 schema（ADR-008）
  ts: number;
}
interface EventStream {
  subscribe(handler: (e: RunEvent) => void): Unsubscribe;
  publish(e: RunEvent): void;
}
```

### 4.5 Guardrail（四阶段）
```ts
enum GuardrailStage { Input, Output, ToolCall, ToolResult }
interface Guardrail {
  stage: GuardrailStage;
  check(value: unknown, ctx: GuardrailContext): Promise<GuardrailResult>;
}
interface GuardrailResult {
  allowed: boolean;
  replacement?: unknown;
  reason?: string;
}
```
Guardrail 实例是**插件**，经 PluginHost 挂载，不进 runtime 构造函数（ADR-003）。

### 4.6 UsageLimits / TerminationPolicy
```ts
interface UsageLimits {
  request_limit: number;
  tool_calls_limit: number;
  input_tokens_limit?: number;
  output_tokens_limit?: number;
  total_cost_limit?: number;
}
interface TerminationPolicy {
  max_iterations: number;
  max_runtime_seconds?: number;
  stop_on_no_tool_calls: boolean;
}
```
作为 runtime 骨架前置（控制面优先，继承 legacy/GAPS 精神）。

### 4.7 Hooks
```ts
enum HookType { BeforeLlm, AfterLlm, BeforeTool, AfterTool, OnError }
interface Hook {
  type: HookType;
  run(ctx: HookContext): Promise<HookContext | null>;   // null = 拦截
}
```
Hook 是**插件**。

### 4.8 SessionBackend
```ts
interface SessionBackend {
  load(session_id: string): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
}
```
MVP 提供 in-memory + file 参考 backend。

### 4.9 PluginHost 与 AgentRuntime（统一扩展入口）
```ts
interface Plugin {
  name: string;
  install(host: PluginHost): void;
}
interface PluginHost {
  registerTool(def: ToolDefinition): void;
  registerProvider(name: string, factory: ProviderFactory): void;
  registerGuardrail(g: Guardrail): void;
  registerHook(h: Hook): void;
  // tool/provider/guardrail/hook 走同一注册心智（ADR-004）
}
interface AgentRuntimeOptions {
  provider: LLMProvider;
  model: string;
  tools: ToolRegistry;
  context: ContextManager;
  events: EventStream;
  limits: UsageLimits;
  termination: TerminationPolicy;
  plugins?: Plugin[];          // guardrail/memory/mcp/... 经此注入
  session?: SessionBackend;
}
class AgentRuntime {
  constructor(opts: AgentRuntimeOptions);
  run(input: string | Message, session_id?: string): Promise<string>;
}
```
**硬约束**：runtime 构造函数不接收 guardrail/memory/mcp/corrections/resilience 实例；它们以 Plugin 形式经 `plugins` 注入，在 install 时注册到 host（ADR-003，对应 [legacy/LESSONS.md](../legacy/LESSONS.md) 教训2）。

## 5. 扩展模型（统一心智）

新增任何扩展能力，统一用 **Plugin + PluginHost**：

```ts
const myPlugin: Plugin = {
  name: "my-plugin",
  install(host) {
    host.registerTool({
      name: "search",
      description: "搜索文件",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
      handler: async (args) => /* ... */,
    });
    host.registerGuardrail({
      stage: GuardrailStage.Output,
      check: async (v) => ({ allowed: true }),
    });
  },
};
```

- 内置工具/provider/guardrail 也走同一 Plugin 机制（内置插件在 core 启动时自动 install）。
- 用户插件通过配置 `plugins: [./my-plugin.ts]` 或 TUI 加载。
- **不再有 4 套机制**（ADR-004，对应 legacy/LESSONS 教训3）。

### 5.1 扩展类型（用户面向）

四种扩展内容类型，全部经 PluginHost 投放，**core 不为它们新增接口**（ADR-011）：

| 类型 | 是什么 | 形态 | 谁来加 |
|------|--------|------|--------|
| **Plugin** | 代码能力（tools/providers/guardrails/hooks） | TS 包 | 开发者 |
| **MCP** | 外部能力（协议桥） | MCP server + 桥接插件 | 任意语言 |
| **Skill** | 行为 know-how（可复用剧本） | Markdown + 可选脚本 | 无基础用户也能写 |
| **Config** | agent 声明（人设/工具集/限额） | YAML | 弱基础用户 |

- **Skill** 由 skills-loader 插件承载：用 `BeforeLlm` 钩子按需注入 skill 内容，用 TUI slash 命令触发；skill 内容是 Markdown，非代码。Skill 承载的不只领域 know-how，也包括 Agent 自身的元认知策略（如何查询资产、节俭上下文、何时委派子 agent、CRUD 自己的工具/Skill/MCP/Plugin）。元认知 Skill 随 Vessel 分发并在启动时自动加载。
- **MCP** 由 MCP client 插件桥接外部 server 进 tool 注册表。
- 三者共用 PluginHost，故"加功能 = 加 Plugin/MCP/Skill"字面成立且 core 零改动（ADR-011/012）。

插件 backlog 目录见 [PLUGINS.md](PLUGINS.md)。

## 6. 配置模型

- **零配置起步**：仅填 `api_key` 即可对话；provider/model/limits/guardrail 全有安全默认（ADR-005）。
- **渐进披露**：`vessel.yaml` 只在用户需要时出现，默认不生成几十个键（对应 legacy/LESSONS 教训4）。
- 配置 schema 由 `@vessel/config` 定义并校验；**未知键报错**（而非静默忽略）。
- 优先级：CLI flag > env (`VESSEL_*`) > `vessel.yaml` > 安全默认。
- Key 永远用户自备，从 env 或向导读；不内置任何厂商 Key。

## 7. 数据流

```
用户(TUI) → Config 加载 → 构造 Runtime(plugins install) → run()
   → loop: provider.chat ⇄ pluginHost.invoke(tool) ⇄ context.add
   → events → EventStream → TUI 流式渲染 / trace / replay
   → SessionBackend 持久化 RunState
```

## 8. 实现红线

实现必须遵守的约束清单（含理由）见 [CLAUDE.md §6 红线](../CLAUDE.md)。核心几条：
- core 极小：runtime 只管 loop+事件+状态；guardrail/memory/mcp/corrections/resilience/evals 是插件。
- runtime 构造函数只收核心必需项，不注入插件对象。
- 事件类型枚举化 + payload schema；全异步无 sync-in-async；不可变优先；不留 stub。
- core 不依赖 tui/config/plugins；不绑厂商/价格；不引入 LangChain。
