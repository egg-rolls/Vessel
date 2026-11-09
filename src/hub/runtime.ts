/**
 * Hub 进程装配（S5）。
 *
 * 只负责把 registry / secret store（node token）/ node credentials / HTTP 服务
 * 接在一起；配置校验、CLI 参数解析和网络协议分别留在各自模块。
 *
 * - hub data dir 必须与 gateway data dir 不同（`hub_data_dir_conflict`）；
 * - 启动时只把 registry 里的旧记录标 `unreachable`，等待节点重连；不读 view token、不拨号；
 * - 两个入站端口工厂（join / credentials）同时注入时才装配 `nodeControl`；
 * - `stop()` 幂等：停服务 → flush 目录。
 *
 * @module vessel/hub/runtime
 */

import * as fs from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '@vessel-agent/core';
import type { HubConfig, VesselConfig } from '../../packages/config/src/index';
import { expandHome, resolveDataDir } from '../data-paths';
import {
  deleteRecordIfOwned,
  isBeforeBoot,
  isProcessAlive as pidIsAlive,
  quarantineCorruptRecordIfUnchanged,
  readGatewayStateFile,
} from '../gateway/pid';
import { resolveNodeId } from '../node-identity';
import { createHubJoinStore } from './join-store';
import { createHubNodeCredentialStore } from './node-credential-store';
import {
  type CreateHubRegistryOptions,
  createHubRegistry,
  type HubNodePatch,
  type HubRegistry,
} from './registry';
import { type CreateHubServerOptions, createHubServer, type HubServer } from './server';
import { createHubSnapshotPolicy } from './snapshot-policy';
import type {
  HubJoinStoreLike,
  HubNodeCredentialStoreLike,
  HubNodeInboundDeps,
  HubNodeInboundHooks,
  HubNodeJoinedInput,
  HubNodePointer,
  HubNodeRecord,
  HubNodeSnapshot,
  HubNodeStatus,
} from './types';

/**
 * 缺省 hub data dir：`<gatewayDataDir>/hub`。
 *
 * standalone `vessel hub start` 与 gateway 自动 hub 共用同一目录，
 * 避免同一台机器出现两个目录；只有显式 `--data-dir` / `hub.dataDir` 才分叉。
 */
export function defaultHubDataDir(config: VesselConfig): string {
  return path.join(path.resolve(expandHome(resolveDataDir(config))), 'hub');
}

/** 单实例独占锁文件名（S10.2，位于 hub data dir 根）。 */
export const HUB_LOCK_FILE = 'hub.lock';

/** 不可解析 hub.lock 的宽限（E3）。 */
const HUB_UNPARSEABLE_GRACE_MS = 5_000;

/** `<hubDataDir>/hub.lock` 的内容；仅用于判定实例存活。 */
export interface HubLockFile {
  pid: number;
  started_at: number;
  url?: string;
}

/** 进程装配依赖；测试可注入 fake 实现，不启动真实网络。 */
export interface HubRuntimeFactories {
  resolveHubId?: (options: { dataDir: string; logger?: Logger }) => Promise<string>;
  createRegistry?: (options: CreateHubRegistryOptions) => HubRegistry;
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
  /** hub data dir 独占锁；默认 true（测试可显式关闭）。 */
  singleInstance?: boolean;
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

function errnoCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/** hub.lock 形状校验；deleteRecordIfOwned / readGatewayStateFile 的 parse 回调。 */
function parseHubLockRecord(raw: unknown): HubLockFile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const info = raw as Partial<HubLockFile>;
  if (typeof info.pid !== 'number' || !Number.isInteger(info.pid) || info.pid <= 0) return null;
  if (typeof info.started_at !== 'number' || !Number.isFinite(info.started_at)) return null;
  return {
    pid: info.pid,
    started_at: info.started_at,
    ...(typeof info.url === 'string' ? { url: info.url } : {}),
  };
}

/**
 * 读取 `<hubDataDir>/hub.lock`（gateway 自动拉起 Hub 的 adopt / 归属复核用）。
 * 缺失 / 损坏 / I/O 错误一律返回 null，由调用方按未运行处理。
 */
export async function readHubLockFile(dataDir: string): Promise<HubLockFile | null> {
  const snapshot = await readGatewayStateFile<HubLockFile>(path.join(dataDir, HUB_LOCK_FILE), {
    now: Date.now(),
    graceMs: HUB_UNPARSEABLE_GRACE_MS,
    parse: parseHubLockRecord,
  });
  return snapshot.kind === 'ok' ? snapshot.value : null;
}

interface HubLockHandle {
  release(): Promise<void>;
  /** process 'exit' 兜底；不抛错。 */
  releaseSync(): void;
  /** 服务绑定端口后补写 url（仅诊断；不影响单实例判定）。 */
  setUrl(url: string): Promise<void>;
}

