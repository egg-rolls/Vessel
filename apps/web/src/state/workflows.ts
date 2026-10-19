/** workflow 列表/详情的纯选择器（与 gateway 的状态机对齐）。 */
import type { WorkflowRunStatus, WorkflowRunSummary } from '../gateway/types';

export type WorkflowStatusFilter = 'all' | WorkflowRunStatus;

/**
 * 可恢复：gateway 只在 running / completed / cancelled 之外允许 resume。
 * UI 对 pending / interrupted / failed 提供「恢复」。
 */
export function workflowStatusResumable(status: WorkflowRunStatus): boolean {
  return status === 'pending' || status === 'interrupted' || status === 'failed';
}

/** 非终态才可取消（失败/完成/取消都不可再取消）。 */
export function workflowStatusCancellable(status: WorkflowRunStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

/** active = 需要 2s 轮询的状态。 */
export function workflowStatusActive(status: WorkflowRunStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'interrupted';
}

export function filterWorkflows(
  workflows: readonly WorkflowRunSummary[],
  filter: WorkflowStatusFilter,
): WorkflowRunSummary[] {
  return filter === 'all'
    ? [...workflows]
    : workflows.filter((workflow) => workflow.status === filter);
}

export function progressPercent(completed: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const value = Math.round((Math.max(0, completed) / total) * 100);
  return Math.min(100, Math.max(0, value));
}
