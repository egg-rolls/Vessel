import { describe, expect, it } from 'bun:test';
import {
  formatSessions,
  getSessionState,
  listSessions,
  runSessionsCommand,
  sortSessions,
} from '../src/commands/sessions-command.js';
import type { RpcClientLike } from '../src/repl-context.js';
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

describe('/sessions', () => {
  it('list 按 updated_at 倒序并标记当前会话', async () => {
    const rpc = makeRpc(() => ({ sessions: SESSIONS }));
    const ctx = makeCtx({ rpc, currentSessionId: 's_new' });
    const result = await runSessionsCommand(['list'], ctx, 's_new');
    const output = result.output ?? '';

    expect(output).toContain('Sessions (2, newest first):');
    expect(output.indexOf('s_new')).toBeLessThan(output.indexOf('s_old'));
    expect(output).toContain('* s_new');
    expect(output).toContain('New');
  });

  it('delete 需要 --yes，未确认不发请求', async () => {
    let called = 0;
    const rpc = makeRpc((method) => {
      if (method === 'sessions.delete') called += 1;
      return {};
    });
    const result = await runSessionsCommand(['delete', 's_old'], makeCtx({ rpc }), 's_new');
    expect(result.output).toContain('Add --yes to confirm');
    expect(called).toBe(0);
  });

  it('delete 拒绝删除当前会话', async () => {
    const rpc = makeRpc(() => ({}));
    const result = await runSessionsCommand(
      ['delete', 's_new', '--yes'],
      makeCtx({ rpc }),
      's_new',
    );
    expect(result.output).toContain('Refusing to delete the current session');
  });

  it('delete 成功显示三项计数', async () => {
    const rpc = makeRpc(() => ({
      sessions_deleted: 1,
      runs_deleted: 2,
      events_deleted: 3,
    }));
    const result = await runSessionsCommand(
      ['delete', 's_old', '--yes'],
      makeCtx({ rpc }),
      's_new',
    );
    expect(result.output).toContain('Deleted session "s_old".');
    expect(result.output).toContain('sessions: 1, runs: 2, events: 3');
    expect(rpc.calls[0]).toEqual({
      method: 'sessions.delete',
      params: { session_id: 's_old' },
    });
  });

  it('delete 遇到 conflict 按 code 展示', async () => {
    const rpc = makeRpc(() => {
      throw { code: 'conflict', message: 'session has running run(s)' };
    });
    const result = await runSessionsCommand(
      ['delete', 's_old', '--yes'],
      makeCtx({ rpc }),
      's_new',
    );
    expect(result.output).toContain('✗ [conflict] session has running run(s)');
  });

  it('rename 透传 id 与 title', async () => {
    const rpc = makeRpc(() => ({}));
    const result = await runSessionsCommand(
      ['rename', 's_old', 'My', 'renamed', 'session'],
      makeCtx({ rpc }),
      's_new',
    );
    expect(result.output).toContain('Renamed session "s_old" to "My renamed session".');
    expect(rpc.calls[0]).toEqual({
      method: 'sessions.rename',
      params: { session_id: 's_old', title: 'My renamed session' },
    });
  });

  it('rename 缺少 title 给 usage', async () => {
    const result = await runSessionsCommand(['rename', 's_old'], makeCtx(), 's_new');
    expect(result.output).toContain('Usage: /sessions rename');
  });

  it('未知子命令给 usage', async () => {
    const result = await runSessionsCommand(['nope'], makeCtx(), 's_new');
    expect(result.output).toContain('Usage: /sessions');
  });
});

describe('session helpers', () => {
  it('listSessions 接受裸数组', async () => {
    const rpc = makeRpc(() => SESSIONS);
    const sessions = await listSessions(makeCtx({ rpc }));
    expect(sessions.map((session) => session.session_id)).toEqual(['s_new', 's_old']);
  });

  it('listSessions 无 rpc 时退回 SessionBackend', async () => {
    const ctx = makeCtx();
    const sessions = await listSessions(ctx);
    expect(Array.isArray(sessions)).toBe(true);
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
});
