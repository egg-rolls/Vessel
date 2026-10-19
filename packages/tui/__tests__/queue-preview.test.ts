import { describe, expect, it } from 'bun:test';
import { formatQueuePreview, getQueueWindow } from '../src/components/QueuePreview.js';
import { initialReplUiState, type ReplUiState, replUiReducer } from '../src/repl/use-repl-state.js';
import { makeCtx } from './helpers.js';

function withQueue(values: string[]): ReplUiState {
  let state = initialReplUiState(makeCtx());
  for (const value of values) {
    state = replUiReducer(state, { type: 'enqueueInput', value });
  }
  return state;
}

describe('getQueueWindow', () => {
  it('编辑项始终落在 3 条窗口内', () => {
    expect(getQueueWindow(6, 0)).toEqual({
      start: 0,
      end: 3,
      showLead: false,
      showTail: true,
    });
    expect(getQueueWindow(6, 4)).toEqual({
      start: 3,
      end: 6,
      showLead: true,
      showTail: false,
    });
  });
});

describe('queue editing reducer', () => {
  it('删除只移除当前编辑项，不误删队首', () => {
    let state = withQueue(['a', 'b', 'c']);
    state = replUiReducer(state, { type: 'beginQueueEdit', index: 1, returnInput: '' });
    state = replUiReducer(state, { type: 'removeQueuedInput', index: 1 });

    expect(state.queuedInput).toEqual(['a', 'c']);
    expect(state.queueEditIndex).toBeNull();
  });

  it('保存只替换当前编辑项', () => {
    let state = withQueue(['a', 'b', 'c']);
    state = replUiReducer(state, { type: 'beginQueueEdit', index: 1, returnInput: '' });
    state = replUiReducer(state, { type: 'updateQueuedInput', index: 1, value: 'B' });

    expect(state.queuedInput).toEqual(['a', 'B', 'c']);
    expect(state.queueEditIndex).toBeNull();
  });

  it('Esc 取消编辑恢复进入前的草稿', () => {
    let state = withQueue(['a', 'b']);
    state = replUiReducer(state, { type: 'beginQueueEdit', index: 0, returnInput: 'draft' });
    state = replUiReducer(state, { type: 'cancelQueueEdit' });

    expect(state.input).toBe('draft');
    expect(state.queueEditIndex).toBeNull();
    expect(state.queuedInput).toEqual(['a', 'b']);
  });
});

describe('formatQueuePreview', () => {
  it('rows < 12 只显示一行', () => {
    const lines = formatQueuePreview(['a', 'b', 'c', 'd'], null, 80, 10);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain('▸ 1.');
  });

  it('超过 3 条时显示尾行，且不丢当前编辑项', () => {
    const lines = formatQueuePreview(['a', 'b', 'c', 'd'], 0, 80, 24);
    const text = lines.map((line) => line.text).join('\n');

    expect(text).toContain('queued (4) · editing 1');
    expect(text).toContain('▸ 1. a');
    expect(text).toContain('…and 1 more');
  });
});
