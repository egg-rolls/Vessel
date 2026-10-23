/**
 * Hub 进程装配（S5）。
 *
 * 只负责把 registry / secret store / token broker / control client / HTTP 服务
 * 接在一起；配置校验、CLI 参数解析和网络协议分别留在各自模块。
 *
 * - hub data dir 必须与 gateway data dir 不同（`hub_data_dir_conflict`）；
 * - 启动时按 registry 记录恢复 view token 并重连；
 * - registry 删除 pairing 时同步关闭 control client；
 * - `stop()` 幂等：关连接 → 停服务 → flush 目录。
 *
 * @module vessel/hub/runtime
 */

import * as path from 'node:path';
import type { Logger } from '@vessel-agent/core';
import type { HubConfig, VesselConfig } from '../../packages/config/src/index';
import { expandHome, resolveDataDir } from '../data-paths';
import { resolveNodeId } from '../node-identity';
import {
  createHubControlClient,
  type HubControlClient,
  type HubControlClientOptions,
  type HubControlPointer,
  type HubControlSnapshot,
  type HubControlStatus,
} from './control-client';
import {
  type CreateHubRegistryOptions,
  createHubRegistry,
  type HubNodePatch,
  type HubRegistry,
} from './registry';
import { type CreateSecretStoreOptions, createSecretStore } from './secret-store';
import {
  type CreateHubServerOptions,
  createHubServer,
  type HubConnectNode,
  type HubNodeConnection,
  type HubServer,
} from './server';
import { createHubTokenBroker, type HubTokenBrokerOptions } from './token-broker';
import {
  type HubNodeRecord,
  type HubTokenBrokerLike,
  pairingSecretKey,
  type SecretStore,
} from './types';

/** 缺省 hub data dir（相对 home）。 */
export const DEFAULT_HUB_DATA_DIR = '~/.vessel/hub';

/** 进程装配依赖；测试可注入 fake 实现，不启动真实网络。 */
export interface HubRuntimeFactories {
  resolveHubId?: (options: { dataDir: string; logger?: Logger }) => Promise<string>;
  createRegistry?: (options: CreateHubRegistryOptions) => HubRegistry;
  createSecretStore?: (options: CreateSecretStoreOptions) => SecretStore;
  createTokenBroker?: (options: HubTokenBrokerOptions) => HubTokenBrokerLike;
  createControlClient?: (options: HubControlClientOptions) => HubControlClient;
  createServer?: (options: CreateHubServerOptions) => HubServer;
}

export interface StartHubRuntimeOptions {
  config: VesselConfig;
  /** CLI `--data-dir`；优先于 `config.hub.dataDir`。 */
  dataDir?: string;
  /** 测试 / 嵌入方显式指定 hub id；缺省由 `<hubDataDir>/node.json` 生成。 */
  hubId?: string;
  logger?: Logger;
  now?: () => number;
  factories?: HubRuntimeFactories;
}

export interface HubRuntime {
  hubId: string;
  dataDir: string;
  url: string;
  /** 幂等停止。 */
  stop(): Promise<void>;
}

/** 带稳定错误码的 hub 装配错误。 */
export class HubRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HubRuntimeError';
    this.code = code;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveHubDataDir(config: VesselConfig, explicit?: string): string {
  const configured = explicit ?? config.hub?.dataDir ?? DEFAULT_HUB_DATA_DIR;
  const expanded = expandHome(configured);
  const resolved = path.resolve(expanded);
  const gatewayDataDir = path.resolve(expandHome(resolveDataDir(config)));
  const left = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const right = process.platform === 'win32' ? gatewayDataDir.toLowerCase() : gatewayDataDir;
  if (left === right) {
    throw new HubRuntimeError(
      'hub_data_dir_conflict',
      'hub.dataDir must differ from the gateway dataDir',
    );
  }
  return resolved;
}

/**
 * 启动 hub 进程装配。
 *
 * 工厂注入只替换构造点；连接管理 / 重连 / 目录更新语义保持不变。
 */
