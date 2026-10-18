/**
 * Workflow 控制面网关边界（0.4 W2，DECISION-009 §5.1.4 / §10.3）。
 *
 * gateway 只读：asm 把 ext 的 `WorkflowControls` 适配成这里的结构面。
 * 类型是冻结契约的结构镜像，不 import ext 实现；返回值做白名单归一化，
 * 只暴露冻结字段，避免内部字段或任意路径透传。
 *
 * @module @vessel/serve/workflow
 */

/** workflow run 状态（与 DECISION-009 §5.1.3 一致） */
export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** workflow step 状态 */
export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export const WORKFLOW_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export const WORKFLOW_STEP_STATUSES: readonly WorkflowStepStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
];

/** 默认/最大 limit（与 durable / CLI 一致） */
export const DEFAULT_WORKFLOW_LIMIT = 50;
export const MAX_WORKFLOW_LIMIT = 200;

/** `output_preview` 最大长度（冻结契约 §5.1.4） */
export const MAX_OUTPUT_PREVIEW = 200;

/** `GET /v1/workflows` 的单条摘要 */
export interface WorkflowRunSummary {
  workflow_run_id: string;
  workflow_name: string;
  status: WorkflowRunStatus;
  step_count: number;
  completed_steps: number;
  started_at: number;
  updated_at: number;
  error?: string;
}

/** workflow step 摘要 */
export interface WorkflowStepSummary {
  id: string;
  type: 'agent' | 'tool';
  status: WorkflowStepStatus;
  attempts: number;
  started_at?: number;
  finished_at?: number;
  error?: string;
  output_preview?: string;
}

/** `GET /v1/workflows/<id>` 的详情 */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  definition_path: string;
  inputs: Record<string, string>;
  steps: WorkflowStepSummary[];
}

/** ext 的 WorkflowOutcome 结构镜像 */
export interface WorkflowOutcome {
  workflow_run_id: string;
  status: WorkflowRunStatus;
  error?: string;
}

/** gateway 消费的控制面；字段是 DECISION-009 §5.1.4 / §10.1.2 的结构子集 */
export interface WorkflowControlsLike {
  listRuns(opts?: { status?: WorkflowRunStatus; limit?: number }): Promise<WorkflowRunSummary[]>;
  getRun(workflowRunId: string): Promise<WorkflowRunDetail | null>;
  /** done 恰好 resolve 一次、不 reject；gateway 不等待它 */
  start(
    definitionPath: string,
    opts?: { inputs?: Record<string, string> },
  ): Promise<{ workflowRunId: string; done: Promise<WorkflowOutcome> }>;
  resume(workflowRunId: string): Promise<{ workflowRunId: string; done: Promise<WorkflowOutcome> }>;
  cancel(workflowRunId: string): Promise<void>;
}

/** gateway 注入面；缺省 = workflow 端点关闭 */
export interface WorkflowGatewayOptions extends WorkflowControlsLike {
  /**
   * 在 config.workflow.dir 下解析 name（与 CLI 同规则：
   * name.yaml / name.yml / name.json；不得接受路径分隔符）。
   * 返回 undefined = 未找到。gateway 已先做单段名校验，且不自行拼路径。
   */
  resolveDefinition(name: string): string | undefined;
}

/** 解析 status 查询参数：null = 未提供（全部）；非法返回 null */
export function parseWorkflowStatus(raw: string | null): WorkflowRunStatus | null {
  if (raw === null) return null;
  return WORKFLOW_RUN_STATUSES.includes(raw as WorkflowRunStatus)
    ? (raw as WorkflowRunStatus)
    : null;
}

/** 解析 limit：缺省 50；必须是 1..200 的整数 */
export function parseWorkflowLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_WORKFLOW_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKFLOW_LIMIT) return null;
  return value;
}

