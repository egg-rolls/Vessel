# @vessel/core API 参考

> 公开 API 文档。面向插件开发者和嵌入使用者。
> 接口完整定义见 [docs/specs/SPEC.md](../specs/SPEC.md)。

## 核心类

### AgentRuntime

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
});

// 执行一次对话
const response = await runtime.run('你好');
```

### MemoryPluginHost

```typescript
import { MemoryPluginHost } from '@vessel/core';

const host = new MemoryPluginHost();
host.registerTool(toolDef);
host.registerProvider('openai', factory);
host.registerGuardrail(guardrail);
host.registerHook(hook);
```

## 内置实现（MemoryXxx 系列）

| 类 | 用途 |
|----|------|
| `MemoryLLMProvider` | 测试用 LLM Provider |
| `MemoryToolRegistry` | 内存工具注册表 |
| `MemoryContextManager` | 内存上下文管理 |
| `MemoryEventStream` | 内存事件流 |
| `MemorySessionBackend` | 内存会话存储 |
| `MemoryPluginHost` | 内存插件宿主 |
| `MemoryLimitChecker` | 内存限制检查 |

## 持久化实现

| 类 | 用途 |
|----|------|
| `SQLiteSessionBackend` | SQLite 会话存储 |
| `FileSessionBackend` | 文件会话存储 |

## Provider 实现

| 类 | 用途 |
|----|------|
| `OpenAICompatibleProvider` | OpenAI 兼容 API |
| `AnthropicProvider` | Anthropic API |

## 类型（Type Exports）

### Plugin

```typescript
interface Plugin {
  name: string;
  version?: string;
  description?: string;
  install(host: PluginHost): void | Promise<void>;
}
```

### PluginHost

```typescript
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

### LLMProvider

```typescript
interface LLMProvider {
  chat(req: ChatRequest): Promise<LLMResponse>;
}
```

### ToolDefinition

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<string>;
  timeout?: number;
  default?: boolean;
}
```

### EventType（枚举）

```typescript
enum EventType {
  RunStarted, LlmRequest, LlmResponse,
  ToolCallStarted, ToolCallCompleted, ToolCallFailed,
  GuardrailBlocked, GuardrailModified,
  RunCompleted, RunFailed,
  SessionCreated, SessionLoaded, Error,
}
```

### Guardrail

```typescript
interface Guardrail {
  name: string;
  stage: GuardrailStage; // Input | Output | ToolCall | ToolResult
  check(value: unknown, ctx: GuardrailContext): Promise<GuardrailResult>;
  priority?: number;
}
```

### Hook

```typescript
interface Hook {
  name: string;
  type: HookType; // BeforeLlm | AfterLlm | BeforeTool | AfterTool | OnError
  run(ctx: HookContext): Promise<HookContext | null>;
  priority?: number;
}
```
