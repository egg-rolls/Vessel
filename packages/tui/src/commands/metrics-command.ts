/**
 * /metrics —— 打印 MetricsSnapshot
 * @module @vessel/tui
 *
 * 0.5 双来源（A-3 §10.1）：
 * - live（默认）：`metrics.get { source: 'live' }`；
 * - trace：`metrics.get { source: 'trace' }`，由 core `rebuildMetrics` 重建。
 * 无 RpcClient 的第三方嵌入退回 ctx.metrics（仅 live）。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import type { MetricsSnapshotLike, ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { formatRelativeTime } from '../utils/time.js';
import type { CommandEntry, CommandResult } from './commands.js';

const USAGE = 'Usage: /metrics [--source live|trace] [--json]';

export type MetricsSource = 'live' | 'trace';

export interface MetricsOptions {
  source: MetricsSource;
  json: boolean;
}

type ParseResult = { ok: true; value: MetricsOptions } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMetricsArgs(args: string[]): ParseResult {
  let source: MetricsSource = 'live';
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--source') {
      const value = args[++i];
      if (value !== 'live' && value !== 'trace') {
        return { ok: false, message: USAGE };
      }
      source = value;
      continue;
    }
    return { ok: false, message: `${USAGE} (unknown argument "${arg}")` };
  }

  return { ok: true, value: { source, json } };
}

function numberAt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 宽松读取 MetricsSnapshot；接受 `{ metrics: ... }` 包装 */
export function readMetricsSnapshot(value: unknown): MetricsSnapshotLike | null {
  const raw = isRecord(value) && isRecord(value.metrics) ? value.metrics : value;
  if (!isRecord(raw)) return null;
  if (!isRecord(raw.runs) || !isRecord(raw.tool_calls) || !isRecord(raw.llm)) return null;

  return {
    runs: {
      started: numberAt(raw.runs.started),
      completed: numberAt(raw.runs.completed),
      failed: numberAt(raw.runs.failed),
      cancelled: numberAt(raw.runs.cancelled),
    },
    tool_calls: {
      total: numberAt(raw.tool_calls.total),
      failed: numberAt(raw.tool_calls.failed),
    },
    llm: {
      requests: numberAt(raw.llm.requests),
      prompt_tokens: numberAt(raw.llm.prompt_tokens),
      completion_tokens: numberAt(raw.llm.completion_tokens),
      total_tokens: numberAt(raw.llm.total_tokens),
    },
    duration_ms: {
      total: numberAt(isRecord(raw.duration_ms) ? raw.duration_ms.total : 0),
      max: numberAt(isRecord(raw.duration_ms) ? raw.duration_ms.max : 0),
      avg: numberAt(isRecord(raw.duration_ms) ? raw.duration_ms.avg : 0),
    },
    updated_at: numberAt(raw.updated_at),
  };
}

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
export async function runMetricsCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const parsed = parseMetricsArgs(args);
  if (!parsed.ok) return { handled: true, output: `\n${parsed.message}\n` };
  const options = parsed.value;

  if (ctx.rpc) {
    try {
      const raw = await ctx.rpc.request<unknown>('metrics.get', { source: options.source });
      const snapshot = readMetricsSnapshot(raw);
      if (!snapshot) {
        return { handled: true, output: '\nFailed to read metrics: invalid snapshot.\n' };
      }
      if (options.json) {
        return { handled: true, output: `\n${JSON.stringify(snapshot, null, 2)}\n` };
      }
      const prefix = options.source === 'trace' ? 'Metrics (rebuilt from trace): ' : '';
      return {
        handled: true,
        output: `\n${prefix}${formatMetrics(snapshot)}\n`,
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to read metrics:\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (options.source === 'trace') {
    return {
      handled: true,
      output: '\nMetrics rebuilt from trace require the RPC control plane.\n',
    };
  }

  if (!ctx.metrics) {
    return {
      handled: true,
      output: '\nMetrics are not enabled (observability.metrics: false).\n',
    };
  }

  try {
    const snapshot = ctx.metrics();
    return {
      handled: true,
      output: options.json
        ? `\n${JSON.stringify(snapshot, null, 2)}\n`
        : `\n${formatMetrics(snapshot)}\n`,
    };
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
    description: 'Show runtime metrics (live or rebuilt from trace)',
    usage: '/metrics [--source live|trace] [--json]',
    run: (args, ctx) => runMetricsCommand(args, ctx),
  };
}
