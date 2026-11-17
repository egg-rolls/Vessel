/**
 * 0.56 WebUI 登录：GitHub OAuth 后端（单用户，按数值 user id 白名单）。
 *
 * 设计依据：`docs/dev/design/0.56-webui-auth.md`（附录 A，github_oauth）。
 *
 * 三条不变量：
 * - `redirect_uri` **只**由 `auth.publicOrigin` + 固定路径拼出，永不从请求头推导
 *   （`Host` / `X-Forwarded-*` 都是攻击者可控输入）。
 * - access token 用完即弃：不落盘、不进日志、不进错误文案。
 * - 白名单比对**数值** user id（十进制字符串）；login 只用于展示。
 *
 * @module @vessel-agent/serve/auth/github-oauth
 */

import { createHash } from 'node:crypto';
import { randomToken } from './session.js';

/** one github_oauth 后端的配置形状（camelCase，ADR-019）。 */
export interface GitHubOAuthBackendConfig {
  kind: 'github_oauth';
  /** OAuth App 的 client id：公开值，放配置。 */
  clientId: string;
  /** 存 client secret 的**环境变量名**；secret 值永不入库。 */
  clientSecretEnv: string;
  /** 白名单：数值 GitHub user id（十进制字符串）。 */
  allowUserIds: string[];
  /** 登录按钮文案覆盖。 */
  label?: string | undefined;
}

export type AuthBackendConfig = GitHubOAuthBackendConfig;

/** GitHub 端点；可覆盖（GitHub Enterprise / 验收桩）。 */
export interface GitHubEndpoints {
  authorize: string;
  token: string;
  user: string;
}

export const GITHUB_ENDPOINTS: GitHubEndpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
};

/** 稳定错误码：只用于分支与文案，永不携带密钥。 */
export type GitHubAuthFailure =
  | 'state_invalid'
  | 'code_missing'
  | 'secret_missing'
  | 'token_exchange_failed'
  | 'user_fetch_failed'
  | 'not_allowlisted';

export type GitHubAuthResult =
  | { ok: true; userId: string; username: string }
  | { ok: false; failure: GitHubAuthFailure };

/** 一次在途授权请求；state 只存哈希，且一次性。 */
interface PendingFlow {
  stateHash: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  /** 浏览器绑定值（回合内 cookie 的哈希）：光偷 state 不够。 */
  binder: string | null;
}

export interface IssuedFlow {
  state: string;
  codeChallenge: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function base64urlSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/**
 * One-time state registry with PKCE verifiers.
 *
 * consume() deletes before returning, so a replayed state is always rejected
 * (even when the same value arrives twice in the same millisecond).
 */
export class OAuthFlowStore {
  private readonly flows = new Map<string, PendingFlow>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? STATE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  issue(input: { redirectUri: string; binder: string | null }): IssuedFlow {
    const state = randomToken(32);
    const codeVerifier = randomToken(32);
    this.flows.set(sha256Hex(state), {
      stateHash: sha256Hex(state),
      codeVerifier,
      redirectUri: input.redirectUri,
      createdAt: this.now(),
      binder: input.binder,
    });
    this.cleanup();
    return { state, codeChallenge: base64urlSha256(codeVerifier) };
  }

  /** 校验并消费：未知 / 过期 / 已用过 / 绑定不符一律返回 null。 */
  consume(
    state: string | null,
    binder: string | null,
  ): { codeVerifier: string; redirectUri: string } | null {
    if (state === null || state === '') return null;
    const key = sha256Hex(state);
    const flow = this.flows.get(key);
    if (flow === undefined) return null;
    this.flows.delete(key);
    if (this.now() - flow.createdAt > this.ttlMs) return null;
    if (flow.binder !== binder) return null;
    return { codeVerifier: flow.codeVerifier, redirectUri: flow.redirectUri };
  }

  size(): number {
    return this.flows.size;
  }

  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, flow] of this.flows) {
      if (now - flow.createdAt <= this.ttlMs) continue;
      this.flows.delete(key);
      removed += 1;
    }
    return removed;
  }
}

/** 唯一回调路径：GitHub OAuth App 必须按 publicOrigin + 它登记。 */
export const GITHUB_CALLBACK_PATH = '/auth/github/callback';

/**
 * redirect_uri: publicOrigin + fixed path, nothing else. Trailing slashes are
 * stripped so "https://egg-rolls.top/" and "...top" cannot diverge.
 */
export function buildRedirectUri(publicOrigin: string): string {
  return publicOrigin.trim().replace(/\/+$/, '') + GITHUB_CALLBACK_PATH;
}

