/** 会话列表的纯选择器/更新函数（可单测，无 React 依赖）。 */
import { localDayKey, localDayLabel } from '../format';
import type { SessionInfo } from '../gateway/types';

export const MAX_SESSION_TITLE = 512;
export const SESSION_PAGE_SIZE = 50;

export type SessionStatusFilter = 'all' | 'running' | 'completed' | 'failed' | 'cancelled';

/** 会话排序：updated_at 倒序，同值 session_id 升序（与 TUI 一致）。 */
export function sortSessions(list: readonly SessionInfo[]): SessionInfo[] {
  return [...list].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    if (a.session_id === b.session_id) return 0;
    return a.session_id < b.session_id ? -1 : 1;
  });
}

/** 行标题回退：title > preview > session_id。 */
export function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.preview?.trim() || session.session_id;
}

/** 校验并归一化重命名输入；空白/超长返回 null。 */
export function normalizeSessionTitle(raw: string): string | null {
  const title = raw.trim();
  if (!title || title.length > MAX_SESSION_TITLE) return null;
  return title;
}

/** 会话状态过滤（未知状态归入 all，不隐藏）。 */
export function matchesSessionStatus(session: SessionInfo, filter: SessionStatusFilter): boolean {
  if (filter === 'all') return true;
  return session.status === filter;
}

export interface SessionFilter {
  query?: string;
  status?: SessionStatusFilter;
}

/** 大小写不敏感地匹配 title / preview / session_id。 */
export function filterSessions(
  list: readonly SessionInfo[],
  { query = '', status = 'all' }: SessionFilter = {},
): SessionInfo[] {
  const needle = query.trim().toLowerCase();
  return list.filter((session) => {
    if (!matchesSessionStatus(session, status)) return false;
    if (!needle) return true;
    return [session.title, session.preview, session.session_id].some((value) =>
      (value ?? '').toLowerCase().includes(needle),
    );
  });
}

export interface SessionDayGroup {
  key: string;
  label: string;
  sessions: SessionInfo[];
}

/**
 * 按本地日历日分组（保持传入顺序；调用方已按 updated_at 倒序）。
 * 只影响渲染，不改变窗口/“显示更多”计数。
 */
export function groupSessionsByDay(
  list: readonly SessionInfo[],
  now: number = Date.now(),
): SessionDayGroup[] {
  const groups: SessionDayGroup[] = [];
  for (const session of list) {
    const key = localDayKey(session.updated_at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.sessions.push(session);
      continue;
    }
    groups.push({ key, label: localDayLabel(session.updated_at, now), sessions: [session] });
  }
  return groups;
}

/** 窗口化：先渲染 `limit` 条，返回被隐藏的数量。 */
export function takeSessions(
  list: readonly SessionInfo[],
  limit: number,
): { shown: SessionInfo[]; hiddenCount: number } {
  if (limit <= 0) return { shown: [], hiddenCount: list.length };
  if (limit >= list.length) return { shown: list.slice(), hiddenCount: 0 };
  return { shown: list.slice(0, limit), hiddenCount: list.length - limit };
}

/** 乐观重命名；失败时由调用方用旧 title 回滚。 */
export function renameSessionInList(
  list: readonly SessionInfo[],
  sessionId: string,
  title: string,
): SessionInfo[] {
  return list.map((session) =>
    session.session_id === sessionId ? { ...session, title } : session,
  );
}

export function removeSessionFromList(
  list: readonly SessionInfo[],
  sessionId: string,
): SessionInfo[] {
  return list.filter((session) => session.session_id !== sessionId);
}

/**
 * 删除当前会话后的落点：
 * - 删除的不是当前会话 → 保持当前选择；
 * - 删除的是当前会话或当前草稿 → 回到无选择的 Chat 空态。
 */
export function selectionAfterDelete(
  currentId: string | null,
  draftId: string | null,
  deletedId: string,
): { selectedId: string | null; draftId: string | null } {
  if (currentId === deletedId) return { selectedId: null, draftId: null };
  if (draftId === deletedId) return { selectedId: currentId, draftId: null };
  return { selectedId: currentId, draftId };
}
