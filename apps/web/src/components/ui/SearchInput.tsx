/** 列表 / 过滤栏共用搜索框：统一 input class、search 语义与 no-spellcheck。 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <input
      className={`input search-input ${className}`.trim()}
      type="search"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
    />
  );
}
