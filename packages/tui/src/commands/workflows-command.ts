/**
 * /workflows —— workflow run 列表 / 详情 / 启动 / 恢复 / 取消
 * @module @vessel-agent/tui
 *
 * 数据只来自 ReplContext.workflows（asm 注入的 name 版控制面）。
 * start/resume 返回 { workflowRunId, done }；命令只负责启动，运行态由 REPL 接管
 * （与 /runs resume 同构，DECISION-009 Addendum A §10.1）。
 */

import { classifyError, formatClassifiedError } from '../error-classifier.js';
import { t } from '../i18n/index.js';
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
import { fitCell, padToWidth, truncateToWidth } from '../utils/text-layout.js';
import { formatRelativeTime } from '../utils/time.js';
import type {
  DetailView,
  TableView,
  ViewAction,
  ViewActionInvocation,
  ViewTone,
} from '../views/types.js';
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
  return truncateToWidth(text, max);
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

/** 状态文本：无色终端也能区分 */
export function workflowStatusLabel(status: WorkflowRunStatusLike): string {
  return status === 'running' ? '◐ running' : status;
}

/** 行 tone（颜色是增强，不是唯一信息） */
export function workflowStatusTone(status: WorkflowRunStatusLike): ViewTone {
  if (status === 'failed') return 'danger';
  if (status === 'running' || status === 'interrupted' || status === 'pending') return 'warn';
  if (status === 'completed') return 'ok';
  return 'muted';
}

