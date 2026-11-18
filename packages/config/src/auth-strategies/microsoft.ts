/**
 * Microsoft 策略（`kind: microsoft_oauth`）。
 *
 * 身份 = Graph `/v1.0/me` 的 `id`：
 * - 工作 / 学校账号是对象 id（GUID）；
 * - **个人 Microsoft 账号**是不透明的 16 进制串（如 `8364acbdb89d0ff1`），
 *   只认 GUID 会把个人账号挡在配置之外 —— 这是 0.62 的真实故障现场。
 *
 * 白名单比较**大小写不敏感**（Graph 的 id 大小写不固定）。
 *
 * 个人账号没有 `userPrincipalName` 的 mail 属性，展示名按 displayName →
 * userPrincipalName → mail 依次降级；读不到仍然能用 id 当展示名。
 *
 * @module @vessel-agent/config/auth-strategies/microsoft
 */

import { authorizeUrlWith, exchangeCodeForIdentity } from './oauth-exchange.js';
import { MICROSOFT_OBJECT_ID_SHAPE } from './shapes.js';
import type {
  AuthAvatarRef,
  AuthStrategy,
  AuthStrategyEndpoints,
  AuthStrategyIdentity,
} from './types.js';

const MICROSOFT_ENDPOINTS: AuthStrategyEndpoints = {
  authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  user: 'https://graph.microsoft.com/v1.0/me',
};

/**
 * Microsoft 的 `authorize` **必须**显式带 `response_type=code`
 * （默认 `id_token`，拿不到授权码）；`response_mode=query` 让 code 落在查询串里，
 * 这既是 PKCE 的要求，也是我们这个回调能读到的唯一位置。
 */
const MICROSOFT_AUTHORIZE_EXTRA: ReadonlyArray<readonly [string, string]> = [
  ['response_type', 'code'],
  ['response_mode', 'query'],
];

/** 授权 scope：读 `/me`（含照片）+ 可读展示名 + 刷新用（0.63 头像需要）。 */
const MICROSOFT_SCOPE = 'openid profile email offline_access User.Read';

/** Graph `/v1.0/me` → 身份：`id` 是对象 id（字符串）。 */
export function normalizeMicrosoftUser(raw: unknown): AuthStrategyIdentity | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as {
    id?: unknown;
    displayName?: unknown;
    userPrincipalName?: unknown;
    mail?: unknown;
  };
  if (typeof item.id !== 'string' || item.id.trim() === '') return null;
  const userId = item.id.trim();
  const candidates = [item.displayName, item.userPrincipalName, item.mail];
  const username = candidates.find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return {
    userId,
    username: username?.trim() ?? `microsoft-${userId}`,
    // Graph `/me` **没有**公开头像地址：头像要带 token 去 `/me/photo/$value` 取二进制。
    avatar: { kind: 'graph-photo' },
  };
}

/**
 * Microsoft 的头像只能「带 token 去取」，所以这里给的是一个**标记**，不是地址。
 * 取不到（用户没设头像 / 403 / 超时）都只是没有头像，不影响登录。
 */
export function microsoftAvatarOf(raw: unknown): AuthAvatarRef | null {
  return normalizeMicrosoftUser(raw) === null ? null : { kind: 'graph-photo' };
}

export const MICROSOFT_STRATEGY: AuthStrategy = {
  id: 'microsoft',
  kind: 'microsoft_oauth',
  label: 'Sign in with Microsoft',
  allowUserIdsShape: MICROSOFT_OBJECT_ID_SHAPE,
  authorizeUrl: (params) =>
    authorizeUrlWith(MICROSOFT_ENDPOINTS.authorize, params, {
      // `User.Read` 才能读 `/me` 与 `/me/photo/$value`；openid/profile/email 让 Graph 顺带
      // 给出可读的展示名。`offline_access` 为了「登录之后还能代表用户取一次头像」——
      // refresh token 只存在进程内存里（见 OAuthCredentials 的注释），不落盘。
      scope: MICROSOFT_SCOPE,
      extra: MICROSOFT_AUTHORIZE_EXTRA,
    }),
  handleCallback: (params) =>
    exchangeCodeForIdentity(params, {
      label: 'microsoft_oauth',
      endpoints: MICROSOFT_ENDPOINTS,
      userAccept: 'application/json',
      userRequestLabel: 'GET /me',
      userMissingIdMessage: '/me payload has no usable id',
      identityOf: normalizeMicrosoftUser,
    }),
  identityOf: normalizeMicrosoftUser,
  avatarOf: microsoftAvatarOf,
};
