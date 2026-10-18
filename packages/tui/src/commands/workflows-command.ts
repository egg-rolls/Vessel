/**
 * /workflows —— workflow run 列表 / 详情 / 启动 / 恢复 / 取消
 * @module @vessel/tui
 *
 * 数据只来自 ReplContext.workflows（asm 注入的 name 版控制面）。
 * start/resume 返回 { workflowRunId, done }；命令只负责启动，运行态由 REPL 接管
 * （与 /runs resume 同构，DECISION-009 Addendum A §10.1）。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import type { WorkflowTurnOutcome } from '../repl/run-turn.js';
import type {
  ReplContext,
  WorkflowOutcomeLike,
  WorkflowRunDetailLike,
  WorkflowRunHandle,
  WorkflowRunStatusLike,
  WorkflowRunSummaryLike,
  WorkflowStartResultLike,
  WorkflowStepSummaryLike,
  WorkflowsControl,
} from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import { waitForWorkflowCompletion } from '../rpc-events.js';
import { formatRelativeTime } from '../utils/time.js';
import type { CommandEntry, CommandResult } from './commands.js';

const DISPLAY_LIMIT = 20;
const RUN_ID_WIDTH = 28;
const WORKFLOW_WIDTH = 24;
const STATUS_WIDTH = 12;
const PROGRESS_WIDTH = 9;
const UPDATED_WIDTH = 10;
const STEP_ID_WIDTH = 20;
const STEP_TYPE_WIDTH = 6;
const STEP_STATUS_WIDTH = 10;
const ATTEMPTS_WIDTH = 3;
const DURATION_WIDTH = 9;
const LIST_ERROR_MAX = 80;
const DETAIL_ERROR_MAX = 120;
const STEP_DETAIL_MAX = 80;
const INPUTS_MAX = 120;
const USAGE_LIST = 'Usage: /workflows list [--status <status>] [--limit <n>]';
const USAGE_RUN = 'Usage: /workflows run <name> [--input key=value]...';
const USAGE_WORKFLOWS =
  'Unknown /workflows subcommand "<x>". Usage: /workflows [list|run|show|resume|cancel]';

const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatusLike[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

function isWorkflowRunStatus(value: string): value is WorkflowRunStatusLike {
  return (WORKFLOW_RUN_STATUSES as readonly string[]).includes(value);
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeRelativeTime(ts: number, now: number): string {
  return Number.isFinite(ts) && ts > 0 ? formatRelativeTime(ts, now) : '-';
}

/** 毫秒 -> 1.2s / 350ms；非法值返回 "-" */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function stepDuration(step: WorkflowStepSummaryLike): string {
  if (typeof step.started_at !== 'number' || typeof step.finished_at !== 'number') return '-';
  return formatDurationMs(step.finished_at - step.started_at);
}

function formatInputs(inputs: Record<string, string>): string {
  const entries = Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return '-';
  return truncate(entries.map(([key, value]) => `${key}=${value}`).join(', '), INPUTS_MAX);
}

/** 排序：updated_at 倒序，同值 workflow_run_id 升序（DECISION-009 §5.1.3） */
export function sortWorkflowRuns(runs: WorkflowRunSummaryLike[]): WorkflowRunSummaryLike[] {
  return [...runs].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at - a.updated_at;
    if (a.workflow_run_id === b.workflow_run_id) return 0;
    return a.workflow_run_id < b.workflow_run_id ? -1 : 1;
  });
}

