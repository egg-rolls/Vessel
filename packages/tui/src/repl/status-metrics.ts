/**
 * 状态规则的数据采集——复用 /context 的估算，不复制第二套
 * @module @vessel-agent/tui
 */

import { useEffect, useState } from 'react';
import { estimateContextUsage } from '../commands/context-command.js';
import type { ReplContext } from '../repl-context.js';
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
  /** 原始 cwd；由状态栏按预算格式化（不再预截断到 40 格） */
  cwd: string;
  /** home 前缀；状态栏把 cwd 折叠为 `~` */
  home: string | undefined;
  branch: string | undefined;
  now: number;
}

/**
 * 状态规则数据：context 在阶段变化与运行 tick 时重算；
 * 分支只取一次；失败静默隐藏。0.13 起不再扫描 `session.list()`。
 */
export function useStatusMetrics(
  ctx: ReplContext,
  currentSessionId: string,
  phase: RunPhase,
): StatusMetricsResult {
  const [context, setContext] = useState<ContextUsageDisplay>(() => readContextUsage(ctx));
  const [branch, setBranch] = useState<string | undefined>(undefined);
  const [cwd] = useState(() => process.cwd());
  const [home] = useState(() => process.env.HOME ?? process.env.USERPROFILE);
  const now = useNowTick(phase !== 'idle');

  // biome-ignore lint/correctness/useExhaustiveDependencies: now is the intentional 1s refresh trigger
  useEffect(() => {
    setContext(readContextUsage(ctx));
  }, [ctx, currentSessionId, phase, now]);

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
    cwd,
    home,
    branch,
    now,
  };
}
