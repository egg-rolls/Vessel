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
 * ⚠ 完整 opt-in 列表陷阱（金丝雀 issue-0）：`plugins:` 一旦出现就是**完整**启用清单，不是
 * 「在默认集上追加/覆盖」。只想改某个内置插件的配置（如 web-tools 的 always_register）而写
 * `plugins: [{name: web-tools, ...}]`，会把其余内置插件（basic-tools 的 bash/read/edit/write 等）
 * 全部排除——热应用会据此从活体节点剥离这些工具。要保留内置工具，须把它们一并列入 `plugins:`，
 * 或干脆不写 `plugins:`（走默认集）、仅用该插件自身的配置键。引擎注册表与成员工具面已对齐到
 * 同一轮边界（见 cli.ts tools applier 的 retain 同步），剥离不再产生「被广告却执行不了」的窗口。
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

  let external: PluginDescriptor[] = [];

  if (configured === undefined) {
    // 默认集：排除调试插件、工厂式插件与 opt-in 插件；opt-out 时只保留仓库内插件。
    // 0.43：child 插件（体验插件）由宿主 spawn，不进入 in-process 装载名单。
    // 0.52：OPT_IN_PLUGINS（media）默认不加载——必须由 config.yaml 的 plugins: 显式启用。
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
    external = defaults.filter((descriptor) => descriptor.source !== 'repo');
  } else {
    for (const entry of configured) {
      if (entry.enabled === false) continue;
      selected.set(canonicalName(entry.name), entry);
    }
  }

  // 显式 plugins 项是最终裁决：
  // - 显式 enabled:true 不被声明式 enabled:false 关掉；
  // - 显式 enabled:false 不被声明式条目重新启用。
  const explicitlyEnabled = new Set(
    (configured ?? [])
      .filter((entry) => entry.enabled !== false)
      .map((entry) => canonicalName(entry.name)),
  );
  const explicitlyDisabled = new Set(
    (configured ?? [])
      .filter((entry) => entry.enabled === false)
      .map((entry) => canonicalName(entry.name)),
  );

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
