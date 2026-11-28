/**
 * 体验型 plugin 宿主装配（0.43）。
 *
 * 把 loader 发现的 child descriptor + `plugins[]` 配置映射成 serve 的
 * `PluginHostManager`；gateway 只消费窄接口 `PluginHostManagerLike`。
 *
 * Multi-tenant v1：只用 default tenant 的配置 / settings；非默认 tenant 的
 * 体验型 plugin 激活留给后续切片（不静默混用别的 tenant 配置）。
 *
 * @module vessel/plugin-host-assembly
 */

import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import type { Logger, Plugin } from '../../packages/core/src/index';
import {
  PluginHostManager,
  type PluginHostManagerOptions,
  type PluginReloadResult,
  resolvePluginHttpLimits,
  type PluginDescriptor as ServePluginDescriptor,
} from '../../packages/serve/src/index';
import { pluginEntryEnabled } from './plugin-config';
import type { PluginDescriptor as LoaderPluginDescriptor, PluginLoader } from './plugin-loader';
import type { PluginManifest } from './plugin-manifest';

export interface PluginHostAssemblyOptions {
  /** 默认 tenant 的插件扫描器（`result.bundle.pluginLoader`） */
  loader: Pick<PluginLoader, 'getChildMods'>;
  /** 活配置；`plugins[].config` 即该 plugin 的 settings */
  config: VesselConfig;
  /**
   * 读取当前活配置（可选）。提供时 `expose` 授权随 reload / config watcher 变化；
   * 缺省回退到 `config`（启动快照）。
   */
  getConfig?: () => VesselConfig;
  /** `<dataDir>`；plugin 私有目录为 `<dataDir>/plugins/<id>` */
  dataDir: string;
  logger?: Logger;
  /**
   * settings 解析（单执行面）。缺省只用 `config.plugins[].config`。
   * q-plugin-lifecycle §6.5 P2：gateway 注入读 liveConfig 的实现，子进程重激活拿新值；
   * 本地模式仍用启动 config（其执行面 config 不热重读，语义不变）。
   */
  settingsFor?: (id: string) => Record<string, unknown>;
  /** 探针可覆盖子进程可执行文件 */
  execPath?: string;
  timeouts?: PluginHostManagerOptions['timeouts'];
}

/** `plugins[]` 里某 plugin 的 settings；缺省空对象 */
export function pluginSettingsFor(config: VesselConfig, id: string): Record<string, unknown> {
  const entry = config.plugins?.find((candidate) => candidate.name === id);
  return entry?.config !== undefined ? { ...entry.config } : {};
}

/** `plugins[]` 里某 plugin 的启用状态；缺省 true（覆盖层语义，与 CLI 列表共用判定） */
function pluginEnabledInConfig(config: VesselConfig, id: string): boolean {
  return pluginEntryEnabled(config.plugins, id);
}

/** loader child descriptor → serve 宿主描述（title 等展示字段补默认值） */
function toServeDescriptor(
  descriptor: LoaderPluginDescriptor,
  config: VesselConfig,
): ServePluginDescriptor {
  const manifest = descriptor.manifest;
  if (manifest === undefined) {
    throw new Error(`child plugin "${descriptor.name}" has no manifest`);
  }
  return manifestToServeDescriptor(descriptor, manifest, config);
}

/**
 * loader descriptor + 清单 → serve 宿主描述。child（manifest）与 in-process
 * （capabilityManifest）共用同一映射；运行模式差异由调用方决定。
 */
