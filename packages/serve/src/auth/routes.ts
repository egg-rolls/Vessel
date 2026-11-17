/**
 * 0.56 WebUI 登录：登录流程的 HTTP 面。
 *
 * 路由（全部同源、全部 no-store）：
 *   GET  /auth/status           我是谁 + 登录后端 + CSRF 令牌
 *   GET  /auth/csrf             轮换并返回 CSRF 令牌（刷新页面后取）
 *   GET  /auth/github/start     302 去 GitHub（一次性 state + PKCE）
 *   GET  /auth/github/callback  校验 state/code、比对白名单、建会话
 *   POST /auth/logout           撤销会话（必须有 CSRF）
 *
 * CSRF 用**同步令牌**：令牌随会话生成，只经 `/auth/status`（no-store）交给同源脚本，
 * 所有用 cookie 鉴权的变更类请求必须在 `x-vessel-csrf` 头里带回来。不用双提交：
 * 同父域下的兄弟子域可以写 cookie，双提交挡不住它。
 *
 * @module @vessel-agent/serve/auth/routes
 */

import { createHash } from 'node:crypto';
import type { RequestEdge } from '../gateway/auth.js';
import {
  type AuthBackendConfig,
  buildAuthorizeUrl,
  buildRedirectUri,
  completeGitHubLogin,
  GITHUB_CALLBACK_PATH,
  type GitHubEndpoints,
  OAuthFlowStore,
  resolveClientSecret,
} from './github-oauth.js';
import {
  type AuthSubject,
  buildClearedSessionCookie,
  buildSessionCookie,
  type IssuedSession,
  randomToken,
  readCookie,
  type SessionCookiePolicy,
  type SessionMeta,
  type SessionSnapshot,
  SessionStore,
  sessionCookieName,
} from './session.js';

/** 同步令牌（CSRF）用的请求头。 */
export const CSRF_HEADER = 'x-vessel-csrf';

/** OAuth 往返用的短命绑定 cookie。
 *  SameSite=Lax：Strict 的 cookie 在从 GitHub 跨站回跳时会被丢弃，那样每次登录都会失败。
 */
const OAUTH_BINDER_COOKIE = 'vessel_oauth';
const OAUTH_BINDER_COOKIE_SECURE = '__Host-vessel_oauth';
const OAUTH_BINDER_MAX_AGE_S = 600;

export interface AuthSessionSettings {
  /** 空闲超时（分钟，滑动）；缺省 30。 */
  idleMinutes: number;
  /** 绝对超时（小时）；缺省 12。 */
  absoluteHours: number;
  /** 可选会话落盘文件；省略 = 纯内存。 */
  storageFile?: string | undefined;
}

/** 跑登录面需要的全部设置。 */
export interface AuthSettings {
  /** 公网 origin（如 https://egg-rolls.top）：redirect_uri 的唯一来源。 */
  publicOrigin: string | null;
  /** 额外允许的 Host（publicOrigin 与回环之外再放行的域名）。 */
  allowedHosts: string[];
  /** 登录后端；空 = 未配置 OAuth，行为与今天一致。 */
  backends: AuthBackendConfig[];
  session: AuthSessionSettings;
}

export interface AuthServiceOptions extends AuthSettings {
  /** 解析密钥用的环境变量；缺省 process.env。 */
  env?: Record<string, string | undefined> | undefined;
  /** GitHub 端点覆盖（验收桩 / GHE）。 */
  endpoints?: GitHubEndpoints | undefined;
  /** fetch 覆盖（验收桩）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch | undefined;
  /** 诊断输出；永不接收密钥。 */
  log?: ((message: string) => void) | undefined;
  /** 可注入时钟。 */
  now?: (() => number) | undefined;
}

/** 登录层需要的请求事实（全部取自受信边缘）。 */
export interface AuthRequestContext {
  edge: RequestEdge;
  /** 对端地址；只用于审计哈希。 */
  address: string | null;
}

export type AuthGateResult =
  | { ok: true; snapshot: SessionSnapshot; sid: string }
  | { ok: false; reason: 'no_session' | 'csrf_failed' | 'csrf_missing' };

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 登录页路径（SPA 路由）；失败一律回到这里并带 ?error=...。 */
export const LOGIN_PATH = '/login';

/** 登出状态下也必须可达的路径。 */
export function isAuthPublicPath(pathname: string): boolean {
  if (pathname === LOGIN_PATH) return true;
  return pathname === '/auth' || pathname.startsWith('/auth/');
}

/**
 * 登录面 + 会话闸。
 *
 * 没配 auth.backends 的 gateway 行为与 0.55 逐字一致：服务报 disabled、不 401 任何人、
 * 前端不渲染登录按钮（没有坏 UI，也不会把自己锁在外面）。
 */
