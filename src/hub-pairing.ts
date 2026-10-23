/**
 * 节点侧一次性配对码 `<dataDir>/hub-pairing.json`（S5）。
 *
 * - 文件只存 `sha256(code)`；明文配对码只在 `writePairingFile()` 返回值中出现。
 * - 消费顺序固定：校验 hash → 未使用 → 未过期 → **先原子写 `used_at` 再返回**。
 * - 单进程 single-flight：同一文件的并发消费串行执行，同一 code 只成功一次。
 * - 文件损坏 fail-closed（`pairing_corrupt`），不得重新生成覆盖。
 *
 * @module vessel/hub-pairing
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite } from '@vessel-agent/core';

/** 易读码字母表：去掉 0/O/1/I。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const HASH_RE = /^[0-9a-f]{64}$/;

export const PAIRING_DEFAULT_TTL_S = 300;
export const PAIRING_MIN_TTL_S = 60;
export const PAIRING_MAX_TTL_S = 3600;

/** `<dataDir>/hub-pairing.json` 的形状。 */
export interface HubPairingFile {
  v: 1;
  code_hash: string;
  tenant_id: string;
  expires_at: number;
  used_at?: number;
}

export interface WritePairingFileOptions {
  dataDir: string;
  tenantId: string;
  /** 缺省 300；clamp 到 60..3600 */
  ttlSeconds?: number;
  now?: number;
}

export interface ConsumePairingCodeOptions {
  dataDir: string;
  code: string;
  now?: number;
}

export interface ConsumedPairing {
  tenant_id: string;
  expires_at: number;
}

/** 配对文件路径。 */
export function pairingFilePath(dataDir: string): string {
  return join(dataDir, 'hub-pairing.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

export type PairingErrorCode =
  | 'pairing_not_found'
  | 'pairing_invalid'
  | 'pairing_expired'
  | 'pairing_used'
  | 'pairing_corrupt';

function pairingError(code: PairingErrorCode, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code });
}

/** 生成 `XXXX-XXXX` 的易读配对码（不含 0/O/1/I）。 */
export function createPairingCode(): string {
  let compact = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    compact += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

/**
 * 归一化用户输入：大小写、空白与连字符都不敏感。
 * 非法形状返回 null（调用方映射为 `pairing_invalid`）。
 */
function normalizePairingCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const compact = code.trim().toUpperCase().replace(/[-\s]/g, '');
  if (compact.length !== CODE_LENGTH) return null;
  for (const char of compact) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function hashPairingCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) {
    return PAIRING_DEFAULT_TTL_S;
  }
  return Math.min(PAIRING_MAX_TTL_S, Math.max(PAIRING_MIN_TTL_S, Math.floor(ttlSeconds)));
}

function parsePairingFile(raw: string, path: string): HubPairingFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw pairingError('pairing_corrupt', `${path}: invalid JSON`);
  }
  if (!isRecord(parsed)) throw pairingError('pairing_corrupt', `${path}: not a JSON object`);
  if (parsed.v !== 1) throw pairingError('pairing_corrupt', `${path}: unsupported version`);

  const codeHash = parsed.code_hash;
  if (typeof codeHash !== 'string' || !HASH_RE.test(codeHash)) {
    throw pairingError('pairing_corrupt', `${path}: invalid code_hash`);
  }
  const tenantId = parsed.tenant_id;
  if (typeof tenantId !== 'string' || tenantId === '') {
    throw pairingError('pairing_corrupt', `${path}: invalid tenant_id`);
  }
  const expiresAt = parsed.expires_at;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw pairingError('pairing_corrupt', `${path}: invalid expires_at`);
  }
  const usedAt = parsed.used_at;
  if (usedAt !== undefined && (typeof usedAt !== 'number' || !Number.isFinite(usedAt))) {
    throw pairingError('pairing_corrupt', `${path}: invalid used_at`);
  }

  const file: HubPairingFile = {
    v: 1,
    code_hash: codeHash,
    tenant_id: tenantId,
    expires_at: expiresAt,
  };
  if (usedAt !== undefined) file.used_at = usedAt;
  return file;
}

async function readPairingFile(path: string): Promise<HubPairingFile | 'missing'> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  return parsePairingFile(raw, path);
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

/**
 * 生成并持久化一次性配对码；返回明文码。
 * 再次调用会覆盖旧文件（旧码随之失效）。
 */
export async function writePairingFile(options: WritePairingFileOptions): Promise<string> {
  const path = pairingFilePath(options.dataDir);
  const now = options.now ?? Date.now();
  const ttlSeconds = clampTtl(options.ttlSeconds);
  const code = createPairingCode();
  const file: HubPairingFile = {
    v: 1,
    code_hash: hashPairingCode(code),
    tenant_id: options.tenantId,
    expires_at: now + ttlSeconds * 1000,
  };
  await atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
    ensureDir: true,
  });
  return code;
}

/**
 * 消费配对码。
 *
 * 成功时先原子写 `used_at`，写成功后才返回；并发同 code 只有一次成功，
 * 其余按 `pairing_used` 失败。
 */
export async function consumePairingCode(
  options: ConsumePairingCodeOptions,
): Promise<ConsumedPairing> {
  const normalized = normalizePairingCode(options.code);
  if (normalized === null) {
    throw pairingError('pairing_invalid', 'malformed code');
  }

  const path = pairingFilePath(options.dataDir);
  const digest = Buffer.from(hashPairingCode(normalized), 'hex');

  return withConsumeLock(path, async () => {
    const current = await readPairingFile(path);
    if (current === 'missing') {
      throw pairingError('pairing_not_found', path);
    }

    const stored = Buffer.from(current.code_hash, 'hex');
    if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
      throw pairingError('pairing_invalid', 'code does not match');
    }
    if (current.used_at !== undefined) {
      throw pairingError('pairing_used', 'code already consumed');
    }
    const now = options.now ?? Date.now();
    if (current.expires_at <= now) {
      throw pairingError('pairing_expired', 'code expired');
    }

    const updated: HubPairingFile = { ...current, used_at: now };
    await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
    return { tenant_id: current.tenant_id, expires_at: current.expires_at };
  });
}
