/**
 * 节点动态 token 存储 `<dataDir>/hub-tokens.json`（S5）。
 *
 * - 只存 `sha256(token)` 的 hex；明文只在 `issue()` 返回值中出现一次。
 * - 文件缺失视为空集；损坏 / 字段非法抛 `hub_tokens_corrupt`，不得静默当空。
 * - 先持久化、后更新内存：写失败不会留下“内存已生效、磁盘没有”的状态。
 *
 * @module vessel/node-token-store
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import type { Principal, PrincipalRole } from '../packages/config/src/index';
import type { NodeTokenMeta, NodeTokenScope } from '../packages/serve/src/index';

/** 一条 token 记录；`token_hash` 是 `sha256(token)` 的小写 hex。 */
export interface NodeTokenRecord {
  token_id: string;
  token_hash: string;
  scope: NodeTokenScope;
  tenant_id: string;
  hub_id?: string;
  team_id?: string;
  issued_by: string;
  created_at: number;
  expires_at: number;
  revoked_at?: number;
}

/** `<dataDir>/hub-tokens.json` 的形状。 */
export interface NodeTokensFile {
  v: 1;
  tokens: NodeTokenRecord[];
}

export interface NodeTokenStoreOptions {
  dataDir: string;
  /** 可注入时钟（测试用）；缺省 `Date.now`。 */
  now?: () => number;
}

export interface IssueNodeTokenOptions {
  /** 缺省 `node` */
  issued_by?: string;
  hub_id?: string;
  team_id?: string;
  /** 缺省 `PAIRING_TOKEN_TTL_MS`（30 天） */
  ttl_ms?: number;
  token_id?: string;
  /** 显式签发时刻；缺省取注入时钟 */
  now?: number;
}

export interface IssueNodeTokenResult {
  /** 明文 token；调用方必须只返回一次，不得落盘。 */
  token: string;
  record: NodeTokenRecord;
}

export interface RevokeNodeTokenResult {
  token_id: string;
  revoked_at: number;
  /** 本次调用是否真正改变了状态（幂等重复吊销为 false）。 */
  changed: boolean;
}

/** 未显式给 TTL 时的缺省值：30 天。 */
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const HASH_RE = /^[0-9a-f]{64}$/;
const SCOPES: readonly NodeTokenScope[] = ['view', 'exchange', 'control', 'admin'];

const SCOPE_ROLE: Record<NodeTokenScope, PrincipalRole> = {
  view: 'read',
  exchange: 'write',
  control: 'write',
  admin: 'admin',
};

/** token 存储文件路径。 */
export function hubTokensPath(dataDir: string): string {
  return join(dataDir, 'hub-tokens.json');
}

