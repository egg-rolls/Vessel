/**
 * Team 协议边界工具（R3）
 *
 * core 内部一律 camelCase；gateway JSON 一律 snake_case（DECISION-003 A7）。
 * 这里只做 wire 映射/校验，不实现传输（见 transport/loopback.ts）。
 *
 * @module @vessel-agent/serve/team
 */

import type {
  AgentMessage,
  AgentStatus,
  InboxPage,
  PeerInfo,
  RunEvent,
  Transport,
} from '@vessel-agent/core';
import { PROTOCOL_VERSION } from './protocol.js';

/** 协议边界允许的 kind（U2：core 仍是开放 string） */
export const TEAM_MESSAGE_KINDS = new Set(['message', 'task', 'result', 'cancel']);

/** AGENT_ID_PATTERN（A11） */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 线上 AgentMessage（snake_case） */
export interface WireAgentMessage {
  id: string;
  from: string;
  to: string;
  kind: string;
  content: string;
  reply_to?: string;
  ts: number;
}

/** 线上 AgentStatus（snake_case） */
export interface WireAgentStatus {
  id: string;
  name?: string;
  state: AgentStatus['state'];
  current_run_id?: string;
  tool_names: string[];
  last_error?: string;
}

/** 线上 PeerInfo（snake_case） */
export interface WirePeerInfo {
  node_id: string;
  endpoint?: string;
  agents: WireAgentStatus[];
  protocol: typeof PROTOCOL_VERSION;
  /** 0.9：对端进程代际；旧对端 / 未知时省略（消费方按 `-` 处理） */
  incarnation?: string;
}

/** 0.9 additive：core `PeerInfo` + 代际（transport.peers() 可能是该超集）。 */
export type PeerInfoWithIncarnation = PeerInfo & { incarnation?: string };

/** 协议错误（带稳定 code） */
export class TeamProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TeamProtocolError';
  }
}

/** Host 的最小结构面（RuntimeHost 结构满足） */
export interface TeamHostLike {
  list(): AgentStatus[];
  get(id: string): { status(): AgentStatus; close(): Promise<void> } | undefined;
  inbox(id: string, cursor?: string): Promise<InboxPage>;
  send?(message: AgentMessage): Promise<void>;
  cancel(id: string, runId?: string): void;
  /** 0.14.1 / 0.15 E3：只读快照；自定义 Host 可缺省。 */
  snapshot?(): unknown;
}

/** 成员 spawn 注入（provider/model 由 asm/ext 提供） */
export interface TeamSpawnRequest {
  name?: string;
  model?: string;
  systemPrompt?: string;
}

/** gateway team 端点配置 */
export interface TeamGatewayOptions {
  /** 唯一来源 host.node_id（U3） */
  nodeId: string;
  /** loopback transport；缺省 = 仅 in-process（无跨进程） */
  transport?: Transport;
  /** 成员管理/收件箱；缺省时相关端点返回 no_host */
  host?: TeamHostLike;
  /** 入站投递；缺省依次尝试 transport.deliver / host.send */
  deliver?: (message: AgentMessage) => void | Promise<void>;
  /** spawn 注入；缺省时 POST /v1/team/agents 返回 no_spawn */
  spawn?: (request: TeamSpawnRequest) => Promise<AgentStatus>;
  /** peer 轮询间隔（毫秒，默认 5000） */
  peerPollMs?: number;
}

/** 地址校验：`*` | agentId | nodeId:agentId（U1） */
export function isValidAddress(address: string): boolean {
  if (address === '*') return true;
  const parts = address.split(':');
  if (parts.length === 1) return ID_PATTERN.test(parts[0] ?? '');
  if (parts.length === 2) return ID_PATTERN.test(parts[0] ?? '') && ID_PATTERN.test(parts[1] ?? '');
  return false;
}

/** 解析地址；本机简写返回 nodeId=undefined */
export function parseAddress(address: string): { nodeId?: string; agentId: string } {
  if (!isValidAddress(address) || address === '*') {
    throw new TeamProtocolError('invalid_request', `Invalid address: ${address}`);
  }
  const parts = address.split(':');
  if (parts.length === 1) return { agentId: parts[0] ?? '' };
  return { nodeId: parts[0], agentId: parts[1] ?? '' };
}

