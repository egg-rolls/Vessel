/**
 * 交互方法：permission.respond / ask.respond / interactions.list。
 *
 * @module @vessel-agent/serve
 */

import type { HubTeamScopeLike } from '../../hub-control.js';
import type {
  PendingAsk,
  PendingPermission,
  PermissionRespondResult,
  PermissionScope,
} from '../../interactions-registry.js';
import type {
  StoredInteraction,
  StoredInteractionAnswer,
  StoredInteractionStatus,
} from '../../interactions-store.js';
import {
  isTeamScopedPrincipal,
  RpcError,
  type RpcMethodContext,
  type RpcMethodDefinition,
} from '../../rpc.js';
import { stringParam } from './common.js';

/**
 * `interactions.list` 的数据源（gateway 传入 engine 的实时表）。
 *
 * `interactionRecords` 在引擎启动时已从 `InteractionsStore` 载入磁盘记录
 * （无 run 的 `pending` 转 `orphaned`），进程内事件随后覆盖同 requestId，
 * 因此该表本身就是“内存 ∪ 磁盘”的并集，按 requestId 唯一。
 */
export interface InteractionSources {
  readonly interactionRecords: ReadonlyMap<string, StoredInteraction>;
  /** 内存 pending 权限索引；记录缺失时兜底补齐（正常情况下记录必然存在）。 */
  readonly pendingPermissions: ReadonlyMap<string, PendingPermission>;
  /** legacy pending ask 读取面；0.19 S4 起运行时由 interactionRecords 派生。 */
  readonly pendingAsks: ReadonlyMap<string, PendingAsk>;
}

export interface InteractionMethodsDeps {
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    scope?: PermissionScope,
    actor?: {
      answered_by: 'human' | 'policy';
      answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
    },
  ): PermissionRespondResult;
  respondAsk(
    requestId: string,
    answers: unknown[],
    actor?: {
      answered_by: 'human' | 'policy';
      answered_via?: 'tui' | 'rpc' | 'cli' | 'policy';
    },
  ): unknown;
  interactions: InteractionSources;
  /**
   * S5：control token 的 session → team 归属映射。
   * 缺失或无法判定时，team-scoped principal 一律 fail-closed。
   */
  teamScope?: HubTeamScopeLike;
  /**
   * headless 挂起的 ask（`record.suspended`）被人类回答后，尝试续跑那个 run。
   *
   * 只在「`pending` → `answered` 这一次迁移」上调用一次（重复应答不触发）；
   * 返回 `true` = 续跑已受理（`runs.resume` 的 202 语义），`false` = 跳过。
   * 实现方必须自吞全部错误：续跑失败只能退化为「只记录答案」，不得让应答 RPC 失败。
   * 缺失 = 不续跑（离线 attention / 无 durable 的装配）。
   */
  resumeSuspendedAsk?: (record: StoredInteraction) => boolean | Promise<boolean>;
  /**
   * 0.52：async ask 的答案投放（作为 user 消息进成员 inbox + 起一次新 run）。
   *
   * 与 `resumeSuspendedAsk` 互斥：async 的提问 run 早已正常结束，没有可续跑的
   * checkpoint，答案只能开新 run。只在「`pending` → `answered` 这一次迁移」上调用，
   * 重复应答不触发；实现方必须自吞全部错误（答案已落定，投放失败只退化为只记录答案）。
   * 缺失 = 不投放（离线 attention / 没有 live runtime 的装配）。
   */
  deliverAsyncAskAnswer?: (record: StoredInteraction) => boolean | Promise<boolean>;
}

/** `interactions.list` 的单条结果（Web 端消费契约）。 */
export interface ListedInteraction {
  kind: 'permission' | 'ask';
  request_id: string;
  run_id: string;
  agent_id?: string;
  team_id?: string;
  session_id?: string;
  /** 成员 bridge 请求的父会话（additive，缺失时不输出该 key）。 */
  parent_session_id?: string;
  tool_call_id?: string;
  tool?: string;
  input?: unknown;
  questions?: unknown;
  created_at: number;
  status: StoredInteractionStatus;
  /**
   * 0.52：ask 的语义（`async` = 投放到待批页后立即返回成功，答案稍后起新 run）。
   * 缺省键 = sync（阻塞型），旧客户端不受影响。
   */
  mode?: 'sync' | 'async';
  answer?: StoredInteractionAnswer;
}

