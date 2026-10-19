/**
 * 交互式会话选择器（/resume）
 * @module @vessel/tui
 *
 * 保留既有导出名与 props（onSelect/onClose），内部改用 DataTable + 纯 session-picker：
 * ↑↓/jk、PgUp/PgDn、Home/End、`/`/`f` 过滤、Enter 打开、`r` 重命名、`x` 删除（内联确认）。
 * 选中项按 session_id 记录；任何高度都封顶（默认 20 行）。
 */

import type { SessionInfo } from '@vessel/core';
import { Box, Text, useInput, useStdout } from 'ink';
import { type ReactNode, useMemo, useState } from 'react';
import type { LiveMode } from '../repl/layout.js';
import { theme } from '../theme.js';
import {
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
const ACTIVE_DELETE_NOTICE = 'Cannot delete the current session; run /new first.';

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
  const terminalColumns = columns ?? stdout.columns ?? 80;
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
            setNotice(ACTIVE_DELETE_NOTICE);
            return;
          }
          setMode('confirm');
          return;
        }
        if (intent.key === 'R' && onRetry) onRetry();
        return;
      }
      case 'disabledAction':
        setNotice(intent.reason === 'current' ? ACTIVE_DELETE_NOTICE : 'Select a session first.');
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
            setNotice(result.message ?? 'Renamed.');
          } else {
            setNotice(result.message ?? 'Rename failed.');
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
            setNotice(result.message ?? 'Deleted.');
          } else {
            setMode('browse');
            setNotice(result.message ?? 'Delete failed.');
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
          setNotice(intent.reason === 'empty-title' ? 'Title cannot be empty.' : 'Value required.');
        }
        return;
    }
  }

  // < 11 行：只渲染一行摘要，绝不把输入行顶出屏幕。
  if (heightMode === 'hidden') {
    if (status === 'loading') {
      return (
        <Text color={theme.muted} wrap="truncate-end">
          Resume: loading sessions… · esc close
        </Text>
      );
    }
    if (status === 'error') {
      return (
        <Text color={theme.danger} wrap="truncate-end">
          Resume: failed to load sessions · r retry · esc close
        </Text>
      );
    }
    if (sessions.length === 0) {
      return (
        <Text color={theme.muted} wrap="truncate-end">
          Resume: no sessions · esc close
        </Text>
      );
    }
    if (rows.length === 0) {
      return (
        <Text color={theme.muted} wrap="truncate-end">
          Resume: no matches · esc close
        </Text>
      );
    }
    const first = rows[0];
    const more = rows.length > 1 ? ` · ${rows.length - 1} more` : '';
    return (
      <Text color={theme.muted} wrap="truncate-end">
        Resume: {selectedRow?.cells.title ?? first?.cells.title ?? '-'}
        {more} · esc close
      </Text>
    );
  }

  if (status === 'loading') {
    return (
      <SelectionFrame heightMode={heightMode}>
        <Text color={theme.muted}>Loading sessions…</Text>
        <Box marginTop={1}>
          <Text color={theme.faint}>Esc to close</Text>
        </Box>
      </SelectionFrame>
    );
  }

  if (status === 'error') {
    return (
      <SelectionFrame heightMode={heightMode}>
        <Text bold color={theme.danger}>
          Failed to load sessions
        </Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>{error ?? 'Unknown error.'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.faint}>r retry · Esc to close</Text>
        </Box>
      </SelectionFrame>
    );
  }

  if (sessions.length === 0) {
    return (
      <SelectionFrame heightMode={heightMode}>
        <EmptyState title="No sessions to resume." hint="Esc to close" />
      </SelectionFrame>
    );
  }

  if (rows.length === 0) {
    return (
      <SelectionFrame heightMode={heightMode}>
        <EmptyState
          title="No matching sessions"
          hint={filter ? `filter: "${filter}" · esc to clear filter` : 'esc close'}
        />
      </SelectionFrame>
    );
  }

  const showHeader = heightMode === 'normal' || heightMode === 'compact';
  const capacity = Math.max(1, maxRows);
  const window = scrollWindow(rows.length, selectedIndex, capacity);
  const contentWidth = Math.max(1, viewContentWidth(terminalColumns) - TABLE_PREFIX_WIDTH);
  const resolved = resolveColumns(sessionColumns(terminalColumns), contentWidth, terminalColumns);

  return (
    <SelectionFrame heightMode={heightMode} width={viewWidth(terminalColumns)}>
      <Box flexDirection="column" width={viewContentWidth(terminalColumns)}>
        <Box marginBottom={1}>
          <Text bold color={theme.brand}>
            Resume session
          </Text>
          {filter ? (
            <Text color={theme.warn}>
              {' '}
              · filter: {filter}
              {mode === 'filter' ? '_' : ''}
            </Text>
          ) : null}
        </Box>

        <DataTable
          view={{
            kind: 'table',
            title: 'Resume session',
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

        {mode === 'confirm' && selectedSession ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.danger}>
              Delete "{selectedSession.title || selectedSession.preview || '(untitled)'}"?{' '}
              {String(selectedSession.message_count)} messages and related runs/events will be
              removed.
            </Text>
            <Text color={theme.faint}>[y] delete · [n] keep · esc cancel</Text>
          </Box>
        ) : null}

        {mode === 'rename' ? (
          <Box marginTop={1}>
            <Text color={theme.warn}>
              {'r Rename: '}
              {draft}
              <Text color={theme.faint}>▏</Text>
            </Text>
          </Box>
        ) : null}

        {rows.length > window.end - window.start ? (
          <Box marginTop={1}>
            <Text color={theme.faint}>
              showing {window.start + 1}-{window.end} of {rows.length}
              {rows.length !== sessions.length ? ` (filtered from ${sessions.length})` : ''}
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
              type to filter · enter keep · esc clear
              {selectedRow ? ` · ${shortSessionId(selectedRow.key)}` : ''}
            </Text>
          ) : mode === 'rename' ? (
            <Text color={theme.faint}>enter save · esc cancel</Text>
          ) : mode === 'confirm' ? (
            <Text color={theme.faint}>[y] delete · [n] keep · esc cancel</Text>
          ) : (
            <KeyHints
              actions={enabledActions}
              extra="↑↓/jk move"
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
