import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
}

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** 只读 feed：AppShell 用它把 toast 交给 AppBar 中心的 MessageBar 渲染。 */
export interface ToastFeed {
  items: ToastItem[];
  dismiss: (id: string) => void;
}

const ToastFeedContext = createContext<ToastFeed | null>(null);

/** 成功 / 信息 4s，错误 5s；都在 3–5s 区间内。 */
const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 5000,
};
const MAX_VISIBLE = 3;

function toastKey(kind: ToastKind, message: string): string {
  return `${kind}\u0000${message}`;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());
  const liveIds = useRef(new Map<string, string>());
  const itemsRef = useRef<ToastItem[]>([]);

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      const removed = itemsRef.current.find((item) => item.id === id);
      if (removed) liveIds.current.delete(toastKey(removed.kind, removed.message));
      itemsRef.current = itemsRef.current.filter((item) => item.id !== id);
      setItems(itemsRef.current);
    },
    [clearTimer],
  );

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const key = toastKey(kind, message);
      // 相同 kind + 文本只保留一条：重置它的计时，不重复插入。
      const existingId = liveIds.current.get(key);
      const id = existingId ?? crypto.randomUUID();
      clearTimer(id);

      let next = itemsRef.current;
      if (existingId === undefined) {
        liveIds.current.set(key, id);
        next = [...next, { id, kind, message }];
      }
      if (next.length > MAX_VISIBLE) {
        const evicted = next.slice(0, next.length - MAX_VISIBLE);
        next = next.slice(-MAX_VISIBLE);
        for (const item of evicted) {
          clearTimer(item.id);
          liveIds.current.delete(toastKey(item.kind, item.message));
        }
      }
      itemsRef.current = next;
      setItems(next);
      const timer = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS[kind]);
      timers.current.set(id, timer);
    },
    [clearTimer, dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
      dismiss,
    }),
    [push, dismiss],
  );

  const feed = useMemo<ToastFeed>(() => ({ items, dismiss }), [items, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      <ToastFeedContext.Provider value={feed}>{children}</ToastFeedContext.Provider>
    </ToastContext.Provider>
  );
}

/** 只读 toast 列表；渲染统一交给 AppBar 中心的 MessageBar。 */
export function useToastFeed(): ToastFeed {
  const value = useContext(ToastFeedContext);
  if (!value) throw new Error('useToastFeed must be used inside <ToastProvider>');
  return value;
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}

/**
 * 可选 toast：没有 Provider（SSR / 组件级静态渲染测试）时返回 null。
 * 只用于“提示不是关键路径”的叶子组件，避免为测试包一层 Provider。
 */
export function useOptionalToast(): ToastApi | null {
  return useContext(ToastContext);
}
