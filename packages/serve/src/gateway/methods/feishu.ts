/**
 * feishu.* 方法（当前仅 status）。
 *
 * @module @vessel-agent/serve
 */

import { type FeishuGatewayOptions, normalizeFeishuStatus } from '../../feishu.js';
import type { RpcMethodDefinition } from '../../rpc.js';

export interface FeishuMethodsDeps {
  /** 非 default tenant 未配置 → forbidden；default 保持 0.4 not_found。 */
  requireFeishu(tenantId: string): FeishuGatewayOptions;
}

export function createFeishuMethods(deps: FeishuMethodsDeps): RpcMethodDefinition[] {
  const { requireFeishu } = deps;
  return [
    {
      name: 'feishu.status',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: { tenant_id: { type: 'string' } },
      },
      result_schema: {
        type: 'object',
        required: ['channel'],
        properties: {
          channel: {
            type: 'object',
            required: ['connected', 'appIdMasked', 'active_chats', 'queued_messages'],
            properties: {
              connected: { type: 'boolean' },
              appIdMasked: { type: 'string' },
              active_chats: { type: 'integer' },
              queued_messages: { type: 'integer' },
              last_error: { type: 'string' },
            },
          },
        },
      },
      handler: (_params, ctx) => {
        const feishu = requireFeishu(ctx.tenantId);
        return { channel: normalizeFeishuStatus(feishu.status()) };
      },
    },
  ];
}
