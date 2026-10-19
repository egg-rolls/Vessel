/**
 * 视图键盘 -> 语义 intent——纯 reducer
 * @module @vessel/tui
 *
 * 渲染层只负责把按键喂进来并执行返回的 intent；业务（RPC/切会话）留在命令层。
 * Esc 分层：filter -> 清空并回 browse；rename/confirm/form -> 取消当前模式；
 * browse -> 关闭视图。
 */

import type { ViewMode } from './types.js';

/** Ink `useInput` 的 key 结构子集（便于直接传入） */
export interface ViewKey {
  input?: string;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
}

export interface ViewKeyState {
  mode: ViewMode;
  /** 当前过滤词（browse 模式保留，便于显示 "filtered: x"） */
  filter: string;
  /** rename/form 的草稿 */
  draft: string;
  selectedIndex: number;
  itemCount: number;
  /** PgUp/PgDn 步长 */
  pageSize: number;
  /** form 模式当前字段 */
  fieldIndex: number;
  fieldCount: number;
  /** 选中行是否 current（not-current 动作拒绝） */
  selectedCurrent: boolean;
  /** 当前视图声明的动作键（browse 模式下与导航键区分） */
  actionKeys: string[];
  /** 当前选中行上不可用的动作键 */
  disabledActionKeys: string[];
}

export interface ViewKeyStateInput {
  mode?: ViewMode;
  filter?: string;
  draft?: string;
  selectedIndex?: number;
  itemCount?: number;
  pageSize?: number;
  fieldIndex?: number;
  fieldCount?: number;
  selectedCurrent?: boolean;
  actionKeys?: string[];
  disabledActionKeys?: string[];
}

/** 建立 reducer 初始状态（所有字段可选，便于单测与宿主按需覆盖） */
export function initialViewKeyState(input: ViewKeyStateInput = {}): ViewKeyState {
  return {
    mode: input.mode ?? 'browse',
    filter: input.filter ?? '',
    draft: input.draft ?? '',
    selectedIndex: input.selectedIndex ?? 0,
    itemCount: input.itemCount ?? 0,
    pageSize: input.pageSize ?? 5,
    fieldIndex: input.fieldIndex ?? 0,
    fieldCount: input.fieldCount ?? 0,
    selectedCurrent: input.selectedCurrent ?? false,
    actionKeys: input.actionKeys ?? [],
    disabledActionKeys: input.disabledActionKeys ?? [],
  };
}

export type ViewIntent =
  | { type: 'noop' }
  | { type: 'close' }
  | { type: 'moveSelection'; index: number }
  | { type: 'quickSelect'; index: number }
  | { type: 'beginFilter' }
  | { type: 'setFilter'; filter: string }
  | { type: 'exitFilter' }
  | { type: 'clearFilter' }
  | { type: 'beginRename' }
  | { type: 'beginConfirm'; actionKey: string }
  | { type: 'beginForm' }
  | { type: 'submit'; value: string }
  | { type: 'submitConfirm'; yes: boolean }
  | { type: 'cancelMode' }
  | { type: 'action'; key: string }
  | { type: 'disabledAction'; key: string; reason: 'current' | 'selection' }
  | { type: 'focusField'; index: number }
  | { type: 'reject'; reason: 'empty-title' | 'empty-value' };

