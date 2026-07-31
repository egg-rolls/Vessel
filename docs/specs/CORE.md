# @vessel/core 接口参考

> **目标**：快速了解 Core 有什么、什么能改、什么不能改。
> **详细设计**：见 [SPEC.md](SPEC.md)；**决策历史**：见 [ADR.md](ADR.md)。
> **核心原则**：Core 冻结（ADR-017），功能增长走 Plugin/MCP/Skill。

---

## 1. Core 的 9 个接口

Core 只有 9 个接口 + 1 个循环 + 2 个插槽。**所有接口都是 TypeScript 类型定义，没有实现逻辑。**

### 1.1 LLMProvider（大脑）

```typescript
interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>
}

interface ChatRequest {
  messages: Message[]
  model: string
  tools?: ToolSchema[]
  stream?: boolean
  on_chunk?: (chunk: StreamChunk) => void
}

interface LLMResponse {
  content: string
  tool_calls?: ToolCall[]
  finish_reason: "stop" | "tool_calls" | "length"
  usage?: Usage
}
```

**职责**：进出语言空间的大脑。
**实现**：插件（Anthropic/OpenAI/...）。

### 1.2 ToolRegistry（工具注册表）

```typescript
interface ToolRegistry {
  register(def: ToolDefinition): void
  invoke(call: ToolCall, ctx: ToolContext): Promise<string>
  schemas(): ToolSchema[]
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
  handler: ToolHandler
  timeout?: number
  default?: boolean
}

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>
```

**职责**：适配器注册目录（世界↔语言）。
**实现**：Core 内置注册表。

### 1.3 ContextManager（上下文管理）

```typescript
interface ContextManager {
  add(msg: Message): void
  readonly messages: Message[]
  compact(): void
}
```

**职责**：语言空间的活跃内容。
**实现**：Core 内置。

### 1.4 EventStream（事件流）

```typescript
interface EventStream {
  subscribe(handler: (e: RunEvent) => void): Unsubscribe
  publish(e: RunEvent): void
  clear(): void
}

interface RunEvent {
  type: EventType
  run_id: string
  data: EventPayload
  ts: number
}

enum EventType {
  RunStarted = 'run.started',
  LlmRequest = 'llm.request',
  LlmResponse = 'llm.response',
  LlmStreamChunk = 'llm.stream.chunk',
  ToolCallStarted = 'tool.call.started',
  ToolCallCompleted = 'tool.call.completed',
  ToolCallFailed = 'tool.call.failed',
  GuardrailBlocked = 'guardrail.blocked',
  GuardrailModified = 'guardrail.modified',
  RunCompleted = 'run.completed',
  RunFailed = 'run.failed',
  SessionCreated = 'session.created',
  SessionLoaded = 'session.loaded',
  Error = 'error',
}
```

**职责**：语言空间的运行轨迹（trace/replay/TUI 共用）。
**实现**：Core 内置。

### 1.5 Guardrail（护栏）

```typescript
interface Guardrail {
  stage: GuardrailStage
  check(value: unknown, ctx: GuardrailContext): Promise<GuardrailResult>
}

enum GuardrailStage {
  Input = 'input',
  Output = 'output',
  ToolCall = 'tool_call',
  ToolResult = 'tool_result',
}

interface GuardrailResult {
  allowed: boolean
  replacement?: unknown
  reason?: string
}
```

**职责**：语言空间的进出边界。
**实现**：插件（经 PluginHost 挂载）。

### 1.6 UsageLimits（用量限制）

```typescript
interface UsageLimits {
  request_limit: number
  tool_calls_limit: number
  input_tokens_limit?: number
  output_tokens_limit?: number
  total_cost_limit?: number
}
```

**职责**：语言空间的预算。
**实现**：Core 内置。

### 1.7 TerminationPolicy（终止策略）

```typescript
interface TerminationPolicy {
  max_iterations: number
  max_runtime_seconds?: number
}
```

**职责**：语言空间的止损。
**实现**：Core 内置。

### 1.8 Hook（钩子）

```typescript
interface Hook {
  type: HookType
  run(ctx: HookContext): Promise<HookContext | null>
}

enum HookType {
  BeforeLlm = 'before_llm',
  AfterLlm = 'after_llm',
  BeforeTool = 'before_tool',
  AfterTool = 'after_tool',
  OnError = 'on_error',
}
```

**职责**：语言空间的钩子点。
**实现**：插件（经 PluginHost 挂载）。

### 1.9 SessionBackend（会话后端）

```typescript
interface SessionBackend {
  load(session_id: string): Promise<RunState | null>
  save(state: RunState): Promise<void>
  delete(session_id: string): Promise<void>
  list(): Promise<string[]>
  listRich(): Promise<SessionInfo[]>
  close?(): void
}

interface SessionInfo {
  session_id: string
  title: string
  preview: string
  status: string
  started_at: number
  updated_at: number
  message_count: number
}
```

