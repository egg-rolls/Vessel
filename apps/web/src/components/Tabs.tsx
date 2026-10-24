import { useRef } from 'react';

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
}: {
  label: string;
  tabs: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 对应 tabpanel 的 id；提供时每个 tab 生成 id + aria-controls。 */
  panelId?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  return (
    <div
      className="mt-3.5 inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-sunken p-1"
      role="tablist"
      aria-label={label}
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
          tabIndex={tab.id === value ? 0 : -1}
          className="whitespace-nowrap rounded-full bg-transparent px-3 py-1.5 text-sm text-muted transition-colors hover:bg-hover hover:text-ink aria-selected:bg-accent-soft aria-selected:text-accent-ink pointer-coarse:min-h-touch"
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
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
