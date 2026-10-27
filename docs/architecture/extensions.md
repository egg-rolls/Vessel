---
title: 扩展机制与插件发现
kind: current
triggers: [plugin, plugin host, loader, discovery, trust, external, mcp, skill, config]
paths: [packages/core/src/types/plugin.ts, src/plugin-loader.ts, src/plugin-selection.ts, plugins/**]
---

# 扩展机制与插件发现

<a id="plugin"></a>

### `Plugin` / `PluginHost`（`types/plugin.ts`）

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

<a id="extension-model"></a>

## 扩展模型

**一个机制：`Plugin` + `PluginHost`。** core 不为任何扩展类型新增接口。三类扩展内容：

| 类型 | 是什么 | 怎么投放 |
|---|---|---|
| **Plugin** | TypeScript 模块，自描述对象 | `plugins/<category>/<name>/`，见 [#discovery](#discovery) |
| **Skill** | 纯 markdown 文件 | **不是一条加载通道**——由前端读取，经 `RunOptions.messages` 作为消息注入（见 [runtime-api.md](runtime-api.md#messages)） |
| **Config** | YAML 声明 | 见 [config.md](config.md#config-model) |

插件能注册什么：**工具**（`registerTool`）、**Provider**（`registerProvider`）、**Guardrail**（`registerGuardrail`）、**Hook**（`registerHook`）。

**MCP**：`@vessel-agent/mcp-client` 是**插件**，不是 core 模块。配置 `mcp_servers` 后由 asm 装配层构造；工具经 `PluginHost.registerTool` 进入语言空间。stdio 与 HTTP（Streamable HTTP）两种传输；工具名默认 `mcp__<server>__<tool>`；权限默认 `ask`；单 server 失败不影响其他 server（ADR-039）。

<a id="discovery"></a>

## 插件发现

**唯一一套：运行时目录扫描**（`src/plugin-loader.ts`）。

```
plugins/
├── tools/basic-tools/       package.json + src/index.ts   → bash / read / edit
├── context/doc-subscription/→ @vessel-agent/doc-subscription（subscribe 工具 + BeforeLlm hook）
├── mcp/client/              → MCP client（工厂式；配置 mcp_servers 才构造）
├── evals/harness/           → @vessel-agent/evals（工厂式；asm 直接调用库，不注册工具）
├── im/feishu/               → @vessel-agent/feishu（工厂式；--feishu 才启动）
├── security/guardrail-pii/  → 输入输出 PII 脱敏
├── security/redact-secrets/ → 工具结果与输出里的密钥脱敏
├── security/tool-policy/    → ToolCall 阶段 allowlist / denylist
├── observability/hook-logging/
└── provider/{openai,anthropic}/
```

共 **11 个插件包**。规则：`plugins/<category>/<name>/package.json` + `src/index.ts` 存在即注册，**无需改代码、无需构建步骤**；`src/index.ts` 的默认导出须是 `Plugin`（含 `install()`）。目录形态不是 Plugin 的（例如默认导出是工厂函数、需要装配层注入依赖）列在 `FACTORY_PLUGINS` 里，由装配层自行构造——目前是 `mcp-client`、`evals` 与 `feishu`。MCP 要求至少一个 `mcp_servers` 条目；evals 由 CLI 直接调用；feishu 只有显式 `--feishu` 才启动。`PluginLoader` 的默认集与 `plugins:` 显式列表都会过滤它们。

`PluginLoader` 的接口：

```ts
class PluginLoader {
  list(): PluginDescriptor[];
  getProviders(): string[];         // category === 'provider'
  getAvailablePlugins(): string[];  // 排除 provider 与工厂式插件
  load(name: string): Promise<Plugin | null>;
}
```

**扫描只在进程启动时发生一次。** `PluginLoader` 把扫描结果缓存在实例上（插件目录在进程生命周期内视为不变），**这不是热加载**：新增或改动插件需要**重启进程**才生效，`/reload` 只重载配置、不重扫插件目录。用户 / 项目插件目录与 `plugins[].config` 注入见 `docs/versions/0.6.1.md`。

**来源与优先级**：默认扫描根为 `repo`（仓库 `plugins/`）→ `project`（`./.vessel/plugins`）→ `user`（`~/.vessel/plugins`）→ `node_modules`（仓库根与 cwd 的 `node_modules/@vessel-agent/*`，跳过非插件库包）。同名插件**先出现者胜出**，因此仓库覆盖项目、项目覆盖用户。

**默认集与信任边界**：`plugins` 配置缺省时，默认集加载全部可用插件——包括 project / user / node_modules 来源的外部插件。启动时由 `bootstrap` / `--tools` / `doctor` 向 **stderr** 打印一次外部插件告警（数量、名称、来源），告警不进入 stdout / JSON。设置 `VESSEL_NO_EXTERNAL_PLUGINS=1`（或 `true`）后，默认集只加载 `source === 'repo'` 的插件；显式 `plugins:` 列表仍可加载指定外部插件（显式即信任）。外部插件以完整进程权限运行，且早于任何工具权限判定，因此 **P0-3 只做到缓解（MITIGATED），不是已关闭的信任边界**；不可信仓库应使用 opt-out。

**加能力就是放一个文件夹。** `bash` 工具在，写文件 + 跑命令本身就是模型能做的事——这就是不再需要「声明式工具」「用户目录工具扫描」「运行时注册表」的原因。

