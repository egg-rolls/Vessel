/**
 * S8 federation 入站路由（node ↔ node，DECISION-037）。
 *
 * - 独立 peer bearer：gateway 用户 token 与 peer token 命名空间不交叉；
 * - 严格解析 wire envelope：`principal` 受 `[A-Za-z0-9_-]{1,64}` 约束；未知 / 缺失
 *   字段一律 `federation_invalid`，缺 `to.principal` 单独返回 `federation_principal_required`；
 * - 单点投递：`owner` 只写日志；`accept:'log'` 只写日志；`accept:'principal'` 在目标 Team
 *   的 present 非 private 成员中按名字精确匹配唯一一人（最多 1 个 run）；
 * - **没有广播 / `accept:'members'`**；非法 accept 值按 `'principal'` fail-safe，绝不 fan-out；
 * - 每 peer 入站限流（60s 固定窗口，读 body 之前判定；超限 429、零写入）；
 * - 拒绝无副作用：不写日志、不 dispatch、只发一次 `federation.rejected`。
 *
 * 路由必须在 gateway `principalForRequest` 之前处理（同 hub 路由位置）。
 *
 * @module @vessel-agent/serve/federation
 */

import { timingSafeEqual } from 'node:crypto';
import type {
  TeamControlLike,
  TeamDetailLike,
  TeamMemberLike,
  TeamPostResultLike,
  TeamSummaryLike,
} from './team-control.js';

export const FEDERATION_PROTOCOL = 'vessel.federation/1';
export const FEDERATION_MESSAGES_PATH = '/v1/federation/messages';
/** 0.21：opt-in 只读成员目录（DECISION-037 §7.2）。 */
export const FEDERATION_TEAM_INFO_PATH = '/v1/federation/team-info';

/** team-info 缺省返回的成员条数。 */
export const FEDERATION_DEFAULT_MEMBERS_LIMIT = 20;
/** team-info `members_limit` 上界。 */
export const FEDERATION_MEMBERS_LIMIT_MAX = 100;

/** 接收侧固定 tenant（v1 不做多 tenant federation）。 */
const FEDERATION_TENANT = 'default';

/** 去重容量：进程内 LRU，不声称跨重启 exactly-once。 */
const DEDUPE_LIMIT = 1024;

/** 报文信封上限；正文本身另有 1..65536 bytes 限制。 */
const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_CONTENT_BYTES = 65_536;

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PRINCIPAL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 每 peer 入站速率：缺省每分钟 60；`0` = 不限制。 */
export const FEDERATION_DEFAULT_RATE_LIMIT = 60;

/** 固定窗口长度；不做跨重启持久化。 */
const RATE_WINDOW_MS = 60_000;

/** 入站落点解析结果（`federation.received` payload）。 */
export type FederationResolution = 'owner' | 'principal' | 'log';

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
const IDENTITY_KEYS = new Set(['node_id', 'team_id', 'principal']);

export type FederationDirection = 'in' | 'out' | 'both';

/** 已解析 token 的入站 peer（camelCase 与 config loader 一致）。 */
export interface FederationGatewayPeer {
  nodeId: string;
  teamId: string;
  direction: FederationDirection;
  /** 入站落点（本机 Team id）；缺省 = `teamId`。 */
  localTeamId?: string;
  /** 0.21：允许该 peer 查询本机 Team 目录；缺省 false（404）。 */
  allowDirectory?: boolean;
  /** 内存 token：只用于定长比较，不序列化 / 不打印。 */
  token: string;
}

