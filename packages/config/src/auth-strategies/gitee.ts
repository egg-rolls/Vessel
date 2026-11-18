/**
 * Gitee 策略（`kind: gitee_oauth`）。
 *
 * 身份 = `/api/v5/user` 的**数值** `id`；同时把 `login` 当作可比较的身份值
 * （`aliases`）：Gitee 的白名单在实践中写用户名更常见，而 `login` 是 Gitee 自己
 * 用来定位用户的稳定标识。两者都不参与展示以外的用途时不会误判 ——
 * 白名单命中与否只看「配置里写了什么」，不看展示名。
 *
 * @module @vessel-agent/config/auth-strategies/gitee
 */

import { avatarRefFrom } from './avatar-ref.js';
import { authorizeUrlWith, exchangeCodeForIdentity } from './oauth-exchange.js';
import { GITEE_ID_OR_LOGIN_SHAPE } from './shapes.js';
import type {
  AuthAvatarRef,
  AuthStrategy,
  AuthStrategyEndpoints,
  AuthStrategyIdentity,
} from './types.js';

const GITEE_ENDPOINTS: AuthStrategyEndpoints = {
  authorize: 'https://gitee.com/oauth/authorize',
  token: 'https://gitee.com/oauth/token',
  user: 'https://gitee.com/api/v5/user',
};

/** `/api/v5/user` → 身份：数值 id 是主身份，login 作为可比较别名。 */
export function normalizeGiteeUser(raw: unknown): AuthStrategyIdentity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as { id?: unknown; login?: unknown; name?: unknown };
  if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0) return null;
  const login = typeof item.login === 'string' && item.login !== '' ? item.login : null;
  const display = login ?? (typeof item.name === 'string' && item.name !== '' ? item.name : null);
  const userId = String(item.id);
  const avatar = giteeAvatarOf(raw);
  return {
    userId,
    username: display ?? `gitee-${userId}`,
    ...(login !== null ? { aliases: [login] } : {}),
    ...(avatar !== null ? { avatar } : {}),
  };
}

/** Gitee 的 `avatar_url` 是公开地址（同样由服务端代取）。 */
export function giteeAvatarOf(raw: unknown): AuthAvatarRef | null {
  return avatarRefFrom(raw, 'avatar_url');
}

export const GITEE_STRATEGY: AuthStrategy = {
  id: 'gitee',
  kind: 'gitee_oauth',
  label: 'Sign in with Gitee',
  allowUserIdsShape: GITEE_ID_OR_LOGIN_SHAPE,
  authorizeUrl: (params) =>
    // Gitee 与 Microsoft 一样要求显式 `response_type=code`。
    authorizeUrlWith(GITEE_ENDPOINTS.authorize, params, {
      scope: 'user_info',
      extra: [['response_type', 'code']],
    }),
  handleCallback: (params) =>
    exchangeCodeForIdentity(params, {
      label: 'gitee_oauth',
      endpoints: GITEE_ENDPOINTS,
      userAccept: 'application/json',
      userRequestLabel: 'GET /user',
      userMissingIdMessage: '/user payload has no numeric id',
      identityOf: normalizeGiteeUser,
    }),
  identityOf: normalizeGiteeUser,
  avatarOf: giteeAvatarOf,
};
