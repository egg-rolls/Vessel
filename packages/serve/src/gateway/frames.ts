/**
 * Gateway WS/SSE 帧构造 — 纯函数，所有输入显式传入。
 *
 * @module @vessel-agent/serve/gateway/frames
 */

import type { RunEvent } from '@vessel-agent/core';
import type { EventGap } from '../event-buffer.js';
import {
  type NodeInfo,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolInfo,
  protocolError,
  type ServerFrame,
} from '../protocol.js';
import type {
  TimelineEpochEndSegment,
  TimelineHelloSegment,
  TimelineReadFrom,
} from './timeline-protocol.js';

/** camelCase key → snake_case */
function toSnakeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** 浅层递归映射对象/数组的 key（仅用于 agent.* / team.* 事件） */
function toSnakeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[toSnakeKey(key)] = toSnakeValue(item);
    }
    return out;
  }
  return value;
}

/** gateway 事件边界：agent.* / team.* 的 data 映射为 snake_case；其它事件原样 */
function toWireEvent(event: RunEvent): RunEvent {
  if (!event.type.startsWith('agent.') && !event.type.startsWith('team.')) return event;
  return {
    ...event,
    data: toSnakeValue(event.data) as RunEvent['data'],
  };
}

/** 事件来源节点：跨节点事件带 `node_id` 时优先，否则回落到本 gateway nodeId。 */
export function eventSourceNodeId(event: RunEvent, fallbackNodeId: string): string {
  const raw = (event as RunEvent & { node_id?: unknown }).node_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : fallbackNodeId;
}

export interface EventFrameInput {
  nodeId: string;
  seq: number;
  event: RunEvent;
  /** 网关级运行 id（run.started 之后可知） */
  jobId?: string;
  ts?: number;
}

export function eventFrame(input: EventFrameInput): ServerFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'event',
    node_id: eventSourceNodeId(input.event, input.nodeId),
    ts: input.ts ?? Date.now(),
    seq: input.seq,
    ...(input.jobId ? { job_id: input.jobId } : {}),
    // A7：agent.* / team.* 的 data 在 gateway 边界映射为 snake_case
    event: toWireEvent(input.event),
  };
}

export interface HelloFrameInput {
  nodeId: string;
  protocol: ProtocolInfo;
  node: NodeInfo;
  /** 0.9：本进程事务代际 */
  incarnation: string;
  /**
   * 本次 epoch 实际会发送的第一条 seq（调用方已解析）：
   * 有回放窗口时为窗口首条；已追平为 `latestSeq + 1`；空缓冲为 `0`。
   */
  fromSeq: number;
  latestSeq: number;
  ts?: number;
  /**
   * 0.54 B1：本次 epoch 的读源。缺省 `'legacy'`（老装配没这个概念时保持老形状）。
   *
   * `timeline_source` **总是**出现在线上帧里（老客户端忽略未知键即可），
   * 这样新客户端有一个确定的地方判断「该不该做四条 count 校验」，
   * 不用靠「`count` 字段在不在」猜。
   */
  source?: TimelineReadFrom;
  /**
   * 0.54 B1：时间线段（只有 `source === 'timeline'` 时才给）。
   *
   * 给了就与 `from_seq` / `latest_seq` **并存**（不改它们的老口径）：
   * 老客户端照样按 `from_seq` 起、`latest_seq` 判断追平；新客户端读这一段做校验。
   */
  timeline?: TimelineHelloSegment;
}

export function helloFrame(input: HelloFrameInput): ServerFrame {
  const timeline = input.source === 'timeline' ? input.timeline : undefined;
  return {
    v: PROTOCOL_VERSION,
    kind: 'hello',
    node_id: input.nodeId,
    ts: input.ts ?? Date.now(),
    protocol: input.protocol,
    node: input.node,
    incarnation: input.incarnation,
    from_seq: input.fromSeq,
    latest_seq: input.latestSeq,
    timeline_source: input.source ?? 'legacy',
    ...(timeline !== undefined
      ? {
          start_seq: timeline.start_seq,
          end_seq: timeline.end_seq,
          count: timeline.count,
          timeline_head: timeline.timeline_head,
          wal_head: timeline.wal_head,
          published_head: timeline.published_head,
          holes: timeline.holes,
          tainted: timeline.tainted,
          ...(timeline.reset !== undefined ? { reset: timeline.reset } : {}),
        }
      : {}),
  };
}

export interface TimelineEpochEndFrameInput {
  nodeId: string;
  /** 本 epoch 的会话（时间线订阅必须有 `session_id`；缺省时不出现在线上）。 */
  sessionId?: string;
  end: TimelineEpochEndSegment;
  ts?: number;
}

/**
 * 时间线 epoch 的显式结束帧（0.55，additive 新 kind）。
 *
 * 调用方**只能**在时间线 epoch 整趟发完之后用它（见 `gateway.ts#sendTimelineEpoch`）；
 * 老 epoch 没有「这一趟区间」的声明，不该有结束标记。字段口径与「为什么不是猜测」
 * 写在 `timeline-protocol.ts#timelineEpochEnd` / `TimelineEpochEndSegment` 上。
 *
 * 老客户端收不到它也无所谓：未知 `kind` 走客户端分发的 `default:` 静默忽略，
 * 既有帧（`hello` / `event`）的形状与语义**一个字没改**。
 */
export function timelineEpochEndFrame(input: TimelineEpochEndFrameInput): ServerFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'timeline-epoch-end',
    node_id: input.nodeId,
    ts: input.ts ?? Date.now(),
    ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
    end_seq: input.end.end_seq,
    count: input.end.count,
    has_more: input.end.has_more,
  };
}

export interface ResultFrameInput {
  nodeId: string;
  id: string;
  result: unknown;
  ts?: number;
}

export function resultFrame(input: ResultFrameInput): ServerFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'res',
    node_id: input.nodeId,
    ts: input.ts ?? Date.now(),
    id: input.id,
    ok: true,
    result: input.result,
  };
}

export interface ErrorFrameInput {
  nodeId: string;
  id: string;
  error?: ProtocolError;
  ts?: number;
}

export function errorFrame(input: ErrorFrameInput): ServerFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'res',
    node_id: input.nodeId,
    ts: input.ts ?? Date.now(),
    id: input.id,
    ok: false,
    error: input.error ?? protocolError('internal', 'Unknown error'),
  };
}

export interface GapFrameInput {
  nodeId: string;
  gap: EventGap;
  ts?: number;
}

/**
 * 缺口帧（**过渡期字段，B2 落地即删**）。
 *
 * 调用方**只能**在 `timeline_source === 'legacy'` 的老 epoch 上用它；时间线 epoch 的
 * 连续性由 `hello.count` + `hello.holes` 表达，服务端不替客户端编区间
 * （ADR-105 §9 R4）。为什么过渡期还留：B2 上线前老客户端是生产客户端，
 * 它靠这一帧知道「慢消费跳过了 [from_seq, to_seq]」，删早了就退化为静默丢帧。
 */
export function gapFrame(input: GapFrameInput): ServerFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'gap',
    node_id: input.nodeId,
    ts: input.ts ?? Date.now(),
    from_seq: input.gap.from_seq,
    to_seq: input.gap.to_seq,
  };
}
