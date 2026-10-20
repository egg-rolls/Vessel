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

export interface TenantMethodsDeps {
  tenants?: TenantControlLike;
}

export function createTenantMethods(deps: TenantMethodsDeps): RpcMethodDefinition[] {
  const { tenants } = deps;

  function tenantInfoOrThrow(info: unknown): TenantInfo {
    const normalized = normalizeTenantInfo(info);
    if (!normalized) throw new RpcError('internal', 'Invalid tenant metadata');
    return normalized;
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
        if (!tenants) throw new RpcError('not_found', 'Tenant registry is not available');
        return { tenants: (await tenants.list()).map(tenantInfoOrThrow) };
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
      handler: async (params, ctx) => {
        if (!tenants) throw new RpcError('not_found', 'Tenant registry is not available');
        const tenantId = stringParam(params, 'tenant_id');
        if (!ctx.isAdmin && tenantId !== ctx.principal.tenant_id) {
          throw new RpcError('forbidden', 'Cross-tenant access is not allowed');
        }
        const info = await tenants.get(tenantId);
        if (!info) throw new RpcError('not_found', `Tenant not found: ${tenantId}`);
        return { tenant: tenantInfoOrThrow(info) };
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
      handler: async (params) => {
        if (!tenants?.create) {
          throw new RpcError('not_found', 'Tenant create is not available');
        }
        const info = await tenants.create(stringParam(params, 'tenant_id'), {
          ...(typeof params.name === 'string' ? { name: params.name } : {}),
          ...(typeof params.quota === 'object' && params.quota !== null
            ? { quota: params.quota as TenantQuota }
            : {}),
        });
        return { tenant: tenantInfoOrThrow(info) };
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
        if (!tenants?.update) {
          throw new RpcError('not_found', 'Tenant update is not available');
        }
        const info = await tenants.update(stringParam(params, 'tenant_id'), {
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
