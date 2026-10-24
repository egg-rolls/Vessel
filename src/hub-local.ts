/**
 * gateway 同进程本地 hub 装配（S10.2）。
 *
 * gateway 启动时（`--serve` / `vessel gateway start`）在同一个 data dir 下
 * 拉起一个**仅回环**的 hub，并把本机节点目录写进 registry。规则：
 *
 * - `hub.autoStart` 缺省 true；显式 false 关闭；
 * - `hub.direction: 'node'` 表示该 gateway 正在加入远程 hub，跳过本地 hub；
 * - data dir 用显式 `hub.dataDir`，否则 `<gatewayDataDir>/hub`；
 * - 监听固定 `127.0.0.1`，端口 `hub.listen.port ?? 0`，永不开启远程监听；
 * - 同一 data dir 已有活实例时按 `reused` 返回（不视为失败）。
 *
 * 不做自动配对、不接收远程节点、不代理正文。
 *
 * @module vessel/hub-local
 */

import * as path from 'node:path';
import type { Logger } from '@vessel-agent/core';
import type { HubControlLike } from '@vessel-agent/serve';
import type { HubConfig, VesselConfig } from '../packages/config/src/index';
import { expandHome } from './data-paths';
import { HubRuntimeError, type HubRuntimeFactories, startHubRuntime } from './hub/runtime';

/** 本地 hub 固定监听地址；不接受配置改写。 */
export const LOCAL_HUB_HOSTNAME = '127.0.0.1';

export interface StartLocalHubOptions {
  config: VesselConfig;
  /** gateway data dir；未显式配置 `hub.dataDir` 时用 `<gatewayDataDir>/hub`。 */
  gatewayDataDir: string;
  nodeId: string;
  tenantId: string;
  hubControl: HubControlLike;
  logger?: Logger;
  now?: () => number;
  factories?: HubRuntimeFactories;
}

export interface LocalHubHandle {
  status: 'started' | 'reused' | 'skipped';
  url?: string;
  hubId?: string;
  /** skipped / reused 的原因；started 时缺省。 */
  reason?: string;
  /** 幂等停止；reused / skipped 时为 no-op。 */
  stop(): Promise<void>;
}

function noopStop(): Promise<void> {
  return Promise.resolve();
}

function resolveLocalHubDataDir(config: VesselConfig, gatewayDataDir: string): string {
  const configured = config.hub?.dataDir;
  if (configured !== undefined && configured.trim() !== '') {
    return path.resolve(expandHome(configured));
  }
  return path.join(path.resolve(gatewayDataDir), 'hub');
}

/** 按配置启动本地 hub；未满足条件时返回 skipped，已有实例返回 reused。 */
export async function startLocalHub(options: StartLocalHubOptions): Promise<LocalHubHandle> {
  const { config, gatewayDataDir, nodeId, tenantId, hubControl, logger } = options;

  if (config.hub?.autoStart === false) {
    return { status: 'skipped', reason: 'auto_start_disabled', stop: noopStop };
  }
  if (config.hub?.direction === 'node') {
    return { status: 'skipped', reason: 'direction_node', stop: noopStop };
  }

  const dataDir = resolveLocalHubDataDir(config, gatewayDataDir);
  // 只覆盖监听面：回环 + port 0（除非显式端口），永不开启远程 / TLS 远程。
  const hubConfig: HubConfig = {
    ...(config.hub ?? {}),
    listen: {
      ...(config.hub?.listen ?? {}),
      hostname: LOCAL_HUB_HOSTNAME,
      port: config.hub?.listen?.port ?? 0,
    },
    allowRemote: false,
  };
  const runtimeConfig: VesselConfig = { ...config, hub: hubConfig };

  try {
    const runtime = await startHubRuntime({
      config: runtimeConfig,
      dataDir,
      ...(logger !== undefined ? { logger } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.factories !== undefined ? { factories: options.factories } : {}),
      localNode: {
        nodeId,
        tenantId,
        snapshot: () => hubControl.snapshot(tenantId),
        subscribe: (listener) => hubControl.subscribe(tenantId, listener),
      },
    });
    return {
      status: 'started',
      url: runtime.url,
      hubId: runtime.hubId,
      stop: () => runtime.stop(),
    };
  } catch (error) {
    // 同 data dir 已有活实例：复用即可，不把 gateway 启动打成失败。
    if (error instanceof HubRuntimeError && error.code === 'hub_already_running') {
      return { status: 'reused', reason: 'hub_already_running', stop: noopStop };
    }
    throw error;
  }
}
