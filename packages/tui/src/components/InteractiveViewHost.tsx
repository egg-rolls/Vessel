/**
 * 交互式命令视图宿主——唯一持有视图 `useInput` 的组件
 * @module @vessel-agent/tui
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
import { t } from '../i18n/index.js';
import { viewExtraRows } from '../repl/layout.js';
import { theme } from '../theme.js';
import { truncateToWidth } from '../utils/text-layout.js';
import {
  decideHiddenKey,
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
import { viewSelectionKey, viewSelectionRow } from '../views/selection.js';
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
import { formatKeyHints } from './KeyHints.js';
import { PanelFrame } from './PanelFrame.js';

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
    const label = first ? first.cells.title || first.cells.name || first.key : t('view.noItems');
    const more = view.rows.length > 1 ? t('view.more', { count: view.rows.length - 1 }) : '';
    return `${view.title}: ${label}${more}`;
  }
  if (view.kind === 'list') {
    const first = view.items[0];
    const more = view.items.length > 1 ? t('view.more', { count: view.items.length - 1 }) : '';
    return `${view.title}: ${first?.label ?? t('view.noItems')}${more}`;
  }
  return view.title;
}

function confirmHint(action: ViewAction | null): string {
  if (!action) return t('view.cancelHint');
  const tone = action.tone === 'danger' ? t('session.action.delete') : action.label;
  return t('view.confirmHint', { action: tone });
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

  // list 的 item 与 detail 的 view.key 都归一为行，保证 enabled: 'selected' /
  // 'not-current' 与 confirm 文案在非表格视图里同样生效。
  const selectedRow: ViewRow | null = viewSelectionRow(
    view,
    view.kind === 'table' ? (filteredRows[selectedIndex] ?? null) : null,
    view.kind === 'list' ? filteredItems[selectedIndex] : undefined,
  );
  const selectionKey = viewSelectionKey(selectedRow);

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

  // 确认/重命名/notice 追加在数据行之后，先从容量中扣除，保证不顶出底栏。
  const extraRows = viewExtraRows(mode, notice !== null);
  // 容量可以为 0：矮终端 + 确认/notice 时隐藏数据行，而不是强行保留 1 行导致溢出。
  const capacity = heightMode === 'hidden' ? 0 : Math.max(0, maxRows - extraRows);
  const confirmDetails =
    view.kind === 'confirm'
      ? (view.details ?? []).map((text, index) => ({ text, id: `confirm-${index}` }))
      : [];

  useInput(
    (inputChar, key) => {
      const inkKey: ViewKey = { ...key, input: inputChar };

      // hidden（≤10 行）没有可见列表/确认提示/输入框：只允许 Esc 关闭与
      // error 态重试，x/y/r/Enter 等一律阻断，绝不静默执行确认动作。
      if (heightMode === 'hidden') {
        const refresh = actions.find((action) => action.id === 'refresh');
        const decision = decideHiddenKey(inkKey, {
          status,
          refreshKeys: refresh ? [refresh.key, 'r'] : [],
        });
        if (decision === 'close') onClose();
        else if (decision === 'refresh' && refresh) {
          setNotice(null);
          onAction(refresh, selectionKey);
        }
        return;
      }

      if (status === 'error') {
        const refresh = actions.find((action) => action.id === 'refresh');
        // 刷新键由视图声明（runs/metrics 用 r，mcp 用 g）；r 作为兼容兜底。
        if (refresh && (inputChar === refresh.key || inputChar === 'r')) {
          setNotice(null);
          onAction(refresh, selectionKey);
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
            ? t('view.cannotCurrent', { action: action?.label ?? t('view.doThat') })
            : t('view.selectFirst'),
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
        setNotice(intent.reason === 'empty-title' ? t('view.emptyTitle') : t('view.valueRequired'));
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
  // R0：normal/compact 加边框；minimal/hidden 不加。
  const bordered = heightMode === 'normal' || heightMode === 'compact';
  const showHeader = bordered;
  const refresh = actions.find((action) => action.id === 'refresh');
  const rangeWindow = scrollWindow(itemCount, selectedIndex, capacity);
  const rangeVisible = itemCount > rangeWindow.end - rangeWindow.start;
  const rangeText = rangeVisible
    ? `showing ${rangeWindow.start + 1}-${rangeWindow.end} of ${itemCount}`
    : null;
  const titleParts = [titleLine(envelope)];
  if (filter) {
    titleParts.push(`${t('view.filterPrefix', { filter })}${mode === 'filter' ? '_' : ''}`);
  }
  if (rangeText) titleParts.push(rangeText);
  const titleText = view.kind === 'detail' ? '' : titleParts.join(' · ');
  const moveHint =
    itemCount > 0
      ? t(heightMode === 'normal' ? 'view.moveHint' : 'view.moveHintCompact')
      : t('view.escClose');
  const hintsText =
    mode === 'filter'
      ? t('view.filterHint')
      : mode === 'rename'
        ? t('view.renameHint')
        : mode === 'confirm'
          ? confirmHint(pendingAction)
          : formatKeyHints(actions, moveHint, disabledActionKeys);

  const renderFrame = (title: string, hints: string, children: ReactNode) => {
    if (bordered) {
      return (
        <PanelFrame width={width} title={title} hints={hints} marginY={1}>
          {children}
        </PanelFrame>
      );
    }
    return (
      <Box flexDirection="column" width={contentWidth} flexShrink={0}>
        {title ? (
          <Text bold color={theme.brand} wrap="truncate-end">
            {title}
          </Text>
        ) : null}
        {children}
        <Box marginTop={1}>
          <Text color={theme.faint} wrap="truncate-end">
            {hints}
          </Text>
        </Box>
      </Box>
    );
  };

  // hidden 必须先于 loading/error 判定：≤10 行时任何多行状态块都会顶掉输入行。
  if (heightMode === 'hidden') {
    const retry = refresh ? `${refresh.key} retry · ` : '';
    const line =
      status === 'loading'
        ? t('view.loadingClose', { title: view.title })
        : status === 'error'
          ? t('view.failedClose', { title: view.title, retry })
          : t('view.hiddenSummary', { summary: hiddenSummary(envelope) });
    return (
      <Box flexDirection="column" width={contentWidth} flexShrink={0}>
        <Text color={status === 'error' ? theme.danger : theme.muted} wrap="truncate-end">
          {truncateToWidth(line, contentWidth)}
        </Text>
      </Box>
    );
  }

  if (status === 'loading') {
    return renderFrame(
      titleLine(envelope),
      t('view.escClose'),
      <Text color={theme.muted}>{t('view.loading', { title: view.title })}</Text>,
    );
  }

  if (status === 'error') {
    return renderFrame(
      titleLine(envelope),
      t('view.retryClose', { key: refresh?.key ?? 'r' }),
      <Box flexDirection="column">
        <Text bold color={theme.danger}>
          {t('view.failed', { title: view.title })}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>{error ?? t('view.unknownError')}</Text>
        </Box>
      </Box>,
    );
  }

  const window = rangeWindow;

  const content = (
    <>
      {/* 内容（容量为 0 时让位给确认/输入提示，绝不渲染空态多占行） */}
      {view.kind === 'table' && capacity > 0 ? (
        <TableBody
          view={view}
          rows={filteredRows.slice(window.start, window.end)}
          columns={columns}
          selectedKey={selectionKey}
          start={window.start}
          showHeader={showHeader}
          emptyHint={filter ? t('view.escToClearFilter') : t('view.escClose')}
        />
      ) : null}

      {view.kind === 'list' && capacity > 0 ? (
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
              {t('view.confirmActions', {
                confirm: view.confirm.label,
                cancel: view.cancel.label,
              })}
            </Text>
          </Box>
        </Box>
      ) : null}

      {/* 重命名输入 / 内联确认 */}
      {mode === 'rename' ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>
            {t('view.renamePrefix')}
            {draft}
            <Text color={theme.faint}>▏</Text>
          </Text>
        </Box>
      ) : null}

      {mode === 'confirm' && pendingAction ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.danger} wrap="truncate-end">
            {formatConfirmMessage(pendingAction, selectedRow)}
          </Text>
          <Text color={theme.faint}>{confirmHint(pendingAction)}</Text>
        </Box>
      ) : null}

      {notice ? (
        <Box marginTop={1}>
          <Text color={theme.warn}>! {notice}</Text>
        </Box>
      ) : null}
    </>
  );

  return renderFrame(
    titleText,
    hintsText,
    <Box flexDirection="column" width={contentWidth}>
      {content}
    </Box>,
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
    return <EmptyState title={view.emptyText ?? t('common.noItems')} hint={t('view.escClose')} />;
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
            {item.current ? t('view.active') : ''}
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
