import { describe, expect, it } from 'bun:test';
import { initialReplUiState, replUiReducer } from '../src/repl/use-repl-state.js';
import { makeCtx } from './helpers.js';

const ctx = makeCtx();
const base = initialReplUiState(ctx);

describe('输入历史（↑↓）', () => {
  it('↑ 从最新一条开始，↓ 到底恢复原草稿（丢草稿会让用户输入凭空消失）', () => {
    let state = replUiReducer(base, { type: 'recordInput', value: 'first' });
    state = replUiReducer(state, { type: 'recordInput', value: 'second' });
    state = replUiReducer(state, { type: 'setInput', input: 'draft' });

    state = replUiReducer(state, { type: 'historyPrev' });
    expect(state.input).toBe('second');
    state = replUiReducer(state, { type: 'historyPrev' });
    expect(state.input).toBe('first');
    state = replUiReducer(state, { type: 'historyPrev' });
    expect(state.input).toBe('first');

    state = replUiReducer(state, { type: 'historyNext' });
    expect(state.input).toBe('second');
    state = replUiReducer(state, { type: 'historyNext' });
    expect(state.input).toBe('draft');
    expect(state.historyIndex).toBeNull();
  });

  it('连续重复输入只记一次；手工编辑后 ↑ 从最新开始', () => {
    let state = replUiReducer(base, { type: 'recordInput', value: 'same' });
    state = replUiReducer(state, { type: 'recordInput', value: 'same' });
    expect(state.inputHistory).toEqual(['same']);

    state = replUiReducer(state, { type: 'recordInput', value: 'next' });
    state = replUiReducer(state, { type: 'historyPrev' });
    state = replUiReducer(state, { type: 'historyPrev' });
    expect(state.input).toBe('same');
    state = replUiReducer(state, { type: 'setInput', input: 'edited' });
    state = replUiReducer(state, { type: 'historyPrev' });
    expect(state.input).toBe('next');
  });
});

describe('运行中队列', () => {
  it('FIFO 出队且只出一次（重复出队会连续跑两条）', () => {
    let state = replUiReducer(base, { type: 'enqueueInput', value: 'a' });
    state = replUiReducer(state, { type: 'enqueueInput', value: 'b' });
    expect(state.queuedInput).toEqual(['a', 'b']);

    state = replUiReducer(state, { type: 'dequeueInput' });
    expect(state.queuedInput).toEqual(['b']);
    state = replUiReducer(state, { type: 'dequeueInput' });
    expect(state.queuedInput).toEqual([]);
    state = replUiReducer(state, { type: 'dequeueInput' });
    expect(state.queuedInput).toEqual([]);
  });

  it('空白输入不入队', () => {
    const state = replUiReducer(base, { type: 'enqueueInput', value: '   ' });
    expect(state.queuedInput).toEqual([]);
  });
});

describe('Ctrl+O 展开', () => {
  it('打开时递增 expandSignal；关闭不再刷 scrollback', () => {
    const opened = replUiReducer(base, { type: 'toggleExpanded' });
    expect(opened.expandedOutput).toBe(true);
    expect(opened.expandSignal).toBe(1);

    const closed = replUiReducer(opened, { type: 'toggleExpanded' });
    expect(closed.expandedOutput).toBe(false);
    expect(closed.expandSignal).toBe(1);

    const reopened = replUiReducer(closed, { type: 'toggleExpanded' });
    expect(reopened.expandSignal).toBe(2);
  });
});
