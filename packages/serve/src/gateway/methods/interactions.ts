/**
 * 交互方法：permission.respond / ask.respond / interactions.list。
 *
 * @module @vessel-agent/serve
 */

import type { HubTeamScopeLike } from '../../hub-control.js';
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
import type {
  PendingAsk,
  PendingPermission,
  PermissionRespondResult,
  PermissionScope,
} from '../../run-engine.js';
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
  /** 内存 pending ask；ask 不持久化，重启后消失。 */
  readonly pendingAsks: ReadonlyMap<string, PendingAsk>;
}

export interface InteractionMethodsDeps {
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    tenantId?: string,
    scope?: PermissionScope,
  ): PermissionRespondResult;
  respondAsk(requestId: string, answers: unknown[], tenantId?: string): void;
  interactions: InteractionSources;
  /**
   * S5：control token 的 session → team 归属映射。
   * 缺失或无法判定时，team-scoped principal 一律 fail-closed。
   */
  teamScope?: HubTeamScopeLike;
}

/** `interactions.list` 的单条结果（Web 端消费契约）。 */
export interface ListedInteraction {
  kind: 'permission' | 'ask';
  request_id: string;
  run_id: string;
  session_id?: string;
  tool_call_id?: string;
  tool?: string;
  input?: unknown;
  questions?: unknown;
  created_at: number;
  status: StoredInteractionStatus;
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
    session_id: { type: 'string' },
    tool_call_id: { type: 'string' },
    tool: { type: 'string' },
    // input / questions 是模型给出的任意 JSON；校验器不支持 arbitrary，留空即可。
    input: {},
    questions: {},
    created_at: { type: 'number' },
    status: { type: 'string', enum: ['pending', 'answered', 'orphaned'] },
    answer: {
      type: 'object',
      required: ['decision', 'scope', 'answered_at'],
      properties: {
        decision: { type: 'string', enum: ['allow', 'deny'] },
        scope: { type: 'string', enum: ['once', 'session', 'always'] },
        answered_at: { type: 'number' },
      },
    },
  },
};

/**
 * 合并内存与磁盘记录后按 tenant 过滤。
 *
 * 优先级：`interactionRecords`（引擎并集，进程内状态最新）> `pendingPermissions`
 * > `pendingAsks`。同一 requestId 只保留第一条。
 */
function collectInteractions(sources: InteractionSources, tenantId: string): ListedInteraction[] {
  const merged = new Map<string, ListedInteraction>();
  for (const record of sources.interactionRecords.values()) {
    if (record.tenant_id !== tenantId) continue;
    merged.set(record.requestId, {
      kind: 'permission',
      request_id: record.requestId,
      run_id: record.run_id,
      ...(record.session_id !== undefined ? { session_id: record.session_id } : {}),
      ...(record.tool_call_id !== undefined ? { tool_call_id: record.tool_call_id } : {}),
      tool: record.tool,
      input: record.input,
      created_at: record.created_at,
      status: record.status,
      ...(record.answer !== undefined ? { answer: record.answer } : {}),
    });
  }
  for (const [requestId, pending] of sources.pendingPermissions) {
    if (pending.tenant_id !== tenantId || merged.has(requestId)) continue;
    merged.set(requestId, {
      kind: 'permission',
      request_id: requestId,
      run_id: pending.run_id,
      ...(pending.session_id !== undefined ? { session_id: pending.session_id } : {}),
      ...(pending.tool_call_id !== undefined ? { tool_call_id: pending.tool_call_id } : {}),
      tool: pending.tool,
      input: pending.input,
      created_at: pending.ts,
      status: 'pending',
    });
  }
  for (const [requestId, ask] of sources.pendingAsks) {
    if (ask.tenant_id !== tenantId || merged.has(requestId)) continue;
    merged.set(requestId, {
      kind: 'ask',
      request_id: requestId,
      run_id: ask.run_id,
      ...(ask.session_id !== undefined ? { session_id: ask.session_id } : {}),
      ...(ask.questions !== undefined ? { questions: ask.questions } : {}),
      created_at: ask.ts,
      status: 'pending',
    });
  }
  return [...merged.values()];
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

export function createInteractionMethods(deps: InteractionMethodsDeps): RpcMethodDefinition[] {
  const { respondPermission, respondAsk, interactions, teamScope } = deps;

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

  /**
   * team-scoped control token 的请求归属检查。
   * 找不到记录 / 无 session / 映射不可用 / 不属于该 team 一律 `forbidden`，
   * 不区分 `not_found`，避免泄漏请求存在性。
   */
  function assertTeamAccess(requestId: string, principal: RpcMethodContext['principal']): void {
    if (!isTeamScopedPrincipal(principal)) return;
    const sessionId = sessionForRequest(requestId);
    const team = sessionId === undefined ? undefined : teamScope?.teamForSession(sessionId);
    if (team === undefined || team !== principal.team_id) {
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
          tenant_id: { type: 'string' },
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
          ctx.tenantId,
          rawScope as PermissionScope | undefined,
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
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      handler: (params, ctx) => {
        const answers = params.answers;
        if (!Array.isArray(answers)) {
          throw new RpcError('invalid_params', 'answers must be an array');
        }
        const requestId = stringParam(params, 'request_id');
        assertTeamAccess(requestId, ctx.principal);
        respondAsk(requestId, answers, ctx.tenantId);
        return { ok: true };
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
          status: { type: 'string', enum: ['pending', 'answered', 'orphaned'] },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['interactions'],
        properties: {
          interactions: { type: 'array', items: interactionItemSchema },
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
        const limit = parseListLimit(params.limit);
        let items = collectInteractions(interactions, ctx.tenantId).filter(
          (item) =>
            (rawStatus === undefined || item.status === rawStatus) &&
            (sessionId === undefined || item.session_id === sessionId) &&
            (runId === undefined || item.run_id === runId),
        );
        if (isTeamScopedPrincipal(ctx.principal)) {
          // 映射缺失 / 无法判定 → 空列表（fail-closed）。
          const teamId = ctx.principal.team_id;
          items = items.filter(
            (item) =>
              item.session_id !== undefined &&
              teamScope?.teamForSession(item.session_id) === teamId,
          );
        }
        // 最新在前；同时间戳按 request_id 稳定排序。
        items.sort((a, b) =>
          a.created_at === b.created_at
            ? a.request_id < b.request_id
              ? -1
              : a.request_id > b.request_id
                ? 1
                : 0
            : b.created_at - a.created_at,
        );
        return { interactions: items.slice(0, limit) };
      },
    },
  ];
}
