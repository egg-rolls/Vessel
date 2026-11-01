/**
 * sessions.* 方法（list / get / search / delete / rename）。
 *
 * @module @vessel-agent/serve
 */

import type { SessionState, SessionStore } from '@vessel-agent/core';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import {
  MAX_SESSION_SEARCH_LIMIT,
  normalizeSearchQuery,
  parseSearchLimit,
  searchSessions,
} from '../../session-search.js';
import { mapTenantError } from '../../tenant.js';
import { MethodError } from '../errors.js';
import { stringParam, tenantParamSchema } from './common.js';
import { runStateSchema, sessionInfoSchema, sessionSearchHitSchema } from './schemas.js';

/** run 记录的最小读取面（gateway 只需要按 run_id 取最近一条）。 */
export interface SessionRunLookup {
  load(runId: string): Promise<unknown>;
}

export interface SessionMethodsDeps {
  defaultTenantId: string;
  sessionFor(tenantId: string): SessionStore | undefined;
  /** 最近 RunRecord 的读取面；缺省时 `sessions.get` 只用 `legacy_run` 投影。 */
  runStoreFor?(tenantId: string): SessionRunLookup | undefined;
  sessionData?: {
    deleteSessionData(
      sessionId: string,
      tenantId?: string,
    ): Promise<{
      sessions_deleted: number;
      runs_deleted: number;
      events_deleted: number;
    }>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 终态（update_at 可作为 completed_at）。 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

/**
 * `sessions.get` 的线上投影：SessionState 元数据 + 最近 RunRecord（或 `legacy_run`）。
 *
 * 形状保持既有 `runStateSchema`：run 字段来自 RunRecord，session 字段来自 SessionState。
 */
export function toSessionView(state: SessionState, latestRaw: unknown): Record<string, unknown> {
  const latest = isRecord(latestRaw) ? latestRaw : undefined;
  const legacy = state.legacy_run;
  const status = optionalString(latest?.status) ?? state.status ?? 'running';
  const terminal = TERMINAL_STATUSES.has(status);
  const runId = optionalString(latest?.run_id) ?? state.last_run_id ?? state.session_id;
  const startedAt = optionalNumber(latest?.created_at) ?? state.created_at;
  const updatedAt = optionalNumber(latest?.updated_at) ?? state.updated_at;
  const completedAt = terminal ? updatedAt : legacy?.completed_at;
  const usage = latest?.usage ?? legacy?.usage;
  const error = optionalString(latest?.error) ?? legacy?.error;
  const branch = optionalString(latest?.branch) ?? state.created_on_branch;

  return {
    run_id: runId,
    session_id: state.session_id,
    messages: state.messages ?? [],
    started_at: startedAt,
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
    status,
    ...(usage !== undefined ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(state.title !== undefined ? { title: state.title } : {}),
    ...(state.preview !== undefined ? { preview: state.preview } : {}),
    updated_at: updatedAt,
    ...(branch !== undefined ? { branch } : {}),
    ...(state.tenant_id !== undefined ? { tenant_id: state.tenant_id } : {}),
  };
}

export function createSessionMethods(deps: SessionMethodsDeps): RpcMethodDefinition[] {
  const { defaultTenantId, sessionFor, runStoreFor, sessionData } = deps;

  function requireSession(tenantId: string): SessionStore {
    const resolved = sessionFor(tenantId);
    if (!resolved) {
      if (tenantId !== defaultTenantId) {
        throw new RpcError('forbidden', `Tenant session backend is not configured: ${tenantId}`);
      }
      throw new RpcError('not_found', 'No session backend configured');
    }
    return resolved;
  }

  async function listSessions(
    tenantId: string = defaultTenantId,
  ): Promise<{ sessions: unknown[] }> {
    const backend = sessionFor(tenantId);
    if (!backend) {
      // 非 default tenant 未注入 sessionFor → 明确的 forbidden；default 保持旧语义。
      if (tenantId !== defaultTenantId) {
        throw new RpcError('forbidden', `Tenant session backend is not configured: ${tenantId}`);
      }
      throw new MethodError('no_session', 'No session backend configured');
    }
    return { sessions: await backend.listRich() };
  }

  return [
    {
      name: 'sessions.list',
      permission: 'read',
      params_schema: tenantParamSchema,
      result_schema: {
        type: 'object',
        required: ['sessions'],
        properties: {
          sessions: { type: 'array', items: sessionInfoSchema },
        },
      },
      handler: (_params, ctx) => listSessions(ctx.tenantId),
    },
    {
      name: 'sessions.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['session'],
        properties: { session: runStateSchema },
      },
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const state = await backend.load(stringParam(params, 'session_id'));
        if (!state) throw new RpcError('not_found', 'Session not found');
        const runStore = runStoreFor?.(ctx.tenantId);
        const latest =
          runStore !== undefined && state.last_run_id !== undefined
            ? await runStore.load(state.last_run_id)
            : undefined;
        return { session: toSessionView(state, latest) };
      },
    },
    {
      name: 'sessions.search',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 256 },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SESSION_SEARCH_LIMIT },
        },
      },
      result_schema: {
        type: 'object',
        required: ['sessions'],
        properties: {
          sessions: { type: 'array', items: sessionSearchHitSchema },
        },
      },
      handler: async (params, ctx) => {
        const query = normalizeSearchQuery(params.query);
        if (query === null) {
          throw new RpcError('invalid_params', 'query must be 1..256 characters');
        }
        const limit = parseSearchLimit(params.limit);
        if (limit === null) {
          throw new RpcError(
            'invalid_params',
            `limit must be an integer between 1 and ${MAX_SESSION_SEARCH_LIMIT}`,
          );
        }
        const backend = requireSession(ctx.tenantId);
        try {
          return { sessions: await searchSessions(backend, query, limit) };
        } catch (error) {
          mapTenantError(error);
        }
      },
    },
    {
      name: 'sessions.delete',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['sessions_deleted', 'runs_deleted', 'events_deleted'],
        properties: {
          sessions_deleted: { type: 'integer' },
          runs_deleted: { type: 'integer' },
          events_deleted: { type: 'integer' },
        },
      },
      handler: async (params, ctx) => {
        if (!sessionData) {
          throw new RpcError('internal', 'deleteSessionData is not configured');
        }
        try {
          return await sessionData.deleteSessionData(
            stringParam(params, 'session_id'),
            ctx.tenantId,
          );
        } catch (error) {
          mapTenantError(error);
        }
      },
    },
    {
      name: 'sessions.rename',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id', 'title'],
        properties: {
          session_id: { type: 'string', minLength: 1 },
          title: { type: 'string', maxLength: 512 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['session_id', 'title'],
        properties: {
          session_id: { type: 'string' },
          title: { type: 'string' },
        },
      },
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const sessionId = stringParam(params, 'session_id');
        const title = stringParam(params, 'title');
        const state = await backend.load(sessionId);
        if (!state) throw new RpcError('not_found', 'Session not found');
        await backend.save({ ...state, title, updated_at: Date.now() });
        return { session_id: sessionId, title };
      },
    },
  ];
}
