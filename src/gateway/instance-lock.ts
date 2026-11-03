/**
 * Gateway 实例锁（0.14 DECISION-025 §1.6 / DESIGN-0.14 §1.3）。
 *
 * `<dataDir>/gateway-<instance>.lock`，JSON `{pid, started_at, host}`，0600。
 * 每个实例先取锁再 bind；同实例并发只有一个成功。
 *
 * 占用判定不只看 PID：先看 host（机器身份）、boot 时间，再在同实例有 PID 记录时
 * 用 `classifyGatewayRecord` 做身份匹配。只有确认 stale 才用 compare-and-delete
 * 回收；foreign-host / degraded / unknown 永不自动删除。
 *
 * @module vessel/gateway/instance-lock
 */

import * as fs from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyGatewayRecord,
  DEFAULT_GATEWAY_INSTANCE,
  deleteRecordIfOwned,
  isBeforeBoot,
  normalizeGatewayInstance,
  isProcessAlive as pidIsAlive,
  quarantineCorruptRecordIfUnchanged,
  readGatewayPidRecord,
  readGatewayStateFile,
} from './pid';

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
  /** 锁的 started_at（epoch ms）；PID 记录使用同一值。 */
  readonly startedAt: number;
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

/** lock 形状校验；deleteRecordIfOwned 的 parse 回调 */
function parseLockRecord(raw: unknown): GatewayInstanceLockInfo | null {
  return isLockInfo(raw) ? { pid: raw.pid, started_at: raw.started_at, host: raw.host } : null;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

/** E6：win32 上 hostname 比较忽略大小写 */
function sameHost(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * 锁是否确认 stale（可回收）。pid 活且 post-boot 时，只有同实例 PID 记录
 * 属于同一 pid 且被判 stale 才回收；无记录 → starting（持有）。
 */
async function lockIsStale(
  dataDir: string,
  instance: string,
  info: GatewayInstanceLockInfo,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  if (isBeforeBoot(info.started_at)) return true;
  if (!alive(info.pid)) return true;
  // 本进程遗留的旧锁（同 pid 不同 started_at）可直接回收。
  if (info.pid === process.pid) return true;

  const record = await readGatewayPidRecord(dataDir, instance);
  if (record === null) return false;
  if (record.pid !== info.pid) return false;
  const classification = await classifyGatewayRecord(record);
  return classification.state === 'stale';
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
  const alive = options.isPidAlive ?? pidIsAlive;
  const graceMs = options.unparseableGraceMs ?? UNPARSEABLE_GRACE_MS;
  const filePath = gatewayInstanceLockPath(dataDir, instance);
  const startedAt = now();
  const body = `${JSON.stringify({ pid, started_at: startedAt, host }, null, 2)}\n`;

  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(filePath, body, { flag: 'wx', mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => undefined);
      let released = false;
      return {
        instance: instance === DEFAULT_GATEWAY_INSTANCE ? DEFAULT_GATEWAY_INSTANCE : instance,
        path: filePath,
        startedAt,
        release: async (): Promise<void> => {
          if (released) return;
          released = true;
          await deleteRecordIfOwned(
            filePath,
            { pid, started_at: startedAt },
            { parse: parseLockRecord },
          );
        },
        releaseSync: (): void => {
          if (released) return;
          released = true;
          try {
            const info = parseLockRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            if (
              info === null ||
              info.pid !== pid ||
              info.started_at !== startedAt ||
              !sameHost(info.host, host)
            ) {
              return;
            }
            // 同步路径同样先 rename 再删除，避免误删刚被他人接管的锁。
            const reclaimPath = `${filePath}.reclaim-${Date.now()}`;
            fs.renameSync(filePath, reclaimPath);
            fs.rmSync(reclaimPath, { force: true });
          } catch {
            // 退出路径不抛错
          }
        },
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    const snapshot = await readGatewayStateFile<GatewayInstanceLockInfo>(filePath, {
      now: now(),
      graceMs,
      parse: parseLockRecord,
    });

    if (snapshot.kind === 'absent') continue;
    if (snapshot.kind === 'io-error') {
      // I/O 错误 → unknown：不探测、不删除。
      throw new GatewayInstanceLockedError(instance);
    }
    if (snapshot.kind === 'corrupt') {
      if (!snapshot.reclaimable) throw new GatewayInstanceLockedError(instance);
      const quarantined = await quarantineCorruptRecordIfUnchanged(filePath, snapshot.mtimeMs, {
        now: now(),
      });
      if (quarantined) continue;
      throw new GatewayInstanceLockedError(instance);
    }

    const info = snapshot.value;
    if (!sameHost(info.host, host)) {
      // E6：foreign-host 永不回收。
      throw new GatewayInstanceLockedError(instance, info);
    }
    if (!(await lockIsStale(dataDir, instance, info, alive))) {
      throw new GatewayInstanceLockedError(instance, info);
    }
    const deleted = await deleteRecordIfOwned(
      filePath,
      { pid: info.pid, started_at: info.started_at },
      { quarantine: true, now: now(), parse: parseLockRecord },
    );
    if (!deleted) throw new GatewayInstanceLockedError(instance, info);
  }

  throw new GatewayInstanceLockedError(instance);
}
