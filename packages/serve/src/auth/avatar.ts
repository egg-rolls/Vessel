/**
 * 登录头像的服务端半边：**平台代取 + 缓存**，前端只认自己的 `/auth/avatar`。
 *
 * 为什么不让浏览器直连各家 CDN：
 * - 前端就不必把 `img-src` 放开到外域（`img-src 'self'` 保持），CSP 只需要信任自己；
 * - 各家的地址形态会变、可能带短期签名、可能要求 token —— 这些都不该泄漏进浏览器；
 * - 缓存与限流只在一个地方做。
 *
 * 三种真实形状（见 `@vessel-agent/config` 的 `AuthAvatarRef`）：
 * - `url`（GitHub / Gitee 的 `avatar_url`）：服务端代取那个公开地址；
 * - `graph-photo`（Microsoft）：带 access token 去 Graph `GET /me/photo/$value` 取二进制。
 *   用户**没设头像**时 Graph 返回 404，这是常态：落「无头像」，不当错误。
 *
 * 安全底线：
 * - token 只在内存里（`rememberCredentials`），**永不**进会话文件 / 日志 / 响应体；
 * - 代取的公开地址必须是**公网 http(s)**（`isPublicHttpUrl`）：provider 给什么我们都不打内网；
 * - 只接受 `image/*`，超过 `maxBytes` 直接丢弃走前端兜底；
 * - 日志只写 host，不写完整 URL（URL 里可能有签名参数）。
 *
 * @module @vessel-agent/serve/auth/avatar
 */

import type { AuthAvatarRef, OAuthCredentials } from '@vessel-agent/config';

/** 取头像失败的原因；调用方一律当「没有头像」处理（404 + 前端兜底）。 */
export type AvatarFailure =
  | 'no_avatar'
  | 'no_credentials'
  | 'unsafe_url'
  | 'too_large'
  | 'unsupported_type'
  | 'fetch_failed';

export type AvatarResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; reason: AvatarFailure };

/** 内存里的令牌来源：`rememberCredentials` 时由登录流程创建（闭包已捕获 client 凭据）。 */
export interface AvatarCredentialSource {
  accessToken: string;
  /** epoch ms；不知道就省略（按「不过期」处理）。 */
  expiresAt?: number | undefined;
  /** 需要时换新；返回 null = 换不到（没有 refresh token / provider 拒绝）。 */
  refresh?: (() => Promise<OAuthCredentials | null>) | undefined;
}

export interface AvatarServiceOptions {
  fetchImpl?: typeof fetch | undefined;
  log?: ((message: string) => void) | undefined;
  now?: (() => number) | undefined;
  /** 正缓存 TTL，缺省 1h。 */
  ttlMs?: number | undefined;
  /** 负缓存 TTL（「这个人没有头像」），缺省 5min：避免每次渲染都去打 Graph/CDN。 */
  negativeTtlMs?: number | undefined;
  /** 单张上限，缺省 256KB。 */
  maxBytes?: number | undefined;
  /** 单次请求超时，缺省 3s。 */
  timeoutMs?: number | undefined;
  /** 缓存条数上限，缺省 128（超出按插入顺序淘汰）。 */
  maxEntries?: number | undefined;
  /** Graph 端点覆盖（测试用），缺省 `https://graph.microsoft.com/v1.0`。 */
  graphBase?: string | undefined;
}

const DEFAULTS = {
  ttlMs: 60 * 60 * 1000,
  negativeTtlMs: 5 * 60 * 1000,
  maxBytes: 256 * 1024,
  timeoutMs: 3000,
  maxEntries: 128,
  graphBase: 'https://graph.microsoft.com/v1.0',
} as const;

type CacheEntry =
  | { kind: 'image'; bytes: Uint8Array; contentType: string; expiresAt: number }
  | { kind: 'none'; expiresAt: number };

/**
 * 超时信号：**显式** `AbortController` + `setTimeout`，不用 `AbortSignal.timeout`。
 *
 * 为什么要这么写：`AbortSignal.timeout()` 的定时器是 unref 的，在「只有一次挂起的
 * await、没有其它定时器」的场景里（比如接了一个不响应的 fetch 桩）**不会触发** ——
 * 本仓库的 bun 1.3.9 上实测会直接把调用挂死。这里用自己的 timer，并且一定在 finally 里
 * `dispose()`，既保证超时成立，也不留悬挂定时器。
 */
