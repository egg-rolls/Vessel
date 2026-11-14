/**
 * 单节点本地租约服务（ADR-098 C2 / Stage 3）。
 *
 * 两级租约由同一实例管理；实例 per-tenant，每条记录带 tenant 标签：
 *   <tenantDir>/.locks/leases/{bindings,sessions}/<sha16(key)>.lease
 *
 * 记录形状（JSON，0600）：
 *   { lease_id, kind, key, tenant_id, pid, host, fence,
 *     acquired_at, renewed_at, expires_at, state: 'held' | 'released' }
 *
 * - acquire：`wx` 原子创建；同 key 未过期 → `LeaseConflictError`；过期可回收。
 * - renew：原子重写 `expires_at`；已释放/过期 → `LeaseExpiredError`。
 * - release：置 `state: 'released'` 但**保留文件**，让 `fence` 保持单调。
 * - fence：每次成功 acquire = 上一次 fence + 1；跨进程持久，不依赖内存。
 *
 * 与 `session-lock.ts` 的关系：本服务只负责租约/fencing；`'run'` 文件写锁仍由
 * `session-lock.ts` 承担。读路径不获取、不校验租约。
 *
 * **仅单节点本地**：`.locks/leases/**` 不做多节点 / 集群共识，不可当分布式锁使用。
 * 跨节点迁移/接管靠 TTL 过期 + fencing token；同一 dataDir 多进程可用，但依赖本地
 * 文件系统语义（原子 `wx` / rename / rename 可见性）。
 *
 * @module vessel/lease-service
 */

import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_LEASE_OPTIONS } from '@vessel-agent/config';
import {
  LeaseConflictError,
  LeaseExpiredError,
  type LeaseGrant,
  type LeaseKind,
  type LeaseOptions,
  type LeaseServicePort,
  type Logger,
} from '@vessel-agent/core';
// 只读探针复用 session-lock 的不可解析宽限，避免两处各写一套时间判断而漂移。
import { SESSION_LOCK_UNPARSEABLE_GRACE_MS } from './session-lock';

/** 回收守卫文件超过该时长视为 stale */
const LEASE_RECLAIM_GUARD_STALE_MS = 10_000;

/** 磁盘上的租约记录（冻结形状） */
export interface LeaseFileRecord {
  lease_id: string;
  kind: LeaseKind;
  key: string;
  tenant_id: string;
  pid: number;
  host: string;
  fence: number;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
  state: 'held' | 'released';
}

export interface FileLeaseServiceOptions {
  /** 数据根目录（`resolveSingleTenantPaths(...).root`） */
  tenantDir: string;
  tenantId: string;
  /** 租约 TTL；缺省 30000 */
  ttlMs?: number;
  /** 续租间隔（供调用方读取；本服务不启动定时器）；缺省 10000 */
  renewMs?: number;
  /** 时间源；测试可注入 */
  now?: () => number;
  /** 主机名；缺省 `os.hostname()` */
  hostname?: string;
  /** 进程号；缺省 `process.pid` */
  pid?: number;
  /** pid 存活探测；缺省 `process.kill(pid, 0)` */
  isPidAlive?: (pid: number) => boolean;
  /** 预留：诊断日志（当前实现不输出，保持装配层构造签名稳定） */
  logger?: Logger;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, 'ESRCH');
  }
}

/** 租约文件名：sha256 前 16 个 hex 字符 */
function leaseFileName(key: string): string {
  return `${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}.lease`;
}

/**
 * 租约文件路径（唯一命名规则）。
 *
 * acquire / renew / release / fenceOf 与只读探针共用它：文件名两处各写一套的话，
 * 探针会静默看错文件，把活租约读成「不存在」。
 */
function leaseRecordPath(tenantDir: string, kind: LeaseKind, key: string): string {
  return join(
    tenantDir,
    '.locks',
    'leases',
    kind === 'binding' ? 'bindings' : 'sessions',
    leaseFileName(key),
  );
}

