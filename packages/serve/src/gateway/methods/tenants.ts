/**
 * tenants.* 方法（list / get / create / update）。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import {
  normalizeTenantInfo,
  type TenantControlLike,
  type TenantInfo,
  type TenantQuota,
} from '../../tenant.js';
import { stringParam } from './common.js';
import { tenantInfoSchema } from './schemas.js';

/** 新 node 尚无落盘 tenant 元数据时的合成创建时间（进程启动时间，避免显示 1970）。 */
const SYNTHESIZED_TENANT_CREATED_AT = Date.now();

export interface TenantMethodsDeps {
  tenants?: TenantControlLike;
  /** CONTRACT-0.49 C6：本 node 的单 id；管理面只暴露这一项。 */
  singleTenantId: string;
}

export function createTenantMethods(deps: TenantMethodsDeps): RpcMethodDefinition[] {
  const { tenants, singleTenantId } = deps;

  function tenantInfoOrThrow(info: unknown): TenantInfo {
    const normalized = normalizeTenantInfo(info);
    if (!normalized) throw new RpcError('internal', 'Invalid tenant metadata');
    return normalized;
  }

  /**
   * 单 id 的 TenantInfo。registry 尚无落盘数据（新 node）时也返回一项，
   * 保证 C6 的 `tenants.list` 恰有一项、`tenants.get(单 id)` 可用。
   */
  async function singleTenantInfo(): Promise<TenantInfo> {
    if (!tenants) throw new RpcError('not_found', 'Tenant registry is not available');
    const listed = (await tenants.list()).map(tenantInfoOrThrow);
    const match = listed.find((tenant) => tenant.tenant_id === singleTenantId);
    if (match) return match;
    const info = await tenants.get(singleTenantId);
    if (info) return tenantInfoOrThrow(info);
    return {
      tenant_id: singleTenantId,
      status: 'active',
      created_at: SYNTHESIZED_TENANT_CREATED_AT,
    };
  }

  return [
    {
      name: 'tenants.list',
      permission: 'admin',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['tenants'],
        properties: {
          tenants: { type: 'array', items: tenantInfoSchema },
        },
      },
      handler: async () => {
        // CONTRACT-0.49 C6：单公司模式只暴露单 id，legacy 目录不进入 RPC 视图。
        return { tenants: [await singleTenantInfo()] };
      },
    },
    {
      name: 'tenants.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['tenant_id'],
        properties: { tenant_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['tenant'],
        properties: { tenant: tenantInfoSchema },
      },
      handler: async (params) => {
        // CONTRACT-0.49 C6：单 id → info；其它一律 not_found（不再跨 tenant forbidden）。
        const tenantId = stringParam(params, 'tenant_id');
        if (tenantId !== singleTenantId) {
          throw new RpcError('not_found', `Tenant not found: ${tenantId}`);
        }
        return { tenant: await singleTenantInfo() };
      },
    },
    {
      name: 'tenants.create',
      permission: 'admin',
      params_schema: {
        type: 'object',
        required: ['tenant_id'],
        properties: {
          tenant_id: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          quota: { type: 'object' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['tenant'],
        properties: { tenant: tenantInfoSchema },
      },
      handler: async () => {
        // CONTRACT-0.49 C6：单公司模式不允许创建 tenant；不调用 registry、不写盘。
        throw new RpcError('forbidden', 'Tenant creation is not available in single-tenant mode');
      },
    },
    {
      name: 'tenants.update',
      permission: 'admin',
      params_schema: {
        type: 'object',
        required: ['tenant_id'],
        properties: {
          tenant_id: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          status: { type: 'string', enum: ['active', 'disabled'] },
          quota: { type: 'object' },
        },
      },
      result_schema: {
        type: 'object',
        required: ['tenant'],
        properties: { tenant: tenantInfoSchema },
      },
      handler: async (params) => {
        // CONTRACT-0.49 C6：非单 id → not_found；单 id 保持现有 update 语义。
        const tenantId = stringParam(params, 'tenant_id');
        if (tenantId !== singleTenantId) {
          throw new RpcError('not_found', `Tenant not found: ${tenantId}`);
        }
        if (!tenants?.update) {
          throw new RpcError('not_found', 'Tenant update is not available');
        }
        const info = await tenants.update(singleTenantId, {
          ...(typeof params.name === 'string' ? { name: params.name } : {}),
          ...(params.status === 'active' || params.status === 'disabled'
            ? { status: params.status }
            : {}),
          ...(typeof params.quota === 'object' && params.quota !== null
            ? { quota: params.quota as TenantQuota }
            : {}),
        });
        return { tenant: tenantInfoOrThrow(info) };
      },
    },
  ];
}
