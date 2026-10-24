import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Tooltip';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * body 滚动锁用引用计数：嵌套弹窗（例如抽屉里的确认框）关闭内层时不能提前解锁。
 * overflow 用 `hidden`（不是 `clip`），保留桌面端滚动条宽度，避免布局跳动。
 */
let scrollLockCount = 0;
let previousBodyOverflow = '';

function lockBodyScroll(): void {
  if (typeof document === 'undefined') return;
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount += 1;
}

function unlockBodyScroll(): void {
  if (typeof document === 'undefined' || scrollLockCount === 0) return;
  scrollLockCount -= 1;
  if (scrollLockCount === 0) document.body.style.overflow = previousBodyOverflow;
}

/**
 * 弹窗可访问性：初始焦点、Tab 焦点圈、Esc 关闭、关闭后恢复触发元素焦点。
 * 打开期间锁 body 滚动；返回容器 ref（挂到 dialog 元素上）。
 */
export function useModalA11y(onClose: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = containerRef.current;
    lockBodyScroll();
    const focusables = () =>
      root
        ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (element) => element.offsetParent !== null || element === document.activeElement,
          )
        : [];

    const preferred = root?.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? focusables()[0])?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
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

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
      unlockBodyScroll();
    };
  }, []);

  return containerRef;
}

export type ModalSize = 'sm' | 'md' | 'lg';

export function ModalShell({
  label,
  describedBy,
  onClose,
  closeOnBackdrop = true,
  closeLabel,
  size = 'md',
  className = '',
  children,
}: {
  label: string;
  describedBy?: string;
  onClose: () => void;
  closeOnBackdrop?: boolean;
  /** 提供时在右上角渲染关闭按钮；不传则保持原有布局。 */
  closeLabel?: string;
  /** 语义宽度：sm 420 / md 620 / lg 760（tokens.css）。 */
  size?: ModalSize;
  className?: string;
  children: ReactNode;
}) {
  const dialogRef = useModalA11y(onClose);
  // portal 到 body：抽屉 / 网格 / 任意 transform 祖先都不能成为 fixed 的包含块，
  // 也不会用 overflow 裁掉遮罩或对话框。
  const dialog = (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop mousedown closes the modal
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal-${size} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
      >
        <div className="modal-body-scroll">{children}</div>
        {closeLabel ? (
          <IconButton className="modal-close" label={closeLabel} onClick={onClose}>
            ×
          </IconButton>
        ) : null}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}
