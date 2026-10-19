/**
 * 交互式命令视图宿主——唯一持有视图 `useInput` 的组件
 * @module @vessel/tui
 *
 * 输入：纯数据 CommandView + 受控的交互状态（selectedKey/filter/mode/draft）。
 * 输出：onSelect / onFilter / onMode / onAction / onClose；不发 RPC。
 *
 * 高度降级（capacity 来自 computeLiveLayout().pickerMaxRows）：
 * - normal：表头 + 最多 20 行 + 完整 hints
 * - compact：表头 + 最多 10 行 + 单行 hints
 * - minimal：无表头 + 最多 5 行 + 单行 hints
 * - hidden：单行摘要 + esc close（不遮住输入行）
 */

import { Box, Text, useInput } from 'ink';
import { type ReactNode, useMemo, useState } from 'react';
import { theme } from '../theme.js';
import { truncateToWidth } from '../utils/text-layout.js';
import {
  initialViewKeyState,
  reduceViewKey,
  type ViewIntent,
  type ViewKey,
  type ViewKeyState,
} from '../views/keys.js';
import {
  type ResolvedColumn,
  resolveColumns,
  scrollWindow,
  TABLE_PREFIX_WIDTH,
  viewContentWidth,
  viewWidth,
} from '../views/layout.js';
import type { ListView, TableView, ViewRow } from '../views/types.js';
import {
  formatConfirmMessage,
  isViewActionEnabled,
  type ViewAction,
  type ViewEnvelope,
  viewActions,
} from '../views/types.js';
import { DataTable } from './DataTable.js';
import { DetailPanel } from './DetailPanel.js';
import { EmptyState } from './EmptyState.js';
import { KeyHints } from './KeyHints.js';

export interface InteractiveViewHostProps {
  envelope: ViewEnvelope;
  selectedKey: string | null;
  filter: string;
  mode: ViewKeyState['mode'];
  draft: string;
  /** rename/confirm 的待执行动作 */
  pendingAction: ViewAction | null;
  /** 终端列数 */
  columns: number;
  /** 行容量（computeLiveLayout().pickerMaxRows；normal 也封顶） */
  maxRows: number;
  /** 终端高度分档 */
  heightMode: 'normal' | 'compact' | 'minimal' | 'hidden';
  /** 权限/ask-user 浮层出现时禁用键盘 */
  active?: boolean;
  onSelect: (key: string) => void;
  onFilter: (filter: string) => void;
  onMode: (mode: ViewKeyState['mode'], draft?: string, pendingAction?: ViewAction | null) => void;
  onAction: (action: ViewAction, selectionKey: string, value?: string) => void;
  onClose: () => void;
}

/** 纯函数：按过滤词筛选表格行（所有单元格，大小写不敏感） */
export function filterTableRows(rows: ViewRow[], filter: string): ViewRow[] {
  const query = filter.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter((row) =>
    Object.values(row.cells).some((cell) => cell.toLowerCase().includes(query)),
  );
}

/** 纯函数：按过滤词筛选 list 项 */
export function filterListItems(items: ListView['items'], filter: string): ListView['items'] {
  const query = filter.trim().toLowerCase();
  if (!query) return items;
  return items.filter((item) =>
    [item.label, item.description ?? '', item.badge ?? ''].join('\n').toLowerCase().includes(query),
  );
}

function titleLine(envelope: ViewEnvelope): string {
  const { view } = envelope;
  if (view.kind === 'table') {
    return view.meta ? `${view.title} · ${view.meta}` : view.title;
  }
  return view.title;
}

/** hidden 高度下的一行摘要 */
export function hiddenSummary(envelope: ViewEnvelope): string {
  const { view } = envelope;
  if (view.kind === 'table') {
    const first = view.rows[0];
    const label = first ? first.cells.title || first.cells.name || first.key : 'no items';
    const more = view.rows.length > 1 ? ` · ${view.rows.length - 1} more` : '';
    return `${view.title}: ${label}${more}`;
  }
  if (view.kind === 'list') {
    const first = view.items[0];
    const more = view.items.length > 1 ? ` · ${view.items.length - 1} more` : '';
    return `${view.title}: ${first?.label ?? 'no items'}${more}`;
  }
  return view.title;
}

function confirmHint(action: ViewAction | null): string {
  if (!action) return 'esc cancel';
  const tone = action.tone === 'danger' ? 'delete' : action.label;
  return `[y] ${tone}  [n] keep  esc cancel`;
}

