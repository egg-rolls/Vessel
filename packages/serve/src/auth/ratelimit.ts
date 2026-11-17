/**
 * 0.56 P2：登录限速（**按 IP + 按账户**双维度，递增延迟 + 失败锁定）。
 *
 * 规则（一处定义，登录 / TOTP / 恢复码三条路径共用）：
 * - 每次失败同时记到两个维度：`ip:<addr>` 与 `acct:<username>`；
 * - **递增延迟**：第 n 次失败后，下一次尝试要等 `min(250ms * 2^(n-1), 8s)`；
 *   延迟不叠加在锁定之上，锁定单独算；
 * - **锁定**：同维度在 15 分钟窗口内累计 8 次失败 ⇒ 锁 15 分钟（两个维度都判，
 *   任一锁定即拒绝，避免「换 IP 继续猜账户」或「换账户继续猜 IP」）；
 * - **不锁死自己**：`resetAll()` 由 `POST /auth/unlock` 触发（只许回环 + 平台 token），
 *   状态落盘在 `<dataDir>/auth/lockout.json`，重启不会顺手解锁 —— 否则攻击者只要
 *   让进程重启就能洗白。
 *
 * @module @vessel-agent/serve/auth/ratelimit
 */

import { readFileSync } from 'node:fs';
import { atomicWrite } from '@vessel-agent/core';

/** 一次尝试的判定结果。 */
export type LimiterGate =
  | { ok: true; retryAfterMs: number }
  | { ok: false; retryAfterMs: number; scope: 'ip' | 'account' | 'both'; locked: boolean };

/** 一个维度的失败记录。 */
export interface LimiterEntry {
  failures: number;
  /** 递增延迟生效到什么时候（毫秒）。 */
  delayUntil: number;
  /** 锁定到什么时候（毫秒）；0 = 没锁。 */
  lockedUntil: number;
  lastFailureAt: number;
}

export interface LimiterPolicy {
  /** 触发锁定的失败次数。 */
  maxFailures: number;
  /** 失败计数的滑动窗口。 */
  windowMs: number;
  /** 锁定时长。 */
  lockMs: number;
  /** 首次失败后的最短等待。 */
  baseDelayMs: number;
  /** 递增延迟上限。 */
  maxDelayMs: number;
}

export const DEFAULT_LIMITER_POLICY: LimiterPolicy = {
  maxFailures: 8,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
};

interface LimiterFile {
  version: 1;
  entries: Record<string, LimiterEntry>;
}

export interface LoginLimiterOptions {
  /** 落盘文件；省略 = 纯内存（重启即清零，仅用于验收桩）。 */
  file?: string | undefined;
  now?: (() => number) | undefined;
  policy?: Partial<LimiterPolicy> | undefined;
}

/** IP 维度 key。缺失地址（拿不到 socket 信息）时退化成 `ip:unknown`，仍然计数。 */
export function ipKey(address: string | null | undefined): string {
  const normalized = typeof address === 'string' ? address.trim() : '';
  return `ip:${normalized === '' ? 'unknown' : normalized}`;
}

/** 账户维度 key：大小写不敏感（登录名不是身份，只是限流分桶）。 */
export function accountKey(username: string): string {
  return `acct:${username.trim().toLowerCase()}`;
}

/**
 * 双维度限速表。
 *
 * 判定与记账分开（`gate` 先问「现在能不能试」，`fail` 在失败后记账）：
 * 这样口令错、TOTP 错、恢复码错都走同一套节奏，而成功登录只 `reset`。
 */
