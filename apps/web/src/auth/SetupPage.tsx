/**
 * 0.56 P2：一次性引导码换来的「设置会话」页面。
 *
 * 这个会话只做两件事（服务端也只放行这两件事）：设首次口令、绑 TOTP。
 * 完成后照常进应用 —— 引导码本身在同一次请求里就已经作废了。
 *
 * TOTP 的 secret 与恢复码只在这里出现一次：不写日志、不进 sessionStorage，
 * 用户必须当场抄走（页面明确要求「现在存下来」）。
 *
 * @module web/auth/SetupPage
 */

import { type FormEvent, useState } from 'react';
import { t } from '../i18n';
import { enrollTotp, finishSetup, setInitialPassword } from './auth-client';

export interface SetupPageProps {
  /** 登录名（口令后端的单用户）。 */
  username: string;
  /** 引导会话是否已经有口令（replay 后重进 / 刷新）。 */
  passwordSet: boolean;
  /** 完成设置后重新探测会话。 */
  onDone: () => void;
}

type Step = 'password' | 'totp' | 'done';

export function SetupPage({ username, passwordSet, onDone }: SetupPageProps) {
  const [step, setStep] = useState<Step>(passwordSet ? 'totp' : 'password');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError(t('auth.setup.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      const result = await setInitialPassword(password);
      if (!result.ok) {
        setError(t(`auth.error.${result.error ?? 'unknown'}`));
        return;
      }
      setError(null);
      setPassword('');
      setConfirm('');
      setStep('totp');
    } catch {
      setError(t('auth.error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 收尾：把设置会话换成正常口令会话（服务端轮换 sid）。
   * 不做这一步，浏览器会永远停在设置页 —— 设置会话不能进应用是刻意的。
   */
  const complete = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await finishSetup();
      if (!result.ok) {
        setError(t(`auth.error.${result.error ?? 'unknown'}`));
        return;
      }
      setError(null);
      onDone();
    } catch {
      setError(t('auth.error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const startEnroll = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await enrollTotp();
      if (!result.ok) {
        setError(t(`auth.error.${result.error ?? 'unknown'}`));
        return;
      }
      setError(null);
      setOtpauthUri(result.otpauthUri ?? null);
      setSecret(result.secret ?? null);
      setRecoveryCodes(result.recoveryCodes ?? []);
      setStep('done');
    } catch {
      setError(t('auth.error.unknown'));
    } finally {
      setBusy(false);
    }
  };

  const primaryButton =
    'mt-4 inline-flex w-full items-center justify-center rounded-full bg-ink px-4 py-2.5 text-sm font-medium text-surface transition-opacity duration-150 hover:opacity-90 pointer-coarse:min-h-touch disabled:opacity-50';
  const secondaryButton =
    'mt-3 inline-flex w-full items-center justify-center rounded-full bg-transparent border border-line px-4 py-2 text-sm text-muted transition-opacity duration-150 hover:opacity-90 disabled:opacity-50';

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-6 text-ink">
      <div className="w-full max-w-md rounded-xl bg-surface p-8 shadow-elev-1 forced-colors:border">
        <h1 className="font-serif text-2xl font-semibold">{t('auth.setup.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('auth.setup.subtitle', { user: username })}</p>
        {error !== null && (
          <p
            className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}

        {step === 'password' && (
          <form onSubmit={(event) => void submitPassword(event)} className="mt-6">
            <label className="block text-xs font-medium text-muted" htmlFor="setup-password">
              {t('auth.setup.password')}
            </label>
            <input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
            <label className="mt-3 block text-xs font-medium text-muted" htmlFor="setup-confirm">
              {t('auth.setup.passwordConfirm')}
            </label>
            <input
              id="setup-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm text-ink outline-none focus:border-ink"
            />
            <p className="mt-2 text-xs text-faint">{t('auth.setup.passwordHint')}</p>
            <button type="submit" disabled={busy} className={primaryButton}>
              {t('auth.setup.savePassword')}
            </button>
          </form>
        )}

        {step === 'totp' && (
          <div className="mt-6">
            <p className="text-sm text-muted">{t('auth.setup.totpIntro')}</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void startEnroll()}
              className={primaryButton}
            >
              {t('auth.setup.enrollTotp')}
            </button>
            <button
              type="button"
              disabled={busy}
              className={secondaryButton}
              onClick={() => void complete()}
            >
              {t('auth.setup.skipTotp')}
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="mt-6">
            <p className="text-sm text-muted">{t('auth.setup.totpSecret')}</p>
            {otpauthUri !== null && (
              <p className="mt-2 break-all rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-ink">
                {otpauthUri}
              </p>
            )}
            {secret !== null && (
              <p className="mt-2 break-all text-xs text-faint">
                {t('auth.setup.secretFallback', { secret })}
              </p>
            )}
            <p className="mt-4 text-sm font-medium text-danger">{t('auth.setup.recoveryTitle')}</p>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-xs text-ink">
              {recoveryCodes.map((entry) => (
                <li
                  key={entry}
                  className="rounded border border-line bg-sunken px-2 py-1 font-mono"
                >
                  {entry}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-faint">{t('auth.setup.recoveryHint')}</p>
            <button
              type="button"
              disabled={busy}
              className={primaryButton}
              onClick={() => void complete()}
            >
              {t('auth.setup.finish')}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
