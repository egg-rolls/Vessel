/**
 * 插件选择策略——bootstrap 与 `--tools` 共用，避免两处默认集漂移。
 *
 * 语义（0.6.1）：
 * - `plugins` 缺省（undefined）→ 全部可用插件，默认排除 `hook-logging`；
 * - `plugins` 出现（含空数组）→ 不回退默认集，只加载显式启用项；
 * - 全为 `enabled:false` → 为空，绝不回退为「全部插件」；
 * - 声明式 `guardrails:` / `hooks:` 条目按插件名追加（本身即显式 opt-in）；
 * - 显式 `plugins` 项的 `enabled` 是最终裁决：`false` 不能被声明式条目重新启用。
 */

import type { PluginConfig } from '../packages/config/src/index';
import { FACTORY_PLUGINS, type PluginLoader } from './plugin-loader';

/**
 * 解析要加载的插件名。
 * @param declarative 由 `declarativePluginEntries(config)` 产出的声明式条目
 */
export function resolvePluginNames(
  loader: PluginLoader,
  configured: PluginConfig[] | undefined,
  debug: boolean,
  declarative: PluginConfig[] = [],
): string[] {
  const selected = new Map<string, PluginConfig>();

  if (configured === undefined) {
    // 默认集：排除调试插件与工厂式插件。
    for (const name of loader.getAvailablePlugins()) {
      if (name === 'hook-logging' || FACTORY_PLUGINS.has(name)) continue;
      selected.set(name, { name });
    }
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
  return [...selected.keys()].filter((name) => !FACTORY_PLUGINS.has(name));
}
