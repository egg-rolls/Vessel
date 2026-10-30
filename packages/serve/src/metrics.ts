/**
 * Metrics 网关边界（0.4 W2，DECISION-009 §5.4.1）。
 *
 * gateway 只读：asm 注入 core `MetricsCollector.snapshot()`（或等价函数）。
 * 类型是冻结契约的结构镜像，不 import core 新模块。
 *
 * @module @vessel-agent/serve/metrics
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
    /** 缓存读取累计；缺省 = 没有任何缓存数据（CONTRACT-0.29 §1.2，不是 0） */
    cache_read_tokens?: number;
    /** 缓存写入累计；缺省语义同 `cache_read_tokens` */
    cache_creation_tokens?: number;
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

/**
 * 可选计数：缺失 / 非法 → `undefined`。
 *
 * 缓存计数**不能**按 0 归一化：`undefined` 表示「该批事件没有缓存数据」
 * （provider 不支持缓存），0 表示「provider 报告命中/写入 0 个 token」。
 * 折叠成 0 会让 Web 面板把「不可用」显示成 0%（CONTRACT-0.29 §1.2 / §2.2）。
 */
function toOptionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** 归一化 provider 返回值：缺字段按 0，非法条目丢弃，绝不抛给调用方。 */
export function normalizeMetricsSnapshot(input: unknown): MetricsSnapshot {
  const root = isRecord(input) ? input : {};
  const runs = isRecord(root.runs) ? root.runs : {};
  const toolCalls = isRecord(root.tool_calls) ? root.tool_calls : {};
  const llm = isRecord(root.llm) ? root.llm : {};
  const duration = isRecord(root.duration_ms) ? root.duration_ms : {};
  const cacheRead = toOptionalCount(llm.cache_read_tokens);
  const cacheCreation = toOptionalCount(llm.cache_creation_tokens);
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
      // 缺省即省略：wire 上不出现 0，调用方能区分「无数据」与「数据为 0」。
      ...(cacheRead !== undefined ? { cache_read_tokens: cacheRead } : {}),
      ...(cacheCreation !== undefined ? { cache_creation_tokens: cacheCreation } : {}),
    },
    duration_ms: {
      total: toNumber(duration.total),
      max: toNumber(duration.max),
      avg: toNumber(duration.avg),
    },
    updated_at: toCount(root.updated_at),
  };
}
