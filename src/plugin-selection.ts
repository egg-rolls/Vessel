/**
 * 插件选择策略——bootstrap 与 `--tools` 共用，避免两处默认集漂移。
 */

import type { PluginConfig } from '../packages/config/src/index';
import { FACTORY_PLUGINS, type PluginLoader } from './plugin-loader';

/**
 * 解析要加载的插件名：
 * - 配置了 `plugins:` → 只用显式启用项；
 * - 否则用全部可用插件，默认排除 `hook-logging`（仅调试时启用）。
 */
export function resolvePluginNames(
  loader: PluginLoader,
  configured: PluginConfig[] | undefined,
  debug: boolean,
): string[] {
  const enabled = configured?.filter((p) => p.enabled !== false) ?? [];
  // 工厂式插件（delegate-task / team）由 bootstrap 按专用配置显式构造，
  // 不能经 PluginLoader 加载（delegate-task 的 default 是工厂函数，team 的 default 是空插件）。
  const names =
    enabled.length > 0
      ? enabled.map((p) => p.name).filter((name) => !FACTORY_PLUGINS.has(name))
      : loader
          .getAvailablePlugins()
          .filter((name) => name !== 'hook-logging' && !FACTORY_PLUGINS.has(name));

  if (debug && !names.includes('hook-logging')) {
    names.push('hook-logging');
  }
  return names;
}