/**
 * 入站消息若指向本节点（`<nodeId>:agentId`），把 `to` 归一成本机 `agentId`，
 * 便于 Host/Runtime 直接路由；`from` 保留 canonical 形式供回复。
 */
export function normalizeLocalAddress(message: AgentMessage, nodeId: string): AgentMessage {
  if (message.to === '*') return message;
  const target = parseAddress(message.to);
  if (target.nodeId !== nodeId) return message;
  return { ...message, to: target.agentId };
}

/** 目标是否属于另一个节点（用于拒绝中继） */
export function isRemoteAddress(address: string, nodeId: string): boolean {
  if (address === '*') return false;
  const target = parseAddress(address);
  return target.nodeId !== undefined && target.nodeId !== nodeId;
}

/** core AgentMessage → wire（snake_case） */
export function toWireMessage(message: AgentMessage): WireAgentMessage {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    kind: message.kind,
    content: message.content,
    ...(message.replyTo !== undefined ? { reply_to: message.replyTo } : {}),
    ts: message.ts,
  };
}

/** wire → core AgentMessage（校验地址与已知 kind） */
export function fromWireMessage(raw: unknown): AgentMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TeamProtocolError('invalid_request', 'message must be an object');
  }
  const value = raw as Record<string, unknown>;
  const id = value.id;
  const from = value.from;
  const to = value.to;
  const kind = value.kind;
  const content = value.content;
  const ts = value.ts;
  const replyTo = value.reply_to;

  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new TeamProtocolError('invalid_request', 'message.id must be a non-empty string (<=128)');
  }
  if (typeof from !== 'string' || !isValidAddress(from) || from === '*') {
    throw new TeamProtocolError('invalid_request', 'message.from must be a valid address');
  }
  if (typeof to !== 'string' || !isValidAddress(to)) {
    throw new TeamProtocolError('invalid_request', 'message.to must be a valid address');
  }
  if (typeof kind !== 'string' || !TEAM_MESSAGE_KINDS.has(kind)) {
    throw new TeamProtocolError(
      'invalid_request',
      `Unknown message.kind "${String(kind)}" (expected message/task/result/cancel)`,
    );
  }
  if (typeof content !== 'string') {
    throw new TeamProtocolError('invalid_request', 'message.content must be a string');
  }
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    throw new TeamProtocolError('invalid_request', 'message.ts must be a number');
  }
  if (replyTo !== undefined && typeof replyTo !== 'string') {
    throw new TeamProtocolError('invalid_request', 'message.reply_to must be a string');
  }
  return {
    id,
    from,
    to,
    kind,
    content,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ts,
  };
}

/** AgentStatus → wire */
export function toWireAgentStatus(status: AgentStatus): WireAgentStatus {
  return {
    id: status.id,
    ...(status.name !== undefined ? { name: status.name } : {}),
    state: status.state,
    ...(status.currentRunId !== undefined ? { current_run_id: status.currentRunId } : {}),
    tool_names: status.toolNames,
    ...(status.lastError !== undefined ? { last_error: status.lastError } : {}),
  };
}

/** PeerInfo → wire；0.9 代际存在时透出，缺失则省略（向后兼容）。 */
export function toWirePeer(peer: PeerInfoWithIncarnation): WirePeerInfo {
  const incarnation =
    typeof peer.incarnation === 'string' && peer.incarnation !== '' ? peer.incarnation : undefined;
  return {
    node_id: peer.nodeId,
    ...(peer.endpoint !== undefined ? { endpoint: peer.endpoint } : {}),
    agents: peer.agents.map(toWireAgentStatus),
    protocol: PROTOCOL_VERSION,
    ...(incarnation !== undefined ? { incarnation } : {}),
  };
}

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
export function toWireEvent(event: RunEvent): RunEvent {
  if (!event.type.startsWith('agent.') && !event.type.startsWith('team.')) return event;
  return {
    ...event,
    data: toSnakeValue(event.data) as RunEvent['data'],
  };
}

/** 是否为 team 事件流关心的事件 */
export function isTeamEvent(event: RunEvent): boolean {
  return event.type.startsWith('agent.') || event.type.startsWith('team.');
}
