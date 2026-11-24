/**
 * q-fed-simple：用户配置 `federation.peers` 的共享读写（锁 + 原子写）。
 *
 * 从 `src/cli/commands/federation-peer.ts` 抽出的同口径实现，供三处共用：
 * - `federation peer add|remove`（手工管理）；
 * - 入站配对握手（target 侧自动写 peer）；
 * - `federation join`（initiator 侧自动写 peer）。
 *
 * 规则不变：peers 是对象数组，不走标量 config.set 白名单；withConfigLock 跨进程锁 +
 * 原子写保留其它键；原始数组里的非对象条目原样保留（绝不静默丢用户数据）；
 * 只写 validator 合法键（snake_case），绝不写 token 值。
 *
 * @module vessel/federation-peer-store
 */

import {
  readUserConfigRoot,
  withConfigLock,
  writeUserConfigRoot,
} from '../../packages/config/src/index';

/** 带稳定 code 的存储错误（锁内抛出，调用方统一转 exitCode / HTTP）。 */
export class FederationPeerStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'FederationPeerStoreError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** YAML 里 peer 条目的身份（snake_case 为准，容忍手写 camelCase）。 */
export function entryIdentity(entry: Record<string, unknown>): {
  nodeId?: string;
  teamId?: string;
} {
  const nodeId = entry.node_id ?? entry.nodeId;
  const teamId = entry.team_id ?? entry.teamId;
  return {
    ...(typeof nodeId === 'string' ? { nodeId } : {}),
    ...(typeof teamId === 'string' ? { teamId } : {}),
  };
}

export function entryLabel(entry: Record<string, unknown>): string {
  const { nodeId, teamId } = entryIdentity(entry);
  return `${nodeId ?? '?'}:${teamId ?? '?'}`;
}

/**
 * 读用户配置里的 federation.peers 原始条目（锁内调用）。
 * 返回**原始数组**（含非对象条目）：写回时原样保留，绝不静默丢用户数据。
 */
export function readPeerEntries(root: Record<string, unknown>): unknown[] {
  const federation = root.federation;
  if (federation === undefined || federation === null) return [];
  if (!isRecord(federation)) {
    throw new FederationPeerStoreError(
      'federation_peer_invalid_config',
      'federation block in user config is not an object',
    );
  }
  const peers = federation.peers;
  if (peers === undefined || peers === null) return [];
  if (!Array.isArray(peers)) {
    throw new FederationPeerStoreError(
      'federation_peer_invalid_config',
      'federation.peers in user config is not an array',
    );
  }
  return peers;
}

/** 写回 federation.peers（保留 federation 块与其它根键；空数组保留为 []）。 */
export function withPeerEntries(
  root: Record<string, unknown>,
  entries: unknown[],
): Record<string, unknown> {
  const federation = isRecord(root.federation) ? root.federation : {};
  return { ...root, federation: { ...federation, peers: entries } };
}

/** 合法 peer 条目（snake_case；token 只允许 token_env 名或 token_secret 开关）。 */
export interface FederationPeerEntryInput {
  nodeId: string;
  teamId: string;
  url?: string;
  tokenEnv?: string;
  tokenSecret?: boolean;
  direction?: 'in' | 'out' | 'both';
  localTeamId?: string;
  allowDirectory?: boolean;
  caFile?: string;
}

/** 只写 validator FEDERATION_PEER_KEYS 的 snake_case 形；绝不写 token 值。 */
export function peerEntryOf(input: FederationPeerEntryInput): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    node_id: input.nodeId,
    team_id: input.teamId,
    direction: input.direction ?? 'both',
    allow_directory: input.allowDirectory === true,
  };
  if (input.tokenSecret === true) entry.token_secret = true;
  else if (input.tokenEnv !== undefined) entry.token_env = input.tokenEnv;
  if (input.url !== undefined) entry.url = input.url;
  if (input.localTeamId !== undefined) entry.local_team_id = input.localTeamId;
  if (input.caFile !== undefined) entry.ca_file = input.caFile;
  return entry;
}

/**
 * 锁内 upsert：同 `(node_id, team_id)` 已存在 ⇒ 整条替换（配对轮转 / 修复），
 * 否则追加。返回是否新建。调用方负责随后的热应用。
 */
export async function upsertPeerEntry(
  configPath: string,
  input: FederationPeerEntryInput,
): Promise<{ created: boolean }> {
  let created = false;
  await withConfigLock(configPath, async () => {
    const root = await readUserConfigRoot(configPath);
    const entries = readPeerEntries(root);
    const entry = peerEntryOf(input);
    const index = entries.findIndex((candidate) => {
      if (!isRecord(candidate)) return false;
      const identity = entryIdentity(candidate);
      return identity.nodeId === input.nodeId && identity.teamId === input.teamId;
    });
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
      created = true;
    }
    await writeUserConfigRoot(configPath, withPeerEntries(root, entries));
  });
  return { created };
}
