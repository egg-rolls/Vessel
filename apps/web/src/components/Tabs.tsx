import { useRef } from 'react';
import { cn } from './ui/cn';

export interface TabOption<T extends string> {
  id: T;
  label: string;
}

/** 域内一级 tab：role=tablist + 方向键移动 + aria-selected。 */
export function SegmentedTabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  panelId,
  disabled = false,
}: {
  label: string;
  tabs: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 对应 tabpanel 的 id；提供时每个 tab 生成 id + aria-controls。 */
  panelId?: string;
  /** 整组只读：按钮 disabled，键盘与指针都不触发切换（用于保存中 / 不可配置）。 */
  disabled?: boolean;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  return (
    <div
      className={cn(
        'mt-3.5 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-sunken p-1',
        disabled && 'opacity-45',
      )}
      role="tablist"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(element) => {
            if (element) refs.current.set(tab.id, element);
            else refs.current.delete(tab.id);
          }}
          type="button"
          role="tab"
          id={panelId ? `${panelId}-tab-${tab.id}` : undefined}
          aria-controls={panelId}
          aria-selected={tab.id === value}
          disabled={disabled}
          tabIndex={disabled ? -1 : tab.id === value ? 0 : -1}
          className="whitespace-nowrap rounded-full bg-transparent px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-ink aria-selected:bg-accent-soft aria-selected:text-accent-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted pointer-coarse:min-h-touch"
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            if (disabled) return;
            const index = tabs.findIndex((item) => item.id === tab.id);
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(index + delta + tabs.length) % tabs.length];
            if (next) {
              onChange(next.id);
              refs.current.get(next.id)?.focus();
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
