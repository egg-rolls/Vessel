/**
 * 0.56：WebUI 登录闸。
 *
 * 三条规则保证「没配登录」的部署与以前完全一样：
 * - authEnabled === false ⇒ 直接渲染应用（没有登录按钮，不会锁死）；
 * - /auth/status 打不通（老 gateway / 离线）⇒ 直接渲染应用；
 * - authEnabled 且没有会话 ⇒ 只渲染登录页（唯一会被挡住的场景）。
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
import {
  AUTH_REQUIRED_EVENT,
  type AuthStatus,
  type AuthUser,
  fetchAuthStatus,
  fetchCsrfToken,
  logout as requestLogout,
} from './auth-client';
import { LoginPage } from './LoginPage';

/** loading | disabled (no backend) | unknown (probe failed) | anonymous | authenticated */
export type AuthPhase = 'loading' | 'disabled' | 'unknown' | 'anonymous' | 'authenticated';

export interface AuthContextValue {
  phase: AuthPhase;
  authEnabled: boolean;
  user: AuthUser | null;
  loginLabel: string;
  startPath: string;
  /** Redirect URI the OAuth App must register (publicOrigin + fixed path). */
  redirectUri: string | null;
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
const CALLBACK_PATH = '/auth/github/callback';

function phaseFor(status: AuthStatus): AuthPhase {
  if (!status.authEnabled) return 'disabled';
  return status.authenticated ? 'authenticated' : 'anonymous';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [phase, setPhase] = useState<AuthPhase>('loading');

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
    void refresh();
  }, [refresh]);

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
      redirectUri: status?.publicOrigin != null ? status.publicOrigin + CALLBACK_PATH : null,
      refresh,
      logout,
    }),
    [phase, status, backend, refresh, logout],
  );

  if (phase === 'anonymous') {
    return (
      <AuthContext.Provider value={value}>
        <LoginPage
          label={value.loginLabel}
          startPath={value.startPath}
          redirectUri={value.redirectUri}
        />
      </AuthContext.Provider>
    );
  }

  if (phase === 'loading') {
    // One short probe: a splash avoids flashing the app shell then swapping it out.
    return (
      <div className="flex min-h-dvh items-center justify-center bg-page" aria-busy="true">
        <span className="text-sm text-faint">…</span>
      </div>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
