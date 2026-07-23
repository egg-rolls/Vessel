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

### 1.2 元资产与自组织

Vessel 的真正价值不在 core 本身，而在于**启动态极简、运行态自生长**。Agent 起跑时只拿到高度互联的元资产：

```
启动态（Vessel 分发）              运行态（Agent 自生长）
┌──────────────────────┐          ┌──────────────────────────────┐
│  循环（while loop）   │          │  用户: "帮我做市场调研"       │
│  元 Skill:           │          │  Agent:                       │
│    asset-introspection│          │    → search_assets("调研")    │
│    tool-discovery     │          │    → 缺口：没有 web-research  │
│  元 Tools:            │          │    → add_skill(调研方法论)    │
│    search_assets      │          │    → connect_mcp(brave-search)│
│    add_tool           │          │    → 执行 → 完成             │
│    add_skill          │          │    → 资产库积累：调研 Skill   │
│    connect_mcp        │          │       + Brave MCP 连接       │
│    inspect_asset      │          └──────────────────────────────┘
│    patch_asset        │
│    remove_asset       │
└──────────────────────┘
```

**自组织**：Agent 按用户使用模式自动积累 Skill 库和工具集。
**自闭环**：Agent 发现能力缺口 → 自己建工具/接 MCP/写 Skill，不需要人类跳出循环。
**自修复**：工具坏了 → `inspect_asset` 诊断 → `patch_asset` 修 → 验证。人类不用进循环。

Vessel 给 Agent 的不是 50 个工具——而是**一个知道自己有什么、缺什么、怎么补的认知结构**。元资产是 Harness 的真正资产。

### 1.3 资产拓扑：来源 vs 插槽

四种资产类型不是平坦关系。它们是**四种来源**，统一注入**两个插槽**：

```
        来源（资产怎么来的）                插槽（循环用什么）

        Plugin (TS 包) ──→ tools ────→ ┌──────────────┐
        MCP (远程进程) ──→ tools ────→ │ ToolRegistry  │ ← 循环只认这一个
        用户手写        ──→ tools ────→ │              │
        Agent 自建      ──→ tools ────→ └──────────────┘

        Skill (Markdown) ──→ system ┌──────────────┐
        记忆 (跨会话)    ──→ prompt │ ContextManager│ ← 循环只认这一个
        对话历史                 ──→ │              │
        MCP prompts/resources ──→   └──────────────┘

        Config (YAML) ──→ agent 定义 → AgentRuntime 构造
```

| 插槽 | 注入什么 | 被循环怎么用 | 来源可无限扩展？ |
|------|---------|------------|----------------|
| `ToolRegistry` | 工具（世界↔语言适配器） | `invoke(toolCall)` → 执行 | 是。Plugin、MCP、Agent 自建——都是同一个 `registerTool()` |
| `ContextManager` | 知识（语言空间内容） | `add(message)` → 下一轮 LLM 读取 | 是。Skill、记忆、MCP prompts——都是同一个 `add()` |

**为什么 Plugin 和 MCP 不是"两种方向"**：二者都是工具的**来源**。一个工具 handler 可以同时是"世界→语言"（如 web_search）和"语言→世界"（如 write_file）。来源格式（本地 TS vs 远程进程）与适配器方向（A vs B）是正交的。循环不关心工具来自哪里。

**为什么 Skill 不走工具**：Skill 的内容是给 LLM 的知识（"怎么用好系统"），不是给执行引擎的代码（"调这个 API"）。把 asset-introspection 做成工具让 LLM 自己调，就失去了"Agent 从第一轮就知道怎么了解自己"的认知启动效应——工具需要 Agent 意识到来调，Skill 是跑之前就已经在了。

**新来源格式**：出现 WCP / ACP / 任何新协议时，只需一个新的 Bridge Plugin 将其翻译到两个已有插槽：
```ts
const newProtocolPlugin: Plugin = {
  install(host) {
    for (const tool of protocol.listTools()) host.registerTool(tool);
    for (const doc of protocol.listDocs()) host.registerHook({...}); // inject into context
  },
};
```
来源可以无限增长。插槽只有两个。Agent 通过元工具 `connect_mcp`（或未来的 `connect_wcp`）在运行时自己添加新来源。

### 1.4 已知风险与缓解

极简核心把复杂性转移到外围。以下风险来源于架构取舍，供实现与测试时优先关注。

