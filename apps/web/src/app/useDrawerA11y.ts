import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 抽屉可访问性：Esc 关闭、Tab 焦点圈、打开时锁 body 滚动、关闭后归还焦点
 * （`returnFocusId` 优先，否则回到打开前的 `document.activeElement`）。
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
  /**
   * 关闭后把焦点还给某个固定 id 的触发元素。可选：入口是 ActionMenu 这类
   * 可收起菜单（节点随选择卸载）时给不出稳定 id，此时回退到打开前记录的
   * `document.activeElement`；若它已从 DOM 移除（菜单收起），才落到 body。
   */
  returnFocusId?: string;
}): RefObject<HTMLElement | null> {
  const containerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  /** 打开前持有焦点的元素：没有 `returnFocusId` 时用它兜底归还焦点。 */
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) {
      wasOpen.current = open;
      return undefined;
    }
    if (open) {
      // 先记录再抢焦点：Esc / 遮罩 / × 关闭后键盘用户要能回到原来的位置。
      const active = document.activeElement;
      previousFocus.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
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
      const byId = returnFocusId === undefined ? null : document.getElementById(returnFocusId);
      const focusTarget = byId ?? previousFocus.current;
      // 记录的元素可能已随菜单卸载：仍在文档里才聚焦，否则焦点自然回到 body。
      if (focusTarget?.isConnected) focusTarget.focus();
      previousFocus.current = null;
    }
    // `noImplicitReturns`：与上面的 cleanup 分支显式对齐，React 接受 undefined。
    return undefined;
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
