/**
 * Durable run 网关边界（0.3 W1，DECISION-008 §4.4 + Addendum A）。
 *
 * gateway 只是 **只读消费者**：数据来自 asm 注入的 `RunStore` / resume 适配器。
 * 这里用结构类型镜像 core 的 `RunCheckpoint` / `RunStore`（字段与 §4.1 一致），
 * 不依赖 core 新模块是否已经导出；asm 可以直接把 core 实例传进来。
 *
 * @module @vessel-agent/serve/durable
 */

/** run 状态（与 core `RunCheckpoint['status']` 一致） */
export type DurableRunStatus = 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

/** 允许的 run 状态集合 */
export const DURABLE_RUN_STATUSES: readonly DurableRunStatus[] = [
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
];

/** 默认/最大 limit（Addendum A §4） */
export const DEFAULT_DURABLE_LIMIT = 50;
export const MAX_DURABLE_LIMIT = 200;

/** checkpoint 的最小结构面（gateway 只读这些字段） */
export interface DurableCheckpointLike {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: DurableRunStatus;
  /** 0.18 起 core 只写 `[]`；新 checkpoint 的预览在 `metadata.preview`。 */
  messages?: Array<{ role?: string; content?: string }>;
  /** 0.18：checkpoint 附加数据；`preview` 为 session 上下文派生的预览。 */
  metadata?: Record<string, unknown>;
  iteration?: number;
  updated_at: number;
  /** 0.5：所属 tenant；缺省视为 default */
  tenant_id?: string;
}

/** store 的最小结构面（core RunStore 结构满足） */
export interface DurableStoreLike {
  load(runId: string): Promise<DurableCheckpointLike | null>;
  list(opts?: {
    status?: DurableRunStatus;
    session_id?: string;
    limit?: number;
  }): Promise<DurableCheckpointLike[]>;
}

/** gateway durable 注入面；缺省 = 端点关闭 */
export interface DurableGatewayOptions {
  store: DurableStoreLike;
  /**
   * 启动一次恢复。返回/解析表示「已受理」，**不得等待 run 完成**；
   * 缺省表示当前模式只支持列表。
   */
  resume?: (runId: string) => void | Promise<void>;
}

/** GET /v1/durable/runs 的单条摘要（冻结字段） */
export interface DurableRunSummary {
  run_id: string;
  session_id: string;
  agent_id?: string;
  status: DurableRunStatus;
  iteration?: number;
  updated_at: number;
  preview?: string;
}

/** 解析 `status` 查询参数：null/空 = 全部；非法返回 null */
export function parseStatusFilter(raw: string | null): DurableRunStatus[] | null {
  if (raw === null) return [];
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length === 0) return null;
  const result: DurableRunStatus[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    if (!DURABLE_RUN_STATUSES.includes(part as DurableRunStatus)) return null;
    const status = part as DurableRunStatus;
    if (!result.includes(status)) result.push(status);
  }
  return result;
}

/** 解析 `limit`：缺省 50；必须是 1..200 的整数 */
export function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_DURABLE_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DURABLE_LIMIT) return null;
  return value;
}

/** preview 的最大长度（线上冻结语义） */
const PREVIEW_MAX_LENGTH = 120;

function truncatePreview(value: string): string {
  return value.length > PREVIEW_MAX_LENGTH ? value.slice(0, PREVIEW_MAX_LENGTH) : value;
}

/**
 * 取预览：0.18 起优先 `metadata.preview`（core 只写这个，messages 可能为 `[]`）；
 * 缺失 / 非字符串 / 空串时回退到 legacy 的 messages 逻辑。
 */
export function previewOf(checkpoint: DurableCheckpointLike): string | undefined {
  const metadata = checkpoint.metadata;
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
    const fromMetadata = metadata.preview;
    if (typeof fromMetadata === 'string' && fromMetadata.trim() !== '') {
      return truncatePreview(fromMetadata);
    }
  }

  const messages = checkpoint.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const content = messages[index]?.content;
    if (typeof content === 'string' && content.length > 0) {
      return truncatePreview(content);
    }
  }
  return undefined;
}

/** checkpoint → 线上摘要（只暴露冻结字段） */
export function toRunSummary(checkpoint: DurableCheckpointLike): DurableRunSummary {
  const preview = previewOf(checkpoint);
  return {
    run_id: checkpoint.run_id,
    session_id: checkpoint.session_id,
    ...(checkpoint.agent_id !== undefined ? { agent_id: checkpoint.agent_id } : {}),
    status: checkpoint.status,
    ...(typeof checkpoint.iteration === 'number' ? { iteration: checkpoint.iteration } : {}),
    updated_at: checkpoint.updated_at,
    ...(preview !== undefined ? { preview } : {}),
  };
}

/** 按 run_id 去重（保留先出现的一条） */
export function dedupeCheckpoints(checkpoints: DurableCheckpointLike[]): DurableCheckpointLike[] {
  const seen = new Set<string>();
  const result: DurableCheckpointLike[] = [];
  for (const checkpoint of checkpoints) {
    if (seen.has(checkpoint.run_id)) continue;
    seen.add(checkpoint.run_id);
    result.push(checkpoint);
  }
  return result;
}

/** Addendum A §4：updated_at 倒序，同值 run_id 升序 */
export function sortCheckpoints(checkpoints: DurableCheckpointLike[]): DurableCheckpointLike[] {
  return [...checkpoints].sort((left, right) => {
    if (right.updated_at !== left.updated_at) return right.updated_at - left.updated_at;
    return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
  });
}

/** resume 只接受 running / interrupted */
export function isResumableStatus(status: DurableRunStatus): boolean {
  return status === 'running' || status === 'interrupted';
}
