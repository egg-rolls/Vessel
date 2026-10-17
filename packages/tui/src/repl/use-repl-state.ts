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
  /** 工具入参（弹窗展示用；可能是任意 JSON） */
  input: unknown;
  /** 与 core 一致的 120s 超时时间点 */
  expiresAt?: number;
}

/** 单轮 run 的 UI 阶段 */
export type RunPhase = 'idle' | 'running' | 'cancelling';

export interface RunUiState {
  phase: RunPhase;
  abort: AbortController | null;
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
  askUserRequestId: string | null;
  askUserRunId: string | null;
  permissionOverlay: PermissionOverlay | null;
  run: RunUiState;
}

export type ReplUiAction =
  | { type: 'setInput'; input: string }
  | { type: 'appendHistory'; line: string }
  | { type: 'clearHistory' }
  | { type: 'setAutocompleteIndex'; index: number }
  | { type: 'setResumeSessions'; sessions: SessionInfo[] }
  | { type: 'bumpClearSignal' }
  | { type: 'bumpCaret' }
  | { type: 'setAskUserActive'; active: boolean; requestId?: string; runId?: string }
  | { type: 'setPermissionOverlay'; overlay: PermissionOverlay | null }
  | { type: 'clearPermissionForRequest'; requestId: string }
  | { type: 'clearPermissionForRun'; runId: string }
  | { type: 'clearPermissionForTool'; runId: string; toolName: string }
  | { type: 'runStart'; abort: AbortController }
  | { type: 'runCancelRequested' }
  | { type: 'runEnd' }
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
      return {
        ...state,
        askUserActive: action.active,
        askUserRequestId: action.active ? (action.requestId ?? state.askUserRequestId) : null,
        askUserRunId: action.active ? (action.runId ?? state.askUserRunId) : null,
      };
    case 'setPermissionOverlay':
      return { ...state, permissionOverlay: action.overlay };
    case 'clearPermissionForRequest':
      return state.permissionOverlay?.requestId === action.requestId
        ? { ...state, permissionOverlay: null }
        : state;
    case 'clearPermissionForRun':
      return state.permissionOverlay?.run_id === action.runId
        ? { ...state, permissionOverlay: null }
        : state;
    case 'clearPermissionForTool':
      return state.permissionOverlay?.run_id === action.runId &&
        state.permissionOverlay.toolName === action.toolName
        ? { ...state, permissionOverlay: null }
        : state;
    case 'runStart':
      return { ...state, run: { phase: 'running', abort: action.abort } };
    case 'runCancelRequested':
      return state.run.phase === 'running'
        ? { ...state, run: { ...state.run, phase: 'cancelling' } }
        : state;
    case 'runEnd':
      return { ...state, run: { phase: 'idle', abort: null } };
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
    askUserRequestId: null,
    askUserRunId: null,
    permissionOverlay: null,
    run: { phase: 'idle', abort: null },
  };
}

/** 用 useReducer 持有 InkRepl 全部 UI 状态 */
export function useReplState(ctx: ReplContext) {
  return useReducer(replUiReducer, ctx, initialReplUiState);
}