function isLeaseFileRecord(value: unknown): value is LeaseFileRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.lease_id === 'string' &&
    record.lease_id.length > 0 &&
    (record.kind === 'binding' || record.kind === 'session') &&
    typeof record.key === 'string' &&
    typeof record.tenant_id === 'string' &&
    Number.isInteger(record.pid) &&
    typeof record.host === 'string' &&
    typeof record.fence === 'number' &&
    Number.isFinite(record.fence) &&
    typeof record.acquired_at === 'number' &&
    typeof record.renewed_at === 'number' &&
    typeof record.expires_at === 'number' &&
    (record.state === 'held' || record.state === 'released')
  );
}

/** 判活所需的进程身份（与 `FileLeaseService` 构造选项同源） */
interface LeaseProbe {
  host: string;
  pid: number;
  isPidAlive: (pid: number) => boolean;
}

/**
 * 租约是否仍然有效（持有中）。
 *
 * 判据只有这一份，`acquire` / `reclaimAndWrite` / `fenceOf` / `validate` / 只读探针
 * 全部走它，避免各自写一套时间判断后漂移：
 * - `state === 'held'` 且 `expires_at > now`（时间上界就是租约自己的 TTL + 续租）；
 * - 同主机且 pid 不是自己时，死 pid 立即视为失效（回收快路径）；
 * - 跨主机不探测 pid：pid 命名空间不同，`process.kill(pid, 0)` 没有意义。
 *   此时唯一的失效信号是 `expires_at`（默认 TTL 30s + 周期续租）——因此跨主机 /
 *   pid 被复用最多让「已死」晚判一个 TTL，不会永久误判。
 *
 * 这是租约自己的判据，与 `session-lock.ts` 的 `isStale`（死 pid / 跨主机 24h /
 * 不可解析 5s 宽限）分工不同：文件写锁没有过期时间，只能靠 24h 兜底；租约自带
 * `expires_at`，不需要也不该套用 24h。两处唯一刻意不一致的是跨主机 pid 探测：
 * `isStale` 在跨主机时仍会 `process.kill(pid, 0)`（0.15 遗留，pid 跨节点无意义），
 * 这里只在同主机探测，跨主机交给 `expires_at`。
 */
function isRecordHeld(record: LeaseFileRecord, now: number, probe: LeaseProbe): boolean {
  if (record.state !== 'held') return false;
  if (record.expires_at <= now) return false;
  if (record.host === probe.host && record.pid !== probe.pid && !probe.isPidAlive(record.pid)) {
    return false;
  }
  return true;
}

/** 读磁盘租约记录；不存在 / 不可解析 / 形状不符一律 undefined（只读）。 */
async function readLeaseRecord(path: string): Promise<LeaseFileRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isLeaseFileRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 文件租约服务：per-tenant、单节点、带 TTL / renew / fencing。 */
export class FileLeaseService implements LeaseServicePort {
  private readonly tenantDir: string;
  private readonly tenantId: string;
  readonly ttlMs: number;
  readonly renewMs: number;
  private readonly now: () => number;
  private readonly host: string;
  private readonly pid: number;
  private readonly isPidAlive: (pid: number) => boolean;
  /** 本进程持有的租约：lease_id → 文件路径 + 当前 grant */
  private readonly held = new Map<string, { path: string; grant: LeaseGrant }>();

  constructor(options: FileLeaseServiceOptions) {
    this.tenantDir = options.tenantDir;
    this.tenantId = options.tenantId;
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_OPTIONS.ttlMs;
    this.renewMs = options.renewMs ?? DEFAULT_LEASE_OPTIONS.renewMs;
    this.now = options.now ?? Date.now;
    this.host = options.hostname ?? os.hostname();
    this.pid = options.pid ?? process.pid;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  }

