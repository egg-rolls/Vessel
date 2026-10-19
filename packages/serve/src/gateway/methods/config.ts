/**
 * config.* / health.get / capabilities.list 与工具、插件目录方法。
 *
 * @module @vessel/serve
 */

import type { PluginHost } from '@vessel/core';
import type { NodeInfo, ProtocolInfo, ToolInfo } from '../../protocol.js';
import {
  buildCapabilityManifest,
  RpcError,
  type RpcMethodDefinition,
  type RpcMethodTable,
} from '../../rpc.js';
import type { TeamGatewayOptions } from '../../team.js';
import type { ConfigGatewayOptionsLike } from '../../tenant.js';
import { tenantParamSchema } from './common.js';

export interface ConfigMethodsDeps {
  defaultTenantId: string;
  version?: string;
  config?: ConfigGatewayOptionsLike;
  /** 方法表在组装完成后才有值；handler 调用时解析。 */
  methodTable(): RpcMethodTable;
  toolDescriptionsForTenant(tenantId: string): Array<{ name: string; description?: string }>;
  pluginsForTenant(tenantId: string): Array<{ name: string; enabled: boolean }>;
  pluginHostFor(tenantId: string): PluginHost | undefined;
  /** health.get 的实时状态。 */
  clientCount(): number;
  latestSeq(): number;
  protocolInfo: ProtocolInfo;
  nodeInfo(): NodeInfo;
  startedAt: number;
  getTeam(): TeamGatewayOptions | undefined;
}

/** health.get / capabilities.list / config.get / config.sources */
export function createConfigMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  const {
    version,
    config,
    methodTable,
    toolDescriptionsForTenant,
    pluginsForTenant,
    clientCount,
    latestSeq,
    protocolInfo,
    nodeInfo,
    startedAt,
    getTeam,
  } = deps;

  function configControl(): ConfigGatewayOptionsLike {
    if (!config) throw new RpcError('not_found', 'Config view is not available');
    return config;
  }

  return [
    {
      name: 'health.get',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: (_params, ctx) => {
        const team = getTeam();
        return {
          status: 'ok',
          clients: clientCount(),
          latest_seq: latestSeq(),
          protocol: protocolInfo,
          node: nodeInfo(),
          started_at: startedAt,
          tenant_id: ctx.tenantId,
          team: team
            ? {
                enabled: true,
                node_id: team.nodeId,
                transport: team.transport?.kind ?? 'in-process',
              }
            : { enabled: false },
        };
      },
    },
    {
      name: 'capabilities.list',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: (_params, ctx) =>
        buildCapabilityManifest({
          version: version ?? '0.0.0',
          table: methodTable(),
          tools: toolDescriptionsForTenant(ctx.tenantId),
          plugins: pluginsForTenant(ctx.tenantId),
        }),
    },
    {
      name: 'config.get',
      permission: 'read',
      params_schema: tenantParamSchema,
      handler: async (_params, ctx) => {
        const snapshot = await configControl().snapshot(ctx.tenantId);
        return {
          schema_version: snapshot.schema_version,
          config: snapshot.config,
          // A-5 §12.2：TUI 需要展示 user/project 路径
          paths: snapshot.paths ?? { user: '', project: '' },
          tenant_id: snapshot.tenant_id ?? ctx.tenantId,
          ...(snapshot.tenant_overlay_keys
            ? { tenant_overlay_keys: snapshot.tenant_overlay_keys }
            : {}),
        };
      },
    },
    {
      name: 'config.sources',
      permission: 'read',
      params_schema: tenantParamSchema,
      handler: async (_params, ctx) => {
        const snapshot = await configControl().snapshot(ctx.tenantId);
        return {
          sources: snapshot.sources,
          tenant_id: snapshot.tenant_id ?? ctx.tenantId,
          ...(snapshot.tenant_overlay_keys
            ? { tenant_overlay_keys: snapshot.tenant_overlay_keys }
            : {}),
        };
      },
    },
  ];
}

/** tools.list（与 config 同域；单独工厂以保持方法表原顺序）。 */
export function createToolMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  const { defaultTenantId, pluginHostFor } = deps;

  function toolsPayload(tenantId: string = defaultTenantId): { tools: ToolInfo[] } {
    const host = pluginHostFor(tenantId);
    if (tenantId !== defaultTenantId && !host) {
      throw new RpcError('forbidden', `Tenant plugin host is not configured: ${tenantId}`);
    }
    const tools = host?.listTools() ?? [];
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        has_permission_check: typeof tool.checkPermission === 'function',
      })),
    };
  }

  return [
    {
      name: 'tools.list',
      permission: 'read',
      params_schema: tenantParamSchema,
      handler: (_params, ctx) => toolsPayload(ctx.tenantId),
    },
  ];
}

/** plugins.list（与 config 同域；单独工厂以保持方法表原顺序）。 */
export function createPluginsMethods(deps: ConfigMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'plugins.list',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: (_params, ctx) => ({ plugins: deps.pluginsForTenant(ctx.tenantId) }),
    },
  ];
}