| 风险 | 根因 | 严重性 | 缓解 |
|------|------|--------|------|
| Agent 不理解自身资产 | asset-introspection Skill 若写得不好，Agent 退化到 dump 全部工具进上下文 | **高（BIOS 级）** | asset-introspection 必须是测试最多、常 polish 的 Skill；需在多个模型上验证 |
| Agent 把自己改坏 | `add_tool` / `add_skill` / `patch_asset` 注册了错误内容，破坏后续决策 | 中 | `registerTool` 时必须校验 schema + handler 签名；元工具禁止 raw eval；sandbox-fs 限制写入范围 |
| 插件拖垮 runtime | 单进程模型：一个坏插件的 crash 影响同 runtime 的所有能力 | 中 | UsageLimits 硬断 + ToolTimeout + CircuitBreaker；未来考虑 worker 隔离 |
| 无基础用户第一分钟劝退 | API Key 从哪来、provider 选谁——如果 TUI 向导不好，架构再对也没用 | 高 | 首启向导是 Phase 1 工程核心；权限弹窗的提示要面向无基础用户测试 |
| 复杂企业工作流 | DAG + 人工审批 + SLA 当前循环单进程无法表达 | 低（Phase 3 前） | Phase 3 workflow + durable 插件解决；不进 core |
| 长时间任务断电恢复 | 无持久化执行状态 | 低（Phase 3 前） | Phase 3 durable execution 插件解决 |

**核心结论**：架构的上限够高——高上限场景已有扩展路径（Phase 3 插件，不改 core）。架构的下限取决于 asset-introspection Skill 和 TUI 向导的工程质量，不是架构本身能保证的。

### 1.5 认知惰性对抗

**架构不能替代 Agent 思考，但能堵死它所有的偷懒借口。**

| Agent 惰性表现 | 借什么口 | 架构怎么堵死 |
|---------------|---------|------------|
| 不查工具，自己猜 | "我不知道有没有这能力" | `asset-introspection` Skill：第一轮就知道怎么查 |
| 给表面答案 | "没人教过我怎么做深" | Skill + tool-discovery：领域 know-how 随需加载 |
| 面对复杂任务 dump 一句话 | "一个人搞不定" | 子 agent 工具：`delegate_task` spawn 专家 runtime |
| 编造结果 | "反正没人检查" | Guardrail（OUTPUT）+ LLM-judge evaluator（Phase 3）|
| 上下文满了就丢信息 | "我记不住了" | Auto Compact + ContextManager token 预算 |
| 停在第一步就算完成 | "这就是全部我能做的" | `stop_on_no_tool_calls: false` + 任务分解 Skill |
| 遇到未知就说不会 | "没办法" | `search_assets` 查 → `add_skill` 补 → 回头做 |

**架构偷懒自查——Vessel 有没有犯常识性架构错误：**

| 标准 | 符合？ | 证据 |
|------|--------|------|
| 决策有据（ADR） | ✅ | ADR-001~015，每条含 Context/Decision/Consequences |
| 边界清晰（分层） | ✅ | core/config/tui 三层，依赖单向；core/插件/应用层 能力分层 |
| 接口契约（API 先于实现） | ✅ | SPEC §4：9 个 core 接口 + PluginHost + ToolDefinition，全部 TS 类型声明 |
| 扩展开放/修改关闭 | ✅ | PluginHost 统一扩展点；进 core 有决策树；改 core 需 ADR |
| 单一职责（模块） | ✅ | 9 个 core 接口各管一面；God-object 被 ADR-003 明确禁止 |
| 可观测（Event） | ✅ | EventStream 枚举化，trace/replay/TUI 共用 |
| 风险自知 | ✅ | SPEC §1.4 诚实列出 6 个已知风险 + 缓解 |
| 术语统一 | ✅ | GLOSSARY.md；跨文档交叉引用 |
| 最小可行（MVP 明确） | ✅ | ROADMAP Phase 1 范围精确；延后项明标 |
| 依赖方向受控 | ✅ | core 不依赖 tui/config/plugins；不引入 LangChain |
| **尚未验证的弱点** | ⚠️ | |
| asset-introspection 未在任何模型上测试 | BIOS 级风险 | 见 §1.4 |
| 插件加载/卸载/重载语义未指定 | 运行时行为模糊 | Phase 1 实现时需细化 |
| 单进程插件隔离弱 | 同进程 crash 传播 | 未来考虑 worker 隔离 |
| "两个插槽"模型未对真实实现摩擦做验证 | 理论已证，实践待测 | Phase 1 |

