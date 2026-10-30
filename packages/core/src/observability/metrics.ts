/**
 * Metrics 聚合（0.4 C2；0.5 抽出累加器供 trace 重建复用）
 *
 * 只订阅既有事件，做进程内聚合；不新增事件、不改 runtime、不持久化。
 * 多 Host / 多进程不合并；一个 collector 绑定一个 EventStream。
 *
 * `updated_at = max(event.ts)`（无事件为 0），实时与 `rebuildMetrics` 必须一致。
 *
 * @module @vessel-agent/core/observability
 */

import type { EventStream, RunEvent, Unsubscribe } from '../types/event.js';

/** 进程内 metrics 快照（DECISION-009 §5.4.1 冻结形状；0.29 B3 只做 additive） */
export interface MetricsSnapshot {
  runs: { started: number; completed: number; failed: number; cancelled: number };
  tool_calls: { total: number; failed: number };
  llm: {
    requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /**
     * 缓存读取 token 累计（CONTRACT-0.29 §3）。
     *
     * **缺省 = 该批事件里没有任何缓存数据**（不支持缓存的 provider，§1.2）。
     * 不得用 0 表示「不支持」——0 只在 provider 明确报告了 0 时出现。
     * 比率是展示层派生量，不进快照（§2.2）。
     */
    cache_read_tokens?: number;
    /** 缓存写入 token 累计；缺省语义同 `cache_read_tokens` */
    cache_creation_tokens?: number;
  };
  duration_ms: { total: number; max: number; avg: number };
  updated_at: number;
}

/** 非负有限数字；其他值按 0 */
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 可选计数：字段缺失 / 非数字 / 负数 → `undefined`（= 没有数据）。
 *
 * 与 `nonNegative` 的区别是本函数**不把缺失折叠成 0**——缓存计数必须能区分
 * 「provider 不支持缓存」与「命中了 0 个 token」（CONTRACT-0.29 §1.2）。
 */
function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 读取事件 data 对象 */
function readData(event: RunEvent): Record<string, unknown> | undefined {
  const data = event.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

/** 读取嵌套对象字段 */
function readObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 纯累加器：实时 collector 与 trace 重建共用，保证语义一致。
 */
export class MetricsAccumulator {
  private runs = { started: 0, completed: 0, failed: 0, cancelled: 0 };
  private toolCalls = { total: 0, failed: 0 };
  private llm: MetricsSnapshot['llm'] = {
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  private duration = { total: 0, max: 0 };
  private updatedAt = 0;

  /** 消费一个事件；未知类型只推进 updated_at */
  apply(event: RunEvent): void {
    if (typeof event.ts === 'number' && Number.isFinite(event.ts)) {
      this.updatedAt = Math.max(this.updatedAt, event.ts);
    }

    try {
      switch (event.type) {
        case 'run.started':
          this.runs.started += 1;
          break;
        case 'run.completed':
          this.runs.completed += 1;
          this.recordDuration(readData(event)?.duration_ms);
          break;
        case 'run.failed':
          this.runs.failed += 1;
          this.recordDuration(readData(event)?.duration_ms);
          break;
        case 'run.cancelled':
          this.runs.cancelled += 1;
          break;
        case 'tool.call.started':
          this.toolCalls.total += 1;
          break;
        case 'tool.call.failed':
          this.toolCalls.failed += 1;
          break;
        case 'llm.response':
          this.recordLlmResponse(readData(event));
          break;
        default:
          return;
      }
    } catch {
      // Metrics 聚合不得影响事件投递
    }
  }

  /** 当前快照（每次返回新对象） */
  snapshot(): MetricsSnapshot {
    const runCount = this.runs.completed + this.runs.failed;
    return {
      runs: { ...this.runs },
      tool_calls: { ...this.toolCalls },
      llm: { ...this.llm },
      duration_ms: {
        total: this.duration.total,
        max: this.duration.max,
        avg: runCount > 0 ? this.duration.total / runCount : 0,
      },
      updated_at: this.updatedAt,
    };
  }

  /** 清零计数与时长样本 */
  reset(): void {
    this.runs = { started: 0, completed: 0, failed: 0, cancelled: 0 };
    this.toolCalls = { total: 0, failed: 0 };
    this.llm = { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    this.duration = { total: 0, max: 0 };
    this.updatedAt = 0;
  }

  private recordDuration(value: unknown): void {
    const duration = nonNegative(value);
    this.duration.total += duration;
    if (duration > this.duration.max) this.duration.max = duration;
  }

  private recordLlmResponse(data: Record<string, unknown> | undefined): void {
    this.llm.requests += 1;

    const usage = readObject(data?.usage);
    if (!usage) return;

    const prompt = nonNegative(usage.prompt_tokens);
    const completion = nonNegative(usage.completion_tokens);
    const total =
      typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
        ? nonNegative(usage.total_tokens)
        : prompt + completion;

    this.llm.prompt_tokens += prompt;
    this.llm.completion_tokens += completion;
    this.llm.total_tokens += total;

    // 缓存计数（0.29 B3）：只有事件真的带了该字段才累加，全部缺失时保持 undefined。
    const cacheRead = optionalCount(usage.cache_read_input_tokens);
    if (cacheRead !== undefined) {
      this.llm.cache_read_tokens = (this.llm.cache_read_tokens ?? 0) + cacheRead;
    }
    const cacheCreation = optionalCount(usage.cache_creation_input_tokens);
    if (cacheCreation !== undefined) {
      this.llm.cache_creation_tokens = (this.llm.cache_creation_tokens ?? 0) + cacheCreation;
    }
  }
}

/**
 * 订阅既有事件并聚合 metrics。
 *
 * 消费事件：`run.started` / `run.completed` / `run.failed` / `run.cancelled` /
 * `tool.call.started` / `tool.call.failed` / `llm.response`。
 */
export class MetricsCollector {
  private unsubscribe?: Unsubscribe;
  private readonly accumulator = new MetricsAccumulator();

  constructor(events: EventStream) {
    this.unsubscribe = events.subscribe((event) => this.accumulator.apply(event));
  }

  /** 当前快照（每次返回新对象） */
  snapshot(): MetricsSnapshot {
    return this.accumulator.snapshot();
  }

  /** 清零计数与时长样本；保持订阅 */
  reset(): void {
    this.accumulator.reset();
  }

  /** 退订；不关闭 event stream。幂等。 */
  dispose(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = undefined;
  }
}
