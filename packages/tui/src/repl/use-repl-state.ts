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
import type { ViewAction, ViewEnvelope, ViewMode } from '../views/types.js';

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

/** resume picker 的加载状态：失败不能伪装成空列表 */
export type ResumePickerStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface RunUiState {
  phase: RunPhase;
  abort: AbortController | null;
}

/** 当前打开的交互视图（唯一 overlay；与权限/ask-user 同一优先级链） */
export interface ActiveViewState {
  envelope: ViewEnvelope;
  /** 选中的 row/item key（不是索引） */
  selectedKey: string | null;
  filter: string;
  mode: ViewMode;
  /** rename/form 的草稿 */
  draft: string;
  /** 二次确认的动作 */
  pendingAction: ViewAction | null;
  /** 防旧响应覆盖 */
  requestId: number;
}

/** 视图打开时的默认选中 key */
export function defaultViewSelection(envelope: ViewEnvelope): string | null {
  const { view } = envelope;
  if (view.kind === 'table') return view.initialKey ?? view.rows[0]?.key ?? null;
  if (view.kind === 'list') return view.initialKey ?? view.items[0]?.key ?? null;
  return null;
}

/** InkRepl 的完整 UI 状态 */
export interface ReplUiState {
  /** REPL 运行态（currentSessionId / pendingResume / showResumePicker / running） */
  repl: ReplState;
  input: string;
  history: string[];
  autocompleteIndex: number;
  resumeSessions: SessionInfo[];
  resumeStatus: ResumePickerStatus;
  resumeError: string | null;
  /** retry 时自增，驱动 Ink effect 重新拉取 */
  resumeReloadToken: number;
  clearSignal: number;
  inputCaretKey: number;
  askUserActive: boolean;
  askUserRequestId: string | null;
  askUserRunId: string | null;
  permissionOverlay: PermissionOverlay | null;
  run: RunUiState;
  /** 命令返回的交互视图；非 null 时为独占 overlay */
  view: ActiveViewState | null;
  /** 最近成功执行的命令名（不含斜杠，最多 5 个；内存态） */
  recentCommands: string[];
  /** 已提交输入历史（↑↓ 召回；内存态） */
  inputHistory: string[];
  /** 当前浏览历史的位置；null = 未浏览 */
  historyIndex: number | null;
  /** 开始浏览历史前的输入草稿（↓ 到底恢复） */
  historyDraft: string;
  /** 运行中提交的输入队列（run 结束按顺序执行） */
  queuedInput: string[];
  /** 当前正在编辑的队列下标；null = 未编辑 */
  queueEditIndex: number | null;
  /** 进入队列编辑前的输入草稿（Esc 恢复） */
  queueReturnInput: string;
  /** Ctrl+O 展开态（归档完整输出） */
  expandedOutput: boolean;
  /** 递增触发 StreamOutput 把完整输出刷入 scrollback */
  expandSignal: number;
  /** 队列处理完成后的重渲染触发器 */
  queueTick: number;
}

export type ReplUiAction =
  | { type: 'setInput'; input: string }
  | { type: 'appendHistory'; line: string }
  | { type: 'appendHistoryLines'; lines: string[] }
  | { type: 'clearHistory' }
  | { type: 'setAutocompleteIndex'; index: number }
  | { type: 'resumePickerLoading' }
  | { type: 'resumePickerReady'; sessions: SessionInfo[] }
  | { type: 'resumePickerError'; message: string }
  | { type: 'resumePickerRetry' }
  | { type: 'resumePickerReset' }
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
  | { type: 'patchRepl'; patch: Partial<ReplState> }
  | { type: 'openView'; envelope: ViewEnvelope; initialKey?: string }
  | { type: 'closeView' }
  | { type: 'viewSelect'; key: string }
  | { type: 'viewFilter'; filter: string }
  | {
      type: 'viewMode';
      mode: ViewMode;
      draft?: string;
      pendingAction?: ViewAction | null;
    }
  | { type: 'viewData'; envelope: ViewEnvelope; selectedKey?: string; requestId?: number }
  | { type: 'viewLoading'; requestId: number }
  | { type: 'viewError'; message: string; requestId: number }
  | { type: 'pushRecentCommand'; name: string }
  | { type: 'recordInput'; value: string }
  | { type: 'historyPrev' }
  | { type: 'historyNext' }
  | { type: 'enqueueInput'; value: string }
  | { type: 'dequeueInput' }
  | { type: 'clearQueue' }
  | { type: 'beginQueueEdit'; index: number; returnInput: string }
  | { type: 'setQueueEditIndex'; index: number }
  | { type: 'cancelQueueEdit' }
  | { type: 'updateQueuedInput'; index: number; value: string }
  | { type: 'removeQueuedInput'; index: number }
  | { type: 'bumpQueueTick' }
  | { type: 'toggleExpanded' };

