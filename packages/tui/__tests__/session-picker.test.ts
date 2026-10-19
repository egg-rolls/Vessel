import { describe, expect, it } from 'bun:test';
import type { SessionInfo } from '@vessel/core';
import {
  buildSessionPickerView,
  buildSessionRows,
  clampSelectedKey,
  filterSessions,
  keyAfterRemoval,
  moveSelectedKey,
  removeSessionFromList,
  renameSessionInList,
  selectedIndexForKey,
  sessionColumns,
  sessionPickerActions,
  shortSessionId,
  sortSessionsForPicker,
} from '../src/views/session-picker.js';

const NOW = 1_700_000_000_000;

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: 's_old',
    title: 'Old session',
    preview: 'old preview',
    status: 'completed',
    started_at: NOW - 10_000,
    updated_at: NOW - 10_000,
    message_count: 4,
    ...overrides,
  };
}

const SESSIONS: SessionInfo[] = [
  session({ session_id: 's_old', title: 'Old', updated_at: NOW - 2 * 60 * 60 * 1000 }),
  session({
    session_id: 's_new',
    title: 'New',
    preview: 'new preview',
    branch: 'feat/auth',
    updated_at: NOW - 1_000,
    message_count: 2,
  }),
  session({
    session_id: 's_tie_a',
    title: 'Tie A',
    preview: 'tie preview a',
    updated_at: NOW - 1_000,
  }),
  session({
    session_id: 's_tie_b',
    title: 'Tie B',
    preview: 'tie preview b',
    updated_at: NOW - 1_000,
  }),
];

describe('sortSessionsForPicker', () => {
  it('updated_at 倒序，同值 session_id 升序', () => {
    const sorted = sortSessionsForPicker(SESSIONS);
    expect(sorted.map((item) => item.session_id)).toEqual(['s_new', 's_tie_a', 's_tie_b', 's_old']);
  });

  it('不修改输入数组', () => {
    const input = [...SESSIONS];
    sortSessionsForPicker(input);
    expect(input.map((item) => item.session_id)).toEqual(SESSIONS.map((item) => item.session_id));
  });
});

describe('buildSessionRows', () => {
  it('标记 current 并追加 (active)，消息数与相对时间正确', () => {
    const rows = buildSessionRows(SESSIONS, 's_new', NOW);
    const current = rows.find((row) => row.key === 's_new');
    expect(current?.current).toBe(true);
    expect(current?.tone).toBe('ok');
    expect(current?.cells.title).toBe('New (active)');
    expect(current?.cells.msgs).toBe('2');
    expect(current?.cells.updated).toBe('1s ago');
    expect(current?.cells.branch).toBe('feat/auth');

    const old = rows.find((row) => row.key === 's_old');
    expect(old?.current).toBe(false);
    expect(old?.cells.updated).toBe('2h ago');
  });

  it('updated_at <= 0 显示 -，空标题回退 preview 再回退 (untitled)', () => {
    const rows = buildSessionRows(
      [
        session({ session_id: 'a', title: '', preview: 'only preview', updated_at: 0 }),
        session({ session_id: 'b', title: '', preview: '', updated_at: 0 }),
      ],
      undefined,
      NOW,
    );
    expect(rows.find((row) => row.key === 'a')?.cells.title).toBe('only preview');
    expect(rows.find((row) => row.key === 'a')?.cells.updated).toBe('-');
    expect(rows.find((row) => row.key === 'b')?.cells.title).toBe('(untitled)');
  });
});

describe('shortSessionId', () => {
  it('长 id 截断到 12 个字符并保留 …', () => {
    expect(shortSessionId('20260101_120000_abc123')).toBe('20260101_12…');
    expect(shortSessionId('short')).toBe('short');
  });
});

describe('filterSessions', () => {
  it('匹配 title / preview / id / branch，大小写不敏感', () => {
    expect(filterSessions(SESSIONS, 'feat/auth').map((item) => item.session_id)).toEqual(['s_new']);
    expect(filterSessions(SESSIONS, 'NEW PREVIEW').map((item) => item.session_id)).toEqual([
      's_new',
    ]);
    expect(filterSessions(SESSIONS, 's_tie_a').map((item) => item.session_id)).toEqual(['s_tie_a']);
    expect(filterSessions(SESSIONS, 'old').map((item) => item.session_id)).toEqual(['s_old']);
  });

  it('中文过滤与空过滤', () => {
    const sessions = [
      session({ session_id: 'zh', title: '修复登录问题', preview: '中文预览' }),
      session({ session_id: 'en', title: 'Fix auth' }),
    ];
    expect(filterSessions(sessions, '登录').map((item) => item.session_id)).toEqual(['zh']);
    expect(filterSessions(sessions, '中文').map((item) => item.session_id)).toEqual(['zh']);
    expect(filterSessions(sessions, '  ')).toHaveLength(2);
    expect(filterSessions(sessions, 'nope')).toHaveLength(0);
  });
});

