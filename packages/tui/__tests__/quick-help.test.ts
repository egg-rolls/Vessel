import { describe, expect, it } from 'bun:test';
import { shouldOpenQuickHelp } from '../src/components/QuickHelp.js';
import { initialReplUiState, replUiReducer } from '../src/repl/use-repl-state.js';
import { makeCtx } from './helpers.js';

describe('shouldOpenQuickHelp', () => {
  it('只在空输入框刚输入 ? 时打开，不吞已有输入里的问号', () => {
    expect(shouldOpenQuickHelp('', '?')).toBe(true);
    expect(shouldOpenQuickHelp('abc', 'abc?')).toBe(false);
    expect(shouldOpenQuickHelp('', 'x')).toBe(false);
    expect(shouldOpenQuickHelp('?', '??')).toBe(false);
  });
});

describe('setQuickHelp', () => {
  it('打开/关闭是幂等的', () => {
    const initial = initialReplUiState(makeCtx());
    const opened = replUiReducer(initial, { type: 'setQuickHelp', open: true });
    expect(opened.quickHelpOpen).toBe(true);
    expect(replUiReducer(opened, { type: 'setQuickHelp', open: true })).toBe(opened);

    const closed = replUiReducer(opened, { type: 'setQuickHelp', open: false });
    expect(closed.quickHelpOpen).toBe(false);
  });
});