function manifestToServeDescriptor(
  descriptor: LoaderPluginDescriptor,
  manifest: PluginManifest,
  config: VesselConfig,
): ServePluginDescriptor {
  const pluginDir = descriptor.dir;
  const uiDir = manifest.ui !== undefined ? path.resolve(pluginDir, manifest.ui.dir) : undefined;
  // plugin-embed 契约 §1/§3：embed 声明与 trust_ui 确认透传给 manager 计算信任态。
  const uiEmbed = manifest.ui?.embed;
  const trustUi = config.plugins?.find((candidate) => candidate.name === manifest.id)?.trust_ui;
  const contributes = manifest.contributes ?? {};
  // 0.48 M1：manifest 已校验 http 声明（含宿主保留路由）；serve 侧再做一次
  // 结构复检 + 限额收紧 + 跨插件冲突判定。
  const http = manifest.contributes?.http;

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    side: manifest.side,
    entry: descriptor.entry,
    pluginDir,
    ...(uiDir !== undefined ? { uiDir } : {}),
    ...(uiEmbed !== undefined ? { uiEmbed } : {}),
    ...(trustUi !== undefined ? { trustUi } : {}),
    activationEvents: manifest.activationEvents,
    // 内置插件（repo 源）可信；外部插件默认只能 auth: required。
    builtin: descriptor.source === 'repo',
    contributes: {
      ...(contributes.navGroups !== undefined ? { navGroups: contributes.navGroups } : {}),
      ...(contributes.i18n !== undefined ? { i18n: contributes.i18n } : {}),
      ...(contributes.pages !== undefined
        ? {
            pages: contributes.pages.map((page) => ({
              id: page.id,
              title: page.title ?? page.id,
              ...(page.titleKey !== undefined ? { titleKey: page.titleKey } : {}),
              ...(page.nav !== undefined ? { nav: page.nav } : {}),
              ...(page.icon !== undefined ? { icon: page.icon } : {}),
              ...(page.order !== undefined ? { order: page.order } : {}),
              entry: page.entry,
              ...(page.component !== undefined ? { component: page.component } : {}),
            })),
          }
        : {}),
      ...(contributes.panels !== undefined
        ? {
            panels: contributes.panels.map((panel) => ({
              slot: panel.slot,
              id: panel.id,
              ...(panel.order !== undefined ? { order: panel.order } : {}),
              entry: panel.entry,
            })),
          }
        : {}),
      ...(contributes.toolbar !== undefined
        ? {
            toolbar: contributes.toolbar.map((item) => ({
              slot: item.slot,
              id: item.id,
              label: item.label,
              ...(item.titleKey !== undefined ? { titleKey: item.titleKey } : {}),
              ...(item.icon !== undefined ? { icon: item.icon } : {}),
              ...(item.order !== undefined ? { order: item.order } : {}),
              // TI5-2：通用 RPC 绑定菜单 additive 透传（loader readToolbarMenu 已
              // 校验形状；serve contributionsFor 同款条件透传进 plugins.list wire）。
              ...(item.menu !== undefined ? { menu: item.menu } : {}),
              // file-ref P3 additive：插件自持点击动作（loader readToolbar 已校验
              // 形状/互斥/ui.embed；serve 投影同款条件透传）。
              ...(item.action !== undefined ? { action: item.action } : {}),
            })),
          }
        : {}),
      ...(contributes.composer !== undefined
        ? {
            composer: contributes.composer.map((item) => ({
              slot: item.slot,
              ...(item.scheme !== undefined ? { scheme: item.scheme } : {}),
              ...(item.component !== undefined ? { component: item.component } : {}),
              ...(item.handler !== undefined ? { handler: item.handler } : {}),
              ...(item.order !== undefined ? { order: item.order } : {}),
            })),
          }
        : {}),
      ...(contributes.commands !== undefined
        ? {
            commands: contributes.commands.map((command) => ({
              name: command.name,
              title: command.title ?? command.name,
            })),
          }
        : {}),
      ...(contributes.rpc !== undefined
        ? {
            rpc: contributes.rpc.map((method) => ({
              name: method.name,
              ...(method.description !== undefined ? { description: method.description } : {}),
              ...(method.permission !== undefined ? { permission: method.permission } : {}),
            })),
          }
        : {}),
      ...(contributes.events !== undefined ? { events: contributes.events } : {}),
      ...(contributes.settings !== undefined ? { settings: contributes.settings } : {}),
      ...(http !== undefined ? { http } : {}),
    },
    permissions: manifest.permissions,
    dependencies: {
      plugins: manifest.dependencies.plugins,
      ordering: manifest.dependencies.ordering,
    },
    enabled: pluginEnabledInConfig(config, manifest.id),
    // q-plugin-lifecycle §6.5 P2：已解析 settings 值进描述符 → 进 reload 指纹。
    // config 由调用方传 liveConfig（reloader）/ 启动 config（manager），改 settings
    // 即指纹变 → 子进程重激活拿新 env。与 settingsFor 同源（pluginSettingsFor）。
    settings: pluginSettingsFor(config, manifest.id),
  };
}

/**
 * 构造 serve 宿主管理器。没有 child plugin 时也返回实例（空管理器，
 * gateway 的 `/plugins/*` 只会 404），调用方无需判断。
 */
export function createPluginHostManager(options: PluginHostAssemblyOptions): PluginHostManager {
  const descriptors = options.loader
    .getChildMods()
    .map((descriptor) => toServeDescriptor(descriptor, options.config));
  const logger = options.logger;
  return new PluginHostManager({
    // 0.48 M4：`plugins[].expose` 只做 allow/deny；builtin 由 descriptor 提供。
    exposeFor: (id) => {
      const config = options.getConfig?.() ?? options.config;
      return config.plugins?.find((plugin) => plugin.name === id)?.expose;
    },
    descriptors,
    dataDir: options.dataDir,
    // 懒激活（首次页面 / RPC 访问）时解析 settings；单执行面只用一份配置。
    settingsFor: (id) => options.settingsFor?.(id) ?? pluginSettingsFor(options.config, id),
    // 0.48 M1：serve.pluginHttp → 归一化宿主限额；manifest 只能收紧。
    httpLimits: resolvePluginHttpLimits(options.config.node?.pluginHttp),
    ...(logger !== undefined
      ? {
          logger: (level, message, meta) => {
            if (level === 'error') logger.error(message, meta);
            else logger.warn(message, meta);
          },
        }
      : {}),
    ...(options.execPath !== undefined ? { execPath: options.execPath } : {}),
    ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
  });
}

