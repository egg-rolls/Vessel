/**
 * q-fed-simple：node 侧 federation 一次性配对码 `<dataDir>/federation-pair.json`。
 *
 * 语义与 hub `join-store.ts` 同范式（该文明确「只复用 code 生成与 TTL 常量」，
 * 这里照做）：
 * - 文件只存 `sha256(code)`；明文 code 只在 `issue()` 返回值 / CLI 输出出现一次。
 * - 消费顺序固定：hash → 未使用 → 未过期；成功时**先原子写 `used_at` 再返回**。
 * - 单进程 single-flight：同一文件的并发消费串行执行，同一 code 只成功一次。
 * - 文件缺失 → `pairing_not_found`；损坏 → `federation_pair_corrupt`。
 *
 * 与 hub join code 的区别：不绑定 hub_id（node ↔ node 直连，hub 不在数据面），
 * 消费时记录发起方 node_id 供审计。
 *
 * @module vessel/federation-pair-store
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite } from '@vessel-agent/core';
import {
  createPairingCode,
  PAIRING_DEFAULT_TTL_S,
  PAIRING_MAX_TTL_S,
  PAIRING_MIN_TTL_S,
} from '../hub/pairing-code';

/** 配对码文件名（node data dir 根）。 */
export const FEDERATION_PAIR_FILE = 'federation-pair.json';

/** 易读码字母表：去掉 0/O/1/I（与 `createPairingCode` 一致）。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface FederationPairFile {
  v: 1;
  code_hash: string;
  expires_at: number;
  used_at?: number;
  /** 消费方（发起配对的远端 node_id）；只作审计，不参与校验。 */
  node_id?: string;
}

export interface FederationPairIssue {
  code: string;
  expires_at: number;
}

export type FederationPairErrorCode =
  | 'pairing_not_found'
  | 'pairing_invalid'
  | 'pairing_used'
  | 'pairing_expired'
  | 'federation_pair_corrupt';

function pairError(code: FederationPairErrorCode, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code });
}

/** `<dataDir>/federation-pair.json` 路径。 */
export function federationPairPath(dataDir: string): string {
  return join(dataDir, FEDERATION_PAIR_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 归一化用户输入：大小写、空白与连字符都不敏感。非法形状返回 null。 */
function normalizePairCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const compact = code.trim().toUpperCase().replace(/[-\s]/g, '');
  if (compact.length !== CODE_LENGTH) return null;
  for (const char of compact) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function hashPairCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) {
    return PAIRING_DEFAULT_TTL_S;
  }
  return Math.min(PAIRING_MAX_TTL_S, Math.max(PAIRING_MIN_TTL_S, Math.floor(ttlSeconds)));
}

function parsePairFile(raw: string, path: string): FederationPairFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw pairError('federation_pair_corrupt', `${path}: invalid JSON`);
  }
  if (!isRecord(parsed) || parsed.v !== 1) {
    throw pairError('federation_pair_corrupt', `${path}: unsupported envelope`);
  }
  const codeHash = parsed.code_hash;
  if (typeof codeHash !== 'string' || !HASH_RE.test(codeHash)) {
    throw pairError('federation_pair_corrupt', `${path}: invalid code_hash`);
  }
  if (!isFiniteNumber(parsed.expires_at)) {
    throw pairError('federation_pair_corrupt', `${path}: invalid expires_at`);
  }
  if (parsed.used_at !== undefined && !isFiniteNumber(parsed.used_at)) {
    throw pairError('federation_pair_corrupt', `${path}: invalid used_at`);
  }
  if (
    parsed.node_id !== undefined &&
    (typeof parsed.node_id !== 'string' || parsed.node_id === '')
  ) {
    throw pairError('federation_pair_corrupt', `${path}: invalid node_id`);
  }
  const file: FederationPairFile = {
    v: 1,
    code_hash: codeHash,
    expires_at: parsed.expires_at,
  };
  if (parsed.used_at !== undefined) file.used_at = parsed.used_at;
  if (parsed.node_id !== undefined) file.node_id = parsed.node_id;
  return file;
}

async function readPairFile(path: string): Promise<FederationPairFile | 'missing'> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  return parsePairFile(raw, path);
}

/** 进程内按 resolved 路径串行化消费。 */
const pendingConsumes = new Map<string, Promise<unknown>>();

function withConsumeLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = pendingConsumes.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  pendingConsumes.set(key, tail);
  void tail.then(() => {
    if (pendingConsumes.get(key) === tail) pendingConsumes.delete(key);
  });
  return run;
}

export interface FederationPairStore {
  /** 出新码（覆盖旧码；旧码立刻失效）。明文只在返回值出现一次。 */
  issue(input?: { ttl_s?: number }): Promise<FederationPairIssue>;
  /** 消费码；只成功一次。失败抛带稳定 code 的错误。 */
  consume(input: { code: string; node_id: string }): Promise<{ node_id: string }>;
}

/**
 * node 侧配对码存储。`issue()` 由本机 CLI 调用（无 HTTP 领码面）；
 * `consume()` 由入站 pair 路由调用。
 */
export function createFederationPairStore(options: {
  dataDir: string;
  now?: () => number;
}): FederationPairStore {
  const path = federationPairPath(options.dataDir);
  const now = options.now ?? Date.now;

  async function issue(input?: { ttl_s?: number }): Promise<FederationPairIssue> {
    const issuedAt = now();
    const ttlSeconds = clampTtl(input?.ttl_s);
    const code = createPairingCode();
    const file: FederationPairFile = {
      v: 1,
      code_hash: hashPairCode(code),
      expires_at: issuedAt + ttlSeconds * 1000,
    };
    await atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
    return { code, expires_at: file.expires_at };
  }

  async function consume(input: { code: string; node_id: string }): Promise<{ node_id: string }> {
    const normalized = normalizePairCode(input.code);
    if (normalized === null) {
      throw pairError('pairing_invalid', 'malformed code');
    }
    const digest = Buffer.from(hashPairCode(normalized), 'hex');

    return withConsumeLock(path, async () => {
      const current = await readPairFile(path);
      if (current === 'missing') {
        throw pairError('pairing_not_found', path);
      }
      const stored = Buffer.from(current.code_hash, 'hex');
      if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
        throw pairError('pairing_invalid', 'code does not match');
      }
      if (current.used_at !== undefined) {
        throw pairError('pairing_used', 'code already consumed');
      }
      const consumedAt = now();
      if (current.expires_at <= consumedAt) {
        throw pairError('pairing_expired', 'code expired');
      }
      const updated: FederationPairFile = {
        ...current,
        used_at: consumedAt,
        node_id: input.node_id,
      };
      await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`, {
        mode: 0o600,
        ensureDir: true,
      });
      return { node_id: input.node_id };
    });
  }

  return { issue, consume };
}
