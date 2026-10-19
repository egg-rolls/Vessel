/**
 * sessions.* 方法（list / get / search / delete / rename）。
 *
 * @module @vessel/serve
 */

import type { SessionBackend } from '@vessel/core';
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

export interface SessionMethodsDeps {
  defaultTenantId: string;
  sessionFor(tenantId: string): SessionBackend | undefined;
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

export function createSessionMethods(deps: SessionMethodsDeps): RpcMethodDefinition[] {
  const { defaultTenantId, sessionFor, sessionData } = deps;

  function requireSession(tenantId: string): SessionBackend {
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
      handler: async (params, ctx) => {
        const backend = requireSession(ctx.tenantId);
        const state = await backend.load(stringParam(params, 'session_id'));
        if (!state) throw new RpcError('not_found', 'Session not found');
        return { session: state };
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
