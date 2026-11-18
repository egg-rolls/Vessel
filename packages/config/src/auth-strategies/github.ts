/**
 * GitHub 策略（`kind: github_oauth`）。
 *
 * 身份 = `/user` 的**数值** account id。`login` 只用于展示：GitHub 允许改名，
 * 拿 `login` 当身份等于「改个名字就能换人」。
 *
 * @module @vessel-agent/config/auth-strategies/github
 */

import { avatarRefFrom } from './avatar-ref.js';
import { authorizeUrlWith, exchangeCodeForIdentity } from './oauth-exchange.js';
import { NUMERIC_USER_ID_SHAPE } from './shapes.js';
import type {
  AuthAvatarRef,
  AuthStrategy,
  AuthStrategyEndpoints,
  AuthStrategyIdentity,
} from './types.js';

const GITHUB_ENDPOINTS: AuthStrategyEndpoints = {
  authorize: 'https://github.com/login/oauth/authorize',
  token: 'https://github.com/login/oauth/access_token',
  user: 'https://api.github.com/user',
};

/** `/user` → 身份：数值 id 才是身份，login 只用于展示。 */
export function normalizeGitHubUser(raw: unknown): AuthStrategyIdentity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as { id?: unknown; login?: unknown };
  if (typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0) return null;
  const username = typeof item.login === 'string' && item.login !== '' ? item.login : null;
  const avatar = githubAvatarOf(raw);
  return {
    userId: String(item.id),
    username: username ?? `github-${String(item.id)}`,
    ...(avatar !== null ? { avatar } : {}),
  };
}

/** GitHub 的 `avatar_url` 是公开地址（CDN 由服务端代取，前端不直连）。 */
export function githubAvatarOf(raw: unknown): AuthAvatarRef | null {
  return avatarRefFrom(raw, 'avatar_url');
}

export const GITHUB_STRATEGY: AuthStrategy = {
  id: 'github',
  kind: 'github_oauth',
  label: 'Sign in with GitHub',
  allowUserIdsShape: NUMERIC_USER_ID_SHAPE,
  authorizeUrl: (params) =>
    // GitHub 的 `/user` 公开资料不需要 scope，所以这里不传 scope。
    authorizeUrlWith(GITHUB_ENDPOINTS.authorize, params, { extra: [['allow_signup', 'false']] }),
  handleCallback: (params) =>
    exchangeCodeForIdentity(params, {
      label: 'github_oauth',
      endpoints: GITHUB_ENDPOINTS,
      userAccept: 'application/vnd.github+json',
      userRequestLabel: 'GET /user',
      userMissingIdMessage: '/user payload has no numeric id',
      identityOf: normalizeGitHubUser,
    }),
  identityOf: normalizeGitHubUser,
  avatarOf: githubAvatarOf,
};
