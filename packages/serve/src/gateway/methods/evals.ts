/**
 * evals.* 方法（latest / run）。
 *
 * @module @vessel-agent/serve
 */

import { type EvalsGatewayOptions, normalizeEvalReport } from '../../evals.js';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { stringParam } from './common.js';
import { evalReportSchema } from './schemas.js';

export interface EvalMethodsDeps {
  evals?: EvalsGatewayOptions;
}

export function createEvalMethods(deps: EvalMethodsDeps): RpcMethodDefinition[] {
  const { evals } = deps;
  return [
    {
      name: 'evals.latest',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['suite'],
        properties: { suite: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['report'],
        properties: { report: evalReportSchema },
      },
      handler: async (params) => {
        const suite = stringParam(params, 'suite').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suite) || suite.includes('..')) {
          throw new RpcError('invalid_params', 'Invalid suite name');
        }
        if (!evals) throw new RpcError('not_found', 'Eval report not found');
        try {
          const report = await evals.latest(suite);
          const normalized = report ? normalizeEvalReport(report) : null;
          if (!normalized) throw new RpcError('not_found', `Eval report not found: ${suite}`);
          return { report: normalized };
        } catch (error) {
          if (error instanceof RpcError) throw error;
          const code = (error as { code?: unknown }).code;
          if (code === 'eval_not_found') throw new RpcError('not_found', String(error));
          if (code === 'eval_invalid') throw new RpcError('invalid_params', String(error));
          throw new RpcError('internal', 'Failed to read eval report');
        }
      },
    },
    {
      name: 'evals.run',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['suite'],
        properties: { suite: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['report'],
        properties: { report: evalReportSchema },
      },
      handler: async (params) => {
        if (!evals?.run) throw new RpcError('not_found', 'Evals runner is not available');
        const suite = stringParam(params, 'suite');
        return { report: normalizeEvalReport(await evals.run(suite)) };
      },
    },
  ];
}
