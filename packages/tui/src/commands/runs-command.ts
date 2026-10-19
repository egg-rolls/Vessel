/**
 * /runs —— durable run 列表与恢复
 * @module @vessel/tui
 *
 * 数据只来自 ReplContext.runs（asm 注入的 DurableRunsControl）。
 * 列表查询 running + interrupted 两次后合并（DECISION-008 Addendum B §9.5）。
 * 排序：updated_at 倒序，同值 run_id 升序；展示上限 20。
 */

import type {
  DurableRunHandle,
  DurableRunOutcome,
  DurableRunSummary,
  ReplContext,
} from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { waitForRunCompletion } from '../rpc-events.js';
import { formatRelativeTime } from '../utils/time.js';
import type { DetailView, TableView, ViewAction, ViewActionInvocation } from '../views/types.js';
import type { CommandEntry, CommandResult } from './commands.js';

const DISPLAY_LIMIT = 20;
const RUN_ID_WIDTH = 28;
const SESSION_WIDTH = 28;
const STATUS_WIDTH = 14;
const PREVIEW_MAX = 40;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 排序：updated_at 倒序，同值 run_id 升序（Addendum A §4 / Addendum B §9.5） */
export function sortRuns(runs: DurableRunSummary[]): DurableRunSummary[] {
  return [...runs].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    if (a.run_id === b.run_id) return 0;
    return a.run_id < b.run_id ? -1 : 1;
  });
}

/** 合并 running + interrupted，排序后截断到展示上限 */
export function mergeRuns(
  running: DurableRunSummary[],
  interrupted: DurableRunSummary[],
): DurableRunSummary[] {
  return sortRuns([...running, ...interrupted]).slice(0, DISPLAY_LIMIT);
}

function statusLabel(run: DurableRunSummary): string {
  return run.status === 'running' ? 'running (live)' : 'interrupted';
}

/** 视图状态同时带 glyph 与文本（无色终端也可读） */
export function runStatusLabel(run: DurableRunSummary): string {
  return run.status === 'running' ? '◐ running (live)' : '! interrupted';
}