/** 纯函数：列表渲染（调用方负责排序与截断） */
export function formatWorkflowRuns(
  runs: WorkflowRunSummaryLike[],
  now: number = Date.now(),
  filter?: WorkflowRunStatusLike,
): string {
  if (runs.length === 0) {
    return filter ? `\nNo workflow runs with status "${filter}".\n` : '\nNo workflow runs.\n';
  }

  const lines = ['', `Workflow runs (${runs.length}, newest first):`];
  lines.push(
    `  ${'RUN ID'.padEnd(RUN_ID_WIDTH)} ${'WORKFLOW'.padEnd(WORKFLOW_WIDTH)} ${'STATUS'.padEnd(
      STATUS_WIDTH,
    )} ${'PROGRESS'.padEnd(PROGRESS_WIDTH)} ${'UPDATED'.padEnd(UPDATED_WIDTH)} ERROR`,
  );

  for (const run of runs) {
    const progress = `${run.completed_steps}/${run.step_count}`;
    const error = run.error ? truncate(oneLine(run.error), LIST_ERROR_MAX) : '';
    const row = `  ${truncate(run.workflow_run_id, RUN_ID_WIDTH).padEnd(
      RUN_ID_WIDTH,
    )} ${truncate(run.workflow_name, WORKFLOW_WIDTH).padEnd(WORKFLOW_WIDTH)} ${run.status.padEnd(
      STATUS_WIDTH,
    )} ${progress.padEnd(PROGRESS_WIDTH)} ${safeRelativeTime(run.updated_at, now).padEnd(
      UPDATED_WIDTH,
    )} ${error}`;
    lines.push(row.trimEnd());
  }

  lines.push('');
  return lines.join('\n');
}

/** 纯函数：详情渲染（步骤状态、错误、输出预览） */
export function formatWorkflowDetail(
  detail: WorkflowRunDetailLike,
  now: number = Date.now(),
): string {
  const lines = ['', `Workflow run ${detail.workflow_run_id} (${detail.workflow_name})`];
  lines.push(`  status:      ${detail.status}`);
  lines.push(`  progress:    ${detail.completed_steps}/${detail.step_count} steps`);
  lines.push(`  started:     ${safeRelativeTime(detail.started_at, now)}`);
  lines.push(`  updated:     ${safeRelativeTime(detail.updated_at, now)}`);
  lines.push(`  definition:  ${detail.definition_path || '-'}`);
  lines.push(`  inputs:      ${formatInputs(detail.inputs)}`);
  if (detail.error)
    lines.push(`  error:       ${truncate(oneLine(detail.error), DETAIL_ERROR_MAX)}`);
  lines.push('  steps:');
  lines.push(
    `  ${'STEP'.padEnd(STEP_ID_WIDTH)} ${'TYPE'.padEnd(STEP_TYPE_WIDTH)} ${'STATUS'.padEnd(
      STEP_STATUS_WIDTH,
    )} ${'ATT'.padStart(ATTEMPTS_WIDTH)}  ${'DURATION'.padEnd(DURATION_WIDTH)} DETAIL`,
  );

  if (detail.steps.length === 0) lines.push('  (no steps)');

  for (const step of detail.steps) {
    const detailText = step.error
      ? truncate(oneLine(step.error), STEP_DETAIL_MAX)
      : step.output_preview
        ? truncate(oneLine(step.output_preview), STEP_DETAIL_MAX)
        : '-';
    const row = `  ${truncate(step.id, STEP_ID_WIDTH).padEnd(
      STEP_ID_WIDTH,
    )} ${step.type.padEnd(STEP_TYPE_WIDTH)} ${step.status.padEnd(
      STEP_STATUS_WIDTH,
    )} ${String(step.attempts).padStart(ATTEMPTS_WIDTH)}  ${stepDuration(step).padEnd(
      DURATION_WIDTH,
    )} ${detailText}`;
    lines.push(row.trimEnd());
  }

  lines.push('');
  return lines.join('\n');
}

