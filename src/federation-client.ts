/**
 * S7 出站 federation client（asm 层）。
 *
 * - 只走节点直连 `POST <peer.url>/v1/federation/messages`；hub 不在数据面。
 * - allowlist 未命中 / 未启用时**不发网络请求**；无重试、无队列。
 * - token 只从 `FederationRuntimeOptions.peers[].token` 取，只放进
 *   `Authorization: Bearer`，绝不进入错误消息 / 返回值 / 日志。
 * - wire 形状见 DECISION-036 §3.2；本模块不做入站解析。
 *
 * @module vessel/federation-client
 */

import { readFile } from 'node:fs/promises';
import {
  type FederationAddress,
  formatFederationAddress,
  parseFederationAddress,
} from './federation-address';
import type { FederationRuntimeOptions, FederationRuntimePeer } from './federation-config';

/** wire 协议版本（DECISION-036 §3.2） */
export const FEDERATION_PROTOCOL = 'vessel.federation/1';

/** 对端入站端点（DECISION-036 §4） */
export const FEDERATION_MESSAGES_PATH = '/v1/federation/messages';

/** 对端成员目录端点（0.21，DECISION-037 §7.2） */
export const FEDERATION_TEAM_INFO_PATH = '/v1/federation/team-info';

/** team-info `members_limit` 范围（与接收侧一致）。 */
export const FEDERATION_TEAM_INFO_DEFAULT_LIMIT = 20;
export const FEDERATION_TEAM_INFO_MAX_LIMIT = 100;

/** `message_id` / `conversation_id` / `request_id` 共用形状 */
const FEDERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 正文上限：65536 UTF-8 bytes */
export const FEDERATION_MAX_CONTENT_BYTES = 65_536;

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FederationMessage {
  protocol: 'vessel.federation/1';
  message_id: string;
  conversation_id: string;
  from: FederationAddress;
  to: FederationAddress;
  content: string;
  ts: number;
  hop: number;
  request_id?: string;
}

export interface FederationPostInput {
  /** 本机发起地址；`from.node_id` 必须等于 `options.nodeId` */
  from: FederationAddress;
  /** 目标地址（其 `(node_id, team_id)` 必须命中 allowlist 且方向含 out） */
  to: FederationAddress;
  content: string;
  conversation_id?: string;
  request_id?: string;
}

export interface FederationClientIo {
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（默认 10000ms） */
  timeoutMs?: number;
  now?: () => number;
  generateId?: () => string;
}

/** 出站结果（DECISION-036 §3.4；`remote_code` 只透传对端错误码） */
export type FederationPostResult =
  | { status: 'delivered' | 'deduplicated'; message_id: string; hop: number; cursor: string }
  | {
      status: 'rejected';
      code: string;
      reason: string;
      remote_code?: string;
    };

/** team-info 成员条目（脱敏后的 wire 形状）。 */
export interface FederationTeamInfoMember {
  name: string;
  presence: 'live' | 'gone';
  last_seen?: number;
}

/** team-info 结果（DECISION-037 §7.2）。 */
export interface FederationTeamInfo {
  team_id: string;
  name: string;
  description?: string;
  member_count: number;
  online_count: number;
  members: FederationTeamInfoMember[];
}

export interface FederationTeamInfoInput {
  /** 目标 Team 地址；`principal` 不参与目录查询。 */
  to: FederationAddress;
  members_limit?: number;
}

export type FederationTeamInfoResult =
  | { status: 'ok'; team: FederationTeamInfo }
  | { status: 'rejected'; code: string; reason: string; remote_code?: string };

/**
 * 本地配置 / 调用方输入错误（不是对端拒绝）。
 * CLI 映射为用法/配置错误（exit 2）。
 */
export class FederationClientError extends Error {
  readonly code: 'federation_invalid' | 'federation_invalid_config';

  constructor(code: 'federation_invalid' | 'federation_invalid_config', message: string) {
    super(message);
    this.name = 'FederationClientError';
    this.code = code;
  }
}

