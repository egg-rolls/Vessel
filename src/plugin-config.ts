/**
 * 插件安装配置与成员宿主（0.6.1 E1/E10）。
 *
 * - E1：把 `plugins[].config` 透传到 `install(host, { config })`。core 的类型在
 *   0.6.1 才扩展为可选第二参，这里用窄局部 cast，保证与旧签名兼容。
 * - 声明式 `guardrails:` / `hooks:`（0.6.1）：条目名即插件名，config 合并到该插件的
 *   安装配置；显式 `plugins:` 项优先。
 * - E10：团队成员宿主**优先**复用 ext 导出的 `buildChildHost`（剔除 `team_*` 工具）；
 *   当前 ext 尚未导出该符号时，按同一规则本地兜底（合并后自动切换）。
 *
 * @module vessel/plugin-config
 */

import type {
  GuardrailConfig,
  HookConfig,
  PluginConfig,
  VesselConfig,
} from '../packages/config/src/index';
import { MemoryPluginHost, type Plugin, type PluginHost } from '../packages/core/src/index';
import * as teamPluginModule from '../plugins/tools/team/src/index';

/** core 0.6.1 的 install 形状；旧签名只用第一个参数也能工作 */
export type PluginInstallOptions = { config?: Record<string, unknown> };
type InstallWithOptions = (
  host: PluginHost,
  options?: PluginInstallOptions,
) => void | Promise<void>;

/** 团队成员宿主要剔除的工具前缀 */
const TEAM_TOOL_PREFIX = 'team_';

/** 调用插件 install，并透传配置（无配置时保持旧调用形状） */
export function installWithConfig(
  plugin: Plugin,
  host: PluginHost,
  config: Record<string, unknown> | undefined,
): void | Promise<void> {
  const install = plugin.install as InstallWithOptions;
  return config === undefined ? install.call(plugin, host) : install.call(plugin, host, { config });
}

/**
 * 返回一个把安装配置绑定到 `install(host)` 的插件包装。
 * 不修改原对象（加载器对模块有缓存，避免跨 tenant 泄漏配置）。
 */
export function withPluginConfig(
  plugin: Plugin,
  config: Record<string, unknown> | undefined,
): Plugin {
  if (config === undefined) return plugin;
  return {
    name: plugin.name,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    ...(plugin.description !== undefined ? { description: plugin.description } : {}),
    install: (host) => installWithConfig(plugin, host, config),
  };
}

/** 把声明式 guardrails / hooks 条目映射为插件配置（按 name 去重合并） */
export function declarativePluginEntries(config: VesselConfig): PluginConfig[] {
  const merged = new Map<string, PluginConfig>();

  const add = (entry: GuardrailConfig | HookConfig): void => {
    if (typeof entry.name !== 'string' || entry.name.trim() === '') return;
    const name = entry.name.trim();
    const existing = merged.get(name);
    if (!existing) {
      merged.set(name, {
        name,
        ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
        ...(entry.config !== undefined ? { config: { ...entry.config } } : {}),
      });
      return;
    }
    merged.set(name, {
      ...existing,
      // 任一条目显式 false 即停用；否则保持启用。
      ...(entry.enabled === false || existing.enabled === false ? { enabled: false } : {}),
      ...(entry.config !== undefined
        ? { config: { ...(existing.config ?? {}), ...entry.config } }
        : {}),
    });
  };

  for (const entry of config.guardrails ?? []) add(entry);
  for (const entry of config.hooks ?? []) add(entry);

  return [...merged.values()];
}

/**
 * 取某插件的安装配置：显式 `plugins[].config` 覆盖声明式条目；都没有返回 undefined。
 */
export function pluginConfigFor(
  name: string,
  configured: PluginConfig[] | undefined,
  declarative: PluginConfig[] = [],
): Record<string, unknown> | undefined {
  const explicit = configured?.find((entry) => entry.name === name);
  const declared = declarative.find((entry) => entry.name === name);
  const config: Record<string, unknown> = {
    ...(declared?.config ?? {}),
    ...(explicit?.config ?? {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * 团队成员插件宿主：优先使用 ext 导出的 `buildChildHost`；未导出时按相同规则兜底。
 * 成员不能继续调用 team_*，避免无限扩张。
 */
export function buildTeamMemberHost(host: PluginHost): PluginHost {
  const exported = (teamPluginModule as { buildChildHost?: (value: PluginHost) => PluginHost })
    .buildChildHost;
  if (typeof exported === 'function') return exported(host);

  const child = new MemoryPluginHost();
  for (const guardrail of host.getGuardrails()) child.registerGuardrail(guardrail);
  for (const hook of host.getHooks()) child.registerHook(hook);
  for (const tool of host.listTools()) {
    if (tool.name.startsWith(TEAM_TOOL_PREFIX)) continue;
    child.registerTool(tool);
  }
  return child;
}