/** 短 id：窄屏展示 */
export function shortWorkflowRunId(runId: string, max = 18): string {
  const chars = Array.from(runId);
  if (chars.length <= max) return runId;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** /workflows 表格列 */
export function workflowRunColumns(): TableView['columns'] {
  return [
    { key: 'run', header: 'RUN', width: 18, priority: 1 },
    { key: 'workflow', header: 'WORKFLOW', width: 18, priority: 1 },
    { key: 'status', header: 'STATUS', width: 13, priority: 1 },
    { key: 'progress', header: 'PROGRESS', width: 9, priority: 1 },
    { key: 'updated', header: 'UPDATED', width: 10, priority: 2 },
    { key: 'error', header: 'ERROR', minWidth: 12, priority: 2 },
  ];
}

/** 表格动作：Enter 详情、r 恢复、x 取消（确认）、g 刷新 */
export function workflowRunActions(): ViewAction[] {
  return [
    { id: 'show', key: 'enter', label: 'open', enabled: 'selected' },
    { id: 'resume', key: 'r', label: 'resume', enabled: 'selected' },
    {
      id: 'cancel',
      key: 'x',
      label: 'cancel',
      tone: 'danger',
      enabled: 'selected',
      confirm: 'Cancel workflow run "{name}"?',
    },
    { id: 'refresh', key: 'g', label: 'refresh' },
  ];
}

/** 详情动作：r 恢复、x 取消、g 刷新 */
export function workflowDetailActions(): ViewAction[] {
  return [
    { id: 'resume', key: 'r', label: 'resume' },
    {
      id: 'cancel',
      key: 'x',
      label: 'cancel',
      tone: 'danger',
      confirm: 'Cancel this workflow run?',
    },
    { id: 'refresh', key: 'g', label: 'refresh' },
  ];
}

/** 表格视图上下文：保留 --status / --limit，刷新时不丢失 */
export function encodeWorkflowViewKey(
  filter?: WorkflowRunStatusLike,
  limit?: number,
): string | undefined {
  if (filter === undefined && limit === undefined) return undefined;
  return JSON.stringify({
    ...(filter !== undefined ? { status: filter } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

export interface WorkflowViewOptions {
  status?: WorkflowRunStatusLike;
  limit?: number;
}

/** 纯函数：解析表格上下文；非法值当作默认 */
export function decodeWorkflowViewKey(key: string | undefined): WorkflowViewOptions {
  if (!key) return {};
  try {
    const raw = JSON.parse(key) as { status?: unknown; limit?: unknown };
    const status =
      typeof raw.status === 'string' && isWorkflowRunStatus(raw.status) ? raw.status : undefined;
    const limit =
      typeof raw.limit === 'number' &&
      Number.isFinite(raw.limit) &&
      raw.limit >= 1 &&
      raw.limit <= DISPLAY_LIMIT
        ? Math.floor(raw.limit)
        : undefined;
    return {
      ...(status ? { status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  } catch {
    return {};
  }
}

/** 纯函数：list -> TableView */
export function buildWorkflowRunsView(
  runs: WorkflowRunSummaryLike[],
  now: number = Date.now(),
  filter?: WorkflowRunStatusLike,
  limit?: number,
): TableView {
  const rows = runs.map((run) => ({
    key: run.workflow_run_id,
    tone: workflowStatusTone(run.status),
    cells: {
      run: shortWorkflowRunId(run.workflow_run_id),
      workflow: run.workflow_name,
      status: workflowStatusLabel(run.status),
      progress: `${run.completed_steps}/${run.step_count}`,
      updated: safeRelativeTime(run.updated_at, now),
      error: run.error ? truncate(oneLine(run.error), 60) : '',
    },
  }));

  return {
    kind: 'table',
    title: 'Workflow runs',
    columns: workflowRunColumns(),
    rows,
    actions: workflowRunActions(),
    ...(rows[0] ? { initialKey: rows[0].key } : {}),
    emptyText: filter ? `No workflow runs with status "${filter}".` : 'No workflow runs.',
    meta: `${runs.length} · newest first`,
    ...(encodeWorkflowViewKey(filter, limit) ? { key: encodeWorkflowViewKey(filter, limit) } : {}),
  };
}

/** 纯函数：步骤表（已按详情宽度截断、限制行数） */
export function workflowStepLines(detail: WorkflowRunDetailLike, maxRows = 60): string[] {
  if (detail.steps.length === 0) return ['(no steps)'];

  // 16+6+10+3+8+19 + 5*2 gaps = 72：80 列终端里加上 2 空格前缀仍不触发截断。
  const widths = [16, 6, 10, 3, 8, 19] as const;
  const header = [
    fitCell('STEP', widths[0]),
    fitCell('TYPE', widths[1]),
    fitCell('STATUS', widths[2]),
    fitCell('ATT', widths[3], 'right'),
    fitCell('DURATION', widths[4]),
    fitCell('DETAIL', widths[5]),
  ].join('  ');

  const lines = [header];
  const visible = detail.steps.slice(0, Math.max(0, maxRows));
  for (const step of visible) {
    const detailText = step.error
      ? truncate(oneLine(step.error), widths[5])
      : step.output_preview
        ? truncate(oneLine(step.output_preview), widths[5])
        : '-';
    lines.push(
      [
        fitCell(step.id, widths[0]),
        fitCell(step.type, widths[1]),
        fitCell(step.status, widths[2]),
        fitCell(String(step.attempts), widths[3], 'right'),
        fitCell(stepDuration(step), widths[4]),
        fitCell(detailText, widths[5]),
      ].join('  '),
    );
  }
  if (detail.steps.length > visible.length) {
    lines.push(`… ${detail.steps.length - visible.length} more steps`);
  }
  return lines;
}

/** 纯函数：详情 -> DetailView（inputs + steps） */
export function buildWorkflowDetailView(
  detail: WorkflowRunDetailLike,
  now: number = Date.now(),
): DetailView {
  const fields: NonNullable<DetailView['sections'][number]['fields']> = [
    { label: 'Workflow', value: detail.workflow_name },
    {
      label: 'Status',
      value: workflowStatusLabel(detail.status),
      tone: workflowStatusTone(detail.status),
    },
    { label: 'Progress', value: `${detail.completed_steps}/${detail.step_count} steps` },
    { label: 'Started', value: safeRelativeTime(detail.started_at, now) },
    { label: 'Updated', value: safeRelativeTime(detail.updated_at, now) },
    { label: 'Definition', value: detail.definition_path || '-' },
    { label: 'Inputs', value: formatInputs(detail.inputs) },
  ];
  if (detail.error) {
    fields.push({
      label: 'Error',
      value: truncate(oneLine(detail.error), DETAIL_ERROR_MAX),
      tone: 'danger',
    });
  }

  return {
    kind: 'detail',
    title: `Workflow run ${detail.workflow_run_id}`,
    badge: { text: detail.status, tone: workflowStatusTone(detail.status) },
    key: detail.workflow_run_id,
    sections: [
      { title: 'Overview', fields },
      // 步骤表是预排版：DetailPanel 按内容宽度截断而不是换行，窄终端不破列。
      { title: 'Steps', lines: workflowStepLines(detail), preformatted: true },
    ],
    actions: workflowDetailActions(),
  };
}

/** 纯函数：workflow 未启用时的诚实空态 */
export function disabledWorkflowsView(): DetailView {
  return {
    kind: 'detail',
    title: 'Workflows',
    badge: { text: 'disabled', tone: 'warn' },
    sections: [
      {
        title: 'Not enabled',
        lines: ['Workflows are not enabled (workflow.enabled: false).'],
      },
    ],
  };
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
    `  ${padToWidth('RUN ID', RUN_ID_WIDTH)} ${padToWidth(
      'WORKFLOW',
      WORKFLOW_WIDTH,
    )} ${padToWidth('STATUS', STATUS_WIDTH)} ${padToWidth(
      'PROGRESS',
      PROGRESS_WIDTH,
    )} ${padToWidth('UPDATED', UPDATED_WIDTH)} ERROR`,
  );

  for (const run of runs) {
    const progress = `${run.completed_steps}/${run.step_count}`;
    const error = run.error ? truncate(oneLine(run.error), LIST_ERROR_MAX) : '';
    const row = `  ${padToWidth(
      truncate(run.workflow_run_id, RUN_ID_WIDTH),
      RUN_ID_WIDTH,
    )} ${padToWidth(truncate(run.workflow_name, WORKFLOW_WIDTH), WORKFLOW_WIDTH)} ${padToWidth(
      run.status,
      STATUS_WIDTH,
    )} ${padToWidth(progress, PROGRESS_WIDTH)} ${padToWidth(
      safeRelativeTime(run.updated_at, now),
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
    `  ${padToWidth('STEP', STEP_ID_WIDTH)} ${padToWidth(
      'TYPE',
      STEP_TYPE_WIDTH,
    )} ${padToWidth('STATUS', STEP_STATUS_WIDTH)} ${'ATT'.padStart(
      ATTEMPTS_WIDTH,
    )}  ${padToWidth('DURATION', DURATION_WIDTH)} DETAIL`,
  );

  if (detail.steps.length === 0) lines.push('  (no steps)');

  for (const step of detail.steps) {
    const detailText = step.error
      ? truncate(oneLine(step.error), STEP_DETAIL_MAX)
      : step.output_preview
        ? truncate(oneLine(step.output_preview), STEP_DETAIL_MAX)
        : '-';
    const row = `  ${padToWidth(
      truncate(step.id, STEP_ID_WIDTH),
      STEP_ID_WIDTH,
    )} ${padToWidth(step.type, STEP_TYPE_WIDTH)} ${padToWidth(
      step.status,
      STEP_STATUS_WIDTH,
    )} ${String(step.attempts).padStart(ATTEMPTS_WIDTH)}  ${padToWidth(
      stepDuration(step),
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

function workflowsEnvelope(view: TableView | DetailView): NonNullable<CommandResult['view']> {
  return { source: 'workflows', view };
}

function disabledMessage(): CommandResult {
  return {
    handled: true,
    output: '\nWorkflows are not enabled (workflow.enabled: false).\n',
    view: workflowsEnvelope(disabledWorkflowsView()),
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

/** 列表查询（命令主体与视图刷新共用；调用方负责排序与截断） */
async function loadWorkflowRuns(
  ctx: ReplContext,
  options: { status?: WorkflowRunStatusLike; limit: number },
): Promise<WorkflowRunSummaryLike[]> {
  const runs = ctx.rpc
    ? readWorkflowRuns(await ctx.rpc.request<unknown>('workflow.list', options))
    : await (ctx.workflows as WorkflowsControl).listRuns(options);
  return sortWorkflowRuns(runs).slice(0, options.limit);
}

/** 单条详情（命令主体与视图动作共用） */
async function loadWorkflowDetail(
  ctx: ReplContext,
  workflowRunId: string,
): Promise<WorkflowRunDetailLike | null> {
  return ctx.rpc
    ? readWorkflowDetail(
        await ctx.rpc.request<unknown>('workflow.get', { workflow_run_id: workflowRunId }),
      )
    : await (ctx.workflows as WorkflowsControl).getRun(workflowRunId);
}

/** `/workflows` 视图动作：Enter 详情、r 恢复、x 取消、g 刷新 */
export async function runWorkflowsViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  const targetId = invocation.selectionKey || invocation.viewKey || '';

  if (invocation.actionId === 'refresh') {
    try {
      if (invocation.viewKind === 'detail' && targetId) {
        const detail = await loadWorkflowDetail(ctx, targetId);
        if (!detail) return usage(`Workflow run "${targetId}" not found.`);
        return { handled: true, view: workflowsEnvelope(buildWorkflowDetailView(detail)) };
      }
      const options = decodeWorkflowViewKey(invocation.viewKey);
      const limit = options.limit ?? DISPLAY_LIMIT;
      const runs = await loadWorkflowRuns(ctx, {
        limit,
        ...(options.status ? { status: options.status } : {}),
      });
      return {
        handled: true,
        view: workflowsEnvelope(buildWorkflowRunsView(runs, Date.now(), options.status, limit)),
      };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to load workflow runs:\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (invocation.actionId === 'show' || invocation.actionId === 'enter') {
    if (!targetId) return usage('Select a workflow run first.');
    try {
      const detail = await loadWorkflowDetail(ctx, targetId);
      if (!detail) return usage(`Workflow run "${targetId}" not found.`);
      return { handled: true, view: workflowsEnvelope(buildWorkflowDetailView(detail)) };
    } catch (error) {
      return {
        handled: true,
        output: `\nFailed to load workflow run "${targetId}":\n${formatRpcError(error)}\n`,
      };
    }
  }

  if (invocation.actionId === 'resume') {
    if (!targetId) return usage('Select a workflow run first.');
    return runWorkflowsCommand(['resume', targetId], ctx);
  }

  if (invocation.actionId === 'cancel') {
    if (!targetId) return usage('Select a workflow run first.');
    return runWorkflowsCommand(['cancel', targetId], ctx);
  }

  return {
    handled: true,
    output: `\nUnknown /workflows view action "${invocation.actionId}".\n`,
  };
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
      const sorted = await loadWorkflowRuns(ctx, options);
      return {
        handled: true,
        output: formatWorkflowRuns(sorted, Date.now(), parsed.value.status),
        view: workflowsEnvelope(
          buildWorkflowRunsView(sorted, Date.now(), parsed.value.status, parsed.value.limit),
        ),
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
      const detail = await loadWorkflowDetail(ctx, parsed.value);
      if (!detail) return usage(`Workflow run "${parsed.value}" not found.`);
      return {
        handled: true,
        output: formatWorkflowDetail(detail),
        view: workflowsEnvelope(buildWorkflowDetailView(detail)),
      };
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
    description: t('command.workflows.description'),
    usage: '/workflows [list|run|show|resume|cancel]',
    category: 'run',
    keywords: ['pipeline', 'steps'],
    available: (ctx) => Boolean(ctx.workflows || ctx.rpc),
    unavailableHint: 'workflows disabled',
    run: (args, ctx) => runWorkflowsCommand(args, ctx),
    viewAction: (invocation, ctx) => runWorkflowsViewAction(invocation, ctx),
  };
}
