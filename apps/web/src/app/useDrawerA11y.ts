import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 抽屉可访问性：Esc 关闭、Tab 焦点圈、打开时锁 body 滚动、关闭后焦点回到触发元素。
 * `enabled=false`（例如桌面端抽屉变为常驻列）时不介入。
 */
export function useDrawerA11y({
  open,
  onClose,
  enabled = true,
  returnFocusId,
}: {
  open: boolean;
  onClose: () => void;
  enabled?: boolean;
  returnFocusId: string;
}): RefObject<HTMLElement | null> {
  const containerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) {
      wasOpen.current = open;
      return;
    }
    if (open) {
      const first = containerRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
      wasOpen.current = true;
      const previous = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previous;
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      document.getElementById(returnFocusId)?.focus();
    }
  }, [enabled, open, returnFocusId]);

  useEffect(() => {
    if (!enabled || !open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, open]);

  return containerRef;
}
