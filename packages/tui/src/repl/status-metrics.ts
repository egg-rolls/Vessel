/**
 * 状态规则的数据采集——复用 /context 的估算，不复制第二套
 * @module @vessel/tui
 */

import { useEffect, useState } from 'react';
import { estimateContextUsage } from '../commands/context-command.js';
import type { ReplContext } from '../repl-context.js';
import { formatCwd } from '../utils/display-labels.js';
import { getCurrentGitBranch } from '../utils/git.js';
import type { RunPhase } from './use-repl-state.js';

export interface ContextUsageDisplay {
  used: number;
  max?: number;
}

/** 纯函数：从 live context 估算当前用量（与 /context 同源） */
export function readContextUsage(ctx: ReplContext): ContextUsageDisplay {
  const max = ctx.config.context?.maxTokens;
  const usage = estimateContextUsage(ctx.context.messages, {
    source: 'context',
    ...(max !== undefined ? { maxTokens: max } : {}),
  });
  return { used: usage.totalTokens, ...(max !== undefined ? { max } : {}) };
}

/** 运行中每秒刷新；空闲时不建计时器 */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}

export interface StatusMetricsResult {
  context: ContextUsageDisplay;
  sessions: number | undefined;
  cwd: string;
  branch: string | undefined;
  now: number;
}

/**
 * 状态规则数据：context 在阶段变化与运行 tick 时重算；
 * session 数在 mount / 新会话 / resume 后重算；失败静默隐藏。
 */
export function useStatusMetrics(
  ctx: ReplContext,
  currentSessionId: string,
  phase: RunPhase,
): StatusMetricsResult {
  const [context, setContext] = useState<ContextUsageDisplay>(() => readContextUsage(ctx));
  const [sessions, setSessions] = useState<number | undefined>(undefined);
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [cwd] = useState(() => process.cwd());
  const [home] = useState(() => process.env.HOME ?? process.env.USERPROFILE);
  const now = useNowTick(phase !== 'idle');

  // biome-ignore lint/correctness/useExhaustiveDependencies: now is the intentional 1s refresh trigger
  useEffect(() => {
    setContext(readContextUsage(ctx));
  }, [ctx, currentSessionId, phase, now]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh session count on session switch
  useEffect(() => {
    let cancelled = false;
    ctx.session
      .list()
      .then((ids) => {
        if (!cancelled) setSessions(ids.length);
      })
      .catch(() => {
        if (!cancelled) setSessions(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, currentSessionId]);

  useEffect(() => {
    let cancelled = false;
    void getCurrentGitBranch().then((name) => {
      if (!cancelled) setBranch(name);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    context,
    sessions,
    cwd: formatCwd(cwd, home),
    branch,
    now,
  };
}