  async acquire(kind: LeaseKind, key: string, opts: LeaseOptions = {}): Promise<LeaseGrant> {
    const path = this.leasePath(kind, key);
    await mkdir(dirname(path), { recursive: true });
    const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : this.ttlMs;
    const minFence = typeof opts.minFence === 'number' && opts.minFence > 0 ? opts.minFence : 0;
    const now = this.now();

    const initial = await this.readRecord(path);
    if (initial !== undefined && this.isHeld(initial, now)) {
      throw new LeaseConflictError(kind, key);
    }

    let record: LeaseFileRecord;
    if (initial === undefined) {
      const candidate = this.makeRecord(kind, key, Math.max(1, minFence), now, ttlMs);
      const created = await this.tryCreate(path, candidate);
      record = created ? candidate : await this.reclaimAndWrite(path, kind, key, ttlMs, minFence);
    } else {
      record = await this.reclaimAndWrite(path, kind, key, ttlMs, minFence);
    }

    const grant = this.grantOf(record);
    this.held.set(grant.leaseId, { path, grant });
    return grant;
  }

  async renew(leaseId: string): Promise<LeaseGrant> {
    const entry = this.held.get(leaseId);
    if (entry === undefined) throw new LeaseExpiredError('lease_expired', leaseId);

    const now = this.now();
    const record = await this.readRecord(entry.path);
    // 已释放 / 换过 lease_id ⇒ 真的被别人（或自己 release）接管了，照旧失败。
    if (record === undefined || record.lease_id !== leaseId || record.state !== 'held') {
      this.held.delete(leaseId);
      throw new LeaseExpiredError('lease_expired', leaseId);
    }
    // 过期但**仍是我们自己的那一条**：说明这段时间没有人接管（典型场景是合盖/挂起，
    // 整台机器都没在跑）⇒ 原地续期，**fence 不动**。否则长任务跨一次睡眠必死。
    if (record.expires_at <= now && !this.isOwnRecord(record)) {
      this.held.delete(leaseId);
      throw new LeaseExpiredError('lease_expired', leaseId);
    }

    const next: LeaseFileRecord = {
      ...record,
      renewed_at: now,
      expires_at: now + this.ttlMs,
    };
    await this.writeRecord(entry.path, next);
    const grant: LeaseGrant = { ...entry.grant, expiresAt: next.expires_at };
    this.held.set(leaseId, { path: entry.path, grant });
    return grant;
  }

  async release(leaseId: string): Promise<void> {
    const entry = this.held.get(leaseId);
    if (entry === undefined) return;
    this.held.delete(leaseId);
    try {
      const record = await this.readRecord(entry.path);
      if (record !== undefined && record.lease_id === leaseId) {
        if (record.state === 'released') return;
        // 释放时 fence +1：旧 token 立即失效（写入端按 token >= currentFence 拒绝）；
        // 文件保留，后续 acquire 在历史 fence 上继续递增。
        await this.writeRecord(entry.path, {
          ...record,
          fence: record.fence + 1,
          renewed_at: this.now(),
          state: 'released',
        });
      }
    } catch {
      // 释放是 best-effort；释放失败时 TTL 过期兜底（fenceOf 会把过期记录 +1）。
    }
  }

  async validate(leaseId: string): Promise<boolean> {
    const entry = this.held.get(leaseId);
    if (entry === undefined) return false;
    const record = await this.readRecord(entry.path);
    if (
      record === undefined ||
      record.lease_id !== leaseId ||
      record.fence !== entry.grant.fencingToken
    ) {
      return false;
    }
    // 过期但仍是自己的那一条：仍然有效（见 `isOwnRecord` 的说明），别把睡眠判成丢租约。
    return this.isHeld(record, this.now()) || this.isOwnRecord(record);
  }

