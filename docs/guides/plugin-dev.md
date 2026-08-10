# 插件 / 工具开发指南

> 面向开发 Vessel 工具和插件的开发者。**接口契约见 [CORE.md](../api/CORE.md)；决策历史见 [ADR.md](../specs/ADR.md)。**

## 插件模型

Vessel 的能力全部通过 Plugin 注入（ADR-004）。`Plugin.install(host)` 用 `host` 的统一 `register*` 方法注册工具 / Provider / 护栏 / 钩子：

| 方法 | 用途 |
|------|------|
| `host.registerTool(def)` | 注册工具 |
| `host.registerProvider(name, factory)` | 注册 Provider 工厂 |
| `host.registerGuardrail(guardrail)` | 注册安全守卫 |
| `host.registerHook(hook)` | 注册生命周期钩子 |

## 工具注册（构建时扫描，ADR-028）

**内置工具**：放进 `plugins/{category}/{name}/` 目录（含 `package.json` + `src/index.ts`），**构建时自动扫描注册**——`bun run discover` 扫描 `plugins/*/*/package.json` 生成 `src/plugin-registry.generated.ts`。**加工具不需要手改任何注册表**，放对目录即生效。

**用户工具**（`~/.vessel/tools/` 放文件 或 `vessel.yaml` 声明，见 #95）：运行时扫描加载，同样即放即用。

## 工具定义（自描述对象，ADR-026）

工具是**自描述对象**——权限 / 暂停 / 显示 / 条件启用都写在工具自己身上，core 只负责调用：

```ts
import type { ToolDefinition } from '@vessel/core';

const helloTool: ToolDefinition = {
  name: 'hello',
  description: 'Say hello',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  handler: async (args) => `Hello, ${(args as { name: string }).name}!`,
};
```

### 自描述字段（全可选，按需声明）

| 字段 | 用途 |
|------|------|
| `interactive?: boolean` | 需要暂停等用户输入（配合 `ctx.events.waitFor`） |
| `checkPermission?(input, ctx)` | 执行时权限判定，返回 `'allow' \| 'deny' \| 'ask'` |
| `render?(input)` | 自定义显示数据（默认 TUI 模板渲染，与 ADR-021 调和） |
| `isEnabled?(): boolean` | 条件启用（依赖 / 平台 / 环境） |
| `shouldDefer?: boolean` | 延迟加载（tool_reference，预留） |

**普通工具不要硬补字段**——没有交互就不写 `interactive`，没有特殊显示就不写 `render`。字段只加在有真实价值的地方。

## 工具上下文（ToolContext）

handler 的第 2 个参数 `ctx`：

```ts
interface ToolContext {
  run_id: string;
  session_id?: string;
  messages: Message[];
  events: EventStream;   // ADR-026/027：发事件、等事件
}
```

## 事件流交互（交互工具，ADR-027/029）

需要**暂停等用户**的工具：`interactive: true`，handler 里发请求事件 → 等回复事件：

```ts
const askTool: ToolDefinition = {
  name: 'ask_city',
  description: 'Ask the user to pick a city',
  inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
  interactive: true,
  handler: async (args, ctx) => {
    const requestId = crypto.randomUUID();
    ctx.events.publish('ask.city.requested', { requestId, question: args.question });
    // 等 TUI 订阅 → 展示 → 用户作答 → 发 ask.city.answered
    const data = (await ctx.events.waitFor('ask.city.answered', {
      requestId,            // 防多实例串台
      timeout: 60_000,      // 无订阅者(如 headless)时超时抛错 → 工具返回错误兜底
    })) as { answer: string };
    return data.answer;
  },
};
```

**事件名约定**：`<domain>.<action>.<event>`，如 `ask.city.requested` / `ask.city.answered`。事件名开放（ADR-027），无需改 core。

### 事件声明规范（ADR-030）

**全部事件用开放字符串协议，不定义事件常量**——直接写字符串字面量，零 import、零耦合。

- 发布 / 订阅都用字符串：`publish('replay.started', data)` / `subscribe('replay.started', handler)`
- **不要定义 `EventType` / `PermissionEvent` 等常量**——那是已废弃写法（ADR-030 舍弃，杜绝二义）
- 命名空间约定 `<domain>.<action>.<event>` 防撞名
- 拼写错误靠**集成测试**兜底（断言"发布 X 后订阅者收到"），不靠常量挡

## 权限（ADR-029）

- **危险工具**：自带 `checkPermission`，返回 `'allow' | 'deny' | 'ask'`。
- **普通工具**：不声明，由 **runtime 默认策略**统一判定（app 层交互模式 `'ask'` / headless `'allow'`，见 [CORE.md §1.10](../api/CORE.md)）。
- `'ask'` 时 runtime 发 `tool.permission.request` → 等 `tool.permission.response`；用户选 Always 则记住跳过。

```ts
const dangerousTool: ToolDefinition = {
  name: 'rm_all',
  description: 'Remove everything (dangerous)',
  inputSchema: { type: 'object', properties: {} },
  checkPermission: async () => 'ask',   // 每次执行都要用户确认
  handler: async () => 'done',
};
```

## 最小插件

```ts
import type { Plugin } from '@vessel/core';
import { helloTool } from './hello-tool';

const myPlugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  install(host: import('@vessel/core').PluginHost) {
    host.registerTool(helloTool);
  },
};

export default myPlugin;
```

## 目录结构

```
plugins/{category}/{name}/
├── package.json
├── src/
│   └── index.ts          # Plugin default export
└── __tests__/
    └── {name}.test.ts
```

## 测试

```ts
import { describe, expect, it } from 'bun:test';
import { MemoryEventStream, MemoryPluginHost } from '@vessel/core';
import myPlugin from '../src/index';

it('registers the tool', () => {
  const host = new MemoryPluginHost();
  myPlugin.install(host);
  expect(host.listTools().map((t) => t.name)).toContain('hello');
});

it('calls the tool with an eventful context', async () => {
  const host = new MemoryPluginHost();
  myPlugin.install(host);
  const tool = host.getTool('hello');
  // ToolContext 需要 events——用 new MemoryEventStream() 提供
  const result = await tool!.handler({ name: 'Vessel' }, {
    run_id: 'r1',
    messages: [],
    events: new MemoryEventStream(),
  });
  expect(result).toBe('Hello, Vessel!');
});
```

交互工具的测试：mock 一个订阅者，收到请求事件后 `publish` 回复事件，断言 handler 返回（参考 `packages/tui/__tests__/ask-user.test.ts`）。
