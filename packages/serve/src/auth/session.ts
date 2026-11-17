/**
 * 0.56 WebUI 登录：服务端会话表 + CSRF + cookie 助手。
 *
 * 设计依据：`docs/dev/design/0.56-webui-auth.md`（2.2 / 5.4）。
 * 会话 id 明文只出现在客户端 cookie 里，服务端只留 `sha256(sid)`：会话文件被拿走
 * 也无法当 cookie 重放。CSRF 用同步令牌（服务端存 sha256，客户端经 `/auth/status`
 * 取明文），不用双提交 —— 同父域下的兄弟子域能写 cookie。
 *
 * @module @vessel-agent/serve/auth/session
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { atomicWrite } from '@vessel-agent/core';

/** 后端限定的身份；内容只由后端决定（如 `github:174765587`）。 */
export interface AuthSubject {
  /** 稳定 id，如 `github:174765587`。 */
  id: string;
  /** 后端 id，如 `github`。 */
  backend: string;
  /** 后端返回的展示名；只用于界面，**不**参与身份判定。 */
  username: string | null;
}

/** 审计用的请求元数据；落盘前先哈希。 */
export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** 签发结果：cookie 值 + CSRF 明文（只在签发这一刻存在于服务端与客户端）。 */
export interface IssuedSession {
  sid: string;
  csrfToken: string;
  expiresAt: number;
}

/** 校验通过的会话快照（`get()` 返回）。 */
export interface SessionSnapshot {
  subject: AuthSubject;
  csrfTokenHash: string;
  /**
   * 同步令牌明文，仅内存：刷新页面 / 第二个标签页靠 `/auth/status` 再取回。
   * **不落盘** —— 进程重启后为 null，客户端用 `/auth/csrf` 换新的。
   */
  csrfToken: string | null;
  createdAt: number;
  expiresAt: number;
}

/** 落盘记录；`sidHash = sha256(sid)` 十六进制。 */
interface PersistedSession {
  sidHash: string;
  subject: AuthSubject;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  csrfTokenHash: string;
  /** 仅内存：写入前剥掉，读回时置 null。 */
  csrfToken: string | null;
  uaHash: string | null;
  ipHash: string | null;
}

export interface SessionStoreOptions {
  /** 空闲超时（毫秒，滑动）。 */
  idleMs: number;
  /** 绝对超时（毫秒，自创建起算）。 */
  absoluteMs: number;
  /** 可选落盘文件（0600）；省略 = 纯内存。 */
  storageFile?: string | undefined;
  /** 可注入时钟（测试 / 验收）。 */
  now?: (() => number) | undefined;
}

const PERSIST_VERSION = 1;
/** 不必每个请求都重写 lastSeenAt；60s 一次足够维持滑动窗口。 */
const TOUCH_THROTTLE_MS = 60_000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashMeta(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return sha256Hex(value).slice(0, 32);
}

/** CSPRNG 令牌（base64url）。32 字节 = 256 bit。 */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** 定长比较（先对齐长度再 timingSafeEqual，避免按字节提前返回）。 */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 会话表（内存 + 可选 JSON 落盘）。
 *
 * 每次变更（create / rotate / revoke / cleanup）都排一次原子重写；写入串行化，
 * 全部经由 core 的 `atomicWrite`（0600 + rename），不会读到半截文件。
 */
export class SessionStore {
  private readonly sessions = new Map<string, PersistedSession>();
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly storageFile: string | undefined;
  private readonly now: () => number;
  private flushChain: Promise<void> = Promise.resolve();

  constructor(options: SessionStoreOptions) {
    this.idleMs = options.idleMs;
    this.absoluteMs = options.absoluteMs;
    this.storageFile = options.storageFile;
    this.now = options.now ?? (() => Date.now());
    this.loadFromDisk();
  }

  /** 新建会话（首次登录）。 */
  create(subject: AuthSubject, meta: SessionMeta = {}): IssuedSession {
    return this.issue(subject, meta);
  }

  /**
   * 登录后轮换（防会话固定）：旧 id 立即失效，同一个 subject 换新 id + 新 CSRF。
   */
  rotate(sid: string, meta: SessionMeta = {}): IssuedSession | null {
    const current = this.get(sid);
    if (current === null) return null;
    this.revoke(sid);
    return this.issue(current.subject, meta);
  }

