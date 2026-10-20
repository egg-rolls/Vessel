/**
 * Gateway WS/SSE 帧构造 — 纯函数，所有输入显式传入。
 *
 * @module @vessel/serve/gateway/frames
 */

import type { RunEvent } from '@vessel/core';
import type { EventGap } from '../event-buffer.js';
import {
  type NodeInfo,
  PROTOCOL_VERSION,
  type ProtocolError,
  type ProtocolInfo,
  protocolError,
  type ServerFrame,
} from '../protocol.js';
import { toWireEvent } from '../team.js';

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
  fromSeq: number;
  latestSeq: number;
  oldestSeq: number;
  tenantId?: string;
  ts?: number;
}

export function helloFrame(input: HelloFrameInput): ServerFrame {
  const { latestSeq } = input;
  // from_seq = 本次回放的第一条 seq；空缓冲时为 0（此时 latest_seq 也是 0）。
  // 已追平时为 since + 1（= latest + 1），表示「下一条期望序号」。
  return {
    v: PROTOCOL_VERSION,
    kind: 'hello',
    node_id: input.nodeId,
    ts: input.ts ?? Date.now(),
    protocol: input.protocol,
    node: input.node,
    from_seq: latestSeq === 0 ? 0 : Math.max(input.fromSeq + 1, input.oldestSeq),
    latest_seq: latestSeq,
    ...(input.tenantId !== undefined ? { tenant_id: input.tenantId } : {}),
  };
}

export interface GapFrameInput {
  nodeId: string;
  gap: EventGap;
  ts?: number;
}

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
