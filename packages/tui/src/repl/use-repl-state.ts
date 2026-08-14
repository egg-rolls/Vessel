/**
 * InkRepl 的 UI 状态 reducer
 * @module @vessel/tui
 *
 * 把 ink-repl 里散落的多个 useState 收敛为一个 useReducer，
 * 消除 god-component（旧架构 10 个 useState 混装）。
 * 所有 UI 变更走 action，reducer 不可变返回新状态。
 */

import type { SessionInfo } from '@vessel/core';
import { useReducer } from 'react';
import type { ReplState } from '../commands/commands.js';
import type { ReplContext } from '../repl-context.js';

/** 权限确认弹窗数据（ADR-029：tool.permission.request 载荷的展示态） */
export interface PermissionOverlay {
  requestId: string;
  run_id: string;
  toolName: string;
}

/** InkRepl 的完整 UI 状态 */
export interface ReplUiState {
  /** REPL 运行态（currentSessionId / pendingResume / showResumePicker / running） */
  repl: ReplState;
  input: string;
  history: string[];
  autocompleteIndex: number;
  resumeSessions: SessionInfo[];
  clearSignal: number;
  inputCaretKey: number;
  askUserActive: boolean;
  permissionOverlay: PermissionOverlay | null;
}

export type ReplUiAction =
  | { type: 'setInput'; input: string }
  | { type: 'appendHistory'; line: string }
  | { type: 'clearHistory' }
  | { type: 'setAutocompleteIndex'; index: number }
  | { type: 'setResumeSessions'; sessions: SessionInfo[] }
  | { type: 'bumpClearSignal' }
  | { type: 'bumpCaret' }
  | { type: 'setAskUserActive'; active: boolean }
  | { type: 'setPermissionOverlay'; overlay: PermissionOverlay | null }
  | { type: 'patchRepl'; patch: Partial<ReplState> };

/** 纯 reducer：不可变推进 UI 状态 */
export function replUiReducer(state: ReplUiState, action: ReplUiAction): ReplUiState {
  switch (action.type) {
    case 'setInput':
      return { ...state, input: action.input };
    case 'appendHistory':
      return { ...state, history: [...state.history, action.line] };
    case 'clearHistory':
      return { ...state, history: [] };
    case 'setAutocompleteIndex':
      return { ...state, autocompleteIndex: action.index };
    case 'setResumeSessions':
      return { ...state, resumeSessions: action.sessions };
    case 'bumpClearSignal':
      return { ...state, clearSignal: state.clearSignal + 1 };
    case 'bumpCaret':
      return { ...state, inputCaretKey: state.inputCaretKey + 1 };
    case 'setAskUserActive':
      return { ...state, askUserActive: action.active };
    case 'setPermissionOverlay':
      return { ...state, permissionOverlay: action.overlay };
    case 'patchRepl':
      return { ...state, repl: { ...state.repl, ...action.patch } };
  }
}

/** 初始 UI 状态 */
export function initialReplUiState(ctx: ReplContext): ReplUiState {
  return {
    repl: {
      currentSessionId: ctx.currentSessionId,
      pendingResume: false,
      showResumePicker: false,
      running: true,
    },
    input: '',
    history: [],
    autocompleteIndex: 0,
    resumeSessions: [],
    clearSignal: 0,
    inputCaretKey: 0,
    askUserActive: false,
    permissionOverlay: null,
  };
}

/** 用 useReducer 持有 InkRepl 全部 UI 状态 */
export function useReplState(ctx: ReplContext) {
  return useReducer(replUiReducer, ctx, initialReplUiState);
}