/** gateway 注入面；结构对齐 asm 的 `FederationRuntimeOptions`。 */
export interface FederationGatewayOptions {
  enabled: boolean;
  nodeId: string;
  maxHops: number;
  /** 每 peer 入站速率上限（60s 固定窗口）；缺省 60，合法范围 1..600。 */
  rateLimitPerMinute?: number;
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

interface NodeTeamIdentity {
  node_id: string;
  team_id: string;
}

interface EnvelopeIdentity extends NodeTeamIdentity {
  principal: string;
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

/** 解析失败的错误码：缺 `to.principal` 与其它非法形状区分开（DECISION-037 §10）。 */
type ParseFailureCode = 'federation_invalid' | 'federation_principal_required';

type ParseResult = { ok: true; message: FederationMessage } | { ok: false; code: ParseFailureCode };

interface RateWindow {
  windowStart: number;
  count: number;
}

/** team-info 的成员条目：只有名字与活跃度（无 agent_id / workspace / policy）。 */
export interface FederationTeamInfoMember {
  name: string;
  presence: 'live' | 'gone';
  last_seen?: number;
}

/** team-info 响应（DECISION-037 §7.2）。 */
export interface FederationTeamInfo {
  protocol: typeof FEDERATION_PROTOCOL;
  team_id: string;
  name: string;
  description?: string;
  default_principal?: string;
  member_count: number;
  online_count: number;
  members: FederationTeamInfoMember[];
}

interface TeamInfoRequest {
  team_id: string;
  members_limit?: number;
}

type TeamInfoParseResult = { ok: true; request: TeamInfoRequest } | { ok: false };

const TEAM_INFO_KEYS = new Set(['protocol', 'team_id', 'members_limit']);

/** 严格解析 team-info 请求：未知 / 缺失 / 类型错误都按 `federation_invalid`。 */
function parseTeamInfoRequest(record: Record<string, unknown>): TeamInfoParseResult {
  for (const key of Object.keys(record)) if (!TEAM_INFO_KEYS.has(key)) return { ok: false };
  if (record.protocol !== FEDERATION_PROTOCOL) return { ok: false };
  if (typeof record.team_id !== 'string' || !TEAM_ID_RE.test(record.team_id)) {
    return { ok: false };
  }
  const request: TeamInfoRequest = { team_id: record.team_id };
  if (hasOwn(record, 'members_limit')) {
    const limit = record.members_limit;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > FEDERATION_MEMBERS_LIMIT_MAX
    ) {
      return { ok: false };
    }
    request.members_limit = limit;
  }
  return { ok: true, request };
}

type NamedTeamMember = TeamMemberLike & { name: string };

/** live 优先 → last_seen 降序（缺失最后）→ name 字典序。 */
function compareDirectoryMembers(a: NamedTeamMember, b: NamedTeamMember): number {
  const liveDelta = Number(b.presence === 'live') - Number(a.presence === 'live');
  if (liveDelta !== 0) return liveDelta;
  const aSeen =
    typeof a.last_seen === 'number' && Number.isFinite(a.last_seen) ? a.last_seen : undefined;
  const bSeen =
    typeof b.last_seen === 'number' && Number.isFinite(b.last_seen) ? b.last_seen : undefined;
  if (aSeen !== undefined && bSeen !== undefined && aSeen !== bSeen) return bSeen - aSeen;
  if (aSeen === undefined && bSeen !== undefined) return 1;
  if (aSeen !== undefined && bSeen === undefined) return -1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 只统计 present、非 private 且有名字的成员；计数与列表用同一集合，
 * 避免通过 `member_count` 泄漏 private 成员存在性。`members_limit` 只截断列表。
 *
 * `members` 必须是**完整** roster（不能用 `get` 的窗口结果），否则计数会少报。
 */
function buildTeamInfo(
  team: TeamSummaryLike,
  roster: readonly TeamMemberLike[],
  teamId: string,
  limit: number,
): FederationTeamInfo {
  const eligible = roster.filter(
    (member): member is NamedTeamMember =>
      member.membership === 'present' &&
      member.visibility !== 'private' &&
      typeof member.name === 'string' &&
      member.name !== '',
  );
  const names = new Set(eligible.map((member) => member.name));
  const members: FederationTeamInfoMember[] = [...eligible]
    .sort(compareDirectoryMembers)
    .slice(0, limit)
    .map((member) => {
      const entry: FederationTeamInfoMember = { name: member.name, presence: member.presence };
      if (typeof member.last_seen === 'number' && Number.isFinite(member.last_seen)) {
        entry.last_seen = member.last_seen;
      }
      return entry;
    });

  const info: FederationTeamInfo = {
    protocol: FEDERATION_PROTOCOL,
    team_id: teamId,
    name: team.name,
    member_count: eligible.length,
    online_count: eligible.filter((member) => member.presence === 'live').length,
    members,
  };
  const description = team.description;
  if (typeof description === 'string' && description !== '') info.description = description;
  const defaultPrincipal = team.default_principal;
  if (
    defaultPrincipal === 'owner' ||
    (typeof defaultPrincipal === 'string' && names.has(defaultPrincipal))
  ) {
    info.default_principal = defaultPrincipal;
  }
  return info;
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

/** 只读取 `(node_id, team_id)`；用于 peer 身份比对（principal 不参与）。 */
function nodeTeamOf(value: unknown): NodeTeamIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.node_id !== 'string' || typeof value.team_id !== 'string') return undefined;
  return { node_id: value.node_id, team_id: value.team_id };
}

/** 严格键集合（未知 / 缺失键都算非法）。 */
function identityShapeValid(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length !== IDENTITY_KEYS.size) return false;
  for (const key of Object.keys(value)) if (!IDENTITY_KEYS.has(key)) return false;
  return true;
}