  /** 校验会话 id（空闲 + 绝对超时），并按 60s 节流推进 lastSeenAt。 */
  get(sid: string): SessionSnapshot | null {
    if (typeof sid !== 'string' || sid === '') return null;
    const key = sha256Hex(sid);
    const record = this.sessions.get(key);
    if (record === undefined) return null;
    const now = this.now();
    if (now >= record.expiresAt || now - record.lastSeenAt >= this.idleMs) {
      this.drop(key);
      return null;
    }
    if (now - record.lastSeenAt >= TOUCH_THROTTLE_MS) {
      record.lastSeenAt = now;
      this.scheduleFlush();
    }
    return {
      subject: { ...record.subject },
      csrfTokenHash: record.csrfTokenHash,
      csrfToken: record.csrfToken,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  /** 轮换 CSRF 令牌（页面重载后取新值）；返回新明文。 */
  rotateCsrf(sid: string): string | null {
    const key = sha256Hex(sid);
    const record = this.sessions.get(key);
    if (record === undefined) return null;
    const csrfToken = randomToken(32);
    record.csrfTokenHash = sha256Hex(csrfToken);
    record.csrfToken = csrfToken;
    this.scheduleFlush();
    return csrfToken;
  }

  /** 登出：只撤销这一个会话 id。 */
  revoke(sid: string): void {
    if (typeof sid !== 'string' || sid === '') return;
    this.drop(sha256Hex(sid));
  }

  /** 撤销某个 subject 的全部会话（例如把它从白名单移除）。 */
  revokeSubject(subjectId: string): number {
    let removed = 0;
    for (const [key, record] of this.sessions) {
      if (record.subject.id !== subjectId) continue;
      this.sessions.delete(key);
      removed += 1;
    }
    if (removed > 0) this.scheduleFlush();
    return removed;
  }

  /** CSRF 校验：调用方给明文，服务端只存 sha256(明文)。 */
  csrfValid(snapshot: SessionSnapshot, token: string | null | undefined): boolean {
    if (typeof token !== 'string' || token === '') return false;
    return constantTimeEqual(sha256Hex(token), snapshot.csrfTokenHash);
  }

  /** 清掉过期记录；返回清理条数。 */
  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, record] of this.sessions) {
      if (now < record.expiresAt && now - record.lastSeenAt < this.idleMs) continue;
      this.sessions.delete(key);
      removed += 1;
    }
    if (removed > 0) this.scheduleFlush();
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }

  /** 等待挂起的落盘写入完成（关闭进程 / 验收用）。 */
  async flush(): Promise<void> {
    await this.flushChain;
  }

  private issue(subject: AuthSubject, meta: SessionMeta): IssuedSession {
    const now = this.now();
    // 32 字节 = 256 bit CSPRNG；base64url 保证可直接放进 cookie。
    const sid = randomToken(32);
    const csrfToken = randomToken(32);
    const expiresAt = now + this.absoluteMs;
    this.sessions.set(sha256Hex(sid), {
      sidHash: sha256Hex(sid),
      subject: { ...subject },
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      csrfTokenHash: sha256Hex(csrfToken),
      csrfToken,
      uaHash: hashMeta(meta.userAgent),
      ipHash: hashMeta(meta.ip),
    });
    this.scheduleFlush();
    return { sid, csrfToken, expiresAt };
  }

  private drop(key: string): void {
    if (this.sessions.delete(key)) this.scheduleFlush();
  }

  private loadFromDisk(): void {
    if (this.storageFile === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.storageFile, 'utf8'));
    } catch {
      // Missing or corrupt file: start empty (a login fixes it, nothing is locked).
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const raw = (parsed as { sessions?: unknown }).sessions;
    if (!Array.isArray(raw)) return;
    const now = this.now();
    for (const item of raw) {
      const record = sanitizeRecord(item);
      if (record === null) continue;
      if (now >= record.expiresAt || now - record.lastSeenAt >= this.idleMs) continue;
      this.sessions.set(record.sidHash, record);
    }
  }

  private scheduleFlush(): void {
    if (this.storageFile === undefined) return;
    const file = this.storageFile;
    const payload = JSON.stringify({
      version: PERSIST_VERSION,
      // csrfToken is memory-only: strip it before it can reach the disk.
      sessions: [...this.sessions.values()].map((record) => ({ ...record, csrfToken: null })),
    });
    // 0600: the file holds hashed ids only, but it is still an auth artifact.
    this.flushChain = this.flushChain.then(() =>
      atomicWrite(file, payload, { mode: 0o600, ensureDir: true }),
    );
    this.flushChain = this.flushChain.then(
      () => undefined,
      () => undefined,
    );
  }
}

/** 只认回自己写过的形状；其它一律丢弃（防手改/坏文件）。 */
function sanitizeRecord(value: unknown): PersistedSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const subject = item.subject as Record<string, unknown> | undefined;
  if (typeof subject !== 'object' || subject === null) return null;
  if (typeof subject.id !== 'string' || subject.id === '') return null;
  if (typeof subject.backend !== 'string') return null;
  const numbers = ['createdAt', 'lastSeenAt', 'expiresAt'] as const;
  for (const key of numbers) {
    if (typeof item[key] !== 'number' || !Number.isFinite(item[key])) return null;
  }
  if (typeof item.sidHash !== 'string' || item.sidHash.length !== 64) return null;
  if (typeof item.csrfTokenHash !== 'string' || item.csrfTokenHash.length !== 64) return null;
  return {
    sidHash: item.sidHash,
    subject: {
      id: subject.id,
      backend: subject.backend,
      username: typeof subject.username === 'string' ? subject.username : null,
    },
    createdAt: item.createdAt as number,
    lastSeenAt: item.lastSeenAt as number,
    expiresAt: item.expiresAt as number,
    csrfTokenHash: item.csrfTokenHash,
    // Restored sessions have no plain token: the client calls /auth/csrf.
    csrfToken: null,
    uaHash: typeof item.uaHash === 'string' ? item.uaHash : null,
    ipHash: typeof item.ipHash === 'string' ? item.ipHash : null,
  };
}

/** 会话 cookie 属性。 */
export interface SessionCookiePolicy {
  name: string;
  /** 页面是否经 https 提供（决定 cookie 名与 Secure）。 */
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * Cookie name. https deployments get the __Host- prefix: the browser then
 * refuses any cookie that lacks Secure / Path=/ / has a Domain attribute.
 */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-vessel_sid' : 'vessel_sid';
}

/** 新建会话的 Set-Cookie。 */
export function buildSessionCookie(policy: SessionCookiePolicy, sid: string): string {
  return (
    policy.name +
    '=' +
    sid +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
    String(Math.max(0, Math.floor(policy.maxAgeSeconds))) +
    (policy.secure ? '; Secure' : '')
  );
}

/** 清空会话 cookie 的 Set-Cookie（登出 / 会话无效）。 */
export function buildClearedSessionCookie(policy: SessionCookiePolicy): string {
  return (
    policy.name +
    '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' +
    (policy.secure ? '; Secure' : '')
  );
}

/** 读一个 cookie 值；不存在返回 null。 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (header === null || header === '') return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}
