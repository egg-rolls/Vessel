# @vessel/core 接口契约（CORE）

> **目标**：快速了解 Core 有什么、什么能改、什么不能改——**接口契约**。
> **详细设计**：见 [SPEC.md](../specs/SPEC.md)；**决策历史**：见 [ADR.md](../specs/ADR.md)；**事件系统**：见 [EVENT-SYSTEM.md](EVENT-SYSTEM.md)。
> **核心原则**：Core 冻结（ADR-017），功能增长走 Plugin/MCP/Skill。
> **本文件只定义接口/能力**；写工具/插件的开发者指南见 [plugin-dev.md](../guides/plugin-dev.md)。

---

## 快速使用

### AgentRuntime.create

```typescript
import { AgentRuntime } from '@vessel/core';

const runtime = await AgentRuntime.create({
  provider,      // LLMProvider — LLM 提供者
  model,         // string — 模型名
  tools,         // ToolRegistry — 工具注册表
  context,       // ContextManager — 上下文管理器
  events,        // EventStream — 事件流
  limits,        // UsageLimits — 使用量限制
  termination,   // TerminationPolicy — 终止策略
  plugins,       // Plugin[] — 插件列表（可选）
  session,       // SessionBackend — 会话后端（可选）
  systemPrompt,  // string — 系统提示词（可选）
  permission,    // RuntimePermissionConfig — 默认权限策略（可选，ADR-029）
});

// 执行一次对话
const response = await runtime.run('你好');
```

### 内置实现（MemoryXxx 系列）

| 类 | 用途 |
|----|------|
| `MemoryLLMProvider` | 测试用 LLM Provider |
| `MemoryToolRegistry` | 内存工具注册表 |
| `MemoryContextManager` | 内存上下文管理 |
| `MemoryEventStream` | 内存事件流 |
| `MemorySessionBackend` | 内存会话存储 |
| `MemoryPluginHost` | 内存插件宿主 |
| `MemoryLimitChecker` | 内存限制检查 |

### 持久化实现

| 类 | 用途 |
|----|------|
| `SQLiteSessionBackend` | SQLite 会话存储 |
| `FileSessionBackend` | 文件会话存储 |

### Provider 实现

| 类 | 用途 |
|----|------|
| `OpenAICompatibleProvider` | OpenAI 兼容 API |
| `AnthropicProvider` | Anthropic API |

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
  get(name: string): ToolDefinition | undefined
  has(name: string): boolean
  list(): ToolDefinition[]
}

// ADR-026：工具是自描述对象——权限/暂停/显示/条件启用下沉到工具节点
interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
  handler: ToolHandler
  timeout?: number
  default?: boolean
  // ── 自描述字段（全可选，向后兼容）──
  interactive?: boolean                 // 需要暂停等用户输入（用 ctx.events.waitFor 等回复事件）
  checkPermission?(input, ctx): Promise<'allow' | 'deny' | 'ask'>  // 执行时权限判定
  render?(input): unknown               // 自定义显示数据（默认 TUI 模板，与 ADR-021 调和）
  isEnabled?(): boolean                 // 条件启用
  shouldDefer?: boolean                 // 延迟加载（tool_reference，预留）
}

type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<string>

interface ToolContext {
  run_id: string
  session_id?: string
  messages: Message[]
  events: EventStream    // ADR-026/027：工具可发事件、等事件，实现交互暂停
}
```

**职责**：适配器注册目录（世界↔语言）。
**实现**：Core 内置注册表；装配层（`src/plugin-registry.ts`）负责发现插件/工具，注册后 runtime 统一从 `pluginHost` 取工具。

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
// ADR-027：事件名 + payload 开放——插件可发布任意字符串事件名，无需改 core
interface EventStream {
  subscribe(handler: (e: RunEvent) => void): Unsubscribe
  publish(e: RunEvent): void
  clear(): void
  getHistory(runId?: string): RunEvent[]
  // ADR-027：等待一次匹配事件（工具交互暂停原语）
  waitFor(name: string, opts?: { requestId?: string; timeout?: number }): Promise<unknown>
}

interface RunEvent {
  type: string                       // 事件名即开放字符串协议（ADR-027/030），无事件常量
  run_id: string
  data: EventPayload | Record<string, unknown>
  ts: number
}
```

**职责**：语言空间的运行轨迹（trace/replay/TUI 共用）；组件间交流总线（工具 ↔ TUI 事件流交互）。
**实现**：Core 内置（`MemoryEventStream`）。
**详细**：事件声明规范、事件名约定与协作模式见 [EVENT-SYSTEM.md](EVENT-SYSTEM.md)。

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

### 1.10 Permission（工具权限）

```typescript
// ADR-029：未声明 checkPermission 的工具由 runtime 默认策略判定
interface RuntimePermissionConfig {
  default?: 'allow' | 'ask'   // 默认 'allow'；app 层显式开启 'ask'（交互确认）
  autoApprove?: string[]       // 免确认工具名列表
}
// AgentRuntimeOptions.permission?: RuntimePermissionConfig
```

**职责**：工具执行的权限判定（core 统一判定，不依赖 TUI）。
**规则**（agent-runtime tool-calling loop 内）：
- 工具自带 `checkPermission` → 用其判定
- 未声明 → 默认策略：`default === 'ask'`（且非 autoApprove / 未记住）→ 发 `tool.permission.request` 事件 → `waitFor('tool.permission.response')` 等用户 allow/deny；否则放行
- `'allow'` → 执行；`'deny'` → 阻止；`'ask'` → 事件流确认
- 用户选"Always"（`remember: true`）→ 记入 `permissionApproved`，后续跳过确认

**实现**：Core 内置（`agent-runtime.ts` tool-calling loop）。

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
        resolve permission       # tool.checkPermission 或默认策略；'ask' → 事件流等用户（ADR-029）
        emit tool.call.started
        result = pluginHost.invoke(tool_call)   # handler 内可用 ctx.events 发/等事件
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
// 事件类型已开放（ADR-027）：插件可发布任意字符串事件名，无需改 core、无需 ADR。
// 只能扩以下两个枚举：

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
[ ] 我能用事件（开放字符串协议，ADR-030）实现吗？
→ 任一为"是" → 不进 core。
→ 全"否" → 写 ADR，两人 Review。
```

---

## 相关文档

- [SPEC.md](../specs/SPEC.md) - 完整技术规范
- [ADR.md](../specs/ADR.md) - 架构决策记录
- [EVENT-SYSTEM.md](EVENT-SYSTEM.md) - 事件流系统接口
- [tui.md](tui.md) - TUI 接口文档
- [plugin-dev.md](../guides/plugin-dev.md) - 工具/插件开发指南
