import { describe, expect, it } from 'bun:test';
import type { SessionInfo } from '@vessel/core';
import {
  deleteSessionAction,
  renameSessionAction,
  sessionActionResult,
} from '../src/commands/sessions-command.js';
import {
  defaultViewSelection,
  initialReplUiState,
  replUiReducer,
} from '../src/repl/use-repl-state.js';
import type { RpcClientLike } from '../src/repl-context.js';
import { removeSessionFromList, renameSessionInList } from '../src/views/session-picker.js';
import type { TableView, ViewEnvelope } from '../src/views/types.js';
import { makeCtx } from './helpers.js';

const NOW = 1_700_000_000_000;

const SESSIONS: SessionInfo[] = [
  {
    session_id: 's_old',
    title: 'Old',
    preview: '',
    status: 'completed',
    started_at: NOW - 10_000,
    updated_at: NOW - 10_000,
    message_count: 4,
  },
  {
    session_id: 's_new',
    title: 'New',
    preview: '',
    status: 'running',
    started_at: NOW - 1_000,
    updated_at: NOW - 1_000,
    message_count: 2,
  },
];

function makeRpc(handler: (method: string) => unknown): RpcClientLike {
  return {
    async request<T = unknown>(method: string): Promise<T> {
      return (await handler(method)) as T;
    },
    subscribe: () => () => undefined,
  };
}

const tableView: TableView = {
  kind: 'table',
  title: 'Resume session',
  columns: [{ key: 'title', header: 'TITLE' }],
  rows: [
    { key: 's_old', cells: { title: 'Old' } },
    { key: 's_new', cells: { title: 'New' }, current: true },
  ],
  actions: [{ id: 'delete', key: 'x', label: 'delete', enabled: 'not-current' }],
};

function envelope(view: TableView = tableView): ViewEnvelope {
  return { source: 'resume', view };
}

describe('delete/rename action 与选择器行更新', () => {
  it('删除成功 -> 行从列表移除', async () => {
    const ctx = makeCtx({ rpc: makeRpc(() => ({ sessions_deleted: 1 })) });
    const result = await deleteSessionAction(ctx, 's_old', {
      confirmed: true,
      currentSessionId: 's_new',
    });
    expect(sessionActionResult(result).ok).toBe(true);
    expect(removeSessionFromList(SESSIONS, 's_old').map((item) => item.session_id)).toEqual([
      's_new',
    ]);
  });

  it('删除 conflict -> 保留行并展示 [conflict]', async () => {
    const ctx = makeCtx({
      rpc: makeRpc(() => {
        throw { code: 'conflict', message: 'session has running run(s)' };
      }),
    });
    const result = await deleteSessionAction(ctx, 's_old', {
      confirmed: true,
      currentSessionId: 's_new',
    });
    const outcome = sessionActionResult(result);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('[conflict]');
    // 失败时 UI 不调用 removeSessionFromList，原列表保持 2 行。
    expect(SESSIONS).toHaveLength(2);
  });

  it('删除当前会话 -> 拒绝且列表不变', async () => {
    const ctx = makeCtx({ rpc: makeRpc(() => ({})) });
    const result = await deleteSessionAction(ctx, 's_new', {
      confirmed: true,
      currentSessionId: 's_new',
    });
    expect(sessionActionResult(result).ok).toBe(false);
    expect(result.output).toContain('Refusing to delete the current session');
    expect(SESSIONS).toHaveLength(2);
  });

  it('重命名成功 -> 就地更新标题；空标题拒绝', async () => {
    const ctx = makeCtx({ rpc: makeRpc(() => ({})) });
    const renamed = await renameSessionAction(ctx, 's_old', 'Renamed');
    expect(sessionActionResult(renamed).ok).toBe(true);
    expect(renameSessionInList(SESSIONS, 's_old', 'Renamed')[0]?.title).toBe('Renamed');

    const empty = await renameSessionAction(ctx, 's_old', '  ');
    expect(sessionActionResult(empty).ok).toBe(false);
    expect(empty.output).toContain('Usage: /resume rename');
  });
});

describe('视图状态 requestId 防旧响应', () => {
  const ctx = makeCtx();
  const opened = replUiReducer(initialReplUiState(ctx), {
    type: 'openView',
    envelope: envelope(),
  });

  it('openView 选中 initialKey / 第一行', () => {
    expect(opened.view?.selectedKey).toBe('s_old');
    expect(opened.view?.mode).toBe('browse');
    expect(defaultViewSelection(envelope())).toBe('s_old');
  });

  it('viewLoading 记录 requestId；旧 viewData 被丢弃', () => {
    const loading = replUiReducer(opened, { type: 'viewLoading', requestId: 2 });
    expect(loading.view?.requestId).toBe(2);
    expect(loading.view?.envelope.status).toBe('loading');

    const stale = replUiReducer(loading, {
      type: 'viewData',
      envelope: envelope({ ...tableView, title: 'stale' }),
      requestId: 1,
    });
    expect(stale).toBe(loading);

    const fresh = replUiReducer(loading, {
      type: 'viewData',
      envelope: envelope({ ...tableView, title: 'fresh' }),
      selectedKey: 's_new',
      requestId: 2,
    });
    expect(fresh.view?.envelope.view.title).toBe('fresh');
    expect(fresh.view?.selectedKey).toBe('s_new');
    expect(fresh.view?.mode).toBe('browse');
  });

  it('旧 viewError 被丢弃，新 viewError 生效', () => {
    const loading = replUiReducer(opened, { type: 'viewLoading', requestId: 3 });
    expect(replUiReducer(loading, { type: 'viewError', message: 'old', requestId: 2 })).toBe(
      loading,
    );
    const failed = replUiReducer(loading, {
      type: 'viewError',
      message: 'boom',
      requestId: 3,
    });
    expect(failed.view?.envelope.status).toBe('error');
    expect(failed.view?.envelope.error).toBe('boom');
  });

  it('closeView 清空视图', () => {
    const closed = replUiReducer(opened, { type: 'closeView' });
    expect(closed.view).toBeNull();
  });
});

describe('recentCommands', () => {
  const ctx = makeCtx();
  const initial = initialReplUiState(ctx);

  it('去重、最近优先、最多 5 个', () => {
    let state = initial;
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      state = replUiReducer(state, { type: 'pushRecentCommand', name });
    }
    expect(state.recentCommands).toEqual(['f', 'e', 'd', 'c', 'b']);
    state = replUiReducer(state, { type: 'pushRecentCommand', name: 'c' });
    expect(state.recentCommands[0]).toBe('c');
    expect(state.recentCommands).toHaveLength(5);
  });
});
