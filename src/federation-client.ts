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
import type { FederationRuntimeOptions, FederationRuntimePeer } from './federation-config';

/** wire 协议版本（DECISION-036 §3.2） */
export const FEDERATION_PROTOCOL = 'vessel.federation/1';

/** 对端入站端点（DECISION-036 §4） */
export const FEDERATION_MESSAGES_PATH = '/v1/federation/messages';

/** `message_id` / `conversation_id` / `request_id` 共用形状 */
const FEDERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 正文上限：65536 UTF-8 bytes */
export const FEDERATION_MAX_CONTENT_BYTES = 65_536;

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FederationMessage {
  protocol: 'vessel.federation/1';
  message_id: string;
  conversation_id: string;
  from: { node_id: string; team_id: string };
  to: { node_id: string; team_id: string };
  content: string;
  ts: number;
  hop: number;
  request_id?: string;
}

export interface FederationPostInput {
  /** 目标 peer 身份（必须命中 allowlist 且方向含 out） */
  to: { node_id: string; team_id: string };
  /** 本机发起 Team（节点身份来自 options.nodeId） */
  fromTeamId: string;
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
  to: { node_id: string; team_id: string },
): FederationRuntimePeer | undefined {
  return options.peers.find(
    (peer) =>
      peer.node_id === to.node_id &&
      peer.team_id === to.team_id &&
      (peer.direction === 'out' || peer.direction === 'both'),
  );
}

/** peer.url 缺失 / 非 http(s) 属于配置错误 */
function resolveEndpoint(peer: FederationRuntimePeer): string {
  if (peer.url === undefined || peer.url === '') {
    throw new FederationClientError(
      'federation_invalid_config',
      `federation peer ${peer.node_id}:${peer.team_id} has no url`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(peer.url);
  } catch {
    throw new FederationClientError(
      'federation_invalid_config',
      `federation peer ${peer.node_id}:${peer.team_id} url is not a valid http(s) URL`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FederationClientError(
      'federation_invalid_config',
      `federation peer ${peer.node_id}:${peer.team_id} url must be http(s)`,
    );
  }
  return `${peer.url}${FEDERATION_MESSAGES_PATH}`;
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
  if (input.fromTeamId === '') {
    throw new FederationClientError('federation_invalid', 'federation fromTeamId is required');
  }
  if (input.to.node_id === '' || input.to.team_id === '') {
    throw new FederationClientError('federation_invalid', 'federation target is required');
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
    from: { node_id: options.nodeId, team_id: input.fromTeamId },
    to: { node_id: input.to.node_id, team_id: input.to.team_id },
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
        `cannot read CA file for ${peer.node_id}:${peer.team_id}`,
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
      reason: `cannot reach federation peer ${peer.node_id}:${peer.team_id}: ${detail}`,
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
