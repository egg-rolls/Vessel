/**
 * 运行详情的事件纯函数：分类过滤、tool call 折叠、live/trace 合并与分页。
 *
 * 无 React 依赖，可直接单测。事件类型是开放字符串，未知类型归入「其它」。
 */
import type { RunEvent } from '../gateway/types';
import { INTERNAL_EVENT_TYPES } from './events';

export type RunEventFilter = 'all' | 'llm' | 'tools' | 'errors' | 'internal' | 'other';

export const RUN_EVENT_FILTERS: readonly { id: RunEventFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'llm', label: 'LLM' },
  { id: 'tools', label: '工具' },
  { id: 'errors', label: '错误' },
  { id: 'internal', label: '内部' },
  { id: 'other', label: '其它' },
];

/** 默认隐藏的内部事件（含子 agent 的执行细节）。 */
export function isInternalEvent(type: string): boolean {
  return INTERNAL_EVENT_TYPES.has(type) || type.startsWith('subagent.');
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

export interface RunEventFilterOptions {
  filter?: RunEventFilter;
  /** 显示内部事件（context.changed / llm.request / subagent.* 等）。 */
  showInternal?: boolean;
  /** 类型前缀（大小写不敏感）；空串表示不过滤。 */
  typePrefix?: string;
}

/**
 * 先按「内部事件是否显示」过滤，再按类别与类型前缀过滤。
 * 选择「内部」类别时不受开关影响，避免出现空列表却无解释。
 */
export function filterRunEvents(
  events: readonly RunEvent[],
  { filter = 'all', showInternal = false, typePrefix = '' }: RunEventFilterOptions = {},
): RunEvent[] {
  const prefix = typePrefix.trim().toLowerCase();
  return events.filter((event) => {
    if (!showInternal && filter !== 'internal' && isInternalEvent(event.type)) return false;
    if (prefix && !event.type.toLowerCase().startsWith(prefix)) return false;
    if (filter === 'all') return true;
    if (filter === 'internal') return isInternalEvent(event.type);
    // 错误过滤器与工具过滤器有意重叠：tool.call.failed 两边都能查到。
    if (filter === 'errors') return isErrorEvent(event.type);
    if (filter === 'tools') return event.type.startsWith('tool.');
    if (filter === 'llm') return event.type.startsWith('llm.');
    // other：不属于上面任何一类（内部事件已在前面处理）。
    return (
      !isInternalEvent(event.type) &&
      !event.type.startsWith('tool.') &&
      !event.type.startsWith('llm.') &&
      !isErrorEvent(event.type)
    );
  });
}

export interface ToolCallGroup {
  kind: 'tool';
  key: string;
  toolCallId?: string;
  name: string;
  status: 'started' | 'completed' | 'failed';
  started?: RunEvent;
  ended?: RunEvent;
  arguments?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export type RunTimelineItem = { kind: 'event'; key: string; event: RunEvent } | ToolCallGroup;

interface ToolEventData {
  tool_call_id?: unknown;
  tool_name?: unknown;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  duration_ms?: unknown;
}

/**
 * 把 `tool.call.started` 与后续 completed/failed 合成一行。
 * 仅按 `tool_call_id` 配对；缺少 id 或缺少 started 的事件保持独立，
 * 不猜测配对关系（trace 可能从中间开始）。
 */
export function groupRunEvents(events: readonly RunEvent[]): RunTimelineItem[] {
  const items: RunTimelineItem[] = [];
  const byCallId = new Map<string, ToolCallGroup>();

  for (const event of events) {
    if (event.type.startsWith('tool.call.')) {
      const data = event.data as ToolEventData;
      const callId = typeof data.tool_call_id === 'string' ? data.tool_call_id : undefined;
      const name = typeof data.tool_name === 'string' ? data.tool_name : 'tool';
      const isStart = event.type === 'tool.call.started';
      const existing = callId ? byCallId.get(callId) : undefined;

      if (isStart) {
        const group: ToolCallGroup = {
          kind: 'tool',
          key: `tool-${items.length}`,
          name,
          status: 'started',
          started: event,
          ...(callId ? { toolCallId: callId } : {}),
          ...(data.arguments !== undefined ? { arguments: data.arguments } : {}),
        };
        items.push(group);
        if (callId) byCallId.set(callId, group);
        continue;
      }

      let group = existing;
      if (!group) {
        group = {
          kind: 'tool',
          key: `tool-${items.length}`,
          name,
          status: event.type === 'tool.call.completed' ? 'completed' : 'failed',
          ...(callId ? { toolCallId: callId } : {}),
        };
        items.push(group);
        if (callId) byCallId.set(callId, group);
      }
      group.ended = event;
      group.status = event.type === 'tool.call.completed' ? 'completed' : 'failed';
      if (data.result !== undefined) group.result = data.result;
      if (typeof data.error === 'string') group.error = data.error;
      if (typeof data.duration_ms === 'number') group.durationMs = data.duration_ms;
      continue;
    }

    items.push({ kind: 'event', key: `event-${items.length}`, event });
  }

  return items;
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
 * 选择事件记录（trace）使用的 run id。
 *
 * gateway 的 `runs.list` / `runs.get` 返回引擎 run id，而 trace 文件按 core run id
 * 命名（`run.started.event.run_id`）。live 详情必须用 `core_run_id`，否则永远读不到事件；
 * durable 的 checkpoint id 本身就是 core run id。
 */
export function traceRunId(
  tab: 'live' | 'durable',
  run: TraceRunLike | null | undefined,
  fallbackId: string,
  durableId?: string,
): string | undefined {
  if (tab === 'durable') return run?.run_id ?? durableId ?? fallbackId;
  return run?.core_run_id;
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
