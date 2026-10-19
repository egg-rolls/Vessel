/** 运行列表的纯选择器（Live / Durable 分 tab，不做跨源合并）。 */
import type { DurableRunSummary, RunStatus } from '../gateway/types';

export type RunStatusFilter =
  | 'all'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const RUN_PAGE_SIZE = 100;

export function isCancellableRun(status: string): boolean {
  return status === 'queued' || status === 'running';
}

/** durable run 的「恢复运行」条件（后端还会做最终校验）。 */
export function isResumableRun(status: string): boolean {
  return status === 'interrupted' || status === 'failed' || status === 'pending';
}

export function sortLiveRuns(runs: readonly RunStatus[]): RunStatus[] {
  return [...runs].sort(
    (a, b) => (b.started_at ?? 0) - (a.started_at ?? 0) || b.run_id.localeCompare(a.run_id),
  );
}

export function sortDurableRuns(runs: readonly DurableRunSummary[]): DurableRunSummary[] {
  return [...runs].sort((a, b) => b.updated_at - a.updated_at || b.run_id.localeCompare(a.run_id));
}

export interface RunFilter {
  query?: string;
  status?: RunStatusFilter;
  sessionId?: string;
}

function matchesStatus(status: string, filter: RunStatusFilter): boolean {
  return filter === 'all' || status === filter;
}

export function filterLiveRuns(
  runs: readonly RunStatus[],
  { query = '', status = 'all', sessionId }: RunFilter = {},
): RunStatus[] {
  const needle = query.trim().toLowerCase();
  return runs.filter((run) => {
    if (!matchesStatus(run.status, status)) return false;
    if (sessionId && run.session_id !== sessionId) return false;
    if (!needle) return true;
    return [run.run_id, run.session_id, run.output, run.error].some((value) =>
      (value ?? '').toLowerCase().includes(needle),
    );
  });
}

export function filterDurableRuns(
  runs: readonly DurableRunSummary[],
  { query = '', status = 'all', sessionId }: RunFilter = {},
): DurableRunSummary[] {
  const needle = query.trim().toLowerCase();
  return runs.filter((run) => {
    if (!matchesStatus(run.status, status)) return false;
    if (sessionId && run.session_id !== sessionId) return false;
    if (!needle) return true;
    return [run.run_id, run.session_id, run.agent_id, run.preview].some((value) =>
      (value ?? '').toLowerCase().includes(needle),
    );
  });
}

export function takeRuns<T>(
  list: readonly T[],
  limit: number,
): { shown: T[]; hiddenCount: number } {
  if (limit <= 0) return { shown: [], hiddenCount: list.length };
  if (limit >= list.length) return { shown: list.slice(), hiddenCount: 0 };
  return { shown: list.slice(0, limit), hiddenCount: list.length - limit };
}

/** 恢复冲突：后端用 conflict + legacy_code=run_already_running 表达「已在恢复」。 */
export function isAlreadyResumedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  return (
    code === 'conflict' || message.includes('run_already_running') || message.includes('conflict')
  );
}

/** 运行耗时（缺失时返回 undefined）。 */
export function runDurationMs(
  run: Pick<RunStatus, 'started_at' | 'completed_at'>,
): number | undefined {
  if (run.started_at === undefined || run.completed_at === undefined) return undefined;
  return Math.max(0, run.completed_at - run.started_at);
}