export async function startHubRuntime(options: StartHubRuntimeOptions): Promise<HubRuntime> {
  const { config, logger } = options;
  const clock = options.now ?? Date.now;
  const factories = options.factories ?? {};

  const direction = config.hub?.direction;
  if (direction !== undefined && direction !== 'hub') {
    throw new HubRuntimeError(
      'unsupported_direction',
      `hub.direction "${direction}" is not supported in S5`,
    );
  }

  const dataDir = resolveHubDataDir(config, options.dataDir);

  const resolveHub =
    factories.resolveHubId ??
    ((input: { dataDir: string; logger?: Logger }) =>
      resolveNodeId({ dataDir: input.dataDir, ...(input.logger ? { logger: input.logger } : {}) }));
  const hubId = options.hubId ?? (await resolveHub({ dataDir, ...(logger ? { logger } : {}) }));

  const createRegistry = factories.createRegistry ?? createHubRegistry;
  const registry = createRegistry({
    dataDir,
    hubId,
    ...(logger ? { logger } : {}),
    now: clock,
  });
  await registry.load();

  const createSecrets = factories.createSecretStore ?? createSecretStore;
  const secretStore = createSecrets({
    dataDir,
    allowFileSecrets: config.hub?.allowFileSecrets === true,
    ...(logger ? { logger } : {}),
  });

  const createBroker = factories.createTokenBroker ?? createHubTokenBroker;
  const tokenBroker = createBroker({ secretStore, now: clock });

  const createClient = factories.createControlClient ?? createHubControlClient;
  const clients = new Map<string, HubControlClient>();
  let server: HubServer | undefined;
  let stopped = false;
  let unsubscribeRegistry: (() => void) | undefined;

  /** registry.patch 会忽略 undefined；这里补上“清空 last_error”。 */
  function patchRecord(pairingId: string, patch: HubNodePatch): HubNodeRecord | undefined {
    const before = registry.get(pairingId);
    if (before === undefined) return undefined;
    const updated = registry.patch(pairingId, patch);
    if (patch.last_error !== undefined || before.last_error === undefined) return updated;
    const current = registry.get(pairingId);
    if (current === undefined) return updated;
    const copy: HubNodeRecord = { ...current };
    delete copy.last_error;
    return registry.upsert(copy);
  }

  function onSnapshot(pairingId: string, snapshot: HubControlSnapshot): void {
    patchRecord(pairingId, {
      status: 'healthy',
      last_seen: snapshot.observed_at,
      incarnation: snapshot.incarnation,
      revision: snapshot.revision,
      truncated: snapshot.truncated,
      counts: snapshot.counts,
      teams: snapshot.teams,
      agents: snapshot.agents,
      last_error: undefined,
    });
    server?.publishDirectory();
  }

  function onPointer(pointer: HubControlPointer): void {
    server?.publishPointer({
      node_id: pointer.node_id,
      team_id: pointer.team_id,
      reason: pointer.reason,
      request_id: pointer.request_id,
      ts: pointer.ts,
    });
  }

  function onStatus(pairingId: string, status: HubControlStatus): void {
    patchRecord(
      pairingId,
      status === 'healthy' ? { status, last_error: undefined } : { status, last_error: status },
    );
    server?.publishDirectory();
  }

  function closeClient(pairingId: string): void {
    const client = clients.get(pairingId);
    if (client === undefined) return;
    clients.delete(pairingId);
    client.close();
  }

  /** 建立一条 control 连接；同 pairing 的旧连接先关闭。 */
  const connectNode: HubConnectNode = (
    record: HubNodeRecord,
    viewToken: string,
  ): HubNodeConnection => {
    closeClient(record.pairing_id);
    const client = createClient({
      record,
      viewToken,
      hubId,
      ...(logger ? { logger } : {}),
      now: clock,
      onSnapshot: (snapshot) => onSnapshot(record.pairing_id, snapshot),
      onPointer,
      onStatus: (status) => onStatus(record.pairing_id, status),
    });
    clients.set(record.pairing_id, client);
    return {
      close(): void {
        client.close();
        if (clients.get(record.pairing_id) === client) clients.delete(record.pairing_id);
      },
    };
  };

  const createServer = factories.createServer ?? createHubServer;
  server = createServer({
    config: (config.hub ?? {}) as HubConfig,
    hubId,
    registry,
    secretStore,
    tokenBroker,
    connectNode,
    ...(logger ? { logger } : {}),
    now: clock,
  });

  // 启动恢复：目录里的每条记录读取 view token；缺失时标 unauthorized。
  let directoryChanged = false;
  for (const record of registry.list()) {
    let viewToken: string | undefined;
    try {
      viewToken = await secretStore.get(pairingSecretKey(record.pairing_id, 'view'));
    } catch (error) {
      logger?.warn('hub.runtime.secret_read_failed', {
        pairing_id: record.pairing_id,
        error: errorMessage(error),
      });
      patchRecord(record.pairing_id, { status: 'unreachable', last_error: 'secret_store_error' });
      directoryChanged = true;
      continue;
    }
    if (viewToken === undefined || viewToken === '') {
      patchRecord(record.pairing_id, { status: 'unauthorized', last_error: 'unauthorized' });
      directoryChanged = true;
      continue;
    }
    try {
      connectNode(record, viewToken);
    } catch (error) {
      logger?.warn('hub.runtime.connect_failed', {
        pairing_id: record.pairing_id,
        error: errorMessage(error),
      });
      patchRecord(record.pairing_id, { status: 'unreachable', last_error: 'connect_failed' });
      directoryChanged = true;
    }
  }
  if (directoryChanged) server.publishDirectory();

  unsubscribeRegistry = registry.subscribe((event) => {
    if (event.type !== 'remove') return;
    closeClient(event.pairing_id);
  });

  const runtime: HubRuntime = {
    hubId,
    dataDir,
    url: server.url,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      unsubscribeRegistry?.();
      unsubscribeRegistry = undefined;
      for (const client of clients.values()) client.close();
      clients.clear();
      try {
        await server?.stop();
      } finally {
        await registry.flush();
      }
    },
  };

  return runtime;
}
