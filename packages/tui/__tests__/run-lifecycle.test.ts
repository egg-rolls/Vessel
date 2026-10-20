/**
 * 运行期状态与取消语义测试
 */

import { describe, expect, it } from 'bun:test';
import { executeTurn } from '../src/repl/run-turn.js';
import { initialReplUiState, type ReplUiState, replUiReducer } from '../src/repl/use-repl-state.js';
import { makeCtx } from './helpers.js';

function initialState(): ReplUiState {
  return initialReplUiState(makeCtx());
}

function withPermission(state: ReplUiState, requestId = 'req-1'): ReplUiState {
  return replUiReducer(state, {
    type: 'setPermissionOverlay',
    overlay: {
      requestId,
      run_id: 'run-1',
      toolName: 'bash',
      input: { command: 'ls' },
    },
  });
}

describe('run UI lifecycle', () => {
  it('初始为 idle', () => {
    expect(initialState().run).toEqual({ phase: 'idle', abort: null });
  });

  it('runStart -> running，runEnd -> idle', () => {
    const abort = new AbortController();
    let state = replUiReducer(initialState(), { type: 'runStart', abort });
    expect(state.run.phase).toBe('running');
    expect(state.run.abort).toBe(abort);

    state = replUiReducer(state, { type: 'runEnd' });
    expect(state.run).toEqual({ phase: 'idle', abort: null });
  });

  it('runCancelRequested 只从 running 进入 cancelling', () => {
    const abort = new AbortController();
    const idle = initialState();
    expect(replUiReducer(idle, { type: 'runCancelRequested' }).run.phase).toBe('idle');

    let state = replUiReducer(idle, { type: 'runStart', abort });
    state = replUiReducer(state, { type: 'runCancelRequested' });
    expect(state.run.phase).toBe('cancelling');
    // 重复取消不改变状态
    expect(replUiReducer(state, { type: 'runCancelRequested' })).toBe(state);
  });
});

describe('permission overlay cleanup', () => {
  it('按 requestId 只清匹配的请求', () => {
    const state = withPermission(initialState(), 'req-1');
    expect(replUiReducer(state, { type: 'clearPermissionForRequest', requestId: 'other' })).toBe(
      state,
    );
    expect(
      replUiReducer(state, { type: 'clearPermissionForRequest', requestId: 'req-1' })
        .permissionOverlay,
    ).toBeNull();
  });

  it('run 结束时按 run_id 清理', () => {
    const state = withPermission(initialState());
    expect(replUiReducer(state, { type: 'clearPermissionForRun', runId: 'other' })).toBe(state);
    expect(
      replUiReducer(state, { type: 'clearPermissionForRun', runId: 'run-1' }).permissionOverlay,
    ).toBeNull();
  });

  it('工具失败时按 run_id + tool 清理（权限 waitFor 超时路径）', () => {
    const state = withPermission(initialState());
    expect(
      replUiReducer(state, {
        type: 'clearPermissionForTool',
        runId: 'run-1',
        toolName: 'edit',
      }),
    ).toBe(state);
    expect(
      replUiReducer(state, {
        type: 'clearPermissionForTool',
        runId: 'run-1',
        toolName: 'bash',
      }).permissionOverlay,
    ).toBeNull();
  });

  it('ask-user 激活时记录 requestId / runId，关闭时清空', () => {
    let state = replUiReducer(initialState(), {
      type: 'setAskUserActive',
      active: true,
      requestId: 'ask-1',
      runId: 'run-1',
    });
    expect(state.askUserActive).toBe(true);
    expect(state.askUserRequestId).toBe('ask-1');
    expect(state.askUserRunId).toBe('run-1');

    state = replUiReducer(state, { type: 'setAskUserActive', active: false });
    expect(state.askUserRequestId).toBeNull();
    expect(state.askUserRunId).toBeNull();
  });
});

describe('executeTurn', () => {
  it('把 signal 传给 run', async () => {
    const abort = new AbortController();
    let received: AbortSignal | undefined;
    await executeTurn({
      abort,
      run: async (signal) => {
        received = signal;
      },
    });
    expect(received).toBe(abort.signal);
  });

  it('abort 后即使抛非 AbortError 也判为 cancelled', async () => {
    const abort = new AbortController();
    const outcome = await executeTurn({
      abort,
      run: async () => {
        abort.abort(new Error('Run cancelled by user'));
        throw new Error('something else');
      },
    });
    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('未 abort 的失败 -> failed 并带回原始错误', async () => {
    const abort = new AbortController();
    const error = new Error('boom');
    const outcome = await executeTurn({
      abort,
      run: async () => {
        throw error;
      },
    });
    expect(outcome).toEqual({ status: 'failed', error });
  });
});
