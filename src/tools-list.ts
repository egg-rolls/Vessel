/**
 * `--tools` 的工具清单——不构造 AgentRuntime、不需要 API Key。
 *
 * 输出口径固定为 headless 口径（4 个）：bash / edit / read / delegate_task。
 * `ask_user` 仅在「实际进入 REPL 且 stdin 是 TTY」时注册（见 cli.ts / bootstrap.ts），
 * 因此一次性命令里不列出，由调用方在末尾注明。
 */

import { loadConfig } from '../packages/config/src/index';
import { MemoryLLMProvider, MemoryPluginHost } from '../packages/core/src/index';
import { createDelegateTaskPlugin } from '../plugins/tools/delegate-task/src/index';
import { PluginLoader } from './plugin-loader';
import { resolvePluginNames } from './plugin-selection';

export interface ToolSummary {
  name: string;
  description: string;
}

export interface ToolsListing {
  tools: ToolSummary[];
  plugins: string[];
  warnings: string[];
}

/** 按当前配置加载插件并列出工具（只读，无副作用） */
export async function listTools(): Promise<ToolsListing> {
  const { config, validation } = await loadConfig();
  const warnings = [
    ...validation.warnings.map((w) => w.message),
    ...validation.errors.map((e) => e.message),
  ];

  const loader = new PluginLoader();
  const pluginNames = resolvePluginNames(loader, config.plugins, Boolean(process.env.VESSEL_DEBUG));

  const host = new MemoryPluginHost();
  for (const name of pluginNames) {
    const plugin = await loader.load(name);
    if (plugin) await plugin.install(host);
  }

  // delegate_task 是工厂式插件，需装配层注入 provider 工厂；列工具不会调用它。
  const pluginNamesWithFactories = [...pluginNames];
  if (config.delegate?.enabled !== false) {
    const delegate = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      model: config.delegate?.model ?? config.provider?.model ?? 'mock-model',
      maxDepth: config.delegate?.maxDepth,
      disallowed: config.delegate?.disallowed,
      limits: config.delegate?.limits,
      termination: config.delegate?.termination
        ? {
            maxIterations: config.delegate.termination.maxIterations ?? 10,
            maxRuntimeSeconds: config.delegate.termination.maxRuntimeSeconds,
          }
        : undefined,
    });
    await delegate.install(host);
    pluginNamesWithFactories.push(delegate.name);
  }

  const tools = host
    .listTools()
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { tools, plugins: pluginNamesWithFactories, warnings };
}
