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
}: {
  label: string;
  tabs: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(element) => {
            if (element) refs.current.set(tab.id, element);
            else refs.current.delete(tab.id);
          }}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          className={`segment ${tab.id === value ? 'active' : ''}`.trim()}
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
