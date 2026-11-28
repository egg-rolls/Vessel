/**
 * 0.56 WebUI 登录客户端：/auth/status 探测、CSRF 令牌、登出。
 *
 * 刻意不依赖 gateway 模块：平台 RPC 不可用、或还没登录时，登录页也必须能工作。
 *
 * @module web/auth/auth-client
 */

/** One configured login backend, as advertised by GET /auth/status. */
export interface AuthBackendInfo {
  id: string;
  kind: string;
  label: string;
  startPath: string;
}

/** Session identity; username is display only (the id is the identity). */
export interface AuthUser {
  id: string;
  backend: string;
  username: string | null;
}

/** GET /auth/status payload. */
export interface AuthStatus {
  authEnabled: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  csrfToken: string | null;
  loginBackends: AuthBackendInfo[];
  /** Cloud origin the OAuth App is registered with; shown as a login hint. */
  publicOrigin?: string | null;
  /** 0.56 P2：口令后端的登录名（只用于预填输入框）。 */
  username?: string;
  /** 口令后端：是否已经设过口令（false = 需要一次性引导码）。 */
  passwordSet?: boolean;
  /** 口令 hash 来源：`env` 表示不能在界面里改。 */
  passwordSource?: 'env' | 'file' | null;
  /** 口令登录后是否还要一个 TOTP / 恢复码。 */
  totpRequired?: boolean;
  /** 剩余可用恢复码数量。 */
  recoveryCodesLeft?: number;
}

/** 登录类接口的统一返回（`error` 是稳定错误码，不含凭据）。 */
export interface LoginResult {
  ok: boolean;
  /** 口令已通过，还需要第二因子：把 `ticket` 交给 loginWithTotp。 */
  totpRequired?: boolean;
  ticket?: string;
  expiresAt?: number;
  recoveryAllowed?: boolean;
  error?: string;
  message?: string;
  retryAfterSeconds?: number;
  locked?: boolean;
}

/** 引导码换到的会话能力（前端据此决定渲染设置表单还是登录表单）。 */
export interface BootstrapResult {
  ok: boolean;
  bootstrap?: boolean;
  capabilities?: string[];
  passwordSet?: boolean;
  error?: string;
  message?: string;
}

/** TOTP 绑定结果：`secret` 与 `recoveryCodes` **只在这一次**返回。 */
export interface EnrollResult {
  ok: boolean;
  secret?: string;
  otpauthUri?: string;
  recoveryCodes?: string[];
  error?: string;
  message?: string;
}

/** Header carrying the synchronizer CSRF token. */
export const CSRF_HEADER = 'x-vessel-csrf';

const CSRF_STORAGE_KEY = 'vessel.csrf-token';
const STATUS_TIMEOUT_MS = 8_000;

/** Fired when the platform rejects us for a missing/expired session. */
export const AUTH_REQUIRED_EVENT = 'vessel:auth-required';

let csrfToken: string | null = null;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** CSRF token for mutating requests; empty string when unknown. */
export function getCsrfToken(): string {
  if (csrfToken !== null) return csrfToken;
  try {
    csrfToken = storage()?.getItem(CSRF_STORAGE_KEY) ?? null;
  } catch {
    csrfToken = null;
  }
  return csrfToken ?? '';
}

/** Persist (or clear) the CSRF token. Memory + sessionStorage only. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
  try {
    const store = storage();
    if (store === null) return;
    if (token === null || token === '') store.removeItem(CSRF_STORAGE_KEY);
    else store.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    // Storage denied (private mode): the in-memory copy is enough for this tab.
  }
}

/** Ask the shell to re-check the session (401 session_required / logout). */
export function notifyAuthRequired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}

/** Base URL for the auth endpoints: same origin as the page. */
function authUrl(path: string, baseUrl = ''): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const origin = trimmed !== '' ? trimmed : window.location.origin;
  return origin + path;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * GET /auth/status. Throws when the endpoint is missing or unreachable --
 * callers MUST treat that as "auth unknown" and keep the app usable.
 */
