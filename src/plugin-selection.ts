/**
 * 插件选择策略——bootstrap 与 `--tools` 共用，避免两处默认集漂移。
 *
 * 语义（0.7.1）：
 * - `plugins` 缺省（undefined）→ 全部非仓库插件也加载（默认信任模型，见下）；
 * - `VESSEL_NO_EXTERNAL_PLUGINS=1|true` 时，默认集只选 `source === 'repo'`；
 * - `plugins` 出现（含空数组）→ 不回退默认集，只加载显式启用项；
 *   显式列表即信任，opt-out 不影响显式指定的外部插件；
 * - 全为 `enabled:false` → 为空，绝不回退为「全部插件」；
 * - 声明式 `guardrails:` / `hooks:` 条目按插件名追加（本身即显式 opt-in）；
 * - 显式 `plugins` 项的 `enabled` 是最终裁决：`false` 不能被声明式条目重新启用。
 *
 * 默认集里的外部插件（project / user / node_modules）会在启动时告警一次：
 * 它们以完整进程权限运行，不可信仓库应显式 opt-out。
 */

import type { PluginConfig } from '../packages/config/src/index';
import { FACTORY_PLUGINS, type PluginDescriptor, type PluginLoader } from './plugin-loader';

/** 选择结果 */
export interface PluginSelection {
  /** 要加载的插件名（工厂式插件已排除） */
  names: string[];
  /**
   * 默认选中集里的外部插件（source !== 'repo'），用于启动告警。
   * 显式 `plugins:` / 声明式条目指定的外部插件视为已信任，不计入。
   */
  external: PluginDescriptor[];
}

/** `VESSEL_NO_EXTERNAL_PLUGINS` 是否为真（1 / true，大小写不敏感） */
export function externalPluginsDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.VESSEL_NO_EXTERNAL_PLUGINS ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * 解析要加载的插件，并返回默认集中的外部插件。
 * @param declarative 由 `declarativePluginEntries(config)` 产出的声明式条目
 */
export function resolvePluginSelection(
  loader: PluginLoader,
  configured: PluginConfig[] | undefined,
  debug: boolean,
  declarative: PluginConfig[] = [],
  env: Record<string, string | undefined> = process.env,
): PluginSelection {
  const selected = new Map<string, PluginConfig>();
  const descriptors = loader.list();
  const noExternal = externalPluginsDisabled(env);

  let external: PluginDescriptor[] = [];

  if (configured === undefined) {
    // 默认集：排除调试插件与工厂式插件；opt-out 时只保留仓库内插件。
    const defaults = descriptors.filter(
      (descriptor) =>
        descriptor.category !== 'provider' &&
        !FACTORY_PLUGINS.has(descriptor.name) &&
        descriptor.name !== 'hook-logging' &&
        (!noExternal || descriptor.source === 'repo'),
    );
    for (const descriptor of defaults) {
      selected.set(descriptor.name, { name: descriptor.name });
    }
    external = defaults.filter((descriptor) => descriptor.source !== 'repo');
  } else {
    for (const entry of configured) {
      if (entry.enabled === false) continue;
      selected.set(entry.name, entry);
    }
  }

  // 显式 plugins 项是最终裁决：
  // - 显式 enabled:true 不被声明式 enabled:false 关掉；
  // - 显式 enabled:false 不被声明式条目重新启用。
  const explicitlyEnabled = new Set(
    (configured ?? []).filter((entry) => entry.enabled !== false).map((entry) => entry.name),
  );
  const explicitlyDisabled = new Set(
    (configured ?? []).filter((entry) => entry.enabled === false).map((entry) => entry.name),
  );

  // 声明式 guardrails/hooks：按名字启用或停用。
  for (const entry of declarative) {
    if (FACTORY_PLUGINS.has(entry.name)) continue;
    if (entry.enabled === false) {
      if (!explicitlyEnabled.has(entry.name)) selected.delete(entry.name);
      continue;
    }
    if (explicitlyDisabled.has(entry.name)) continue;
    if (!selected.has(entry.name)) selected.set(entry.name, entry);
  }

  if (debug) {
    selected.set('hook-logging', { name: 'hook-logging', enabled: true });
  }

  // 工厂式插件由 bootstrap 按专用配置显式构造，不能经 PluginLoader 加载。
  return {
    names: [...selected.keys()].filter((name) => !FACTORY_PLUGINS.has(name)),
    external,
  };
}

/**
 * 解析要加载的插件名（兼容旧调用点）。
 * @param declarative 由 `declarativePluginEntries(config)` 产出的声明式条目
 */
export function resolvePluginNames(
  loader: PluginLoader,
  configured: PluginConfig[] | undefined,
  debug: boolean,
  declarative: PluginConfig[] = [],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return resolvePluginSelection(loader, configured, debug, declarative, env).names;
}

/** 生成外部插件启动告警；没有外部插件时返回 null。 */
export function formatExternalPluginWarning(external: PluginDescriptor[]): string | null {
  if (external.length === 0) return null;

  const bySource = new Map<string, string[]>();
  for (const descriptor of external) {
    const names = bySource.get(descriptor.source) ?? [];
    names.push(descriptor.name);
    bySource.set(descriptor.source, names);
  }
  const detail = [...bySource.entries()]
    .map(([source, names]) => `${source}: ${names.join(', ')}`)
    .join('; ');

  return (
    `⚠ Loaded ${external.length} external plugin(s) (${detail}). ` +
    'External plugins run with full process privileges; set VESSEL_NO_EXTERNAL_PLUGINS=1 ' +
    'in untrusted repositories.'
  );
}

let externalWarningEmitted = false;

/**
 * 进程内只打印一次外部插件告警（stderr）。
 * @returns 本次是否真的打印了
 */
export function warnExternalPluginsOnce(
  external: PluginDescriptor[],
  write: (message: string) => void = (message) => console.error(message),
): boolean {
  const warning = formatExternalPluginWarning(external);
  if (!warning || externalWarningEmitted) return false;
  externalWarningEmitted = true;
  write(warning);
  return true;
}

/** 测试用：重置 once 状态 */
export function resetExternalPluginWarningForTests(): void {
  externalWarningEmitted = false;
}
