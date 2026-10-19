import { describe, expect, it } from 'bun:test';
import {
  initialViewKeyState,
  reduceViewKey,
  type ViewKey,
  type ViewKeyStateInput,
} from '../src/views/keys.js';

function state(overrides: ViewKeyStateInput = {}) {
  return initialViewKeyState({
    itemCount: 5,
    actionKeys: ['enter', 'r', 'x'],
    pageSize: 5,
    ...overrides,
  });
}

describe('browse 模式', () => {
  it('↑↓ / j k 移动并钳制', () => {
    let current = state();
    let result = reduceViewKey(current, { downArrow: true });
    expect(result.state.selectedIndex).toBe(1);
    expect(result.intent).toEqual({ type: 'moveSelection', index: 1 });

    result = reduceViewKey(result.state, { input: 'j' });
    expect(result.state.selectedIndex).toBe(2);
    result = reduceViewKey(result.state, { input: 'k' });
    expect(result.state.selectedIndex).toBe(1);
    current = result.state;

    for (let i = 0; i < 10; i++) {
      const next = reduceViewKey(current, { upArrow: true });
      expect(next.state.selectedIndex).toBeGreaterThanOrEqual(0);
      current = next.state;
    }
    expect(current.selectedIndex).toBe(0);
  });

  it('PgUp/PgDn 移动 pageSize 行', () => {
    let result = reduceViewKey(state(), { pageDown: true });
    expect(result.state.selectedIndex).toBe(4); // clamp 到 itemCount-1
    result = reduceViewKey(result.state, { pageUp: true });
    expect(result.state.selectedIndex).toBe(0);
  });

  it('Home/End/g/G', () => {
    const end = reduceViewKey(state({ selectedIndex: 2 }), { input: 'G' });
    expect(end.state.selectedIndex).toBe(4);
    const home = reduceViewKey(end.state, { input: 'g' });
    expect(home.state.selectedIndex).toBe(0);
    expect(reduceViewKey(state({ selectedIndex: 2 }), { home: true }).state.selectedIndex).toBe(0);
    expect(reduceViewKey(state(), { end: true }).state.selectedIndex).toBe(4);
  });

  it('动作键优先于单字符导航（g 刷新 vs go-home）', () => {
    // 未声明 g 动作时，g 仍是 Home。
    expect(reduceViewKey(state({ selectedIndex: 3 }), { input: 'g' }).state.selectedIndex).toBe(0);
    // 声明 g 动作（/workflows 刷新）时，g 必须触发动作而不是移动选中项。
    const withAction = state({
      selectedIndex: 3,
      actionKeys: ['g', 'r'],
    });
    const result = reduceViewKey(withAction, { input: 'g' });
    expect(result.intent).toEqual({ type: 'action', key: 'g' });
    expect(result.state.selectedIndex).toBe(3);
  });

  it('Esc 关闭视图', () => {
    expect(reduceViewKey(state(), { escape: true }).intent).toEqual({ type: 'close' });
  });

  it('Enter / 动作键产生 action', () => {
    expect(reduceViewKey(state(), { return: true }).intent).toEqual({
      type: 'action',
      key: 'enter',
    });
    expect(reduceViewKey(state(), { input: 'x' }).intent).toEqual({ type: 'action', key: 'x' });
  });

  it('current 行上的 not-current 动作被拒绝', () => {
    const result = reduceViewKey(state({ selectedCurrent: true, disabledActionKeys: ['x'] }), {
      input: 'x',
    });
    expect(result.intent).toEqual({ type: 'disabledAction', key: 'x', reason: 'current' });
  });

  it('/ 或 f 进入 filter', () => {
    for (const input of ['/', 'f']) {
      const result = reduceViewKey(state(), { input });
      expect(result.state.mode).toBe('filter');
      expect(result.state.filter).toBe('');
      expect(result.intent).toEqual({ type: 'beginFilter' });
    }
  });

  it('1-9 快速选择', () => {
    const result = reduceViewKey(state(), { input: '3' });
    expect(result.state.selectedIndex).toBe(2);
    expect(result.intent).toEqual({ type: 'quickSelect', index: 2 });
  });
});