export async function fetchAuthStatus(baseUrl = ''): Promise<AuthStatus> {
  const response = await withTimeout((signal) =>
    fetch(authUrl('/auth/status', baseUrl), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    }),
  );
  if (!response.ok) throw new Error(`auth_status_http_${String(response.status)}`);
  const body = (await response.json()) as Partial<AuthStatus>;
  const status: AuthStatus = {
    authEnabled: body.authEnabled === true,
    authenticated: body.authenticated === true,
    user: body.user ?? null,
    csrfToken: typeof body.csrfToken === 'string' ? body.csrfToken : null,
    loginBackends: Array.isArray(body.loginBackends) ? body.loginBackends : [],
    publicOrigin: typeof body.publicOrigin === 'string' ? body.publicOrigin : null,
    ...(typeof body.username === 'string' ? { username: body.username } : {}),
    ...(typeof body.passwordSet === 'boolean' ? { passwordSet: body.passwordSet } : {}),
    ...(body.passwordSource === 'env' || body.passwordSource === 'file'
      ? { passwordSource: body.passwordSource }
      : { passwordSource: null }),
    ...(typeof body.totpRequired === 'boolean' ? { totpRequired: body.totpRequired } : {}),
    ...(typeof body.recoveryCodesLeft === 'number'
      ? { recoveryCodesLeft: body.recoveryCodesLeft }
      : {}),
  };
  setCsrfToken(status.csrfToken);
  return status;
}

/** GET /auth/csrf: rotate a token when the page reloaded without one. */
export async function fetchCsrfToken(baseUrl = ''): Promise<string | null> {
  const response = await withTimeout((signal) =>
    fetch(authUrl('/auth/csrf', baseUrl), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    }),
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { csrfToken?: unknown };
  const token = typeof body.csrfToken === 'string' ? body.csrfToken : null;
  setCsrfToken(token);
  return token;
}

/**
 * POST /auth/logout. Returns true when the session is gone (200), false when the
 * server refused -- the cookie is cleared server-side in both cases, so the
 * caller should re-check /auth/status instead of trusting the boolean alone.
 */
export async function logout(baseUrl = ''): Promise<boolean> {
  const token = getCsrfToken();
  const response = await withTimeout((signal) =>
    fetch(authUrl('/auth/logout', baseUrl), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(token !== '' ? { [CSRF_HEADER]: token } : {}),
      },
      cache: 'no-store',
      signal,
    }),
  );
  setCsrfToken(null);
  return response.ok;
}

/** 登录类 POST 的共同封装：JSON-only（服务端会拒绝非 JSON）、同源 cookie。 */
async function postJson(
  path: string,
  body: Record<string, unknown>,
  baseUrl = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await withTimeout((signal) =>
    fetch(authUrl(path, baseUrl), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    }),
  );
  const parsed: unknown = await response.json().catch(() => null); // benign: JSON 解析探针——非 JSON 回落 null，下游校验显式失败。
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return { status: response.status, body: record };
}

function toLoginResult(status: number, body: Record<string, unknown>): LoginResult {
  const error = typeof body.error === 'string' ? body.error : undefined;
  const ok = status === 200 && body.ok === true;
  return {
    ok,
    ...(typeof body.totpRequired === 'boolean' ? { totpRequired: body.totpRequired } : {}),
    ...(typeof body.ticket === 'string' ? { ticket: body.ticket } : {}),
    ...(typeof body.expiresAt === 'number' ? { expiresAt: body.expiresAt } : {}),
    ...(typeof body.recoveryAllowed === 'boolean' ? { recoveryAllowed: body.recoveryAllowed } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
    ...(typeof body.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: body.retryAfterSeconds }
      : {}),
    ...(typeof body.locked === 'boolean' ? { locked: body.locked } : {}),
  };
}

/** POST /auth/login：口令第一步（需要 TOTP 时拿票根去 loginWithTotp）。 */
export async function loginWithPassword(
  username: string,
  password: string,
  baseUrl = '',
): Promise<LoginResult> {
  const { status, body } = await postJson('/auth/login', { username, password }, baseUrl);
  if (status === 200) setCsrfToken(null); // 新会话：旧 CSRF 立刻作废，refresh 会取新的。
  return toLoginResult(status, body);
}

