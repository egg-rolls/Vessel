/**
 * 交互式会话选择器（/resume）
 * @module @vessel-agent/tui
 *
 * 保留既有导出名与 props（onSelect/onClose），内部改用 DataTable + 纯 session-picker：
 * ↑↓/jk、PgUp/PgDn、Home/End、`/`/`f` 过滤、Enter 打开、`r` 重命名、`x` 删除（内联确认）。
 * 选中项按 session_id 记录；任何高度都封顶（默认 20 行）。
 */

import type { SessionInfo } from '@vessel-agent/core';
import { Box, Text, useInput, useStdout, useWindowSize } from 'ink';
import { type ReactNode, useMemo, useState } from 'react';
import { t } from '../i18n/index.js';
import { type LiveMode, viewExtraRows } from '../repl/layout.js';
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
  resolveColumns,
  scrollWindow,
  TABLE_PREFIX_WIDTH,
  viewContentWidth,
  viewWidth,
} from '../views/layout.js';
import {
  buildSessionRows,
  clampSelectedKey,
  filterSessions,
  keyAfterRemoval,
  selectedIndexForKey,
  sessionColumns,
  sessionPickerActions,
  shortSessionId,
} from '../views/session-picker.js';
import type { ViewMode } from '../views/types.js';
import { DataTable } from './DataTable.js';
import { EmptyState } from './EmptyState.js';
import { KeyHints } from './KeyHints.js';

/** 删除/重命名回调的返回：ok=false 保留行并显示 message */
export interface SessionPickerActionResult {
  ok: boolean;
  message?: string;
}

export interface SessionTableProps {
  sessions: SessionInfo[];
  currentSessionId?: string;
  /** picker 数据加载状态；默认 ready，保持外部调用兼容 */
  status?: 'loading' | 'ready' | 'error';
  error?: string | null;
  /** 可见会话行数上限；缺省 20（normal 也封顶） */
  maxRows?: number;
  /** 终端高度分档（normal/compact/minimal/hidden）；缺省 normal */
  heightMode?: LiveMode;
  /** 终端列数；缺省取 stdout.columns */
  columns?: number;
  onRetry?: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** 交互删除；缺省时 `x` 不启用 */
  onDelete?: (id: string) => Promise<SessionPickerActionResult>;
  /** 交互重命名；缺省时 `r` 不启用 */
  onRename?: (id: string, title: string) => Promise<SessionPickerActionResult>;
}

/**
 * 纯函数：把选中索引钳制到 [0, len-1]。
 * 空列表返回 0（不是 -1），避免 ↑↓ 后出现无效索引。
 */
