/**
 * 插件选择策略——bootstrap 与 `--tools` 共用，避免两处默认集漂移。
 */

import type { PluginConfig } from '../packages/config/src/index';
import type { PluginLoader } from './plugin-loader';

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
  const names =
    enabled.length > 0
      ? enabled.map((p) => p.name)
      : loader.getAvailablePlugins().filter((name) => name !== 'hook-logging');

  if (debug && !names.includes('hook-logging')) {
    names.push('hook-logging');
  }
  return names;
}
