import { describe, expect, it } from 'bun:test';
import type { SessionInfo } from '@vessel-agent/core';
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

describe('history archive（0.18：UiItem）', () => {
  it('appendHistory 生成 command item，并分配单调 id', () => {
    let state = replUiReducer(initialReplUiState(ctx), { type: 'appendHistory', line: '# hi' });
    state = replUiReducer(state, { type: 'appendHistory', line: 'second' });

    expect(state.history).toEqual([
      { item: { kind: 'command', id: 'h_1', text: '# hi' } },
      { item: { kind: 'command', id: 'h_2', text: 'second' } },
    ]);
  });

  it('appendItem / appendItems 保留结构化 item', () => {
    let state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendItem',
      item: { kind: 'user', text: 'hello', at: 1 },
    });
    state = replUiReducer(state, {
      type: 'appendItems',
      items: [
        { kind: 'assistant', id: 'a1', text: 'hi', at: 2 },
        { kind: 'run', id: 'r1', runId: 'run', status: 'completed', toolCount: 0 },
      ],
    });

    expect(state.history).toEqual([
      { item: { kind: 'user', id: 'h_1', text: 'hello', at: 1 } },
      { item: { kind: 'assistant', id: 'a1', text: 'hi', at: 2 } },
      { item: { kind: 'run', id: 'r1', runId: 'run', status: 'completed', toolCount: 0 } },
    ]);
    expect(state.itemSeq).toBe(1);
  });

  it('appendHistoryLines 按顺序生成 item', () => {
    const state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistoryLines',
      lines: ['a', 'b'],
    });

    expect(state.history).toEqual([
      { item: { kind: 'command', id: 'h_1', text: 'a' } },
      { item: { kind: 'command', id: 'h_2', text: 'b' } },
    ]);
  });

  it('brand tone 映射为 command.tone=brand（启动头保留暗金）', () => {
    const state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistoryLines',
      lines: ['wordmark', 'tagline'],
      tone: 'brand',
    });

    expect(state.history).toEqual([
      { item: { kind: 'command', id: 'h_1', text: 'wordmark', tone: 'brand' } },
      { item: { kind: 'command', id: 'h_2', text: 'tagline', tone: 'brand' } },
    ]);
  });

  it('归档前清洗控制序列，空行也保留', () => {
    const state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistoryLines',
      lines: ['a\x1b[31mb', '', 'c\r\nd'],
    });

    expect(state.history.map((entry) => entry.item)).toEqual([
      { kind: 'command', id: 'h_1', text: 'ab' },
      { kind: 'command', id: 'h_2', text: '' },
      { kind: 'command', id: 'h_3', text: 'c\nd' },
    ]);
  });

  it('error tone 使用 fullText 作为完整载荷，且不会复制成两条', () => {
    const state = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistory',
      line: '✗ [api] boom',
      tone: 'error',
      fullText: '✗ [api] boom\nmore',
    });

    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toEqual({
      item: { kind: 'error', id: 'h_1', text: '✗ [api] boom\nmore' },
    });
  });

  it('clearHistory 清空归档但不回退 id 序号', () => {
    const filled = replUiReducer(initialReplUiState(ctx), {
      type: 'appendHistory',
      line: 'x',
    });
    const cleared = replUiReducer(filled, { type: 'clearHistory' });
    expect(cleared.history).toEqual([]);
    expect(cleared.itemSeq).toBe(1);
  });
});
