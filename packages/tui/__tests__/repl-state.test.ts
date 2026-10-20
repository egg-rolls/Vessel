import { describe, expect, it } from 'bun:test';
import type { SessionInfo } from '@vessel/core';
import { initialReplUiState, replUiReducer } from '../src/repl/use-repl-state.js';
import { makeCtx } from './helpers.js';

const ctx = makeCtx();

const session: SessionInfo = {
  session_id: 's1',
  title: 'One',
  preview: 'preview',
  status: 'completed',
  started_at: 1_000,
  updated_at: 2_000,
  message_count: 2,
};

describe('resume picker reducer', () => {
  it('loading -> ready 保存会话并清除错误', () => {
    const loading = replUiReducer(initialReplUiState(ctx), { type: 'resumePickerLoading' });
    expect(loading.resumeStatus).toBe('loading');

    const ready = replUiReducer(loading, { type: 'resumePickerReady', sessions: [session] });
    expect(ready.resumeStatus).toBe('ready');
    expect(ready.resumeError).toBeNull();
    expect(ready.resumeSessions).toEqual([session]);
  });

  it('loading -> error 保留错误（不伪装成空列表）', () => {
    const state = replUiReducer(initialReplUiState(ctx), {
      type: 'resumePickerError',
      message: '✗ [internal] boom',
    });
    expect(state.resumeStatus).toBe('error');
    expect(state.resumeError).toBe('✗ [internal] boom');
    expect(state.resumeSessions).toEqual([]);
  });

  it('retry 回到 loading 并递增 reload token', () => {
    const errored = replUiReducer(initialReplUiState(ctx), {
      type: 'resumePickerError',
      message: 'boom',
    });
    const retried = replUiReducer(errored, { type: 'resumePickerRetry' });

    expect(retried.resumeStatus).toBe('loading');
    expect(retried.resumeError).toBeNull();
    expect(retried.resumeReloadToken).toBe(errored.resumeReloadToken + 1);
  });

  it('reset 清空会话、错误并回到 idle', () => {
    const ready = replUiReducer(initialReplUiState(ctx), {
      type: 'resumePickerReady',
      sessions: [session],
    });
    const reset = replUiReducer(ready, { type: 'resumePickerReset' });

    expect(reset.resumeStatus).toBe('idle');
    expect(reset.resumeError).toBeNull();
    expect(reset.resumeSessions).toEqual([]);
  });
});

describe('history archive', () => {
  it('appendHistory 支持 markdown 标记，默认纯文本', () => {
    let state = replUiReducer(initialReplUiState(ctx), { type: 'appendHistory', line: '# hi' });
    state = replUiReducer(state, { type: 'appendHistory', line: '# hi', markdown: true });

    expect(state.history).toEqual([{ text: '# hi' }, { text: '# hi', markdown: true }]);
  });

  it('appendHistoryLines 默认纯文本，可整体标记 markdown', () => {
    let state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistoryLines',
      lines: ['a', 'b'],
    });
    state = replUiReducer(state, {
      type: 'appendHistoryLines',
      lines: ['**c**'],
      markdown: true,
    });

    expect(state.history).toEqual([
      { text: 'a' },
      { text: 'b' },
      { text: '**c**', markdown: true },
    ]);
  });

  it('归档前清洗控制序列，空行也保留', () => {
    const state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistoryLines',
      lines: ['a\x1b[31mb', '', 'c\r\nd'],
    });

    expect(state.history).toEqual([{ text: 'ab' }, { text: '' }, { text: 'c\nd' }]);
  });

  it('error tone / fullText 在归档后保留，且不会复制成两条', () => {
    const state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistory',
      line: '✗ [api] boom',
      tone: 'error',
      fullText: '✗ [api] boom\nmore',
    });

    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toEqual({
      text: '✗ [api] boom',
      tone: 'error',
      fullText: '✗ [api] boom\nmore',
    });
  });

  it('clearHistory 清空归档', () => {
    const filled = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistory',
      line: 'x',
    });
    expect(replUiReducer(filled, { type: 'clearHistory' }).history).toEqual([]);
  });
});
