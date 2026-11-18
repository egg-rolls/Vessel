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

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type AuthStrategy,
  authStrategies,
  getAuthStrategy,
  PASSWORD_STRATEGY_KIND,
  redirectAuthStrategies,
} from '@vessel-agent/config';
import { isLoopbackAddress, type RequestEdge } from '../gateway/auth.js';
import { BootstrapCodes, PendingLogins } from './bootstrap.js';
import { CredentialStore, normalizeRecoveryCode } from './credentials.js';
import {
  buildAuthorizeUrl,
  buildRedirectUri,
  completeOAuthLogin,
  type OAuthBackendConfig,
  type OAuthEndpoints,
  OAuthFlowStore,
  oauthCallbackPath,
  oauthStartPath,
  resolveClientSecret,
} from './oauth.js';
import { mergePublicOrigins, selectPublicOrigin } from './origins.js';
import { dummyPasswordCheck, passwordPolicyError, verifyPassword } from './password.js';
import { accountKey, ipKey, LoginLimiter, retryAfterSeconds } from './ratelimit.js';
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
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from './totp.js';

/** 同步令牌（CSRF）用的请求头。 */
export const CSRF_HEADER = 'x-vessel-csrf';

/** OAuth 往返用的短命绑定 cookie。
 *  SameSite=Lax：Strict 的 cookie 在从 GitHub 跨站回跳时会被丢弃，那样每次登录都会失败。
 */
const OAUTH_BINDER_COOKIE = 'vessel_oauth';
const OAUTH_BINDER_COOKIE_SECURE = '__Host-vessel_oauth';
const OAUTH_BINDER_MAX_AGE_S = 600;

/** 登录表单 JSON 体的上限：口令不会超过这个长度。 */
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

/** 口令后端的运行配置（口令 hash 只从 env 名 / 凭据文件取，不在配置里）。 */
export interface PasswordBackendConfig {
  kind: 'password';
  username?: string | undefined;
  passwordHashEnv?: string | undefined;
  totpSecretEnv?: string | undefined;
  label?: string | undefined;
}

/** 一个登录后端：任意已注册的 OAuth 策略或口令（可叠加 TOTP）。 */
export type AuthBackendConfig = OAuthBackendConfig | PasswordBackendConfig;

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
  /**
   * 0.60：公网来源白名单（有序、已归一、去重）。空 / 省略 = 不启用公网来源。
   *
   * `redirect_uri` 只能由这里的某个来源 + 固定路径拼出；选哪一个由**受信边缘**决定
   * （见 `./origins.js`）。与 `publicOrigin` 同时给出时合并去重。
   */
  publicOrigins?: string[] | undefined;
  /**
   * 单个公网 origin（如 https://egg-rolls.top）：语义等价于「只有一个元素的
   * `publicOrigins`」，保留是为了向后兼容。
   */
  publicOrigin?: string | null;
  /** 额外允许的 Host（publicOrigins 与回环之外再放行的域名）。 */
  allowedHosts: string[];
  /** 登录后端；空 = 未配置登录，行为与今天一致。 */
  backends: AuthBackendConfig[];
  session: AuthSessionSettings;
  /** 凭据库文件（口令 hash / TOTP 密钥 / 恢复码 hash）；省略 = 纯内存。 */
  credentialsFile?: string | undefined;
  /** 登录限速状态文件；省略 = 纯内存（重启即清零）。 */
  lockoutFile?: string | undefined;
  /** 一次性引导码租期（毫秒）；缺省 10 分钟。 */
  bootstrapTtlMs?: number | undefined;
}

export interface AuthServiceOptions extends AuthSettings {
  /** 解析密钥用的环境变量；缺省 process.env。 */
  env?: Record<string, string | undefined> | undefined;
  /** OAuth 端点覆盖（验收桩 / 私有部署）；省略 = 用策略自带的正式端点。 */
  endpoints?: OAuthEndpoints | undefined;
  /** fetch 覆盖（验收桩）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch | undefined;
  /**
   * `GET /auth/whoami` 的运行期事实（node / team）。
   *
   * 登录层只认识请求与会话，不认识 node 注册表与 team；这两样由组合根注入。
   * 不注入时 whoami 只报 `identity` / `backends` / `auth_mode`，`node` 与 `team`
   * 一律 null（前端据此降级），**不猜**。
   */
  runtimeInfo?: ((req: Request) => WhoamiRuntimeInfo | Promise<WhoamiRuntimeInfo>) | undefined;
  /**
   * 平台 token（本进程实际生效的那个值）：`POST /auth/unlock` 用它做「确实是本机主人」
   * 的第二个凭据。**只比较、不回显、不落盘**。
   */
  platformToken?: string | undefined;
  /** 诊断输出；永不接收口令 / TOTP 密钥 / 恢复码。 */
  log?: ((message: string) => void) | undefined;
  /** 可注入时钟。 */
  now?: (() => number) | undefined;
}

/** `GET /auth/whoami` 里 node / team 的形状（组合根注入）。 */
export interface WhoamiRuntimeInfo {
  node: { id: string; name: string; state: string } | null;
  team: { id: string; name: string } | null;
}

/** 一个可发起登录的后端（`/auth/whoami` 的 `backends`）。 */
export interface WhoamiBackend {
  id: string;
  label: string;
  kind: string;
  /** 缺 secret / 缺 clientId 时为 true，并给出 `reason`。 */
  disabled?: boolean;
  reason?: string;
}

