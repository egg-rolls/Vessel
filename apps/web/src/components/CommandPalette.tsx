// biome-ignore-all lint/a11y/useSemanticElements: custom combobox requires a listbox, not a native select
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  filterPaletteItems,
  groupPaletteItems,
  moveIndex,
  type PaletteItem,
} from '../state/palette';
import { ModalShell } from './Modal';

/**
 * Ctrl/Cmd+K 命令面板：导航 / 实体 / 动作 / 帮助分组。
 * 只执行安全动作；破坏性动作必须在对应视图中二次确认。
 */
export function CommandPalette({
  items,
  entities,
  initialQuery = '',
  onClose,
  onExecute,
}: {
  items: readonly PaletteItem[];
  entities: readonly PaletteItem[];
  initialQuery?: string;
  onClose: () => void;
  /** 由 AppShell 统一处理破坏性动作的二次确认。 */
  onExecute?: (item: PaletteItem) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  const filtered = useMemo(
    () => filterPaletteItems([...items, ...entities], query),
    [items, entities, query],
  );
  const sections = useMemo(() => groupPaletteItems(filtered), [filtered]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const activeItem = activeIndex >= 0 ? flat[activeIndex] : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 查询变化时回到第一条结果
  useEffect(() => {
    setActive(0);
  }, [query]);

  const execute = (item: PaletteItem) => {
    onClose();
    // 让关闭/焦点恢复先发生，再执行导航/动作。
    window.setTimeout(() => {
      if (onExecute) onExecute(item);
      else item.run();
    }, 0);
  };

  return (
    <ModalShell label="命令面板" onClose={onClose} className="palette">
      <div className="palette-input-row">
        <span className="palette-prefix" aria-hidden="true">
          ⌘K
        </span>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索导航、会话、运行或输入 > 执行动作"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeItem ? `palette-${activeItem.id}` : undefined}
          aria-label="命令面板搜索"
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive(moveIndex(activeIndex, 1, flat.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive(moveIndex(activeIndex, -1, flat.length));
            } else if (event.key === 'Home') {
              event.preventDefault();
              setActive(flat.length > 0 ? 0 : -1);
            } else if (event.key === 'End') {
              event.preventDefault();
              setActive(flat.length - 1);
            } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && activeItem) {
              event.preventDefault();
              execute(activeItem);
            }
          }}
        />
      </div>

      <div className="palette-results" id={listId} role="listbox" aria-label="命令结果">
        {sections.map((section) => (
          <div
            className="palette-group"
            role="group"
            aria-label={section.label}
            key={section.group}
          >
            <div className="palette-group-title" aria-hidden="true">
              {section.label}
            </div>
            {section.items.map((item) => {
              const index = flat.indexOf(item);
              const selected = index === activeIndex;
              return (
                <button
                  key={item.id}
                  id={`palette-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`palette-option ${selected ? 'active' : ''}`.trim()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => execute(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.danger && <span className="palette-danger">需确认</span>}
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && <p className="palette-empty">没有匹配“{query.trim()}”的结果。</p>}
      </div>

      <div className="palette-footer">
        <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        <span aria-live="polite" className="palette-count">
          {flat.length} 项结果
        </span>
      </div>
    </ModalShell>
  );
}