const PERMISSION_SCOPES: ReadonlySet<PermissionScope> = new Set(['once', 'session', 'always']);
const INTERACTION_STATUSES: ReadonlySet<StoredInteractionStatus> = new Set([
  'pending',
  'answered',
  'orphaned',
]);
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

const interactionItemSchema = {
  type: 'object',
  required: ['kind', 'request_id', 'run_id', 'created_at', 'status'],
  properties: {
    kind: { type: 'string', enum: ['permission', 'ask'] },
    request_id: { type: 'string' },
    run_id: { type: 'string' },
    agent_id: { type: 'string' },
    team_id: { type: 'string' },
    session_id: { type: 'string' },
    parent_session_id: { type: 'string' },
    tool_call_id: { type: 'string' },
    tool: { type: 'string' },
    // input / questions 是模型给出的任意 JSON；校验器不支持 arbitrary，留空即可。
    input: {},
    questions: {},
    created_at: { type: 'number' },
    status: { type: 'string', enum: ['pending', 'answered', 'orphaned'] },
    mode: { type: 'string', enum: ['sync', 'async'] },
    answer: {
      type: 'object',
      required: ['answered_at'],
      properties: {
        decision: { type: 'string', enum: ['allow', 'deny'] },
        scope: { type: 'string', enum: ['once', 'session', 'always'] },
        answers: { type: 'array' },
        answered_at: { type: 'number' },
        answered_by: { type: 'string', enum: ['human', 'policy'] },
        answered_via: { type: 'string', enum: ['tui', 'rpc', 'cli', 'policy'] },
        policy: { type: 'string', enum: ['deny_after', 'auto_allow'] },
        latency_ms: { type: 'number' },
      },
    },
  },
};

/**
 * 合并内存与磁盘记录。
 *
 * 优先级：`interactionRecords`（引擎并集，进程内状态最新）> `pendingPermissions`
 * > `pendingAsks`。同一 requestId 只保留第一条。
 */
function collectInteractions(sources: InteractionSources): ListedInteraction[] {
  const merged = new Map<string, ListedInteraction>();
  for (const record of sources.interactionRecords.values()) {
    const kind = record.kind ?? 'permission';
    merged.set(record.requestId, {
      kind,
      request_id: record.requestId,
      run_id: record.run_id,
      ...(record.agent_id !== undefined ? { agent_id: record.agent_id } : {}),
      ...(record.team_id !== undefined ? { team_id: record.team_id } : {}),
      ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
      ...(record.parent_session_id !== undefined
        ? { parent_session_id: record.parent_session_id }
        : {}),
      ...(record.tool_call_id !== undefined ? { tool_call_id: record.tool_call_id } : {}),
      tool: record.tool,
      ...(kind === 'ask' ? { questions: record.input } : { input: record.input }),
      created_at: record.created_at,
      status: record.status,
      ...(record.mode === 'async' ? { mode: 'async' as const } : {}),
      ...(record.answer !== undefined ? { answer: record.answer } : {}),
    });
  }
  for (const [requestId, pending] of sources.pendingPermissions) {
    if (merged.has(requestId)) continue;
    merged.set(requestId, {
      kind: 'permission',
      request_id: requestId,
      run_id: pending.run_id,
      ...(pending.session_id !== undefined ? { session_id: pending.session_id } : {}),
      ...(pending.parent_session_id !== undefined
        ? { parent_session_id: pending.parent_session_id }
        : {}),
      ...(pending.tool_call_id !== undefined ? { tool_call_id: pending.tool_call_id } : {}),
      tool: pending.tool,
      input: pending.input,
      created_at: pending.ts,
      status: 'pending',
    });
  }
  for (const [requestId, ask] of sources.pendingAsks) {
    if (merged.has(requestId)) continue;
    merged.set(requestId, {
      kind: 'ask',
      request_id: requestId,
      run_id: ask.run_id,
      ...(ask.session_id !== undefined ? { session_id: ask.session_id } : {}),
      ...(ask.parent_session_id !== undefined ? { parent_session_id: ask.parent_session_id } : {}),
      ...(ask.questions !== undefined ? { questions: ask.questions } : {}),
      created_at: ask.ts,
      status: 'pending',
    });
  }
  return [...merged.values()];
}