/**
 * model-registry D3：install 之后登记 in-process 能力插件的 RPC / 贡献面。
 *
 * 判据与 readPlugin 一致：package.json 声明 vessel 清单但无 entry → in-process
 * （descriptor.capabilityManifest）。child 插件仍走 createPluginHostManager 的
 * descriptor 路径，不经这里；未声明清单的 in-process 插件无贡献面，no-op。
 * handler 用插件自己的 `Plugin.rpc`（与 child dispatch 同形），经
 * manager.registerInProcess 进同一个 PluginRpcRegistry / canonical 名 / DTO 校验；
 * pages / navGroups / rpc 白名单由 contributionsFor 覆盖进 plugins.list。
 */
export function registerInProcessPlugin(options: {
  manager: PluginHostManager;
  descriptor: LoaderPluginDescriptor;
  plugin: Plugin;
  config: VesselConfig;
}): void {
  const { manager, descriptor, plugin, config } = options;
  if (descriptor.mode !== 'in-process') {
    throw new Error(`plugin "${descriptor.name}" is not in-process`);
  }
  const manifest = descriptor.capabilityManifest;
  if (manifest === undefined) return;
  const rpc = plugin.rpc;
  manager.registerInProcess(
    manifestToServeDescriptor(descriptor, manifest, config),
    typeof rpc === 'function' ? rpc.bind(plugin) : undefined,
  );
}

/**
 * 双路登记单实现（S8 / 332fd2e7 的收口）：wiring 收集的 provider 类能力插件
 * 与通用装载名单可能各持同一 descriptor/plugin（同 loader 缓存 + ESM 单实例）。
 * 按 name 去重只登记一次，否则第二次 manager.registerInProcess 抛
 * plugin_id_conflict，node 启动崩溃。
 *
 * 返回 plugins.list 基础行；enabled 与登记口径一致（config `plugins[].enabled`，
 * 缺省 true），不谎报 enabled。
 */
export function registerInProcessPluginEntries(options: {
  manager: PluginHostManager;
  entries: ReadonlyArray<{ descriptor: LoaderPluginDescriptor; plugin: Plugin }>;
  config: VesselConfig;
}): Array<{ name: string; enabled: boolean }> {
  const rows: Array<{ name: string; enabled: boolean }> = [];
  const seen = new Set<string>();
  for (const entry of options.entries) {
    if (seen.has(entry.descriptor.name)) continue;
    seen.add(entry.descriptor.name);
    registerInProcessPlugin({
      manager: options.manager,
      descriptor: entry.descriptor,
      plugin: entry.plugin,
      config: options.config,
    });
    const manifestId = entry.descriptor.capabilityManifest?.id ?? entry.descriptor.name;
    rows.push({
      name: entry.descriptor.name,
      enabled: pluginEnabledInConfig(options.config, manifestId),
    });
  }
  return rows;
}

/**
 * q-plugin-lifecycle §6.2 R1 读写联动：按活配置同步已登记 in-process 插件的
 * 登记态（enabled + RPC / 贡献面）。manager.enable/disable 是现成实现（此前零生产
 * 调用方），这里接线 —— 热 disable → 翻 enabled + 注销 RPC + 贡献面收口；enable 反之。
 * 读面随后读同一活配置同口径，四面一致。child 的启停由 manager.reload（enabled 进
 * 指纹）负责，不在此重复。
 *
 * bootstrap 顺手项（设计稿 §5.3.5）：自 cli tools applier 抽出的共享单实现——
 * cli 网络面与 bootstrap 本地面共消费同一函数（getConfig 各读自身活配置），
 * 消除双份漂移。逐行读 getConfig()（与 cli 原闭包逐行读 liveConfig 同语义）。
 */
export async function syncInProcessRegistrationState(options: {
  manager: PluginHostManager | undefined;
  rows: ReadonlyArray<{ name: string }>;
  getConfig: () => VesselConfig;
}): Promise<string[]> {
  const { manager, rows, getConfig } = options;
  if (manager === undefined) return [];
  const lines: string[] = [];
  const statusById = new Map(manager.statuses().map((status) => [status.id, status]));
  for (const row of rows) {
    const desired = pluginEntryEnabled(getConfig().plugins, row.name);
    const current = statusById.get(row.name)?.enabled;
    if (current === undefined || current === desired) continue;
    if (desired) {
      manager.enable(row.name);
      lines.push(`plugins: ${row.name} enabled`);
    } else {
      await manager.disable(row.name);
      lines.push(`plugins: ${row.name} disabled`);
    }
  }
  return lines;
}

