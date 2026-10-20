/**
 * 方法表拆分后的共享小工具（纯函数 / 常量）。
 *
 * @module @vessel-agent/serve
 */

import { RpcError } from '../../rpc.js';

/** `{ tenant_id?: string }` 参数 schema（0.5 方法表沿用） */
export const tenantParamSchema = {
  type: 'object',
  properties: { tenant_id: { type: 'string' } },
} as const;

export function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', `${key} is required`);
  }
  return value;
}

/**
 * checkpoint 是否属于该 tenant。
 * 未标注 tenant 的 checkpoint 视为当前 store 所属 tenant（file store 按目录隔离）。
 */
export function checkpointBelongsToTenant(
  checkpoint: { tenant_id?: string },
  tenantId: string,
): boolean {
  return checkpoint.tenant_id === undefined || checkpoint.tenant_id === tenantId;
}
