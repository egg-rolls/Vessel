/**
 * 表头过滤弹层（可复用）。
 *
 * 规格（后续筛选器照此实现，避免各页漂移）：
 * - 触发器：`aria-haspopup="listbox"` + `aria-expanded`，带 label 与 chevron，
 *   负外边距（`-mx-2`）+ `px-2 py-1` 让它在 `<th>` 内与表头文字对齐，焦点态可见。
 * - 面板：`createPortal` 到 `body`，`position: fixed`；left/top 夹在视口 8px 边距内，
 *   下方空间不足时翻到触发器上方。
 * - 尺寸上限：宽 `min(30vw, calc(100vw - 1rem))`（绝不超过 30vw），
 *   高 `min(30vh, calc(100vh - 1rem))`；选项区 `overflow-y: auto`。
 * - 选项 > `searchThreshold`（默认 8）时，面板顶部出现 sticky 搜索框
 *   （`position: sticky; top: 0` + `bg-raised` + 底部分隔线），输入即过滤。
 * - 键盘：ArrowUp / ArrowDown / Home / End / Enter / Escape；点击外部关闭；
 *   关闭后焦点回到触发器；选中项使用既有 accent-soft / accent-ink token。
 *
 * 只使用既有颜色 token（bg-raised / border-line / text-ink / text-faint /
 * bg-hover / accent-soft / accent-ink / shadow-elev-3），不新增颜色或断点。
 */

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { SearchInput } from './SearchInput';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterPopoverProps {
  /** 表头标题；也是「全部」选项与触发器默认文案。 */
  label: string;
  /** 「全部」选项的值（runs 状态用 `all`，agent 用空串）。 */
  allValue: string;
  value: string;
  options: readonly FilterOption[];
  onChange: (value: string) => void;
  /** 选项数量超过该值时显示搜索框；默认 8。 */
  searchThreshold?: number;
  searchPlaceholder?: string;
  searchLabel?: string;
  className?: string;
}

interface PanelPosition {
  left: number;
  top?: number;
  bottom?: number;
  maxWidth: number;
  maxHeight: number;
  minWidth: number;
}

const VIEWPORT_MARGIN = 8;

export function FilterPopover({
  label,
  allValue,
  value,
  options,
  onChange,
  searchThreshold = 8,
  searchPlaceholder,
  searchLabel,
  className,
}: FilterPopoverProps) {
  const entries = useMemo<FilterOption[]>(
    () => [{ value: allValue, label }, ...options],
    [allValue, label, options],
  );
  const searchable = entries.length > searchThreshold + 1;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!searchable || needle === '') return entries;
    const allEntry = entries[0];
    const rest = entries.slice(1).filter((entry) => entry.label.toLowerCase().includes(needle));
    return allEntry ? [allEntry, ...rest] : rest;
  }, [entries, searchable, needle]);

  const selected = entries.find((entry) => entry.value === value);
  const activeIndex = visible.length === 0 ? -1 : Math.min(Math.max(active, 0), visible.length - 1);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActive(0);
    setQuery('');
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openList = useCallback(() => {
    const index = entries.findIndex((entry) => entry.value === value);
    setQuery('');
    setActive(index >= 0 ? index : 0);
    setOpen(true);
  }, [entries, value]);

  const pick = useCallback(
    (entry: FilterOption) => {
      if (entry.value !== value) onChange(entry.value);
      close(true);
    },
    [close, onChange, value],
  );

  // 触发器保持焦点（无搜索时）；有搜索时把焦点交给搜索框。
  useEffect(() => {
    if (!open) return;
    if (searchable) inputRef.current?.focus();
    else triggerRef.current?.focus();
  }, [open, searchable]);

  // 定位：固定定位 + 8px 视口夹取；下方不够时翻到上方。
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
      const maxWidth = Math.min(viewportWidth * 0.3, viewportWidth - VIEWPORT_MARGIN * 2);
      const heightCap = Math.min(viewportHeight * 0.3, viewportHeight - VIEWPORT_MARGIN * 2);
      const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN - 4;
      const spaceAbove = rect.top - VIEWPORT_MARGIN - 4;
      const placeAbove = spaceBelow < heightCap && spaceAbove > spaceBelow;
      const available = Math.max(64, placeAbove ? spaceAbove : spaceBelow);
      const maxHeight = Math.min(heightCap, available);
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, viewportWidth - maxWidth - VIEWPORT_MARGIN),
      );
      setPosition({
        left,
        ...(placeAbove
          ? { bottom: Math.max(VIEWPORT_MARGIN, viewportHeight - rect.top + 4) }
          : { top: Math.min(rect.bottom + 4, viewportHeight - VIEWPORT_MARGIN - 4) }),
        maxWidth,
        maxHeight,
        minWidth: Math.min(rect.width, maxWidth),
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // 点击外部关闭。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, close]);

  // 当前高亮项滚入视野。
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openList();
      }
      return;
    }
    const count = visible.length;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (count === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (Math.min(Math.max(index, 0), count - 1) + 1) % count);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (Math.min(Math.max(index, 0), count - 1) - 1 + count) % count);
      return;
    }
    // 搜索框里的 Home/End 留给光标；列表模式下才跳选项。
    const fromSearch = event.target instanceof HTMLInputElement;
    if (event.key === 'Home' && !fromSearch) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End' && !fromSearch) {
      event.preventDefault();
      setActive(count - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const entry = visible[Math.min(Math.max(active, 0), count - 1)];
      if (entry) pick(entry);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          '-mx-2 inline-flex max-w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-xs font-mono tracking-wide text-faint uppercase transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          className,
        )}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={label}
        onClick={() => {
          if (open) close(true);
          else openList();
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="truncate">{selected ? selected.label : label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className={cn('size-3 flex-none text-faint transition-transform', open && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      {open && position !== null
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={label}
              className="fixed z-tooltip flex flex-col overflow-hidden rounded-md border border-line bg-raised shadow-elev-3"
              style={{
                left: position.left,
                top: position.top,
                bottom: position.bottom,
                maxWidth: position.maxWidth,
                maxHeight: position.maxHeight,
                minWidth: position.minWidth,
              }}
              onKeyDown={handleKeyDown}
            >
              {searchable && (
                <div className="sticky top-0 z-1 border-b border-line bg-raised p-1.5">
                  <SearchInput
                    ref={inputRef}
                    value={query}
                    onChange={(next) => {
                      setQuery(next);
                      setActive(0);
                    }}
                    placeholder={searchPlaceholder ?? label}
                    ariaLabel={searchLabel ?? label}
                  />
                </div>
              )}
              <div
                id={listId}
                role="listbox"
                aria-label={label}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
              >
                {visible.map((entry, index) => {
                  const isSelected = entry.value === value;
                  return (
                    // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant 模式下选项不接收焦点
                    // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘交互在触发器 / 面板上（listbox 模式）
                    <div
                      key={`${entry.value}:${entry.label}`}
                      ref={(node) => {
                        optionRefs.current[index] = node;
                      }}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      className={cn(
                        'flex min-h-8 cursor-pointer items-center rounded-sm px-2.5 py-1.75 text-sm text-ink transition-colors pointer-coarse:min-h-touch',
                        index === activeIndex && 'bg-hover',
                        isSelected && 'bg-accent-soft text-accent-ink',
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerEnter={() => setActive(index)}
                      onClick={() => pick(entry)}
                    >
                      <span className="truncate">{entry.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
