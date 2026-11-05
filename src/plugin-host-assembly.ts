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
  type PluginDescriptor as ServePluginDescriptor,
} from '../packages/serve/src/index';
import type { PluginDescriptor as LoaderPluginDescriptor, PluginLoader } from './plugin-loader';

export interface PluginHostAssemblyOptions {
  /** 默认 tenant 的插件扫描器（`result.bundle.pluginLoader`） */
  loader: Pick<PluginLoader, 'getChildMods'>;
  /** 活配置；`plugins[].config` 即该 plugin 的 settings */
  config: VesselConfig;
  /** `<dataDir>`；plugin 私有目录为 `<dataDir>/plugins/<id>` */
  dataDir: string;
  logger?: Logger;
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

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    side: manifest.side,
    entry: descriptor.entry,
    pluginDir,
    ...(uiDir !== undefined ? { uiDir } : {}),
    activationEvents: manifest.activationEvents,
    contributes: {
      ...(contributes.pages !== undefined
        ? {
            pages: contributes.pages.map((page) => ({
              id: page.id,
              title: page.title ?? page.id,
              ...(page.nav !== undefined ? { nav: page.nav } : {}),
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
            })),
          }
        : {}),
      ...(contributes.events !== undefined ? { events: contributes.events } : {}),
      ...(contributes.settings !== undefined ? { settings: contributes.settings } : {}),
    },
    permissions: manifest.permissions,
    dependencies: {
      plugins: manifest.dependencies.mods,
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
    descriptors,
    dataDir: options.dataDir,
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
 * 启动时激活所有 enabled 且 inactive 的 plugin。
 *
 * 当前 serve follow-up 没有 `settingsFor(id, tenantId)` 端口，所以这里用
 * 启动配置的 `plugins[].config` 直接 activate（v1 只覆盖 default tenant）。
 * 单个 plugin 激活失败只记日志，不阻断 gateway 启动。
 */
export async function activateEnabledPlugins(
  manager: PluginHostManager,
  options: {
    config: VesselConfig;
    tenantId: string;
    logger?: Logger;
  },
): Promise<string[]> {
  const targets = manager
    .statuses()
    .filter((status) => status.enabled && status.status === 'inactive');
  const activated: string[] = [];

  await Promise.all(
    targets.map(async (status) => {
      try {
        await manager.activate(status.id, {
          tenantId: options.tenantId,
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
