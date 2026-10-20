/**
 * 跨节点 team 控制协议（0.6 F5/B3）。
 *
 * 只定义 team 自己的方法名、wire→legacy 映射与错误归一；
 * HTTP/TLS/token/重连由 asm 注入的 `Transport.request` 实现负责。
 * 本文件不依赖 serve/core 的远程实现，也不改 core 类型。
 *
 * 冻结形状见 DECISION-014 Addendum B/C：
 * - team.spawn       → POST /v1/team/agents
 * - team.inbox       → GET  /v1/team/inbox
 * - team.status      → GET  /v1/team/agents/:id
 * - team.status.list → GET  /v1/team/agents
 */

import { randomUUID } from 'node:crypto';
import type { Transport } from '@vessel-agent/core';
import type { AgentState, AgentStatus, InboxPage, TeamMessage, TeamMessageKind } from './host.js';

/** 跨节点控制方法（响应/请求均为 gateway wire 形状） */
export const TEAM_REMOTE_METHODS = {
  spawn: 'team.spawn',
  inbox: 'team.inbox',
  status: 'team.status',
  statusList: 'team.status.list',
} as const;

export type TeamRemoteMethod = (typeof TEAM_REMOTE_METHODS)[keyof typeof TEAM_REMOTE_METHODS];

/** 冻结的传输错误码（Addendum B） */
export const REMOTE_TEAM_ERROR_CODES = [
  'transport_closed',
  'peer_not_found',
  'peer_unreachable',
  'timeout',
  'unauthorized',
  'unsupported_protocol',
  'invalid_request',
  'agent_not_found',
  'no_spawn',
] as const;

export type RemoteTeamErrorCode = (typeof REMOTE_TEAM_ERROR_CODES)[number] | 'remote_unsupported';

const KNOWN_CODES = new Set<string>(REMOTE_TEAM_ERROR_CODES);

/** 稳定错误：message 带 `<code>: ` 前缀，工具层统一显示为 `Error: <code>: ...` */
export class RemoteTeamError extends Error {
  constructor(
    readonly code: RemoteTeamErrorCode,
    message: string,
    readonly nodeId?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RemoteTeamError';
  }
}

/** Transport.request 的结构形状（core 0.6 additive；此处本地声明保证 0.5 分支可 typecheck） */
interface TransportRequestLike {
  requestId?: string;
  method: string;
  params?: unknown;
}

interface RemoteCapableTransport extends Transport {
  request?<T>(nodeId: string, request: TransportRequestLike): Promise<T>;
}

export interface RemoteRequestOptions {
  /** status/inbox 等幂等操作允许一次重试；spawn 禁止 */
  retryOnce?: boolean;
  /** 同一逻辑请求的重试复用同一个 id；缺省生成 */
  requestId?: string;
}

/** transport 是否具备远程控制能力 */
export function hasRemoteRequest(transport: Transport): boolean {
  return typeof (transport as RemoteCapableTransport).request === 'function';
}

