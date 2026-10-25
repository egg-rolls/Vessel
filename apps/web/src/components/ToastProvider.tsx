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
import { t } from '../i18n';

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
/** 成功 / 信息 4s，错误 5s；都在 3–5s 区间内。 */
const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 5000,
};
const MAX_VISIBLE = 3;
const TOAST_GLYPH: Record<ToastKind, string> = {
  success: '✓',
  error: '✗',
  info: 'i',
};

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

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-relevant="additions">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast toast-${item.kind}`}
            role={item.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-icon" aria-hidden="true">
              {TOAST_GLYPH[item.kind]}
            </span>
            <span className="toast-message">{item.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label={t('common.closeNotice')}
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
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
