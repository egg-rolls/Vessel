/**
 * 运行时状态 hook
 * 管理 REPL 的运行时状态
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReplState } from '../commands/commands.js';
import type { ReplContext } from '../repl-context.js';

interface UseRuntimeStateOptions {
  ctx: ReplContext;
  onStateChange?: (state: ReplState) => void;
}

export function useRuntimeState({ ctx, onStateChange }: UseRuntimeStateOptions) {
  const [state, setState] = useState<ReplState>({
    currentSessionId: ctx.currentSessionId,
    pendingResume: false,
    pendingDelete: false,
    running: true,
  });

  const [history, setHistory] = useState<string[]>([]);

  // 同步 currentSessionId 到 ctx
  useEffect(() => {
    ctx.currentSessionId = state.currentSessionId;
  }, [state.currentSessionId, ctx]);

  // 状态变更回调
  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  const addHistory = useCallback((line: string) => {
    setHistory((prev) => [...prev, line]);
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  const updateState = useCallback((updates: Partial<ReplState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  const setPendingResume = useCallback((pending: boolean) => {
    setState((prev) => ({ ...prev, pendingResume: pending }));
  }, []);

  const setPendingDelete = useCallback((pending: boolean) => {
    setState((prev) => ({ ...prev, pendingDelete: pending }));
  }, []);

  const setCurrentSession = useCallback(
    (id: string) => {
      setState((prev) => ({ ...prev, currentSessionId: id }));
      ctx.onSessionChange(id);
    },
    [ctx],
  );

  const stopRunning = useCallback(() => {
    setState((prev) => ({ ...prev, running: false }));
  }, []);

  return {
    state,
    history,
    addHistory,
    clearHistory,
    updateState,
    setPendingResume,
    setPendingDelete,
    setCurrentSession,
    stopRunning,
  };
}
