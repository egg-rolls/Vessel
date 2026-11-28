/**
 * 插件读面共享工厂（bootstrap P0；architecture-block-bootstrap-design §5）。
 *
 * 两表面同源：cli 网络面（gatewayOptions.plugins / pluginCatalog）与 bootstrap
 * 本地面（localDispatcher opts.plugins / pluginCatalog）共用本工厂，消灭手写
 * plugins() 与 cli 闭包的双份漂移（H3）。实现 = cli.ts 三闭包
 * （pluginRuntimeEntries / bundlePluginEntries / pluginCatalog）的纯移动 + 参数化：
 * liveConfig → getConfig()、gatewayBundle → input 字段；child 行映射、去重顺序
 * （bundle 先、runtime 后，mergePluginList 首见优先）、factoryPluginDisplayEnabled
 * 门控、settingsFingerprint 逐字保留。
 *
 * 契约边界（设计 §5.4）：装配层拥有清单——serve 只把 contributions / metadata
 * 合并进基础行（mergePluginList），不自动造行；catalog 的 lifecycle / surfaces /
 * pendingRestart 原料也只有装配层给得全。
 *
 * @module vessel/plugin-surface
 */

import type { PluginExposeConfig, VesselConfig } from '../../packages/config/src/index';
import type { PluginSurfaceKind } from '../../packages/core/src/index';
import {
  buildPluginCatalog,
  type PluginCatalogItem,
  type PluginHostManager,
} from '../../packages/serve/src/index';
import { factoryPluginDisplayEnabled, pluginEntryEnabled } from './plugin-config';
import { pluginSettingsFor } from './plugin-host-assembly';
import { derivePluginLifecycle, type PluginLifecycle } from './plugin-lifecycle';
import { FACTORY_PLUGINS, type PluginLoader } from './plugin-loader';

export interface PluginSurfaceInput {
  loader: Pick<PluginLoader, 'list' | 'getChildMods'>;
  /** bundle.plugins（启动装载名单；provider / 工厂不经此路径） */
  loadedPlugins: ReadonlyArray<{ name: string }>;
  /** registerInProcessPlugins 返回的已登记 in-process 能力插件基础行 */
  inProcessRows: ReadonlyArray<{ name: string; enabled: boolean }>;
  manager: Pick<PluginHostManager, 'statuses' | 'httpSurfaceDisabled'> | undefined;
  /** cli: () => liveConfig；bootstrap: () => liveConfigRef.current（活配置，两表面同源） */
  getConfig: () => VesselConfig;
  /** pendingRestart 的已生效基线（bundle.config，启动态） */
  startupConfig: VesselConfig;
  /** install 期实际登记的注册面（bundle.pluginSurfaces） */
  surfaces: ReadonlyMap<string, ReadonlySet<PluginSurfaceKind>>;
  /** reloader.pendingInProcessRestart（代码面待重启差异） */
  pendingInProcessRestart: () => ReadonlySet<string>;
}

export interface PluginSurface {
  /** plugins.list 基础行：bundle 行 + in-process 行 + 显式 disabled 行 + 发现未装载行 + child runtime 行 */
  entries(): Array<{
    name: string;
    enabled: boolean;
    version?: string;
    mode?: string;
    status?: string;
  }>;
  /** plugins.catalog 单视图（lifecycle / pendingRestart / expose / httpSurfaceDisabled） */
  catalog(): PluginCatalogItem[];
}

