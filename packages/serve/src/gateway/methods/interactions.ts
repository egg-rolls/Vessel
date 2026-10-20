/**
 * 交互应答方法：permission.respond / ask.respond。
 *
 * @module @vessel/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { stringParam } from './common.js';

export interface InteractionMethodsDeps {
  respondPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    remember: boolean,
    tenantId?: string,
  ): void;
  respondAsk(requestId: string, answers: unknown[], tenantId?: string): void;
}

export function createInteractionMethods(deps: InteractionMethodsDeps): RpcMethodDefinition[] {
  const { respondPermission, respondAsk } = deps;
  return [
    {
      name: 'permission.respond',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['request_id', 'decision'],
        properties: {
          request_id: { type: 'string', minLength: 1 },
          decision: { type: 'string', enum: ['allow', 'deny'] },
          remember: { type: 'boolean' },
          tenant_id: { type: 'string' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      handler: (params, ctx) => {
        const requestId = stringParam(params, 'request_id');
        const decision = params.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          throw new RpcError('invalid_params', "decision must be 'allow' or 'deny'");
        }
        respondPermission(requestId, decision, params.remember === true, ctx.tenantId);
        return { ok: true };
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