  async fenceOf(kind: LeaseKind, key: string): Promise<number> {
    const record = await this.readRecord(this.leasePath(kind, key));
    if (record === undefined) return 0;
    // 已释放：release 已把 fence +1。
    if (record.state === 'released') return record.fence;
    // 未过期 ⇒ 当前 fence。
    if (this.isHeld(record, this.now())) return record.fence;
    // **过期但仍是我们自己的租约** ⇒ 期间没人接管，当前 fence 就是它的 fence。
    // （过去这里一律 +1，等于自己把自己判成 stale，长任务跨一次睡眠即死。）
    if (this.isOwnRecord(record)) return record.fence;
    // 已过期 / 死 pid：视为失效，旧 token 必须小于当前 fence。
    return record.fence + 1;
  }

  private leasePath(kind: LeaseKind, key: string): string {
    return leaseRecordPath(this.tenantDir, kind, key);
  }

  private makeRecord(
    kind: LeaseKind,
    key: string,
    fence: number,
    now: number,
    ttlMs: number,
  ): LeaseFileRecord {
    return {
      lease_id: randomUUID(),
      kind,
      key,
      tenant_id: this.tenantId,
      pid: this.pid,
      host: this.host,
      fence,
      acquired_at: now,
      renewed_at: now,
      expires_at: now + ttlMs,
      state: 'held',
    };
  }

  private grantOf(record: LeaseFileRecord): LeaseGrant {
    return {
      leaseId: record.lease_id,
      kind: record.kind,
      key: record.key,
      tenantId: record.tenant_id,
      fencingToken: record.fence,
      expiresAt: record.expires_at,
    };
  }

  /** 未释放且未过期；同主机死 pid 视为可回收快路径（判据见 `isRecordHeld`）。 */
  private isHeld(record: LeaseFileRecord, now: number): boolean {
    return isRecordHeld(record, now, {
      host: this.host,
      pid: this.pid,
      isPidAlive: this.isPidAlive,
    });
  }

  /**
   * 这条（可能已过期的）磁盘记录**是否仍是本进程自己持有的那一条**。
   *
   * 判据只看身份，不看时钟：`lease_id` 是 `acquire`/回收时新生成的 `randomUUID()`
   * （`makeRecord`），谁回收谁换 lease_id。所以「lease_id 没变 + pid/host 是我们」
   * 就等价于「期间没有人接管过」，与 `expires_at` 无关。
   *
   * 这条判据是「合盖/挂起不再打死长任务」的关键：机器睡完醒来时 `expires_at` 必然过期，
   * 但**没有任何别的进程能在这段时间内接管**（同一台机器也睡着了）。过去这里只看时钟，
   * 于是 `renew` 抛 `lease_expired`、`fenceOf` 又把 fence +1，把自己在跑的 writer 判成
   * `stale_fence` —— 长任务因此必然失败。跑着的租约仍然是我们 的，就不该假装它被别人拿走了。
   */
  private isOwnRecord(record: LeaseFileRecord): boolean {
    return record.pid === this.pid && record.host === this.host && this.held.has(record.lease_id);
  }

  /** 读磁盘记录；实现与只读探针共用 `readLeaseRecord`（形状校验只有一份）。 */
  private async readRecord(path: string): Promise<LeaseFileRecord | undefined> {
    return readLeaseRecord(path);
  }

