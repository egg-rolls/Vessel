/**
 * 账号浮层的几何与键盘行为（非模态 popover）。
 *
 * 与 `components/Modal` 的 `useModalA11y` 的差别只有一条但很关键：**不锁 body 滚动**——
 * 头部浮层不是模态，锁滚动会让「点外面关掉」变成一次滚不动的手感事故。
 * 所以这里独立实现，复用的是同一套判据（初始焦点 / Tab 圆圈 / Esc / 关掉后焦点回触发器）。
 *
 * 定位：portal 到 body 后 `position: fixed`，右对齐触发器、贴它下沿 6px；
 * 视口夹取 8px；下方空间不足且上方更宽裕时翻到上方。
 *
 * @module web/domains/auth/useAccountPopover
 */

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 与 `components/Modal` 保持同一份可聚焦判据（那边没导出，这里按同一规则重写）。 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const VIEWPORT_MARGIN = 8;
const GAP = 6;
/** 下方可用高度小于这个数、且上方更宽裕时，翻到触发器上方。 */
const MIN_BELOW = 240;

export interface PopoverPosition {
  right: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export interface AccountPopover {
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  /** `null` = 还没量出来（首帧不渲染面板，避免闪一下再归位）。 */
  position: PopoverPosition | null;
}

export function useAccountPopover({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): AccountPopover {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - GAP - VIEWPORT_MARGIN;
      const placeAbove = spaceBelow < MIN_BELOW && spaceAbove > spaceBelow;
      const available = Math.max(120, placeAbove ? spaceAbove : spaceBelow);
      setPosition({
        right: Math.max(VIEWPORT_MARGIN, viewportWidth - rect.right),
        ...(placeAbove ? { bottom: viewportHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
        maxHeight: Math.min(available, viewportHeight - VIEWPORT_MARGIN * 2),
      });
    };
    update();
    window.setTimeout(update, 0);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  const focusables = useCallback(
    () =>
      panelRef.current
        ? [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (element) => element.offsetParent !== null || element === document.activeElement,
          )
        : [],
    [],
  );

  /**
   * 面板是「量完位置才渲染」的（`position === null` 时 DOM 里还没有它），
   * 所以焦点 / 键盘的挂载点要等它真的进 DOM 之后 —— 否则打开浮层焦点还在触发器上，
   * 键盘用户得先按一次 Tab 才知道浮层开了。
   */
  const ready = position !== null;

  useEffect(() => {
    if (!open || !ready) return;
    // 打开即把焦点移进面板。
    focusables()[0]?.focus();

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeRef.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 只关这一层：`stopPropagation` 让下层的 Esc 处理器（命令面板 / 抽屉）不接管。
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.key === 'Tab') {
        // 焦点陷阱：面板是最后一片 UI，Tab 出去就「掉到」背后的页面上。
        if (first === undefined || last === undefined) return;
        if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const index = items.indexOf(active as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = index === -1 ? 0 : (index + step + items.length) % items.length;
      items[next]?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      // 关掉后焦点回到触发器：否则它会留在刚被移除的节点上，键盘焦点丢失。
      triggerRef.current?.focus();
    };
  }, [open, ready, focusables]);

  return { triggerRef, panelRef, position };
}