async function releaseHubLock(lockPath: string, startedAt: number): Promise<void> {
  await deleteRecordIfOwned(
    lockPath,
    { pid: process.pid, started_at: startedAt },
    { parse: parseHubLockRecord },
  );
}

/**
 * 获取 `<hubDataDir>/hub.lock` 独占锁。
 *
 * 只确认 stale（pid 死或 pre-boot）才回收，且 compare-and-delete；
 * 活 pid post-boot → `hub_already_running`；损坏未过宽限 / I/O 错误 → 保守拒绝。
 * 文件以 0600 创建，内容为 `{pid, started_at, url?}`。
 */
async function acquireHubLock(
  dataDir: string,
  url: string,
  now: () => number,
  logger: Logger | undefined,
): Promise<HubLockHandle> {
  const lockPath = path.join(dataDir, HUB_LOCK_FILE);
  await mkdir(dataDir, { recursive: true });
  const startedAt = now();
  const body: HubLockFile = { pid: process.pid, started_at: startedAt };
  if (url !== '') body.url = url;
  const payload = `${JSON.stringify(body)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      try {
        await file.writeFile(payload, 'utf8');
      } finally {
        await file.close();
      }
      let released = false;
      return {
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          await releaseHubLock(lockPath, startedAt);
        },
        releaseSync: (): void => {
          if (released) return;
          released = true;
          try {
            const current = parseHubLockRecord(JSON.parse(fs.readFileSync(lockPath, 'utf8')));
            if (
              current === null ||
              current.pid !== process.pid ||
              current.started_at !== startedAt
            ) {
              return;
            }
            const reclaimPath = `${lockPath}.reclaim-${Date.now()}`;
            fs.renameSync(lockPath, reclaimPath);
            fs.rmSync(reclaimPath, { force: true });
          } catch {
            // 退出路径不抛错。
          }
        },
        async setUrl(nextUrl: string): Promise<void> {
          const next: HubLockFile = { pid: process.pid, started_at: startedAt, url: nextUrl };
          try {
            const file = await open(lockPath, 'w', 0o600);
            try {
              await file.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
            } finally {
              await file.close();
            }
          } catch {
            // 诊断字段写入失败不影响运行。
          }
        },
      };
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;

      const snapshot = await readGatewayStateFile<HubLockFile>(lockPath, {
        now: now(),
        graceMs: HUB_UNPARSEABLE_GRACE_MS,
        parse: parseHubLockRecord,
      });

      if (snapshot.kind === 'absent') continue;
      if (snapshot.kind === 'io-error') {
        throw new HubRuntimeError(
          'hub_already_running',
          `hub data dir lock is unreadable (${snapshot.error.message}): ${dataDir}`,
        );
      }
      if (snapshot.kind === 'corrupt') {
        if (!snapshot.reclaimable) {
          throw new HubRuntimeError(
            'hub_already_running',
            `hub data dir lock is ${snapshot.reason}: ${dataDir}`,
          );
        }
        const quarantined = await quarantineCorruptRecordIfUnchanged(lockPath, snapshot.mtimeMs, {
          now: now(),
        });
        if (quarantined) continue;
        throw new HubRuntimeError(
          'hub_already_running',
          `hub data dir lock changed during recovery: ${dataDir}`,
        );
      }

      const existing = snapshot.value;
      if (pidIsAlive(existing.pid) && !isBeforeBoot(existing.started_at)) {
        throw new HubRuntimeError(
          'hub_already_running',
          `hub data dir is already in use by pid ${existing.pid}: ${dataDir}`,
        );
      }

      logger?.warn('hub.runtime.stale_lock_reclaimed', {
        data_dir: dataDir,
        pid: existing.pid,
      });
      const deleted = await deleteRecordIfOwned(
        lockPath,
        { pid: existing.pid, started_at: existing.started_at },
        { quarantine: true, now: now(), parse: parseHubLockRecord },
      );
      if (deleted) continue;
      throw new HubRuntimeError(
        'hub_already_running',
        `hub data dir lock changed during recovery: ${dataDir}`,
      );
    }
  }
  throw new HubRuntimeError('hub_already_running', `hub data dir is already in use: ${dataDir}`);
}

function resolveHubDataDir(config: VesselConfig, explicit?: string): string {
  const gatewayDataDir = path.resolve(expandHome(resolveDataDir(config)));
  const configured = explicit ?? config.hub?.dataDir;
  const resolved =
    configured === undefined ? defaultHubDataDir(config) : path.resolve(expandHome(configured));
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

  let server: HubServer | undefined;
  let lock: HubLockHandle | undefined;
  let stopped = false;

  /** registry.patch 会忽略 undefined；这里补上“清空 last_error”。 */
  function patchRecord(nodeId: string, patch: HubNodePatch): HubNodeRecord | undefined {
    const before = registry.get(nodeId);
    if (before === undefined) return undefined;
    const updated = registry.patch(nodeId, patch);
    if (patch.last_error !== undefined || before.last_error === undefined) return updated;
    const current = registry.get(nodeId);
    if (current === undefined) return updated;
    const copy: HubNodeRecord = { ...current };
    delete copy.last_error;
    return registry.upsert(copy);
  }

  // ---- node → hub 入站 hooks（S5.1）----

  function onInboundSnapshot(nodeId: string, snapshot: HubNodeSnapshot): void {
    // 跨重连的旧包必须丢弃：用 registry 里已持久化的代际 / revision 种子化。
    const before = registry.get(nodeId);
    if (before !== undefined) {
      const policy = createHubSnapshotPolicy({
        ...(before.incarnation !== undefined ? { incarnation: before.incarnation } : {}),
        ...(before.revision !== undefined ? { revision: before.revision } : {}),
      });
      if (!policy.accept(snapshot.incarnation, snapshot.revision)) {
        logger?.debug?.('hub.runtime.stale_inbound_snapshot', {
          node_id: nodeId,
          revision: snapshot.revision,
          last_revision: before.revision,
        });
        return;
      }
    }
    patchRecord(nodeId, {
      status: 'healthy',
      name: snapshot.name,
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

  function onInboundStatus(nodeId: string, status: HubNodeStatus, error?: string): void {
    patchRecord(
      nodeId,
      status === 'healthy'
        ? { status, last_error: undefined }
        : { status, last_error: error ?? status },
    );
    server?.publishDirectory();
  }

  /** join 成功：建立（或覆盖）direction:'node' 目录记录；data_plane 由 registry 派生。 */
  function onJoined(input: HubNodeJoinedInput): void {
    const record: HubNodeRecord = {
      node_id: input.node_id,
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
  function onAuthenticated(input: { node_id: string; node_token_id: string }): void {
    if (registry.get(input.node_id) !== undefined) return;
    registry.upsert({
      node_id: input.node_id,
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

  // 默认装配真实 join / credential 端口；测试可注入 fake。
  const createJoinStore =
    factories.createJoinStore ?? (() => createHubJoinStore({ dataDir, hubId, now: clock }));
  const createNodeCredentials =
    factories.createNodeCredentials ??
    (() => createHubNodeCredentialStore({ dataDir, now: clock }));

  const joinStore = createJoinStore();
  const credentials = await createNodeCredentials();
  const nodeControl: HubNodeInboundDeps = {
    hubId,
    joinStore,
    credentials,
    hooks: inboundHooks,
    ...(logger ? { logger } : {}),
    now: clock,
  };

  const createServer = factories.createServer ?? createHubServer;
  // `nodeControl` 由 M-I2 的 server 路由消费；此处按扩展选项传递，缺省为 undefined。
  const serverOptions: CreateHubServerOptions & {
    nodeControl?: HubNodeInboundDeps;
  } = {
    config: (config.hub ?? {}) as HubConfig,
    hubId,
    registry,
    ...(logger ? { logger } : {}),
    now: clock,
    nodeControl,
  };
  // S10.2：同一 hub data dir 只允许一个活实例。锁先于监听端口获取，
  // 这样固定端口被既存实例占用时也能稳定返回 `hub_already_running`。
  // url 在服务起来后补写；锁只用于存活判定，不承载协议状态。
  if (options.singleInstance !== false) {
    lock = await acquireHubLock(dataDir, '', clock, logger);
    const exitLock = lock;
    process.once('exit', () => exitLock.releaseSync());
  }

  try {
    server = createServer(serverOptions);
    await lock?.setUrl(server.url);
  } catch (error) {
    const held = lock;
    lock = undefined;
    await held?.release();
    throw error;
  }

  // 启动恢复：上次的 healthy 不可信，先全部标 unreachable，等待节点重连。
  // 旧 hub→node 记录已无法反拨，标 disconnected；节点重新 join 后会覆盖。
  let directoryChanged = false;
  for (const record of registry.list()) {
    patchRecord(
      record.node_id,
      record.direction === 'node'
        ? { status: 'unreachable', last_error: 'waiting_for_node' }
        : { status: 'unreachable', last_error: 'disconnected' },
    );
    directoryChanged = true;
  }
  if (directoryChanged) server.publishDirectory();

  const runtime: HubRuntime = {
    hubId,
    dataDir,
    url: server.url,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await server?.stop();
      } finally {
        try {
          await registry.flush();
        } finally {
          await lock?.release();
          lock = undefined;
        }
      }
    },
  };

  return runtime;
}
