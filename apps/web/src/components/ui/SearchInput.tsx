import { cn } from './cn';

/**
 * 列表 / 过滤栏共用搜索框。视觉与布局全部由 utilities 负责；
 * flex 宽度（`grow basis-60 max-w-search`）由调用方通过 `className` 追加。
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
        'h-control w-full min-w-0 rounded-sm border-0 bg-sunken px-3 text-sm text-ink shadow-elev-inset transition-colors placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
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