/** 纯 reducer：不可变推进 UI 状态 */
export function replUiReducer(state: ReplUiState, action: ReplUiAction): ReplUiState {
  switch (action.type) {
    case 'setInput':
      // 手工编辑离开历史浏览；否则 ↑ 会从旧位置继续而不是最新一条。
      return { ...state, input: action.input, historyIndex: null, historyDraft: '' };
    case 'appendHistory':
      return { ...state, history: [...state.history, action.line] };
    case 'appendHistoryLines':
      return action.lines.length === 0
        ? state
        : { ...state, history: [...state.history, ...action.lines] };
    case 'clearHistory':
      return { ...state, history: [] };
    case 'setAutocompleteIndex':
      return { ...state, autocompleteIndex: action.index };
    case 'resumePickerLoading':
      return { ...state, resumeStatus: 'loading', resumeError: null };
    case 'resumePickerReady':
      return {
        ...state,
        resumeStatus: 'ready',
        resumeError: null,
        resumeSessions: action.sessions,
      };
    case 'resumePickerError':
      return { ...state, resumeStatus: 'error', resumeError: action.message };
    case 'resumePickerRetry':
      return {
        ...state,
        resumeStatus: 'loading',
        resumeError: null,
        resumeReloadToken: state.resumeReloadToken + 1,
      };
    case 'resumePickerReset':
      return { ...state, resumeStatus: 'idle', resumeError: null, resumeSessions: [] };
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
    case 'openView': {
      const selectedKey = action.initialKey ?? defaultViewSelection(action.envelope);
      return {
        ...state,
        view: {
          envelope: action.envelope,
          selectedKey,
          filter: '',
          mode: 'browse',
          draft: '',
          pendingAction: null,
          requestId: 0,
        },
      };
    }
    case 'closeView':
      return state.view === null ? state : { ...state, view: null };
    case 'viewSelect':
      return state.view === null
        ? state
        : { ...state, view: { ...state.view, selectedKey: action.key } };
    case 'viewFilter':
      return state.view === null
        ? state
        : { ...state, view: { ...state.view, filter: action.filter } };
    case 'viewMode':
      return state.view === null
        ? state
        : {
            ...state,
            view: {
              ...state.view,
              mode: action.mode,
              draft: action.draft ?? '',
              pendingAction:
                action.pendingAction !== undefined
                  ? action.pendingAction
                  : state.view.pendingAction,
            },
          };
    case 'viewData': {
      if (state.view === null) return state;
      // 旧响应不得覆盖新响应。
      if (action.requestId !== undefined && action.requestId < state.view.requestId) {
        return state;
      }
      return {
        ...state,
        view: {
          ...state.view,
          envelope: action.envelope,
          selectedKey:
            action.selectedKey !== undefined ? action.selectedKey : state.view.selectedKey,
          pendingAction: null,
          draft: '',
          mode: 'browse',
        },
      };
    }
    case 'viewLoading':
      return state.view === null
        ? state
        : {
            ...state,
            view: {
              ...state.view,
              requestId: action.requestId,
              envelope: { ...state.view.envelope, status: 'loading', error: undefined },
            },
          };
    case 'viewError': {
      if (state.view === null || action.requestId < state.view.requestId) return state;
      return {
        ...state,
        view: {
          ...state.view,
          envelope: {
            ...state.view.envelope,
            status: 'error',
            error: action.message,
          },
        },
      };
    }
    case 'pushRecentCommand': {
      const rest = state.recentCommands.filter((name) => name !== action.name);
      return { ...state, recentCommands: [action.name, ...rest].slice(0, 5) };
    }
    case 'recordInput': {
      const value = action.value.trim();
      if (!value) return state;
      const last = state.inputHistory.at(-1);
      const inputHistory =
        last === value ? state.inputHistory : [...state.inputHistory, value].slice(-200);
      return { ...state, inputHistory, historyIndex: null, historyDraft: '' };
    }
    case 'historyPrev': {
      if (state.inputHistory.length === 0) return state;
      const index =
        state.historyIndex === null
          ? state.inputHistory.length - 1
          : Math.max(0, state.historyIndex - 1);
      return {
        ...state,
        historyIndex: index,
        historyDraft: state.historyIndex === null ? state.input : state.historyDraft,
        input: state.inputHistory[index] ?? '',
      };
    }
    case 'historyNext': {
      if (state.historyIndex === null) return state;
      const index = state.historyIndex + 1;
      if (index >= state.inputHistory.length) {
        return { ...state, historyIndex: null, input: state.historyDraft, historyDraft: '' };
      }
      return { ...state, historyIndex: index, input: state.inputHistory[index] ?? '' };
    }
    case 'enqueueInput':
      return action.value.trim()
        ? { ...state, queuedInput: [...state.queuedInput, action.value] }
        : state;
    case 'dequeueInput':
      return state.queuedInput.length === 0
        ? state
        : {
            ...state,
            queuedInput: state.queuedInput.slice(1),
            queueEditIndex: null,
            queueReturnInput: '',
          };
    case 'clearQueue':
      return state.queuedInput.length === 0
        ? state
        : { ...state, queuedInput: [], queueEditIndex: null, queueReturnInput: '' };
    case 'beginQueueEdit': {
      if (state.queuedInput.length === 0) return state;
      const index = Math.max(0, Math.min(state.queuedInput.length - 1, action.index));
      return { ...state, queueEditIndex: index, queueReturnInput: action.returnInput };
    }
    case 'setQueueEditIndex': {
      if (state.queueEditIndex === null || state.queuedInput.length === 0) return state;
      const index = Math.max(0, Math.min(state.queuedInput.length - 1, action.index));
      return { ...state, queueEditIndex: index };
    }
    case 'cancelQueueEdit':
      return state.queueEditIndex === null
        ? state
        : {
            ...state,
            queueEditIndex: null,
            queueReturnInput: '',
            input: state.queueReturnInput,
          };
    case 'updateQueuedInput': {
      if (action.index < 0 || action.index >= state.queuedInput.length) return state;
      const value = action.value.trim();
      const queuedInput = value
        ? state.queuedInput.map((item, index) => (index === action.index ? value : item))
        : state.queuedInput.filter((_, index) => index !== action.index);
      return { ...state, queuedInput, queueEditIndex: null, queueReturnInput: '' };
    }
    case 'removeQueuedInput': {
      if (action.index < 0 || action.index >= state.queuedInput.length) return state;
      return {
        ...state,
        queuedInput: state.queuedInput.filter((_, index) => index !== action.index),
        queueEditIndex: null,
        queueReturnInput: '',
      };
    }
    case 'bumpQueueTick':
      return { ...state, queueTick: state.queueTick + 1 };
    case 'toggleExpanded': {
      const expandedOutput = !state.expandedOutput;
      return {
        ...state,
        expandedOutput,
        expandSignal: expandedOutput ? state.expandSignal + 1 : state.expandSignal,
      };
    }
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
    resumeStatus: 'idle',
    resumeError: null,
    resumeReloadToken: 0,
    clearSignal: 0,
    inputCaretKey: 0,
    askUserActive: false,
    askUserRequestId: null,
    askUserRunId: null,
    permissionOverlay: null,
    run: { phase: 'idle', abort: null },
    view: null,
    recentCommands: [],
    inputHistory: [],
    historyIndex: null,
    historyDraft: '',
    queuedInput: [],
    queueEditIndex: null,
    queueReturnInput: '',
    expandedOutput: false,
    expandSignal: 0,
    queueTick: 0,
  };
}

/** 用 useReducer 持有 InkRepl 全部 UI 状态 */
export function useReplState(ctx: ReplContext) {
  return useReducer(replUiReducer, ctx, initialReplUiState);
}