export interface ViewKeyReduction {
  state: ViewKeyState;
  intent: ViewIntent;
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

function isPrintable(key: ViewKey): boolean {
  return (
    key.input !== undefined && key.input.length > 0 && !key.ctrl && !key.meta && key.input !== '\t'
  );
}

function appendInput(state: ViewKeyState, input: string): ViewKeyState {
  return { ...state, draft: state.draft + input };
}

function removeLast(state: ViewKeyState, field: 'draft' | 'filter'): ViewKeyState {
  const chars = Array.from(state[field]);
  chars.pop();
  return { ...state, [field]: chars.join('') };
}

function move(state: ViewKeyState, index: number): ViewKeyReduction {
  const next = clamp(index, state.itemCount);
  return {
    state: { ...state, selectedIndex: next },
    intent: { type: 'moveSelection', index: next },
  };
}

function browse(state: ViewKeyState, key: ViewKey): ViewKeyReduction {
  if (key.escape) return { state, intent: { type: 'close' } };

  // 动作键优先于单字符导航（g 既是 home 又可能是 refresh；动作必须能触发）。
  if (isPrintable(key)) {
    const input = key.input ?? '';
    if (state.actionKeys.includes(input)) return emitAction(state, input);
  }

  if (key.upArrow || (key.input === 'k' && !key.ctrl && !key.meta)) {
    return move(state, state.selectedIndex - 1);
  }
  if (key.downArrow || (key.input === 'j' && !key.ctrl && !key.meta)) {
    return move(state, state.selectedIndex + 1);
  }
  if (key.pageUp) return move(state, state.selectedIndex - state.pageSize);
  if (key.pageDown) return move(state, state.selectedIndex + state.pageSize);
  if (key.home || (key.input === 'g' && !key.ctrl && !key.meta)) return move(state, 0);
  if (key.end || (key.input === 'G' && !key.ctrl && !key.meta)) {
    return move(state, state.itemCount - 1);
  }

  if (key.return) {
    return emitAction(state, 'enter');
  }

  if (key.input === '/' || key.input === 'f') {
    return {
      state: { ...state, mode: 'filter', filter: '' },
      intent: { type: 'beginFilter' },
    };
  }

  if (isPrintable(key)) {
    const input = key.input ?? '';

    // 1-9 快速选择：与旧 picker 行为一致（数字不是动作键时）。
    if (/^[1-9]$/.test(input)) {
      const index = clamp(Number.parseInt(input, 10) - 1, state.itemCount);
      return { state: { ...state, selectedIndex: index }, intent: { type: 'quickSelect', index } };
    }
  }

  return { state, intent: { type: 'noop' } };
}

function emitAction(state: ViewKeyState, actionKey: string): ViewKeyReduction {
  if (state.disabledActionKeys.includes(actionKey)) {
    return {
      state,
      intent: {
        type: 'disabledAction',
        key: actionKey,
        reason: state.selectedCurrent ? 'current' : 'selection',
      },
    };
  }
  return { state, intent: { type: 'action', key: actionKey } };
}

function filterMode(state: ViewKeyState, key: ViewKey): ViewKeyReduction {
  if (key.escape) {
    return {
      state: { ...state, mode: 'browse', filter: '' },
      intent: { type: 'clearFilter' },
    };
  }
  if (key.return) {
    return { state: { ...state, mode: 'browse' }, intent: { type: 'exitFilter' } };
  }
  if (key.ctrl && key.input === 'u') {
    return { state: { ...state, filter: '' }, intent: { type: 'setFilter', filter: '' } };
  }
  if (key.backspace || key.delete) {
    const next = removeLast(state, 'filter');
    return { state: next, intent: { type: 'setFilter', filter: next.filter } };
  }
  if (isPrintable(key)) {
    const next = { ...state, filter: state.filter + (key.input ?? '') };
    return { state: next, intent: { type: 'setFilter', filter: next.filter } };
  }
  return { state, intent: { type: 'noop' } };
}

function renameMode(state: ViewKeyState, key: ViewKey): ViewKeyReduction {
  if (key.escape) {
    return {
      state: { ...state, mode: 'browse', draft: '' },
      intent: { type: 'cancelMode' },
    };
  }
  if (key.return) {
    if (state.draft.trim().length === 0) {
      return { state, intent: { type: 'reject', reason: 'empty-title' } };
    }
    return { state, intent: { type: 'submit', value: state.draft } };
  }
  if (key.ctrl && key.input === 'u') {
    return { state: { ...state, draft: '' }, intent: { type: 'noop' } };
  }
  if (key.backspace || key.delete) {
    return { state: removeLast(state, 'draft'), intent: { type: 'noop' } };
  }
  if (isPrintable(key)) {
    return { state: appendInput(state, key.input ?? ''), intent: { type: 'noop' } };
  }
  return { state, intent: { type: 'noop' } };
}

function confirmMode(state: ViewKeyState, key: ViewKey): ViewKeyReduction {
  if (key.input === 'y' && !key.ctrl && !key.meta) {
    return {
      state: { ...state, mode: 'browse' },
      intent: { type: 'submitConfirm', yes: true },
    };
  }
  if ((key.input === 'n' && !key.ctrl && !key.meta) || key.escape) {
    return {
      state: { ...state, mode: 'browse' },
      intent: { type: 'submitConfirm', yes: false },
    };
  }
  if (key.return) {
    return {
      state: { ...state, mode: 'browse' },
      intent: { type: 'submitConfirm', yes: true },
    };
  }
  return { state, intent: { type: 'noop' } };
}

function formMode(state: ViewKeyState, key: ViewKey): ViewKeyReduction {
  if (key.escape) {
    return {
      state: { ...state, mode: 'browse', draft: '' },
      intent: { type: 'cancelMode' },
    };
  }
  if (key.tab && state.fieldCount > 0) {
    const index = (state.fieldIndex + 1) % state.fieldCount;
    return {
      state: { ...state, fieldIndex: index },
      intent: { type: 'focusField', index },
    };
  }
  if (key.return) {
    if (state.draft.trim().length === 0) {
      return { state, intent: { type: 'reject', reason: 'empty-value' } };
    }
    return { state, intent: { type: 'submit', value: state.draft } };
  }
  if (key.ctrl && key.input === 'u') {
    return { state: { ...state, draft: '' }, intent: { type: 'noop' } };
  }
  if (key.backspace || key.delete) {
    return { state: removeLast(state, 'draft'), intent: { type: 'noop' } };
  }
  if (isPrintable(key)) {
    return { state: appendInput(state, key.input ?? ''), intent: { type: 'noop' } };
  }
  return { state, intent: { type: 'noop' } };
}

/** 纯函数：按键 -> 新状态 + 语义 intent；不产生副作用 */
export function reduceViewKey(state: ViewKeyState, key: ViewKey): ViewKeyReduction {
  switch (state.mode) {
    case 'browse':
      return browse(state, key);
    case 'filter':
      return filterMode(state, key);
    case 'rename':
      return renameMode(state, key);
    case 'confirm':
      return confirmMode(state, key);
    case 'form':
      return formMode(state, key);
  }
}
