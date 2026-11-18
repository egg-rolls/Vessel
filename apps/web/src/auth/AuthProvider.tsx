/**
 * 0.56：WebUI 登录闸。
 *
 * 三条规则保证「没配登录」的部署与以前完全一样：
 * - authEnabled === false ⇒ 直接渲染应用（没有登录按钮，不会锁死）；
 * - /auth/status 打不通（老 gateway / 离线）⇒ 直接渲染应用；
 * - authEnabled 且没有会话 ⇒ 只渲染登录页（唯一会被挡住的场景）。
 *
 * 0.56 P2：`#token=` / `#bootstrap=` 里的一次性引导码在这里被消费一次：
 * 成功后拿到的是**设置会话**（只能设口令 / 绑 TOTP），失败（含重放）就退回登录页
 * 并显示原因 —— 引导码本身不再当平台 token 用。
 *
 * @module web/auth/AuthProvider
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { clearPendingBootstrapCode, pendingBootstrapCode } from '../gateway/connection-initial';
import {
  AUTH_REQUIRED_EVENT,
  type AuthStatus,
  type AuthUser,
  bootstrapSession,
  fetchAuthStatus,
  fetchCsrfToken,
  logout as requestLogout,
} from './auth-client';
import { LoginPage } from './LoginPage';
import { SetupPage } from './SetupPage';

/** loading | disabled (no backend) | unknown (probe failed) | anonymous | setup | authenticated */
export type AuthPhase =
  | 'loading'
  | 'disabled'
  | 'unknown'
  | 'anonymous'
  | 'setup'
  | 'authenticated';

export interface AuthContextValue {
  phase: AuthPhase;
  authEnabled: boolean;
  user: AuthUser | null;
  loginLabel: string;
  startPath: string;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

const FALLBACK_LOGIN_LABEL = 'GitHub';

function phaseFor(status: AuthStatus): AuthPhase {
  if (!status.authEnabled) return 'disabled';
  if (!status.authenticated) return 'anonymous';
  // 引导会话只用于设口令 / 绑 TOTP：先把它走完，别让一个「半认证」状态进应用。
  return status.user?.backend === 'bootstrap' ? 'setup' : 'authenticated';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  /**
   * 先在**同一次初始化**里试着用掉 `#token=` 引导码，再探测会话。
   *
   * 顺序很重要：引导码来自 URL hash，刷新页面就没了，所以必须在第一次探测前后
   * 立刻消费；失败要留下原因给登录页（例如 `bootstrap_replayed`）。
   */
  const consumeBootstrap = useCallback(async () => {
    const code = pendingBootstrapCode();
    if (code === '') return;
    clearPendingBootstrapCode();
    try {
      const result = await bootstrapSession(code);
      if (!result.ok) {
        setBootstrapError(result.error ?? 'bootstrap_invalid');
      }
    } catch {
      setBootstrapError('bootstrap_invalid');
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchAuthStatus();
      // Reloaded the tab after a gateway restart? The plain CSRF token lives in
      // memory only, so trade a stale one for a fresh one before the shell needs it.
      if (next.authEnabled && next.authenticated && next.csrfToken === null) {
        await fetchCsrfToken().catch(() => null);
      }
      setStatus(next);
      setPhase(phaseFor(next));
    } catch {
      // Never lock the UI on a failed probe: behave like a build without login.
      setStatus(null);
      setPhase('unknown');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await consumeBootstrap();
      if (cancelled) return;
      await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [consumeBootstrap, refresh]);

  useEffect(() => {
    const onRequired = () => {
      void refresh();
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onRequired);
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await requestLogout();
    } catch {
      // Even a failed request may have cleared the cookie; re-probe below.
    }
    await refresh();
  }, [refresh]);

  const backend = status?.loginBackends[0];
  const value = useMemo<AuthContextValue>(
    () => ({
      phase,
      authEnabled: status?.authEnabled === true,
      user: status?.user ?? null,
      loginLabel: backend?.label ?? FALLBACK_LOGIN_LABEL,
      startPath: backend?.startPath ?? '/auth/github/start',
      refresh,
      logout,
    }),
    [phase, status, backend, refresh, logout],
  );

  if (phase === 'anonymous') {
    return (
      <AuthContext.Provider value={value}>
        <LoginPage
          backends={status?.loginBackends ?? []}
          passwordSet={status?.passwordSet !== false}
          username={status?.username ?? ''}
          totpRequired={status?.totpRequired === true}
          recoveryCodesLeft={status?.recoveryCodesLeft ?? 0}
          bootstrapError={bootstrapError}
          onDone={() => {
            setBootstrapError(null);
            void refresh();
          }}
        />
      </AuthContext.Provider>
    );
  }

  if (phase === 'setup') {
    return (
      <AuthContext.Provider value={value}>
        <SetupPage
          username={status?.user?.username ?? status?.username ?? 'admin'}
          passwordSet={status?.passwordSet === true}
          onDone={() => {
            void refresh();
          }}
        />
      </AuthContext.Provider>
    );
  }

  if (phase === 'loading') {
    // One short probe: a splash avoids flashing the app shell then swapping it out.
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg" aria-busy="true">
        <span className="text-sm text-faint">…</span>
      </div>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
