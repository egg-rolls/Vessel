/**
 * 插件选择策略——bootstrap 与 `--tools` 共用，避免两处默认集漂移。
 *
 * 语义（0.56.1 翻转，用户裁定「安装的插件默认开启」，main 批准方案 B）：
 * - **覆盖层语义**：默认集（全部已安装的 in-process 能力插件）恒为底，
 *   `plugins:` 条目只做覆盖，不再是「完整启用清单」：
 *   - 条目 `enabled: false` → 排除（显式关永远优先）；
 *   - 条目列入（enabled true / 缺省）→ 显式启用，可救回默认集之外的插件
 *     （hook-logging、被 opt-out 挡下的外部插件等）；显式列表即信任，
 *     opt-out 不影响显式指定的外部插件；
 *   - 未列入 → 走默认集（**新装插件不配置即装载**）。
 * - `plugins: []` = 无覆盖 = 完整默认集（旧语义是空集，破坏点见下）；
 * - 默认集排除项（结构性，非「用户装的插件」语义范畴）：provider 类（专用装配）、
 *   FACTORY_PLUGINS（bootstrap 按专用配置构造）、hook-logging（VESSEL_DEBUG 门控）、
 *   child（宿主 spawn，不进 in-process 名单）；OPT_IN_PLUGINS 现为空集（media 已转默认）；
 * - `VESSEL_NO_EXTERNAL_PLUGINS=1|true` 时，默认集只选 `source === 'repo'`；
 * - 声明式 `guardrails:` / `hooks:` 条目按插件名追加（本身即显式 opt-in）；
 * - 显式 `plugins` 项的 `enabled` 是最终裁决：`false` 不能被声明式条目重新启用。
 *
 * ⚠ 旧契约（≤0.56.0，金丝雀 issue-0）已推翻：`plugins:` 一旦出现曾是**完整**启用清单，
 * 写部分清单会把其余内置插件全部排除（热应用据此从活体节点剥离工具）。覆盖层语义下
 * 部分清单只覆盖所列条目，issue-0 陷阱随之消失。**存量配置行为变化**：靠部分清单刻意
 * 只开少数插件的配置，现在会开启完整默认集，须用 `enabled: false` 显式关——金丝雀重点
 * 回归项。`vessel plugin enable|disable` 不再物化全量清单（只写目标单条），新装插件
 * 不会再被物化清单静默排除。引擎注册表与成员工具面的轮边界原子收敛（cli.ts tools
 * applier 的 retain 同步）不受影响：剥离仍只发生在显式 enabled:false / 声明式停用时。
 *
 * 默认集里的外部插件（project / user / node_modules）会在启动时告警一次：
 * 它们以完整进程权限运行，不可信仓库应显式 opt-out。
 */

import type { PluginConfig } from '../../packages/config/src/index';
import {
  FACTORY_PLUGINS,
  OPT_IN_PLUGINS,
  type PluginDescriptor,
  type PluginLoader,
  pluginAliasMap,
} from './plugin-loader';

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
  // 兼容别名归一（金丝雀终验 issue-①）：规范名 = 清单 id（skills），旧包短名
  // （plugin-skills）是别名。config 按任一种拼写书写都归一到规范名再选择，
  // 与 loader.load / pluginConfigs[plugin.name] / pluginEnabledInConfig 同一口径。
  const aliases = pluginAliasMap(descriptors);
  const canonicalName = (name: string): string => aliases.get(name) ?? name;

  // 显式条目（覆盖层）先归一：enabled:false 排除；列入 = 显式启用（最终裁决）。
  const explicitlyEnabled = new Set<string>();
  const explicitlyDisabled = new Set<string>();
  for (const entry of configured ?? []) {
    const name = canonicalName(entry.name);
    if (entry.enabled === false) explicitlyDisabled.add(name);
    else explicitlyEnabled.add(name);
  }

  // 默认集（恒为底）：排除调试插件、工厂式插件与 opt-in 插件（现为空集）；
  // opt-out 时只保留仓库内插件。
  // 0.43：child 插件（体验插件）由宿主 spawn，不进入 in-process 装载名单。
  // 0.56.1：media 已转默认（OPT_IN_PLUGINS 清空）——装的插件默认开启。
  const defaults = descriptors.filter(
    (descriptor) =>
      descriptor.mode === 'in-process' &&
      descriptor.category !== 'provider' &&
      !FACTORY_PLUGINS.has(descriptor.name) &&
      !OPT_IN_PLUGINS.has(descriptor.name) &&
      descriptor.name !== 'hook-logging' &&
      (!noExternal || descriptor.source === 'repo'),
  );
  for (const descriptor of defaults) {
    selected.set(descriptor.name, { name: descriptor.name });
  }
  // 显式列入的外部插件视为已信任，不计入启动告警（旧契约保留）。
  const external = defaults.filter(
    (descriptor) => descriptor.source !== 'repo' && !explicitlyEnabled.has(descriptor.name),
  );

  // 覆盖：显式 enabled:false 从默认集移除；列入条目带自身 config 覆盖默认条目。
  // 未列入的插件保持默认集成员身份——新装插件不配置即装载。
  for (const entry of configured ?? []) {
    const name = canonicalName(entry.name);
    if (entry.enabled === false) selected.delete(name);
    else selected.set(name, entry);
  }

  // 声明式 guardrails/hooks：按名字启用或停用。
  for (const entry of declarative) {
    const name = canonicalName(entry.name);
    if (FACTORY_PLUGINS.has(name)) continue;
    if (entry.enabled === false) {
      if (!explicitlyEnabled.has(name)) selected.delete(name);
      continue;
    }
    if (explicitlyDisabled.has(name)) continue;
    if (!selected.has(name)) selected.set(name, entry);
  }

  if (debug) {
    selected.set('hook-logging', { name: 'hook-logging', enabled: true });
  }

  // 工厂式插件由 bootstrap 按专用配置显式构造，不能经 PluginLoader 加载。
  // child 插件即使被显式写进 plugins: 也不走 in-process 装载。
  const modeByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor.mode]));
  return {
    names: [...selected.keys()].filter(
      (name) => !FACTORY_PLUGINS.has(name) && modeByName.get(name) !== 'child',
    ),
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