/** 重新扫描的 loader 端口（`rescan()` 返回最新描述符） */
export interface PluginReloaderOptions {
  loader: Pick<PluginLoader, 'rescan' | 'list'>;
  manager: PluginHostManager;
  /** 每次 reload 读取当前活配置（enabled / settings / dependencies 可能已变） */
  getConfig: () => VesselConfig;
}

/** in-process 能力插件的 per-plugin 指纹（name → name@version:dir）。 */
function inProcessFingerprintMap(
  descriptors: readonly LoaderPluginDescriptor[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const descriptor of descriptors) {
    if (descriptor.mode !== 'in-process') continue;
    map.set(descriptor.name, `${descriptor.name}@${descriptor.version}:${descriptor.dir}`);
  }
  return map;
}

/** 共享插件重载器：child 热重载 + in-process 待重启追踪（q-plugin-lifecycle §6.2 R2）。 */
export interface PluginReloader {
  reload(): Promise<PluginReloadResult>;
  /**
   * in-process 插件中「磁盘指纹 ≠ 已生效（启动）指纹」的集合（新增 / 变更 / 移除）。
   * in-process 代码更新须重启（ESM 物理约束），故已生效基线恒为启动态，pending 持续到重启。
   * 这是 `restart_required` 真信号的 per-plugin 来源，供 catalog pendingRestart 汇聚。
   */
  pendingInProcessRestart(): ReadonlySet<string>;
}

/**
 * 创建共享 `reloadPlugins()`：`loader.rescan()` → 用当前配置重建 child
 * descriptor → `manager.reload(descriptors)`。
 *
 * 不重启进程；in-process 能力插件若发生变化，结果带 `restart_required`，
 * 不谎报已重载。pending 以**启动态**为已生效基线（不随 reload 清零），诚实持续到重启。
 */
export function createPluginReloader(options: PluginReloaderOptions): PluginReloader {
  const applied = inProcessFingerprintMap(options.loader.list());

  const pendingFrom = (descriptors: readonly LoaderPluginDescriptor[]): Set<string> => {
    const current = inProcessFingerprintMap(descriptors);
    const pending = new Set<string>();
    for (const [name, fingerprint] of applied) {
      if (current.get(name) !== fingerprint) pending.add(name);
    }
    for (const name of current.keys()) {
      if (!applied.has(name)) pending.add(name);
    }
    return pending;
  };

  return {
    pendingInProcessRestart: () => pendingFrom(options.loader.list()),
    async reload(): Promise<PluginReloadResult> {
      const descriptors = options.loader.rescan();
      const pending = pendingFrom(descriptors);

      const config = options.getConfig();
      const childDescriptors = descriptors
        .filter((descriptor) => descriptor.mode === 'child')
        .map((descriptor) => toServeDescriptor(descriptor, config));

      const result = await options.manager.reload(childDescriptors);
      if (pending.size > 0) result.restart_required = true;
      return result;
    },
  };
}

/** `activationEvents` 是否要求启动即激活 */
function startsAtStartup(events: readonly string[] | undefined): boolean {
  return (events ?? []).some((event) => event === 'onStartup' || event === '*');
}

/**
 * 启动时只激活声明了 `onStartup` / `*` 的 enabled plugin。
 * `onPage:*` / `onCommand:*` 保持 inactive，等首次页面 / RPC 访问由 serve
 * 的 `ensureActive` 懒激活（`settingsFor` 已注入 manager）。
 * 单个 plugin 激活失败只记日志，不阻断 gateway 启动。
 */
export async function activateStartupPlugins(
  manager: PluginHostManager,
  options: {
    loader: Pick<PluginLoader, 'getChildMods'>;
    config: VesselConfig;
    tenantId: string;
    logger?: Logger;
  },
): Promise<string[]> {
  const startup = new Set(
    options.loader
      .getChildMods()
      .filter((descriptor) => startsAtStartup(descriptor.manifest?.activationEvents))
      .map((descriptor) => descriptor.name),
  );
  const targets = manager
    .statuses()
    .filter((status) => startup.has(status.id) && status.enabled && status.status === 'inactive');
  const activated: string[] = [];

  await Promise.all(
    targets.map(async (status) => {
      try {
        await manager.activate(status.id, {
          settings: pluginSettingsFor(options.config, status.id),
        });
        activated.push(status.id);
      } catch (error) {
        options.logger?.warn('plugin.activation.failed', {
          plugin: status.id,
          tenant: options.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return activated.sort();
}
