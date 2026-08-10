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
  permission,    // RuntimePermissionConfig — 默认权限策略（可选，ADR-029）
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
// ADR-026：工具是自描述对象——权限/暂停/显示/条件启用下沉到工具节点
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<string>;
  timeout?: number;
  default?: boolean;
  // ── 自描述字段（全可选，向后兼容）──
  interactive?: boolean;                                    // 需要暂停等用户输入
  checkPermission?(input: unknown, ctx: ToolContext): Promise<'allow' | 'deny' | 'ask'>;
  render?(input: unknown): unknown;                         // 自定义显示数据
  isEnabled?(): boolean;                                    // 条件启用
  shouldDefer?: boolean;                                    // 延迟加载（预留）
}

interface ToolContext {
  run_id: string;
  session_id?: string;
  messages: Message[];
  events: EventStream;   // ADR-026/027：工具可发事件、等事件（waitFor）
}
```

### 事件名（开放字符串协议，ADR-030）

```typescript
// ADR-030：事件名一律为开放字符串字面量，无常量/枚举。
// 核心事件名（供参考）：
//   'run.started'            RunStartedPayload
//   'llm.request'            LlmRequestPayload
//   'llm.response'           LlmResponsePayload
//   'llm.stream.chunk'       LlmStreamChunkPayload
//   'tool.call.started'      ToolCallStartedPayload
//   'tool.call.completed'    ToolCallCompletedPayload
//   'tool.call.failed'       ToolCallFailedPayload
//   'guardrail.blocked'      GuardrailBlockedPayload
//   'guardrail.modified'     GuardrailModifiedPayload
//   'run.completed'          RunCompletedPayload
//   'run.failed'             RunFailedPayload
//   'session.created' / 'session.loaded' / 'error'
// 插件可发布任意自定义字符串事件名，无需改 core。
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
