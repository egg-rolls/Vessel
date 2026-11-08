/**
 * feishu.* 方法（当前仅 status）。
 *
 * @module @vessel-agent/serve
 */

import { type FeishuGatewayOptions, normalizeFeishuStatus } from '../../feishu.js';
import type { RpcMethodDefinition } from '../../rpc.js';

export interface FeishuMethodsDeps {
  /** 未配置 → 0.4 not_found。 */
  requireFeishu(): FeishuGatewayOptions;
}

export function createFeishuMethods(deps: FeishuMethodsDeps): RpcMethodDefinition[] {
  const { requireFeishu } = deps;
  return [
    {
      name: 'feishu.status',
      permission: 'read',
      params_schema: { type: 'object' },
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
      handler: () => {
        const feishu = requireFeishu();
        return { channel: normalizeFeishuStatus(feishu.status()) };
      },
    },
  ];
}