/** 纯函数：/workflows run|resume 的结局行 */
export function formatWorkflowOutcome(workflowRunId: string, outcome: WorkflowTurnOutcome): string {
  switch (outcome.status) {
    case 'completed':
      return `✓ Workflow run "${workflowRunId}" completed.`;
    case 'cancelled':
      return `⏹ Workflow run "${workflowRunId}" cancelled.`;
    case 'interrupted':
      return `⚠ Workflow run "${workflowRunId}" interrupted. Resume with /workflows resume ${workflowRunId}.`;
    case 'failed':
      return `✗ Workflow run "${workflowRunId}" failed: ${formatClassifiedError(
        classifyError(outcome.error),
      )}`;
  }
}

// ── 参数解析 ─────────────────────────────────────

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

export interface WorkflowListOptions {
  status?: WorkflowRunStatusLike;
  limit: number;
}

export interface WorkflowRunOptions {
  name: string;
  inputs?: Record<string, string>;
}

/** TUI 只接受单段安全名：拒绝 / \ . ..（DECISION-009 Addendum A §10.1.1） */
export function isValidWorkflowName(name: string): boolean {
  return (
    name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
  );
}

export function parseWorkflowListArgs(args: string[]): ParseResult<WorkflowListOptions> {
  let status: WorkflowRunStatusLike | undefined;
  let limit = DISPLAY_LIMIT;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === '--status') {
      const value = args[++i];
      if (value === undefined) return { ok: false, message: USAGE_LIST };
      if (!isWorkflowRunStatus(value)) {
        return {
          ok: false,
          message: `Invalid status "${value}". Valid: ${WORKFLOW_RUN_STATUSES.join(', ')}.`,
        };
      }
      status = value;
      continue;
    }

    if (arg === '--limit') {
      const value = args[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        return { ok: false, message: '--limit must be an integer between 1 and 20.' };
      }
      const parsed = Number.parseInt(value, 10);
      if (parsed < 1 || parsed > DISPLAY_LIMIT) {
        return { ok: false, message: '--limit must be an integer between 1 and 20.' };
      }
      limit = parsed;
      continue;
    }

    return { ok: false, message: `${USAGE_LIST} (unknown argument "${arg}")` };
  }

  return { ok: true, value: status ? { status, limit } : { limit } };
}

export function parseWorkflowRunArgs(args: string[]): ParseResult<WorkflowRunOptions> {
  const name = args[0];
  if (name === undefined) return { ok: false, message: USAGE_RUN };
  if (!isValidWorkflowName(name)) {
    return {
      ok: false,
      message: `Invalid workflow name "${name}"; use a name under workflow.dir (no path separators).`,
    };
  }

  const inputs: Record<string, string> = {};
  let hasInputs = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--input') return { ok: false, message: USAGE_RUN };

    const pair = args[++i];
    if (pair === undefined) return { ok: false, message: USAGE_RUN };

    const separator = pair.indexOf('=');
    if (separator <= 0) {
      return { ok: false, message: `Invalid --input "${pair}". ${USAGE_RUN}` };
    }

    inputs[pair.slice(0, separator)] = pair.slice(separator + 1);
    hasInputs = true;
  }

  return { ok: true, value: hasInputs ? { name, inputs } : { name } };
}

// ── 命令执行 ─────────────────────────────────────

function usage(message: string): CommandResult {
  return { handled: true, output: `\n${message}\n` };
}

function disabledMessage(): CommandResult {
  return {
    handled: true,
    output: '\nWorkflows are not enabled (workflow.enabled: false).\n',
  };
}

