/**
 * S7 federation 入站路由（node ↔ node，DECISION-036）。
 *
 * - 独立 peer bearer：gateway 用户 token 与 peer token 命名空间不交叉；
 * - 严格解析 wire envelope：未知 / 缺失字段一律 `federation_invalid`；
 * - 只写接收侧 Team 日志（`TeamControlLike.post`），不 dispatch、不产生 run；
 * - 拒绝无副作用：不写日志、不 dispatch、只发一次 `federation.rejected`。
 *
 * 路由必须在 gateway `principalForRequest` 之前处理（同 hub 路由位置）。
 *
 * @module @vessel-agent/serve/federation
 */

import { timingSafeEqual } from 'node:crypto';
import type { TeamControlLike, TeamDetailLike } from './team-control.js';

export const FEDERATION_PROTOCOL = 'vessel.federation/1';
export const FEDERATION_MESSAGES_PATH = '/v1/federation/messages';

/** 接收侧固定 tenant（v1 不做多 tenant federation）。 */
const FEDERATION_TENANT = 'default';

/** 去重容量：进程内 LRU，不声称跨重启 exactly-once。 */
const DEDUPE_LIMIT = 1024;

/** 报文信封上限；正文本身另有 1..65536 bytes 限制。 */
const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_CONTENT_BYTES = 65_536;

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const TOP_LEVEL_KEYS = new Set([
  'protocol',
  'message_id',
  'conversation_id',
  'from',
  'to',
  'content',
  'ts',
  'hop',
  'request_id',
]);
const IDENTITY_KEYS = new Set(['node_id', 'team_id']);

export type FederationDirection = 'in' | 'out' | 'both';

/** 已解析 token 的入站 peer（`direction` 缺省 both 由 resolver 补齐）。 */
export interface FederationGatewayPeer {
  node_id: string;
  team_id: string;
  direction: FederationDirection;
  /** 仅出站映射用；入站不改写目标 Team（S7.1 以 `to.team_id` 为准）。 */
  localTeamId?: string;
  /** 内存 token：只用于定长比较，不序列化 / 不打印。 */
  token: string;
}

/** gateway 注入面；结构对齐 asm 的 `FederationRuntimeOptions`。 */
export interface FederationGatewayOptions {
  enabled: boolean;
  nodeId: string;
  maxHops: number;
  peers: FederationGatewayPeer[];
}

export interface FederationRouteOptions {
  /** 未注入或 `enabled !== true` → 端点返回 404。 */
  federation?: FederationGatewayOptions;
  /** 目标 Team 控制面（default tenant）；未注入 → 404 `team_not_found`。 */
  teams?: TeamControlLike;
  /** 诊断事件出口（gateway 注入 `publishTeamEvent`，投 default tenant 流）。 */
  publish?: (type: string, data: Record<string, unknown>) => void;
}

export interface FederationRoute {
  /** 非 federation 路径返回 `null`；其余一律返回 Response。 */
  handle(req: Request, extra?: Record<string, string>): Promise<Response | null>;
}

interface EnvelopeIdentity {
  node_id: string;
  team_id: string;
}

interface FederationMessage {
  message_id: string;
  conversation_id: string;
  from: EnvelopeIdentity;
  to: EnvelopeIdentity;
  content: string;
  ts: number;
  hop: number;
}

interface DedupeEntry {
  message_id: string;
  cursor: string;
}

/** 进程内 LRU：命中即刷新，超过上限淘汰最旧。 */
class ReceivedCache {
  private readonly entries = new Map<string, DedupeEntry>();

  constructor(private readonly limit: number) {}

  get(key: string): DedupeEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: DedupeEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function errorJson(
  code: string,
  message: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, extra);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

/** 只读取身份字段；字段缺失 / 类型错误返回 undefined（由调用方决定错误码）。 */
function identityOf(value: unknown): EnvelopeIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.node_id !== 'string' || typeof value.team_id !== 'string') return undefined;
  return { node_id: value.node_id, team_id: value.team_id };
}

function identityShapeValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length !== IDENTITY_KEYS.size) return false;
  for (const key of Object.keys(value)) if (!IDENTITY_KEYS.has(key)) return false;
  return true;
}

/**
 * 严格解析 envelope；任何未知 / 缺失字段、错误类型、非法 pattern 都返回 undefined。
 * 调用方在 `from` 身份比对之后调用。
 */