  /** `wx` 原子创建；已存在返回 false。 */
  private async tryCreate(path: string, record: LeaseFileRecord): Promise<boolean> {
    try {
      await writeFile(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      await chmod(path, 0o600).catch(() => undefined);
      return true;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return false;
      throw error;
    }
  }

  /**
   * 回收过期/已释放记录并写入新租约。
   * 用 `<path>.reclaim` 守卫串行化并发回收者；守卫自身 stale 后允许抢占。
   */
  private async reclaimAndWrite(
    path: string,
    kind: LeaseKind,
    key: string,
    ttlMs: number,
    minFence: number,
  ): Promise<LeaseFileRecord> {
    const guardPath = `${path}.reclaim`;
    let guard: FileHandle | undefined;
    for (let attempt = 0; attempt < 2 && guard === undefined; attempt += 1) {
      try {
        guard = await open(guardPath, 'wx');
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        const stale = await stat(guardPath)
          .then((info) => this.now() - info.mtimeMs > LEASE_RECLAIM_GUARD_STALE_MS)
          .catch(() => true);
        if (!stale) throw new LeaseConflictError(kind, key);
        await unlink(guardPath).catch(() => undefined);
      }
    }
    if (guard === undefined) throw new LeaseConflictError(kind, key);

    try {
      const fresh = await this.readRecord(path);
      const now = this.now();
      if (fresh !== undefined && this.isHeld(fresh, now)) {
        throw new LeaseConflictError(kind, key);
      }
      const record = this.makeRecord(
        kind,
        key,
        Math.max((fresh?.fence ?? 0) + 1, minFence),
        now,
        ttlMs,
      );
      await this.writeRecord(path, record);
      return record;
    } finally {
      await guard.close().catch(() => undefined);
      await unlink(guardPath).catch(() => undefined);
    }
  }

  /** 原子重写：临时文件 + rename，避免读到半截 JSON。 */
  private async writeRecord(path: string, record: LeaseFileRecord): Promise<void> {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await chmod(temp, 0o600).catch(() => undefined);
      await rename(temp, path);
      await chmod(path, 0o600).catch(() => undefined);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}

/** 只读租约探针结论（0.18 session liveness） */
export interface LeaseInspection {
  /**
   * - `absent`：没有租约文件（memory 后端 / 0.34 前数据 / 没接 lease 服务的部署）
   * - `live`：持有中、未过期、同主机 pid 活（`isRecordHeld`）
   * - `stale`：记录可解析但不代表活写者（released / 过期 / 同主机死 pid），或不可解析已过宽限
   * - `unparseable`：文件存在但不可解析且仍在宽限内（保守视为写入中）
   */
  state: 'absent' | 'live' | 'stale' | 'unparseable';
  record?: LeaseFileRecord;
}

/**
 * 只读检查某个 session 的 SessionLease（0.18 session liveness 对账用）。
 *
 * 只读：不创建 / 不改写 / 不删除文件，`acquire` / `renew` / `release` 语义不变。
 * 存在的意义是让「谁还活着」的判据与租约服务同源：0.34 Stage 3 起 session 级排他
 * 由 SessionLease 承担，正常运行**不持文件写锁**。
 *
 * 判活口径完全交给 `isRecordHeld`（与 acquire / fenceOf 同一份实现）；
 * 时间上界用租约自己的 `expires_at`（TTL + 续租），不套用 session-lock 的跨主机 24h。
 */
export async function inspectSessionLease(
  tenantDir: string,
  sessionId: string,
  options: {
    now?: () => number;
    hostname?: string;
    pid?: number;
    isPidAlive?: (pid: number) => boolean;
    unparseableGraceMs?: number;
  } = {},
): Promise<LeaseInspection> {
  const path = leaseRecordPath(tenantDir, 'session', sessionId);
  const now = options.now ?? Date.now;

  const record = await readLeaseRecord(path);
  if (record !== undefined) {
    const held = isRecordHeld(record, now(), {
      host: options.hostname ?? os.hostname(),
      pid: options.pid ?? process.pid,
      isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    });
    return { state: held ? 'live' : 'stale', record };
  }

  // 记录读不出来时只区分「没有文件」与「有文件但坏了」：后者在宽限内保守视为
  // 写入中（与 `inspectSessionLock` 的 unparseable 同口径），过了宽限才允许对账接管，
  // 否则一个损坏的租约文件会永久挡住对死进程的修复。
  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (mtimeMs === undefined) return { state: 'absent' };

  const graceMs = options.unparseableGraceMs ?? SESSION_LOCK_UNPARSEABLE_GRACE_MS;
  return { state: now() - mtimeMs > graceMs ? 'stale' : 'unparseable' };
}
