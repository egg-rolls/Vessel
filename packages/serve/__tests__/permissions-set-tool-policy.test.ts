import { describe, expect, it } from 'bun:test';
import { MemoryPluginHost, type ToolDefinition } from '@vessel-agent/core';
import {
  createPermissionsMethods,
  type PermissionsMethodsDeps,
  TOOL_POLICIES,
} from '../src/gateway/methods/permissions.js';
import type { RpcMethodContext } from '../src/rpc.js';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => '',
  };
}

function hostWith(...names: string[]): MemoryPluginHost {
  const host = new MemoryPluginHost();
  for (const name of names) host.registerTool(tool(name));
  return host;
}

function context(tenantId = 'default'): RpcMethodContext {
  return { tenantId, principal: { tenant_id: tenantId, role: 'write' } } as RpcMethodContext;
}

const METHOD = 'permissions.setToolPolicy';

function handlerOf(deps: PermissionsMethodsDeps) {
  const method = createPermissionsMethods(deps).find((entry) => entry.name === METHOD);
  if (!method) throw new Error(`missing method: ${METHOD}`);
  return method;
}

function depsWithWriter(overrides: Partial<PermissionsMethodsDeps> = {}): {
  deps: PermissionsMethodsDeps;
  writes: Array<{ tool: string; policy: string }>;
} {
  const writes: Array<{ tool: string; policy: string }> = [];
  return {
    deps: {
      defaultTenantId: 'default',
      pluginHostFor: () => hostWith('bash', 'read', 'edit'),
      permissions: {
        setToolPolicy: ({ tool: name, policy }) => {
          writes.push({ tool: name, policy });
          return {
            auto_approve: policy === 'auto' ? [name] : [],
            never_auto_approve: policy === 'never' ? [name] : [],
          };
        },
      },
      ...overrides,
    },
    writes,
  };
}

describe('permissions.setToolPolicy', () => {
  it('declares write permission, params schema and result schema', () => {
    const method = handlerOf({ defaultTenantId: 'default', pluginHostFor: () => hostWith('bash') });
    expect(method.permission).toBe('write');
    expect(method.params_schema).toBeDefined();
    expect(method.result_schema).toBeDefined();
    expect(TOOL_POLICIES).toEqual(['auto', 'ask', 'never']);
  });

  it('calls the injected writer for each of the three policies', async () => {
    for (const policy of TOOL_POLICIES) {
      const { deps, writes } = depsWithWriter();
      const result = (await handlerOf(deps).handler(
        { tool: 'bash', policy },
        context(),
      )) as unknown as {
        ok: boolean;
        policy: string;
        auto_approve: string[];
        never_auto_approve: string[];
      };
      expect(result as unknown as Record<string, unknown>).toEqual({
        ok: true,
        tool: 'bash',
        policy,
        auto_approve: policy === 'auto' ? ['bash'] : [],
        never_auto_approve: policy === 'never' ? ['bash'] : [],
      });
      expect(writes).toEqual([{ tool: 'bash', policy }]);
    }
  });

  it('rejects unknown tools with invalid_params（不写盘）', async () => {
    const { deps, writes } = depsWithWriter();
    await expect(
      handlerOf(deps).handler({ tool: 'nope', policy: 'auto' }, context()),
    ).rejects.toMatchObject({ code: 'invalid_params', message: 'Unknown tool: nope' });
    expect(writes).toEqual([]);
  });

  it('rejects unknown policies with invalid_params', async () => {
    const { deps } = depsWithWriter();
    await expect(
      handlerOf(deps).handler({ tool: 'bash', policy: 'maybe' }, context()),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('only the default tenant may write（非 default 一律 forbidden）', async () => {
    const { deps, writes } = depsWithWriter();
    await expect(
      handlerOf(deps).handler({ tool: 'bash', policy: 'auto' }, context('other')),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(writes).toEqual([]);
  });

  it('returns not_supported when no writer is injected', async () => {
    const method = handlerOf({ defaultTenantId: 'default', pluginHostFor: () => hostWith('bash') });
    await expect(method.handler({ tool: 'bash', policy: 'auto' }, context())).rejects.toMatchObject(
      { code: 'not_supported' },
    );
  });

  it('wraps writer failures as internal', async () => {
    const method = handlerOf({
      defaultTenantId: 'default',
      pluginHostFor: () => hostWith('bash'),
      permissions: {
        setToolPolicy: () => {
          throw new Error('disk full');
        },
      },
    });
    await expect(method.handler({ tool: 'bash', policy: 'auto' }, context())).rejects.toMatchObject(
      { code: 'internal', message: 'disk full' },
    );
  });
});
