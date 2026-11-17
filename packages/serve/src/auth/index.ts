/**
 * 0.56 WebUI 登录模块出口。
 *
 * @module @vessel-agent/serve/auth
 */

export {
  type BootstrapClaim,
  BootstrapCodes,
  DEFAULT_BOOTSTRAP_TTL_MS,
  type IssuedBootstrapCode,
  type PendingLoginEntry,
  PendingLogins,
} from './bootstrap.js';
export {
  CredentialStore,
  type CredentialStoreOptions,
  RECOVERY_CODE_COUNT,
  type RecoveryCodeRecord,
  type StoredCredentials,
  type TotpRecord,
} from './credentials.js';
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
  ARGON2_PARAMS,
  detectAlgorithm,
  hashPassword,
  passwordPolicyError,
  type StoredPassword,
  verifyPassword,
} from './password.js';
export {
  accountKey,
  DEFAULT_LIMITER_POLICY,
  ipKey,
  type LimiterEntry,
  type LimiterGate,
  type LimiterPolicy,
  LoginLimiter,
  retryAfterSeconds,
} from './ratelimit.js';
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
  unlockCommand,
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
export {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  normalizeCode,
  stepAt,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_SECRET_BYTES,
  TOTP_STEP_SECONDS,
  totpAt,
  type VerifyTotpInput,
  verifyTotp,
} from './totp.js';