export function InteractiveViewHost({
  envelope,
  selectedKey,
  filter,
  mode,
  draft,
  pendingAction,
  columns,
  maxRows,
  heightMode,
  active = true,
  onSelect,
  onFilter,
  onMode,
  onAction,
  onClose,
}: InteractiveViewHostProps) {
  const { view, status = 'ready', error } = envelope;
  const [notice, setNotice] = useState<string | null>(null);

  const actions = viewActions(view);
  const filteredRows = useMemo(
    () => (view.kind === 'table' ? filterTableRows(view.rows, filter) : []),
    [view, filter],
  );
  const filteredItems = useMemo(
    () => (view.kind === 'list' ? filterListItems(view.items, filter) : []),
    [view, filter],
  );
  const itemCount =
    view.kind === 'table' ? filteredRows.length : view.kind === 'list' ? filteredItems.length : 0;
  const selectedIndex = useMemo(() => {
    if (view.kind === 'table') {
      const index = filteredRows.findIndex((row) => row.key === selectedKey);
      return index >= 0 ? index : 0;
    }
    if (view.kind === 'list') {
      const index = filteredItems.findIndex((item) => item.key === selectedKey);
      return index >= 0 ? index : 0;
    }
    return 0;
  }, [view, filteredRows, filteredItems, selectedKey]);

  const selectedRow: ViewRow | null =
    view.kind === 'table' ? (filteredRows[selectedIndex] ?? null) : null;
  const selectionKey =
    view.kind === 'table'
      ? (selectedRow?.key ?? '')
      : view.kind === 'list'
        ? (filteredItems[selectedIndex]?.key ?? '')
        : '';

  const disabledActionKeys = actions
    .filter((action) => !isViewActionEnabled(action, selectedRow))
    .map((action) => action.key);
  const actionKeys = actions.map((action) => action.key);

  const keyState = initialViewKeyState({
    mode,
    filter,
    draft,
    selectedIndex,
    itemCount,
    pageSize: 5,
    selectedCurrent: selectedRow?.current === true,
    actionKeys,
    disabledActionKeys,
  });

  const capacity = heightMode === 'hidden' ? 0 : Math.max(1, maxRows);
  const confirmDetails =
    view.kind === 'confirm'
      ? (view.details ?? []).map((text, index) => ({ text, id: `confirm-${index}` }))
      : [];

  useInput(
    (inputChar, key) => {
      const inkKey: ViewKey = { ...key, input: inputChar };

      if (status === 'error') {
        if (inputChar === 'r') {
          const refresh = actions.find((action) => action.id === 'refresh');
          if (refresh) {
            setNotice(null);
            onAction(refresh, selectionKey);
          }
        }
        if (key.escape) onClose();
        return;
      }
      if (status === 'loading') {
        if (key.escape) onClose();
        return;
      }

      // 独立的 ConfirmView：不经过表格 reducer。
      if (view.kind === 'confirm') {
        if (key.escape || (inputChar === 'n' && !key.ctrl && !key.meta)) {
          onClose();
          return;
        }
        if (inputChar === 'y' || key.return) {
          onAction(
            {
              id: view.confirm.id,
              key: 'y',
              label: view.confirm.label,
              ...(view.confirm.tone ? { tone: view.confirm.tone } : {}),
            },
            '',
          );
          return;
        }
        return;
      }

      const reduction = reduceViewKey(keyState, inkKey);
      const next = reduction.state;

      // reducer 内的纯文本编辑（rename/form/filter）通过受控 props 回写。
      if (next.filter !== filter) onFilter(next.filter);
      if (next.draft !== draft || next.mode !== mode) {
        const nextPending = reduction.intent.type === 'cancelMode' ? null : pendingAction;
        onMode(next.mode, next.draft, nextPending);
      }
      if (reduction.intent.type !== 'noop') {
        handleIntent(reduction.intent);
      }
    },
    { isActive: active },
  );

  function handleIntent(intent: ViewIntent): void {
    switch (intent.type) {
      case 'noop':
        return;
      case 'close':
        onClose();
        return;
      case 'moveSelection':
        if (view.kind === 'table') {
          const row = filteredRows[intent.index];
          if (row) onSelect(row.key);
        } else if (view.kind === 'list') {
          const item = filteredItems[intent.index];
          if (item) onSelect(item.key);
        }
        return;
      case 'quickSelect': {
        const row = view.kind === 'table' ? filteredRows[intent.index] : null;
        if (row) {
          onSelect(row.key);
          const enter = actions.find((action) => action.key === 'enter');
          if (enter) onAction(enter, row.key);
        }
        return;
      }
      case 'beginFilter':
        setNotice(null);
        onFilter('');
        onMode('filter', '');
        return;
      case 'setFilter':
        onFilter(intent.filter);
        return;
      case 'exitFilter':
        onMode('browse');
        return;
      case 'clearFilter':
        onFilter('');
        onMode('browse');
        return;
      case 'action': {
        const action = actions.find((candidate) => candidate.key === intent.key);
        if (!action) return;
        setNotice(null);
        if (action.inputFrom) {
          onMode('rename', selectedRow?.cells[action.inputFrom] ?? '', action);
          return;
        }
        if (action.confirm) {
          onMode('confirm', '', action);
          return;
        }
        onAction(action, selectionKey);
        return;
      }
      case 'disabledAction': {
        const action = actions.find((candidate) => candidate.key === intent.key);
        setNotice(
          intent.reason === 'current'
            ? `Cannot ${action?.label ?? 'do that'} the current item.`
            : 'Select an item first.',
        );
        return;
      }
      case 'submit': {
        if (!pendingAction) {
          onMode('browse');
          return;
        }
        onAction(pendingAction, selectionKey, intent.value);
        onMode('browse', '', null);
        return;
      }
      case 'submitConfirm': {
        if (intent.yes && pendingAction) {
          onAction(pendingAction, selectionKey);
        }
        onMode('browse', '', null);
        return;
      }
      case 'cancelMode':
        onMode('browse', '', null);
        return;
      case 'focusField':
        onMode('form', draft);
        return;
      case 'reject':
        setNotice(intent.reason === 'empty-title' ? 'Title cannot be empty.' : 'Value required.');
        return;
      case 'beginRename':
      case 'beginConfirm':
      case 'beginForm':
        return;
    }
  }

  // ── 渲染 ──────────────────────────────────────

  const width = viewWidth(columns);
  const contentWidth = viewContentWidth(columns);
  const bordered = heightMode !== 'hidden';
  const showHeader = heightMode === 'normal' || heightMode === 'compact';

  if (status === 'loading') {
    return (
      <ViewFrame bordered={bordered}>
        <Text color={theme.muted}>Loading {view.title}…</Text>
        <Box marginTop={1}>
          <Text color={theme.faint}>esc close</Text>
        </Box>
      </ViewFrame>
    );
  }

  if (status === 'error') {
    return (
      <ViewFrame bordered={bordered}>
        <Text bold color={theme.danger}>
          Failed to load {view.title}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>{error ?? 'Unknown error.'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.faint}>r retry · esc close</Text>
        </Box>
      </ViewFrame>
    );
  }

  if (heightMode === 'hidden') {
    return (
      <ViewFrame bordered={false} width={contentWidth}>
        <Text color={theme.muted} wrap="truncate-end">
          {truncateToWidth(`${hiddenSummary(envelope)} · esc close`, contentWidth)}
        </Text>
      </ViewFrame>
    );
  }

  const window = scrollWindow(itemCount, selectedIndex, capacity);

  return (
    <ViewFrame bordered={bordered} width={width}>
      <Box flexDirection="column" width={contentWidth}>
        {/* 标题 + 过滤/模式状态 */}
        <Box marginBottom={1}>
          <Text bold color={theme.brand}>
            {titleLine(envelope)}
          </Text>
          {filter ? (
            <Text color={theme.warn}>
              {' '}
              · filter: {truncateToWidth(filter, Math.max(1, contentWidth - 20))}
              {mode === 'filter' ? '_' : ''}
            </Text>
          ) : null}
        </Box>

        {/* 内容 */}
        {view.kind === 'table' ? (
          <TableBody
            view={view}
            rows={filteredRows.slice(window.start, window.end)}
            columns={columns}
            selectedKey={selectionKey}
            start={window.start}
            showHeader={showHeader}
            emptyHint={filter ? 'esc to clear filter' : 'esc close'}
          />
        ) : null}

        {view.kind === 'list' ? (
          <ListBody
            view={view}
            items={filteredItems.slice(window.start, window.end)}
            start={window.start}
            selectedKey={selectionKey}
            showHeader={showHeader}
          />
        ) : null}

        {view.kind === 'detail' ? (
          <DetailPanel view={view} width={contentWidth} maxRows={capacity} />
        ) : null}

        {view.kind === 'form' ? <FormBody view={view} draft={draft} mode={mode} /> : null}

        {view.kind === 'confirm' ? (
          <Box flexDirection="column">
            <Text color={theme.muted}>{view.message}</Text>
            {confirmDetails.map((detail) => (
              <Text key={detail.id} color={theme.faint}>
                {'  '}
                {detail.text}
              </Text>
            ))}
            <Box marginTop={1}>
              <Text color={theme.faint}>
                [y] {view.confirm.label} · [n] {view.cancel.label}
              </Text>
            </Box>
          </Box>
        ) : null}

        {/* 窗口指示 */}
        {itemCount > window.end - window.start && itemCount > 0 ? (
          <Box marginTop={1}>
            <Text color={theme.faint}>
              showing {window.start + 1}-{window.end} of {itemCount}
            </Text>
          </Box>
        ) : null}

        {/* 重命名输入 / 内联确认 */}
        {mode === 'rename' ? (
          <Box marginTop={1}>
            <Text color={theme.warn}>
              {'r Rename: '}
              {draft}
              <Text color={theme.faint}>▏</Text>
            </Text>
          </Box>
        ) : null}

        {mode === 'confirm' && pendingAction ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.danger}>{formatConfirmMessage(pendingAction, selectedRow)}</Text>
            <Text color={theme.faint}>{confirmHint(pendingAction)}</Text>
          </Box>
        ) : null}

        {notice ? (
          <Box marginTop={1}>
            <Text color={theme.warn}>! {notice}</Text>
          </Box>
        ) : null}

        {/* 按键提示 */}
        <Box marginTop={1}>
          {mode === 'filter' ? (
            <Text color={theme.faint}>type to filter · enter keep · esc clear</Text>
          ) : mode === 'rename' ? (
            <Text color={theme.faint}>enter save · esc cancel</Text>
          ) : mode === 'confirm' ? (
            <Text color={theme.faint}>{confirmHint(pendingAction)}</Text>
          ) : (
            <KeyHints
              actions={actions}
              extra={
                itemCount > 0
                  ? `${heightMode === 'normal' ? '↑↓/jk/pgup/pgdn move' : '↑↓ move'}`
                  : 'esc close'
              }
              disabledKeys={disabledActionKeys}
            />
          )}
        </Box>
      </Box>
    </ViewFrame>
  );
}

