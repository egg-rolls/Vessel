/**
 * Metrics 网关边界（0.4 W2，DECISION-009 §5.4.1）。
 *
 * gateway 只读：asm 注入 core `MetricsCollector.snapshot()`（或等价函数）。
 * 类型是冻结契约的结构镜像，不 import core 新模块。
 *
 * @module @vessel/serve/metrics
 */

/** 进程内聚合快照（与 core `MetricsSnapshot` 字段一致） */
export interface MetricsSnapshot {
  runs: { started: number; completed: number; failed: number; cancelled: number };
  tool_calls: { total: number; failed: number };
  llm: {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  duration_ms: { total: number; max: number; avg: number };
  updated_at: number;
}

/** gateway 注入面；缺省 = metrics 端点关闭 */
export type MetricsProvider = () => MetricsSnapshot;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 归一化 provider 返回值：缺字段按 0，非法条目丢弃，绝不抛给调用方。 */
export function normalizeMetricsSnapshot(input: unknown): MetricsSnapshot {
  const root = isRecord(input) ? input : {};
  const runs = isRecord(root.runs) ? root.runs : {};
  const toolCalls = isRecord(root.tool_calls) ? root.tool_calls : {};
  const llm = isRecord(root.llm) ? root.llm : {};
  const duration = isRecord(root.duration_ms) ? root.duration_ms : {};
  return {
    runs: {
      started: toCount(runs.started),
      completed: toCount(runs.completed),
      failed: toCount(runs.failed),
      cancelled: toCount(runs.cancelled),
    },
    tool_calls: {
      total: toCount(toolCalls.total),
      failed: toCount(toolCalls.failed),
    },
    llm: {
      requests: toCount(llm.requests),
      prompt_tokens: toCount(llm.prompt_tokens),
      completion_tokens: toCount(llm.completion_tokens),
      total_tokens: toCount(llm.total_tokens),
    },
    duration_ms: {
      total: toNumber(duration.total),
      max: toNumber(duration.max),
      avg: toNumber(duration.avg),
    },
    updated_at: toCount(root.updated_at),
  };
}