// 与 asm resolver / 冻结契约一致：1..64 个 [A-Za-z0-9_-]，不允许点、路径分隔符。
const SAFE_WORKFLOW_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * gateway 只接受单段安全名：仅字母、数字、下划线、连字符，长度 1..64。
 * 真正的目录解析由 asm 注入的 resolveDefinition 完成。
 */
export function isSafeWorkflowName(raw: string): boolean {
  return SAFE_WORKFLOW_NAME.test(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizePreview(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > MAX_OUTPUT_PREVIEW ? value.slice(0, MAX_OUTPUT_PREVIEW) : value;
}

/** checkpoint/summary → 线上摘要（只暴露冻结字段） */
export function toWireWorkflowSummary(input: unknown): WorkflowRunSummary | null {
  if (!isRecord(input)) return null;
  const id = input.workflow_run_id;
  const name = input.workflow_name;
  const status = input.status;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof status !== 'string' || !WORKFLOW_RUN_STATUSES.includes(status as WorkflowRunStatus)) {
    return null;
  }
  const error = optionalString(input.error);
  return {
    workflow_run_id: id,
    workflow_name: name,
    status: status as WorkflowRunStatus,
    step_count: toCount(input.step_count),
    completed_steps: toCount(input.completed_steps),
    started_at: toNumber(input.started_at),
    updated_at: toNumber(input.updated_at),
    ...(error !== undefined ? { error } : {}),
  };
}

function toWireStep(input: unknown): WorkflowStepSummary | null {
  if (!isRecord(input)) return null;
  const id = input.id;
  const type = input.type;
  const status = input.status;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (type !== 'agent' && type !== 'tool') return null;
  if (
    typeof status !== 'string' ||
    !WORKFLOW_STEP_STATUSES.includes(status as WorkflowStepStatus)
  ) {
    return null;
  }
  const startedAt = toNumber(input.started_at);
  const finishedAt = toNumber(input.finished_at);
  const error = optionalString(input.error);
  const outputPreview = normalizePreview(input.output_preview);
  return {
    id,
    type,
    status: status as WorkflowStepStatus,
    attempts: toCount(input.attempts),
    ...(startedAt > 0 ? { started_at: startedAt } : {}),
    ...(finishedAt > 0 ? { finished_at: finishedAt } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(outputPreview !== undefined ? { output_preview: outputPreview } : {}),
  };
}

/** detail → 线上详情（只暴露冻结字段） */
export function toWireWorkflowDetail(input: unknown): WorkflowRunDetail | null {
  const summary = toWireWorkflowSummary(input);
  if (!summary || !isRecord(input)) return null;
  const definitionPath = input.definition_path;
  if (typeof definitionPath !== 'string') return null;
  const inputs: Record<string, string> = {};
  if (isRecord(input.inputs)) {
    for (const [key, value] of Object.entries(input.inputs)) {
      if (typeof value === 'string') inputs[key] = value;
    }
  }
  const steps = Array.isArray(input.steps)
    ? input.steps
        .map((step) => toWireStep(step))
        .filter((step): step is WorkflowStepSummary => step !== null)
    : [];
  return {
    ...summary,
    definition_path: definitionPath,
    inputs,
    steps,
  };
}

/** 按 workflow_run_id 去重（保留先出现的一条） */
export function dedupeWorkflowSummaries(summaries: WorkflowRunSummary[]): WorkflowRunSummary[] {
  const seen = new Set<string>();
  const result: WorkflowRunSummary[] = [];
  for (const summary of summaries) {
    if (seen.has(summary.workflow_run_id)) continue;
    seen.add(summary.workflow_run_id);
    result.push(summary);
  }
  return result;
}

/** updated_at 倒序、同值 workflow_run_id 升序（DECISION-009 §5.1.3） */
export function sortWorkflowSummaries(summaries: WorkflowRunSummary[]): WorkflowRunSummary[] {
  return [...summaries].sort((left, right) => {
    if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at;
    return left.workflow_run_id < right.workflow_run_id
      ? -1
      : left.workflow_run_id > right.workflow_run_id
        ? 1
        : 0;
  });
}
