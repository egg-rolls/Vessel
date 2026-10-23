/**
 * Hub 目录注册表（S5 / PLAN §8）。
 *
 * - 持久化 `<hubDataDir>/registry.json`（`HubRegistryFile` v1）；
 * - 0600 atomicWrite + 250ms debounce；
 * - 文件缺失 = 空目录；损坏 / `v !== 1` / 字段非法 → `hub_registry_corrupt`
 *   fail-closed，不静默覆盖；
 * - 主键 `pairing_id = node_id:tenant_id`，同一 node 可有多个 pairing；
 * - `direction` 缺省按 `'hub'` 读；`data_plane` 由 `public_url ?? url` 派生；
 * - 只存元数据（teams / agents 白名单），禁止字段不会落盘；
 * - 写前强制 `HUB_MAX_TEAMS` / `HUB_MAX_AGENTS` 上限并置 `truncated`。
 *
 * 启动时把节点标 `unreachable` 是调用方职责；registry 只做存储。
 *
 * @module vessel/hub/registry
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@vessel-agent/core';
import { atomicWrite } from '@vessel-agent/core';
import {
  HUB_MAX_AGENTS,
  HUB_MAX_TEAMS,
  type HubAgentMeta,
  type HubTeamMeta,
  parseHubAgentMeta,
  parseHubTeamMeta,
} from '@vessel-agent/serve';
import {
  type HubDataPlane,
  type HubNodeDirection,
  type HubNodeRecord,
  type HubNodeStatus,
  type HubRegistryFile,
  pairingIdFor,
} from './types.js';

/** registry 文件名（hub data dir 根） */
export const HUB_REGISTRY_FILE = 'registry.json';

/** debounce 缺省值（毫秒） */
export const HUB_REGISTRY_DEBOUNCE_MS = 250;

/** 目录事件；只带主键，不带记录内容。 */
export interface HubRegistryEvent {
  type: 'upsert' | 'patch' | 'remove';
  pairing_id: string;
}

export type HubRegistryListener = (event: HubRegistryEvent) => void;

export interface CreateHubRegistryOptions {
  /** hub data dir（必须与 gateway data_dir 不同，由调用方保证） */
  dataDir: string;
  hubId: string;
  logger?: Logger;
  now?: () => number;
  /** 覆盖 debounce（测试可用 0 / 小值） */
  debounceMs?: number;
}

/** 可修改字段；主键与 node/tenant 身份不可 patch。 */
export type HubNodePatch = Partial<Omit<HubNodeRecord, 'pairing_id' | 'node_id' | 'tenant_id'>>;

export interface HubRegistry {
  /** 读取并校验 registry 文件；缺失为空目录，损坏抛 `hub_registry_corrupt`。 */
  load(): Promise<void>;
  /** 当前完整文件快照（深拷贝）。 */
  snapshot(): HubRegistryFile;
  /** 全量记录（深拷贝）。 */
  list(): HubNodeRecord[];
  get(pairingId: string): HubNodeRecord | undefined;
  /** 写入/替换一条记录（按 pairing_id）；返回落库后的深拷贝。 */
  upsert(record: HubNodeRecord): HubNodeRecord;
  /** 局部更新；记录不存在返回 undefined。 */
  patch(pairingId: string, patch: HubNodePatch): HubNodeRecord | undefined;
  /** 删除；返回被删除记录（不存在返回 undefined）。 */
  remove(pairingId: string): HubNodeRecord | undefined;
  /** 取消 debounce 并等待当前写队列落盘。写失败只记日志。 */
  flush(): Promise<void>;
  /** 订阅目录变更；返回取消函数。 */
  subscribe(listener: HubRegistryListener): () => void;
}

/** 稳定错误：目录文件损坏 / 版本或字段非法。 */
export class HubRegistryCorruptError extends Error {
  readonly code = 'hub_registry_corrupt' as const;
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`hub_registry_corrupt: ${path}: ${reason}`);
    this.name = 'HubRegistryCorruptError';
    this.path = path;
  }
}