function startTimeout(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** 内网 / 保留地址：代取时一律拒绝（provider 给什么都不打内网）。 */ function isPrivateHostname(
  hostname: string,
): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return true;
  // IPv6：回环 / 链路本地 / 唯一本地
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true; // 云元数据
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** 只有「公网 http(s) URL」才允许代取。 */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.hostname === '') return false;
  return !isPrivateHostname(url.hostname);
}

/** 日志里只写 host（URL 可能带签名参数）。 */
function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '<invalid-url>';
  }
}

export class AvatarService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly credentials = new Map<string, AvatarCredentialSource>();
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly graphBase: string;

  constructor(options: AvatarServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULTS.negativeTtlMs;
    this.maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
    this.graphBase = (options.graphBase ?? DEFAULTS.graphBase).replace(/\/+$/, '');
  }

  /**
   * 记住这个用户的 Graph 令牌来源（**只在内存**）。
   *
   * `refresh` 是登录流程闭上来的闭包（里面握着 client id/secret）；本服务不关心 provider
   * 细节，也不需要知道 token 怎么换。
   */
  rememberCredentials(subjectId: string, source: AvatarCredentialSource): void {
    this.credentials.set(subjectId, source);
  }

  /** 会话结束时丢掉令牌（登出 / 会话过期）。 */
  forget(subjectId: string): void {
    this.credentials.delete(subjectId);
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`photo:${subjectId}`)) this.cache.delete(key);
    }
  }

  /** 该用户是否有服务端令牌（`graph-photo` 没有它就取不到）。 */
  hasCredentials(subjectId: string): boolean {
    return this.credentials.has(subjectId);
  }

  /**
   * 取头像。**任何失败都返回 `{ok:false}`**，不抛错：头像不是关键路径。
   *
   * `ref` 为 null 直接算「没有头像」，不打网络。
   */
  async get(subjectId: string, ref: AuthAvatarRef | null): Promise<AvatarResult> {
    if (ref === null) return { ok: false, reason: 'no_avatar' };
    const key = ref.kind === 'url' ? `url:${ref.url}` : `photo:${subjectId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.kind === 'image'
        ? { ok: true, bytes: cached.bytes, contentType: cached.contentType }
        : { ok: false, reason: 'no_avatar' };
    }
    const result =
      ref.kind === 'url' ? await this.fetchPublic(ref.url) : await this.fetchGraph(subjectId);
    this.store(key, result);
    return result;
  }

  private store(key: string, result: AvatarResult): void {
    const now = this.now();
    if (result.ok) {
      this.cache.set(key, {
        kind: 'image',
        bytes: result.bytes,
        contentType: result.contentType,
        expiresAt: now + this.ttlMs,
      });
    } else {
      this.cache.set(key, { kind: 'none', expiresAt: now + this.negativeTtlMs });
    }
    // 有界缓存：Map 保插入顺序，超上限从最早插入的开始丢。
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }

  /** 公开地址（GitHub / Gitee）：服务端代取，同样走超时 + 体积 + 类型校验。 */
  private async fetchPublic(url: string): Promise<AvatarResult> {
    if (!isPublicHttpUrl(url)) {
      this.log(`avatar: refusing to fetch a non-public URL (host=${hostOf(url)})`);
      return { ok: false, reason: 'unsafe_url' };
    }
    try {
      const timeout = startTimeout(this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'image/*', 'user-agent': 'vessel-agent' },
          signal: timeout.signal,
          redirect: 'follow',
        });
      } finally {
        timeout.dispose();
      }
      if (!response.ok) {
        this.log(
          `avatar: public fetch failed host=${hostOf(url)} status=${String(response.status)}`,
        );
        return { ok: false, reason: 'no_avatar' };
      }
      // 重定向后落点也要是公网（防止被 302 到内网）。
      if (!isPublicHttpUrl(response.url === '' ? url : response.url)) {
        this.log(`avatar: redirect left the public internet (host=${hostOf(response.url)})`);
        return { ok: false, reason: 'unsafe_url' };
      }
      return await this.readImage(response);
    } catch (error) {
      this.log(`avatar: public fetch error host=${hostOf(url)} (${errorName(error)})`);
      return { ok: false, reason: 'fetch_failed' };
    }
  }

  /** Microsoft：带 token 去 Graph 取 `/me/photo/$value`（404 = 没设头像，是常态）。 */
  private async fetchGraph(subjectId: string): Promise<AvatarResult> {
    const source = this.credentials.get(subjectId);
    if (source === undefined) {
      // 重启后内存里的令牌没了；头像消失，登录状态不受影响。
      this.log('avatar: no in-memory Graph credentials for this session');
      return { ok: false, reason: 'no_credentials' };
    }
    const first = await this.requestGraphPhoto(subjectId, source);
    if (first.kind === 'retry') {
      const refreshed = await this.refresh(source);
      if (refreshed === null) return { ok: false, reason: 'no_credentials' };
      const second = await this.requestGraphPhoto(subjectId, refreshed);
      return second.kind === 'done' ? second.result : { ok: false, reason: 'no_avatar' };
    }
    return first.result;
  }

  private async requestGraphPhoto(
    subjectId: string,
    source: AvatarCredentialSource,
  ): Promise<{ kind: 'done'; result: AvatarResult } | { kind: 'retry' }> {
    if (source.expiresAt !== undefined && source.expiresAt <= this.now()) {
      return source.refresh === undefined
        ? { kind: 'done', result: { ok: false, reason: 'no_credentials' } }
        : { kind: 'retry' };
    }
    try {
      const timeout = startTimeout(this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.graphBase}/me/photo/$value`, {
          method: 'GET',
          headers: { authorization: `Bearer ${source.accessToken}`, 'user-agent': 'vessel-agent' },
          signal: timeout.signal,
        });
      } finally {
        timeout.dispose();
      }
      if (response.status === 401) {
        // access token 失效：如果有刷新能力就换一次，否则当没有头像。
        return source.refresh === undefined
          ? { kind: 'done', result: { ok: false, reason: 'no_credentials' } }
          : { kind: 'retry' };
      }
      if (response.status === 403 || response.status === 404) {
        // 403：租户没给 User.Read / 照片被策略挡；404：用户没设头像 —— 都是「没有头像」。
        this.log(
          `avatar: graph photo unavailable status=${String(response.status)} user=${subjectId}`,
        );
        return { kind: 'done', result: { ok: false, reason: 'no_avatar' } };
      }
      if (!response.ok) {
        this.log(`avatar: graph photo failed status=${String(response.status)} user=${subjectId}`);
        return { kind: 'done', result: { ok: false, reason: 'fetch_failed' } };
      }
      return { kind: 'done', result: await this.readImage(response) };
    } catch (error) {
      this.log(`avatar: graph photo error user=${subjectId} (${errorName(error)})`);
      return { kind: 'done', result: { ok: false, reason: 'fetch_failed' } };
    }
  }

  /** 用登录时捕获的闭包换新令牌；换不到就当没有（不抛）。 */
  private async refresh(source: AvatarCredentialSource): Promise<AvatarCredentialSource | null> {
    if (source.refresh === undefined) return null;
    try {
      const next = await source.refresh();
      if (next === null) return null;
      return { accessToken: next.accessToken, expiresAt: next.expiresAt };
    } catch (error) {
      this.log(`avatar: token refresh failed (${errorName(error)})`);
      return null;
    }
  }

  /** 字节 + 类型 + 体积校验（两条取图路径共用）。 */
  private async readImage(response: Response): Promise<AvatarResult> {
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!contentType.toLowerCase().startsWith('image/')) {
      this.log(
        `avatar: dropped non-image content-type=${contentType === '' ? '<none>' : contentType}`,
      );
      return { ok: false, reason: 'unsupported_type' };
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      this.log(`avatar: dropped oversized image (content-length=${String(declared)})`);
      return { ok: false, reason: 'too_large' };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return { ok: false, reason: 'no_avatar' };
    if (bytes.byteLength > this.maxBytes) {
      this.log(`avatar: dropped oversized image (bytes=${String(bytes.byteLength)})`);
      return { ok: false, reason: 'too_large' };
    }
    return { ok: true, bytes, contentType };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
