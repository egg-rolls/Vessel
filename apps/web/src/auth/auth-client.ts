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