/**
 * 严格解析 envelope；任何未知 / 缺失字段、错误类型、非法 pattern 都失败。
 * 缺 `to.principal` 单独返回 `federation_principal_required`（旧 S7 报文缺 `from.principal`
 * 仍按 `federation_invalid`）。
 *
 * `to.node_id` 的本机比对由调用方在解析之后执行（DECISION-037 §5 顺序）。
 */
function parseEnvelope(record: Record<string, unknown>): ParseResult {
  const invalid: ParseResult = { ok: false, code: 'federation_invalid' };
  for (const key of Object.keys(record)) if (!TOP_LEVEL_KEYS.has(key)) return invalid;

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
  for (const key of required) if (!hasOwn(record, key)) return invalid;

  if (record.protocol !== FEDERATION_PROTOCOL) return invalid;
  if (typeof record.message_id !== 'string' || !MESSAGE_ID_RE.test(record.message_id)) {
    return invalid;
  }
  if (typeof record.conversation_id !== 'string' || !MESSAGE_ID_RE.test(record.conversation_id)) {
    return invalid;
  }

  // from：三段都必须存在且合法（缺 principal 是 federation_invalid）。
  if (!identityShapeValid(record.from)) return invalid;
  const from = record.from;
  if (
    typeof from.node_id !== 'string' ||
    typeof from.team_id !== 'string' ||
    typeof from.principal !== 'string' ||
    !NODE_ID_RE.test(from.node_id) ||
    !TEAM_ID_RE.test(from.team_id) ||
    !PRINCIPAL_RE.test(from.principal)
  ) {
    return invalid;
  }

  // to：缺 principal 有专用错误码；其余形状问题仍是 invalid。
  if (!isRecord(record.to)) return invalid;
  const to = record.to;
  for (const key of Object.keys(to)) if (!IDENTITY_KEYS.has(key)) return invalid;
  if (typeof to.node_id !== 'string' || typeof to.team_id !== 'string') return invalid;
  if (!NODE_ID_RE.test(to.node_id) || !TEAM_ID_RE.test(to.team_id)) return invalid;
  if (!hasOwn(to, 'principal')) return { ok: false, code: 'federation_principal_required' };
  if (typeof to.principal !== 'string' || !PRINCIPAL_RE.test(to.principal)) return invalid;

  if (typeof record.content !== 'string') return invalid;
  const contentBytes = Buffer.byteLength(record.content, 'utf8');
  if (contentBytes < 1 || contentBytes > MAX_CONTENT_BYTES) return invalid;

  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return invalid;
  if (typeof record.hop !== 'number' || !Number.isInteger(record.hop) || record.hop < 1) {
    return invalid;
  }

  if (hasOwn(record, 'request_id')) {
    const requestId = record.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) {
      return invalid;
    }
  }

  return {
    ok: true,
    message: {
      message_id: record.message_id,
      conversation_id: record.conversation_id,
      from: {
        node_id: from.node_id,
        team_id: from.team_id,
        principal: from.principal,
      },
      to: {
        node_id: to.node_id,
        team_id: to.team_id,
        principal: to.principal,
      },
      content: record.content,
      ts: record.ts,
      hop: record.hop,
    },
  };
}

