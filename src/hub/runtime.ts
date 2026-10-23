/**
 * Hub 进程装配（S5）。
 *
 * 只负责把 registry / secret store / token broker / control client / HTTP 服务
 * 接在一起；配置校验、CLI 参数解析和网络协议分别留在各自模块。
 *
 * - hub data dir 必须与 gateway data dir 不同（`hub_data_dir_conflict`）；
 * - 启动时按 registry 记录恢复 view token 并重连；`direction:'node'` 的记录只标
 *   `unreachable` 等待节点重连，不读 view token、不拨号；
 * - 两个入站端口工厂（join / credentials）同时注入时才装配 `nodeControl`；
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
import { createHubSnapshotPolicy } from './snapshot-policy';
import { createHubTokenBroker, type HubTokenBrokerOptions } from './token-broker';
import {
  type HubJoinStoreLike,
  type HubNodeCredentialStoreLike,
  type HubNodeInboundDeps,
  type HubNodeInboundHooks,
  type HubNodeJoinedInput,
  type HubNodePointer,
  type HubNodeRecord,
  type HubNodeSnapshot,
  type HubNodeStatus,
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
  /** hub 侧 join code 端口；与 `createNodeCredentials` 同时提供才启用入站。 */
  createJoinStore?: () => HubJoinStoreLike;
  /** hub 侧 node token 端口；与 `createJoinStore` 同时提供才启用入站。 */
  createNodeCredentials?: () => Promise<HubNodeCredentialStoreLike>;
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

  // ---- node → hub 入站 hooks（S5.1）----

  function onInboundSnapshot(pairingId: string, snapshot: HubNodeSnapshot): void {
    // 跨重连的旧包必须丢弃：用 registry 里已持久化的代际 / revision 种子化。
    const before = registry.get(pairingId);
    if (before !== undefined) {
      const policy = createHubSnapshotPolicy({
        ...(before.incarnation !== undefined ? { incarnation: before.incarnation } : {}),
        ...(before.revision !== undefined ? { revision: before.revision } : {}),
      });
      if (!policy.accept(snapshot.incarnation, snapshot.revision)) {
        logger?.debug?.('hub.runtime.stale_inbound_snapshot', {
          pairing_id: pairingId,
          revision: snapshot.revision,
          last_revision: before.revision,
        });
        return;
      }
    }
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

  function onInboundPointer(pointer: HubNodePointer): void {
    server?.publishPointer({
      node_id: pointer.node_id,
      team_id: pointer.team_id,
      reason: pointer.reason,
      request_id: pointer.request_id,
      ts: pointer.ts,
    });
  }

  function onInboundStatus(pairingId: string, status: HubNodeStatus, error?: string): void {
    patchRecord(
      pairingId,
      status === 'healthy'
        ? { status, last_error: undefined }
        : { status, last_error: error ?? status },
    );
    server?.publishDirectory();
  }

  /** join 成功：建立（或覆盖）direction:'node' 目录记录；data_plane 由 registry 派生。 */
  function onJoined(input: HubNodeJoinedInput): void {
    const record: HubNodeRecord = {
      pairing_id: input.pairing_id,
      node_id: input.node_id,
      tenant_id: input.tenant_id,
      direction: 'node',
      node_token_id: input.node_token_id,
      status: 'connecting',
      truncated: false,
      counts: { teams: 0, agents: 0, live_agents: 0 },
      teams: [],
      agents: [],
    };
    if (input.public_url !== undefined) {
      record.url = input.public_url;
      record.public_url = input.public_url;
    }
    if (input.alias !== undefined) record.alias = input.alias;
    registry.upsert(record);
    server?.publishDirectory();
  }

  /** auth 成功：registry 记录缺失时重建最小记录；已存在则绝不覆盖。 */
  function onAuthenticated(input: {
    pairing_id: string;
    node_id: string;
    tenant_id: string;
    node_token_id: string;
  }): void {
    if (registry.get(input.pairing_id) !== undefined) return;
    registry.upsert({
      pairing_id: input.pairing_id,
      node_id: input.node_id,
      tenant_id: input.tenant_id,
      direction: 'node',
      node_token_id: input.node_token_id,
      status: 'connecting',
      truncated: false,
      counts: { teams: 0, agents: 0, live_agents: 0 },
      teams: [],
      agents: [],
    });
    server?.publishDirectory();
  }

  const inboundHooks: HubNodeInboundHooks = {
    onSnapshot: onInboundSnapshot,
    onPointer: onInboundPointer,
    onStatus: onInboundStatus,
    onJoined,
    onAuthenticated,
  };

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
  ): HubNodeConnection | undefined => {
    // node 拨号的 pairing 由入站连接管理；hub 不反向拨号。
    if (record.direction === 'node') return undefined;
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

  // 只有两个端口都注入时才启用 node 入站；否则 join 端点保持 404。
  let nodeControl: HubNodeInboundDeps | undefined;
  if (factories.createJoinStore !== undefined && factories.createNodeCredentials !== undefined) {
    const joinStore = factories.createJoinStore();
    const credentials = await factories.createNodeCredentials();
    nodeControl = {
      hubId,
      joinStore,
      credentials,
      hooks: inboundHooks,
      ...(logger ? { logger } : {}),
      now: clock,
    };
  }

  const createServer = factories.createServer ?? createHubServer;
  // `nodeControl` 由 M-I2 的 server 路由消费；此处按扩展选项传递，缺省为 undefined。
  const serverOptions: CreateHubServerOptions & {
    nodeControl?: HubNodeInboundDeps;
  } = {
    config: (config.hub ?? {}) as HubConfig,
    hubId,
    registry,
    secretStore,
    tokenBroker,
    connectNode,
    ...(logger ? { logger } : {}),
    now: clock,
    nodeControl,
  };
  server = createServer(serverOptions);

  // 启动恢复：上次的 healthy 不可信，先全部标 unreachable；再逐条读 view token。
  // node 拨号的记录不读 secret、不拨号，等待节点重连。
  let directoryChanged = false;
  for (const record of registry.list()) {
    if (record.direction === 'node') {
      patchRecord(record.pairing_id, {
        status: 'unreachable',
        last_error: 'waiting_for_node',
      });
    } else {
      patchRecord(record.pairing_id, { status: 'unreachable', last_error: 'reconnecting' });
    }
    directoryChanged = true;
  }
  for (const record of registry.list()) {
    if (record.direction === 'node') continue;
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
