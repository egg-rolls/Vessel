import { describe, expect, it } from 'bun:test';
import type { CommandResult } from '../src/commands/commands.js';
import {
  deleteSessionAction,
  formatSessions,
  getSessionState,
  listSessions,
  renameSessionAction,
  runSessionsCommand,
  SESSIONS_DEPRECATION,
  sessionActionResult,
  sessionsCommand,
  sortSessions,
} from '../src/commands/sessions-command.js';
import type { RpcClientLike } from '../src/repl-context.js';
import { displayWidth } from '../src/utils/text-layout.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

const SESSIONS = [
  {
    session_id: 's_old',
    title: 'Old',
    preview: 'old preview',
    status: 'completed',
    started_at: NOW - 10_000,
    updated_at: NOW - 10_000,
    message_count: 4,
  },
  {
    session_id: 's_new',
    title: 'New',
    preview: 'new preview',
    status: 'running',
    started_at: NOW - 1_000,
    updated_at: NOW - 1_000,
    message_count: 2,
  },
];

function makeRpc(
  handler: (method: string, params?: unknown) => unknown,
): RpcClientLike & { calls: Array<{ method: string; params?: unknown }> } {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    calls,
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, ...(params !== undefined ? { params } : {}) });
      return (await handler(method, params)) as T;
    },
    subscribe: () => () => undefined,
  };
}

describe('deleteSessionAction', () => {
  it('需要 --yes，未确认不发请求', async () => {
    let called = 0;
    const rpc = makeRpc((method) => {
      if (method === 'sessions.delete') called += 1;
      return {};
    });
    const result = await deleteSessionAction(makeCtx({ rpc }), 's_old', {
      confirmed: false,
      currentSessionId: 's_new',
    });
    expect(result.output).toContain('Add --yes to confirm');
    expect(called).toBe(0);
  });

  it('拒绝删除当前会话（即使带 --yes）', async () => {
    const rpc = makeRpc(() => ({}));
    const result = await deleteSessionAction(makeCtx({ rpc }), 's_new', {
      confirmed: true,
      currentSessionId: 's_new',
    });
    expect(result.output).toContain('Refusing to delete the current session');
    expect(rpc.calls).toHaveLength(0);
  });

  it('成功显示三项计数', async () => {
    const rpc = makeRpc(() => ({
      sessions_deleted: 1,
      runs_deleted: 2,
      events_deleted: 3,
    }));
    const result = await deleteSessionAction(makeCtx({ rpc }), 's_old', {
      confirmed: true,
      currentSessionId: 's_new',
    });
    expect(result.output).toContain('Deleted session "s_old".');
    expect(result.output).toContain('sessions: 1, runs: 2, events: 3');
    expect(rpc.calls[0]).toEqual({
      method: 'sessions.delete',
      params: { session_id: 's_old' },
    });
  });

  it('conflict 按 code 展示', async () => {
    const rpc = makeRpc(() => {
      throw { code: 'conflict', message: 'session has running run(s)' };
    });
    const result = await deleteSessionAction(makeCtx({ rpc }), 's_old', {
      confirmed: true,
      currentSessionId: 's_new',
    });
    expect(result.output).toContain('✗ [conflict] session has running run(s)');
    expect(sessionActionResult(result)).toEqual({
      ok: false,
      message: expect.stringContaining('[conflict]'),
    });
  });

  it('成功结果可归一为 { ok: true }', async () => {
    const rpc = makeRpc(() => ({ sessions_deleted: 1 }));
    const result = await deleteSessionAction(makeCtx({ rpc }), 's_old', {
      confirmed: true,
      currentSessionId: 's_new',
    });
    expect(sessionActionResult(result).ok).toBe(true);
  });
});

describe('renameSessionAction', () => {
  it('透传 id 与 title', async () => {
    const rpc = makeRpc(() => ({}));
    const result = await renameSessionAction(makeCtx({ rpc }), 's_old', 'My renamed session');
    expect(result.output).toContain('Renamed session "s_old" to "My renamed session".');
    expect(rpc.calls[0]).toEqual({
      method: 'sessions.rename',
      params: { session_id: 's_old', title: 'My renamed session' },
    });
  });

  it('空标题拒绝且不发请求', async () => {
    let called = 0;
    const rpc = makeRpc(() => {
      called += 1;
      return {};
    });
    const result = await renameSessionAction(makeCtx({ rpc }), 's_old', '   ');
    expect(result.output).toContain('Usage: /resume rename');
    expect(called).toBe(0);
  });

  it('无 RPC 时给出明确提示', async () => {
    const result = await renameSessionAction(makeCtx(), 's_old', 'New');
    expect(result.output).toContain('Renaming sessions requires the RPC control plane');
  });
});