/** 是否可安全重试（仅网络类错误） */
function isRetryable(code: RemoteTeamErrorCode): boolean {
  return code === 'timeout' || code === 'peer_unreachable';
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把任意传输/远端错误归一为冻结错误码；未知码按 peer_unreachable 处理 */
export function normalizeRemoteError(error: unknown, nodeId?: string): RemoteTeamError {
  if (error instanceof RemoteTeamError) return error;
  const raw = errorCode(error);
  const code: RemoteTeamErrorCode =
    raw !== undefined && KNOWN_CODES.has(raw) ? (raw as RemoteTeamErrorCode) : 'peer_unreachable';
  return new RemoteTeamError(code, errorMessage(error), nodeId);
}

/**
 * 发起一次跨节点请求。
 * - 无 `request` 能力 → remote_unsupported；
 * - `retryOnce` 只对 timeout / peer_unreachable 重试一次，并复用 requestId；
 * - 其它错误立即抛出，由工具层折回文本。
 */
export async function requestRemote<T = unknown>(
  transport: Transport,
  nodeId: string,
  method: TeamRemoteMethod,
  params?: unknown,
  options: RemoteRequestOptions = {},
): Promise<T> {
  const capable = transport as RemoteCapableTransport;
  if (typeof capable.request !== 'function') {
    throw new RemoteTeamError(
      'remote_unsupported',
      `transport does not support remote requests (node "${nodeId}")`,
      nodeId,
    );
  }

  const requestId = options.requestId ?? randomUUID();
  const attempts = options.retryOnce ? 2 : 1;
  let last: RemoteTeamError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await capable.request<T>(nodeId, {
        requestId,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    } catch (error) {
      last = normalizeRemoteError(error, nodeId);
      if (attempt + 1 >= attempts || !isRetryable(last.code)) break;
    }
  }

  throw last ?? new RemoteTeamError('peer_unreachable', 'remote request failed', nodeId);
}

// ── wire → legacy 映射（gateway 边界 snake_case） ──────────

const AGENT_STATES = new Set<AgentState>(['idle', 'running', 'cancelled', 'error', 'closed']);
const MESSAGE_KINDS = new Set<TeamMessageKind>(['message', 'task', 'result', 'cancel']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalid(nodeId: string, message: string): RemoteTeamError {
  return new RemoteTeamError('invalid_request', message, nodeId);
}

/** gateway WireAgentStatus → 工具输出（保留旧字段，附加 nodeId） */
export function toRemoteStatus(raw: unknown, nodeId: string): AgentStatus {
  const value = asRecord(raw);
  if (!value) throw invalid(nodeId, 'invalid remote agent status');
  const id = value.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw invalid(nodeId, 'remote agent status.id must be a non-empty string');
  }
  const state = value.state;
  if (typeof state !== 'string' || !AGENT_STATES.has(state as AgentState)) {
    throw invalid(nodeId, `remote agent status.state is invalid: ${String(state)}`);
  }
  const toolNames = Array.isArray(value.tool_names)
    ? value.tool_names.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    id,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    state: state as AgentState,
    toolNames,
    ...(typeof value.last_error === 'string' ? { lastError: value.last_error } : {}),
    nodeId,
  };
}

/** gateway WireAgentMessage → TeamMessage（附加 nodeId） */
export function toRemoteMessage(raw: unknown, nodeId: string): TeamMessage {
  const value = asRecord(raw);
  if (!value) throw invalid(nodeId, 'invalid remote message');
  const { id, from, to, kind, content, ts } = value;
  if (typeof id !== 'string' || id.length === 0)
    throw invalid(nodeId, 'remote message.id is invalid');
  if (typeof from !== 'string' || from.length === 0) {
    throw invalid(nodeId, 'remote message.from is invalid');
  }
  if (typeof to !== 'string' || to.length === 0)
    throw invalid(nodeId, 'remote message.to is invalid');
  if (typeof kind !== 'string' || !MESSAGE_KINDS.has(kind as TeamMessageKind)) {
    throw invalid(nodeId, `remote message.kind is invalid: ${String(kind)}`);
  }
  if (typeof content !== 'string') throw invalid(nodeId, 'remote message.content is invalid');
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    throw invalid(nodeId, 'remote message.ts is invalid');
  }
  return {
    id,
    from,
    to,
    kind: kind as TeamMessageKind,
    content,
    ...(typeof value.reply_to === 'string' ? { reply_to: value.reply_to } : {}),
    ts,
    nodeId,
  };
}

/** gateway inbox 响应 → InboxPage */
export function toRemoteInbox(raw: unknown, nodeId: string): InboxPage {
  const value = asRecord(raw);
  if (!value) throw invalid(nodeId, 'invalid remote inbox page');
  const messages = value.messages;
  if (!Array.isArray(messages)) throw invalid(nodeId, 'remote inbox messages must be an array');
  if (typeof value.cursor !== 'string') throw invalid(nodeId, 'remote inbox cursor is invalid');
  return {
    messages: messages.map((message) => toRemoteMessage(message, nodeId)),
    cursor: value.cursor,
  };
}

/** gateway GET /v1/team/agents 响应 → AgentStatus[] */
export function toRemoteStatusList(raw: unknown, nodeId: string): AgentStatus[] {
  const value = asRecord(raw);
  if (!value || !Array.isArray(value.agents)) {
    throw invalid(nodeId, 'invalid remote agent list');
  }
  return value.agents.map((agent) => toRemoteStatus(agent, nodeId));
}
