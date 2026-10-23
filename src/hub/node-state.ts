/**
 * 节点出站状态文件（S5.1）。
 *
 * - `<dataDir>/hub-node.json`（`HubNodeState`）：join 结果里的**非秘密**字段；
 *   缺失 = 未 join；损坏 / 版本或字段非法 → `hub_node_state_corrupt` fail-closed。
 *   写入按白名单构造，token 永远不会落进这个文件。
 * - `<dataDir>/hub-node-status.json`：出站连接状态（advisory）；损坏时返回
 *   undefined，不让一个状态文件阻塞 gateway 启动。
 *
 * 两个文件都是 0600 atomicWrite。
 *
 * @module vessel/hub/node-state
 */

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import { type HubNodeState, type HubNodeStatus, pairingIdFor } from './types.js';

/** `HubNodeState` 文件名（gateway data dir 根）。 */
export const HUB_NODE_STATE_FILE = 'hub-node.json';

/** 出站连接状态文件名（gateway data dir 根）。 */
export const HUB_NODE_STATUS_FILE = 'hub-node-status.json';

/** 状态文件只记录客户端自己会报告的五种状态。 */
export type HubNodeOutboundStatus = Extract<
  HubNodeStatus,
  'connecting' | 'healthy' | 'unreachable' | 'unauthorized' | 'incompatible'
>;

/** `<dataDir>/hub-node-status.json`；`last_error` 是稳定错误码，不含正文。 */
export interface HubNodeStatusFile {
  v: 1;
  status: HubNodeOutboundStatus;
  last_error?: string;
  updated_at: number;
  hello_at?: number;
}

/** 稳定错误：`hub-node.json` 损坏 / 版本或字段非法。 */
export class HubNodeStateCorruptError extends Error {
  readonly code = 'hub_node_state_corrupt' as const;
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`hub_node_state_corrupt: ${path}: ${reason}`);
    this.name = 'HubNodeStateCorruptError';
    this.path = path;
  }
}

const OUTBOUND_STATUSES = new Set<HubNodeOutboundStatus>([
  'connecting',
  'healthy',
  'unreachable',
  'unauthorized',
  'incompatible',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function statePath(dataDir: string): string {
  return join(dataDir, HUB_NODE_STATE_FILE);
}

function statusPath(dataDir: string): string {
  return join(dataDir, HUB_NODE_STATUS_FILE);
}

/** 只按白名单解析；未知字段（尤其 token）一律丢弃。 */
function parseState(value: unknown): HubNodeState | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;

  const hubUrl = value.hub_url;
  const hubId = value.hub_id;
  const nodeId = value.node_id;
  const tenantId = value.tenant_id;
  const pairingId = value.pairing_id;
  const tokenId = value.token_id;
  if (
    !isNonEmptyString(hubUrl) ||
    !isNonEmptyString(hubId) ||
    !isNonEmptyString(nodeId) ||
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(pairingId) ||
    !isNonEmptyString(tokenId)
  ) {
    return undefined;
  }
  if (pairingId !== pairingIdFor(nodeId, tenantId)) return undefined;
  if (!isFiniteNumber(value.expires_at) || !isFiniteNumber(value.joined_at)) {
    return undefined;
  }

  const state: HubNodeState = {
    v: 1,
    hub_url: hubUrl,
    hub_id: hubId,
    node_id: nodeId,
    tenant_id: tenantId,
    pairing_id: pairingId,
    token_id: tokenId,
    expires_at: value.expires_at,
    joined_at: value.joined_at,
  };

  for (const field of ['ca_file', 'public_url', 'alias'] as const) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    if (!isNonEmptyString(fieldValue)) return undefined;
    state[field] = fieldValue;
  }
  return state;
}

/** 写入时同样只保留白名单字段，避免把调用方对象的额外属性（如 token）落盘。 */
function toFileState(state: HubNodeState): HubNodeState {
  const out: HubNodeState = {
    v: 1,
    hub_url: state.hub_url,
    hub_id: state.hub_id,
    node_id: state.node_id,
    tenant_id: state.tenant_id,
    pairing_id: state.pairing_id,
    token_id: state.token_id,
    expires_at: state.expires_at,
    joined_at: state.joined_at,
  };
  if (state.ca_file !== undefined) out.ca_file = state.ca_file;
  if (state.public_url !== undefined) out.public_url = state.public_url;
  if (state.alias !== undefined) out.alias = state.alias;
  return out;
}

/** 读取 `hub-node.json`；缺失返回 undefined，损坏抛 `HubNodeStateCorruptError`。 */
export async function readHubNodeState(dataDir: string): Promise<HubNodeState | undefined> {
  const path = statePath(dataDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HubNodeStateCorruptError(path, 'invalid JSON');
  }
  const state = parseState(parsed);
  if (state === undefined) {
    throw new HubNodeStateCorruptError(path, 'invalid state');
  }
  return state;
}

/** 0600 原子写入 `hub-node.json`；只写白名单字段。 */
export async function writeHubNodeState(dataDir: string, state: HubNodeState): Promise<void> {
  await atomicWrite(statePath(dataDir), `${JSON.stringify(toFileState(state))}\n`, {
    mode: 0o600,
    ensureDir: true,
  });
}

/** 删除 `hub-node.json`；不存在视为成功。 */
export async function deleteHubNodeState(dataDir: string): Promise<void> {
  try {
    await unlink(statePath(dataDir));
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }
}

function parseStatus(value: unknown): HubNodeStatusFile | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  const status = value.status;
  if (typeof status !== 'string' || !OUTBOUND_STATUSES.has(status as HubNodeOutboundStatus)) {
    return undefined;
  }
  if (!isFiniteNumber(value.updated_at)) return undefined;

  const out: HubNodeStatusFile = {
    v: 1,
    status: status as HubNodeOutboundStatus,
    updated_at: value.updated_at,
  };
  if (value.last_error !== undefined) {
    if (!isNonEmptyString(value.last_error)) return undefined;
    out.last_error = value.last_error;
  }
  if (value.hello_at !== undefined) {
    if (!isFiniteNumber(value.hello_at)) return undefined;
    out.hello_at = value.hello_at;
  }
  return out;
}

/**
 * 读取 `hub-node-status.json`；缺失 / 损坏 / 字段非法都返回 undefined。
 * 状态是 advisory，不能让启动失败。
 */
export async function readHubNodeStatus(dataDir: string): Promise<HubNodeStatusFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(statusPath(dataDir), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseStatus(parsed);
}

/** 0600 原子写入 `hub-node-status.json`；只写白名单字段。 */
export async function writeHubNodeStatus(
  dataDir: string,
  status: HubNodeStatusFile,
): Promise<void> {
  const out: HubNodeStatusFile = {
    v: 1,
    status: status.status,
    updated_at: status.updated_at,
  };
  if (status.last_error !== undefined) out.last_error = status.last_error;
  if (status.hello_at !== undefined) out.hello_at = status.hello_at;
  await atomicWrite(statusPath(dataDir), `${JSON.stringify(out)}\n`, {
    mode: 0o600,
    ensureDir: true,
  });
}