export class AuthService {
  readonly settings: AuthSettings;
  readonly sessions: SessionStore;
  readonly flows: OAuthFlowStore;
  private readonly env: Record<string, string | undefined>;
  private readonly endpoints: GitHubEndpoints | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly log: (message: string) => void;

  constructor(options: AuthServiceOptions) {
    const idleMinutes = Number.isFinite(options.session.idleMinutes)
      ? Math.max(1, options.session.idleMinutes)
      : 30;
    const absoluteHours = Number.isFinite(options.session.absoluteHours)
      ? Math.max(1, options.session.absoluteHours)
      : 12;
    this.settings = {
      publicOrigin: options.publicOrigin,
      allowedHosts: [...options.allowedHosts],
      backends: [...options.backends],
      session: {
        idleMinutes,
        absoluteHours,
        storageFile: options.session.storageFile,
      },
    };
    this.env = options.env ?? (process.env as Record<string, string | undefined>);
    this.endpoints = options.endpoints;
    this.fetchImpl = options.fetchImpl;
    this.log = options.log ?? (() => {});
    this.sessions = new SessionStore({
      idleMs: idleMinutes * 60_000,
      absoluteMs: absoluteHours * 3_600_000,
      storageFile: options.session.storageFile,
      now: options.now,
    });
    this.flows = new OAuthFlowStore({ now: options.now });
  }

  /** 至少配了一个交互式后端时为 true。 */
  get enabled(): boolean {
    return this.settings.backends.length > 0;
  }

  /** 当前页面协议下生效的 cookie 策略。 */
  cookiePolicy(secure: boolean): SessionCookiePolicy {
    return {
      name: sessionCookieName(secure),
      secure,
      // Max-Age follows the absolute lifetime; the store still enforces idle.
      maxAgeSeconds: this.settings.session.absoluteHours * 3600,
    };
  }

  /** 本请求携带的会话（没有则 null）。 */
  readSession(
    req: Request,
    ctx: AuthRequestContext,
  ): { sid: string; snapshot: SessionSnapshot } | null {
    const policy = this.cookiePolicy(this.isSecureContext(ctx));
    const sid = readCookie(req, policy.name);
    if (sid === null) return null;
    const snapshot = this.sessions.get(sid);
    if (snapshot === null) return null;
    return { sid, snapshot };
  }

  /**
   * 是否处于 https 上下文（受信边缘说了算；反代场景看 X-Forwarded-Proto）。
   *
   * 刻意**不**从 publicOrigin 推导：明文的 http 响应里带 Secure 的 cookie 会被浏览器
   * 直接丢弃，所以以请求协议为准。反代后面这个协议就是 https。
   */
  isSecureContext(ctx: AuthRequestContext): boolean {
    return ctx.edge.protocol === 'https';
  }

  /**
   * 用 cookie 鉴权的 API 的闸。
   *
   * 变更类请求还必须带同步令牌，且 Origin（若有）必须与受信边缘一致：
   * cookie 本身不是能力凭证 —— 这才是 SameSite=Strict 有意义的前提。
   */
  authorize(
    req: Request,
    ctx: AuthRequestContext,
    options: { mutating?: boolean } = {},
  ): AuthGateResult {
    const session = this.readSession(req, ctx);
    if (session === null) return { ok: false, reason: 'no_session' };
    const mutating = options.mutating ?? false;
    if (mutating) {
      const origin = req.headers.get('origin');
      if (origin !== null && !this.originMatchesEdge(origin, ctx)) {
        return { ok: false, reason: 'csrf_failed' };
      }
      const token = req.headers.get(CSRF_HEADER);
      if (token === null || token === '') return { ok: false, reason: 'csrf_missing' };
      if (!this.sessions.csrfValid(session.snapshot, token)) {
        return { ok: false, reason: 'csrf_failed' };
      }
    }
    return { ok: true, snapshot: session.snapshot, sid: session.sid };
  }

  /** 在途回合的绑定值；浏览器没有则 null。 */
  private readBinder(req: Request, ctx: AuthRequestContext): string | null {
    const name = this.isSecureContext(ctx) ? OAUTH_BINDER_COOKIE_SECURE : OAUTH_BINDER_COOKIE;
    return readCookie(req, name);
  }

  /** Origin 头必须与受信边缘解析出的 host 一致。 */
  private originMatchesEdge(origin: string, ctx: AuthRequestContext): boolean {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (ctx.edge.host === null) return false;
    return parsed.host.toLowerCase() === ctx.edge.host.toLowerCase();
  }

