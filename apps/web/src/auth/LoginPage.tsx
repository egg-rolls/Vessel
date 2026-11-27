/**
 * 0.56 P2：登录页（口令 + TOTP / 恢复码 / 任意 OAuth 后端）。
 *
 * 三种形态由 `/auth/status` 的事实决定：
 * - 配了口令后端且**已设口令** ⇒ 用户名 + 口令表单；需要第二因子时切到验证码输入；
 * - 配了口令后端但**还没设口令** ⇒ 只提示「用启动日志里的一次性引导码打开」；
 * - 任意 OAuth 后端（github / microsoft / gitee 的任意组合）⇒ 各一个品牌按钮
 *   （整页跳转；平台 RPC 挂了也能走）。没有口令后端时第一个是主按钮，其余是普通按钮。
 *
 * 错误位由本地状态驱动（登录接口的稳定错误码），并额外显示**错误码本身**：
 * 部署排障时 `user_fetch_failed` / `token_exchange_failed` 的区别就是「网关出网
 * 不通」与「GitHub 拒绝」的分界线，不该只能去翻服务端日志。
 *
 * 样式只用 L2：`Button` / `Field` / `Input` / `Icon` 与 L1 token（`bg-bg` /
 * `border-line` / `shadow-elev-1` / `text-title` …）。登录页是独立的全屏页，
 * 不套 `PageScaffold`，标题仍照 DESIGN.md §1 的排版（`text-title`）。
 *
 * @module web/auth/LoginPage
 */

import { type FormEvent, useState } from 'react';
import { Button, Field, Icon, type IconName, Input } from '../components/ui';
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

interface AuthErrorDetail {
  code: string;
  message: string;
}

/**
 * OAuth 后端的品牌图形（按服务端给的 `id` 取）。
 *
 * 未知 provider 只是没有图标：标签与 `startPath` 都来自服务端，前端不硬编码 provider 清单。
 */
const OAUTH_ICONS: Partial<Record<string, IconName>> = {
  github: 'github',
  microsoft: 'microsoft',
  gitee: 'gitee',
};

/** 稳定错误码 → 文案 + 原始码（码要留在 UI 上，排障时是唯一的分界线）。 */
function errorDetail(code: string | null | undefined): AuthErrorDetail | null {
  if (code === null || code === undefined || code === '') return null;
  if ((KNOWN_ERRORS as readonly string[]).includes(code)) {
    return { code, message: t(`auth.error.${code}`) };
  }
  if ((KNOWN_LOGIN_ERRORS as readonly string[]).includes(code)) {
    return { code, message: t(`auth.error.${code}`) };
  }
  return { code, message: t('auth.error.unknown') };
}

function errorFromLocation(): AuthErrorDetail | null {
  try {
    return errorDetail(new URLSearchParams(window.location.search).get('error'));
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
  onDone,
}: LoginPageProps) {
  const passwordBackend = backends.find((backend) => backend.kind === 'password') ?? null;
  const oauthBackends = backends.filter((backend) => backend.kind !== 'password');
  const [name, setName] = useState(username);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorDetail | null>(
    errorDetail(bootstrapError) ?? errorFromLocation(),
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
    setError(errorDetail(result.error));
  };

  const submitPassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      apply(await loginWithPassword(name, password));
    } catch {
      setError({ code: 'network', message: t('auth.error.unknown') });
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
      setError({ code: 'network', message: t('auth.error.unknown') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-6 text-ink">
      <div className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-elev-1 forced-colors:border">
        <h1 className="text-center font-serif text-title font-semibold leading-tight tracking-wide text-ink">
          {t('auth.login.title')}
        </h1>
        {passwordBackend !== null && (
          <p className="mt-2.5 max-w-prose text-md leading-normal text-muted">
            {t('auth.login.passwordSubtitle')}
          </p>
        )}
        {error !== null && (
          <div
            className="mt-4 rounded-sm border border-danger/40 bg-danger-soft px-3 py-2"
            role="alert"
          >
            <p className="text-sm text-danger">{error.message}</p>
            <p className="mt-1 break-all font-mono text-2xs text-danger/80">{error.code}</p>
          </div>
        )}
        {passwordBackend !== null && !passwordSet && (
          <p className="mt-4 rounded-sm border border-line bg-sunken px-3 py-2 text-xs text-muted">
            {t('auth.login.bootstrapHint')}
          </p>
        )}
        {passwordBackend !== null && passwordSet && ticket === null && (
          <form
            onSubmit={(event) => void submitPassword(event)}
            className="mt-5 flex flex-col gap-3"
          >
            <Field label={t('auth.login.username')} htmlFor="login-username">
              <Input
                id="login-username"
                name="username"
                autoComplete="username"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={t('auth.login.password')} htmlFor="login-password">
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full">
              {t('auth.login.submit')}
            </Button>
          </form>
        )}
        {totpRequired && ticket !== null && (
          <form onSubmit={(event) => void submitCode(event)} className="mt-5 flex flex-col gap-3">
            <Field
              label={t('auth.login.codeLabel')}
              htmlFor="login-code"
              hint={
                recoveryCodesLeft > 0
                  ? t('auth.login.codeHint')
                  : t('auth.login.codeHintNoRecovery')
              }
            >
              <Input
                id="login-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono tracking-widest"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full">
              {t('auth.login.submitCode')}
            </Button>
            <Button
              type="button"
              variant="plain"
              className="w-full"
              onClick={() => {
                setTicket(null);
                setCode('');
                setError(null);
              }}
            >
              {t('auth.login.backToPassword')}
            </Button>
          </form>
        )}
        {oauthBackends.length > 0 && ticket === null && (
          <div className={`${passwordBackend === null ? 'mt-5' : 'mt-3'} flex flex-col gap-3`}>
            {oauthBackends.map((backend, index) => {
              const icon = OAUTH_ICONS[backend.id];
              return (
                <Button
                  key={backend.id}
                  type="button"
                  variant={passwordBackend === null && index === 0 ? 'primary' : 'plain'}
                  className="w-full"
                  onClick={() => {
                    // 整页跳转：OAuth 的 state 由服务端签发，不经前端存储。
                    window.location.assign(backend.startPath);
                  }}
                >
                  {icon !== undefined && <Icon name={icon} size={16} />}
                  {backend.label}
                </Button>
              );
            })}
          </div>
        )}
        {passwordBackend !== null && passwordSet && (
          <p className="mt-4 break-all text-xs text-faint">{t('auth.login.totpHint')}</p>
        )}
      </div>
    </main>
  );
}
