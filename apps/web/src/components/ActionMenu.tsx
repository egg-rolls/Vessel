import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n';
import { iconButtonClass, Tooltip } from './Tooltip';
import { cn } from './ui';

export interface ActionMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * 行级 `⋯` 菜单：aria-haspopup/expanded、方向键移动、Enter 执行、
 * Esc/点击外部关闭并把焦点还给触发按钮。
 */
export function ActionMenu({
  label = t('common.moreActions'),
  items,
  disabled = false,
  className,
}: {
  label?: string;
  items: readonly ActionMenuItem[];
  disabled?: boolean;
  /** 追加到触发器容器的布局 / 显隐类（如列表 hover 显隐）。 */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const buttons = () => [
      ...(menu?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
    ];
    buttons()[0]?.focus();

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menu?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      const list = buttons();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        list[(index + 1 + list.length) % list.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        list[list.length - 1]?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span className={cn('relative inline-flex flex-none', className)}>
      <Tooltip label={label}>
        <button
          ref={buttonRef}
          type="button"
          className={iconButtonClass}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </Tooltip>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="absolute right-0 top-full z-20 mt-1 flex min-w-40 flex-col rounded-lg bg-raised p-1 shadow-elev-3"
          role="menu"
          aria-label={label}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                'rounded-md bg-transparent px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-hover disabled:opacity-45',
                item.danger && 'text-danger hover:bg-danger-soft',
              )}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
