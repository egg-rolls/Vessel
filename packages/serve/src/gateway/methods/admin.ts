/**
 * gateway.* 管理方法（`gateway.reload`，DECISION-023 §2.3）。
 *
 * serve 只负责协议形状、权限与参数校验；真实重载由 asm 通过
 * `GatewayOptions.reload` 注入。未注入时明确返回 `not_supported`。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { stringListSchema } from './schemas.js';

/** v1 可热重载的范围（DECISION-023 §2.3）。 */
export const RELOAD_SCOPES = ['config', 'plugins'] as const;

/** 热重载范围。 */
export type ReloadScope = (typeof RELOAD_SCOPES)[number];

/** `gateway.reload` 结果；`requires_restart` 不得伪装成已生效。 */
export interface GatewayReloadResult {
  reloaded: string[];
  requires_restart: string[];
}

export interface AdminMethodsDeps {
  /** asm 注入的实际热重载实现；缺省 → `not_supported`。 */
  reload?: (scopes: string[]) => Promise<GatewayReloadResult>;
}

/**
 * 解析 `scopes`：缺省 = 全部可热重载范围；去重并保持调用方顺序。
 * schema 已先校验类型与 enum；这里兜底非数组输入。
 */
export function parseReloadScopes(value: unknown): ReloadScope[] {
  if (value === undefined) return [...RELOAD_SCOPES];
  if (!Array.isArray(value)) {
    throw new RpcError('invalid_params', 'scopes must be an array');
  }
  const scopes: ReloadScope[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(RELOAD_SCOPES as readonly string[]).includes(item)) {
      throw new RpcError('invalid_params', `scopes must only contain: ${RELOAD_SCOPES.join(', ')}`);
    }
    if (!scopes.includes(item as ReloadScope)) scopes.push(item as ReloadScope);
  }
  return scopes;
}

export function createAdminMethods(deps: AdminMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'gateway.reload',
      permission: 'admin',
      params_schema: {
        type: 'object',
        properties: {
          scopes: {
            type: 'array',
            items: { type: 'string', enum: [...RELOAD_SCOPES] },
          },
        },
      },
      result_schema: {
        type: 'object',
        required: ['reloaded', 'requires_restart'],
        properties: {
          reloaded: stringListSchema,
          requires_restart: stringListSchema,
        },
      },
      handler: async (params) => {
        const reload = deps.reload;
        if (!reload) {
          throw new RpcError('not_supported', 'gateway.reload is not supported by this gateway');
        }
        return reload(parseReloadScopes(params.scopes));
      },
    },
  ];
}