describe('filter 模式', () => {
  it('可打印字符追加、Backspace 删除、Ctrl+U 清空', () => {
    let result = reduceViewKey(state({ mode: 'filter', filter: '' }), { input: '中' });
    expect(result.state.filter).toBe('中');
    expect(result.intent).toEqual({ type: 'setFilter', filter: '中' });

    result = reduceViewKey(result.state, { input: 'a' });
    expect(result.state.filter).toBe('中a');

    result = reduceViewKey(result.state, { backspace: true });
    expect(result.state.filter).toBe('中');
    expect(result.intent).toEqual({ type: 'setFilter', filter: '中' });

    result = reduceViewKey(result.state, { input: 'u', ctrl: true });
    expect(result.state.filter).toBe('');
    expect(result.intent).toEqual({ type: 'setFilter', filter: '' });
  });

  it('/ 在 filter 模式是普通字符', () => {
    const result = reduceViewKey(state({ mode: 'filter' }), { input: '/' });
    expect(result.state.filter).toBe('/');
  });

  it('Enter 退出 filter 并保留结果', () => {
    const result = reduceViewKey(state({ mode: 'filter', filter: 'auth' }), { return: true });
    expect(result.state.mode).toBe('browse');
    expect(result.state.filter).toBe('auth');
    expect(result.intent).toEqual({ type: 'exitFilter' });
  });

  it('Esc 清空并回 browse（分层退出第一层）', () => {
    const result = reduceViewKey(state({ mode: 'filter', filter: 'auth' }), { escape: true });
    expect(result.state.mode).toBe('browse');
    expect(result.state.filter).toBe('');
    expect(result.intent).toEqual({ type: 'clearFilter' });
  });
});

describe('rename 模式', () => {
  it('输入 / Backspace / Ctrl+U', () => {
    let result = reduceViewKey(state({ mode: 'rename', draft: 'old' }), { input: '新' });
    expect(result.state.draft).toBe('old新');
    result = reduceViewKey(result.state, { backspace: true });
    expect(result.state.draft).toBe('old');
    result = reduceViewKey(result.state, { input: 'u', ctrl: true });
    expect(result.state.draft).toBe('');
  });

  it('Enter 提交草稿', () => {
    const result = reduceViewKey(state({ mode: 'rename', draft: 'New title' }), { return: true });
    expect(result.intent).toEqual({ type: 'submit', value: 'New title' });
  });

  it('空标题拒绝提交', () => {
    const result = reduceViewKey(state({ mode: 'rename', draft: '   ' }), { return: true });
    expect(result.intent).toEqual({ type: 'reject', reason: 'empty-title' });
    expect(result.state.mode).toBe('rename');
  });

  it('Esc 只取消当前模式（不关闭视图）', () => {
    const result = reduceViewKey(state({ mode: 'rename', draft: 'x' }), { escape: true });
    expect(result.state.mode).toBe('browse');
    expect(result.state.draft).toBe('');
    expect(result.intent).toEqual({ type: 'cancelMode' });
  });
});

describe('confirm 模式', () => {
  it('y / Enter 确认，n / Esc 取消', () => {
    expect(reduceViewKey(state({ mode: 'confirm' }), { input: 'y' }).intent).toEqual({
      type: 'submitConfirm',
      yes: true,
    });
    expect(reduceViewKey(state({ mode: 'confirm' }), { return: true }).intent).toEqual({
      type: 'submitConfirm',
      yes: true,
    });
    expect(reduceViewKey(state({ mode: 'confirm' }), { input: 'n' }).intent).toEqual({
      type: 'submitConfirm',
      yes: false,
    });
    expect(reduceViewKey(state({ mode: 'confirm' }), { escape: true }).intent).toEqual({
      type: 'submitConfirm',
      yes: false,
    });
  });

  it('确认后回到 browse', () => {
    const result = reduceViewKey(state({ mode: 'confirm' }), { input: 'y' });
    expect(result.state.mode).toBe('browse');
  });
});

describe('form 模式', () => {
  it('Tab 切换字段', () => {
    const result = reduceViewKey(state({ mode: 'form', fieldCount: 3, fieldIndex: 0 }), {
      tab: true,
    });
    expect(result.state.fieldIndex).toBe(1);
    expect(result.intent).toEqual({ type: 'focusField', index: 1 });
  });

  it('Enter 提交 / 空值拒绝', () => {
    expect(reduceViewKey(state({ mode: 'form', draft: 'new' }), { return: true }).intent).toEqual({
      type: 'submit',
      value: 'new',
    });
    expect(reduceViewKey(state({ mode: 'form', draft: '' }), { return: true }).intent).toEqual({
      type: 'reject',
      reason: 'empty-value',
    });
  });

  it('Esc 取消表单', () => {
    const result = reduceViewKey(state({ mode: 'form', draft: 'x' }), { escape: true });
    expect(result.state.mode).toBe('browse');
    expect(result.intent).toEqual({ type: 'cancelMode' });
  });
});

describe('未知键', () => {
  it('返回 noop 且状态不变', () => {
    const before = state();
    const key: ViewKey = {};
    const result = reduceViewKey(before, key);
    expect(result.intent).toEqual({ type: 'noop' });
    expect(result.state).toEqual(before);
  });
});
