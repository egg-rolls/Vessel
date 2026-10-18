/**
 * Metrics 聚合（0.4 C2）
 *
 * 只订阅既有事件，做进程内聚合；不新增事件、不改 runtime、不持久化。
 * 多 Host / 多进程不合并；一个 collector 绑定一个 EventStream。
 *
 * @module @vessel/core/observability
 */

import type { EventStream, RunEvent, Unsubscribe } from '../types/event.js';

/** 进程内 metrics 快照（DECISION-009 §5.4.1 冻结形状） */
export interface MetricsSnapshot {
  runs: { started: number; completed: number; failed: number; cancelled: number };
  tool_calls: { total: number; failed: number };
  llm: { requests: number; prompt_tokens: number; completion_tokens: number; total_tokens: number };
  duration_ms: { total: number; max: number; avg: number };
  updated_at: number;
}

/** 非负有限数字；其他值按 0 */
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
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
 * 订阅既有事件并聚合 metrics。
 *
 * 消费事件：`run.started` / `run.completed` / `run.failed` / `run.cancelled` /
 * `tool.call.started` / `tool.call.failed` / `llm.response`。
 *
 * 注意：0.4 的取消路径由 `AgentRuntime` 发 `run.failed`，Core 暂无
 * `run.cancelled` 发射方，因此 `runs.cancelled` 当前恒为 0；
 * 被取消的 run 会计入 `runs.failed`。统一 run/host 取消事件留到 0.5。
 */
export class MetricsCollector {
  private unsubscribe?: Unsubscribe;
  private runs = { started: 0, completed: 0, failed: 0, cancelled: 0 };
  private toolCalls = { total: 0, failed: 0 };
  private llm = { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  private duration = { total: 0, max: 0 };
  private updatedAt: number;

  constructor(events: EventStream) {
    this.updatedAt = Date.now();
    this.unsubscribe = events.subscribe((event) => this.handle(event));
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

  /** 清零计数与时长样本；保持订阅 */
  reset(): void {
    this.runs = { started: 0, completed: 0, failed: 0, cancelled: 0 };
    this.toolCalls = { total: 0, failed: 0 };
    this.llm = { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    this.duration = { total: 0, max: 0 };
    this.updatedAt = Date.now();
  }

  /** 退订；不关闭 event stream。幂等。 */
  dispose(): void {
    if (!this.unsubscribe) return;
    this.unsubscribe();
    this.unsubscribe = undefined;
  }

  private handle(event: RunEvent): void {
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
      this.updatedAt = Date.now();
    } catch {
      // Metrics 聚合不得影响事件投递
    }
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
  }
}
