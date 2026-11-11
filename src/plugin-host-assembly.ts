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
import type { VesselConfig } from '../packages/config/src/index';
import type { Logger } from '../packages/core/src/index';
import {
  PluginHostManager,
  type PluginHostManagerOptions,
  type PluginReloadResult,
  resolvePluginHttpLimits,
  type PluginDescriptor as ServePluginDescriptor,
} from '../packages/serve/src/index';
import type { PluginDescriptor as LoaderPluginDescriptor, PluginLoader } from './plugin-loader';

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
   * settings 解析（单执行面）。缺省只用 `config.plugins[].config`；
   * asm 注入启动 bundle 的配置，不回退 liveConfig。
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

/** `plugins[]` 里某 plugin 的启用状态；缺省 true */
function pluginEnabledInConfig(config: VesselConfig, id: string): boolean {
  const entry = config.plugins?.find((candidate) => candidate.name === id);
  return entry === undefined || entry.enabled !== false;
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
  const pluginDir = descriptor.dir;
  const uiDir = manifest.ui !== undefined ? path.resolve(pluginDir, manifest.ui.dir) : undefined;
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
    httpLimits: resolvePluginHttpLimits(options.config.serve?.pluginHttp),
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

/** 重新扫描的 loader 端口（`rescan()` 返回最新描述符） */
export interface PluginReloaderOptions {
  loader: Pick<PluginLoader, 'rescan' | 'list'>;
  manager: PluginHostManager;
  /** 每次 reload 读取当前活配置（enabled / settings / dependencies 可能已变） */
  getConfig: () => VesselConfig;
}

/** in-process 能力插件无法热重载：指纹变化时 `restart_required=true` */
function inProcessFingerprint(descriptors: readonly LoaderPluginDescriptor[]): string {
  return descriptors
    .filter((descriptor) => descriptor.mode === 'in-process')
    .map((descriptor) => `${descriptor.name}@${descriptor.version}:${descriptor.dir}`)
    .sort()
    .join('|');
}

/**
 * 创建共享 `reloadPlugins()`：`loader.rescan()` → 用当前配置重建 child
 * descriptor → `manager.reload(descriptors)`。
 *
 * 不重启进程；in-process 能力插件若发生变化，结果带 `restart_required`，
 * 不谎报已重载。
 */
export function createPluginReloader(
  options: PluginReloaderOptions,
): () => Promise<PluginReloadResult> {
  let baseline = inProcessFingerprint(options.loader.list());

  return async (): Promise<PluginReloadResult> => {
    const descriptors = options.loader.rescan();
    const next = inProcessFingerprint(descriptors);
    const restartRequired = next !== baseline;
    baseline = next;

    const config = options.getConfig();
    const childDescriptors = descriptors
      .filter((descriptor) => descriptor.mode === 'child')
      .map((descriptor) => toServeDescriptor(descriptor, config));

    const result = await options.manager.reload(childDescriptors);
    if (restartRequired) result.restart_required = true;
    return result;
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
