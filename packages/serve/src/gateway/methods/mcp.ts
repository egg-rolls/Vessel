/**
 * mcp.* 方法（list / reconnect）。
 *
 * @module @vessel/serve
 */

import { type McpGatewayOptions, normalizeMcpServers } from '../../mcp.js';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';
import { stringParam } from './common.js';

export interface McpMethodsDeps {
  mcp?: McpGatewayOptions;
}

export function createMcpMethods(deps: McpMethodsDeps): RpcMethodDefinition[] {
  const { mcp } = deps;
  return [
    {
      name: 'mcp.list',
      permission: 'read',
      params_schema: { type: 'object' },
      handler: async () => {
        if (!mcp) throw new RpcError('not_found', 'MCP is not enabled');
        try {
          return { servers: normalizeMcpServers(await mcp.listServers()) };
        } catch {
          throw new RpcError('internal', 'Failed to read MCP server status');
        }
      },
    },
    {
      name: 'mcp.reconnect',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } },
      },
      handler: async (params, ctx) => {
        if (!mcp?.reconnect) {
          throw new RpcError('not_found', 'MCP reconnect is not available');
        }
        await mcp.reconnect(stringParam(params, 'name'));
        return { ok: true, tenant_id: ctx.tenantId };
      },
    },
  ];
}