type ListOrder = 'oldest' | 'newest';

interface ListCursor {
  order: ListOrder;
  createdAt: number;
  requestId: string;
}

function parseListOrder(value: unknown): ListOrder {
  if (value === undefined) return 'newest';
  if (value === 'oldest' || value === 'newest') return value;
  throw new RpcError('invalid_params', "order must be 'oldest' or 'newest'");
}

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(
    JSON.stringify({ o: cursor.order, t: cursor.createdAt, r: cursor.requestId }),
    'utf8',
  ).toString('base64url');
}

function parseListCursor(value: unknown): ListCursor {
  if (typeof value !== 'string') throw new RpcError('invalid_params', 'invalid cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new RpcError('invalid_params', 'invalid cursor');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RpcError('invalid_params', 'invalid cursor');
  }
  const { o, t, r } = parsed as Record<string, unknown>;
  if (
    (o !== 'oldest' && o !== 'newest') ||
    typeof t !== 'number' ||
    !Number.isFinite(t) ||
    typeof r !== 'string'
  ) {
    throw new RpcError('invalid_params', 'invalid cursor');
  }
  return { order: o, createdAt: t, requestId: r };
}

function compareListItems(order: ListOrder, a: ListedInteraction, b: ListedInteraction): number {
  const byRequestId = a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0;
  if (a.created_at === b.created_at) return byRequestId;
  return order === 'newest' ? b.created_at - a.created_at : a.created_at - b.created_at;
}

function parseListLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIST_LIMIT
  ) {
    throw new RpcError(
      'invalid_params',
      `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

/** 记录是否是「仍在等人类」的 ask（sync 或 async）。 */
function isPendingAsk(record: StoredInteraction): boolean {
  return record.status === 'pending' && (record.kind ?? 'permission') === 'ask';
}

/** 记录是否是「headless 挂起、且仍在等人类」的 ask。 */
function isSuspendedPendingAsk(record: StoredInteraction): boolean {
  return (
    record.status === 'pending' &&
    record.suspended === true &&
    (record.kind ?? 'permission') === 'ask'
  );
}

/**
 * 应答结果是否是「本次真的写下答案」（而不是幂等重放）。
 * 重复应答（`duplicate`）与冲突（抛错）都不算，因此不会触发第二次续跑。
 */
function isFreshAnswer(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return record.ok === true && record.duplicate !== true;
}

export function createInteractionMethods(deps: InteractionMethodsDeps): RpcMethodDefinition[] {
  const {
    respondPermission,
    respondAsk,
    interactions,
    teamScope,
    resumeSuspendedAsk,
    deliverAsyncAskAnswer,
  } = deps;

  /** 请求所属 session；记录不存在或没有 session 时返回 undefined。 */
  function sessionForRequest(requestId: string): string | undefined {
    const record = interactions.interactionRecords.get(requestId);
    if (record !== undefined) return record.session_id;
    const pending = interactions.pendingPermissions.get(requestId);
    if (pending !== undefined) return pending.session_id;
    const ask = interactions.pendingAsks.get(requestId);
    if (ask !== undefined) return ask.session_id;
    return undefined;
  }

  /** 请求的 team 归属：记录自描述优先，缺失才回退 session 映射。 */
  function teamIdForRequest(requestId: string): string | undefined {
    const record = interactions.interactionRecords.get(requestId);
    if (record?.team_id !== undefined) return record.team_id;
    const sessionId = sessionForRequest(requestId);
    return sessionId === undefined ? undefined : teamScope?.teamForSession(sessionId);
  }

  /** 单个 item 的 team 归属：team_id 优先，缺失回退 session 映射。 */
  function itemTeamId(item: ListedInteraction): string | undefined {
    if (item.team_id !== undefined) return item.team_id;
    return item.session_id === undefined ? undefined : teamScope?.teamForSession(item.session_id);
  }

  /**
   * team-scoped control token 的请求归属检查。
   * 找不到记录 / 无 team 归属 / 不属于该 team 一律 `forbidden`，
   * 不区分 `not_found`，避免泄漏请求存在性。
   */
  function assertTeamAccess(requestId: string, principal: RpcMethodContext['principal']): void {
    if (!isTeamScopedPrincipal(principal)) return;
    if (teamIdForRequest(requestId) !== principal.team_id) {
      throw new RpcError('forbidden', 'Request is not accessible to this team');
    }
  }

  return [
    {
      name: 'permission.respond',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['decision'],
        properties: {
          request_id: { type: 'string', minLength: 1 },
          // DECISION-024 §2.2：兼容 camelCase。
          requestId: { type: 'string', minLength: 1 },
          decision: { type: 'string', enum: ['allow', 'deny'] },
          remember: { type: 'boolean' },
          scope: { type: 'string', enum: ['once', 'session', 'always'] },
          answered_via: { type: 'string', enum: ['rpc', 'cli'] },
        },
      },
      result_schema: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          decision: { type: 'string', enum: ['allow', 'deny'] },
          scope: { type: 'string', enum: ['once', 'session', 'always'] },
          duplicate: { type: 'boolean' },
          answered_by: { type: 'string', enum: ['human', 'policy'] },
          answered_via: { type: 'string', enum: ['tui', 'rpc', 'cli', 'policy'] },
          latency_ms: { type: 'number' },
          team_id: { type: 'string' },
        },
      },
      handler: (params, ctx) => {
        const rawRequestId = params.request_id ?? params.requestId;
        if (typeof rawRequestId !== 'string' || rawRequestId.length === 0) {
          throw new RpcError('invalid_params', 'request_id is required');
        }
        const decision = params.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          throw new RpcError('invalid_params', "decision must be 'allow' or 'deny'");
        }
        const rawScope = params.scope;
        if (rawScope !== undefined && !PERMISSION_SCOPES.has(rawScope as PermissionScope)) {
          throw new RpcError('invalid_params', "scope must be 'once', 'session' or 'always'");
        }
        assertTeamAccess(rawRequestId, ctx.principal);
        return respondPermission(
          rawRequestId,
          decision,
          params.remember === true,
          rawScope as PermissionScope | undefined,
          {
            answered_by: 'human',
            answered_via: params.answered_via === 'cli' ? 'cli' : 'rpc',
          },
        );
      },
    },
    {
      name: 'ask.respond',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['request_id', 'answers'],
        properties: {
          request_id: { type: 'string', minLength: 1 },
          answers: { type: 'array' },
          answered_via: { type: 'string', enum: ['rpc', 'cli'] },
        },
      },
      result_schema: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          duplicate: { type: 'boolean' },
          answered_by: { type: 'string', enum: ['human', 'policy'] },
          answered_via: { type: 'string', enum: ['tui', 'rpc', 'cli', 'policy'] },
          latency_ms: { type: 'number' },
          team_id: { type: 'string' },
          // 只对 headless 挂起的 ask 出现：这个答案是否让那个 run 重新跑起来。
          // 缺省键 = 普通阻塞型 ask（应答者就在原地等，不存在续跑概念）。
          resumed: { type: 'boolean' },
          // 只对 async ask 出现：答案是否已作为 user 消息投给该成员并起了一次新 run。
          // false = 只记录了答案（没有 live runtime / 成员已关闭）。
          delivered: { type: 'boolean' },
        },
      },
      handler: async (params, ctx) => {
        const answers = params.answers;
        if (!Array.isArray(answers)) {
          throw new RpcError('invalid_params', 'answers must be an array');
        }
        const requestId = stringParam(params, 'request_id');
        assertTeamAccess(requestId, ctx.principal);
        // 状态迁移前的记录：只有「suspended pending」才可能在应答后需要续跑。
        const before = interactions.interactionRecords.get(requestId);
        const result = respondAsk(requestId, answers, {
          answered_by: 'human',
          answered_via: params.answered_via === 'cli' ? 'cli' : 'rpc',
        });
        if (
          deliverAsyncAskAnswer !== undefined &&
          before !== undefined &&
          isPendingAsk(before) &&
          before.mode === 'async' &&
          isFreshAnswer(result)
        ) {
          let delivered = false;
          try {
            delivered = (await deliverAsyncAskAnswer({ ...before, status: 'answered' })) === true;
          } catch {
            delivered = false;
          }
          return typeof result === 'object' && result !== null
            ? { ...(result as Record<string, unknown>), delivered }
            : { ok: true, delivered };
        }
        if (
          resumeSuspendedAsk === undefined ||
          before === undefined ||
          !isSuspendedPendingAsk(before) ||
          !isFreshAnswer(result)
        ) {
          return result;
        }
        let resumed = false;
        try {
          // 先把答案落定（respondAsk 已同步落记录），再尝试续跑：
          // 续跑失败只退化为「只记录答案」，应答本身仍然成功。
          resumed = (await resumeSuspendedAsk(before)) === true;
        } catch {
          resumed = false;
        }
        return typeof result === 'object' && result !== null
          ? { ...(result as Record<string, unknown>), resumed }
          : { ok: true, resumed };
      },
    },
    {
      name: 'interactions.list',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          run_id: { type: 'string' },
          team_id: { type: 'string' },
          agent_id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'answered', 'orphaned'] },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
          order: { type: 'string', enum: ['oldest', 'newest'] },
          cursor: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['interactions'],
        properties: {
          interactions: { type: 'array', items: interactionItemSchema },
          total: { type: 'integer' },
          next_cursor: { type: 'string' },
        },
      },
      handler: (params, ctx) => {
        const rawStatus = params.status;
        if (
          rawStatus !== undefined &&
          !INTERACTION_STATUSES.has(rawStatus as StoredInteractionStatus)
        ) {
          throw new RpcError(
            'invalid_params',
            "status must be 'pending', 'answered' or 'orphaned'",
          );
        }
        const sessionId =
          typeof params.session_id === 'string' && params.session_id.length > 0
            ? params.session_id
            : undefined;
        const runId =
          typeof params.run_id === 'string' && params.run_id.length > 0 ? params.run_id : undefined;
        const agentId =
          typeof params.agent_id === 'string' && params.agent_id.length > 0
            ? params.agent_id
            : undefined;
        const limit = parseListLimit(params.limit);
        const order = parseListOrder(params.order);
        const cursor = params.cursor === undefined ? undefined : parseListCursor(params.cursor);
        // 换序后沿用旧 cursor 会静默错页；直接拒绝。
        if (cursor !== undefined && cursor.order !== order) {
          throw new RpcError('invalid_params', 'invalid cursor');
        }
        let items = collectInteractions(interactions).filter(
          (item) =>
            (rawStatus === undefined || item.status === rawStatus) &&
            (sessionId === undefined || item.session_id === sessionId) &&
            (runId === undefined || item.run_id === runId),
        );
        // team-scoped token 强制自己的 team；普通 token 按参数过滤。
        // 归属判定 team_id 优先，缺失才回退 session 映射（无法判定 → 过滤掉）。
        const requestedTeam =
          typeof params.team_id === 'string' && params.team_id.length > 0
            ? params.team_id
            : undefined;
        const teamFilter = isTeamScopedPrincipal(ctx.principal)
          ? ctx.principal.team_id
          : requestedTeam;
        if (teamFilter !== undefined) {
          items = items.filter((item) => itemTeamId(item) === teamFilter);
        }
        if (agentId !== undefined) {
          items = items.filter((item) => item.agent_id === agentId);
        }
        // 同时间戳一律按 request_id 升序，保证翻页边界稳定。
        items.sort((a, b) => compareListItems(order, a, b));
        // total 是过滤后的总条数，不受 limit / cursor 影响。
        const total = items.length;
        if (cursor !== undefined) {
          items = items.filter((item) => {
            const afterCursor =
              order === 'newest'
                ? item.created_at < cursor.createdAt
                : item.created_at > cursor.createdAt;
            return (
              afterCursor ||
              (item.created_at === cursor.createdAt && item.request_id > cursor.requestId)
            );
          });
        }
        const page = items.slice(0, limit);
        const last = page[page.length - 1];
        return {
          interactions: page,
          total,
          ...(items.length > limit && last !== undefined
            ? {
                next_cursor: encodeListCursor({
                  order,
                  createdAt: last.created_at,
                  requestId: last.request_id,
                }),
              }
            : {}),
        };
      },
    },
  ];
}