function parseEnvelope(
  record: Record<string, unknown>,
  localNodeId: string,
): FederationMessage | undefined {
  for (const key of Object.keys(record)) if (!TOP_LEVEL_KEYS.has(key)) return undefined;

  const required = [
    'protocol',
    'message_id',
    'conversation_id',
    'from',
    'to',
    'content',
    'ts',
    'hop',
  ] as const;
  for (const key of required) if (!hasOwn(record, key)) return undefined;

  if (record.protocol !== FEDERATION_PROTOCOL) return undefined;
  if (typeof record.message_id !== 'string' || !MESSAGE_ID_RE.test(record.message_id)) {
    return undefined;
  }
  if (typeof record.conversation_id !== 'string' || !MESSAGE_ID_RE.test(record.conversation_id)) {
    return undefined;
  }

  if (!identityShapeValid(record.from) || !identityShapeValid(record.to)) return undefined;
  const from = identityOf(record.from);
  const to = identityOf(record.to);
  if (!from || !to) return undefined;
  if (!NODE_ID_RE.test(from.node_id) || !TEAM_ID_RE.test(from.team_id)) return undefined;
  if (!NODE_ID_RE.test(to.node_id) || !TEAM_ID_RE.test(to.team_id)) return undefined;
  if (to.node_id !== localNodeId) return undefined;

  if (typeof record.content !== 'string') return undefined;
  const contentBytes = Buffer.byteLength(record.content, 'utf8');
  if (contentBytes < 1 || contentBytes > MAX_CONTENT_BYTES) return undefined;

  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return undefined;
  if (typeof record.hop !== 'number' || !Number.isInteger(record.hop) || record.hop < 1) {
    return undefined;
  }

  if (hasOwn(record, 'request_id')) {
    const requestId = record.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return undefined;
    }
  }

  return {
    message_id: record.message_id,
    conversation_id: record.conversation_id,
    from,
    to,
    content: record.content,
    ts: record.ts,
    hop: record.hop,
  };
}

/** 从 Authorization: Bearer 中解析 token；缺失 / 非 Bearer 返回 undefined。 */
function bearerToken(req: Request): string | undefined {
  const header = req.headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1];
  return token && token.length > 0 ? token : undefined;
}

/**
 * 线性遍历全部 peer 做定长比较（不提前返回），命中且长度一致才算匹配。
 * 未知 token 不会因比较提前退出而泄漏命中位置。
 */
function matchPeer(
  candidate: string,
  peers: readonly FederationGatewayPeer[],
): FederationGatewayPeer | undefined {
  const candidateBytes = Buffer.from(candidate, 'utf8');
  let matched: FederationGatewayPeer | undefined;
  for (const peer of peers) {
    const expectedBytes = Buffer.from(peer.token, 'utf8');
    if (expectedBytes.length === 0) continue;
    const sameLength = expectedBytes.length === candidateBytes.length;
    const compared = sameLength ? candidateBytes : Buffer.alloc(expectedBytes.length);
    const equal = timingSafeEqual(expectedBytes, compared);
    if (equal && sameLength) matched = peer;
  }
  return matched;
}

type BodyResult = { ok: true; value: unknown } | { ok: false };

