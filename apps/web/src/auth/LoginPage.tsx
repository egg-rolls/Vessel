/**
 * 0.56 P2：极简登录页（口令 + TOTP / 恢复码 / GitHub）。
 *
 * 三种形态由 `/auth/status` 的事实决定：
 * - 配了口令后端且**已设口令** ⇒ 用户名 + 口令表单；需要第二因子时切到验证码输入；
 * - 配了口令后端但**还没设口令** ⇒ 只提示「用启动日志里的一次性引导码打开」；
 * - GitHub 后端 ⇒ 普通链接（平台 RPC 挂了也能点）。
 *
 * 错误位由本地状态驱动（登录接口的稳定错误码），不把服务端文案直接当 UI 文案用。
 *
 * @module web/auth/LoginPage
 */

import { type FormEvent, useState } from 'react';
import { t } from '../i18n';
import {
  type AuthBackendInfo,
  type LoginResult,
  loginWithPassword,
  loginWithTotp,
} from './auth-client';

/** Error codes the gateway appends to /login?error=... (OAuth 回调那条路)。 */
const KNOWN_ERRORS = [
  'state_invalid',
  'code_missing',
  'secret_missing',
  'token_exchange_failed',
  'user_fetch_failed',
  'not_allowlisted',
  'public_origin_missing',
  'backend_not_configured',
  'bootstrap_replayed',
  'bootstrap_expired',
  'bootstrap_invalid',
] as const;

/** 登录接口返回的稳定错误码（口令 / TOTP / 限流）。 */
const KNOWN_LOGIN_ERRORS = [
  'invalid_credentials',
  'invalid_code',
  'code_replayed',
  'ticket_invalid',
  'rate_limited',
  'password_not_set',
  'password_unsupported',
  'bootstrap_disabled',
] as const;

function translateError(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === '') return null;
  if ((KNOWN_ERRORS as readonly string[]).includes(code)) return t(`auth.error.${code}`);
  if ((KNOWN_LOGIN_ERRORS as readonly string[]).includes(code)) return t(`auth.error.${code}`);
  return t('auth.error.unknown');
}

function errorFromLocation(): string | null {
  try {
    return translateError(new URLSearchParams(window.location.search).get('error'));
  } catch {
    return null;
  }
}

export interface LoginPageProps {
  /** 后端列表（口令在前、GitHub 在后；由 /auth/status 决定）。 */
  backends: AuthBackendInfo[];
  /** 口令后端：是否已设口令。 */
  passwordSet: boolean;
  /** 口令后端的登录名（预填）。 */
  username: string;
  /** 口令登录后是否还要 TOTP / 恢复码。 */
  totpRequired: boolean;
  /** 剩余恢复码数量（为 0 时不提示这条路）。 */
  recoveryCodesLeft: number;
  /** 引导码失败原因（`bootstrap_replayed` 等）；没有则 null。 */
  bootstrapError: string | null;
  /** GitHub 回调地址提示（OAuth App 必须逐字节一致）；没有则 null。 */
  redirectUri: string | null;
  /** 登录成功后重新探测会话。 */
  onDone: () => void;
}

export function LoginPage({
  backends,
  passwordSet,
  username,
  totpRequired,
  recoveryCodesLeft,
  bootstrapError,
  redirectUri,
  onDone,
}: LoginPageProps) {
  const passwordBackend = backends.find((backend) => backend.kind === 'password') ?? null;
  const githubBackend = backends.find((backend) => backend.kind === 'github_oauth') ?? null;
  const [name, setName] = useState(username);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    translateError(bootstrapError) ?? errorFromLocation(),
  );

  const apply = (result: LoginResult): void => {
    if (result.ok && result.totpRequired === true && typeof result.ticket === 'string') {
      setTicket(result.ticket);
      setCode('');
      setError(null);
      return;
    }
    if (result.ok) {
      setError(null);
      onDone();
      return;
    }
    setError(translateError(result.error));
  };

  const submitPassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      apply(await loginWithPassword(name, password));
    } catch {
      setError(t('auth.error.unknown'));
    } finally {
      setBusy(false);
      setPassword('');
    }
  };

  const submitCode = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || ticket === null) return;
    setBusy(true);
    try {
      apply(await loginWithTotp(ticket, code));
    } catch {
      setError(t('auth.error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const secondaryButton =
    'mt-3 inline-flex w-full items-center justify-center rounded-full border border-line px-4 py-2 text-sm text-muted transition-opacity duration-150 hover:opacity-90';
  const primaryButton =
    'mt-4 inline-flex w-full items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-page transition-opacity duration-150 hover:opacity-90 pointer-coarse:min-h-touch disabled:opacity-50';

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-page px-6 text-ink">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="font-serif text-2xl font-semibold">{t('auth.login.title')}</h1>
        <p className="mt-2 text-sm text-muted">
          {passwordBackend !== null ? t('auth.login.passwordSubtitle') : t('auth.login.subtitle')}
        </p>
        {error !== null && (
          <p
            className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        {passwordBackend !== null && !passwordSet && (
          <p className="mt-4 rounded-lg border border-line bg-page px-3 py-2 text-xs text-muted">
            {t('auth.login.bootstrapHint')}
          </p>
        )}
        {passwordBackend !== null && passwordSet && ticket === null && (
          <form onSubmit={(event) => void submitPassword(event)} className="mt-6">
            <label className="block text-xs font-medium text-muted" htmlFor="login-username">
              {t('auth.login.username')}
            </label>
            <input
              id="login-username"
              name="username"
              autoComplete="username"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
            <label className="mt-3 block text-xs font-medium text-muted" htmlFor="login-password">
              {t('auth.login.password')}
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
            <button type="submit" disabled={busy} className={primaryButton}>
              {t('auth.login.submit')}
            </button>
          </form>
        )}
        {totpRequired && ticket !== null && (
          <form onSubmit={(event) => void submitCode(event)} className="mt-6">
            <label className="block text-xs font-medium text-muted" htmlFor="login-code">
              {t('auth.login.codeLabel')}
            </label>
            <input
              id="login-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-page px-3 py-2 text-sm tracking-widest text-ink outline-none focus:border-ink"
            />
            <p className="mt-2 text-xs text-faint">
              {recoveryCodesLeft > 0
                ? t('auth.login.codeHint')
                : t('auth.login.codeHintNoRecovery')}
            </p>
            <button type="submit" disabled={busy} className={primaryButton}>
              {t('auth.login.submitCode')}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setTicket(null);
                setCode('');
                setError(null);
              }}
            >
              {t('auth.login.backToPassword')}
            </button>
          </form>
        )}
        {githubBackend !== null && ticket === null && (
          <a
            href={githubBackend.startPath}
            className={
              passwordBackend !== null && passwordSet
                ? secondaryButton
                : 'mt-6 inline-flex w-full items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-page transition-opacity duration-150 hover:opacity-90 pointer-coarse:min-h-touch'
            }
          >
            {githubBackend.label}
          </a>
        )}
        {githubBackend !== null && redirectUri !== null && (
          <p className="mt-4 break-all text-xs text-faint">
            {t('auth.login.redirectHint', { uri: redirectUri })}
          </p>
        )}
        {passwordBackend !== null && passwordSet && (
          <p className="mt-4 break-all text-xs text-faint">{t('auth.login.totpHint')}</p>
        )}
      </div>
    </main>
  );
}