function makeHandle(
  control: WorkflowsControl,
  started: WorkflowStartResultLike,
): WorkflowRunHandle {
  return {
    workflowRunId: started.workflowRunId,
    done: started.done,
    cancel: () => control.cancel(started.workflowRunId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isWorkflowStatus(value: unknown): value is WorkflowRunStatusLike {
  return typeof value === 'string' && isWorkflowRunStatus(value);
}

function isStepStatus(value: unknown): value is WorkflowStepSummaryLike['status'] {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'cancelled'
  );
}

function readWorkflowId(value: unknown): string | null {
  const raw = isRecord(value) && isRecord(value.workflow) ? value.workflow : value;
  if (!isRecord(raw)) return null;
  if (typeof raw.workflow_run_id === 'string') return raw.workflow_run_id;
  if (typeof raw.workflowRunId === 'string') return raw.workflowRunId;
  return null;
}

function readWorkflowSummary(value: unknown): WorkflowRunSummaryLike | null {
  if (!isRecord(value) || typeof value.workflow_run_id !== 'string') return null;
  return {
    workflow_run_id: value.workflow_run_id,
    workflow_name: typeof value.workflow_name === 'string' ? value.workflow_name : '-',
    status: isWorkflowStatus(value.status) ? value.status : 'pending',
    step_count: numberAt(value.step_count),
    completed_steps: numberAt(value.completed_steps),
    started_at: numberAt(value.started_at),
    updated_at: numberAt(value.updated_at),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function readWorkflowRuns(value: unknown): WorkflowRunSummaryLike[] {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.workflows)
      ? value.workflows
      : isRecord(value) && Array.isArray(value.runs)
        ? value.runs
        : [];
  return raw.map(readWorkflowSummary).filter((run): run is WorkflowRunSummaryLike => run !== null);
}

function readStep(value: unknown): WorkflowStepSummaryLike | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  return {
    id: value.id,
    type: value.type === 'tool' ? 'tool' : 'agent',
    status: isStepStatus(value.status) ? value.status : 'pending',
    attempts: numberAt(value.attempts),
    ...(typeof value.started_at === 'number' ? { started_at: value.started_at } : {}),
    ...(typeof value.finished_at === 'number' ? { finished_at: value.finished_at } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.output_preview === 'string' ? { output_preview: value.output_preview } : {}),
  };
}

function readInputs(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const inputs: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') inputs[key] = item;
  }
  return inputs;
}

function readWorkflowDetail(value: unknown): WorkflowRunDetailLike | null {
  const raw = isRecord(value) && isRecord(value.workflow) ? value.workflow : value;
  const summary = readWorkflowSummary(raw);
  if (!summary || !isRecord(raw)) return null;
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map(readStep).filter((step): step is WorkflowStepSummaryLike => step !== null)
    : [];
  return {
    ...summary,
    definition_path: typeof raw.definition_path === 'string' ? raw.definition_path : '',
    inputs: readInputs(raw.inputs),
    steps,
  };
}

/** 0.5：RPC start/resume 只返回 id，完成由 workflow.* 事件判定（Q2） */
function makeRpcHandle(
  rpc: NonNullable<ReplContext['rpc']>,
  workflowRunId: string,
): WorkflowRunHandle {
  const waiter = waitForWorkflowCompletion(rpc, workflowRunId);
  return {
    workflowRunId,
    done: waiter.done.then(
      (outcome): WorkflowOutcomeLike => ({
        workflow_run_id: workflowRunId,
        status: outcome.status,
        ...(outcome.error !== undefined ? { error: String(outcome.error) } : {}),
      }),
    ),
    cancel: async () => {
      waiter.stop();
      await rpc
        .request('workflow.cancel', { workflow_run_id: workflowRunId })
        .catch(() => undefined);
    },
  };
}

function singleId(args: string[], subcommand: string): ParseResult<string> {
  const id = args[0];
  if (id === undefined || id.length === 0 || args.length !== 1) {
    return { ok: false, message: `Usage: /workflows ${subcommand} <id>` };
  }
  return { ok: true, value: id };
}

/** /workflows 的执行体（导出供单测） */
export async function runWorkflowsCommand(
  args: string[],
  ctx: ReplContext,
): Promise<CommandResult> {
  const rpc = ctx.rpc;
  const control = ctx.workflows;
  if (!rpc && !control) return disabledMessage();

  const [subcommand, ...rest] = args;

  if (subcommand === undefined || subcommand === 'list') {
    const parsed = parseWorkflowListArgs(rest);
    if (!parsed.ok) return usage(parsed.message);
    try {
      const options: { status?: WorkflowRunStatusLike; limit: number } = {
        limit: parsed.value.limit,
      };
      if (parsed.value.status) options.status = parsed.value.status;
      const runs = rpc
        ? readWorkflowRuns(await rpc.request<unknown>('workflow.list', options))
        : await (control as WorkflowsControl).listRuns(options);
      const sorted = sortWorkflowRuns(runs).slice(0, parsed.value.limit);
      return {
        handled: true,
        output: formatWorkflowRuns(sorted, Date.now(), parsed.value.status),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to list workflow runs:\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'run') {
    const parsed = parseWorkflowRunArgs(rest);
    if (!parsed.ok) return usage(parsed.message);
    try {
      if (rpc) {
        const raw = await rpc.request<unknown>('workflow.start', {
          name: parsed.value.name,
          ...(parsed.value.inputs ? { inputs: parsed.value.inputs } : {}),
        });
        const id = readWorkflowId(raw);
        if (!id) throw new Error('invalid workflow.start result');
        return {
          handled: true,
          output: `\nStarted workflow run "${id}" (${parsed.value.name}).\n`,
          workflowRun: makeRpcHandle(rpc, id),
        };
      }

      const started = await (control as WorkflowsControl).start(
        parsed.value.name,
        parsed.value.inputs ? { inputs: parsed.value.inputs } : undefined,
      );
      return {
        handled: true,
        output: `\nStarted workflow run "${started.workflowRunId}" (${parsed.value.name}).\n`,
        workflowRun: makeHandle(control as WorkflowsControl, started),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to start workflow "${parsed.value.name}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'show') {
    const parsed = singleId(rest, subcommand);
    if (!parsed.ok) return usage(parsed.message);
    try {
      const detail = rpc
        ? readWorkflowDetail(
            await rpc.request<unknown>('workflow.get', { workflow_run_id: parsed.value }),
          )
        : await (control as WorkflowsControl).getRun(parsed.value);
      if (!detail) return usage(`Workflow run "${parsed.value}" not found.`);
      return { handled: true, output: formatWorkflowDetail(detail) };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to load workflow run "${parsed.value}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'resume') {
    const parsed = singleId(rest, subcommand);
    if (!parsed.ok) return usage(parsed.message);
    try {
      if (rpc) {
        const raw = await rpc.request<unknown>('workflow.resume', {
          workflow_run_id: parsed.value,
        });
        const resumedId = readWorkflowId(raw) ?? parsed.value;
        return {
          handled: true,
          output: `\nResuming workflow run "${resumedId}"...\n`,
          workflowRun: makeRpcHandle(rpc, resumedId),
        };
      }

      const started = await (control as WorkflowsControl).resume(parsed.value);
      return {
        handled: true,
        output: `\nResuming workflow run "${started.workflowRunId}"...\n`,
        workflowRun: makeHandle(control as WorkflowsControl, started),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to resume workflow run "${parsed.value}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (subcommand === 'cancel') {
    const parsed = singleId(rest, subcommand);
    if (!parsed.ok) return usage(parsed.message);
    try {
      if (rpc) {
        await rpc.request('workflow.cancel', { workflow_run_id: parsed.value });
      } else {
        await (control as WorkflowsControl).cancel(parsed.value);
      }
      return {
        handled: true,
        output: `\nCancellation requested for workflow run "${parsed.value}".\n`,
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to cancel workflow run "${parsed.value}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  return usage(USAGE_WORKFLOWS.replace('<x>', subcommand));
}

export function workflowsCommand(): CommandEntry {
  return {
    name: 'workflows',
    description: 'Workflows: list / run / show / resume / cancel',
    usage: '/workflows [list|run|show|resume|cancel]',
    run: (args, ctx) => runWorkflowsCommand(args, ctx),
  };
}