/** 拼 authorize URL（/auth/github/start 的 302 目标）。 */
export function buildAuthorizeUrl(input: {
  config: GitHubOAuthBackendConfig;
  flow: IssuedFlow;
  redirectUri: string;
  endpoints?: GitHubEndpoints | undefined;
}): string {
  const endpoints = input.endpoints ?? GITHUB_ENDPOINTS;
  const url = new URL(endpoints.authorize);
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  // No scopes: /user (public profile incl. numeric id) needs none.
  url.searchParams.set('state', input.flow.state);
  url.searchParams.set('code_challenge', input.flow.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

/** 归一 /user 返回：数值 id 才是身份，login 只用于展示。 */
export function normalizeGitHubUser(raw: unknown): { userId: string; username: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as { id?: unknown; login?: unknown };
  if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0) return null;
  const username = typeof item.login === 'string' && item.login !== '' ? item.login : null;
  return { userId: String(item.id), username: username ?? `github-${String(item.id)}` };
}

/** 白名单只比对数值 id。 */
export function isAllowlisted(allowUserIds: string[], userId: string): boolean {
  return allowUserIds.some((entry) => String(entry).trim() === userId);
}

/** 从**环境变量名**取 client secret；永不从配置取。 */
export function resolveClientSecret(
  config: GitHubOAuthBackendConfig,
  env: Record<string, string | undefined>,
): string | null {
  const value = env[config.clientSecretEnv];
  if (typeof value !== 'string' || value === '') return null;
  return value;
}

/** 诊断输出：只写非敏感事实（不含 token / secret）。 */
export type AuthLogFn = (message: string) => void;

export interface CompleteLoginInput {
  config: GitHubOAuthBackendConfig;
  env: Record<string, string | undefined>;
  code: string | null;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch | undefined;
  endpoints?: GitHubEndpoints | undefined;
  log?: AuthLogFn | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Exchange the code and resolve the subject.
 *
 * Any failure returns a code; the token is a local variable that dies with the
 * call. Log lines contain at most GitHub error codes, never tokens/secrets.
 */
export async function completeGitHubLogin(input: CompleteLoginInput): Promise<GitHubAuthResult> {
  const log = input.log ?? (() => {});
  if (input.code === null || input.code === '') {
    log('github_oauth: callback without code');
    return { ok: false, failure: 'code_missing' };
  }
  const clientSecret = resolveClientSecret(input.config, input.env);
  if (clientSecret === null) {
    log(`github_oauth: env ${input.config.clientSecretEnv} is not set`);
    return { ok: false, failure: 'secret_missing' };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoints = input.endpoints ?? GITHUB_ENDPOINTS;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const signal = () => AbortSignal.timeout(timeoutMs);

  let accessToken: string | null = null;
  try {
    const body = new URLSearchParams();
    body.set('client_id', input.config.clientId);
    body.set('client_secret', clientSecret);
    body.set('code', input.code);
    body.set('redirect_uri', input.redirectUri);
    body.set('code_verifier', input.codeVerifier);
    const tokenResponse = await fetchImpl(endpoints.token, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'vessel-agent',
      },
      body: body.toString(),
      signal: signal(),
    });
    const tokenPayload: unknown = await tokenResponse.json().catch(() => null);
    const tokenField =
      typeof tokenPayload === 'object' && tokenPayload !== null
        ? (tokenPayload as { access_token?: unknown }).access_token
        : undefined;
    if (typeof tokenField !== 'string' || tokenField === '') {
      const errCode =
        typeof tokenPayload === 'object' && tokenPayload !== null
          ? (tokenPayload as { error?: unknown }).error
          : undefined;
      log(
        'github_oauth: token exchange failed status=' +
          String(tokenResponse.status) +
          ' error=' +
          (typeof errCode === 'string' ? errCode : 'unknown'),
      );
      return { ok: false, failure: 'token_exchange_failed' };
    }
    accessToken = tokenField;

    const userResponse = await fetchImpl(endpoints.user, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'vessel-agent',
      },
      signal: signal(),
    });
    if (!userResponse.ok) {
      log(`github_oauth: GET /user failed status=${String(userResponse.status)}`);
      return { ok: false, failure: 'user_fetch_failed' };
    }
    const userPayload: unknown = await userResponse.json().catch(() => null);
    const user = normalizeGitHubUser(userPayload);
    if (user === null) {
      log('github_oauth: /user payload has no numeric id');
      return { ok: false, failure: 'user_fetch_failed' };
    }
    if (!isAllowlisted(input.config.allowUserIds, user.userId)) {
      // Display name is not secret; it makes the rejection diagnosable.
      log(`github_oauth: user id ${user.userId} (${user.username}) is not allowlisted`);
      return { ok: false, failure: 'not_allowlisted' };
    }
    return { ok: true, userId: user.userId, username: user.username };
  } catch (error) {
    // Never interpolate the thrown value blindly: it can embed request details.
    const name = error instanceof Error ? error.name : 'unknown';
    log(`github_oauth: request failed (${name})`);
    return { ok: false, failure: 'user_fetch_failed' };
  } finally {
    // Drop the token reference as soon as the call is done (use-and-discard).
    accessToken = null;
  }
}
