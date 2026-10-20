/**
 * 会话选择器的纯逻辑：排序、过滤、行构造、列集合、选中 key 维护
 * @module @vessel-agent/tui
 *
 * 组件（SessionTable / InteractiveViewHost）只消费这里的结果；RPC 留在命令层。
 * 选中项始终按 session_id 记录，过滤/删除/刷新后不会按索引漂移。
 */

import type { SessionInfo } from '@vessel-agent/core';
import { t } from '../i18n/index.js';
import { formatRelativeTime } from '../utils/time.js';
import type { TableView, ViewAction, ViewColumn, ViewRow } from './types.js';

/** 排序：updated_at 倒序，同值 session_id 升序（与 /sessions、/resume 一致） */
export function sortSessionsForPicker(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    if (a.session_id === b.session_id) return 0;
    return a.session_id < b.session_id ? -1 : 1;
  });
}

/** 大小写不敏感 substring：title / preview / session_id / branch */
export function filterSessions(sessions: SessionInfo[], filter: string): SessionInfo[] {
  const query = filter.trim().toLowerCase();
  if (!query) return sessions;
  return sessions.filter((session) => {
    const haystack = [session.title, session.preview, session.session_id, session.branch ?? '']
      .join('\n')
      .toLowerCase();
    return haystack.includes(query);
  });
}

/** 短 id（窄屏展示）：保留前 12 个字符 */
export function shortSessionId(sessionId: string, max = 12): string {
  const chars = Array.from(sessionId);
  if (chars.length <= max) return sessionId;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function sessionTitle(session: SessionInfo): string {
  return session.title || session.preview || t('session.untitled');
}

/** 纯函数：构造表格行（排序、current 标记、相对时间、消息数） */
export function buildSessionRows(
  sessions: SessionInfo[],
  currentSessionId: string | undefined,
  now: number = Date.now(),
): ViewRow[] {
  return sortSessionsForPicker(sessions).map((session) => {
    const current = session.session_id === currentSessionId;
    return {
      key: session.session_id,
      current,
      ...(current ? { tone: 'ok' as const } : {}),
      cells: {
        title: current
          ? t('session.titleActive', { title: sessionTitle(session) })
          : sessionTitle(session),
        id: session.session_id,
        shortId: shortSessionId(session.session_id),
        msgs: String(session.message_count),
        updated: session.updated_at > 0 ? formatRelativeTime(session.updated_at, now) : '-',
        branch: session.branch || '-',
        status: session.status || '-',
      },
    };
  });
}

/** 响应式列集合：xs(<70) / sm(70-99) / md(100-119) / lg(>=120) */
export function sessionColumns(columns: number): ViewColumn[] {
  const title: ViewColumn = { key: 'title', header: 'TITLE', priority: 1, minWidth: 24 };
  const id: ViewColumn = { key: 'id', header: 'ID', width: 21, priority: 2 };
  const msgs: ViewColumn = {
    key: 'msgs',
    header: 'MSGS',
    width: 5,
    align: 'right',
    priority: 1,
  };
  const updated: ViewColumn = { key: 'updated', header: 'UPDATED', width: 10, priority: 1 };

  if (columns < 70) return [title, msgs, updated];
  if (columns < 100) return [title, { ...id, width: 18 }, msgs, updated];
  if (columns < 120) {
    return [title, id, msgs, updated, { key: 'branch', header: 'BRANCH', width: 12, priority: 2 }];
  }
  return [
    title,
    id,
    msgs,
    updated,
    { key: 'branch', header: 'BRANCH', width: 12, priority: 2 },
    { key: 'status', header: 'STATUS', width: 10, priority: 3 },
  ];
}

/** 会话选择器动作；x 对 current 不可用（not-current） */
export function sessionPickerActions(): ViewAction[] {
  return [
    { id: 'resume', key: 'enter', label: t('session.action.resume'), enabled: 'selected' },
    {
      id: 'rename',
      key: 'r',
      label: t('session.action.rename'),
      enabled: 'selected',
      inputFrom: 'title',
    },
    {
      id: 'delete',
      key: 'x',
      label: t('session.action.delete'),
      tone: 'danger',
      enabled: 'not-current',
      confirm: t('session.action.confirmDelete'),
    },
    { id: 'refresh', key: 'R', label: t('session.action.refresh'), enabled: 'always' },
  ];
}

export interface SessionPickerInput {
  sessions: SessionInfo[];
  currentSessionId?: string;
  now?: number;
  columns?: number;
  filter?: string;
  selectedKey?: string | null;
}

/** 纯函数：构造 SessionTable 使用的 TableView（已排序 + 过滤） */
export function buildSessionPickerView(input: SessionPickerInput): TableView {
  const now = input.now ?? Date.now();
  const filtered = filterSessions(input.sessions, input.filter ?? '');
  const rows = buildSessionRows(filtered, input.currentSessionId, now);

  const hasSelection = input.selectedKey
    ? rows.some((row) => row.key === input.selectedKey)
    : false;
  const initialKey = hasSelection ? (input.selectedKey ?? undefined) : rows[0]?.key;

  return {
    kind: 'table',
    title: t('session.title'),
    columns: sessionColumns(input.columns ?? 80),
    rows,
    actions: sessionPickerActions(),
    ...(initialKey ? { initialKey } : {}),
    emptyText: input.filter ? t('session.noMatches') : t('session.empty'),
    meta: `${rows.length}${rows.length !== input.sessions.length ? `/${input.sessions.length}` : ''}`,
  };
}

/** 选中 key 在行列表中的索引；不存在返回 -1 */
export function selectedIndexForKey(rows: ViewRow[], key: string | null | undefined): number {
  if (!key) return -1;
  return rows.findIndex((row) => row.key === key);
}

/**
 * 把选中 key 钳制到有效行：key 仍存在则保留，否则落到 clamped index。
 * 空列表返回 null（绝不返回无效 key）。
 */
export function clampSelectedKey(
  rows: ViewRow[],
  key: string | null | undefined,
  fallbackIndex = 0,
): string | null {
  if (rows.length === 0) return null;
  if (key && rows.some((row) => row.key === key)) return key;
  const index = Math.min(Math.max(0, fallbackIndex), rows.length - 1);
  return rows[index]?.key ?? null;
}

/** 按行移动选中 key（钳制在 [0, len-1]） */
export function moveSelectedKey(
  rows: ViewRow[],
  key: string | null | undefined,
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const current = Math.max(0, selectedIndexForKey(rows, key));
  const index = Math.min(Math.max(0, current + delta), rows.length - 1);
  return rows[index]?.key ?? null;
}

/**
 * 删除后选中项落到原位置的下一条（没有下一条则上一条）。
 * `rows` 是删除前的列表。
 */
export function keyAfterRemoval(rows: ViewRow[], removedKey: string): string | null {
  const index = selectedIndexForKey(rows, removedKey);
  const remaining = rows.filter((row) => row.key !== removedKey);
  if (remaining.length === 0) return null;
  const target = Math.min(Math.max(0, index), remaining.length - 1);
  return remaining[target]?.key ?? null;
}

/** 纯函数：就地重命名（返回新数组；未命中时原样返回） */
export function renameSessionInList(
  sessions: SessionInfo[],
  sessionId: string,
  title: string,
): SessionInfo[] {
  return sessions.map((session) =>
    session.session_id === sessionId ? { ...session, title } : session,
  );
}

/** 纯函数：从列表移除会话（返回新数组） */
export function removeSessionFromList(sessions: SessionInfo[], sessionId: string): SessionInfo[] {
  return sessions.filter((session) => session.session_id !== sessionId);
}