  /** GET /auth/status：我是谁、有哪些登录后端、CSRF 令牌。 */
  private statusResponse(req: Request, ctx: AuthRequestContext): Response {
    const session = this.readSession(req, ctx);
    const user = session === null ? null : session.snapshot.subject;
    return jsonResponse({
      authEnabled: this.enabled,
      authenticated: session !== null,
      user: user === null ? null : { id: user.id, backend: user.backend, username: user.username },
      csrfToken: session === null ? null : session.snapshot.csrfToken,
      loginBackends: this.enabled ? [this.describeBackend()] : [],
      // Ops hint for the login page: the exact redirect_uri to register on GitHub.
      publicOrigin: this.settings.publicOrigin,
    });
  }

  /** 后端的公开描述（不含密钥、不含白名单）。 */
  private describeBackend(): {
    id: string;
    kind: string;
    label: string;
    startPath: string;
  } {
    const backend = this.githubBackend();
    return {
      id: 'github',
      kind: backend?.kind ?? 'github_oauth',
      label: backend?.label ?? 'Sign in with GitHub',
      startPath: '/auth/github/start',
    };
  }

  private githubBackend(): AuthBackendConfig | null {
    for (const backend of this.settings.backends) {
      if (backend.kind === 'github_oauth') return backend;
    }
    return null;
  }

  /** GET /auth/csrf：内存丢了旧令牌时轮换并返回一个新的。 */
  private csrfResponse(req: Request, ctx: AuthRequestContext): Response {
    const session = this.readSession(req, ctx);
    if (session === null) return jsonResponse({ error: 'session_required' }, 401);
    const token = this.sessions.rotateCsrf(session.sid);
    if (token === null) return jsonResponse({ error: 'session_required' }, 401);
    return jsonResponse({ csrfToken: token });
  }

  /** POST /auth/logout：撤销会话、清 cookie、告诉前端。 */
  private logoutResponse(req: Request, ctx: AuthRequestContext): Response {
    const policy = this.cookiePolicy(this.isSecureContext(ctx));
    const cleared = buildClearedSessionCookie(policy);
    const session = this.readSession(req, ctx);
    if (session !== null) {
      const origin = req.headers.get('origin');
      if (origin !== null && !this.originMatchesEdge(origin, ctx)) {
        return jsonResponse({ error: 'csrf_failed' }, 403, { 'set-cookie': cleared });
      }
      const token = req.headers.get(CSRF_HEADER);
      if (token === null || token === '') {
        return jsonResponse({ error: 'csrf_missing' }, 403, { 'set-cookie': cleared });
      }
      if (!this.sessions.csrfValid(session.snapshot, token)) {
        return jsonResponse({ error: 'csrf_failed' }, 403, { 'set-cookie': cleared });
      }
      this.sessions.revoke(session.sid);
    }
    // Idempotent: logging out twice, or without a session, still ends clean.
    return jsonResponse({ ok: true }, 200, { 'set-cookie': cleared });
  }

  /** GET /auth/github/start：一次性 state + PKCE，然后 302 去 GitHub。 */
  private githubStart(ctx: AuthRequestContext): Response {
    const backend = this.githubBackend();
    if (backend === null) return jsonResponse({ error: 'backend_not_configured' }, 404);
    const origin = this.settings.publicOrigin;
    if (origin === null) {
      // Never derive redirect_uri from Host / X-Forwarded-*: that is attacker input.
      this.log('github_oauth: auth.publicOrigin missing, refusing to build a redirect_uri');
      return jsonResponse({ error: 'public_origin_missing' }, 500);
    }
    if (resolveClientSecret(backend, this.env) === null) {
      this.log(`github_oauth: env ${backend.clientSecretEnv} is not set`);
      return redirectResponse(`${LOGIN_PATH}?error=secret_missing`);
    }
    const secure = this.isSecureContext(ctx);
    const binder = randomToken(32);
    const redirectUri = buildRedirectUri(origin);
    const flow = this.flows.issue({ redirectUri, binder: sha256Hex(binder) });
    const target = buildAuthorizeUrl({
      config: backend,
      flow,
      redirectUri,
      endpoints: this.endpoints,
    });
    return redirectResponse(target, [this.binderCookie(secure, binder)]);
  }

  /** 绑定 cookie：HttpOnly + Lax（必须能跨站回跳）+ 10 分钟。 */
  private binderCookie(secure: boolean, value: string): string {
    const name = secure ? OAUTH_BINDER_COOKIE_SECURE : OAUTH_BINDER_COOKIE;
    return (
      name +
      '=' +
      value +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
      String(OAUTH_BINDER_MAX_AGE_S) +
      (secure ? '; Secure' : '')
    );
  }

