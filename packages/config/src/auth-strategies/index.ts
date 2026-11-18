/**
 * 登录策略模块出口。
 *
 * @module @vessel-agent/config/auth-strategies
 */

export { avatarRefFrom, publicAvatarRef } from './avatar-ref.js';
export { GITEE_STRATEGY, giteeAvatarOf, normalizeGiteeUser } from './gitee.js';
export { GITHUB_STRATEGY, githubAvatarOf, normalizeGitHubUser } from './github.js';
export { isAllowlisted, type NormalizedAllowUserIds, normalizeAllowUserIds } from './match.js';
export { MICROSOFT_STRATEGY, microsoftAvatarOf, normalizeMicrosoftUser } from './microsoft.js';
export {
  authorizeUrlWith,
  exchangeCodeForIdentity,
  type OAuthProfileSource,
} from './oauth-exchange.js';
export { PASSWORD_STRATEGY } from './password.js';
export {
  authStrategies,
  DEFAULT_AUTH_BACKEND_KIND,
  describeRegisteredAuthKinds,
  getAuthStrategy,
  redirectAuthStrategies,
  registerAuthStrategy,
  registeredAuthKinds,
  requiresPublicOrigin,
  resetAuthStrategies,
} from './registry.js';
export {
  GITEE_ID_OR_LOGIN_SHAPE,
  MICROSOFT_OBJECT_ID_SHAPE,
  NO_ALLOW_USER_IDS_SHAPE,
  NUMERIC_USER_ID_SHAPE,
} from './shapes.js';
export {
  type AllowUserIdsShape,
  type AuthAvatarRef,
  type AuthorizeUrlParams,
  type AuthStrategy,
  type AuthStrategyEndpoints,
  type AuthStrategyFailure,
  type AuthStrategyIdentity,
  type AuthStrategyLoginResult,
  type HandleCallbackParams,
  type OAuthCredentials,
  PASSWORD_STRATEGY_KIND,
} from './types.js';
