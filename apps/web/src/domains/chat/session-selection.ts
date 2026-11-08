/** 单公司：会话选择只保留一个 key。 */
export const LAST_SESSION_KEY = 'vessel.chat.lastSession.v1.default';

export function lastSessionKey(): string {
  return LAST_SESSION_KEY;
}

/** 坑：隐私模式 / SSR 下访问 `window.sessionStorage` 会抛错。 */
export function browserSessionStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** 空值 / `new` / 空白视为无记录。 */
export function readLastSession(storage: Storage | null): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(lastSessionKey());
    const trimmed = value?.trim();
    if (!trimmed || trimmed === 'new') return null;
    return trimmed;
  } catch {
    return null;
  }
}

/** `new` / 空值不写：只有真实 session id 才值得恢复。 */
export function writeLastSession(storage: Storage | null, sessionId: string): void {
  if (!storage) return;
  const id = sessionId.trim();
  if (!id || id === 'new') return;
  try {
    storage.setItem(lastSessionKey(), id);
  } catch {
    // 配额满 / 隐私模式：恢复能力降级为无记录。
  }
}

export function clearLastSession(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(lastSessionKey());
  } catch {
    // 同 writeLastSession：失败不阻塞导航。
  }
}

export type SessionRestoreDecision =
  | { kind: 'keep' }
  | { kind: 'wait' }
  | { kind: 'restore'; sessionId: string }
  | { kind: 'new'; clear: boolean };

/**
 * 值：路由已有 id（真实 id 或 `new`）一律 keep —— 深链接优先。
 * 坑：会话列表未加载（`null`）时不能判记录失效，只能 wait。
 */
export function decideSessionRestore(input: {
  routeSessionId?: string;
  storedSessionId: string | null;
  knownSessionIds: readonly string[] | null;
}): SessionRestoreDecision {
  const { routeSessionId, storedSessionId, knownSessionIds } = input;
  if (routeSessionId) return { kind: 'keep' };
  if (!storedSessionId || storedSessionId === 'new') {
    return { kind: 'new', clear: storedSessionId === 'new' };
  }
  if (knownSessionIds === null) return { kind: 'wait' };
  if (knownSessionIds.includes(storedSessionId)) {
    return { kind: 'restore', sessionId: storedSessionId };
  }
  return { kind: 'new', clear: true };
}