const STATUSES = new Set<HubNodeStatus>([
  'connecting',
  'healthy',
  'unreachable',
  'incompatible',
  'unauthorized',
  'identity_mismatch',
]);

const DIRECTIONS = new Set<HubNodeDirection>(['hub', 'node']);

const DATA_PLANES = new Set<HubDataPlane>(['direct', 'unreachable']);

/** 数据面可达性只看是否存在浏览器可达 origin（`public_url` 优先，其次 `url`）。 */
function deriveDataPlane(url: string | undefined, publicUrl: string | undefined): HubDataPlane {
  return publicUrl !== undefined || url !== undefined ? 'direct' : 'unreachable';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asCount(value: unknown): number | undefined {
  if (!isFiniteNumber(value) || value < 0) return undefined;
  return Math.floor(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

/**
 * 只按白名单构造记录；未知字段（content / messages / token ...）一律丢弃。
 * 字段非法返回 undefined。
 */
function parseNodeRecord(value: unknown): HubNodeRecord | undefined {
  if (!isRecord(value)) return undefined;

  const pairingId = value.pairing_id;
  const nodeId = value.node_id;
  const tenantId = value.tenant_id;
  if (!isNonEmptyString(pairingId) || !isNonEmptyString(nodeId) || !isNonEmptyString(tenantId)) {
    return undefined;
  }
  if (pairingId !== pairingIdFor(nodeId, tenantId)) return undefined;

  // 旧文件缺 `direction` 按 hub 读；写时总是写入。
  let direction: HubNodeDirection = 'hub';
  if (value.direction !== undefined) {
    if (
      typeof value.direction !== 'string' ||
      !DIRECTIONS.has(value.direction as HubNodeDirection)
    ) {
      return undefined;
    }
    direction = value.direction as HubNodeDirection;
  }

  let url: string | undefined;
  if (value.url !== undefined) {
    if (!isNonEmptyString(value.url)) return undefined;
    url = value.url;
  } else if (direction === 'hub') {
    // hub 拨号必须有可连接的 url；node 拨号允许缺失（NAT）。
    return undefined;
  }

  let publicUrl: string | undefined;
  if (value.public_url !== undefined) {
    if (!isNonEmptyString(value.public_url)) return undefined;
    publicUrl = value.public_url;
  }

  let dataPlane: HubDataPlane;
  if (value.data_plane !== undefined) {
    if (
      typeof value.data_plane !== 'string' ||
      !DATA_PLANES.has(value.data_plane as HubDataPlane)
    ) {
      return undefined;
    }
    dataPlane = value.data_plane as HubDataPlane;
  } else {
    dataPlane = deriveDataPlane(url, publicUrl);
  }

  const status = value.status;
  if (typeof status !== 'string' || !STATUSES.has(status as HubNodeStatus)) return undefined;
  if (typeof value.truncated !== 'boolean') return undefined;

  const countsRaw = value.counts;
  if (!isRecord(countsRaw)) return undefined;
  const teamsCount = asCount(countsRaw.teams);
  const agentsCount = asCount(countsRaw.agents);
  const liveAgentsCount = asCount(countsRaw.live_agents);
  if (teamsCount === undefined || agentsCount === undefined || liveAgentsCount === undefined) {
    return undefined;
  }

  if (!Array.isArray(value.teams) || !Array.isArray(value.agents)) return undefined;
  const teams: HubTeamMeta[] = [];
  for (const item of value.teams) {
    const team = parseHubTeamMeta(item);
    if (!team) return undefined;
    teams.push(team);
  }
  const agents: HubAgentMeta[] = [];
  for (const item of value.agents) {
    const agent = parseHubAgentMeta(item);
    if (!agent) return undefined;
    agents.push(agent);
  }

  const record: HubNodeRecord = {
    pairing_id: pairingId,
    node_id: nodeId,
    tenant_id: tenantId,
    direction,
    data_plane: dataPlane,
    status: status as HubNodeStatus,
    truncated: value.truncated,
    counts: { teams: teamsCount, agents: agentsCount, live_agents: liveAgentsCount },
    teams,
    agents,
  };

  if (url !== undefined) record.url = url;
  if (publicUrl !== undefined) record.public_url = publicUrl;
  if (value.node_token_id !== undefined) {
    if (!isNonEmptyString(value.node_token_id)) return undefined;
    record.node_token_id = value.node_token_id;
  }
  if (value.alias !== undefined) {
    if (!isNonEmptyString(value.alias)) return undefined;
    record.alias = value.alias;
  }
  if (value.ca_file !== undefined) {
    if (!isNonEmptyString(value.ca_file)) return undefined;
    record.ca_file = value.ca_file;
  }
  if (value.last_seen !== undefined) {
    if (!isFiniteNumber(value.last_seen)) return undefined;
    record.last_seen = value.last_seen;
  }
  if (value.last_error !== undefined) {
    if (!isNonEmptyString(value.last_error)) return undefined;
    record.last_error = value.last_error;
  }
  if (value.incarnation !== undefined) {
    if (!isNonEmptyString(value.incarnation)) return undefined;
    record.incarnation = value.incarnation;
  }
  if (value.revision !== undefined) {
    if (!isFiniteNumber(value.revision) || value.revision < 0) return undefined;
    record.revision = Math.floor(value.revision);
  }
  return record;
}

/** 强制数组上限；counts 保留节点报告的总数。 */
function applyBounds(record: HubNodeRecord): HubNodeRecord {
  const overTeams = record.teams.length > HUB_MAX_TEAMS;
  const overAgents = record.agents.length > HUB_MAX_AGENTS;
  if (!overTeams && !overAgents) return record;
  return {
    ...record,
    teams: overTeams ? record.teams.slice(0, HUB_MAX_TEAMS) : record.teams,
    agents: overAgents ? record.agents.slice(0, HUB_MAX_AGENTS) : record.agents,
    truncated: true,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function registryPath(dataDir: string): string {
  return join(dataDir, HUB_REGISTRY_FILE);
}

class HubRegistryImpl implements HubRegistry {
  private readonly path: string;
  private readonly hubId: string;
  private readonly logger: Logger | undefined;
  private readonly clock: () => number;
  private readonly debounceMs: number;

  private readonly nodes = new Map<string, HubNodeRecord>();
  private readonly listeners = new Set<HubRegistryListener>();
  private updatedAt: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: CreateHubRegistryOptions) {
    this.path = registryPath(options.dataDir);
    this.hubId = options.hubId;
    this.logger = options.logger;
    this.clock = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? HUB_REGISTRY_DEBOUNCE_MS;
    this.updatedAt = this.clock();
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        this.nodes.clear();
        this.updatedAt = this.clock();
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HubRegistryCorruptError(this.path, 'invalid JSON');
    }
    if (!isRecord(parsed)) {
      throw new HubRegistryCorruptError(this.path, 'not a JSON object');
    }
    if (parsed.v !== 1) {
      throw new HubRegistryCorruptError(this.path, 'unsupported version');
    }
    if (!isNonEmptyString(parsed.hub_id)) {
      throw new HubRegistryCorruptError(this.path, 'invalid hub_id');
    }
    if (parsed.hub_id !== this.hubId) {
      throw new HubRegistryCorruptError(this.path, 'hub_id mismatch');
    }
    if (!isFiniteNumber(parsed.updated_at)) {
      throw new HubRegistryCorruptError(this.path, 'invalid updated_at');
    }
    if (!Array.isArray(parsed.nodes)) {
      throw new HubRegistryCorruptError(this.path, 'nodes must be an array');
    }

    const next = new Map<string, HubNodeRecord>();
    for (const item of parsed.nodes) {
      const record = parseNodeRecord(item);
      if (!record) {
        throw new HubRegistryCorruptError(this.path, 'invalid node record');
      }
      if (next.has(record.pairing_id)) {
        throw new HubRegistryCorruptError(this.path, 'duplicate pairing_id');
      }
      next.set(record.pairing_id, applyBounds(record));
    }

    this.nodes.clear();
    for (const [key, record] of next) this.nodes.set(key, record);
    this.updatedAt = parsed.updated_at;
  }

  snapshot(): HubRegistryFile {
    return {
      v: 1,
      hub_id: this.hubId,
      updated_at: this.updatedAt,
      nodes: this.list(),
    };
  }

  list(): HubNodeRecord[] {
    return [...this.nodes.values()].map((record) => clone(record));
  }

  get(pairingId: string): HubNodeRecord | undefined {
    const record = this.nodes.get(pairingId);
    return record ? clone(record) : undefined;
  }

  upsert(record: HubNodeRecord): HubNodeRecord {
    const parsed = parseNodeRecord(record);
    if (!parsed) {
      throw new Error('hub_registry_invalid_record: record does not match HubNodeRecord');
    }
    const bounded = applyBounds(parsed);
    this.nodes.set(bounded.pairing_id, bounded);
    this.updatedAt = this.clock();
    this.emit({ type: 'upsert', pairing_id: bounded.pairing_id });
    this.scheduleWrite();
    return clone(bounded);
  }

  patch(pairingId: string, patch: HubNodePatch): HubNodeRecord | undefined {
    const existing = this.nodes.get(pairingId);
    if (!existing) return undefined;

    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value;
    }
    // 主键与身份字段不可经 patch 改写。
    merged.pairing_id = existing.pairing_id;
    merged.node_id = existing.node_id;
    merged.tenant_id = existing.tenant_id;

    // url / public_url 变化时重新派生 data_plane；显式提供的 data_plane 优先。
    const patchHasDataPlane = patch.data_plane !== undefined;
    const patchTouchesUrls = patch.url !== undefined || patch.public_url !== undefined;
    if (patchTouchesUrls && !patchHasDataPlane) delete merged.data_plane;

    const parsed = parseNodeRecord(merged);
    if (!parsed) {
      throw new Error('hub_registry_invalid_record: patch produces an invalid record');
    }
    const bounded = applyBounds(parsed);
    this.nodes.set(pairingId, bounded);
    this.updatedAt = this.clock();
    this.emit({ type: 'patch', pairing_id: pairingId });
    this.scheduleWrite();
    return clone(bounded);
  }

  remove(pairingId: string): HubNodeRecord | undefined {
    const existing = this.nodes.get(pairingId);
    if (!existing) return undefined;
    this.nodes.delete(pairingId);
    this.updatedAt = this.clock();
    this.emit({ type: 'remove', pairing_id: pairingId });
    this.scheduleWrite();
    return clone(existing);
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.enqueueWrite();
  }

  subscribe(listener: HubRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: HubRegistryEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn('hub.registry.listener_failed', {
          pairing_id: event.pairing_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private scheduleWrite(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueueWrite();
    }, this.debounceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 串行写；失败只记日志并保留内存态，下一次变更重试。 */
  private enqueueWrite(): Promise<void> {
    const task = async (): Promise<void> => {
      try {
        await this.writeNow();
      } catch (error) {
        this.logger?.warn('hub.registry.write_failed', {
          path: this.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    this.writeChain = this.writeChain.then(task, task);
    return this.writeChain;
  }

  private async writeNow(): Promise<void> {
    const body = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    await atomicWrite(this.path, body, { mode: 0o600, ensureDir: true });
  }
}

/** 创建注册表实例；调用方随后 `await registry.load()`。 */
export function createHubRegistry(options: CreateHubRegistryOptions): HubRegistry {
  return new HubRegistryImpl(options);
}
