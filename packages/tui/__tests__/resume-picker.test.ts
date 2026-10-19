import { describe, expect, it } from 'bun:test';
import { loadResumeSessions } from '../src/repl/resume-picker.js';
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

describe('loadResumeSessions', () => {
  it('成功时返回按 updated_at 倒序的 sessions', async () => {
    const rpc = makeRpc(() => ({ sessions: SESSIONS }));
    const result = await loadResumeSessions(makeCtx({ rpc }));

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.sessions.map((session) => session.session_id)).toEqual(['s_new', 's_old']);
    expect(rpc.calls[0]?.method).toBe('sessions.list');
  });

  it('sessions.list 失败时返回 error 而不 reject', async () => {
    const rpc = makeRpc(() => {
      throw { code: 'internal', message: 'boom' };
    });
    const result = await loadResumeSessions(makeCtx({ rpc }));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.message).toContain('✗ [internal] boom');
  });
});
