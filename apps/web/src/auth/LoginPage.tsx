/**
 * 0.56：极简登录页。
 *
 * 只在「gateway 宣告了登录后端 + 当前没有会话」时渲染。一个主操作（OAuth 起步地址是
 * 普通链接，平台 RPC 挂了也能点）+ 一个错误位（由 ?error=<code> 驱动）。
 *
 * @module web/auth/LoginPage
 */

import { t } from '../i18n';

/** Error codes the gateway appends to /login?error=... */
const KNOWN_ERRORS = [
  'state_invalid',
  'code_missing',
  'secret_missing',
  'token_exchange_failed',
  'user_fetch_failed',
  'not_allowlisted',
  'public_origin_missing',
  'backend_not_configured',
] as const;

function errorMessage(code: string | null): string | null {
  if (code === null || code === '') return null;
  if ((KNOWN_ERRORS as readonly string[]).includes(code)) {
    return t(`auth.error.${code}`);
  }
  return t('auth.error.unknown');
}

function errorFromLocation(): string | null {
  try {
    return errorMessage(new URLSearchParams(window.location.search).get('error'));
  } catch {
    return null;
  }
}

export function LoginPage({
  label,
  startPath,
  redirectUri,
}: {
  label: string;
  startPath: string;
  /** Shown as a hint: the OAuth App must register exactly this redirect URI. */
  redirectUri: string | null;
}) {
  const error = errorFromLocation();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-page px-6 text-ink">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8 shadow-sm">
        <h1 className="font-serif text-2xl font-semibold">{t('auth.login.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('auth.login.subtitle')}</p>
        {error !== null && (
          <p
            className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        <a
          href={startPath}
          className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-page transition-opacity duration-150 hover:opacity-90 pointer-coarse:min-h-touch"
        >
          {label}
        </a>
        {redirectUri !== null && (
          <p className="mt-4 break-all text-xs text-faint">
            {t('auth.login.redirectHint', { uri: redirectUri })}
          </p>
        )}
      </div>
    </main>
  );
}
