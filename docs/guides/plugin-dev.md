# 插件开发指南

## 插件模型

Vessel 的能力全部通过 Plugin 注入（ADR-004）。一个插件就是一个 `Plugin` 接口的实现。

## 快速开始

### 最小插件

```typescript
import type { Plugin, PluginHost } from '@vessel/core';

const myPlugin: Plugin = {
  name: 'my-plugin',
  version: '1.0.0',
  description: '我的第一个插件',

  install(host: PluginHost): void {
    // 注册工具
    host.registerTool({
      name: 'hello',
      description: 'Say hello',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      handler: async (args) => {
        const { name } = args as { name: string };
        return `Hello, ${name}!`;
      },
    });
  },
};
```

### 添加到项目

1. 在 `plugins/` 下建目录：
   ```
   plugins/my-plugin/
   ├── package.json
   └── src/
       └── index.ts
   ```

2. `package.json`：
   ```json
   {
     "name": "@vessel/my-plugin",
     "version": "1.0.0",
     "main": "src/index.ts",
     "dependencies": { "@vessel/core": "workspace:*" }
   }
   ```

3. 在 `start.ts` 或 `cli.ts` 中加载：
   ```typescript
   import { myPlugin } from './plugins/my-plugin/src/index';
   const plugins = [myPlugin];
   ```

## 四种扩展能力

通过 `PluginHost` 可注册四种能力：

| 能力 | 方法 | 用途 |
|------|------|------|
| Tool | `host.registerTool(def)` | 给 Agent 增加工具能力 |
| Provider | `host.registerProvider(name, factory)` | 增加 LLM Provider |
| Guardrail | `host.registerGuardrail(g)` | 增加安全检查 |
| Hook | `host.registerHook(h)` | 在 LLM/tool 调用前后注入逻辑 |

### 注册 Guardrail

```typescript
host.registerGuardrail({
  name: 'pii-detector',
  stage: GuardrailStage.Output,
  priority: 10,
  check: async (value, ctx) => {
    if (containsPII(value as string)) {
      return { allowed: false, reason: '输出包含 PII' };
    }
    return { allowed: true };
  },
});
```

### 注册 Hook

```typescript
host.registerHook({
  name: 'logging',
  type: HookType.AfterLlm,
  priority: 100,
  run: async (ctx) => {
    console.log(`[Hook] LLM 调用完成: run_id=${ctx.run_id}`);
    return ctx;
  },
});
```

## 参考实现

| 插件 | 说明 | 路径 |
|------|------|------|
| provider-openai | OpenAI 兼容 Provider | `plugins/provider-openai/src/index.ts` |
| file-ops | 文件操作工具 | `plugins/file-ops/src/index.ts` |
| guardrail-pii | PII 检测 | `plugins/guardrail-pii/src/index.ts` |
| meta-tools | 自管理工具 | `plugins/meta-tools/src/index.ts` |
| skills-loader | Skill 加载器 | `plugins/skills-loader/src/index.ts` |

## 规则

- 插件包放在 `plugins/` 目录下
- 包名以 `@vessel/` 为前缀
- 不直接调用 LLM API（用 Provider 接口）
- 测试不依赖外部服务
- 参考 [docs/specs/PLUGINS.md](../specs/PLUGINS.md) 查看已有和规划的插件
