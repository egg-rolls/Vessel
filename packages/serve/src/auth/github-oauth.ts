/**
 * 0.56 GitHub OAuth 的**兼容出口**。
 *
 * 通用流程在 `./oauth.js`，provider 差异在 `@vessel-agent/config` 的
 * `auth-strategies/`（策略注册表）；本模块只保留旧导出名，避免调用方在同一个
 * 提交里被强制改名。
 *
 * @deprecated 用 `./oauth.js`（流程）+ 策略注册表（provider）。
 * @module @vessel-agent/serve/auth/github-oauth
 */

export { normalizeGitHubUser } from '@vessel-agent/config';
export {
  type AuthLogFn,
  buildAuthorizeUrl,
  buildRedirectUri,
  type CompleteOAuthLoginInput,
  completeGitHubLogin,
  completeOAuthLogin,
  GITHUB_CALLBACK_PATH,
  type GitHubAuthFailure,
  type GitHubAuthResult,
  type GitHubEndpoints,
  type GitHubOAuthBackendConfig,
  isAllowlisted,
  normalizeProviderUser,
  type OAuthAuthFailure,
  type OAuthAuthResult,
  type OAuthBackendConfig,
  type OAuthEndpoints,
  OAuthFlowStore,
  resolveClientSecret,
} from './oauth.js';