**职责**：会话持久化。
**实现**：插件（in-memory/file/sqlite）。

---

## 2. Core 的循环

### 2.1 tool-calling loop

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
        result = pluginHost.invoke(tool_call)
        apply TOOL_RESULT guardrail
        emit tool.call.completed
        context.add(tool result)
      persist RunState
    else: break
  emit run.completed(max iterations)
```

**职责**：通用工具调用循环。
**实现**：Core 内置（`AgentRuntime.run()`）。

---

## 3. Core 的 2 个插槽

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
```

**职责**：
- `ToolRegistry`：工具（世界↔语言适配器）
- `ContextManager`：知识（语言空间内容）

---

## 4. 什么能改 Core？

**Core 冻结（ADR-017）**，只能因三种原因改：

### 4.1 扩"插座"（新增枚举成员）

```typescript
// 可以：新增 EventType 成员
enum EventType {
  // ... 现有成员
  LlmThinking = 'llm.thinking',  // ← 新增
}

// 可以：新增 HookType 成员
enum HookType {
  // ... 现有成员
  BeforeSession = 'before_session',  // ← 新增
}

// 可以：新增 GuardrailStage 成员
enum GuardrailStage {
  // ... 现有成员
  Session = 'session',  // ← 新增
}
```

**要求**：写新 ADR。

### 4.2 修 loop 级 bug

- 竞态条件
- 内存泄漏
- 安全漏洞

**要求**：写新 ADR。

### 4.3 横切需求（先证明无法用 Plugin/Hook/Guardrail/事件/工具表示）

**要求**：
1. 先尝试用 Plugin/Hook/Guardrail/事件/工具解决
2. 证明不可行
3. 写新 ADR
4. 两人 Review

**状态**：尚无已知的此类需求（ADR-015）。

---

## 5. 什么不能改 Core？

### 5.1 功能增长

```
❌ 给 Core 加新功能
✅ 用 Plugin/MCP/Skill 实现
```

### 5.2 新增接口

```
❌ 给 Core 加新接口
✅ 用 Plugin 注册工具/钩子/护栏
```

### 5.3 工具显示

```
❌ 在 Core 定义工具怎么显示
✅ 在 TUI 层定义 ToolDisplayDefinition（ADR-021）
```

### 5.4 状态追踪

```
❌ 在 Core 追踪思考/等待状态
✅ 在 TUI 层实现 StateTracker（ADR-022）
```

### 5.5 配置扩展

```
❌ 在 Core 定义配置格式
✅ 在 Config 层定义
```

---

## 6. 改 Core 前的 Checklist

```
[ ] 我能用 Plugin + PluginHost.registerTool/registerHook 实现吗？
[ ] 我能用 MCP server + bridge plugin 实现吗？
[ ] 我能用 Skill（Markdown + BeforeLlm Hook）实现吗？
[ ] 我能用 Guardrail（四阶段）实现吗？
[ ] 我能用事件（新增或现有 EventType）实现吗？
→ 任一为"是" → 不进 core。
→ 全"否" → 写 ADR，两人 Review。
```

---

## 7. 扩展路径速查

| 需求 | 用什么 | 改 Core？ |
|------|--------|----------|
| 新工具 | Plugin + registerTool | ❌ |
| 新 Provider | Plugin + registerProvider | ❌ |
| 新护栏 | Plugin + registerGuardrail | ❌ |
| 新钩子 | Plugin + registerHook | ❌ |
| 新事件类型 | 新增 EventType 成员 | ⚠️ 需 ADR |
| 新 Skill | Markdown + skills-loader | ❌ |
| 新 MCP | MCP server + bridge plugin | ❌ |
| 工具显示 | TUI 层 ToolDisplayDefinition | ❌ |
| Spinner 状态 | TUI 层 StateTracker | ❌ |
| 新配置项 | Config 层 | ❌ |
| 新 CLI 命令 | CLI 层 | ❌ |

---

## 8. 文件位置

```
packages/core/src/
├── types/
│   ├── provider.ts        # LLMProvider, ChatRequest, LLMResponse
│   ├── tool.ts            # ToolRegistry, ToolDefinition, ToolHandler
│   ├── context.ts         # ContextManager
│   ├── event.ts           # EventStream, EventType, RunEvent
│   ├── guardrail.ts       # Guardrail, GuardrailStage
│   ├── hook.ts            # Hook, HookType
│   ├── session.ts         # SessionBackend, SessionInfo
│   ├── limits.ts          # UsageLimits, TerminationPolicy
│   └── index.ts           # 导出所有类型
├── runtime/
│   └── agent-runtime.ts   # AgentRuntime, tool-calling loop
└── index.ts               # 包入口
```

---

## 9. 相关文档

- [SPEC.md](SPEC.md) - 完整技术规范
- [ADR.md](ADR.md) - 架构决策记录
- [CLAUDE.md](../../CLAUDE.md) - AI 编码指南
- [tui.md](../api/tui.md) - TUI 接口文档