export function clampSelection(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

const DEFAULT_MAX_ROWS = 20;

export function SessionTable({
  sessions,
  currentSessionId,
  status = 'ready',
  error = null,
  maxRows = DEFAULT_MAX_ROWS,
  heightMode = 'normal',
  columns,
  onRetry,
  onSelect,
  onClose,
  onDelete,
  onRename,
}: SessionTableProps) {
  const { stdout } = useStdout();
  // useStdout 不订阅 resize：优先 useWindowSize（props.columns 仍可覆盖）。
  const windowSize = useWindowSize();
  const terminalColumns =
    columns ?? (windowSize.columns > 0 ? windowSize.columns : (stdout.columns ?? 80));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<ViewMode>('browse');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = useMemo(() => filterSessions(sessions, filter), [sessions, filter]);
  const rows = useMemo(
    () => buildSessionRows(filtered, currentSessionId),
    [filtered, currentSessionId],
  );

  // 选中 key 失效（过滤/删除/刷新）时钳制到有效行，绝不指向不存在的 id。
  const effectiveKey = clampSelectedKey(
    rows,
    selectedKey,
    selectedIndexForKey(rows, selectedKey) >= 0 ? selectedIndexForKey(rows, selectedKey) : 0,
  );
  const selectedIndex = Math.max(0, selectedIndexForKey(rows, effectiveKey));
  const selectedRow = rows[selectedIndex] ?? null;
  const selectedSession = selectedRow
    ? filtered.find((session) => session.session_id === selectedRow.key)
    : undefined;

  const actions = sessionPickerActions();
  const enabledActions = actions.filter((action) => {
    if (action.id === 'rename' && !onRename) return false;
    if (action.id === 'delete' && !onDelete) return false;
    return true;
  });
  const disabledActionKeys = actions
    .filter((action) => action.id === 'delete' && selectedRow?.current === true)
    .map((action) => action.key);
  const actionKeys = enabledActions.map((action) => action.key);

  const keyState: ViewKeyState = initialViewKeyState({
    mode,
    filter,
    draft,
    selectedIndex,
    itemCount: rows.length,
    pageSize: 5,
    selectedCurrent: selectedRow?.current === true,
    actionKeys,
    disabledActionKeys,
  });

  useInput((inputChar, key) => {
    // hidden（≤10 行）只显示一行摘要：除 Esc 与 error 态重试外一律不处理，
    // 否则 x/y/r 会在看不到列表与确认提示的情况下静默删除/改名。
    if (heightMode === 'hidden') {
      const decision = decideHiddenKey(
        { ...key, input: inputChar },
        { status, refreshKeys: onRetry ? ['r'] : [] },
      );
      if (decision === 'close') onClose();
      if (decision === 'refresh' && onRetry) onRetry();
      return;
    }

    if (status === 'loading') {
      if (key.escape) onClose();
      return;
    }
    if (status === 'error') {
      if (inputChar === 'r' && onRetry) onRetry();
      if (key.escape) onClose();
      return;
    }

    const inkKey: ViewKey = { ...key, input: inputChar };
    const reduction = reduceViewKey(keyState, inkKey);
    const next = reduction.state;

    if (next.filter !== filter) setFilter(next.filter);
    if (next.draft !== draft) setDraft(next.draft);
    if (next.mode !== mode) setMode(next.mode);
    if (reduction.intent.type !== 'noop') handleIntent(reduction.intent);
  });

  function handleIntent(intent: ViewIntent): void {
    switch (intent.type) {
      case 'noop':
        return;
      case 'close':
        onClose();
        return;
      case 'moveSelection': {
        const nextKey = rows[intent.index]?.key;
        if (nextKey) setSelectedKey(nextKey);
        return;
      }
      case 'quickSelect': {
        const row = rows[intent.index];
        if (row) {
          setSelectedKey(row.key);
          onSelect(row.key);
        }
        return;
      }
      case 'beginFilter':
        setNotice(null);
        setFilter('');
        setMode('filter');
        return;
      case 'setFilter':
        setFilter(intent.filter);
        return;
      case 'exitFilter':
      case 'clearFilter':
        setMode('browse');
        if (intent.type === 'clearFilter') setFilter('');
        return;
      case 'action': {
        setNotice(null);
        if (intent.key === 'enter') {
          if (selectedRow) onSelect(selectedRow.key);
          return;
        }
        if (intent.key === 'r') {
          setDraft(selectedSession?.title || selectedSession?.preview || '');
          setMode('rename');
          return;
        }
        if (intent.key === 'x') {
          if (!selectedRow) return;
          if (selectedRow.current) {
            setNotice(t('session.cannotDeleteCurrent'));
            return;
          }
          setMode('confirm');
          return;
        }
        if (intent.key === 'R' && onRetry) onRetry();
        return;
      }
      case 'disabledAction':
        setNotice(
          intent.reason === 'current' ? t('session.cannotDeleteCurrent') : t('session.selectFirst'),
        );
        return;
      case 'submit': {
        // rename
        if (!onRename || !selectedRow) {
          setMode('browse');
          return;
        }
        void onRename(selectedRow.key, intent.value).then((result) => {
          if (result.ok) {
            setMode('browse');
            setNotice(result.message ?? t('session.renamed'));
          } else {
            setNotice(result.message ?? t('session.renameFailed'));
          }
        });
        return;
      }
      case 'submitConfirm': {
        const removed = selectedRow?.key ?? null;
        if (!intent.yes || !onDelete || !removed) {
          setMode('browse');
          return;
        }
        void onDelete(removed).then((result) => {
          if (result.ok) {
            const nextKey = keyAfterRemoval(rows, removed);
            setSelectedKey(nextKey);
            setMode('browse');
            setNotice(result.message ?? t('session.deleted'));
          } else {
            setMode('browse');
            setNotice(result.message ?? t('session.deleteFailed'));
          }
        });
        return;
      }
      case 'cancelMode':
        setMode('browse');
        setDraft('');
        return;
      case 'focusField':
      case 'beginRename':
      case 'beginConfirm':
      case 'beginForm':
      case 'reject':
        if (intent.type === 'reject') {
          setNotice(
            intent.reason === 'empty-title' ? t('session.emptyTitle') : t('session.valueRequired'),
          );
        }
        return;
    }
  }

  // < 11 行：只渲染一行摘要，绝不把输入行顶出屏幕。
  if (heightMode === 'hidden') {
    if (status === 'loading') {
      return (
        <Text color={theme.muted} wrap="truncate-end">
          {t('session.hidden.loading')}
        </Text>
      );
    }
    if (status === 'error') {
      return (
        <Text color={theme.danger} wrap="truncate-end">
          {t('session.hidden.failed', {
            retry: onRetry ? t('session.hidden.failedRetry') : '',
          })}
        </Text>
      );
    }
    if (sessions.length === 0) {
      return (
        <Text color={theme.muted} wrap="truncate-end">
          {t('session.hidden.none')}
        </Text>
      );
    }
    if (rows.length === 0) {
      return (
        <Text color={theme.muted} wrap="truncate-end">
          {t('session.hidden.noMatches')}
        </Text>
      );
    }
    const first = rows[0];
    const more = rows.length > 1 ? t('session.more', { count: rows.length - 1 }) : '';
    return (
      <Text color={theme.muted} wrap="truncate-end">
        {t('session.hidden.summary', {
          title: selectedRow?.cells.title ?? first?.cells.title ?? '-',
          more,
        })}
      </Text>
    );
  }

  if (status === 'loading') {
    return (
      <SelectionFrame heightMode={heightMode}>
        <Text color={theme.muted}>{t('session.loading')}</Text>
        <Box marginTop={1}>
          <Text color={theme.faint}>{t('session.escClose')}</Text>
        </Box>
      </SelectionFrame>
    );
  }

  if (status === 'error') {
    return (
      <SelectionFrame heightMode={heightMode}>
        <Text bold color={theme.danger}>
          {t('session.failed')}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>{error ?? t('session.unknownError')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.faint}>{t('session.retryClose')}</Text>
        </Box>
      </SelectionFrame>
    );
  }

  if (sessions.length === 0) {
    return (
      <SelectionFrame heightMode={heightMode}>
        <EmptyState title={t('session.empty')} hint={t('session.escClose')} />
      </SelectionFrame>
    );
  }

  if (rows.length === 0) {
    return (
      <SelectionFrame heightMode={heightMode}>
        <EmptyState
          title={t('session.noMatches')}
          hint={filter ? t('session.noMatchesFilterHint', { filter }) : t('session.noMatchesHint')}
        />
      </SelectionFrame>
    );
  }

  const showHeader = heightMode === 'normal' || heightMode === 'compact';
  // 确认/重命名/notice 会追加在数据行之后，必须先让出对应行数。
  const extraRows = viewExtraRows(mode, notice !== null);
  // 容量可以为 0：矮终端 + 确认/notice 时应隐藏数据行，而不是强行保留 1 行导致溢出。
  const capacity = Math.max(0, maxRows - extraRows);
  const window = scrollWindow(rows.length, selectedIndex, capacity);
  const rangeVisible = rows.length > window.end - window.start;
  const rangeText = rangeVisible
    ? `${t('session.range', {
        start: window.start + 1,
        end: window.end,
        total: rows.length,
      })}${
        rows.length !== sessions.length
          ? t('session.rangeFiltered', { total: sessions.length })
          : ''
      }`
    : null;
  const contentWidth = Math.max(1, viewContentWidth(terminalColumns) - TABLE_PREFIX_WIDTH);
  const resolved = resolveColumns(sessionColumns(terminalColumns), contentWidth, terminalColumns);

  return (
    <SelectionFrame heightMode={heightMode} width={viewWidth(terminalColumns)}>
      <Box flexDirection="column" width={viewContentWidth(terminalColumns)}>
        <Box marginBottom={1}>
          <Text bold color={theme.brand}>
            {t('session.title')}
          </Text>
          {filter ? (
            <Text color={theme.warn}>
              {' '}
              ·{' '}
              {t('session.filterPrompt', {
                filter: truncateToWidth(
                  filter,
                  Math.max(1, viewContentWidth(terminalColumns) - 34),
                ),
              })}
              {mode === 'filter' ? '_' : ''}
            </Text>
          ) : null}
          {/* 窗口指示折进标题行，避免在矮终端额外占 2 行 */}
          {rangeText ? <Text color={theme.faint}> · {rangeText}</Text> : null}
        </Box>

        {capacity > 0 ? (
          <DataTable
            view={{
              kind: 'table',
              title: t('session.title'),
              columns: sessionColumns(terminalColumns),
              rows,
              actions,
            }}
            columns={resolved}
            rows={rows.slice(window.start, window.end)}
            selectedKey={effectiveKey}
            start={window.start}
            showHeader={showHeader}
          />
        ) : null}

        {mode === 'confirm' && selectedSession ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.danger} wrap="truncate-end">
              {t('session.confirmDeleteBody', {
                title: selectedSession.title || selectedSession.preview || t('session.untitled'),
                count: selectedSession.message_count,
              })}
            </Text>
            <Text color={theme.faint}>{t('session.confirmDeleteHint')}</Text>
          </Box>
        ) : null}

        {mode === 'rename' ? (
          <Box marginTop={1}>
            <Text color={theme.warn}>
              {t('session.renamePrefix')}
              {draft}
              <Text color={theme.faint}>▏</Text>
            </Text>
          </Box>
        ) : null}

        {notice ? (
          <Box marginTop={1}>
            <Text color={theme.warn}>! {notice}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          {mode === 'filter' ? (
            <Text color={theme.faint}>
              {t('session.filterHint')}
              {selectedRow ? ` · ${shortSessionId(selectedRow.key)}` : ''}
            </Text>
          ) : mode === 'rename' ? (
            <Text color={theme.faint}>{t('session.renameHint')}</Text>
          ) : mode === 'confirm' ? (
            <Text color={theme.faint}>{t('session.confirmDeleteHint')}</Text>
          ) : (
            <KeyHints
              actions={enabledActions}
              extra={t('session.moveHint')}
              disabledKeys={disabledActionKeys}
            />
          )}
        </Box>
      </Box>
    </SelectionFrame>
  );
}

function SelectionFrame({
  children,
  heightMode,
  width,
}: {
  children: ReactNode;
  heightMode: LiveMode;
  width?: number;
}) {
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="single"
      borderColor={theme.line}
      paddingX={1}
      marginY={heightMode === 'minimal' ? 0 : 1}
      {...(width !== undefined ? { width } : {})}
    >
      {children}
    </Box>
  );
}