#### 两个适配器 = Agent 的故障诊断框架

Agent 完成任务的两个充要条件（直接来源于 §1.1 的适配器模型）：

1. **入适配器（知识）**：是否有足够知识理解此任务？
2. **出适配器（工具）**：是否有足够工具执行此任务？

任一不满足 → Agent 不应猜、不应装。应走 asset-introspection Skill 的认知检查循环：知识缺 → `search_assets` / `web-search` / `ask_user`；工具缺 → `search_assets` / `connect_mcp` / `add_tool` / `ask_user`。完整认知模式见 [PLUGINS.md §8.1](PLUGINS.md)。

**判断**：Vessel 目前的架构文档达到了专业软件架构的标准——有依据（ADR）、有契约（SPEC）、有边界（SCOPE 精神→PRD）、有风险意识（§1.4）。它不是认知惰性的产物。但它是一个**理论验证了的、代码未经检验的架构**。Phase 1 实现时，架构中标注为 ⚠️ 的条目是第一优先级的验证目标。

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
  default?: boolean;  // true = 在 system prompt 中自动列出; false = 通过 search_assets 发现
}
interface ToolRegistry {
  register(def: ToolDefinition): void;
  invoke(call: ToolCall, ctx: ToolContext): Promise<string>;
  schemas(): ToolSchema[];
}
```
工具用**声明式注册**（见 §5），与 provider/hook/guardrail 同构。

**默认工具体系**：常用基础工具（`file-ops`、`grep`、`web-search`、`web-fetch`）设 `default: true`，启动时在 system prompt 中简要列出。领域工具（`browser`、`rag`、`ocr`）设 `default: false`，由 Agent 通过 `search_assets` 按需发现。危险工具（`shell`）设 `default: false` 且必走 permission-prompt。Agent 可通过 Config CRUD 管理哪些工具默认可见。工具集清单见 [PLUGINS.md §一](PLUGINS.md)。

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

**格式**：YAML（`vessel.yaml`）。`@vessel/config` 以 JSON Schema 校验，未知键报错。**零配置起步**：文件不存在时全用安全默认，仅需 API Key。

**优先级**：CLI flag > env (`VESSEL_*`) > `vessel.yaml` > 安全默认。

### 6.1 完整 schema（渐进披露）

```yaml
# vessel.yaml — 仅供按需覆盖。空文件 = 全默认 + API Key 即可跑。

# 模型（必填的唯一项：API Key 由 env/wizard 提供）
model:
  provider: openai       # 空值时首启向导引导选择
  name: gpt-4.1
  base_url: ""           # 空值 = 内置预设 URL

# 工具（全部可选，不写 = 默认）
tools:
  default: [file-ops, grep, web-search, web-fetch, todo-list, ask-user]
  timeout: 30            # 全局工具超时(秒)

  shell:                 # 逐工具覆盖
    timeout: 60
    permission: require-approval
  web-search:
    api_key: ${TAVILY_API_KEY}
    timeout: 15

# 运行时控制
agent:
  max_iterations: 50
  max_runtime_seconds: 300

# 预算硬上限
limits:
  request_limit: 50
  tool_calls_limit: 200
  total_cost_limit: 5.0

# 会话与观测
sessions:
  backend: sqlite
  sqlite_path: .vessel/sessions.db

observability:
  event_stream: jsonl
  jsonl_path: .vessel/events.jsonl

# 插件
plugins:
  - memory-project
  - mcp-client

mcp:
  servers:
    - name: filesystem
      command: npx
      args: [-y, @anthropic/mcp-filesystem, /tmp]
```

### 6.2 核心设计原则

- **零配置**：空 `vessel.yaml`（仅有 `VESSEL_API_KEY`）可跑。
- **渐进披露**：默认不生成此文件。首启向导引导填 Key → 即可对话。高级用户手动创建文件覆盖。
- **工具默认清单** (`tools.default`)：Agent 可通过元工具修改——它就是 `Config` 资产的 CRUD 操作。
- **工具级覆盖** (`tools.<name>.*`)：少数需要特殊超时/权限/Key 的工具才写。
- **显式校验**：未知键报错，防止 typo 导致的静默失效。

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
