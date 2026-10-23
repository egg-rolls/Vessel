/**
 * Node → Hub 出站装配（S5.1）。
 *
 * 把三件事组合起来：`<dataDir>/hub-node.json`（join 状态）、
 * `<dataDir>/hub-node/` 下的 SecretStore（node token）、以及出站客户端。
 * hub 进程不经过这里；gateway 只有在 `hub.direction: 'node'` 时才启动出站。
 *
 * 任何跳过都不阻塞本地使用：只记日志并写 advisory 状态文件。
 *
 * @module vessel/hub/outbound-wiring
 */

import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import type { HubControlLike } from '@vessel-agent/serve';
import type { VesselConfig } from '../../packages/config/src/index.js';
import {
  type HubNodeOutboundStatus,
  type HubNodeStatusFile,
  readHubNodeState,
  writeHubNodeStatus,
} from './node-state.js';
import { createHubNodeOutboundClient } from './outbound-client.js';
import { type CreateSecretStoreOptions, createSecretStore } from './secret-store.js';
import type { SecretStore } from './types.js';

/** node token 在节点 SecretStore 中的 key。 */
export function hubNodeTokenSecretKey(hubId: string): string {
  return `node:${hubId}:control`;
}

export interface StartHubNodeOutboundOptions {
  config: VesselConfig;
  /** gateway data dir；state / status 文件与 `hub-node/` 都在这里。 */
  dataDir: string;
  nodeId: string;
  tenantId: string;
  hubControl: HubControlLike;
  logger?: Logger;
  /** 预留给 CLI / 测试覆盖 env；当前不读取。 */
  env?: Record<string, string | undefined>;
  /** 测试注入 SecretStore 工厂。 */
  createSecretStore?: (options: CreateSecretStoreOptions) => SecretStore;
}

export interface StartedHubNodeOutbound {
  status: 'started' | 'skipped';
  reason?: string;
  /** 停止出站；skipped 时也是 no-op。 */
  close(): Promise<void>;
}

/** 节点侧 SecretStore 的 keychain service；与 hub 的 `vessel-hub` 隔离。 */
const NODE_KEYCHAIN_SERVICE = 'vessel-node';

/** 只写 advisory 状态；失败不阻塞出站。 */
function createStatusWriter(dataDir: string, logger: Logger | undefined) {
  let queue: Promise<void> = Promise.resolve();

  return function write(
    status: HubNodeOutboundStatus,
    error: string | undefined,
    helloAt: number | undefined,
  ): Promise<void> {
    const body: HubNodeStatusFile = {
      v: 1,
      status,
      updated_at: Date.now(),
    };
    if (error !== undefined) body.last_error = error;
    if (helloAt !== undefined) body.hello_at = helloAt;

    const task = queue.then(() => writeHubNodeStatus(dataDir, body));
    queue = task.catch(() => {});
    return task.catch((failure: unknown) => {
      logger?.warn('hub.node.status_write_failed', {
        error: failure instanceof Error ? failure.message : String(failure),
      });
    });
  };
}

/** 按配置启动节点出站；未满足条件时返回 skipped，不抛错。 */
export async function startHubNodeOutbound(
  options: StartHubNodeOutboundOptions,
): Promise<StartedHubNodeOutbound> {
  const { config, dataDir, nodeId, tenantId, hubControl, logger } = options;
  const noop = { close: async (): Promise<void> => {} };

  if (config.hub?.direction !== 'node') {
    return { status: 'skipped', reason: 'direction_not_node', ...noop };
  }

  const state = await readHubNodeState(dataDir);
  if (state === undefined) {
    logger?.warn('hub.node.not_joined', { node_id: nodeId });
    return { status: 'skipped', reason: 'not_joined', ...noop };
  }

  const configuredUrl = config.hub.url;
  if (configuredUrl !== undefined && configuredUrl !== state.hub_url) {
    logger?.warn('hub.node.url_overridden', {
      configured: configuredUrl,
      state: state.hub_url,
    });
  }

  const writeStatus = createStatusWriter(dataDir, logger);
  let helloAt: number | undefined;

  // 节点身份 / tenant 必须与 join 时一致；否则 token 绑定必然失败。
  if (state.node_id !== nodeId || state.tenant_id !== tenantId) {
    await writeStatus('unauthorized', 'identity_mismatch', helloAt);
    logger?.warn('hub.node.identity_mismatch', {
      state_node_id: state.node_id,
      node_id: nodeId,
      state_tenant_id: state.tenant_id,
      tenant_id: tenantId,
    });
    return { status: 'skipped', reason: 'identity_mismatch', ...noop };
  }

  const createSecrets = options.createSecretStore ?? createSecretStore;
  const secrets = createSecrets({
    dataDir: join(dataDir, 'hub-node'),
    allowFileSecrets: config.hub.allowFileSecrets === true,
    keychainService: NODE_KEYCHAIN_SERVICE,
    ...(logger !== undefined ? { logger } : {}),
  });

  const tokenKey = hubNodeTokenSecretKey(state.hub_id);
  const token = await secrets.get(tokenKey);
  if (token === undefined || token === '') {
    await writeStatus('unauthorized', 'credential_missing', helloAt);
    logger?.warn('hub.node.credential_missing', { hub_id: state.hub_id, node_id: nodeId });
    return { status: 'skipped', reason: 'credential_missing', ...noop };
  }

  await writeStatus('connecting', undefined, helloAt);

  const client = createHubNodeOutboundClient({
    state,
    token,
    hubControl,
    hubId: state.hub_id,
    nodeId,
    tenantId,
    hubUrl: state.hub_url,
    ...(state.ca_file !== undefined
      ? { caFile: state.ca_file }
      : config.hub.caFile !== undefined
        ? { caFile: config.hub.caFile }
        : {}),
    ...(logger !== undefined ? { logger } : {}),
    onStatus: (status, error) => {
      void writeStatus(status, error, helloAt);
    },
    onHello: () => {
      helloAt = Date.now();
      void writeStatus('healthy', undefined, helloAt);
    },
  });

  return {
    status: 'started',
    close: async () => {
      client.close();
    },
  };
}
