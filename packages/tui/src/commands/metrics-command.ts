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
import { t } from '../i18n/index.js';
import type { MetricsSnapshotLike, ReplContext } from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { formatRelativeTime } from '../utils/time.js';
import type { DetailView, ViewAction, ViewActionInvocation } from '../views/types.js';
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

function metricsUpdated(snapshot: MetricsSnapshotLike, now: number): string {
  return Number.isFinite(snapshot.updated_at) && snapshot.updated_at > 0
    ? formatRelativeTime(snapshot.updated_at, now)
    : '-';
}

/** 视图动作：r 刷新；有 RPC 时 t 在 live/trace 间切换 */
export function metricsActions(canToggleSource: boolean): ViewAction[] {
  const actions: ViewAction[] = [{ id: 'refresh', key: 'r', label: 'refresh' }];
  if (canToggleSource) actions.push({ id: 'source', key: 't', label: 'live/trace' });
  return actions;
}

/** 纯函数：KPI 详情（分区而非一行拼接） */
export function buildMetricsDetailView(
  snapshot: MetricsSnapshotLike,
  source: MetricsSource,
  options: { now?: number; canToggleSource?: boolean } = {},
): DetailView {
  const now = options.now ?? Date.now();
  return {
    kind: 'detail',
    title: 'Metrics',
    badge: { text: source, tone: source === 'trace' ? 'info' : 'ok' },
    key: source,
    sections: [
      {
        title: 'Overview',
        fields: [
          { label: 'Source', value: source === 'trace' ? 'rebuilt from trace' : 'live' },
          { label: 'Updated', value: metricsUpdated(snapshot, now) },
        ],
      },
      {
        title: 'Runs',
        fields: [
          { label: 'Started', value: String(snapshot.runs.started) },
          { label: 'Completed', value: String(snapshot.runs.completed), tone: 'ok' },
          { label: 'Failed', value: String(snapshot.runs.failed), tone: 'danger' },
          { label: 'Cancelled', value: String(snapshot.runs.cancelled), tone: 'warn' },
        ],
      },
      {
        title: 'Tools',
        fields: [
          { label: 'Calls', value: String(snapshot.tool_calls.total) },
          { label: 'Failed', value: String(snapshot.tool_calls.failed), tone: 'danger' },
        ],
      },
      {
        title: 'LLM',
        fields: [
          { label: 'Requests', value: String(snapshot.llm.requests) },
          { label: 'Prompt tokens', value: String(snapshot.llm.prompt_tokens) },
          { label: 'Completion tokens', value: String(snapshot.llm.completion_tokens) },
          { label: 'Total tokens', value: String(snapshot.llm.total_tokens) },
        ],
      },
      {
        title: 'Duration',
        fields: [
          { label: 'Total', value: formatMs(snapshot.duration_ms.total) },
          { label: 'Avg', value: formatMs(snapshot.duration_ms.avg) },
          { label: 'Max', value: formatMs(snapshot.duration_ms.max) },
        ],
      },
    ],
    actions: metricsActions(options.canToggleSource === true),
  };
}

type MetricsFetch = { ok: true; snapshot: MetricsSnapshotLike } | { ok: false; message: string };

/** 读取快照（命令主体与视图刷新共用；错误文本与既有命令一致） */
export async function fetchMetricsSnapshot(
  ctx: ReplContext,
  source: MetricsSource,
): Promise<MetricsFetch> {
  if (ctx.rpc) {
    try {
      const raw = await ctx.rpc.request<unknown>('metrics.get', { source });
      const snapshot = readMetricsSnapshot(raw);
      if (!snapshot) return { ok: false, message: 'Failed to read metrics: invalid snapshot.' };
      return { ok: true, snapshot };
    } catch (error) {
      return { ok: false, message: `Failed to read metrics:\n${formatRpcError(error)}` };
    }
  }

  if (source === 'trace') {
    return { ok: false, message: 'Metrics rebuilt from trace require the RPC control plane.' };
  }
  if (!ctx.metrics) {
    return { ok: false, message: 'Metrics are not enabled (observability.metrics: false).' };
  }
  try {
    return { ok: true, snapshot: ctx.metrics() };
  } catch (error) {
    return {
      ok: false,
      message: `Failed to read metrics:\n${formatClassifiedError(classifyError(error))}`,
    };
  }
}

/** `/metrics` 视图动作：r 刷新；有 RPC 时 t 切换 live/trace */
export async function runMetricsViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  const current: MetricsSource = invocation.viewKey === 'trace' ? 'trace' : 'live';

  if (invocation.actionId === 'refresh') {
    const result = await fetchMetricsSnapshot(ctx, current);
    if (!result.ok) return { handled: true, output: `\n${result.message}\n` };
    return {
      handled: true,
      view: {
        source: 'metrics',
        view: buildMetricsDetailView(result.snapshot, current, { canToggleSource: true }),
      },
    };
  }

  if (invocation.actionId === 'source') {
    if (!ctx.rpc) {
      return {
        handled: true,
        output: '\nMetrics rebuilt from trace require the RPC control plane.\n',
      };
    }
    const next: MetricsSource = current === 'trace' ? 'live' : 'trace';
    const result = await fetchMetricsSnapshot(ctx, next);
    if (!result.ok) return { handled: true, output: `\n${result.message}\n` };
    return {
      handled: true,
      view: {
        source: 'metrics',
        view: buildMetricsDetailView(result.snapshot, next, { canToggleSource: true }),
      },
    };
  }

  return {
    handled: true,
    output: `\nUnknown /metrics view action "${invocation.actionId}".\n`,
  };
}

/** /metrics 的执行体（导出供单测） */
export async function runMetricsCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const parsed = parseMetricsArgs(args);
  if (!parsed.ok) return { handled: true, output: `\n${parsed.message}\n` };
  const options = parsed.value;

  const loaded = await fetchMetricsSnapshot(ctx, options.source);
  if (!loaded.ok) {
    return { handled: true, output: `\n${loaded.message}\n` };
  }
  const snapshot = loaded.snapshot;

  // JSON 是机器可读出口：保持纯文本，不返回 view。
  if (options.json) {
    return { handled: true, output: `\n${JSON.stringify(snapshot, null, 2)}\n` };
  }

  const prefix = options.source === 'trace' ? 'Metrics (rebuilt from trace): ' : '';
  return {
    handled: true,
    output: `\n${prefix}${formatMetrics(snapshot)}\n`,
    view: {
      source: 'metrics',
      view: buildMetricsDetailView(snapshot, options.source, {
        canToggleSource: Boolean(ctx.rpc),
      }),
    },
  };
}

export function metricsCommand(): CommandEntry {
  return {
    name: 'metrics',
    description: t('command.metrics.description'),
    usage: '/metrics [--source live|trace] [--json]',
    category: 'inspect',
    keywords: ['tokens', 'usage', 'stats'],
    available: (ctx) => Boolean(ctx.metrics || ctx.rpc),
    unavailableHint: 'not enabled',
    run: (args, ctx) => runMetricsCommand(args, ctx),
    viewAction: (invocation, ctx) => runMetricsViewAction(invocation, ctx),
  };
}
