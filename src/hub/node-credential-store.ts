/**
 * Hub 侧 node token 存储 `<hubDataDir>/node-tokens.json`（S5.1）。
 *
 * hub 签发、node 持有明文（SecretStore）；这里只存 `sha256(token)` 的 hex。
 *
 * - 文件缺失视为空集；损坏 / 字段非法抛 `hub_node_tokens_corrupt`，不得静默当空。
 * - 先持久化、后更新内存：写失败不会留下“内存已生效、磁盘没有”的状态。
 * - `authenticate` 同步且常量时间比较（WS 首帧用）。
 * - 错误信息只带路径 / 索引 / 字段名，绝不带 `token_hash`。
 *
 * @module vessel/hub/node-credential-store
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import type {
  HubNodeCredentialStoreLike,
  HubNodeTokenRecord,
  HubNodeTokensFile,
  IssuedHubNodeToken,
} from './types';

/** node token 文件名（hub data dir 根）。 */
export const HUB_NODE_TOKENS_FILE = 'node-tokens.json';

/** 未显式给 TTL 时的缺省值：30 天。 */
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const HASH_RE = /^[0-9a-f]{64}$/;

export interface CreateHubNodeCredentialStoreOptions {
  /** hub data dir */
  dataDir: string;
  /** 可注入时钟（测试用）；缺省 `Date.now` */
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function corrupt(path: string, reason: string): Error {
  return Object.assign(new Error(`hub_node_tokens_corrupt: ${path}: ${reason}`), {
    code: 'hub_node_tokens_corrupt' as const,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `<hubDataDir>/node-tokens.json` 路径。 */
export function hubNodeTokensPath(dataDir: string): string {
  return join(dataDir, HUB_NODE_TOKENS_FILE);
}

/** `sha256(token)` 的小写 hex；与落盘字段一致。 */
export function hashHubNodeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseRecord(raw: unknown, path: string, index: number): HubNodeTokenRecord {
  if (!isRecord(raw)) throw corrupt(path, `tokens[${index}] is not an object`);

  const tokenId = raw.token_id;
  if (!isNonEmptyString(tokenId)) throw corrupt(path, `tokens[${index}].token_id invalid`);

  const tokenHash = raw.token_hash;
  if (typeof tokenHash !== 'string' || !HASH_RE.test(tokenHash)) {
    throw corrupt(path, `tokens[${index}].token_hash invalid`);
  }

  const scope = raw.scope;
  if (scope !== 'node') throw corrupt(path, `tokens[${index}].scope invalid`);

  const hubId = raw.hub_id;
  if (!isNonEmptyString(hubId)) throw corrupt(path, `tokens[${index}].hub_id invalid`);

  const nodeId = raw.node_id;
  if (!isNonEmptyString(nodeId)) throw corrupt(path, `tokens[${index}].node_id invalid`);

  const tenantId = raw.tenant_id;
  if (!isNonEmptyString(tenantId)) throw corrupt(path, `tokens[${index}].tenant_id invalid`);

  const pairingId = raw.pairing_id;
  if (!isNonEmptyString(pairingId)) throw corrupt(path, `tokens[${index}].pairing_id invalid`);

  const issuedBy = raw.issued_by;
  if (!isNonEmptyString(issuedBy)) throw corrupt(path, `tokens[${index}].issued_by invalid`);

  const createdAt = raw.created_at;
  if (!isFiniteNumber(createdAt)) throw corrupt(path, `tokens[${index}].created_at invalid`);

  const expiresAt = raw.expires_at;
  if (!isFiniteNumber(expiresAt)) throw corrupt(path, `tokens[${index}].expires_at invalid`);

  const revokedAt = raw.revoked_at;
  if (revokedAt !== undefined && !isFiniteNumber(revokedAt)) {
    throw corrupt(path, `tokens[${index}].revoked_at invalid`);
  }

  const record: HubNodeTokenRecord = {
    token_id: tokenId,
    token_hash: tokenHash,
    scope: 'node',
    hub_id: hubId,
    node_id: nodeId,
    tenant_id: tenantId,
    pairing_id: pairingId,
    issued_by: issuedBy,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  if (revokedAt !== undefined) record.revoked_at = revokedAt;
  return record;
}

function parseTokensFile(raw: string, path: string): HubNodeTokenRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corrupt(path, 'invalid JSON');
  }
  if (!isRecord(parsed)) throw corrupt(path, 'not a JSON object');
  if (parsed.v !== 1) throw corrupt(path, 'unsupported version');
  const tokens = parsed.tokens;
  if (!Array.isArray(tokens)) throw corrupt(path, 'tokens is not an array');
  return tokens.map((entry, index) => parseRecord(entry, path, index));
}

async function readTokensFile(path: string): Promise<HubNodeTokenRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  return parseTokensFile(raw, path);
}

/**
 * 打开 hub 侧 node token 存储；加载完成前不返回。
 *
 * 文件缺失 → 空集；损坏 → 抛 `hub_node_tokens_corrupt`。
 */
export async function createHubNodeCredentialStore(
  options: CreateHubNodeCredentialStoreOptions,
): Promise<HubNodeCredentialStoreLike> {
  const path = hubNodeTokensPath(options.dataDir);
  const now = options.now ?? Date.now;
  let records = await readTokensFile(path);
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(tokenId: string) => void>();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function persist(next: HubNodeTokenRecord[]): Promise<void> {
    const body: HubNodeTokensFile = { v: 1, tokens: next };
    await atomicWrite(path, `${JSON.stringify(body, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
  }

  function authenticate(token: string): HubNodeTokenRecord | null {
    if (typeof token !== 'string' || token === '') return null;
    const digest = createHash('sha256').update(token).digest();
    const at = now();

    let matched: HubNodeTokenRecord | undefined;
    for (const record of records) {
      const stored = Buffer.from(record.token_hash, 'hex');
      if (stored.length !== digest.length) continue;
      // 不提前返回：避免按 token 在文件中的位置泄漏时序信息。
      if (timingSafeEqual(stored, digest)) matched = record;
    }
    if (matched === undefined) return null;
    if (matched.revoked_at !== undefined) return null;
    if (matched.expires_at <= at) return null;
    return { ...matched };
  }

  async function issue(input: {
    hub_id: string;
    node_id: string;
    tenant_id: string;
    pairing_id: string;
    ttl_ms?: number;
  }): Promise<IssuedHubNodeToken> {
    return enqueue(async () => {
      const issuedAt = now();
      const expiresAt = issuedAt + (input.ttl_ms ?? DEFAULT_TOKEN_TTL_MS);
      const token = randomBytes(32).toString('base64url');
      const record: HubNodeTokenRecord = {
        token_id: randomUUID(),
        token_hash: hashHubNodeToken(token),
        scope: 'node',
        hub_id: input.hub_id,
        node_id: input.node_id,
        tenant_id: input.tenant_id,
        pairing_id: input.pairing_id,
        issued_by: 'join',
        created_at: issuedAt,
        expires_at: expiresAt,
      };

      const next = [...records, record];
      await persist(next);
      records = next;
      return {
        token,
        token_id: record.token_id,
        expires_at: expiresAt,
        scope: 'node',
        hub_id: record.hub_id,
        node_id: record.node_id,
        tenant_id: record.tenant_id,
        pairing_id: record.pairing_id,
      };
    });
  }

  async function revoke(
    tokenId: string,
  ): Promise<{ token_id: string; revoked_at: number; changed: boolean } | null> {
    return enqueue(async () => {
      const index = records.findIndex((record) => record.token_id === tokenId);
      if (index === -1) return null;
      const current = records[index];
      if (current === undefined) return null;
      if (current.revoked_at !== undefined) {
        return { token_id: tokenId, revoked_at: current.revoked_at, changed: false };
      }

      const revokedAt = now();
      const next = records.slice();
      next[index] = { ...current, revoked_at: revokedAt };
      await persist(next);
      records = next;
      for (const listener of listeners) listener(tokenId);
      return { token_id: tokenId, revoked_at: revokedAt, changed: true };
    });
  }

  async function revokePairing(pairingId: string): Promise<number> {
    return enqueue(async () => {
      const revokedAt = now();
      const changedIds: string[] = [];
      const next = records.map((record) => {
        if (record.pairing_id !== pairingId || record.revoked_at !== undefined) return record;
        changedIds.push(record.token_id);
        return { ...record, revoked_at: revokedAt };
      });
      if (changedIds.length === 0) return 0;

      await persist(next);
      records = next;
      for (const tokenId of changedIds) {
        for (const listener of listeners) listener(tokenId);
      }
      return changedIds.length;
    });
  }

  function list(): HubNodeTokenRecord[] {
    return records.map((record) => ({ ...record }));
  }

  function onRevoke(listener: (tokenId: string) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { issue, authenticate, revoke, revokePairing, list, onRevoke };
}