function ViewFrame({
  children,
  bordered,
  width,
}: {
  children: ReactNode;
  bordered: boolean;
  width?: number;
}) {
  if (!bordered) return <Box flexDirection="column">{children}</Box>;
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.line}
      paddingX={1}
      marginY={1}
      {...(width !== undefined ? { width } : {})}
    >
      {children}
    </Box>
  );
}

function TableBody({
  view,
  rows,
  columns,
  selectedKey,
  start,
  showHeader,
  emptyHint,
}: {
  view: TableView;
  rows: ViewRow[];
  columns: number;
  selectedKey: string;
  start: number;
  showHeader: boolean;
  emptyHint: string;
}) {
  const contentWidth = Math.max(1, viewContentWidth(columns) - TABLE_PREFIX_WIDTH);
  const resolved: ResolvedColumn[] = resolveColumns(view.columns, contentWidth, columns);
  return (
    <DataTable
      view={view}
      columns={resolved}
      rows={rows}
      selectedKey={selectedKey}
      start={start}
      showHeader={showHeader}
      emptyHint={emptyHint}
    />
  );
}

function ListBody({
  view,
  items,
  start,
  selectedKey,
  showHeader,
}: {
  view: ListView;
  items: ListView['items'];
  start: number;
  selectedKey: string;
  showHeader: boolean;
}) {
  if (items.length === 0) {
    return <EmptyState title={view.emptyText ?? 'No items.'} hint="esc close" />;
  }
  return (
    <Box flexDirection="column">
      {showHeader ? (
        <Text color={theme.faint} bold>
          {'  #  ITEM'}
        </Text>
      ) : null}
      {items.map((item, offset) => {
        const index = start + offset;
        const selected = item.key === selectedKey;
        const color = selected ? theme.brand : item.current ? theme.ok : theme.muted;
        return (
          <Text key={item.key} color={color} bold={selected} wrap="truncate-end">
            {`${selected ? '›' : item.current ? '●' : ' '} ${String(index + 1).padStart(2, ' ')}  ${item.label}`}
            {item.description ? ` — ${item.description}` : ''}
            {item.badge ? ` [${item.badge}]` : ''}
            {item.current ? ' (active)' : ''}
          </Text>
        );
      })}
    </Box>
  );
}

function FormBody({
  view,
  draft,
  mode,
}: {
  view: Extract<ViewEnvelope['view'], { kind: 'form' }>;
  draft: string;
  mode: ViewKeyState['mode'];
}) {
  return (
    <Box flexDirection="column">
      {view.fields.map((field, index) => {
        const active = mode === 'form' && index === 0;
        return (
          <Text key={field.key} color={active ? theme.brand : theme.muted}>
            {`  ${field.label}: `}
            {active ? draft || field.placeholder || '' : field.value || field.placeholder || ''}
          </Text>
        );
      })}
    </Box>
  );
}
