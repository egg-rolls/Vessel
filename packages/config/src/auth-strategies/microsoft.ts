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
import type { AuthStrategy, AuthStrategyEndpoints, AuthStrategyIdentity } from './types.js';

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
  return { userId, username: username?.trim() ?? `microsoft-${userId}` };
}

export const MICROSOFT_STRATEGY: AuthStrategy = {
  id: 'microsoft',
  kind: 'microsoft_oauth',
  label: 'Sign in with Microsoft',
  allowUserIdsShape: MICROSOFT_OBJECT_ID_SHAPE,
  authorizeUrl: (params) =>
    authorizeUrlWith(MICROSOFT_ENDPOINTS.authorize, params, {
      // `User.Read` 才能读 `/me`；openid/profile/email 让 Graph 顺带给出可读的展示名。
      scope: 'openid profile email User.Read',
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
};
