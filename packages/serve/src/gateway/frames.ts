/**
 * Gateway WS/SSE 帧构造 — 纯函数，所有输入显式传入。
 *
 * @module @vessel-agent/serve/gateway/frames
 */

import type { RunEvent } from '@vessel-agent/core';
import {
  type NodeInfo,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolInfo,
  protocolError,
  type ServerFrame,
} from '../protocol.js';
import type { TimelineEpochEndSegment, TimelineHelloSegment } from './timeline-protocol.js';

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
   * 时间线段（0.55：**它的存在本身就是判据**）。
   *
   * 给了 ⇒ 本 epoch 是时间线 epoch（帧的 `seq` 是会话内 `timeline_seq`，下面七个字段
   * 一并给出）；不给 ⇒ 老 epoch（环形 hub seq，老行为）。
   *
   * 0.54 时代这里还有一个 `timeline_source: 'timeline' | 'legacy'` 的**显式标记**，
   * 0.55 删掉了：形状本身（`timeline` 在不在）已经是完整的判据，多一个字段就多一处
   * 可能与形状不一致的地方。老客户端读的正是「`start_seq` 等在不在」，所以删它不会
   * 让任何老客户端改变行为（它们本来就不认识 `timeline_source`）。
   */
  timeline?: TimelineHelloSegment;
}

export function helloFrame(input: HelloFrameInput): ServerFrame {
  const timeline = input.timeline;
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