export function createPluginSurface(input: PluginSurfaceInput): PluginSurface {
  // 0.43：`plugins.list` / `plugin.changed` 的 base 列表要含体验型 child 插件；
  // 贡献字段由 gateway 与 manager.contributionsFor 合并。E10：附带
  // version / mode / status（serve 的 plugins 选项类型仍是 {name,enabled}，
  // 子类型可结构兼容，不额外造类型）。
  const pluginRuntimeEntries = (): Array<{
    name: string;
    enabled: boolean;
    version?: string;
    mode?: string;
    status?: string;
  }> => {
    const descriptors = new Map(
      input.loader.getChildMods().map((descriptor) => [descriptor.name, descriptor]),
    );
    return (
      input.manager?.statuses().map((status) => {
        const descriptor = descriptors.get(status.id);
        return {
          name: status.id,
          enabled: status.enabled,
          ...(descriptor !== undefined
            ? { version: descriptor.version, mode: descriptor.mode }
            : {}),
          status: status.status,
        };
      }) ?? []
    );
  };

  // 0.47：单执行面的 plugins 数据源（与 gateway `plugins` 同源）。
  const bundlePluginEntries = (): Array<{ name: string; enabled: boolean }> => {
    const liveConfig = input.getConfig();
    // q-plugin-lifecycle §6.2 R1：enabled 统一读 liveConfig 的共享判定
    // （pluginEntryEnabled，覆盖层语义），不再硬编码 true / 读启动 config ——
    // 热 disable / 热装载后面板如实翻转（读写联动见 tools applier 的登记态同步）。
    const loaded = new Set(input.loadedPlugins.map((plugin) => plugin.name));
    const listed = input.loadedPlugins.map((plugin) => ({
      name: plugin.name,
      enabled: pluginEntryEnabled(liveConfig.plugins, plugin.name),
    }));
    // P1-w2d：已登记 in-process 能力插件补基础行（provider 类不在 bundle.plugins），
    // 否则 plugins.list 的 contributions 没有行可合并（契约 §1）；按 name 去重。
    for (const row of input.inProcessRows) {
      if (!loaded.has(row.name)) {
        listed.push({
          name: row.name,
          enabled: pluginEntryEnabled(liveConfig.plugins, row.name),
        });
        loaded.add(row.name);
      }
    }
    // 配置里显式 disabled 的插件不加载，但仍要出现在 plugins.list 中（读 liveConfig）。
    for (const configured of liveConfig.plugins ?? []) {
      if (configured.enabled === false && !loaded.has(configured.name)) {
        listed.push({ name: configured.name, enabled: false });
        loaded.add(configured.name);
      }
    }
    // 0.56.1：发现但未装载的插件也补基础行（否则面板/catalog 完全不可见——
    // catalog 缺行即跳过）。工厂式按实际装配门控标注（与 CLI 列表共用
    // factoryPluginDisplayEnabled，读 liveConfig）；其余未装载（opt-out / debug 门控 /
    // 加载失败）显示关。child 行由 manager.statuses() 提供，不在此补。
    for (const descriptor of input.loader.list()) {
      if (loaded.has(descriptor.name) || descriptor.mode === 'child') continue;
      listed.push({
        name: descriptor.name,
        enabled:
          FACTORY_PLUGINS.has(descriptor.name) &&
          factoryPluginDisplayEnabled(liveConfig, descriptor.name),
      });
      loaded.add(descriptor.name);
    }
    return listed;
  };
  const entries = (): Array<{
    name: string;
    enabled: boolean;
    version?: string;
    mode?: string;
    status?: string;
  }> => [...bundlePluginEntries(), ...pluginRuntimeEntries()];

  // 0.47：catalog 单视图；descriptor 是发现结果（全局），status 只按 entry 名查找。
  // 0.48 M4：注入 config `expose` 与 manager 的 surface 级冲突状态。
  // q-plugin-lifecycle §6.1/§6.2：注入 per-capability lifecycle（宿主审计推导）与
  // pendingRestart（期望态 ≠ 已生效态 且该面 restart 的差异汇聚）。
  const settingsFingerprint = (settings: Record<string, unknown>): string =>
    JSON.stringify(
      Object.keys(settings)
        .sort()
        .map((key) => [key, settings[key]]),
    );
  const catalog = (): PluginCatalogItem[] => {
    const liveConfig = input.getConfig();
    const expose = new Map<string, PluginExposeConfig>();
    for (const plugin of liveConfig.plugins ?? []) {
      if (plugin.expose !== undefined) expose.set(plugin.name, plugin.expose);
    }
    const httpSurfaceDisabled = input.manager?.httpSurfaceDisabled() === true;
    const descriptors = input.loader.list();
    const startupConfig = input.startupConfig;
    const codePending = input.pendingInProcessRestart();
    const lifecycle = new Map<string, PluginLifecycle>();
    const pendingRestart = new Map<string, boolean>();
    for (const descriptor of descriptors) {
      const profile = derivePluginLifecycle({
        name: descriptor.name,
        mode: descriptor.mode,
        surfaces: input.surfaces.get(descriptor.name),
        isFactory: FACTORY_PLUGINS.has(descriptor.name),
        category: descriptor.category,
        declared: (descriptor.manifest ?? descriptor.capabilityManifest)?.lifecycle,
        // child settings 热应用已接线（§6.5 P2）：settingsFor 读 liveConfig + settings
        // 值进 reload 指纹 → 子进程重激活，child settings 转热。
        childSettingsHot: true,
      });
      lifecycle.set(descriptor.name, profile);
      // pendingRestart：只在该面 lifecycle 为 restart 时，期望态 ≠ 已生效态才算。
      let pending = false;
      if (profile.toggle === 'restart') {
        // restart 类启停的已生效态 = 启动态（注册面不热翻）；期望态 = liveConfig。
        const desired = pluginEntryEnabled(liveConfig.plugins, descriptor.name);
        const effective = pluginEntryEnabled(startupConfig.plugins, descriptor.name);
        if (desired !== effective) pending = true;
      }
      if (profile.settings === 'restart') {
        const desired = settingsFingerprint(pluginSettingsFor(liveConfig, descriptor.name));
        const applied = settingsFingerprint(pluginSettingsFor(startupConfig, descriptor.name));
        if (desired !== applied) pending = true;
      }
      if (profile.code === 'restart' && codePending.has(descriptor.name)) pending = true;
      pendingRestart.set(descriptor.name, pending);
    }
    return buildPluginCatalog({
      entries: entries(),
      descriptors: new Map(descriptors.map((descriptor) => [descriptor.name, descriptor])),
      statuses: input.manager?.statuses() ?? [],
      lifecycle,
      pendingRestart,
      ...(expose.size > 0 ? { expose } : {}),
      ...(httpSurfaceDisabled ? { httpSurfaceDisabled } : {}),
    });
  };

  return { entries, catalog };
}