/** 短 run id：窄屏展示；保留前 max-1 个字符 */
export function shortRunId(runId: string, max = 18): string {
  const chars = Array.from(runId);
  if (chars.length <= max) return runId;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** /runs 表格列（80 / 100+ 自适应） */
export function runsColumns(): TableView['columns'] {
  return [
    { key: 'run', header: 'RUN', width: 18, priority: 1 },
    { key: 'session', header: 'SESSION', width: 18, priority: 2 },
    { key: 'status', header: 'STATUS', width: 17, priority: 1 },
    { key: 'updated', header: 'UPDATED', width: 10, priority: 1 },
    { key: 'iter', header: 'ITER', width: 4, align: 'right', priority: 2 },
    { key: 'preview', header: 'PREVIEW', minWidth: 16, priority: 1 },
  ];
}

/** /runs 视图动作：Enter 恢复、x 取消、r 刷新 */
export function runsViewActions(): ViewAction[] {
  return [
    { id: 'resume', key: 'enter', label: 'resume', enabled: 'selected' },
    {
      id: 'cancel',
      key: 'x',
      label: 'cancel',
      tone: 'danger',
      enabled: 'selected',
      confirm: 'Cancel run "{name}"?',
    },
    { id: 'refresh', key: 'r', label: 'refresh' },
  ];
}

/** 纯函数：run 列表 -> TableView（行顺序与 formatRuns 一致） */
export function buildRunsView(runs: DurableRunSummary[], now: number = Date.now()): TableView {
  const rows = runs.map((run) => ({
    key: run.run_id,
    tone: run.status === 'running' ? ('warn' as const) : ('default' as const),
    cells: {
      run: shortRunId(run.run_id),
      runId: run.run_id,
      session: shortRunId(run.session_id),
      status: runStatusLabel(run),
      updated: formatRelativeTime(run.updated_at, now),
      iter: String(run.iteration ?? '-'),
      preview: truncate(oneLine(run.preview ?? ''), 60),
    },
  }));

  return {
    kind: 'table',
    title: 'Durable runs',
    columns: runsColumns(),
    rows,
    actions: runsViewActions(),
    ...(rows[0] ? { initialKey: rows[0].key } : {}),
    emptyText: 'No running or interrupted runs.',
    meta: `${runs.length} · newest first`,
  };
}

/** 纯函数：durable 未启用时的诚实空态 */
export function disabledRunsView(): DetailView {
  return {
    kind: 'detail',
    title: 'Durable runs',
    badge: { text: 'disabled', tone: 'warn' },
    sections: [
      {
        title: 'Not enabled',
        lines: ['Durable runs are not enabled (durable.enabled: false).'],
      },
    ],
  };
}

/** 纯函数：把 run 列表渲染成表格文本（测试用） */
export function formatRuns(runs: DurableRunSummary[], now: number = Date.now()): string {
  if (runs.length === 0) return '\nNo running or interrupted runs.\n';

  const lines = ['', `Durable runs (${runs.length}, newest first):`];
  lines.push(
    `  ${'RUN ID'.padEnd(RUN_ID_WIDTH)} ${'SESSION'.padEnd(SESSION_WIDTH)} ${'STATUS'.padEnd(
      STATUS_WIDTH,
    )} ${'UPDATED'.padEnd(10)} ${'ITER'.padStart(4)}  PREVIEW`,
  );

  for (const run of runs) {
    const preview = truncate(oneLine(run.preview ?? ''), PREVIEW_MAX);
    lines.push(
      `  ${truncate(run.run_id, RUN_ID_WIDTH).padEnd(RUN_ID_WIDTH)} ${truncate(
        run.session_id,
        SESSION_WIDTH,
      ).padEnd(SESSION_WIDTH)} ${statusLabel(run).padEnd(STATUS_WIDTH)} ${formatRelativeTime(
        run.updated_at,
        now,
      ).padEnd(10)} ${String(run.iteration ?? '-').padStart(4)}  ${preview}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

function runsEnvelope(view: TableView | DetailView): NonNullable<CommandResult['view']> {
  return { source: 'runs', view };
}

function disabledMessage(): CommandResult {
  return {
    handled: true,
    output: '\nDurable runs are not enabled (durable.enabled: false).\n',
    view: runsEnvelope(disabledRunsView()),
  };
}

function usage(message: string): CommandResult {
  return { handled: true, output: `\n${message}\n` };
}

function listFailure(error: unknown): CommandResult {
  return {
    handled: true,
    output: `\nFailed to list durable runs:\n${formatRpcError(error)}\n`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRunSummaries(value: unknown): DurableRunSummary[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.runs)
      ? value.runs
      : [];
  return raw
    .filter(
      (item): item is Record<string, unknown> => isRecord(item) && typeof item.run_id === 'string',
    )
    .map((item) => ({
      run_id: item.run_id as string,
      session_id: typeof item.session_id === 'string' ? item.session_id : '',
      ...(typeof item.agent_id === 'string' ? { agent_id: item.agent_id } : {}),
      ...(item.status === 'running' || item.status === 'interrupted'
        ? { status: item.status }
        : { status: 'interrupted' as const }),
      updated_at: typeof item.updated_at === 'number' ? item.updated_at : 0,
      ...(typeof item.iteration === 'number' ? { iteration: item.iteration } : {}),
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
    }));
}

interface ResumeResultLike {
  run_id: string;
  session_id: string;
}

function readResumeResult(value: unknown): ResumeResultLike | null {
  const raw = isRecord(value) && isRecord(value.run) ? value.run : value;
  if (!isRecord(raw)) return null;
  const runId =
    typeof raw.run_id === 'string'
      ? raw.run_id
      : typeof raw.runId === 'string'
        ? raw.runId
        : undefined;
  if (!runId) return null;
  const sessionId =
    typeof raw.session_id === 'string'
      ? raw.session_id
      : typeof raw.sessionId === 'string'
        ? raw.sessionId
        : '';
  return { run_id: runId, session_id: sessionId };
}

async function listRunSummaries(
  ctx: ReplContext,
  status: 'running' | 'interrupted',
  limit: number,
): Promise<DurableRunSummary[]> {
  if (ctx.rpc) {
    return readRunSummaries(await ctx.rpc.request<unknown>('runs.list', { status, limit }));
  }
  return ctx.runs ? ctx.runs.list({ status, limit }) : [];
}

function mapRunOutcome(outcome: {
  status: 'completed' | 'failed' | 'cancelled';
  error?: unknown;
}): DurableRunOutcome {
  if (outcome.status === 'failed') return { status: 'failed', error: outcome.error };
  return { status: outcome.status };
}

/** 0.5：RPC resume 只返回 id；完成由事件判定（Q2） */
function resumeViaRpc(ctx: ReplContext, runId: string): Promise<DurableRunHandle> {
  if (!ctx.rpc) throw new Error('rpc unavailable');
  const rpc = ctx.rpc;

  return rpc.request<unknown>('runs.resume', { run_id: runId }).then((raw) => {
    const result = readResumeResult(raw);
    if (!result) throw new Error('invalid runs.resume result');
    const waiter = waitForRunCompletion(rpc, result.run_id);

    return {
      runId: result.run_id,
      sessionId: result.session_id,
      done: waiter.done.then(mapRunOutcome),
      cancel: () => {
        waiter.stop();
        void rpc.request('runs.cancel', { run_id: result.run_id }).catch(() => undefined);
      },
    } satisfies DurableRunHandle;
  });
}

/** running + interrupted 合并、排序、截断（无参列表与视图刷新共用） */
async function loadRuns(ctx: ReplContext): Promise<DurableRunSummary[]> {
  const [running, interrupted] = await Promise.all([
    listRunSummaries(ctx, 'running', DISPLAY_LIMIT),
    listRunSummaries(ctx, 'interrupted', DISPLAY_LIMIT),
  ]);
  return mergeRuns(running, interrupted);
}

/** `/runs` 视图动作：Enter/r 恢复、x 取消、r 刷新（source 固定 'runs'） */
export async function runRunsViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  if (invocation.actionId === 'refresh') {
    try {
      const runs = await loadRuns(ctx);
      return { handled: true, view: runsEnvelope(buildRunsView(runs)) };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to list durable runs:\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (invocation.actionId === 'resume' || invocation.actionId === 'enter') {
    if (!invocation.selectionKey) {
      return usage('Select a run first.');
    }
    return runRunsCommand(['resume', invocation.selectionKey], ctx);
  }

  if (invocation.actionId === 'cancel') {
    if (!invocation.selectionKey) return usage('Select a run first.');
    if (!ctx.rpc) {
      return usage('Cancelling runs requires the RPC control plane.');
    }
    try {
      const result = await ctx.rpc.request<unknown>('runs.cancel', {
        run_id: invocation.selectionKey,
      });
      const cancelled =
        typeof result === 'object' && result !== null && 'cancelled' in result
          ? (result as { cancelled?: unknown }).cancelled
          : undefined;
      if (cancelled === false) {
        return {
          handled: true,
          output: `\nRun "${invocation.selectionKey}" is not running; nothing to cancel.\n`,
        };
      }
      return {
        handled: true,
        output: `\nCancellation requested for run "${invocation.selectionKey}".\n`,
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to cancel run "${invocation.selectionKey}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  return { handled: true, output: `\nUnknown /runs view action "${invocation.actionId}".\n` };
}

/** /runs 的执行体（导出供单测） */
export async function runRunsCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  if (!ctx.rpc && !ctx.runs) return disabledMessage();

  const [subcommand, runId, ...rest] = args;

  if (subcommand === undefined) {
    try {
      const runs = await loadRuns(ctx);
      return {
        handled: true,
        output: formatRuns(runs),
        view: runsEnvelope(buildRunsView(runs)),
      };
    } catch (error) {
      return listFailure(error);
    }
  }

  if (subcommand !== 'resume') {
    return usage(`Unknown /runs subcommand "${subcommand}". Usage: /runs [resume <runId>]`);
  }

  if (!runId || rest.length > 0) {
    return usage('Usage: /runs resume <runId>');
  }

  try {
    const handle = ctx.rpc
      ? await resumeViaRpc(ctx, runId)
      : await (ctx.runs as NonNullable<ReplContext['runs']>).resume(runId);
    ctx.onSessionChange(handle.sessionId);
    return {
      handled: true,
      output: `\nResuming run "${runId}" (session ${handle.sessionId})…\n`,
      nextState: { currentSessionId: handle.sessionId },
      resumeRun: handle,
    };
  } catch (error) {
    return {
      handled: true,
      output: `\nFailed to resume run "${runId}":\n${formatRpcError(error)}\n`,
    };
  }
}

export function runsCommand(): CommandEntry {
  return {
    name: 'runs',
    description: 'Durable runs: list / resume',
    usage: '/runs [resume <runId>]',
    category: 'run',
    keywords: ['durable', 'interrupt', 'recover'],
    available: (ctx) => Boolean(ctx.runs || ctx.rpc),
    unavailableHint: 'durable disabled',
    run: (args, ctx) => runRunsCommand(args, ctx),
    viewAction: (invocation, ctx) => runRunsViewAction(invocation, ctx),
  };
}
