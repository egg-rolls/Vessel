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
  /**
   * CONTRACT-0.34-context C7：仅服务 `sessions.compact` 的 per-tenant 执行面。
   * 结构化读取可选 `compactContext(sessionId)`；缺省或方法缺失 = `compact_unavailable`。
   */
  runtimeFor?(tenantId: string): unknown;
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

type CompactContextFn = (sessionId: string) => Promise<{ removed: number; remaining: number }>;

type RewindContextFn = (
  sessionId: string,
  keepMessages: number,
) => Promise<{ removed: number; remaining: number }>;

/** 门面 / EU 以 `Error(message)` 表达的业务错误（见 CONTRACT-0.37 §3）。 */
function rewindErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `compact_unavailable` 可能以 RpcError.code 或 message 形式到达（远程 / 本地门面）。 */
function isCompactUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === 'string' && code.includes('compact_unavailable')) ||
    (typeof message === 'string' && message.includes('compact_unavailable'))
  );
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
  const { defaultTenantId, sessionFor, runStoreFor, sessionData, runtimeFor } = deps;

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
    {
      // CONTRACT-0.34-context C7：手动压缩。远程 / connect 走本方法；
      // 本地 TUI 直接经 ExecutionUnit.compactContext。
      name: 'sessions.compact',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id'],
        properties: { session_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['removed', 'remaining', 'reason'],
        properties: {
          removed: { type: 'integer', minimum: 0 },
          remaining: { type: 'integer', minimum: 0 },
          reason: { type: 'string', enum: ['manual'] },
        },
      },
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const sessionId = stringParam(params, 'session_id');
        const state = await backend.load(sessionId);
        if (!state) throw new RpcError('session_not_found', 'Session not found');

        const runtime = runtimeFor?.(ctx.tenantId) as
          | { compactContext?: CompactContextFn }
          | undefined;
        const compactContext = runtime?.compactContext;
        if (typeof compactContext !== 'function') {
          throw new RpcError('compact_unavailable', 'Context compaction is not available');
        }

        try {
          const result = await compactContext.call(runtime, sessionId);
          return {
            removed: result.removed,
            remaining: result.remaining,
            reason: 'manual' as const,
          };
        } catch (error) {
          // runtime 门面把“没有 live EU / 无方法”也报成 compact_unavailable；
          // 其它错误原样抛给 dispatcher（内部错误不伪装成不可用）。
          if (isCompactUnavailable(error)) {
            throw new RpcError('compact_unavailable', 'Context compaction is not available');
          }
          throw error;
        }
      },
    },
    {
      // CONTRACT-0.37：消息撤回。`keep_messages` 是 `sessions.get` 的
      // `session.messages` 下标；删除 `[keep_messages, ...)`。
      name: 'sessions.rewind',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['session_id', 'keep_messages'],
        properties: {
          session_id: { type: 'string', minLength: 1 },
          keep_messages: { type: 'integer', minimum: 0 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['session_id', 'removed', 'remaining'],
        properties: {
          session_id: { type: 'string' },
          removed: { type: 'integer', minimum: 0 },
          remaining: { type: 'integer', minimum: 0 },
        },
      },
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const sessionId = stringParam(params, 'session_id');
        const state = await backend.load(sessionId);
        if (!state) throw new RpcError('session_not_found', 'Session not found');

        const keepMessages = optionalNumber(params.keep_messages);
        if (keepMessages === undefined || !Number.isInteger(keepMessages) || keepMessages < 0) {
          throw new RpcError('invalid_params', 'keep_messages must be a non-negative integer');
        }

        const runtime = runtimeFor?.(ctx.tenantId) as
          | { rewindContext?: RewindContextFn }
          | undefined;
        const rewindContext = runtime?.rewindContext;
        if (typeof rewindContext !== 'function') {
          throw new RpcError('rewind_unavailable', 'Message rewind is not available');
        }

        try {
          const result = await rewindContext.call(runtime, sessionId, keepMessages);
          return {
            session_id: sessionId,
            removed: result.removed,
            remaining: result.remaining,
          };
        } catch (error) {
          // 门面 / EU 的业务错误是 `Error(message)`；内部错误不伪装成业务码。
          const text = rewindErrorText(error);
          if (text.includes('run_in_progress')) {
            throw new RpcError('conflict', 'run_in_progress');
          }
          if (text.includes('session_not_found')) {
            throw new RpcError('session_not_found', 'Session not found');
          }
          if (text.includes('invalid_params')) {
            throw new RpcError('invalid_params', text);
          }
          if (text.includes('rewind_unavailable')) {
            throw new RpcError('rewind_unavailable', 'Message rewind is not available');
          }
          throw error;
        }
      },
    },
  ];
}