export class LoginLimiter {
  private entries = new Map<string, LimiterEntry>();
  private readonly policy: LimiterPolicy;
  private readonly file: string | undefined;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: LoginLimiterOptions = {}) {
    this.policy = { ...DEFAULT_LIMITER_POLICY, ...options.policy };
    this.file = options.file;
    this.now = options.now ?? (() => Date.now());
    this.loadFromDisk();
  }

  /** 现在这个维度组合能不能试；不能时给出要等多久（秒级精度给客户端）。 */
  gate(dimensions: string[]): LimiterGate {
    const now = this.now();
    let retryAfterMs = 0;
    let locked = false;
    let ipLocked = false;
    let accountLocked = false;
    for (const dimension of dimensions) {
      const entry = this.entries.get(dimension);
      if (entry === undefined) continue;
      if (entry.lockedUntil > now) {
        locked = true;
        retryAfterMs = Math.max(retryAfterMs, entry.lockedUntil - now);
        if (dimension.startsWith('ip:')) ipLocked = true;
        else accountLocked = true;
        continue;
      }
      if (entry.delayUntil > now) {
        retryAfterMs = Math.max(retryAfterMs, entry.delayUntil - now);
      }
    }
    if (locked) {
      return {
        ok: false,
        retryAfterMs,
        scope: ipLocked && accountLocked ? 'both' : ipLocked ? 'ip' : 'account',
        locked: true,
      };
    }
    if (retryAfterMs > 0) {
      return {
        ok: false,
        retryAfterMs,
        scope: dimensions.some((dimension) => dimension.startsWith('ip:')) ? 'ip' : 'account',
        locked: false,
      };
    }
    return { ok: true, retryAfterMs: 0 };
  }

  /** 记一次失败；返回这次是否触发（或仍处于）锁定。 */
  fail(dimensions: string[]): { locked: boolean; retryAfterMs: number } {
    const now = this.now();
    let locked = false;
    let retryAfterMs = 0;
    for (const dimension of dimensions) {
      const previous = this.entries.get(dimension);
      const inWindow =
        previous !== undefined && now - previous.lastFailureAt <= this.policy.windowMs;
      const failures = (inWindow ? previous.failures : 0) + 1;
      const entry: LimiterEntry = {
        failures,
        delayUntil: now + this.delayFor(failures),
        lockedUntil:
          failures >= this.policy.maxFailures
            ? now + this.policy.lockMs
            : (previous?.lockedUntil ?? 0),
        lastFailureAt: now,
      };
      this.entries.set(dimension, entry);
      if (entry.lockedUntil > now) {
        locked = true;
        retryAfterMs = Math.max(retryAfterMs, entry.lockedUntil - now);
      }
    }
    this.scheduleWrite();
    return { locked, retryAfterMs };
  }

  /** 成功登录：清掉两个维度的计数（只清这一次命中的 key）。 */
  reset(dimensions: string[]): void {
    let changed = false;
    for (const dimension of dimensions) {
      if (this.entries.delete(dimension)) changed = true;
    }
    if (changed) this.scheduleWrite();
  }

  /** 解锁：清空所有维度（`POST /auth/unlock` 用）。返回清掉的条目数。 */
  resetAll(): number {
    const count = this.entries.size;
    this.entries = new Map();
    if (count > 0) this.scheduleWrite();
    return count;
  }

  /** 某个维度当前记录（诊断输出用，不含口令/验证码）。 */
  peek(dimension: string): LimiterEntry | null {
    const entry = this.entries.get(dimension);
    return entry === undefined ? null : { ...entry };
  }

  size(): number {
    return this.entries.size;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** 第 n 次失败后的等待时长（指数增长，封顶 maxDelayMs）。 */
  private delayFor(failures: number): number {
    if (failures <= 0) return 0;
    const exponent = Math.min(failures - 1, 10);
    return Math.min(this.policy.baseDelayMs * 2 ** exponent, this.policy.maxDelayMs);
  }

  private scheduleWrite(): void {
    if (this.file === undefined) return;
    const payload: LimiterFile = { version: 1, entries: Object.fromEntries(this.entries) };
    const file = this.file;
    const text = JSON.stringify(payload);
    this.writeChain = this.writeChain.then(() =>
      atomicWrite(file, text, { mode: 0o600, ensureDir: true }),
    );
    this.writeChain = this.writeChain.then(
      () => undefined,
      () => undefined,
    );
  }

  private loadFromDisk(): void {
    if (this.file === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const entries = (parsed as { entries?: unknown }).entries;
    if (typeof entries !== 'object' || entries === null) return;
    const now = this.now();
    for (const [key, raw] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const failures = typeof item.failures === 'number' ? item.failures : 0;
      const lastFailureAt = typeof item.lastFailureAt === 'number' ? item.lastFailureAt : 0;
      const lockedUntil = typeof item.lockedUntil === 'number' ? item.lockedUntil : 0;
      const delayUntil = typeof item.delayUntil === 'number' ? item.delayUntil : 0;
      // 过期就丢：窗口之外的失败计数没有意义，也不该被历史文件一直拖着。
      if (now - lastFailureAt > this.policy.windowMs && lockedUntil <= now) continue;
      this.entries.set(key, { failures, lastFailureAt, lockedUntil, delayUntil });
    }
  }
}

/** 给客户端的 429 头部（秒，向上取整；最小 1）。 */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