/** POST /auth/login/totp：第二因子（6 位码或一次性恢复码）。 */
export async function loginWithTotp(
  ticket: string,
  code: string,
  baseUrl = '',
): Promise<LoginResult> {
  const { status, body } = await postJson('/auth/login/totp', { ticket, code }, baseUrl);
  if (status === 200) setCsrfToken(null);
  return toLoginResult(status, body);
}

/** POST /auth/bootstrap：一次性引导码 → 引导会话（只能设口令 / 绑 TOTP）。 */
export async function bootstrapSession(code: string, baseUrl = ''): Promise<BootstrapResult> {
  const { status, body } = await postJson('/auth/bootstrap', { code }, baseUrl);
  const error = typeof body.error === 'string' ? body.error : undefined;
  return {
    ok: status === 200 && body.ok === true,
    ...(typeof body.bootstrap === 'boolean' ? { bootstrap: body.bootstrap } : {}),
    ...(Array.isArray(body.capabilities)
      ? {
          capabilities: body.capabilities.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : {}),
    ...(typeof body.passwordSet === 'boolean' ? { passwordSet: body.passwordSet } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}

/** POST /auth/password/set：引导会话里设首次口令。 */
export async function setInitialPassword(password: string, baseUrl = ''): Promise<LoginResult> {
  const token = getCsrfToken();
  const response = await withTimeout((signal) =>
    fetch(authUrl('/auth/password/set', baseUrl), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token !== '' ? { [CSRF_HEADER]: token } : {}),
      },
      body: JSON.stringify({ password }),
      cache: 'no-store',
      signal,
    }),
  );
  const parsed: unknown = await response.json().catch(() => null); // benign: JSON 解析探针——非 JSON 回落 null，下游校验显式失败。
  const body =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  setCsrfToken(null); // 服务端轮换了 sid/CSRF
  if (response.ok) {
    // 轮换后旧 CSRF 立刻作废：紧接着的 /auth/totp/enroll 需要新的同步令牌。
    await fetchCsrfToken(baseUrl).catch(() => null); // benign: CSRF 预热尽力而为——失败后续请求重取。
  }
  return toLoginResult(response.status, body);
}

/** POST /auth/setup/finish：把设置会话换成正常的口令会话（否则应用进不去）。 */
export async function finishSetup(baseUrl = ''): Promise<LoginResult> {
  const token = getCsrfToken();
  const response = await withTimeout((signal) =>
    fetch(authUrl('/auth/setup/finish', baseUrl), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token !== '' ? { [CSRF_HEADER]: token } : {}),
      },
      body: '{}',
      cache: 'no-store',
      signal,
    }),
  );
  const parsed: unknown = await response.json().catch(() => null); // benign: JSON 解析探针——非 JSON 回落 null，下游校验显式失败。
  const body =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  setCsrfToken(null);
  return toLoginResult(response.status, body);
}

/** POST /auth/totp/enroll：绑定 TOTP，拿 secret 与一次性恢复码。 */
export async function enrollTotp(baseUrl = ''): Promise<EnrollResult> {
  const token = getCsrfToken();
  const response = await withTimeout((signal) =>
    fetch(authUrl('/auth/totp/enroll', baseUrl), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(token !== '' ? { [CSRF_HEADER]: token } : {}),
      },
      body: '{}',
      cache: 'no-store',
      signal,
    }),
  );
  const parsed: unknown = await response.json().catch(() => null); // benign: JSON 解析探针——非 JSON 回落 null，下游校验显式失败。
  const body =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const error = typeof body.error === 'string' ? body.error : undefined;
  return {
    ok: response.status === 200 && body.ok === true,
    ...(typeof body.secret === 'string' ? { secret: body.secret } : {}),
    ...(typeof body.otpauthUri === 'string' ? { otpauthUri: body.otpauthUri } : {}),
    ...(Array.isArray(body.recoveryCodes)
      ? {
          recoveryCodes: body.recoveryCodes.filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : {}),
    ...(error !== undefined ? { error } : {}),
    ...(typeof body.message === 'string' ? { message: body.message } : {}),
  };
}
