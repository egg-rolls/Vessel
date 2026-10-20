import type { RunEvent } from '../../gateway/types';
import { type ErrorMeta, errorMetaOf } from '../../state/error-visibility';
import type { TimelineItem } from '../../state/events';

export type ToolCardStatus = 'running' | 'done' | 'error';

export interface ToolCardView {
  kind: 'tool';
  key: string;
  callId?: string;
  name: string;
  status: ToolCardStatus;
  args?: unknown;
  result?: unknown;
  error?: string;
  /** 0.14 additive：tool.call.failed 的结构化错误元数据。 */
  errorMeta?: ErrorMeta;
  durationMs?: number;
  truncated?: boolean;
  startedAt: number;
}

export type ChatRenderItem =
  | { kind: 'text'; text: string; key: string }
  | { kind: 'reasoning'; text: string; key: string }
  | { kind: 'event'; event: RunEvent; key: string }
  | ToolCardView;

interface PendingStart {
  card: ToolCardView;
  callId?: string;
}

function callIdOf(data: Record<string, unknown>): string | undefined {
  const id = data.tool_call_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function toolNameOf(data: Record<string, unknown>): string | undefined {
  const name = data.tool_name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function durationOf(data: Record<string, unknown>): number | undefined {
  const value = data.duration_ms;
  return typeof value === 'number' ? value : undefined;
}

function errorOf(data: Record<string, unknown>): string | undefined {
  const value = data.error;
  if (typeof value === 'string') return value;
  if (value === undefined) return undefined;
  return String(value);
}

function takePending(
  pending: PendingStart[],
  callId: string | undefined,
  name: string | undefined,
): PendingStart | undefined {
  if (callId !== undefined) {
    const exact = pending.findIndex((entry) => entry.callId === callId);
    if (exact >= 0) return pending.splice(exact, 1)[0];
  }
  if (name === undefined) return undefined;
  // Distinct call ids must never be merged through the name fallback.
  const fallback = pending.findIndex(
    (entry) => entry.card.name === name && (callId === undefined || entry.callId === undefined),
  );
  return fallback >= 0 ? pending.splice(fallback, 1)[0] : undefined;
}

export function foldToolItems(items: readonly TimelineItem[]): ChatRenderItem[] {
  const output: ChatRenderItem[] = [];
  const pending: PendingStart[] = [];

  for (const item of items) {
    if (item.kind !== 'event') {
      output.push(item);
      continue;
    }

    const { event } = item;
    if (event.type === 'tool.call.started') {
      const callId = callIdOf(event.data);
      const card: ToolCardView = {
        kind: 'tool',
        key: item.key,
        callId,
        name: toolNameOf(event.data) ?? 'tool',
        status: 'running',
        args: event.data.arguments,
        truncated: event.data.truncated === true ? true : undefined,
        startedAt: event.ts,
      };
      output.push(card);
      pending.push({ card, callId });
      continue;
    }

    if (event.type === 'tool.call.completed' || event.type === 'tool.call.failed') {
      const completed = event.type === 'tool.call.completed';
      const callId = callIdOf(event.data);
      const name = toolNameOf(event.data);
      const durationMs = durationOf(event.data);
      const started = takePending(pending, callId, name);

      if (started) {
        started.card.status = completed ? 'done' : 'error';
        if (started.card.callId === undefined && callId !== undefined) {
          started.card.callId = callId;
        }
        if (completed) started.card.result = event.data.result;
        else {
          started.card.error = errorOf(event.data);
          started.card.errorMeta = errorMetaOf(event.data);
        }
        if (durationMs !== undefined) started.card.durationMs = durationMs;
        if (event.data.truncated === true) started.card.truncated = true;
        continue;
      }

      output.push({
        kind: 'tool',
        key: `tool-${item.key}`,
        callId,
        name: name ?? 'tool',
        status: completed ? 'done' : 'error',
        result: completed ? event.data.result : undefined,
        error: completed ? undefined : errorOf(event.data),
        errorMeta: completed ? undefined : errorMetaOf(event.data),
        durationMs,
        truncated: event.data.truncated === true ? true : undefined,
        startedAt: event.ts,
      });
      continue;
    }

    output.push(item);
  }

  return output;
}