async function readBody(req: Request): Promise<BodyResult> {
  const contentType = req.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('application/json')) {
    return { ok: false };
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_ENVELOPE_BYTES) return { ok: false };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_ENVELOPE_BYTES) return { ok: false };
  if (text.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function dedupeKey(message: FederationMessage): string {
  return `${message.from.node_id}\u0000${message.from.team_id}\u0000${message.message_id}`;
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

/** 创建入站路由；gateway 在 `principalForRequest` 之前调用 `handle()`。 */
export function createFederationRoute(options: FederationRouteOptions): FederationRoute {
  const dedupe = new ReceivedCache(DEDUPE_LIMIT);
  let cursor = 0;

  function publish(type: string, data: Record<string, unknown>): void {
    try {
      options.publish?.(type, data);
    } catch {
      // 诊断事件 best-effort，不影响投递
    }
  }

  return {
    async handle(req, extra = {}) {
      const url = new URL(req.url);
      if (url.pathname !== FEDERATION_MESSAGES_PATH) return null;
      if (req.method !== 'POST') {
        return errorJson('not_found', `Not found: ${url.pathname}`, 404, extra);
      }

      const federation = options.federation;
      if (federation?.enabled !== true) {
        return errorJson('not_found', `Not found: ${url.pathname}`, 404, extra);
      }

      // 1. peer bearer（gateway 用户 token 不属于任何 peer → 401）。
      const token = bearerToken(req);
      const peer = token === undefined ? undefined : matchPeer(token, federation.peers);
      if (!peer) {
        publish('federation.rejected', { direction: 'in', code: 'federation_unauthorized' });
        return errorJson(
          'federation_unauthorized',
          'Missing or invalid federation token',
          401,
          extra,
        );
      }

      // 2. 方向：只接受含 `in` 的 peer。
      if (peer.direction !== 'in' && peer.direction !== 'both') {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_not_allowed',
          peer_node: peer.node_id,
          peer_team: peer.team_id,
        });
        return errorJson(
          'federation_not_allowed',
          'Inbound delivery is not allowed for this peer',
          403,
          extra,
        );
      }

      // 3. body 读取失败仍按报文非法处理（不回显正文）。
      const body = await readBody(req);
      if (!body.ok || !isRecord(body.value)) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_invalid',
          peer_node: peer.node_id,
          peer_team: peer.team_id,
        });
        return errorJson('federation_invalid', 'Invalid federation message', 400, extra);
      }

      // 4. `from` 身份必须等于该 peer（在完整解析之前比对）。
      const claimedFrom = identityOf(body.value.from);
      if (!claimedFrom) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_invalid',
          peer_node: peer.node_id,
          peer_team: peer.team_id,
        });
        return errorJson('federation_invalid', 'Invalid federation message', 400, extra);
      }
      if (claimedFrom.node_id !== peer.node_id || claimedFrom.team_id !== peer.team_id) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_not_allowed',
          peer_node: peer.node_id,
          peer_team: peer.team_id,
        });
        return errorJson(
          'federation_not_allowed',
          'Message origin does not match the authenticated peer',
          403,
          extra,
        );
      }

      // 5. 严格解析。
      const message = parseEnvelope(body.value, federation.nodeId);
      if (!message) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_invalid',
          peer_node: peer.node_id,
          peer_team: peer.team_id,
        });
        return errorJson('federation_invalid', 'Invalid federation message', 400, extra);
      }

      const peerDetail = {
        peer_node: peer.node_id,
        peer_team: peer.team_id,
        hop: message.hop,
      };

      // 6. 落点由 peer 配置决定（DECISION-036 §3.1/§3.3）；报文不得指定任意本机 Team。
      const localTeamId = peer.localTeamId ?? peer.team_id;
      if (message.to.team_id !== localTeamId) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_not_allowed',
          ...peerDetail,
        });
        return errorJson(
          'federation_not_allowed',
          'Message target does not match the configured peer',
          403,
          extra,
        );
      }

      // 7. hop 上界与自指环（防御性；v1 无自动中继）。
      if (message.hop > federation.maxHops) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_hop_exceeded',
          ...peerDetail,
        });
        return errorJson(
          'federation_hop_exceeded',
          `hop exceeds maxHops (${federation.maxHops})`,
          409,
          extra,
        );
      }
      if (message.from.node_id === federation.nodeId) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_cycle_detected',
          ...peerDetail,
        });
        return errorJson(
          'federation_cycle_detected',
          'Message claims to originate from this node',
          409,
          extra,
        );
      }

      // 8. 目标 Team：v1 固定 default tenant；未注入 / 不存在 → 404。
      const teams = options.teams;
      if (!teams || teams.tenantId !== FEDERATION_TENANT) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'team_not_found',
          ...peerDetail,
        });
        return errorJson('team_not_found', 'Team not found', 404, extra);
      }
      let team: TeamDetailLike | undefined;
      try {
        team = await teams.get(localTeamId);
      } catch {
        team = undefined;
      }
      if (!team) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'team_not_found',
          ...peerDetail,
        });
        return errorJson('team_not_found', 'Team not found', 404, extra);
      }

      // 9. 去重：重复不写日志，返回首次本地 id / cursor。
      const key = dedupeKey(message);
      const seen = dedupe.get(key);
      if (seen) {
        return json(
          {
            protocol: FEDERATION_PROTOCOL,
            ok: true,
            message_id: seen.message_id,
            deduplicated: true,
            cursor: seen.cursor,
          },
          200,
          extra,
        );
      }

      // 10. 唯一写入点：Team 日志。失败不返回 202，不重试。
      let written: { message_id: string };
      try {
        written = await teams.post({
          team_id: localTeamId,
          content: message.content,
          from: `federation:${message.from.node_id}:${message.from.team_id}`,
          mentions: [],
          conversation_id: message.conversation_id,
        });
      } catch (error) {
        const code = errorCode(error);
        if (code === 'not_found' || code === 'team_not_found') {
          publish('federation.rejected', {
            direction: 'in',
            code: 'team_not_found',
            ...peerDetail,
          });
          return errorJson('team_not_found', 'Team not found', 404, extra);
        }
        publish('federation.rejected', {
          direction: 'in',
          code: 'team_log_write_failed',
          ...peerDetail,
        });
        return errorJson('team_log_write_failed', 'Failed to write the local team log', 500, extra);
      }

      const localCursor = String(++cursor);
      dedupe.set(key, { message_id: written.message_id, cursor: localCursor });
      publish('federation.received', {
        message_id: message.message_id,
        local_message_id: written.message_id,
        from_node: message.from.node_id,
        from_team: message.from.team_id,
        team_id: localTeamId,
        hop: message.hop,
      });
      return json(
        {
          protocol: FEDERATION_PROTOCOL,
          ok: true,
          message_id: written.message_id,
          cursor: localCursor,
        },
        202,
        extra,
      );
    },
  };
}
