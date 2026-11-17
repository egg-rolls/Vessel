/**
 * 0.56 P2：一次性引导码 + TOTP 在途登录票据。
 *
 * 为什么有引导码：`#token=` 退场之后，一个**全新部署**必须还有一条不用先配口令就能
 * 进去的路，否则「装完打不开」。规则刻意收紧：
 * - **单次**：claim 即作废，用来换一个 `bootstrap` 会话；
 * - **短 TTL**：缺省 10 分钟（`DEFAULT_BOOTSTRAP_TTL_MS`），过期即废；
 * - **只用一次就退场**：拿它换到的会话只能做两件事 —— 设口令、绑 TOTP；
 * - **重放可检测**：用过的记录不立刻删（保留到租期结束），第二次提交同一个码会命中
 *   `replayed`，调用方据此**撤销它当初签发的那条会话**并告警。
 *
 * 只存在内存里（进程重启即失效，并从日志重新发一枚新的）：它本来就不该被持久化，
 * 否则「一次性」要靠清理逻辑保证，一旦漏清就是长期后门。
 *
 * @module @vessel-agent/serve/auth/bootstrap
 */

import { createHash } from 'node:crypto';
import { randomToken } from './session.js';

/** 引导码租期：10 分钟。够慢一点的人打开浏览器，又短到不像个长期口令。 */
export const DEFAULT_BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
/** 用过的记录多留 30 分钟：重放检测靠它，过期后连「曾经有过」都不必记得。 */
const USED_GRACE_MS = 30 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface BootstrapRecord {
  expiresAt: number;
  usedAt: number | null;
  /** 由它签发的会话（sha256(sid)）；重放时按这个撤销。 */
  sessionSidHash: string | null;
}

export interface IssuedBootstrapCode {
  /** 明文引导码：只在签发这一刻存在于内存与（一次）日志里。 */
  code: string;
  expiresAt: number;
}

export type BootstrapClaim =
  | { ok: true; key: string }
  | { ok: false; status: 'unknown' | 'expired' }
  | { ok: false; status: 'replayed'; sessionSidHash: string | null };

/**
 * 一次性引导码表。
 *
 * `claim` 采用「先判后用」的顺序：同一个码并发提交时只有一个能拿到 `ok`，
 * 其余落进 `replayed` 分支（与真正的重放走同一条撤销路径）。
 */
export class BootstrapCodes {
  private readonly codes = new Map<string, BootstrapRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 签发一枚新码（旧的未用码各自留到过期：重启后日志里可能还有多条）。 */
  issue(): IssuedBootstrapCode {
    this.cleanup();
    const code = randomToken(16);
    const expiresAt = this.now() + this.ttlMs;
    this.codes.set(sha256Hex(code), { expiresAt, usedAt: null, sessionSidHash: null });
    return { code, expiresAt };
  }

  /** 认领一枚码。成功时返回内部 key，供随后 `bindSession` 绑定会话。 */
  claim(code: string): BootstrapClaim {
    if (typeof code !== 'string' || code === '') return { ok: false, status: 'unknown' };
    const key = sha256Hex(code.trim());
    const record = this.codes.get(key);
    if (record === undefined) return { ok: false, status: 'unknown' };
    const now = this.now();
    if (record.usedAt !== null) {
      return { ok: false, status: 'replayed', sessionSidHash: record.sessionSidHash };
    }
    if (now >= record.expiresAt) return { ok: false, status: 'expired' };
    record.usedAt = now;
    return { ok: true, key };
  }

  /** 把刚签发的会话绑到这条记录上（重放时按它撤销）。 */
  bindSession(key: string, sidHash: string): void {
    const record = this.codes.get(key);
    if (record === undefined) return;
    record.sessionSidHash = sidHash;
  }

  size(): number {
    return this.codes.size;
  }

  /** 清理过期记录；返回清理条数。 */
  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, record] of this.codes) {
      const deadline =
        record.usedAt === null
          ? record.expiresAt
          : Math.max(record.expiresAt, record.usedAt) + USED_GRACE_MS;
      if (now < deadline) continue;
      this.codes.delete(key);
      removed += 1;
    }
    return removed;
  }
}

/** 在途登录：口令已过、等 TOTP 的那一段（票根在内存里，单次 + 5 分钟）。 */
export interface PendingLoginEntry {
  username: string;
  ip: string | null;
  userAgent: string | null;
  expiresAt: number;
  /** 已经失败过的验证码次数（超过上限就作废票根，要求重新输口令）。 */
  attempts: number;
}

const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
const PENDING_LOGIN_MAX_ATTEMPTS = 5;

/** 两段式登录的票根表：口令过了但还没过 TOTP 的中间态。 */
export class PendingLogins {
  private readonly entries = new Map<string, PendingLoginEntry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  issue(input: { username: string; ip: string | null; userAgent: string | null }): {
    ticket: string;
    expiresAt: number;
  } {
    this.cleanup();
    const ticket = randomToken(32);
    const expiresAt = this.now() + PENDING_LOGIN_TTL_MS;
    this.entries.set(sha256Hex(ticket), { ...input, expiresAt, attempts: 0 });
    return { ticket, expiresAt };
  }

  /** 取出票根（不消费）：验证码错一次还能再试，超过上限才作废。 */
  peek(ticket: string): { key: string; entry: PendingLoginEntry } | null {
    if (typeof ticket !== 'string' || ticket === '') return null;
    const key = sha256Hex(ticket.trim());
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return { key, entry };
  }

  /** 记一次失败；到上限就作废票根。 */
  failAttempt(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.attempts += 1;
    if (entry.attempts >= PENDING_LOGIN_MAX_ATTEMPTS) this.entries.delete(key);
  }

  consume(key: string): void {
    this.entries.delete(key);
  }

  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (now < entry.expiresAt) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }
}
