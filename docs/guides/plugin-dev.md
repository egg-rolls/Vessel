# 插件开发指南

## 插件模型

Vessel 的能力全部通过 Plugin 注入（ADR-004）。`Plugin.install(host)` 用 `host` 的统一 `register*` 方法注册。

已注册 12 个插件（`src/cli.ts` 的 `PLUGIN_IMPORT_MAP`），默认加载 10 个。

## 快速开始

### 最小插件

```ts
import type { Plugin, PluginHost } from '@vessel/core';

const myPlugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  install(host: PluginHost): void {
    host.registerTool({
      name: 'hello',
      description: 'Say hello',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      handler: async (args) => `Hello, ${(args as { name: string }).name}!`,
    });
  },
};

export default myPlugin;
```

### 所有可用上下文

插件可以调用：

| 方法 | 用途 | 受支持的上下文 |
|------|------|---------------|
| `host.registerTool(def)` | 注册新工具 | ✅ |
| `host.registerProvider(name, factory)` | 注册 Provider 工厂 | ✅ |
| `host.registerGuardrail(guardrail)` | 注册安全守卫 | ✅ |
| `host.registerHook(hook)` | 注册生命周期钩子 | ✅ |

### Provider 插件

**Provider 插件现在是薄工厂**（ADR-019，P1）：从 `@vessel/core` 导入核心 provider 类，并使用 provider 预设注册工厂。

```ts
import { OpenAICompatibleProvider } from '@vessel/core';

const plugin: Plugin = {
  name: 'provider-openai',
  install(host: PluginHost) {
    host.registerProvider('openai', (config) =>
      new OpenAICompatibleProvider({
        api_key: config.api_key as string,
        base_url: config.base_url as string ?? 'https://api.openai.com/v1',
        model: config.model as string ?? 'gpt-4',
      })
    );
    // 也可以注册更多名称
    host.registerProvider('google', (config) =>
      new OpenAICompatibleProvider({
        api_key: config.api_key as string,
        base_url: config.base_url as string ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: config.model as string ?? 'gemini-pro',
      })
    );
  },
};
```

**规则**：
- OpenAI 兼容的 provider 全部用一个插件注册多个名称。
- Anthropic 用 `AnthropicProvider`（核心版本，不是插件版本）。
- **不要写自己的 LLMProvider 类**——核心版本拥有完整的流式传输、工具调用和 `on_chunk` 支持，而插件版本不具备这些。

### 配置约定

- 插件从 `host` 获取配置：`host.registerProvider('name', (config: Record<string, unknown>) => ...)`。
- 使用可选的 `config?: unknown` 参数传递配置：`install(host, config)`。
- 插件需要支持零配置启动——没有外部依赖的情况也能工作。

### 目录结构

```
plugins/{category}/{name}/
├── package.json
├── src/
│   └── index.ts          # Plugin default export
└── __tests__/
    └── {name}.test.ts    # 安装验证 + 功能测试
```

### 插件加载

在 `src/cli.ts` 的 `PLUGIN_IMPORT_MAP` 中添加插件后即可加载。用户可以在 `vessel.yaml` 中通过 `plugins[].name` 按需加载。
