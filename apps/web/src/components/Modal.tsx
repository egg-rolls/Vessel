import { type ReactNode, useEffect, useRef } from 'react';
import { IconButton } from './Tooltip';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 弹窗可访问性：初始焦点、Tab 焦点圈、Esc 关闭、关闭后恢复触发元素焦点。
 * 返回容器 ref（挂到 dialog 元素上）。
 */
export function useModalA11y(onClose: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = containerRef.current;
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
    };
  }, []);

  return containerRef;
}

export function ModalShell({
  label,
  describedBy,
  onClose,
  closeOnBackdrop = true,
  closeLabel,
  className = '',
  children,
}: {
  label: string;
  describedBy?: string;
  onClose: () => void;
  closeOnBackdrop?: boolean;
  /** 提供时在右上角渲染关闭按钮；不传则保持原有布局。 */
  closeLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  const dialogRef = useModalA11y(onClose);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop mousedown closes the modal
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
      >
        {children}
        {closeLabel ? (
          <IconButton className="modal-close" label={closeLabel} onClick={onClose}>
            ×
          </IconButton>
        ) : null}
      </div>
    </div>
  );
}