  /** 清掉绑定 cookie（成功、失败、重放都清）。 */
  private clearedBinderCookie(secure: boolean): string {
    const name = secure ? OAUTH_BINDER_COOKIE_SECURE : OAUTH_BINDER_COOKIE;
    return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  /** GET /auth/github/callback：校验 state + code、比对白名单、建会话。 */
  private async githubCallback(req: Request, url: URL, ctx: AuthRequestContext): Promise<Response> {
    const secure = this.isSecureContext(ctx);
    const clearedBinder = this.clearedBinderCookie(secure);
    const backend = this.githubBackend();
    if (backend === null) {
      return jsonResponse({ error: 'backend_not_configured' }, 404, {
        'set-cookie': clearedBinder,
      });
    }
    const binder = this.readBinder(req, ctx);
    const flow = this.flows.consume(
      url.searchParams.get('state'),
      binder === null ? null : sha256Hex(binder),
    );
    if (flow === null) {
      // Unknown / expired / replayed state, or a state minted for another browser.
      this.log('github_oauth: state rejected (unknown, expired, replayed or binder mismatch)');
      return redirectResponse(`${LOGIN_PATH}?error=state_invalid`, [clearedBinder]);
    }
    const result = await completeGitHubLogin({
      config: backend,
      env: this.env,
      code: url.searchParams.get('code'),
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier,
      fetchImpl: this.fetchImpl,
      endpoints: this.endpoints,
      log: this.log,
    });
    if (!result.ok) {
      return redirectResponse(`${LOGIN_PATH}?error=${result.failure}`, [clearedBinder]);
    }
    const subject: AuthSubject = {
      id: `github:${result.userId}`,
      backend: 'github',
      username: result.username,
    };
    const existing = this.readSession(req, ctx);
    const issued = this.issueSession(subject, req, ctx, existing === null ? null : existing.sid);
    const policy = this.cookiePolicy(secure);
    this.log(`github_oauth: login ok for ${subject.id}`);
    return redirectResponse('/', [buildSessionCookie(policy, issued.sid), clearedBinder]);
  }

  /**
   * 建登录后的会话。已存在活会话时**轮换**：id 与 CSRF 令牌都换新的（防会话固定）。
   */
  private issueSession(
    subject: AuthSubject,
    req: Request,
    ctx: AuthRequestContext,
    existingSid: string | null,
  ): IssuedSession {
    const meta: SessionMeta = {
      ip: ctx.address,
      userAgent: req.headers.get('user-agent'),
    };
    if (existingSid !== null) {
      const rotated = this.sessions.rotate(existingSid, meta);
      if (rotated !== null) return rotated;
    }
    return this.sessions.create(subject, meta);
  }

  /** 处理 /auth/*；不是本模块的路径返回 null，交给后面的静态 / RPC。 */
  async handle(req: Request, url: URL, ctx: AuthRequestContext): Promise<Response | null> {
    const path = url.pathname;
    const method = req.method.toUpperCase();
    if (path === '/auth/status') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET');
      return this.statusResponse(req, ctx);
    }
    if (path === '/auth/csrf') {
      if (method !== 'GET') return methodNotAllowed('GET');
      return this.csrfResponse(req, ctx);
    }
    if (path === '/auth/logout') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return this.logoutResponse(req, ctx);
    }
    if (path === '/auth/github/start') {
      if (method !== 'GET') return methodNotAllowed('GET');
      return this.githubStart(ctx);
    }
    if (path === GITHUB_CALLBACK_PATH) {
      if (method !== 'GET') return methodNotAllowed('GET');
      return await this.githubCallback(req, url, ctx);
    }
    if (path === '/auth' || path === '/auth/') {
      return jsonResponse({
        authEnabled: this.enabled,
        endpoints: [
          '/auth/status',
          '/auth/csrf',
          '/auth/logout',
          '/auth/github/start',
          GITHUB_CALLBACK_PATH,
        ],
      });
    }
    // `/login` is a static SPA route: fall through so the shell can render it.
    if (path === '/auth' || path.startsWith('/auth/')) {
      return jsonResponse({ error: 'not_found' }, 404);
    }
    return null;
  }

  /** 清理过期会话与在途流程（由 server 定时调用）。 */
  cleanup(): void {
    this.sessions.cleanup();
    this.flows.cleanup();
  }

  /** 等待挂起的落盘写入（关闭进程）。 */
  async flush(): Promise<void> {
    await this.sessions.flush();
  }
}

function methodNotAllowed(allowed: string): Response {
  return jsonResponse({ error: 'method_not_allowed' }, 405, { allow: allowed });
}
