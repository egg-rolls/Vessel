/**
 * 0.56 WebUI 登录模块出口。
 *
 * @module @vessel-agent/serve/auth
 */

export {
  type AuthBackendConfig,
  type AuthLogFn,
  buildAuthorizeUrl,
  buildRedirectUri,
  completeGitHubLogin,
  GITHUB_CALLBACK_PATH,
  type GitHubAuthFailure,
  type GitHubAuthResult,
  type GitHubEndpoints,
  type GitHubOAuthBackendConfig,
  isAllowlisted,
  normalizeGitHubUser,
  OAuthFlowStore,
  resolveClientSecret,
} from './github-oauth.js';
export {
  type AuthGateResult,
  type AuthRequestContext,
  AuthService,
  type AuthServiceOptions,
  type AuthSessionSettings,
  type AuthSettings,
  CSRF_HEADER,
  isAuthPublicPath,
  LOGIN_PATH,
} from './routes.js';
export {
  type AuthSubject,
  buildClearedSessionCookie,
  buildSessionCookie,
  type IssuedSession,
  randomToken,
  readCookie,
  type SessionCookiePolicy,
  type SessionMeta,
  type SessionSnapshot,
  SessionStore,
  sessionCookieName,
} from './session.js';
