/**
 * `--tools` 的工具清单——不构造 AgentRuntime、不需要 API Key。
 *
 * 输出口径固定为 headless 口径（4 个）：bash / edit / read / delegate_task。
 * `ask_user` 仅在「实际进入 REPL 且 stdin 是 TTY」时注册（见 cli.ts / bootstrap.ts），
 * 因此一次性命令里不列出，由调用方在末尾注明。
 */

import { loadConfig } from '../packages/config/src/index';
import {
  createRuntime,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
} from '../packages/core/src/index';
import { createDelegateTaskPlugin } from '../plugins/tools/delegate-task/src/index';
import { createTeamPlugin } from '../plugins/tools/team/src/index';
import { resolveAgentCwd } from './path-resolution';
import { buildPluginConfigMap, declarativePluginEntries, installWithConfig } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';

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
  const { config, validation, tenantId } = await loadConfig();
  const warnings = [
    ...validation.warnings.map((w) => w.message),
    ...validation.errors.map((e) => e.message),
  ];

  const loader = new PluginLoader();
  const declarative = declarativePluginEntries(config);
  const selection = resolvePluginSelection(
    loader,
    config.plugins,
    Boolean(process.env.VESSEL_DEBUG),
    declarative,
  );
  // 告警只走 stderr，不进入 stdout / 返回的 warnings（JSON 输出保持干净）。
  warnExternalPluginsOnce(selection.external);
  const pluginNames = selection.names;

  const pluginConfigs = buildPluginConfigMap(config.plugins, declarative, resolveAgentCwd(config));
  const host = new MemoryPluginHost();
  for (const name of pluginNames) {
    const plugin = await loader.load(name);
    if (plugin) {
      await installWithConfig(plugin, host, pluginConfigs[plugin.name]);
    }
  }

  // delegate_task 是工厂式插件，需装配层注入 provider 工厂；列工具不会调用它。
  const pluginNamesWithFactories = [...pluginNames];
  if (config.delegate?.enabled !== false) {
    const delegate = createDelegateTaskPlugin({
      providerFactory: () => new MemoryLLMProvider(),
      tenantId,
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
      // `--tools` 是一次性命令，无 TUI 应答者：按 headless 口径 allow。
      permissionMode: config.delegate?.permissionMode ?? 'allow',
      readOnlyTools: config.delegate?.readOnlyTools,
    });
    await delegate.install(host);
    pluginNamesWithFactories.push(delegate.name);
  }

  // team 原型同样必须显式 opt-in；启用后 `--tools` 会多出 5 个 team_* 工具。
  if (config.team?.enabled === true) {
    // ext 0.3：team 必须注入 core RuntimeHost（插件不再自带内嵌 Host）。
    const teamHost = await createRuntime({ pluginHost: host });
    try {
      const team = createTeamPlugin({
        providerFactory: () => new MemoryLLMProvider(),
        tenantId,
        model: config.team.model ?? config.provider?.model ?? 'mock-model',
        events: new MemoryEventStream(),
        host: teamHost,
        ownerId: config.team.ownerId,
        memberLimits: config.team.memberLimits,
        memberTermination: config.team.memberTermination
          ? {
              maxIterations: config.team.memberTermination.maxIterations ?? 10,
              maxRuntimeSeconds: config.team.memberTermination.maxRuntimeSeconds,
            }
          : undefined,
      });
      await team.install(host);
      pluginNamesWithFactories.push(team.name);
    } finally {
      await teamHost.close();
    }
  }

  // 保持与运行时相同的注册顺序（能力工具 → delegate_task → team_*），
  // 不要在这里单独按字母序排，否则 --tools 与 /tools、Web 会给出两种顺序。
  const tools = host.listTools().map((t) => ({ name: t.name, description: t.description }));

  return { tools, plugins: pluginNamesWithFactories, warnings };
}