/** `GET /auth/whoami` 的返回体（契约见 0.62 前端单子 C）。 */
export interface AuthWhoami {
  identity: { name: string; id: string; role: string } | null;
  node: { id: string; name: string; state: string } | null;
  team: { id: string; name: string } | null;
  backends: WhoamiBackend[];
  auth_mode: 'cookie' | 'bearer' | 'none';
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
  /**
   * 0.60：公网来源白名单（有序、已归一、去重）。
   *
   * 所有「用哪个来源拼 redirect_uri」的判断都读这一份，不读单个 `publicOrigin`：
   * 两处各读一个字段，迟早会漂移成「CSP 放行 A、登录跳 B」。
   */
  readonly publicOrigins: string[];
  readonly sessions: SessionStore;
  readonly flows: OAuthFlowStore;
  readonly credentials: CredentialStore;
  readonly limiter: LoginLimiter;
  readonly bootstraps: BootstrapCodes;
  readonly pendingLogins: PendingLogins;
  /**
   * 引导会话的世代映射：`sha256(sid)` → 引导码记录 key。
   *
   * 为什么要跟：设口令时会把 sid 轮换（防会话固定），而「重放引导码要撤销它当初签发的
   * 会话」必须撤销**活着的那个**（轮换后的后代），否则撤销的是已经不存在的旧 id。
   */
  private readonly setupBindings = new Map<string, string>();
  private readonly env: Record<string, string | undefined>;
  private readonly endpoints: OAuthEndpoints | undefined;
  private readonly runtimeInfo:
    | ((req: Request) => WhoamiRuntimeInfo | Promise<WhoamiRuntimeInfo>)
    | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly platformToken: string | undefined;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(options: AuthServiceOptions) {
    const idleMinutes = Number.isFinite(options.session.idleMinutes)
      ? Math.max(1, options.session.idleMinutes)
      : 30;
    const absoluteHours = Number.isFinite(options.session.absoluteHours)
      ? Math.max(1, options.session.absoluteHours)
      : 12;
    // 0.60：`publicOrigin` 等价于「只有一个元素的 publicOrigins」——两条配置合并去重，
    // 顺序是 publicOrigin 在前、列表按配置顺序跟上（单来源部署因此逐字不变）。
    const publicOrigins = mergePublicOrigins(options.publicOrigins, options.publicOrigin);
    this.publicOrigins = publicOrigins;
    this.settings = {
      publicOrigins: [...publicOrigins],
      publicOrigin: publicOrigins[0] ?? null,
      allowedHosts: [...options.allowedHosts],
      backends: [...options.backends],
      session: {
        idleMinutes,
        absoluteHours,
        storageFile: options.session.storageFile,
      },
      credentialsFile: options.credentialsFile,
      lockoutFile: options.lockoutFile,
      bootstrapTtlMs: options.bootstrapTtlMs,
    };
    this.env = options.env ?? (process.env as Record<string, string | undefined>);
    this.endpoints = options.endpoints;
    this.runtimeInfo = options.runtimeInfo;
    this.fetchImpl = options.fetchImpl;
    this.platformToken =
      typeof options.platformToken === 'string' && options.platformToken !== ''
        ? options.platformToken
        : undefined;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.sessions = new SessionStore({
      idleMs: idleMinutes * 60_000,
      absoluteMs: absoluteHours * 3_600_000,
      storageFile: options.session.storageFile,
      now: options.now,
    });
    this.flows = new OAuthFlowStore({ now: options.now });
    this.credentials = new CredentialStore({
      file: options.credentialsFile,
      now: options.now,
      username: this.passwordBackend()?.username,
    });
    this.limiter = new LoginLimiter({ file: options.lockoutFile, now: options.now });
    this.bootstraps = new BootstrapCodes({
      ...(options.bootstrapTtlMs !== undefined ? { ttlMs: options.bootstrapTtlMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.pendingLogins = new PendingLogins(options.now !== undefined ? { now: options.now } : {});
    this.warnAboutPasswordBackend();
  }

  /**
   * 启动自检（口令后端）：把「现在到底靠什么登录」写进日志，并且在**没有任何凭据**时
   * 打印一枚一次性引导码。绝不生成默认口令 —— 默认口令是「装完就被接管」的同义词。
   */
  private warnAboutPasswordBackend(): void {
    const backend = this.passwordBackend();
    if (backend === null) return;
    const envHash = this.envPasswordHash(backend);
    if (envHash !== null) {
      this.log(
        `password: using the hash from env ${backend.passwordHashEnv ?? '?'} (env wins over the credentials file)`,
      );
      return;
    }
    if (this.credentials.hasPassword()) {
      this.log('password: using the hash from the credentials file');
      return;
    }
    const hint = this.bootstraps.issue();
    // 只打印一次：单次 + 短 TTL；用完后这个 URL 就没有任何作用了。
    this.log(
      'password: no credential configured yet — opening the WebUI with the one-time bootstrap code ' +
        'mints a setup session (set the password, enroll TOTP). ' +
        `Open http://127.0.0.1:<platform-port>/#token=${hint.code} within ` +
        `${String(Math.round((this.settings.bootstrapTtlMs ?? 600_000) / 60_000))} min. ` +
        'Alternatively set auth.backends[].passwordHashEnv to an argon2id hash and skip this step.',
    );
  }

  /** 口令后端（单用户）；没配返回 null。 */
  passwordBackend(): PasswordBackendConfig | null {
    for (const backend of this.settings.backends) {
      if (backend.kind === PASSWORD_STRATEGY_KIND) return backend as PasswordBackendConfig;
    }
    return null;
  }

  /** env 里的口令 hash（显式配置，优先级最高）；没有返回 null。 */
  private envPasswordHash(
    backend: Extract<AuthBackendConfig, { kind: 'password' }>,
  ): string | null {
    const name = backend.passwordHashEnv;
    if (name === undefined) return null;
    const value = this.env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      this.log(`password: env ${name} is empty — falling back to the credentials file`);
      return null;
    }
    return value.trim();
  }

  /** 实际生效的口令 hash 来源；没有凭据返回 null。 */
  private effectivePassword(): {
    stored: { algorithm?: string; value: string };
    source: 'env' | 'file';
  } | null {
    const backend = this.passwordBackend();
    if (backend === null) return null;
    const envHash = this.envPasswordHash(backend);
    if (envHash !== null) return { stored: { value: envHash }, source: 'env' };
    const snapshot = this.credentials.snapshot();
    if (snapshot.password !== undefined) return { stored: snapshot.password, source: 'file' };
    return null;
  }

  /** 口令后端是否已具备登录条件（有 hash）。 */
  get passwordReady(): boolean {
    return this.effectivePassword() !== null;
  }

  /** 是否要求 TOTP：env 给了密钥，或者已经绑过密钥。 */
  get totpRequired(): boolean {
    return this.totpSecret() !== null;
  }

  /** 生效的 TOTP 密钥（env 优先）；没有返回 null。 */
  private totpSecret(): string | null {
    const backend = this.passwordBackend();
    if (backend === null) return null;
    const envName = backend.totpSecretEnv;
    if (envName !== undefined) {
      const value = this.env[envName];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return this.credentials.snapshot().totp?.secret ?? null;
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
    const password = this.passwordBackend();
    return jsonResponse({
      authEnabled: this.enabled,
      authenticated: session !== null,
      user: user === null ? null : { id: user.id, backend: user.backend, username: user.username },
      csrfToken: session === null ? null : session.snapshot.csrfToken,
      loginBackends: this.enabled ? this.describeBackends() : [],
      // Ops hint for the login page: the exact redirect_uri to register on GitHub.
      // 0.60：多来源时给出**本次请求**会用的那个（选不出来 = null，登录页就不显示这一行），
      // 单来源时与今天逐字相同；来源清单本身不在这里回显（端点匿名可达）。
      publicOrigin: selectPublicOrigin(ctx.edge, this.publicOrigins),
      // 口令后端的登录页提示（**不含**任何凭据值）：
      // 还没设口令 ⇒ 登录页告诉用户「用启动日志里的引导码」；`totpRequired` 决定
      // 表单是否要第二个输入框。
      ...(password !== null
        ? {
            username: password.username ?? this.credentials.username,
            passwordSet: this.passwordReady,
            passwordSource: this.effectivePassword()?.source ?? null,
            totpRequired: this.totpRequired,
            recoveryCodesLeft: this.credentials.recoveryCodesLeft(),
          }
        : {}),
    });
  }

  /**
   * GET /auth/whoami：前端渲染外壳需要的**一屏事实**（与 `platform.whoami` 区分：
   * 后者讲平台 token 与代理能力，这个讲「我是谁、能用哪个后端登录」）。
   *
   * 三条约束：
   * - **未登录也允许调用**：`identity: null`，`backends` 照旧 —— 登录页正是靠它
   *   渲染按钮的，要求先登录才能问「怎么登录」就是死锁；
   * - 只报本人：`identity` 只有自己的 id / 展示名 / 角色，**不**回显 `allow_user_ids`
   *   名单，也永不回显 client secret；
   * - `node` / `team` 由组合根注入（登录层不认识它们）；注入方没给就是 null，
   *   前端据此降级 —— 不猜、不编。
   */
  private async whoamiResponse(req: Request, ctx: AuthRequestContext): Promise<Response> {
    const session = this.readSession(req, ctx);
    const subject = session === null ? null : session.snapshot.subject;
    const runtime = (await this.runtimeInfo?.(req)) ?? { node: null, team: null };
    const body: AuthWhoami = {
      identity:
        subject === null
          ? null
          : {
              // 展示名缺省用 id（口令后端只有登录名）。
              name: subject.username ?? subject.id,
              id: subject.id,
              // 单用户部署：能拿到会话的人就是本部署的主人，与平台 token 同侧。
              role: 'admin',
            },
      node: runtime.node ?? null,
      team: runtime.team ?? null,
      backends: this.enabled ? this.whoamiBackends() : [],
      auth_mode: this.authModeOf(req, session),
    };
    return jsonResponse(body);
  }

  /**
   * 本次请求是**怎么被认出来的**：
   * - 会话 cookie（`cookie`）；
   * - 平台 token（`bearer`）；
   * - 都没有（`none`）：回环匿名也是这一种（旧行为，不锁死本机）。
   */
  private authModeOf(
    req: Request,
    session: { snapshot: SessionSnapshot } | null,
  ): 'cookie' | 'bearer' | 'none' {
    if (session !== null) return 'cookie';
    const provided = bearer(req);
    if (
      this.platformToken !== undefined &&
      provided !== null &&
      constantTimeEqual(provided, this.platformToken)
    ) {
      return 'bearer';
    }
    return 'none';
  }

  /**
   * 后端的公开描述（不含密钥、不含白名单）。
   *
   * 顺序 = 配置顺序；provider 差异（id / 文案 / 起步路径）全部来自策略注册表，
   * 这里没有任何 provider 名字面量。
   */
  private describeBackends(): {
    id: string;
    kind: string;
    label: string;
    startPath: string;
  }[] {
    const list: { id: string; kind: string; label: string; startPath: string }[] = [];
    for (const backend of this.settings.backends) {
      if (backend.kind === PASSWORD_STRATEGY_KIND) {
        const password = this.passwordBackend();
        if (password === null) continue;
        list.push({
          id: 'password',
          kind: 'password',
          label: password.label ?? 'Sign in with a password',
          // 口令表单就在登录页本身：没有独立的 302 起步地址。
          startPath: LOGIN_PATH,
        });
        continue;
      }
      const strategy = getAuthStrategy(backend.kind);
      if (strategy === null) continue;
      list.push({
        id: strategy.id,
        kind: strategy.kind,
        label: backend.label ?? strategy.label,
        startPath: oauthStartPath(strategy),
      });
    }
    return list;
  }

  /**
   * `/auth/whoami` 的 `backends`：**当前配置里启用、且现在真能发起**的策略。
   *
   * 缺 client secret 的后端照样列出来，但带 `disabled: true` + `reason` ——
   * 「登录按钮点了没反应」必须能自己解释，而不是要人去翻服务端日志。
   */
  private whoamiBackends(): WhoamiBackend[] {
    const list: WhoamiBackend[] = [];
    for (const strategy of authStrategies()) {
      if (strategy.kind === PASSWORD_STRATEGY_KIND) {
        const password = this.passwordBackend();
        if (password === null) continue;
        list.push({
          id: 'password',
          kind: 'password',
          label: password.label ?? strategy.label,
        });
        continue;
      }
      const backend = this.oauthBackend(strategy.kind);
      if (backend === null) continue;
      const entry: WhoamiBackend = {
        id: strategy.id,
        kind: strategy.kind,
        label: backend.label ?? strategy.label,
      };
      const reason = this.oauthBackendBlocker(backend);
      if (reason !== null) {
        entry.disabled = true;
        entry.reason = reason;
      }
      list.push(entry);
    }
    return list;
  }

  /** 后端现在发起不了的原因；能发起返回 null。 */
  private oauthBackendBlocker(backend: OAuthBackendConfig): string | null {
    if (backend.clientId.trim() === '') return 'client_id_missing';
    if (resolveClientSecret(backend, this.env) === null) {
      return `secret_missing: env ${backend.clientSecretEnv} is not set`;
    }
    return null;
  }

  /** 按 kind 取已配置的 OAuth 后端；没配返回 null。 */
  private oauthBackend(kind: string): OAuthBackendConfig | null {
    for (const backend of this.settings.backends) {
      if (backend.kind === PASSWORD_STRATEGY_KIND) continue;
      // `kind` 是开放取值（策略注册表决定），TypeScript 无法据此收窄，所以显式断言：
      // 走到这里已经排除了口令后端，剩下的形状就是 OAuth 后端。
      if (backend.kind === kind) return backend as OAuthBackendConfig;
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

  /** GET /auth/<provider>/start：一次性 state + PKCE，然后 302 去 provider。 */
  private oauthStart(strategy: AuthStrategy, ctx: AuthRequestContext): Response {
    const backend = this.oauthBackend(strategy.kind);
    if (backend === null) return jsonResponse({ error: 'backend_not_configured' }, 404);
    // 0.60：来源由**受信边缘**在白名单里挑一个；选不出来就拒绝。
    // Never derive redirect_uri from Host / X-Forwarded-*: that is attacker input.
    const origin = selectPublicOrigin(ctx.edge, this.publicOrigins);
    if (origin === null) {
      this.log(
        `${strategy.kind}: no whitelisted public origin matches this request, refusing to build a redirect_uri`,
      );
      return jsonResponse({ error: 'public_origin_missing' }, 500);
    }
    if (resolveClientSecret(backend, this.env) === null) {
      this.log(`${strategy.kind}: env ${backend.clientSecretEnv} is not set`);
      return redirectResponse(`${LOGIN_PATH}?error=secret_missing`);
    }
    const secure = this.isSecureContext(ctx);
    const binder = randomToken(32);
    const redirectUri = buildRedirectUri(origin, oauthCallbackPath(strategy));
    // 选中的来源与它拼出的 redirect_uri 一起进在途流程：回调时两样都要对得上。
    const flow = this.flows.issue({ origin, binder: sha256Hex(binder), redirectUri });
    const target = buildAuthorizeUrl({
      strategy,
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

  /** GET /auth/<provider>/callback：校验 state + code、比对白名单、建会话。 */
  private async oauthCallback(
    strategy: AuthStrategy,
    req: Request,
    url: URL,
    ctx: AuthRequestContext,
  ): Promise<Response> {
    const secure = this.isSecureContext(ctx);
    const clearedBinder = this.clearedBinderCookie(secure);
    const backend = this.oauthBackend(strategy.kind);
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
      this.log(`${strategy.kind}: state rejected (unknown, expired, replayed or binder mismatch)`);
      return redirectResponse(`${LOGIN_PATH}?error=state_invalid`, [clearedBinder]);
    }
    // 0.60：state 绑定的是**发起时**选中的来源；回调必须落在同一个来源上 ——
    // 同一套受信边缘判定再选一次，且两边都必须在白名单里。不一致 ⇒ 直接拒绝，
    // 文案不解释原因（不让攻击者据此调参）。
    const callbackOrigin = selectPublicOrigin(ctx.edge, this.publicOrigins);
    if (
      callbackOrigin === null ||
      callbackOrigin !== flow.origin ||
      !this.publicOrigins.includes(flow.origin)
    ) {
      this.log(
        `${strategy.kind}: state origin mismatch (start and callback resolved to different origins), rejected`,
      );
      return redirectResponse(`${LOGIN_PATH}?error=state_invalid`, [clearedBinder]);
    }
    // Provider 侧拒绝（用户取消 / 管理员未批准 / 应用配错）不带 code，只带 `error`
    // （+ `error_description`）。不记下来的话，排障时只剩一个 code_missing，
    // 分不清「用户点了取消」和「应用没配好」。
    const providerError = url.searchParams.get('error');
    if (providerError !== null && providerError !== '') {
      const description = (url.searchParams.get('error_description') ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 200);
      this.log(
        `${strategy.kind}: provider returned error=${providerError}` +
          (description === '' ? '' : ` (${description})`),
      );
    }
    const result = await completeOAuthLogin({
      strategy,
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
      id: `${strategy.id}:${result.userId}`,
      backend: strategy.id,
      username: result.username,
    };
    const existing = this.readSession(req, ctx);
    const issued = this.issueSession(subject, req, ctx, existing === null ? null : existing.sid);
    const policy = this.cookiePolicy(secure);
    this.log(`${strategy.kind}: login ok for ${subject.id}`);
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

  // ── 0.56 P2：口令登录 / TOTP / 一次性引导码 ─────────────────────────────

  /**
   * 登录类 POST 的共同前置：JSON-only + Origin 校验。
   *
   * 要求 `content-type: application/json` 有两个作用：跨站表单 post 发不出这个类型
   * （会触发预检），而预检要过 CORS，所以我们顺手把「浏览器里第三方页面偷偷提交登录
   * 表单」这条路堵死；Origin 命中受信边缘的 Host 则挡掉同源之外的 JSON 提交。
   */
  private async readLoginBody(
    req: Request,
    ctx: AuthRequestContext,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
    const origin = req.headers.get('origin');
    if (origin !== null && !this.originMatchesEdge(origin, ctx)) {
      return { ok: false, response: jsonResponse({ error: 'forbidden_origin' }, 403) };
    }
    const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      return { ok: false, response: jsonResponse({ error: 'json_required' }, 415) };
    }
    const text = await req.text().catch(() => '');
    if (text.length > MAX_LOGIN_BODY_BYTES) {
      return { ok: false, response: jsonResponse({ error: 'body_too_large' }, 413) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text === '' ? '{}' : text);
    } catch {
      return { ok: false, response: jsonResponse({ error: 'invalid_json' }, 400) };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, response: jsonResponse({ error: 'invalid_json' }, 400) };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  }

  /** 双维度限流的两个 key。 */
  private limitDimensions(ctx: AuthRequestContext, username: string): string[] {
    return [ipKey(ctx.address), accountKey(username)];
  }

  /** 限流拒绝的响应：429 + Retry-After（**不含**任何凭据信息）。 */
  private rateLimitedResponse(
    gate: { retryAfterMs: number; scope: 'ip' | 'account' | 'both'; locked: boolean },
    ctx: AuthRequestContext,
  ): Response {
    const seconds = retryAfterSeconds(gate.retryAfterMs);
    const base = {
      error: 'rate_limited',
      scope: gate.scope,
      locked: gate.locked,
      retryAfterSeconds: seconds,
      message:
        (gate.locked
          ? 'Too many failed login attempts: this ' +
            (gate.scope === 'both'
              ? 'client and account are'
              : gate.scope === 'ip'
                ? 'client is'
                : 'account is') +
            ' locked until the timer runs out.'
          : 'Slow down: wait for the timer before the next attempt.') +
        ' On the machine that runs the gateway you can unlock immediately with: ' +
        unlockCommand(ctx),
    };
    return jsonResponse(base, 429, { 'retry-after': String(seconds) });
  }

  /**
   * POST /auth/login：口令第一步。
   *
   * 两种成功形态：`totpRequired: false`（已建会话，cookie 已下发）或
   * `totpRequired: true`（拿到 5 分钟票根，去 `/auth/login/totp` 交验证码）。
   * 任何失败都**不区分**「用户名不存在」与「口令错」—— 单用户部署里没有这个信息可言。
   */
  private async passwordLogin(req: Request, ctx: AuthRequestContext): Promise<Response> {
    const backend = this.passwordBackend();
    if (backend === null) return jsonResponse({ error: 'backend_not_configured' }, 404);
    const parsed = await this.readLoginBody(req, ctx);
    if (!parsed.ok) return parsed.response;
    const username =
      typeof parsed.body.username === 'string' && parsed.body.username.trim() !== ''
        ? parsed.body.username.trim()
        : (backend.username ?? this.credentials.username);
    const password = typeof parsed.body.password === 'string' ? parsed.body.password : '';
    const dimensions = this.limitDimensions(ctx, username);
    const gate = this.limiter.gate(dimensions);
    if (!gate.ok) return this.rateLimitedResponse(gate, ctx);

    const expected = this.effectivePassword();
    if (expected === null) {
      // 还没有口令：登录页应当引导「用启动日志里的一次性引导码」。
      return jsonResponse(
        {
          error: 'password_not_set',
          message:
            'No password is configured yet. Use the one-time bootstrap code printed at startup ' +
            '(open the page with #token=<code>): it mints a setup session where you can set the password.',
        },
        409,
      );
    }
    const outcome = await verifyPassword(password, expected.stored);
    if (outcome === 'unsupported') {
      this.log('password: argon2id verification is unavailable in this runtime (no Bun.password)');
      return jsonResponse({ error: 'password_unsupported' }, 500);
    }
    if (outcome !== 'ok') {
      // 恒定开销：口令错与「没设口令」在时间上也别分开。
      if (username !== (backend.username ?? this.credentials.username)) {
        await dummyPasswordCheck(password);
      }
      const failure = this.limiter.fail(dimensions);
      this.log(
        `password: login failed for ${username} from ${ctx.address ?? 'unknown'}` +
          (failure.locked ? ' (locked)' : ''),
      );
      if (failure.locked) {
        return this.rateLimitedResponse(
          { retryAfterMs: failure.retryAfterMs, scope: 'both', locked: true },
          ctx,
        );
      }
      return jsonResponse({ error: 'invalid_credentials' }, 401);
    }

    if (this.totpRequired) {
      const pending = this.pendingLogins.issue({
        username,
        ip: ctx.address,
        userAgent: req.headers.get('user-agent'),
      });
      return jsonResponse({
        ok: true,
        totpRequired: true,
        ticket: pending.ticket,
        expiresAt: pending.expiresAt,
        recoveryAllowed: this.credentials.recoveryCodesLeft() > 0,
      });
    }

    this.limiter.reset(dimensions);
    return this.completePasswordLogin(req, ctx, username, 'password login ok');
  }

  /** 口令通过（无 TOTP）后的收尾：轮换或新建会话 + 下发 cookie。 */
  private completePasswordLogin(
    req: Request,
    ctx: AuthRequestContext,
    username: string,
    logLine: string,
  ): Response {
    const subject: AuthSubject = { id: `password:${username}`, backend: 'password', username };
    const existing = this.readSession(req, ctx);
    const issued = this.issueSession(subject, req, ctx, existing === null ? null : existing.sid);
    this.log(`password: ${logLine} for ${subject.id}`);
    return jsonResponse({ ok: true, totpRequired: false }, 200, {
      'set-cookie': buildSessionCookie(this.cookiePolicy(this.isSecureContext(ctx)), issued.sid),
    });
  }

  /**
   * POST /auth/login/totp：口令第二步（验证码或恢复码）。
   *
   * 恢复码与 TOTP 共用一个入口：6 位纯数字走 TOTP（带重放闸），其它形状走恢复码
   * （一次性，只存 hash）。两者都记同一个限流维度。
   */
  private async totpLogin(req: Request, ctx: AuthRequestContext): Promise<Response> {
    if (this.passwordBackend() === null) {
      return jsonResponse({ error: 'backend_not_configured' }, 404);
    }
    const parsed = await this.readLoginBody(req, ctx);
    if (!parsed.ok) return parsed.response;
    const ticket = typeof parsed.body.ticket === 'string' ? parsed.body.ticket : '';
    const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
    const pending = this.pendingLogins.peek(ticket);
    if (pending === null) {
      return jsonResponse(
        { error: 'ticket_invalid', message: 'The login ticket expired: enter the password again.' },
        401,
      );
    }
    const dimensions = this.limitDimensions(ctx, pending.entry.username);
    const gate = this.limiter.gate(dimensions);
    if (!gate.ok) return this.rateLimitedResponse(gate, ctx);

    const secret = this.totpSecret();
    const lastStep = this.credentials.snapshot().totp?.lastStep ?? 0;
    const looksLikeRecovery = normalizeRecoveryCode(code).length >= 10;
    if (!looksLikeRecovery && secret !== null) {
      const result = verifyTotp({ secret, code, nowMs: this.now(), lastStep });
      if (result.ok) {
        await this.credentials.noteTotpStep(result.step);
        this.pendingLogins.consume(pending.key);
        this.limiter.reset(dimensions);
        return this.completePasswordLogin(req, ctx, pending.entry.username, 'totp login ok');
      }
      if (result.reason === 'replayed') {
        // 同一个码第二次：算一次失败（可能是有人截了旧码），并明确告警。
        const failure = this.limiter.fail(dimensions);
        this.log(
          `password: TOTP replay rejected for ${pending.entry.username} ` +
            `(step already used); code not accepted twice`,
        );
        if (failure.locked) {
          return this.rateLimitedResponse(
            { retryAfterMs: failure.retryAfterMs, scope: 'both', locked: true },
            ctx,
          );
        }
        return jsonResponse({ error: 'code_replayed' }, 401);
      }
    }
    if (looksLikeRecovery || secret === null) {
      if (await this.credentials.consumeRecoveryCode(code)) {
        this.pendingLogins.consume(pending.key);
        this.limiter.reset(dimensions);
        this.log(`password: recovery code accepted for ${pending.entry.username} (burned)`);
        return this.completePasswordLogin(req, ctx, pending.entry.username, 'recovery login ok');
      }
    }
    this.pendingLogins.failAttempt(pending.key);
    const failure = this.limiter.fail(dimensions);
    this.log(`password: second factor rejected for ${pending.entry.username}`);
    if (failure.locked) {
      return this.rateLimitedResponse(
        { retryAfterMs: failure.retryAfterMs, scope: 'both', locked: true },
        ctx,
      );
    }
    return jsonResponse({ error: 'invalid_code' }, 401);
  }

  /**
   * POST /auth/bootstrap：一次性引导码 → 引导会话（`#token=` 之后的唯一入口）。
   *
   * - 单次：认领即作废；
   * - 短 TTL：过期即废；
   * - **重放**：同一个码第二次提交 ⇒ 撤销它当初签发的会话 + 告警日志；
   * - 拿到的会话只能设口令 / 绑 TOTP（`capabilities` 里写明，前端照此渲染）。
   */
  private async bootstrapLogin(req: Request, ctx: AuthRequestContext): Promise<Response> {
    if (this.passwordBackend() === null) {
      return jsonResponse(
        {
          error: 'bootstrap_disabled',
          message:
            'No password backend is configured, so bootstrap codes are not accepted. ' +
            'Use the platform token (connection settings) or a bearer token instead.',
        },
        409,
      );
    }
    const parsed = await this.readLoginBody(req, ctx);
    if (!parsed.ok) return parsed.response;
    const code = typeof parsed.body.code === 'string' ? parsed.body.code.trim() : '';
    const dimensions = this.limitDimensions(ctx, 'bootstrap');
    const gate = this.limiter.gate(dimensions);
    if (!gate.ok) return this.rateLimitedResponse(gate, ctx);

    const claim = this.bootstraps.claim(code);
    if (!claim.ok) {
      if (claim.status === 'replayed') {
        // 告警 + 撤销：用过的码不该再出现，出现就是有人拿到了它。
        const revoked =
          claim.sessionSidHash === null ? 0 : this.revokeSessionByHash(claim.sessionSidHash);
        this.log(
          `bootstrap: REPLAYED bootstrap code rejected from ${ctx.address ?? 'unknown'}; ` +
            `revoked ${String(revoked)} session(s) minted by it`,
        );
        this.limiter.fail(dimensions);
        return jsonResponse(
          {
            error: 'bootstrap_replayed',
            message:
              'This bootstrap code was already used: the session it created has been revoked. ' +
              'Sign in with the password, or restart the gateway to get a fresh code.',
          },
          409,
        );
      }
      this.limiter.fail(dimensions);
      this.log(`bootstrap: rejected an unknown or expired code from ${ctx.address ?? 'unknown'}`);
      return jsonResponse(
        {
          error: claim.status === 'expired' ? 'bootstrap_expired' : 'bootstrap_invalid',
          message:
            'The bootstrap code is unknown or expired. Restart the gateway to print a fresh one.',
        },
        401,
      );
    }

    const existing = this.readSession(req, ctx);
    const issued = this.issueSession(
      { id: 'bootstrap:local', backend: 'bootstrap', username: this.credentials.username },
      req,
      ctx,
      existing === null ? null : existing.sid,
    );
    if (existing !== null) this.sessions.revoke(existing.sid);
    this.bootstraps.bindSession(claim.key, sha256Hex(issued.sid));
    this.setupBindings.set(sha256Hex(issued.sid), claim.key);
    this.limiter.reset(dimensions);
    this.log('bootstrap: one-time code consumed — setup session issued');
    return jsonResponse(
      {
        ok: true,
        bootstrap: true,
        capabilities: ['set_password', 'enroll_totp'],
        passwordSet: this.passwordReady,
      },
      200,
      {
        'set-cookie': buildSessionCookie(this.cookiePolicy(this.isSecureContext(ctx)), issued.sid),
      },
    );
  }

  /** 按 `sha256(sid)` 撤销（引导码重放用：我们只留哈希，拿不到 sid 明文）。 */
  private revokeSessionByHash(sidHash: string): number {
    const removed = this.sessions.revokeByHash(sidHash) ? 1 : 0;
    this.setupBindings.delete(sidHash);
    return removed;
  }

  /**
   * 引导会话的能力闸：只允许 `set_password` / `enroll_totp`。
   * 唯一判据是会话 subject —— 口令会话、GitHub 会话都不需要这些动作。
   * 变更类请求照旧要过 CSRF（同步令牌），与其它用 cookie 鉴权的 POST 同口径。
   */
  private setupSession(
    req: Request,
    ctx: AuthRequestContext,
  ): { sid: string; snapshot: SessionSnapshot } | null {
    const session = this.readSession(req, ctx);
    if (session === null) return null;
    if (session.snapshot.subject.backend !== 'bootstrap') return null;
    const origin = req.headers.get('origin');
    if (origin !== null && !this.originMatchesEdge(origin, ctx)) return null;
    const token = req.headers.get(CSRF_HEADER);
    if (token === null || token === '') return null;
    if (!this.sessions.csrfValid(session.snapshot, token)) return null;
    return session;
  }

  /** POST /auth/password/set：用引导会话设首次口令（argon2id）。 */
  private async setPassword(req: Request, ctx: AuthRequestContext): Promise<Response> {
    const session = this.setupSession(req, ctx);
    if (session === null) {
      return jsonResponse(
        {
          error: 'setup_session_required',
          message:
            'Setting the password requires a setup session: open the page with the one-time ' +
            'bootstrap code printed at startup (#token=<code>).',
        },
        403,
      );
    }
    const backend = this.passwordBackend();
    if (backend !== null && this.effectivePassword()?.source === 'env') {
      return jsonResponse(
        {
          error: 'password_from_env',
          message: `The password hash comes from env ${backend.passwordHashEnv ?? '?'}: change it there instead.`,
        },
        409,
      );
    }
    const parsed = await this.readLoginBody(req, ctx);
    if (!parsed.ok) return parsed.response;
    const password = typeof parsed.body.password === 'string' ? parsed.body.password : '';
    const policyError = passwordPolicyError(password);
    if (policyError !== null) {
      return jsonResponse(
        {
          error: policyError,
          message: 'Choose a password with at least 10 characters (length is the only rule).',
        },
        400,
      );
    }
    await this.credentials.setPassword(password);
    // 防会话固定：设完口令立刻换一个新 sid（旧 cookie 立即失效）；世代映射跟着走，
    // 这样「重放引导码」撤销的仍是活着的那个会话。
    const rotated = this.sessions.rotate(session.sid);
    if (rotated !== null) {
      const key = this.setupBindings.get(sha256Hex(session.sid));
      this.setupBindings.delete(sha256Hex(session.sid));
      const newHash = sha256Hex(rotated.sid);
      this.setupBindings.set(newHash, key ?? '');
      if (key !== undefined && key !== '') this.bootstraps.bindSession(key, newHash);
    }
    this.log('password: initial password set from the setup session (argon2id)');
    const headers: Record<string, string> = {};
    if (rotated !== null) {
      headers['set-cookie'] = buildSessionCookie(
        this.cookiePolicy(this.isSecureContext(ctx)),
        rotated.sid,
      );
    }
    return jsonResponse({ ok: true, totpRequired: this.totpRequired }, 200, headers);
  }

  /**
   * POST /auth/totp/enroll：引导会话里绑定 TOTP。
   *
   * 返回 `otpauth://` 配对 URI + 一批恢复码（**明文只在这一刻出现**；落盘只有 hash）。
   * 这些值不进日志、不进事件。
   */
  private async enrollTotp(req: Request, ctx: AuthRequestContext): Promise<Response> {
    const session = this.setupSession(req, ctx);
    if (session === null) {
      return jsonResponse(
        {
          error: 'setup_session_required',
          message: 'TOTP enrollment requires the setup session opened with the bootstrap code.',
        },
        403,
      );
    }
    if (this.credentials.snapshot().totp !== undefined && this.passwordReady) {
      return jsonResponse({ error: 'totp_already_enrolled' }, 409);
    }
    const secret = generateTotpSecret();
    await this.credentials.setTotpSecret(secret);
    const recoveryCodes = await this.credentials.replaceRecoveryCodes();
    this.log('password: TOTP enrolled (secret and recovery codes were not logged)');
    return jsonResponse({
      ok: true,
      secret,
      otpauthUri: buildOtpauthUri({ secret, account: this.credentials.username }),
      recoveryCodes,
      driftSteps: 1,
      stepSeconds: 30,
      message:
        'Scan the URI, then store the recovery codes now: each one works once and they are not shown again.',
    });
  }

  /**
   * POST /auth/setup/finish：把设置会话换成正常的口令会话。
   *
   * 为什么需要：设置会话只放行「设口令 / 绑 TOTP」，如果它一直保持 `bootstrap` 身份，
   * 用户设完后会被永久留在设置页（应用永远进不去）。这里把它轮换成一个普通的
   * `password:<用户名>` 会话：旧 sid 立即失效，重放撤销仍然跟着这个后代会话走。
   */
  private async finishSetup(req: Request, ctx: AuthRequestContext): Promise<Response> {
    const session = this.setupSession(req, ctx);
    if (session === null) {
      return jsonResponse({ error: 'setup_session_required' }, 403);
    }
    if (!this.passwordReady) {
      return jsonResponse(
        { error: 'password_not_set', message: 'Set the password before finishing setup.' },
        409,
      );
    }
    const username = this.passwordBackend()?.username ?? this.credentials.username;
    const subject: AuthSubject = { id: `password:${username}`, backend: 'password', username };
    this.sessions.revoke(session.sid);
    const issued = this.sessions.create(subject, {
      ip: ctx.address,
      userAgent: req.headers.get('user-agent'),
    });
    const key = this.setupBindings.get(sha256Hex(session.sid));
    this.setupBindings.delete(sha256Hex(session.sid));
    const newHash = sha256Hex(issued.sid);
    this.setupBindings.set(newHash, key ?? '');
    if (key !== undefined && key !== '') this.bootstraps.bindSession(key, newHash);
    this.log('bootstrap: setup session completed and rotated into a password session');
    return jsonResponse({ ok: true, totpRequired: this.totpRequired }, 200, {
      'set-cookie': buildSessionCookie(this.cookiePolicy(this.isSecureContext(ctx)), issued.sid),
    });
  }

  /**
   * POST /auth/recovery/rotate：重新签发一批恢复码。
   *
   * 需要**已认证会话 + CSRF**（走既有 `authorize(mutating)`），所以它不会变成
   * 「谁都能把别人的恢复码换掉」。当 TOTP 密钥来自 env（没有引导会话可用的场景）时，
   * 这是拿到恢复码的唯一通道。
   */
  private async rotateRecoveryCodes(req: Request, ctx: AuthRequestContext): Promise<Response> {
    if (this.totpSecret() === null) {
      return jsonResponse({ error: 'totp_not_enrolled' }, 409);
    }
    const gate = this.authorize(req, ctx, { mutating: true });
    if (!gate.ok) {
      const status = gate.reason === 'no_session' ? 401 : 403;
      return jsonResponse({ error: gate.reason }, status);
    }
    const recoveryCodes = await this.credentials.replaceRecoveryCodes();
    this.log(`password: recovery codes rotated for ${gate.snapshot.subject.id} (not logged)`);
    return jsonResponse({ ok: true, recoveryCodes });
  }

  /**
   * POST /auth/unlock：把锁定状态的登录限速清空。
   *
   * 两个条件同时成立才允许：**回环直连**（不是经反代的回环 peer）+ `Authorization:
   * Bearer <平台 token>`。这样「把自己锁在外面」永远是本机一条命令能解决的事，
   * 而公网拿不到这条捷径。
   */
  private unlock(req: Request, ctx: AuthRequestContext): Response {
    if (!isLocalDirectish(ctx)) {
      return jsonResponse(
        {
          error: 'forbidden',
          message: 'Unlocking is only allowed from the loopback interface of the gateway host.',
        },
        403,
      );
    }
    const expected = this.platformToken;
    if (expected !== undefined) {
      const provided = bearer(req);
      if (provided === null || !constantTimeEqual(provided, expected)) {
        return jsonResponse(
          {
            error: 'platform_unauthorized',
            message:
              'Unlock needs Authorization: Bearer <platform token>. ' +
              'Run: ' +
              unlockCommand(ctx),
          },
          401,
        );
      }
    }
    const cleared = this.limiter.resetAll();
    this.log(`password: lockout cleared from loopback (${String(cleared)} entries)`);
    return jsonResponse({ ok: true, cleared });
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
    if (path === '/auth/login') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await this.passwordLogin(req, ctx);
    }
    if (path === '/auth/login/totp') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await this.totpLogin(req, ctx);
    }
    if (path === '/auth/bootstrap') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await this.bootstrapLogin(req, ctx);
    }
    if (path === '/auth/password/set') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await this.setPassword(req, ctx);
    }
    if (path === '/auth/setup/finish') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await this.finishSetup(req, ctx);
    }
    if (path === '/auth/totp/enroll') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await this.enrollTotp(req, ctx);
    }
    if (path === '/auth/recovery/rotate') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await this.rotateRecoveryCodes(req, ctx);
    }
    if (path === '/auth/unlock') {
      if (method !== 'POST') return methodNotAllowed('POST');
      return this.unlock(req, ctx);
    }
    if (path === '/auth/whoami') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed('GET');
      return await this.whoamiResponse(req, ctx);
    }
    const oauthRoute = matchOAuthRoute(path);
    if (oauthRoute !== null) {
      if (method !== 'GET') return methodNotAllowed('GET');
      return oauthRoute.phase === 'start'
        ? this.oauthStart(oauthRoute.strategy, ctx)
        : await this.oauthCallback(oauthRoute.strategy, req, url, ctx);
    }
    if (path === '/auth' || path === '/auth/') {
      return jsonResponse({
        authEnabled: this.enabled,
        endpoints: [
          '/auth/status',
          '/auth/csrf',
          '/auth/logout',
          '/auth/login',
          '/auth/login/totp',
          '/auth/bootstrap',
          '/auth/password/set',
          '/auth/setup/finish',
          '/auth/totp/enroll',
          '/auth/recovery/rotate',
          '/auth/unlock',
          '/auth/whoami',
          ...redirectAuthStrategies().flatMap((strategy) => [
            oauthStartPath(strategy),
            oauthCallbackPath(strategy),
          ]),
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
    this.bootstraps.cleanup();
    this.pendingLogins.cleanup();
    // 会话没了，世代映射也没有意义：顺手回收（不清理只是内存泄漏，但没理由留着）。
    for (const sidHash of this.setupBindings.keys()) {
      if (!this.sessions.hasHash(sidHash)) this.setupBindings.delete(sidHash);
    }
  }

  /** 等待挂起的落盘写入（关闭进程）。 */
  async flush(): Promise<void> {
    await this.sessions.flush();
    await this.credentials.flush();
    await this.limiter.flush();
  }
}

function methodNotAllowed(allowed: string): Response {
  return jsonResponse({ error: 'method_not_allowed' }, 405, { allow: allowed });
}

/**
 * `/auth/<provider>/(start|callback)` 的路由匹配。
 *
 * provider 清单来自策略注册表（`redirectAuthStrategies()`），不是这里的一份硬编码表 ——
 * 新 provider 注册后路由自动存在。
 */
function matchOAuthRoute(
  path: string,
): { strategy: AuthStrategy; phase: 'start' | 'callback' } | null {
  for (const strategy of redirectAuthStrategies()) {
    if (path === oauthStartPath(strategy)) return { strategy, phase: 'start' };
    if (path === oauthCallbackPath(strategy)) return { strategy, phase: 'callback' };
  }
  return null;
}

/** `Authorization: Bearer <token>` 的值；缺失返回 null。 */
function bearer(req: Request): string | null {
  const authorization = req.headers.get('authorization');
  if (authorization === null || !authorization.toLowerCase().startsWith('bearer ')) return null;
  const value = authorization.slice('bearer '.length).trim();
  return value === '' ? null : value;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 解锁命令（写进 429 / 401 的文案里，照抄就能跑）。
 *
 * 用 `vessel token show --purpose platform --allow-non-interactive` 现场取平台 token：
 * 派生 token 也是这个命令（用户不需要先知道值），且命令本身只在本机可执行。
 */
export function unlockCommand(ctx?: { edge: Pick<RequestEdge, 'host'> }): string {
  const host = ctx?.edge.host ?? '127.0.0.1:8642';
  return (
    'curl -fsS -X POST http://' +
    host +
    '/auth/unlock -H "Authorization: Bearer $(vessel token show --purpose platform --allow-non-interactive)"'
  );
}

/** Host 是不是回环（`127.0.0.1:8642` / `localhost` / `[::1]:8642` 都算）。 */
function loopbackHost(host: string | null): boolean {
  if (host === null || host === '') return false;
  const bare = host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/**
 * 「本机直连」的判据（解锁用）。
 *
 * 不用 `edge.localDirect`：它要求「回环 socket ∧ 未经受信代理」，而**没配反代密钥时
 * 回环必然被算成受信代理**（`proxySecretAllowed` 未配置恒 true）—— 拿它当闸，
 * 默认部署（没配反代密钥）的解锁永远 403，正好是「把自己锁在外面」。
 *
 * 这里按真正的意图判：socket 对端是回环 **且** 生效 Host 指向回环。
 * 同机反代把 Host 改写公网域名时，这一条不成立（那种场景另有平台 token 兜底）。
 */
function isLocalDirectish(ctx: AuthRequestContext): boolean {
  return isLoopbackAddress(ctx.address) && loopbackHost(ctx.edge.host);
}