describe('sessionColumns', () => {
  it('80/100/120 列分别显示 id / branch / status', () => {
    expect(sessionColumns(60).map((column) => column.key)).toEqual(['title', 'msgs', 'updated']);
    expect(sessionColumns(80).map((column) => column.key)).toEqual([
      'title',
      'id',
      'msgs',
      'updated',
    ]);
    expect(sessionColumns(100).map((column) => column.key)).toEqual([
      'title',
      'id',
      'msgs',
      'updated',
      'branch',
    ]);
    expect(sessionColumns(120).map((column) => column.key)).toEqual([
      'title',
      'id',
      'msgs',
      'updated',
      'branch',
      'status',
    ]);
  });

  it('title 永远第一个，数字列右对齐', () => {
    for (const columns of [60, 80, 100, 120]) {
      expect(sessionColumns(columns)[0]?.key).toBe('title');
    }
    expect(sessionColumns(80).find((column) => column.key === 'msgs')?.align).toBe('right');
  });
});

describe('buildSessionPickerView', () => {
  it('默认选中第一行并带 meta / actions', () => {
    const view = buildSessionPickerView({
      sessions: SESSIONS,
      currentSessionId: 's_new',
      columns: 100,
      now: NOW,
    });
    expect(view.kind).toBe('table');
    expect(view.title).toBe('Resume session');
    expect(view.initialKey).toBe('s_new');
    expect(view.meta).toBe('4');
    expect(view.rows).toHaveLength(4);
    expect(view.actions?.map((action) => action.id)).toEqual([
      'resume',
      'rename',
      'delete',
      'refresh',
    ]);
  });

  it('过滤后保留选中 key（若仍存在）并显示 /总数', () => {
    const view = buildSessionPickerView({
      sessions: SESSIONS,
      currentSessionId: 's_new',
      columns: 80,
      filter: 'feat',
      selectedKey: 's_new',
      now: NOW,
    });
    expect(view.rows.map((row) => row.key)).toEqual(['s_new']);
    expect(view.initialKey).toBe('s_new');
    expect(view.meta).toBe('1/4');
  });

  it('过滤空结果显示 emptyText', () => {
    const view = buildSessionPickerView({
      sessions: SESSIONS,
      filter: 'no-such-session',
      now: NOW,
    });
    expect(view.rows).toHaveLength(0);
    expect(view.emptyText).toBe('No matching sessions');
  });

  it('current 的 delete 动作是 not-current', () => {
    const deleteAction = sessionPickerActions().find((action) => action.id === 'delete');
    expect(deleteAction?.enabled).toBe('not-current');
    expect(deleteAction?.confirm).toContain('{name}');
  });
});

describe('选中 key 维护', () => {
  const rows = buildSessionRows(SESSIONS, undefined, NOW);

  it('selectedIndexForKey / clampSelectedKey', () => {
    expect(selectedIndexForKey(rows, 's_tie_a')).toBeGreaterThanOrEqual(0);
    expect(selectedIndexForKey(rows, 'missing')).toBe(-1);
    expect(clampSelectedKey(rows, 's_old')).toBe('s_old');
    expect(clampSelectedKey(rows, 'missing', 0)).toBe(rows[0]?.key ?? null);
    expect(clampSelectedKey([], 'x')).toBeNull();
  });

  it('moveSelectedKey 钳制在有效范围', () => {
    const first = rows[0]?.key ?? null;
    expect(moveSelectedKey(rows, first, -1)).toBe(first);
    expect(moveSelectedKey(rows, first, 1)).toBe(rows[1]?.key ?? null);
    expect(moveSelectedKey(rows, first, 99)).toBe(rows[rows.length - 1]?.key ?? null);
    expect(moveSelectedKey([], first, 1)).toBeNull();
  });

  it('删除后选中项落到原位置的下一条', () => {
    const keys = rows.map((row) => row.key);
    const removed = keys[1];
    if (!removed) throw new Error('expected row');
    expect(keyAfterRemoval(rows, removed)).toBe(keys[2] ?? null);
    const last = keys[keys.length - 1];
    if (!last) throw new Error('expected row');
    expect(keyAfterRemoval(rows, last)).toBe(keys[keys.length - 2] ?? null);
  });
});

describe('列表变换', () => {
  it('renameSessionInList / removeSessionFromList 返回新数组', () => {
    const renamed = renameSessionInList(SESSIONS, 's_old', 'Renamed');
    expect(renamed.find((item) => item.session_id === 's_old')?.title).toBe('Renamed');
    expect(SESSIONS.find((item) => item.session_id === 's_old')?.title).toBe('Old');

    const removed = removeSessionFromList(SESSIONS, 's_old');
    expect(removed.map((item) => item.session_id)).not.toContain('s_old');
  });
});
