/**
 * OAuth 的**唯一** HTTP 实现（授权码 → access token → 用户对象 → 身份）。
 *
 * provider 之间真正不同的只有三件事：端点、`authorize` 上多几个固定参数、
 * 用户对象里哪个字段是身份。这三件事由每个策略文件声明，流程本身只有这一份 ——
 * 否则加第三个 provider 时就会有人把「读哪个字段当 id」再抄一遍，抄错一个字段
 * 就是一次越权登录。
 *
 * 不变量（与 0.56 的 github_oauth 逐字一致）：
 * - access token 用完即弃：不落盘、不进日志、不进错误文案；
 * - 两条腿分开 catch：网络不通（网关出不了网）与 provider 拒绝是两种排障方向；
 * - 日志只写状态码 / provider 错误码 / 归一后的 user id，**永不**写 token / secret。
 *
 * @module @vessel-agent/config/auth-strategies/oauth-exchange
 */

import type {
  AuthorizeUrlParams,
  AuthStrategyEndpoints,
  AuthStrategyIdentity,
  AuthStrategyLoginResult,
  HandleCallbackParams,
} from './types.js';

/** 拼授权跳转 URL 的公共部分（`client_id` / `redirect_uri` / PKCE / 额外固定参数）。 */
export function authorizeUrlWith(
  baseUrl: string,
  params: AuthorizeUrlParams,
  options: { scope?: string | null; extra?: ReadonlyArray<readonly [string, string]> } = {},
): string {
  const url = new URL(params.endpoints?.authorize ?? baseUrl);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  if (options.scope !== undefined && options.scope !== null && options.scope !== '') {
    url.searchParams.set('scope', options.scope);
  }
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of options.extra ?? []) url.searchParams.set(key, value);
  return url.toString();
}

/** 一个 provider 的「读用户」细节。 */
export interface OAuthProfileSource {
  /** 日志前缀（= 策略 kind）。 */
  label: string;
  endpoints: AuthStrategyEndpoints;
  /** 用户接口的 `accept` 头。 */
  userAccept: string;
  /** 日志里的用户接口称呼（GitHub 是 `GET /user`，Graph 是 `GET /me`）。 */
  userRequestLabel: string;
  /** 读不到身份时的日志措辞。 */
  userMissingIdMessage: string;
  /** 归一用户对象（策略自己的 `identityOf`）。 */
  identityOf(profile: unknown): AuthStrategyIdentity | null;
  /** 端点覆盖；省略 = 上面 `endpoints` 里的正式端点。 */
  endpointsOverride?: AuthStrategyEndpoints | undefined;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 用授权码换身份。任何失败都返回**稳定失败码**，不抛错（回调路由据此 302 回登录页）。
 *
 * 白名单**不在这里**比对：那是与 provider 无关的策略，放在 `./match.js`。
 */
export async function exchangeCodeForIdentity(
  params: HandleCallbackParams,
  source: OAuthProfileSource,
): Promise<AuthStrategyLoginResult> {
  const log = params.log ?? (() => {});
  const prefix = source.label;
  if (params.code === null || params.code === '') {
    log(`${prefix}: callback without code`);
    return { ok: false, failure: 'code_missing' };
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const endpoints = params.endpoints ?? source.endpointsOverride ?? source.endpoints;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = (): AbortSignal => AbortSignal.timeout(timeoutMs);

  let accessToken: string | null = null;
  try {
    const body = new URLSearchParams();
    body.set('client_id', params.clientId);
    body.set('client_secret', params.clientSecret);
    body.set('code', params.code);
    body.set('redirect_uri', params.redirectUri);
    body.set('code_verifier', params.codeVerifier);
    body.set('grant_type', 'authorization_code');
    let tokenResponse: Response;
    try {
      tokenResponse = await fetchImpl(endpoints.token, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'vessel-agent',
        },
        body: body.toString(),
        signal: signal(),
      });
    } catch (error) {
      // 不内插 thrown value：它可能带上请求细节。
      log(`${prefix}: token exchange request failed (${errorName(error)})`);
      return { ok: false, failure: 'token_exchange_failed' };
    }
    const tokenPayload: unknown = await tokenResponse.json().catch(() => null);
    const tokenField = readField(tokenPayload, 'access_token');
    if (typeof tokenField !== 'string' || tokenField === '') {
      const errCode = readField(tokenPayload, 'error');
      log(
        `${prefix}: token exchange failed status=` +
          String(tokenResponse.status) +
          ' error=' +
          (typeof errCode === 'string' ? errCode : 'unknown'),
      );
      return { ok: false, failure: 'token_exchange_failed' };
    }
    accessToken = tokenField;
    // 令牌逃生口（唯一一处）：只给「登录之后还要代表用户去取头像」的 provider。
    // 通用流程把它交给内存级 AvatarService；这里不判断是谁，也不写日志。
    if (params.onCredentials !== undefined) {
      const refreshToken = readField(tokenPayload, 'refresh_token');
      const expiresIn = readField(tokenPayload, 'expires_in');
      const scopeField = readField(tokenPayload, 'scope');
      params.onCredentials({
        accessToken: tokenField,
        tokenEndpoint: endpoints.token,
        ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
        ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
          ? { expiresAt: Date.now() + expiresIn * 1000 }
          : {}),
        ...(typeof scopeField === 'string' && scopeField !== '' ? { scope: scopeField } : {}),
      });
    }

    let userResponse: Response;
    try {
      userResponse = await fetchImpl(endpoints.user, {
        method: 'GET',
        headers: {
          accept: source.userAccept,
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'vessel-agent',
        },
        signal: signal(),
      });
    } catch (error) {
      log(`${prefix}: ${source.userRequestLabel} request failed (${errorName(error)})`);
      return { ok: false, failure: 'user_fetch_failed' };
    }
    if (!userResponse.ok) {
      log(`${prefix}: ${source.userRequestLabel} failed status=${String(userResponse.status)}`);
      return { ok: false, failure: 'user_fetch_failed' };
    }
    const userPayload: unknown = await userResponse.json().catch(() => null);
    const identity = source.identityOf(userPayload);
    if (identity === null) {
      log(`${prefix}: ${source.userMissingIdMessage}`);
      return { ok: false, failure: 'user_fetch_failed' };
    }
    return { ok: true, identity };
  } catch (error) {
    // 两条腿之外（解析等）：保留历史失败码，别让调用方少一个分支。
    log(`${prefix}: unexpected failure (${errorName(error)})`);
    return { ok: false, failure: 'user_fetch_failed' };
  } finally {
    // token 引用立刻丢掉（use-and-discard）。
    accessToken = null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function readField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}
