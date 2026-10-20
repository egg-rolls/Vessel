/**
 * 交互应答方法：permission.respond / ask.respond。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import type { PermissionRespondResult, PermissionScope } from '../../run-engine.js';
import { stringParam } from './common.js';

export interface InteractionMethodsDeps {
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    tenantId?: string,
    scope?: PermissionScope,
  ): PermissionRespondResult;
  respondAsk(requestId: string, answers: unknown[], tenantId?: string): void;
}

const PERMISSION_SCOPES: ReadonlySet<PermissionScope> = new Set(['once', 'session', 'always']);

export function createInteractionMethods(deps: InteractionMethodsDeps): RpcMethodDefinition[] {
  const { respondPermission, respondAsk } = deps;
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
        respondAsk(stringParam(params, 'request_id'), answers, ctx.tenantId);
        return { ok: true };
      },
    },
  ];
}
