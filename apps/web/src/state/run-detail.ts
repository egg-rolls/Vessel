/**
 * 运行详情的事件纯函数：类别划分、live/trace 合并与分页游标。
 *
 * 无 React 依赖，可直接单测。事件类型是开放字符串，未知类型归入「其它」。
 * 日志行索引 / 过滤 / 分页窗口在 domains/runs/run-event-log.ts。
 */
import type { RunEvent } from '../gateway/types';
import { tierOf } from './event-visibility';

export type RunEventFilter = 'all' | 'llm' | 'tools' | 'errors' | 'internal' | 'other';

export const RUN_EVENT_FILTERS: readonly { id: RunEventFilter; labelKey: string }[] = [
  { id: 'all', labelKey: 'runs.detail.filter.all' },
  { id: 'llm', labelKey: 'runs.detail.filter.llm' },
  { id: 'tools', labelKey: 'runs.detail.filter.tools' },
  { id: 'errors', labelKey: 'runs.detail.filter.errors' },
  { id: 'internal', labelKey: 'runs.detail.filter.internal' },
  { id: 'other', labelKey: 'runs.detail.filter.other' },
];

/**
 * 默认隐藏的内部事件：从 `event-visibility.ts` 的三档表派生（`tier === 'internal'`，
 * 含 `subagent.` 家族）。**不要**在这里另写集合：Runs 页的筛选桶与聊天窗的可见性
 * 必须同源，否则「Runs 里算内部、聊天里算内容」的漂移会再出现。
 */
export function isInternalEvent(type: string): boolean {
  return tierOf(type) === 'internal';
}

/** 失败/错误事件（包含 tool.call.failed 与 guardrail.blocked）。 */
export function isErrorEvent(type: string): boolean {
  return type === 'error' || type === 'guardrail.blocked' || type.endsWith('.failed');
}

export function eventCategory(
  type: string,
): Exclude<RunEventFilter, 'all' | 'internal'> | 'internal' {
  if (isInternalEvent(type)) return 'internal';
  if (type.startsWith('llm.')) return 'llm';
  if (type.startsWith('tool.')) return 'tools';
  if (isErrorEvent(type)) return 'errors';
  return 'other';
}

function eventKey(event: RunEvent): string {
  return `${event.type}@${event.ts}`;
}

/**
 * 合并 trace 回放与内存实时事件：trace 在前，live 只追加未出现的事件。
 * 有 seq 的事件优先按 seq 去重（实时事件通常没有 seq，再退化为 type+ts）。
 */
export function mergeRunEvents(trace: readonly RunEvent[], live: readonly RunEvent[]): RunEvent[] {
  const seenKeys = new Set(trace.map(eventKey));
  const seenSeq = new Set(
    trace
      .map((event) => event.seq)
      .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq)),
  );
  const merged = [...trace];
  for (const event of live) {
    if (typeof event.seq === 'number' && seenSeq.has(event.seq)) continue;
    if (seenKeys.has(eventKey(event))) continue;
    seenKeys.add(eventKey(event));
    if (typeof event.seq === 'number') seenSeq.add(event.seq);
    merged.push(event);
  }
  return merged;
}

/** 下一页 `since_seq`：最后一条带 seq 的事件；没有 seq 时无法分页。 */
export function nextSinceSeq(events: readonly RunEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const seq = events[index]?.seq;
    if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
  }
  return undefined;
}

export interface TraceRunLike {
  run_id: string;
  core_run_id?: string;
}

/**
 * 选择事件记录（trace）使用的 run id：`core_run_id ?? run_id`。
 *
 * 0.27 后 `core_run_id` 不再返回（`job_id ≡ run_id`），live 直接退化到 `run_id`；
 * 旧 gateway 仍优先 `core_run_id`。run 尚未进入 live 列表（如排队中）时返回
 * undefined，由调用方渲染「尚未映射」的排队文案。
 * durable 的 checkpoint id 本身就是 run id。
 */
export function traceRunId(
  tab: 'live' | 'durable',
  run: TraceRunLike | null | undefined,
  fallbackId: string,
  durableId?: string,
): string | undefined {
  if (tab === 'durable') return run?.run_id ?? durableId ?? fallbackId;
  if (!run) return undefined;
  return run.core_run_id ?? run.run_id;
}

export interface TraceErrorLike {
  code?: string;
  message: string;
}

/** trace 未启用/无记录：展示解释态而不是可重试错误。 */
export function isTraceUnavailable(error: TraceErrorLike): boolean {
  const message = error.message.toLowerCase();
  return (
    error.code === 'not_found' ||
    error.code === 'method_not_allowed' ||
    message.includes('trace reader is not available') ||
    message.includes('method_not_allowed') ||
    message.includes('not_found') ||
    message.includes('not available')
  );
}
