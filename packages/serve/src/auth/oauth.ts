/**
 * 0.62 WebUI 登录：OAuth 的**唯一流程**。
 *
 * provider 之间的差异全部在策略注册表里（`@vessel-agent/config` 的
 * `auth-strategies/`）：端点、authorize 上多几个参数、用户对象里哪个字段是身份、
 * `allow_user_ids` 是什么形状。本模块只剩下与 provider 无关的那部分：
 *
 * 三条不变量（与 0.56 的 github_oauth 逐字一致）：
 * - `redirect_uri` **只**由「本次选中的来源（`auth.public_origins` /
 *   `auth.public_origin` 白名单里的原值）+ 固定回调路径」拼出，永不从请求头推导
 *   （`Host` / `X-Forwarded-*` 都是攻击者可控输入）；选中的来源同时写进在途流程，
 *   回调来源不一致即拒绝。
 * - access token 用完即弃：不落盘、不进日志、不进错误文案。
 * - 白名单按 provider 归一化后的身份**精确匹配**（大小写敏感性由策略声明）；
 *   展示名只用于界面。
 *
 * @module @vessel-agent/serve/auth/oauth
 */

import { createHash } from 'node:crypto';
import {
  type AuthStrategy,
  type AuthStrategyEndpoints,
  type AuthStrategyFailure,
  type AuthStrategyIdentity,
  GITHUB_STRATEGY,
  isAllowlisted as isIdentityAllowlisted,
} from '@vessel-agent/config';
import { randomToken } from './session.js';

/** 一个 OAuth 后端的运行配置（camelCase，ADR-019）；所有 kind 字段形状一致。 */
export interface OAuthBackendConfig {
  /** `auth.backends[].kind` 的生效值（见策略注册表；不要再在这里枚举）。 */
  kind: string;
  /** OAuth App 的 client id：公开值，放配置。 */
  clientId: string;
  /** 存 client secret 的**环境变量名**；secret 值永不入库。 */
  clientSecretEnv: string;
  /** 白名单：provider 归一化后的身份（字符串精确匹配）。 */
  allowUserIds: string[];
  /** 登录按钮文案覆盖。 */
  label?: string | undefined;
}

/** 0.56 名称的兼容别名。 */
export type GitHubOAuthBackendConfig = OAuthBackendConfig;

/** OAuth 端点；可覆盖（验收桩 / 私有部署）。 */
export type OAuthEndpoints = AuthStrategyEndpoints;

/** 0.56 名称的兼容别名。 */
export type GitHubEndpoints = OAuthEndpoints;

/** 稳定错误码：只用于分支与文案，永不携带密钥。 */
export type OAuthAuthFailure = AuthStrategyFailure;

/** 0.56 名称的兼容别名。 */
export type GitHubAuthFailure = OAuthAuthFailure;

export type OAuthAuthResult =
  | { ok: true; userId: string; username: string }
  | { ok: false; failure: OAuthAuthFailure };

/** 0.56 名称的兼容别名。 */
export type GitHubAuthResult = OAuthAuthResult;

