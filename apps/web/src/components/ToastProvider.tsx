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
const AUTO_DISMISS_MS = 4000;
const MAX_VISIBLE = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = crypto.randomUUID();
      setItems((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, kind, message }]);
      const timer = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timers.current.set(id, timer);
    },
    [dismiss],
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
      <div className="toast-region" aria-live="polite" aria-relevant="additions">
        {items.map((item) => (
          <div
            key={item.id}
            className={`toast toast-${item.kind}`}
            role={item.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-message">{item.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭提示"
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