type FetchInit = RequestInit & { tls?: { ca: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function randomId(): string {
  return crypto.randomUUID();
}

/** 正文按 UTF-8 字节计长（不按 UTF-16 code unit） */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function validId(value: string): boolean {
  return FEDERATION_ID_RE.test(value);
}

/** 找 allowlist peer；未知 / 方向不符返回 undefined（fail closed） */
function findOutboundPeer(
  options: FederationRuntimeOptions,
  to: Pick<FederationAddress, 'node_id' | 'team_id'>,
): FederationRuntimePeer | undefined {
  return options.peers.find(
    (peer) =>
      peer.nodeId === to.node_id &&
      peer.teamId === to.team_id &&
      (peer.direction === 'out' || peer.direction === 'both'),
  );
}

/**
 * 该 node 段是否在配置里出现过（任何 team / 任何方向）。
 *
 * 用来区分两种「发不出去」：节点根本不存在 vs 节点存在但这条 peer/方向没开。
 * 前者是调用方写错了地址，后者是策略。回同一个 code 会让排查方向相反。
 */
function hasKnownPeerNode(options: FederationRuntimeOptions, nodeId: string): boolean {
  return options.peers.some((peer) => peer.nodeId === nodeId);
}

/** peer.url 缺失 / 非 http(s) 属于配置错误 */
function resolveEndpoint(
  peer: FederationRuntimePeer,
  path: string = FEDERATION_MESSAGES_PATH,
): string {
  if (peer.url === undefined || peer.url === '') {
    throw new FederationClientError(
      'federation_invalid_config',
      `federation peer ${peer.nodeId}:${peer.teamId} has no url`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(peer.url);
  } catch {
    throw new FederationClientError(
      'federation_invalid_config',
      `federation peer ${peer.nodeId}:${peer.teamId} url is not a valid http(s) URL`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FederationClientError(
      'federation_invalid_config',
      `federation peer ${peer.nodeId}:${peer.teamId} url must be http(s)`,
    );
  }
  return `${peer.url}${path}`;
}

/** 三段地址必须已通过 parser；不合法的对象在发请求前拒绝。 */
function requireValidAddress(label: 'from' | 'to', address: FederationAddress): void {
  const parsed = parseFederationAddress(formatFederationAddress(address));
  if (!parsed.ok) {
    throw new FederationClientError('federation_invalid', `federation ${label} address is invalid`);
  }
}

/** 校验调用方输入并生成 wire 消息（hop 恒为 1） */
export function buildFederationMessage(
  options: FederationRuntimeOptions,
  input: FederationPostInput,
  io: Pick<FederationClientIo, 'now' | 'generateId'> = {},
): FederationMessage {
  const contentBytes = utf8Bytes(input.content);
  if (contentBytes < 1 || contentBytes > FEDERATION_MAX_CONTENT_BYTES) {
    throw new FederationClientError(
      'federation_invalid',
      `federation content must be 1..${FEDERATION_MAX_CONTENT_BYTES} UTF-8 bytes`,
    );
  }
  requireValidAddress('from', input.from);
  requireValidAddress('to', input.to);
  // 本机身份只由 options.nodeId 决定；调用方不能声明别的节点。
  if (input.from.node_id !== options.nodeId) {
    throw new FederationClientError(
      'federation_invalid',
      'federation from node_id does not match this node',
    );
  }
  const conversationId = input.conversation_id ?? (io.generateId ?? randomId)();
  if (!validId(conversationId)) {
    throw new FederationClientError(
      'federation_invalid',
      'federation conversation_id does not match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
    );
  }
  const messageId = (io.generateId ?? randomId)();
  if (!validId(messageId)) {
    throw new FederationClientError(
      'federation_invalid',
      'federation message_id does not match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
    );
  }
  if (input.request_id !== undefined && !validId(input.request_id)) {
    throw new FederationClientError('federation_invalid', 'federation request_id is invalid');
  }

  const message: FederationMessage = {
    protocol: FEDERATION_PROTOCOL,
    message_id: messageId,
    conversation_id: conversationId,
    from: input.from,
    to: input.to,
    content: input.content,
    ts: (io.now ?? Date.now)(),
    hop: 1,
  };
  if (input.request_id !== undefined) message.request_id = input.request_id;
  return message;
}

function errorDetail(body: unknown): { code?: string; message?: string } {
  if (!isRecord(body) || !isRecord(body.error)) return {};
  const result: { code?: string; message?: string } = {};
  if (typeof body.error.code === 'string' && body.error.code !== '') result.code = body.error.code;
  if (typeof body.error.message === 'string') result.message = body.error.message;
  return result;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * 向 allowlist 中的 peer 投递一条消息。
 *
 * 禁用 / 未命中 allowlist 在构造请求前返回 rejected，不产生网络请求。
 * 配置错误抛 `FederationClientError`；网络 / TLS / 超时不重试。
 */
export async function postFederation(
  options: FederationRuntimeOptions,
  input: FederationPostInput,
  io: FederationClientIo = {},
): Promise<FederationPostResult> {
  if (options.enabled !== true) {
    return {
      status: 'rejected',
      code: 'federation_disabled',
      reason: 'federation is disabled on this node',
    };
  }

  const peer = findOutboundPeer(options, input.to);
  if (peer === undefined) {
    // 地址写错了 node 段 vs 策略不允许：分开报，排查方向完全不同。
    // reason 只回显 `node:team` 两段（有字符集约束），不回显调用方原文。
    if (!hasKnownPeerNode(options, input.to.node_id)) {
      return {
        status: 'rejected',
        code: 'federation_unknown_node',
        reason: `no configured federation node ${input.to.node_id}:${input.to.team_id}`,
      };
    }
    return {
      status: 'rejected',
      code: 'federation_not_allowed',
      reason: `no outbound federation peer for ${input.to.node_id}:${input.to.team_id}`,
    };
  }

  const message = buildFederationMessage(options, input, io);
  const endpoint = resolveEndpoint(peer);

  const init: FetchInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${peer.token}`,
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(io.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  if (peer.caFile !== undefined) {
    let ca: string;
    try {
      ca = await readFile(peer.caFile, 'utf8');
    } catch {
      throw new FederationClientError(
        'federation_invalid_config',
        `cannot read CA file for ${peer.nodeId}:${peer.teamId}`,
      );
    }
    init.tls = { ca };
  }

  const fetchImpl = io.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'rejected',
      code: 'federation_peer_unreachable',
      reason: `cannot reach federation peer ${peer.nodeId}:${peer.teamId}: ${detail}`,
    };
  }

  const body = await readJson(response);

  if (!response.ok) {
    const detail = errorDetail(body);
    const result: FederationPostResult = {
      status: 'rejected',
      code: 'federation_peer_error',
      reason: detail.message ?? `peer returned HTTP ${response.status}`,
    };
    if (detail.code !== undefined) result.remote_code = detail.code;
    return result;
  }

  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.message_id !== 'string' ||
    body.message_id === '' ||
    typeof body.cursor !== 'string'
  ) {
    return {
      status: 'rejected',
      code: 'federation_peer_error',
      reason: 'peer returned an invalid federation response',
    };
  }

  return {
    status: body.deduplicated === true ? 'deduplicated' : 'delivered',
    message_id: body.message_id,
    hop: message.hop,
    cursor: body.cursor,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * 严格解析对端目录响应并重建脱敏对象：只保留名字 / 活跃度 / 描述，
 * 即使对端多返回 agent_id / workspace / policy 也不会进入结果。
 */
function parseTeamInfoBody(body: unknown): FederationTeamInfo | undefined {
  if (!isRecord(body)) return undefined;
  if (body.protocol !== FEDERATION_PROTOCOL) return undefined;
  if (typeof body.team_id !== 'string' || body.team_id === '') return undefined;
  if (typeof body.name !== 'string') return undefined;
  if (!isCount(body.member_count) || !isCount(body.online_count)) return undefined;
  if (!Array.isArray(body.members)) return undefined;

  const members: FederationTeamInfoMember[] = [];
  for (const raw of body.members) {
    if (!isRecord(raw)) return undefined;
    if (typeof raw.name !== 'string' || raw.name === '') return undefined;
    if (raw.presence !== 'live' && raw.presence !== 'gone') return undefined;
    const entry: FederationTeamInfoMember = { name: raw.name, presence: raw.presence };
    if (raw.last_seen !== undefined) {
      if (typeof raw.last_seen !== 'number' || !Number.isFinite(raw.last_seen)) return undefined;
      entry.last_seen = raw.last_seen;
    }
    members.push(entry);
  }

  const team: FederationTeamInfo = {
    team_id: body.team_id,
    name: body.name,
    member_count: body.member_count,
    online_count: body.online_count,
    members,
  };
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return undefined;
    team.description = body.description;
  }
  return team;
}

/**
 * 查询 allowlist peer 的 Team 目录（0.21，DECISION-037 §7.2）。
 *
 * 禁用 / 未命中 allowlist 在构造请求前返回 rejected，不产生网络请求。
 * 配置错误抛 `FederationClientError`；网络 / TLS / 超时不重试；token 不进入结果。
 */
export async function postFederationTeamInfo(
  options: FederationRuntimeOptions,
  input: FederationTeamInfoInput,
  io: FederationClientIo = {},
): Promise<FederationTeamInfoResult> {
  if (options.enabled !== true) {
    return {
      status: 'rejected',
      code: 'federation_disabled',
      reason: 'federation is disabled on this node',
    };
  }

  const peer = findOutboundPeer(options, input.to);
  if (peer === undefined) {
    return {
      status: 'rejected',
      code: 'federation_not_allowed',
      reason: `no outbound federation peer for ${input.to.node_id}:${input.to.team_id}`,
    };
  }

  requireValidAddress('to', input.to);
  if (input.members_limit !== undefined) {
    if (
      typeof input.members_limit !== 'number' ||
      !Number.isInteger(input.members_limit) ||
      input.members_limit < 1 ||
      input.members_limit > FEDERATION_TEAM_INFO_MAX_LIMIT
    ) {
      throw new FederationClientError(
        'federation_invalid',
        `members_limit must be an integer between 1 and ${FEDERATION_TEAM_INFO_MAX_LIMIT}`,
      );
    }
  }

  const endpoint = resolveEndpoint(peer, FEDERATION_TEAM_INFO_PATH);
  const payload = {
    protocol: FEDERATION_PROTOCOL,
    team_id: input.to.team_id,
    ...(input.members_limit !== undefined ? { members_limit: input.members_limit } : {}),
  };

  const init: FetchInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${peer.token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(io.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  if (peer.caFile !== undefined) {
    let ca: string;
    try {
      ca = await readFile(peer.caFile, 'utf8');
    } catch {
      throw new FederationClientError(
        'federation_invalid_config',
        `cannot read CA file for ${peer.nodeId}:${peer.teamId}`,
      );
    }
    init.tls = { ca };
  }

  const fetchImpl = io.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, init);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'rejected',
      code: 'federation_peer_unreachable',
      reason: `cannot reach federation peer ${peer.nodeId}:${peer.teamId}: ${detail}`,
    };
  }

  const body = await readJson(response);
  if (!response.ok) {
    const detail = errorDetail(body);
    const result: FederationTeamInfoResult = {
      status: 'rejected',
      code: 'federation_peer_error',
      reason: detail.message ?? `peer returned HTTP ${response.status}`,
    };
    if (detail.code !== undefined) result.remote_code = detail.code;
    return result;
  }

  const team = parseTeamInfoBody(body);
  if (team === undefined) {
    return {
      status: 'rejected',
      code: 'federation_peer_error',
      reason: 'peer returned an invalid federation team-info response',
    };
  }
  return { status: 'ok', team };
}
