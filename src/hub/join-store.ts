/**
 * Hub 侧一次性 join code `<hubDataDir>/hub-join.json`（S5.1）。
 *
 * 与 S5 的 `src/hub-pairing.ts` 镜像但所有权相反：hub 生成 code，node 消费。
 * 因此这里不复用 `writePairingFile` / `consumePairingCode`（它们硬编码 node 侧
 * 路径与 tenant 语义），只复用 code 生成与 TTL 常量。
 *
 * - 文件只存 `sha256(code)`；明文 code 只在 `issue()` 返回值中出现一次。
 * - 消费顺序固定：hash → 未使用 → 未过期 → `hub_id` → `tenant_id`。
 * - 成功时**先原子写 `used_at` / `node_id` / `pairing_id` 再返回**。
 * - 单进程 single-flight：同一文件的并发消费串行执行，同一 code 只成功一次。
 * - 文件缺失 → `pairing_not_found`（不是发现端点）；损坏 → `hub_join_corrupt`。
 *
 * @module vessel/hub/join-store
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
} from '../hub-pairing';
import {
  type HubJoinConsumeResult,
  type HubJoinFile,
  type HubJoinIssue,
  type HubJoinStoreLike,
  pairingIdFor,
} from './types';

/** join code 文件名（hub data dir 根）。 */
export const HUB_JOIN_FILE = 'hub-join.json';

/** 易读码字母表：去掉 0/O/1/I（与 `createPairingCode` 一致）。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface CreateHubJoinStoreOptions {
  /** hub data dir */
  dataDir: string;
  /** 本 hub 身份；写入 code 文件并参与消费校验 */
  hubId: string;
  /** 可注入时钟（测试用）；缺省 `Date.now` */
  now?: () => number;
}

export type HubJoinErrorCode =
  | 'pairing_not_found'
  | 'pairing_invalid'
  | 'pairing_used'
  | 'pairing_expired'
  | 'tenant_mismatch'
  | 'hub_join_corrupt';

function joinError(code: HubJoinErrorCode, reason: string): Error {
  return Object.assign(new Error(`${code}: ${reason}`), { code });
}

/** `<hubDataDir>/hub-join.json` 路径。 */
export function hubJoinPath(dataDir: string): string {
  return join(dataDir, HUB_JOIN_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 归一化用户输入：大小写、空白与连字符都不敏感。非法形状返回 null。 */
function normalizeJoinCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const compact = code.trim().toUpperCase().replace(/[-\s]/g, '');
  if (compact.length !== CODE_LENGTH) return null;
  for (const char of compact) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function hashJoinCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function clampTtl(ttlSeconds: number | undefined): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) {
    return PAIRING_DEFAULT_TTL_S;
  }
  return Math.min(PAIRING_MAX_TTL_S, Math.max(PAIRING_MIN_TTL_S, Math.floor(ttlSeconds)));
}