describe('/sessions deprecated alias', () => {
  it('list 打印迁移提示并转入 /resume 选择器状态', async () => {
    const rpc = makeRpc(() => ({ sessions: SESSIONS }));
    const ctx = makeCtx({ rpc });
    const entry = sessionsCommand();
    const state = {
      currentSessionId: 's_new',
      pendingResume: false,
      showResumePicker: false,
      running: true,
    };
    const result = await entry.run(['list'], ctx, state);
    expect(result.output).toContain(SESSIONS_DEPRECATION);
    expect(result.nextState).toEqual({ showResumePicker: true, pendingResume: true });
  });

  it('delete/rename 转调同一 action，并保留迁移提示', async () => {
    const rpc = makeRpc((method) => {
      if (method === 'sessions.delete') {
        return { sessions_deleted: 1, runs_deleted: 0, events_deleted: 0 };
      }
      return {};
    });
    const ctx = makeCtx({ rpc, currentSessionId: 's_new' });
    const entry = sessionsCommand();
    const state = {
      currentSessionId: 's_new',
      pendingResume: false,
      showResumePicker: false,
      running: true,
    };

    const deleted = await entry.run(['delete', 's_old', '--yes'], ctx, state);
    expect(deleted.output).toContain(SESSIONS_DEPRECATION);
    expect(deleted.output).toContain('Deleted session "s_old".');

    const renamed = await entry.run(['rename', 's_old', 'New title'], ctx, state);
    expect(renamed.output).toContain(SESSIONS_DEPRECATION);
    expect(renamed.output).toContain('Renamed session "s_old" to "New title".');
  });

  it('未知子命令的 usage 指向 /resume', async () => {
    const result = await runSessionsCommand(['nope'], makeCtx(), 's_new');
    expect(result.output).toContain('Usage: /resume');
  });

  it('runSessionsCommand list 不再打印旧表格，而是请求 picker', async () => {
    const result = await runSessionsCommand(['list'], makeCtx(), 's_new');
    expect(result.output).toContain('Resume which session?');
    expect((result as CommandResult).nextState).toEqual({
      showResumePicker: true,
      pendingResume: true,
    });
  });
});

describe('session helpers', () => {
  it('listSessions 接受裸数组', async () => {
    const rpc = makeRpc(() => SESSIONS);
    const sessions = await listSessions(makeCtx({ rpc }));
    expect(sessions.map((session) => session.session_id)).toEqual(['s_new', 's_old']);
  });

  it('getSessionState 读取 messages；not_found 返回 null', async () => {
    const rpc = makeRpc((_method, params) => {
      const id = (params as { session_id?: string }).session_id;
      if (id === 'missing') throw { code: 'not_found', message: 'missing' };
      return { session: { messages: [{ role: 'user', content: 'hi' }] } };
    });
    const ctx = makeCtx({ rpc });
    expect((await getSessionState(ctx, 's1'))?.messages).toHaveLength(1);
    expect(await getSessionState(ctx, 'missing')).toBeNull();
  });

  it('sortSessions 同 updated_at 按 id 升序', () => {
    const sorted = sortSessions([
      {
        session_id: 'b',
        title: '',
        preview: '',
        status: '',
        started_at: 0,
        updated_at: 1,
        message_count: 0,
      },
      {
        session_id: 'a',
        title: '',
        preview: '',
        status: '',
        started_at: 0,
        updated_at: 1,
        message_count: 0,
      },
    ]);
    expect(sorted.map((session) => session.session_id)).toEqual(['a', 'b']);
  });

  it('formatSessions 空列表', () => {
    expect(formatSessions([], 's1')).toBe('No sessions.');
  });

  it('formatSessions 的 CJK 标题按显示宽度截断且不破坏列', () => {
    const longTitle = '中文标题'.repeat(20);
    const output = formatSessions(
      [
        {
          session_id: 's_zh',
          title: longTitle,
          preview: '',
          status: 'completed',
          started_at: NOW,
          updated_at: NOW - 1_000,
          message_count: 3,
        },
      ],
      's_other',
      NOW,
    );
    const row = output.split('\n').find((line) => line.includes('s_zh'));
    expect(row).toBeDefined();
    if (!row) return;
    // 行首 marker + id(28 列) + msgs(8) + updated(10)；标题被截断到 48 显示列。
    expect(row).toContain('s_zh');
    expect(row).toContain('…');
    expect(displayWidth(row)).toBeLessThan(110);
  });
});
