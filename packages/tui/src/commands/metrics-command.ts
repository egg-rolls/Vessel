/**
 * /metrics —— 打印 MetricsSnapshot 单行摘要
 * @module @vessel/tui
 *
 * 数据只来自 ReplContext.metrics（asm 注入的快照闭包）；
 * observability.metrics 关闭时未注入，命令给出明确提示。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import type { MetricsSnapshotLike, ReplContext } from '../repl-context.js';
import { formatRelativeTime } from '../utils/time.js';
import type { CommandEntry, CommandResult } from './commands.js';

function formatMs(ms: number): string {
  return Number.isFinite(ms) ? `${Math.round(ms)}ms` : '-';
}

/** 纯函数：单行快照摘要（不含换行） */
export function formatMetrics(snapshot: MetricsSnapshotLike, now: number = Date.now()): string {
  const updated =
    Number.isFinite(snapshot.updated_at) && snapshot.updated_at > 0
      ? formatRelativeTime(snapshot.updated_at, now)
      : '-';

  return [
    `Metrics: ${snapshot.runs.started} runs (${snapshot.runs.completed} completed, ${snapshot.runs.failed} failed, ${snapshot.runs.cancelled} cancelled)`,
    `${snapshot.tool_calls.total} tool calls (${snapshot.tool_calls.failed} failed)`,
    `${snapshot.llm.requests} LLM requests`,
    `${snapshot.llm.total_tokens} tokens (${snapshot.llm.prompt_tokens} prompt, ${snapshot.llm.completion_tokens} completion)`,
    `duration total ${formatMs(snapshot.duration_ms.total)} / avg ${formatMs(
      snapshot.duration_ms.avg,
    )} / max ${formatMs(snapshot.duration_ms.max)}`,
    `updated ${updated}`,
  ].join(' · ');
}

/** /metrics 的执行体（导出供单测） */
export function runMetricsCommand(args: string[], ctx: ReplContext): CommandResult {
  if (args.length > 0) return { handled: true, output: '\nUsage: /metrics\n' };

  if (!ctx.metrics) {
    return {
      handled: true,
      output: '\nMetrics are not enabled (observability.metrics: false).\n',
    };
  }

  try {
    return { handled: true, output: `\n${formatMetrics(ctx.metrics())}\n` };
  } catch (error) {
    return {
      handled: true,
      output: `\nFailed to read metrics:\n${formatClassifiedError(classifyError(error))}\n`,
    };
  }
}

export function metricsCommand(): CommandEntry {
  return {
    name: 'metrics',
    description: 'Show runtime metrics snapshot',
    usage: '/metrics',
    run: (args, ctx) => runMetricsCommand(args, ctx),
  };
}
