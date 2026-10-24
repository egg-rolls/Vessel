import { cn } from './cn';

/**
 * 列表 / 过滤栏共用搜索框。
 * `search-input` 只作为布局 hook 保留：`.filter-bar` / `.net-toolbar` 等未迁移容器
 * 仍用它控制 flex 宽度；视觉全部由 Tailwind 负责。
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <input
      className={cn(
        'search-input h-control w-full min-w-0 rounded-sm border-0 bg-sunken px-3 text-sm text-ink shadow-elev-inset transition-colors placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        className,
      )}
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
    />
  );
}
