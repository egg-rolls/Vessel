/**
 * 口令策略（`kind: password`）。
 *
 * 口令后端**不是** OAuth：它没有授权跳转、没有回调、也不吃 `allow_user_ids`
 * （登录名就是身份，口令 hash 从 env / 凭据文件取）。
 *
 * 它在注册表里的作用只有一个：让「kind → 该后端需要什么」只有一份声明，
 * validator / resolver / 路由都不必再写一份 `if (kind === 'password')`。
 *
 * @module @vessel-agent/config/auth-strategies/password
 */

import { NO_ALLOW_USER_IDS_SHAPE } from './shapes.js';
import type { AuthStrategy } from './types.js';

export const PASSWORD_STRATEGY: AuthStrategy = {
  id: 'password',
  kind: 'password',
  label: 'Sign in with a password',
  allowUserIdsShape: NO_ALLOW_USER_IDS_SHAPE,
  // null = 没有授权跳转：口令表单就在登录页本身（`/auth/login`）。
  authorizeUrl: () => null,
  // 不可达：`/auth/password/*` 系列的 handler 不会走策略回调。
  // 显式抛错而不是返回一个「假装成功」的结果 —— 后者会变成一条越权后门。
  handleCallback: () => {
    throw new Error(
      'password backend has no OAuth callback: /auth/login, /auth/login/totp and /auth/bootstrap ' +
        'handle it instead',
    );
  },
  // 口令后端没有 provider 返回的 profile。
  identityOf: () => null,
};
