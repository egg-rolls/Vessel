/**
 * Gateway 实例锁（0.14 DECISION-025 §1.6 / DESIGN-0.14 §1.3）。
 *
 * `<dataDir>/gateway-<instance>.lock`，JSON `{pid, started_at, host}`，0600。
 * 每个实例先取锁再 bind；同实例并发只有一个成功。死 pid / 不可解析超过宽限期
 * 的锁可回收。锁只用于运行期裁决；PID 文件仍是发现来源。
 *
 * @module vessel/gateway/instance-lock
 */

import * as fs from 'node:fs';
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_GATEWAY_INSTANCE, isProcessAlive, normalizeGatewayInstance } from './pid';

/** 不可解析锁的宽限（与 tenant lock 一致） */
const UNPARSEABLE_GRACE_MS = 5_000;

/** 锁内容（冻结形状） */
export interface GatewayInstanceLockInfo {
  pid: number;
  started_at: number;
  host: string;
}

/** 锁被占用 */
export class GatewayInstanceLockedError extends Error {
  readonly code = 'instance_locked' as const;
  readonly instance: string;
  readonly owner?: GatewayInstanceLockInfo;

  constructor(instance: string, owner?: GatewayInstanceLockInfo) {
    super(
      `instance_locked: gateway instance "${instance}" is already running` +
        (owner ? ` (pid ${owner.pid} on ${owner.host})` : '') +
        '. Stop it first or choose another --instance.',
    );
    this.name = 'GatewayInstanceLockedError';
    this.instance = instance;
    if (owner) this.owner = owner;
  }
}

export interface AcquireGatewayInstanceLockOptions {
  dataDir: string;
  instance?: string;
  now?: () => number;
  hostname?: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  unparseableGraceMs?: number;
}

/** 持有的实例锁 */
export interface GatewayInstanceLock {
  readonly instance: string;
  readonly path: string;
  release(): Promise<void>;
  /** process 'exit' 钩子用；不抛错 */
  releaseSync(): void;
}

/** 锁文件路径 */
export function gatewayInstanceLockPath(dataDir: string, instance?: string): string {
  const name = normalizeGatewayInstance(instance);
  return path.join(dataDir, `gateway-${name}.lock`);
}

function isLockInfo(value: unknown): value is GatewayInstanceLockInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.started_at === 'number' &&
    Number.isFinite(record.started_at) &&
    typeof record.host === 'string'
  );
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

async function readLock(filePath: string): Promise<GatewayInstanceLockInfo | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return isLockInfo(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 不可解析锁是否超过宽限期（mtime） */
async function unparseableIsStale(
  filePath: string,
  now: number,
  graceMs: number,
): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return now - info.mtimeMs > graceMs;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

function ownedByUs(info: GatewayInstanceLockInfo | undefined, pid: number): boolean {
  return info?.pid === pid;
}

async function releaseAtPath(
  filePath: string,
  pid: number,
  known: GatewayInstanceLockInfo | undefined,
): Promise<void> {
  if (known !== undefined && !ownedByUs(known, pid)) return;
  if (known === undefined) {
    // 不解析内容时不删：避免误删正在写入的他进程锁。
    const info = await readLock(filePath);
    if (info !== undefined && !ownedByUs(info, pid)) return;
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

/**
 * 获取实例锁。同一实例已有存活持有者 → 抛 `GatewayInstanceLockedError`。
 */
export async function acquireGatewayInstanceLock(
  options: AcquireGatewayInstanceLockOptions,
): Promise<GatewayInstanceLock> {
  const instance = normalizeGatewayInstance(options.instance);
  const dataDir = options.dataDir;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const host = options.hostname ?? os.hostname();
  const alive = options.isPidAlive ?? isProcessAlive;
  const graceMs = options.unparseableGraceMs ?? UNPARSEABLE_GRACE_MS;
  const filePath = gatewayInstanceLockPath(dataDir, instance);
  const body = `${JSON.stringify({ pid, started_at: now(), host }, null, 2)}\n`;

  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(filePath, body, { flag: 'wx', mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => undefined);
      let released = false;
      return {
        instance: instance === DEFAULT_GATEWAY_INSTANCE ? DEFAULT_GATEWAY_INSTANCE : instance,
        path: filePath,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          const current = await readLock(filePath);
          if (current !== undefined && current.pid !== pid) return;
          await releaseAtPath(filePath, pid, current);
        },
        releaseSync: (): void => {
          if (released) return;
          released = true;
          try {
            const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (isLockInfo(parsed) && parsed.pid === pid) fs.unlinkSync(filePath);
          } catch {
            // 退出路径不抛错
          }
        },
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    const info = await readLock(filePath);
    if (info !== undefined) {
      if (alive(info.pid) && !(info.pid === pid)) {
        throw new GatewayInstanceLockedError(instance, info);
      }
      // 死 pid（或本进程旧锁）→ 回收后重试一次
      await unlink(filePath).catch(() => undefined);
      continue;
    }

    if (await unparseableIsStale(filePath, now(), graceMs)) {
      await unlink(filePath).catch(() => undefined);
      continue;
    }
    throw new GatewayInstanceLockedError(instance);
  }

  throw new GatewayInstanceLockedError(instance);
}
