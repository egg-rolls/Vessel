/**
 * /runs —— durable run 列表与恢复
 * @module @vessel/tui
 *
 * 数据只来自 ReplContext.runs（asm 注入的 DurableRunsControl）。
 * 列表查询 running + interrupted 两次后合并（DECISION-008 Addendum B §9.5）。
 * 排序：updated_at 倒序，同值 run_id 升序；展示上限 20。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import type { DurableRunSummary, ReplContext } from '../repl-context.js';
import { formatRelativeTime } from '../utils/time.js';
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

function disabledMessage(): CommandResult {
  return {
    handled: true,
    output: '\nDurable runs are not enabled (durable.enabled: false).\n',
  };
}

function usage(message: string): CommandResult {
  return { handled: true, output: `\n${message}\n` };
}

function listFailure(error: unknown): CommandResult {
  return {
    handled: true,
    output: `\nFailed to list durable runs:\n${formatClassifiedError(classifyError(error))}\n`,
  };
}

/** /runs 的执行体（导出供单测） */
export async function runRunsCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const control = ctx.runs;
  if (!control) return disabledMessage();

  const [subcommand, runId, ...rest] = args;

  if (subcommand === undefined) {
    try {
      const [running, interrupted] = await Promise.all([
        control.list({ status: 'running', limit: DISPLAY_LIMIT }),
        control.list({ status: 'interrupted', limit: DISPLAY_LIMIT }),
      ]);
      return { handled: true, output: formatRuns(mergeRuns(running, interrupted)) };
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
    const handle = await control.resume(runId);
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
      output: `\nFailed to resume run "${runId}":\n${formatClassifiedError(
        classifyError(error),
      )}\n`,
    };
  }
}

export function runsCommand(): CommandEntry {
  return {
    name: 'runs',
    description: 'Durable runs: list / resume',
    usage: '/runs [resume <runId>]',
    run: (args, ctx) => runRunsCommand(args, ctx),
  };
}