/** `sha256(token)` 的小写 hex；与落盘字段一致。 */
export function hashNodeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function corrupt(path: string, reason: string): Error {
  return Object.assign(new Error(`hub_tokens_corrupt: ${path}: ${reason}`), {
    code: 'hub_tokens_corrupt' as const,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRecord(raw: unknown, path: string, index: number): NodeTokenRecord {
  if (!isRecord(raw)) throw corrupt(path, `tokens[${index}] is not an object`);

  const tokenId = raw.token_id;
  if (!isNonEmptyString(tokenId)) throw corrupt(path, `tokens[${index}].token_id invalid`);

  const tokenHash = raw.token_hash;
  if (typeof tokenHash !== 'string' || !HASH_RE.test(tokenHash)) {
    throw corrupt(path, `tokens[${index}].token_hash invalid`);
  }

  const scope = raw.scope;
  if (typeof scope !== 'string' || !SCOPES.includes(scope as NodeTokenScope)) {
    throw corrupt(path, `tokens[${index}].scope invalid`);
  }

  const tenantId = raw.tenant_id;
  if (!isNonEmptyString(tenantId)) throw corrupt(path, `tokens[${index}].tenant_id invalid`);

  const hubId = raw.hub_id;
  if (hubId !== undefined && !isNonEmptyString(hubId)) {
    throw corrupt(path, `tokens[${index}].hub_id invalid`);
  }

  const teamId = raw.team_id;
  if (teamId !== undefined && !isNonEmptyString(teamId)) {
    throw corrupt(path, `tokens[${index}].team_id invalid`);
  }

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

  const record: NodeTokenRecord = {
    token_id: tokenId,
    token_hash: tokenHash,
    scope: scope as NodeTokenScope,
    tenant_id: tenantId,
    issued_by: issuedBy,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  if (hubId !== undefined) record.hub_id = hubId;
  if (teamId !== undefined) record.team_id = teamId;
  if (revokedAt !== undefined) record.revoked_at = revokedAt;
  return record;
}

function parseTokensFile(raw: string, path: string): NodeTokenRecord[] {
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

async function readTokensFile(path: string): Promise<NodeTokenRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return [];
    throw error;
  }
  return parseTokensFile(raw, path);
}

function toMeta(record: NodeTokenRecord): NodeTokenMeta {
  const meta: NodeTokenMeta = {
    token_id: record.token_id,
    scope: record.scope,
    tenant_id: record.tenant_id,
    issued_by: record.issued_by,
    created_at: record.created_at,
    expires_at: record.expires_at,
  };
  if (record.hub_id !== undefined) meta.hub_id = record.hub_id;
  if (record.team_id !== undefined) meta.team_id = record.team_id;
  if (record.revoked_at !== undefined) meta.revoked_at = record.revoked_at;
  return meta;
}

/**
 * 进程内 token 存储。`authenticate` / `hasTokens` 是同步的，
 * 调用方必须先 `await load()`（`createNodeTokenControl` 已处理）。
 */
export class NodeTokenStore {
  readonly dataDir: string;
  private readonly now: () => number;
  private records: NodeTokenRecord[] = [];
  private readonly listeners = new Set<(tokenId: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: NodeTokenStoreOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? Date.now;
  }

  /** 从磁盘重载；文件缺失清空内存态。损坏时抛 `hub_tokens_corrupt`。 */
  async load(): Promise<void> {
    this.records = await readTokensFile(hubTokensPath(this.dataDir));
  }

  /** 是否存在未吊销且未过期的 token（用于 gateway configured 判定）。 */
  hasTokens(): boolean {
    const now = this.now();
    return this.records.some(
      (record) => record.revoked_at === undefined && record.expires_at > now,
    );
  }

  /** 常量时间校验；吊销 / 过期 / 不存在一律返回 null。 */
  authenticate(token: string): Principal | null {
    if (typeof token !== 'string' || token === '') return null;
    const digest = createHash('sha256').update(token).digest();
    const now = this.now();

    let matched: NodeTokenRecord | undefined;
    for (const record of this.records) {
      const stored = Buffer.from(record.token_hash, 'hex');
      if (stored.length !== digest.length) continue;
      // 不提前返回：避免按 token 在文件中的位置泄漏时序信息。
      if (timingSafeEqual(stored, digest)) matched = record;
    }
    if (matched === undefined) return null;
    if (matched.revoked_at !== undefined) return null;
    if (matched.expires_at <= now) return null;

    const principal: Principal = {
      tenant_id: matched.tenant_id,
      role: SCOPE_ROLE[matched.scope],
      scope: matched.scope,
      token_id: matched.token_id,
    };
    if (matched.team_id !== undefined) principal.team_id = matched.team_id;
    if (matched.hub_id !== undefined) principal.hub_id = matched.hub_id;
    return principal;
  }

  /** 签发 token；先原子写盘，成功后更新内存并返回明文。 */
  async issue(
    scope: NodeTokenScope,
    tenantId: string,
    options: IssueNodeTokenOptions = {},
  ): Promise<IssueNodeTokenResult> {
    return this.enqueue(async () => {
      const now = options.now ?? this.now();
      const expiresAt = now + (options.ttl_ms ?? DEFAULT_TOKEN_TTL_MS);
      const token = randomBytes(32).toString('base64url');
      const record: NodeTokenRecord = {
        token_id: options.token_id ?? randomUUID(),
        token_hash: hashNodeToken(token),
        scope,
        tenant_id: tenantId,
        issued_by: options.issued_by ?? 'node',
        created_at: now,
        expires_at: expiresAt,
      };
      if (options.hub_id !== undefined) record.hub_id = options.hub_id;
      if (options.team_id !== undefined) record.team_id = options.team_id;

      const next = [...this.records, record];
      await this.persist(next);
      this.records = next;
      return { token, record: { ...record } };
    });
  }

  /**
   * 吊销 token；幂等。
   *
   * 返回 null 表示 `tokenId` 不存在；已吊销的 token 返回首次的 `revoked_at`
   * 且 `changed: false`。只有真正改变状态时才通知 `onRevoke`。
   */
  async revoke(tokenId: string): Promise<RevokeNodeTokenResult | null> {
    return this.enqueue(async () => {
      const index = this.records.findIndex((record) => record.token_id === tokenId);
      if (index === -1) return null;
      const current = this.records[index];
      if (current === undefined) return null;
      if (current.revoked_at !== undefined) {
        return { token_id: tokenId, revoked_at: current.revoked_at, changed: false };
      }

      const revokedAt = this.now();
      const updated: NodeTokenRecord = { ...current, revoked_at: revokedAt };
      const next = this.records.slice();
      next[index] = updated;
      await this.persist(next);
      this.records = next;
      for (const listener of this.listeners) listener(tokenId);
      return { token_id: tokenId, revoked_at: revokedAt, changed: true };
    });
  }

  /** 所有 token 元数据（不含 token / hash）。 */
  list(): NodeTokenMeta[] {
    return this.records.map(toMeta);
  }

  /** 注册吊销监听；返回取消函数。 */
  onRevoke(listener: (tokenId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(records: NodeTokenRecord[]): Promise<void> {
    const body: NodeTokensFile = { v: 1, tokens: records };
    await atomicWrite(hubTokensPath(this.dataDir), `${JSON.stringify(body, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
  }
}