/** 人类可读的回信地址：`<principal>@<node_id>:<team_id>`。 */
function addressOf(identity: EnvelopeIdentity): string {
  return `${identity.principal}@${identity.node_id}:${identity.team_id}`;
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

type FederationAcceptMode = 'principal' | 'log';

type AcceptModeResult =
  | { ok: true; mode: FederationAcceptMode }
  | { ok: false; code: 'members_not_supported' };

/**
 * 接收侧同意策略（S8）：只接受 `'principal' | 'log'`，缺省 `'principal'`。
 * 手改 team.json 的 `'members'` 必须明确失败（DECISION-037 §5.1），
 * 不得 salvage 成 principal 后静默继续；配置层另由 validator 报错。
 */
function acceptModeOf(team: TeamDetailLike): AcceptModeResult {
  const policy = team.team.policy;
  if (!isRecord(policy)) return { ok: true, mode: 'principal' };
  const federation = policy.federation;
  if (!isRecord(federation)) return { ok: true, mode: 'principal' };
  if (federation.accept === 'members') return { ok: false, code: 'members_not_supported' };
  return { ok: true, mode: federation.accept === 'log' ? 'log' : 'principal' };
}

/**
 * 在 present 且非 private、未 closed 的成员中按 `name` 精确匹配唯一一人。
 * 无命中 / 重名一律 undefined（调用方返回 404，不泄漏存在性）。
 */
function resolvePrincipalMember(
  members: readonly TeamMemberLike[],
  principal: string,
): TeamMemberLike | undefined {
  const matches = members.filter(
    (member) =>
      member.membership === 'present' &&
      member.visibility !== 'private' &&
      member.state !== 'closed' &&
      member.name === principal,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** 每 peer 固定 60s 窗口；合法上限 1..600，非法值 fail closed（0 不再表示不限制）。 */
function consumeRateLimit(
  windows: Map<string, RateWindow>,
  peer: FederationGatewayPeer,
  limit: number,
  now: number,
): boolean {
  if (!Number.isInteger(limit) || limit < 1) return false;
  const key = `${peer.nodeId}\u0000${peer.teamId}`;
  const window = windows.get(key);
  if (!window || now - window.windowStart >= RATE_WINDOW_MS) {
    windows.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (window.count >= limit) return false;
  window.count += 1;
  return true;
}

/** 创建入站路由；gateway 在 `principalForRequest` 之前调用 `handle()`。 */
export function createFederationRoute(options: FederationRouteOptions): FederationRoute {
  const dedupe = new ReceivedCache(DEDUPE_LIMIT);
  const rateWindows = new Map<string, RateWindow>();
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
      const isMessages = url.pathname === FEDERATION_MESSAGES_PATH;
      const isTeamInfo = url.pathname === FEDERATION_TEAM_INFO_PATH;
      if (!isMessages && !isTeamInfo) return null;
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
          peer_node: peer.nodeId,
          peer_team: peer.teamId,
        });
        return errorJson(
          'federation_not_allowed',
          'Inbound delivery is not allowed for this peer',
          403,
          extra,
        );
      }

      // 3. team-info（0.21）：opt-in、只读；未开 allowDirectory 统一 404 不泄漏存在性。
      if (isTeamInfo) {
        if (peer.allowDirectory !== true) {
          return errorJson('not_found', `Not found: ${url.pathname}`, 404, extra);
        }
        const teamInfoLimit = federation.rateLimitPerMinute ?? FEDERATION_DEFAULT_RATE_LIMIT;
        if (!consumeRateLimit(rateWindows, peer, teamInfoLimit, Date.now())) {
          return errorJson('federation_rate_limited', 'Federation rate limit exceeded', 429, extra);
        }
        const teamInfoBody = await readBody(req);
        if (!teamInfoBody.ok || !isRecord(teamInfoBody.value)) {
          return errorJson(
            'federation_invalid',
            'Invalid federation team-info request',
            400,
            extra,
          );
        }
        const teamInfo = parseTeamInfoRequest(teamInfoBody.value);
        if (!teamInfo.ok) {
          return errorJson(
            'federation_invalid',
            'Invalid federation team-info request',
            400,
            extra,
          );
        }
        const localTeamId = peer.localTeamId ?? peer.teamId;
        if (teamInfo.request.team_id !== localTeamId) {
          return errorJson('federation_unknown_team', 'Team not found', 404, extra);
        }
        const teamInfoControl = options.teams;
        if (!teamInfoControl || teamInfoControl.tenantId !== FEDERATION_TENANT) {
          return errorJson('federation_unknown_team', 'Team not found', 404, extra);
        }
        let directoryTeam: TeamDetailLike | undefined;
        try {
          // 取元数据；窗口用最大值，完整计数另走 roster（见下）。
          directoryTeam = await teamInfoControl.get(localTeamId, {
            members_limit: FEDERATION_MEMBERS_LIMIT_MAX,
          });
        } catch {
          directoryTeam = undefined;
        }
        if (!directoryTeam) {
          return errorJson('federation_unknown_team', 'Team not found', 404, extra);
        }
        // 计数必须用完整 roster；读取失败时明确 500，不用窗口结果少报计数。
        let fullRoster: readonly TeamMemberLike[];
        try {
          fullRoster = await teamInfoControl.roster(localTeamId);
        } catch {
          return errorJson('internal', 'Failed to read the team roster', 500, extra);
        }
        return json(
          buildTeamInfo(
            directoryTeam.team,
            fullRoster,
            localTeamId,
            teamInfo.request.members_limit ?? FEDERATION_DEFAULT_MEMBERS_LIMIT,
          ),
          200,
          extra,
        );
      }

      // 4. 每 peer 限流：在认证 + 方向之后、读 body 之前判定；超限零写入。
      const rateLimit = federation.rateLimitPerMinute ?? FEDERATION_DEFAULT_RATE_LIMIT;
      if (!consumeRateLimit(rateWindows, peer, rateLimit, Date.now())) {
        return errorJson('federation_rate_limited', 'Federation rate limit exceeded', 429, extra);
      }

      // 4. body 读取失败仍按报文非法处理（不回显正文）。
      const body = await readBody(req);
      if (!body.ok || !isRecord(body.value)) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_invalid',
          peer_node: peer.nodeId,
          peer_team: peer.teamId,
        });
        return errorJson('federation_invalid', 'Invalid federation message', 400, extra);
      }

      // 5. `from` 身份必须等于该 peer（只比 node+team；principal 不参与）。
      const claimedFrom = nodeTeamOf(body.value.from);
      if (!claimedFrom) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_invalid',
          peer_node: peer.nodeId,
          peer_team: peer.teamId,
        });
        return errorJson('federation_invalid', 'Invalid federation message', 400, extra);
      }
      if (claimedFrom.node_id !== peer.nodeId || claimedFrom.team_id !== peer.teamId) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_not_allowed',
          peer_node: peer.nodeId,
          peer_team: peer.teamId,
        });
        return errorJson(
          'federation_not_allowed',
          'Message origin does not match the authenticated peer',
          403,
          extra,
        );
      }

      // 6. 严格解析（缺 to.principal 有专用错误码；from.principal 缺失仍是 invalid）。
      const parsed = parseEnvelope(body.value);
      if (!parsed.ok) {
        publish('federation.rejected', {
          direction: 'in',
          code: parsed.code,
          peer_node: peer.nodeId,
          peer_team: peer.teamId,
        });
        if (parsed.code === 'federation_principal_required') {
          return errorJson(
            'federation_principal_required',
            'Federation message requires to.principal',
            400,
            extra,
          );
        }
        return errorJson('federation_invalid', 'Invalid federation message', 400, extra);
      }
      const message = parsed.message;

      // 7. 报文必须投给本机（peer 身份之后、Team 落点之前）。
      if (message.to.node_id !== federation.nodeId) {
        publish('federation.rejected', {
          direction: 'in',
          code: 'federation_invalid',
          peer_node: peer.nodeId,
          peer_team: peer.teamId,
        });
        return errorJson('federation_invalid', 'Invalid federation message', 400, extra);
      }

      const peerDetail = {
        peer_node: peer.nodeId,
        peer_team: peer.teamId,
        hop: message.hop,
      };

      // 8. 落点由 peer 配置决定（DECISION-036 §3.1/§3.3）；报文不得指定任意本机 Team。
      const localTeamId = peer.localTeamId ?? peer.teamId;
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

      // 9. hop 上界与自指环（防御性；v1 无自动中继）。
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

      // 10. 目标 Team：v1 固定 default tenant；未注入 / 不存在 → 404。
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

      // 删除的全员 fan-out 语义必须显式失败；不静默改成 principal。
      const accept = acceptModeOf(team);
      if (!accept.ok) {
        publish('federation.rejected', {
          direction: 'in',
          code: accept.code,
          ...peerDetail,
        });
        return errorJson(
          'members_not_supported',
          'policy.federation.accept "members" was removed in 0.21; use "principal" or "log"',
          500,
          extra,
        );
      }

      // 12. 去重：重复不写日志，返回首次本地 id / cursor。
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

      // 11. 投递解析（DECISION-037 §5）：owner 优先 → accept:'log' → 单成员。
      const mode = accept.mode;
      let resolution: FederationResolution;
      let mentions: string[] = [];
      let to: string[] | undefined;
      if (message.to.principal === 'owner') {
        resolution = 'owner';
        to = ['owner'];
      } else if (mode === 'log') {
        resolution = 'log';
      } else {
        const member = resolvePrincipalMember(team.members, message.to.principal);
        if (!member) {
          // private / left / closed / 不存在 / 重名：统一 404，不写日志、不 dispatch。
          publish('federation.rejected', {
            direction: 'in',
            code: 'federation_unknown_principal',
            ...peerDetail,
          });
          return errorJson(
            'federation_unknown_principal',
            'Unknown federation principal',
            404,
            extra,
          );
        }
        resolution = 'principal';
        mentions = [member.agent_id];
      }

      // 13. 唯一写入点：Team 日志（principal 模式由 TeamService 先写 mention 再 dispatch）。
      // 失败不返回 202，不重试。
      const fromAddr = addressOf(message.from);
      const toAddr = addressOf(message.to);
      let written: TeamPostResultLike;
      try {
        written = await teams.post({
          team_id: localTeamId,
          content: message.content,
          from: `federation:${fromAddr}`,
          mentions,
          ...(to !== undefined ? { to } : {}),
          conversation_id: message.conversation_id,
          federation: {
            from_addr: fromAddr,
            to_addr: toAddr,
            conversation_id: message.conversation_id,
            hop: message.hop,
          },
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
        resolution,
        principal: message.to.principal,
        delivered: written.delivered.filter((entry) => entry.status === 'queued').length,
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