/** 一次在途授权请求；state 只存哈希，且一次性。 */
interface PendingFlow {
  stateHash: string;
  codeVerifier: string;
  /**
   * 本次流程**使用的来源**（白名单里的原值）。
   *
   * 回调必须落在同一个来源上（同一套受信边缘判定再选一次）；不一致直接拒绝。
   * 这是「state 绑定来源」那一格：光绑定 redirect_uri 不够，还要能说出它是谁。
   */
  origin: string;
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

/** 某个策略的授权起步路径（`/auth/<id>/start`）。 */
export function oauthStartPath(strategy: Pick<AuthStrategy, 'id'>): string {
  return `/auth/${strategy.id}/start`;
}

/** 某个策略的回调路径（`/auth/<id>/callback`）。 */
export function oauthCallbackPath(strategy: Pick<AuthStrategy, 'id'>): string {
  return `/auth/${strategy.id}/callback`;
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

  /**
   * 签发一次性 state + PKCE verifier。
   *
   * `origin` 是**本次流程选中的来源**（必须来自白名单），`redirectUri` 由它 +
   * provider 的固定路径拼出，两者一起落进在途表 —— 回调时既不能改 redirect_uri，
   * 也不能改来源。
   */
  issue(input: { origin: string; binder: string | null; redirectUri: string }): IssuedFlow {
    const state = randomToken(32);
    const codeVerifier = randomToken(32);
    this.flows.set(sha256Hex(state), {
      stateHash: sha256Hex(state),
      codeVerifier,
      origin: input.origin,
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
  ): { codeVerifier: string; redirectUri: string; origin: string } | null {
    if (state === null || state === '') return null;
    const key = sha256Hex(state);
    const flow = this.flows.get(key);
    if (flow === undefined) return null;
    this.flows.delete(key);
    if (this.now() - flow.createdAt > this.ttlMs) return null;
    if (flow.binder !== binder) return null;
    return { codeVerifier: flow.codeVerifier, redirectUri: flow.redirectUri, origin: flow.origin };
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

/** GitHub 的唯一回调路径（0.56 常量，保持导出）。 */
export const GITHUB_CALLBACK_PATH = oauthCallbackPath(GITHUB_STRATEGY);

/**
 * redirect_uri: publicOrigin + fixed path, nothing else. Trailing slashes are
 * stripped so "https://egg-rolls.top/" and "...top" cannot diverge.
 *
 * `callbackPath` 省略时保持 0.56 行为（GitHub 路径）。
 */
export function buildRedirectUri(
  publicOrigin: string,
  callbackPath: string = GITHUB_CALLBACK_PATH,
): string {
  return publicOrigin.trim().replace(/\/+$/, '') + callbackPath;
}

/** 拼 authorize URL（`/auth/<provider>/start` 的 302 目标）。 */
export function buildAuthorizeUrl(input: {
  strategy: AuthStrategy;
  config: OAuthBackendConfig;
  flow: IssuedFlow;
  redirectUri: string;
  endpoints?: OAuthEndpoints | undefined;
}): string {
  const url = input.strategy.authorizeUrl({
    clientId: input.config.clientId,
    redirectUri: input.redirectUri,
    state: input.flow.state,
    codeChallenge: input.flow.codeChallenge,
    ...(input.endpoints !== undefined ? { endpoints: input.endpoints } : {}),
  });
  if (url === null) {
    // 口令策略没有授权跳转；调用方必须先判断（见 routes.ts 的 requiresPublicOrigin）。
    throw new Error(`auth strategy "${input.strategy.kind}" has no authorize URL`);
  }
  return url;
}

/** 归一 provider 返回的用户对象（委托给策略）。 */
export function normalizeProviderUser(
  strategy: AuthStrategy,
  raw: unknown,
): AuthStrategyIdentity | null {
  return strategy.identityOf(raw);
}

/** 白名单按字符串精确匹配（0.56 签名；大小写不敏感的 provider 走策略版）。 */
export function isAllowlisted(allowUserIds: string[], userId: string): boolean {
  return allowUserIds.some((entry) => String(entry).trim() === userId);
}

/** 从**环境变量名**取 client secret；永不从配置取。 */
export function resolveClientSecret(
  config: Pick<OAuthBackendConfig, 'clientSecretEnv'>,
  env: Record<string, string | undefined>,
): string | null {
  const value = env[config.clientSecretEnv];
  if (typeof value !== 'string' || value === '') return null;
  return value;
}

/** 诊断输出：只写非敏感事实（不含 token / secret）。 */
export type AuthLogFn = (message: string) => void;

export interface CompleteOAuthLoginInput {
  /** 用哪个策略（= `auth.backends[].kind` 查注册表的结果）。 */
  strategy: AuthStrategy;
  config: OAuthBackendConfig;
  env: Record<string, string | undefined>;
  code: string | null;
  redirectUri: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch | undefined;
  endpoints?: OAuthEndpoints | undefined;
  log?: AuthLogFn | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Exchange the code and resolve the subject.
 *
 * 两条腿在策略里（`handleCallback`），白名单比对在这里 —— 后者与 provider 无关。
 * 任何失败都返回稳定错误码；token 是局部变量，随调用结束消失。
 */
export async function completeOAuthLogin(input: CompleteOAuthLoginInput): Promise<OAuthAuthResult> {
  const log = input.log ?? (() => {});
  const prefix = input.strategy.kind;
  const clientSecret = resolveClientSecret(input.config, input.env);
  if (clientSecret === null) {
    log(`${prefix}: env ${input.config.clientSecretEnv} is not set`);
    return { ok: false, failure: 'secret_missing' };
  }
  const result = await input.strategy.handleCallback({
    code: input.code,
    redirectUri: input.redirectUri,
    codeVerifier: input.codeVerifier,
    clientId: input.config.clientId,
    clientSecret,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.endpoints !== undefined ? { endpoints: input.endpoints } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    log,
  });
  if (!result.ok) return { ok: false, failure: result.failure };
  const identity = result.identity;
  if (!isIdentityAllowlisted(input.strategy, input.config.allowUserIds, identity)) {
    // Display name is not secret; it makes the rejection diagnosable.
    log(`${prefix}: user id ${identity.userId} (${identity.username}) is not allowlisted`);
    return { ok: false, failure: 'not_allowlisted' };
  }
  return { ok: true, userId: identity.userId, username: identity.username };
}

/** 0.56 导出名：GitHub 的等价调用。 */
export function completeGitHubLogin(
  input: Omit<CompleteOAuthLoginInput, 'strategy'>,
): Promise<OAuthAuthResult> {
  return completeOAuthLogin({ ...input, strategy: GITHUB_STRATEGY });
}
