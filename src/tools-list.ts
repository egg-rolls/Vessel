/**
 * `--tools` 的工具清单——不构造 AgentRuntime、不需要 API Key。
 *
 * 输出口径固定为 headless 口径：默认 3 个（bash / edit / read）；
 * `agent.enabled: true` 时额外列出 canonical `agent`（0.17）。
 * `ask_user` 仅在交互 REPL（TTY）或 gateway / serve 下注册（见 cli.ts / bootstrap.ts），
 * 因此一次性命令里不列出，由调用方在末尾注明。
 */

import {
  createAgentService,
  createAgentTool,
  createInProcessMemberRuntime,
} from '@vessel-agent/agent';
import { loadConfig, resolveTenantToolPolicy } from '../packages/config/src/index';
import { MemoryLLMProvider, MemoryPluginHost } from '../packages/core/src/index';
import { resolveAgentCwd } from './path-resolution';
import { buildPluginConfigMap, declarativePluginEntries, installWithConfig } from './plugin-config';
import { PluginLoader } from './plugin-loader';
import { resolvePluginSelection, warnExternalPluginsOnce } from './plugin-selection';
import { TenantToolHost } from './tenant-runtime-factory';

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
  // 0.18（DECISION-032 §1.5/§1.7）：`--tools` 与运行期同一过滤边界，
  // 插件工具与 agent 工具都走包装器。
  const host = new TenantToolHost(
    new MemoryPluginHost(),
    resolveTenantToolPolicy(config, tenantId),
  );
  for (const name of pluginNames) {
    const plugin = await loader.load(name);
    if (plugin) {
      await installWithConfig(plugin, host, pluginConfigs[plugin.name]);
    }
  }

  // `--tools` 是一次性只读命令：按 headless 口径；只有显式 agent.enabled 才列出
  // canonical agent。
  const agentEnabled = config.agent?.enabled === true;

  const pluginNamesWithFactories = [...pluginNames];
  if (agentEnabled) {
    // 只注册工具 schema；不 spawn 成员、不落 snapshot。
    const model = config.agent?.model ?? config.provider?.model ?? 'mock-model';
    const runtime = createInProcessMemberRuntime({
      providerFactory: () => new MemoryLLMProvider(),
      model,
      pluginHost: host,
    });
    const service = createAgentService({ tenantId, runtime, defaultModel: model });
    host.registerTool(createAgentTool(service, { ownerId: 'main' }));
    pluginNamesWithFactories.push('agent');
  }

  // 保持与运行时相同的注册顺序（能力工具 → agent），
  // 不要在这里单独按字母序排，否则 --tools 与 /tools、Web 会给出两种顺序。
  const tools = host.listTools().map((t) => ({ name: t.name, description: t.description }));

  return { tools, plugins: pluginNamesWithFactories, warnings };
}