function parseJoinFile(raw: string, path: string): HubJoinFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw joinError('hub_join_corrupt', `${path}: invalid JSON`);
  }
  if (!isRecord(parsed)) throw joinError('hub_join_corrupt', `${path}: not a JSON object`);
  if (parsed.v !== 1) throw joinError('hub_join_corrupt', `${path}: unsupported version`);

  const codeHash = parsed.code_hash;
  if (typeof codeHash !== 'string' || !HASH_RE.test(codeHash)) {
    throw joinError('hub_join_corrupt', `${path}: invalid code_hash`);
  }
  const hubId = parsed.hub_id;
  if (!isNonEmptyString(hubId)) throw joinError('hub_join_corrupt', `${path}: invalid hub_id`);
  const tenantId = parsed.tenant_id;
  if (!isNonEmptyString(tenantId)) {
    throw joinError('hub_join_corrupt', `${path}: invalid tenant_id`);
  }
  const expiresAt = parsed.expires_at;
  if (!isFiniteNumber(expiresAt)) {
    throw joinError('hub_join_corrupt', `${path}: invalid expires_at`);
  }
  const usedAt = parsed.used_at;
  if (usedAt !== undefined && !isFiniteNumber(usedAt)) {
    throw joinError('hub_join_corrupt', `${path}: invalid used_at`);
  }
  const nodeId = parsed.node_id;
  if (nodeId !== undefined && !isNonEmptyString(nodeId)) {
    throw joinError('hub_join_corrupt', `${path}: invalid node_id`);
  }
  const pairingId = parsed.pairing_id;
  if (pairingId !== undefined && !isNonEmptyString(pairingId)) {
    throw joinError('hub_join_corrupt', `${path}: invalid pairing_id`);
  }

  const file: HubJoinFile = {
    v: 1,
    code_hash: codeHash,
    hub_id: hubId,
    tenant_id: tenantId,
    expires_at: expiresAt,
  };
  if (usedAt !== undefined) file.used_at = usedAt;
  if (nodeId !== undefined) file.node_id = nodeId;
  if (pairingId !== undefined) file.pairing_id = pairingId;
  return file;
}

async function readJoinFile(path: string): Promise<HubJoinFile | 'missing'> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  return parseJoinFile(raw, path);
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
 * Hub 侧 join code 存储。
 *
 * `issue()` 覆盖旧 code；旧 code 随之失效。`consume()` 只成功一次。
 */
export function createHubJoinStore(options: CreateHubJoinStoreOptions): HubJoinStoreLike {
  const path = hubJoinPath(options.dataDir);
  const now = options.now ?? Date.now;

  async function issue(input: { tenant_id: string; ttl_s?: number }): Promise<HubJoinIssue> {
    const issuedAt = now();
    const ttlSeconds = clampTtl(input.ttl_s);
    const code = createPairingCode();
    const file: HubJoinFile = {
      v: 1,
      code_hash: hashJoinCode(code),
      hub_id: options.hubId,
      tenant_id: input.tenant_id,
      expires_at: issuedAt + ttlSeconds * 1000,
    };
    await atomicWrite(path, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
    return { code, expires_at: file.expires_at };
  }

  async function consume(input: {
    code: string;
    hub_id: string;
    node_id: string;
    tenant_id: string;
  }): Promise<HubJoinConsumeResult> {
    const normalized = normalizeJoinCode(input.code);
    if (normalized === null) {
      throw joinError('pairing_invalid', 'malformed code');
    }
    const digest = Buffer.from(hashJoinCode(normalized), 'hex');

    return withConsumeLock(path, async () => {
      const current = await readJoinFile(path);
      if (current === 'missing') {
        throw joinError('pairing_not_found', path);
      }

      const stored = Buffer.from(current.code_hash, 'hex');
      if (stored.length !== digest.length || !timingSafeEqual(stored, digest)) {
        throw joinError('pairing_invalid', 'code does not match');
      }
      if (current.used_at !== undefined) {
        throw joinError('pairing_used', 'code already consumed');
      }
      const consumedAt = now();
      if (current.expires_at <= consumedAt) {
        throw joinError('pairing_expired', 'code expired');
      }
      if (current.hub_id !== input.hub_id) {
        throw joinError('pairing_invalid', 'hub_id does not match');
      }
      if (current.tenant_id !== input.tenant_id) {
        throw joinError('tenant_mismatch', 'tenant does not match');
      }

      const pairingId = pairingIdFor(input.node_id, input.tenant_id);
      const updated: HubJoinFile = {
        ...current,
        used_at: consumedAt,
        node_id: input.node_id,
        pairing_id: pairingId,
      };
      await atomicWrite(path, `${JSON.stringify(updated, null, 2)}\n`, {
        mode: 0o600,
        ensureDir: true,
      });
      return {
        hub_id: current.hub_id,
        tenant_id: current.tenant_id,
        node_id: input.node_id,
        pairing_id: pairingId,
      };
    });
  }

  return { issue, consume };
}
