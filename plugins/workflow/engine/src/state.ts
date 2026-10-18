/**
 * 状态判定与摘要构造。
 */

import type {
  WorkflowRunDetail,
  WorkflowRunFile,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowStepState,
  WorkflowStepStatus,
  WorkflowStepSummary,
} from './types.js';

const TERMINAL_RUN: ReadonlySet<WorkflowRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

const TERMINAL_STEP: ReadonlySet<WorkflowStepStatus> = new Set([
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN.has(status);
}

export function isTerminalStepStatus(status: WorkflowStepStatus): boolean {
  return TERMINAL_STEP.has(status);
}

/** 输出预览最多 200 字符。 */
export function outputPreview(output: string, max = 200): string {
  return output.length <= max ? output : output.slice(0, max);
}

export function stepSummary(step: WorkflowStepState): WorkflowStepSummary {
  const summary: WorkflowStepSummary = {
    id: step.id,
    type: step.type,
    status: step.status,
    attempts: step.attempts,
  };
  if (step.started_at !== undefined) summary.started_at = step.started_at;
  if (step.finished_at !== undefined) summary.finished_at = step.finished_at;
  if (step.error !== undefined) summary.error = step.error;
  if (step.output_preview !== undefined) summary.output_preview = step.output_preview;
  return summary;
}

export function runSummary(file: WorkflowRunFile): WorkflowRunSummary {
  const summary: WorkflowRunSummary = {
    workflow_run_id: file.workflow_run_id,
    workflow_name: file.workflow_name,
    status: file.status,
    step_count: file.steps.length,
    completed_steps: file.steps.filter((step) => step.status === 'completed').length,
    started_at: file.started_at,
    updated_at: file.updated_at,
  };
  if (file.error !== undefined) summary.error = file.error;
  if (file.tenant_id !== undefined) summary.tenant_id = file.tenant_id;
  return summary;
}

export function runDetail(file: WorkflowRunFile): WorkflowRunDetail {
  return {
    ...runSummary(file),
    definition_path: file.definition_path,
    inputs: { ...file.inputs },
    steps: file.steps.map(stepSummary),
  };
}
