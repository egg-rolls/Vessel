/**
 * permissions.* 方法（CONTRACT-hot-apply §7）。
 *
 * 只有一条 canonical 方法：`permissions.setToolPolicy`。三档语义完全由用户 YAML 的
 * `permission.auto_approve` / `permission.never_auto_approve` 两个数组表达——
 * serve 不做映射推导，只做参数 / tenant / 工具存在性校验，写盘由 asm 注入
 * （`src/permission-store.ts` 的 0600 原子写）。
 *
 * 成功后调用方（web）自己再调 `gateway.reload({ scopes: ['permission'] })`；
 * 本方法不触发任何热应用，避免出现「参数级立即生效」后门。
 *
 * @module @vessel-agent/serve
 */

import type { PluginHost } from '@vessel-agent/core';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';

/** 三档确认策略（自动允许 / 每次确认 / 强制确认）。 */
export const TOOL_POLICIES = ['auto', 'ask', 'never'] as const;

export type ToolPolicy = (typeof TOOL_POLICIES)[number];

/** 写盘结果：两个规范化后的规则数组。 */
export interface ToolPolicyWriteResult {
  auto_approve: string[];
  never_auto_approve: string[];
}

/** asm 注入的写盘面；缺省 → `not_supported`。 */
export interface PermissionsControl {
  /**
   * 写用户 YAML 的两个数组（保留其它键、0600 原子写）。
   * tool 已由本模块校验存在性；实现只需落盘并返回写入后的两个数组。
   */
  setToolPolicy(input: { tool: string; policy: ToolPolicy }): ToolPolicyWriteResult;
}

export interface PermissionsMethodsDeps {
  /** 只有 default tenant 能改写用户级 YAML（与 `config.set` 同一约束）。 */
  defaultTenantId: string;
  /** 缺省 → `not_supported`。 */
  permissions?: PermissionsControl;
  /** `tools.list` 的同一宿主来源；用于工具存在性校验。 */
  pluginHostFor(tenantId: string): PluginHost | undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError('invalid_params', `${key} is required`, { key });
  }
  return value.trim();
}

function policyParam(params: Record<string, unknown>): ToolPolicy {
  const value = params.policy;
  if (typeof value !== 'string' || !(TOOL_POLICIES as readonly string[]).includes(value)) {
    throw new RpcError('invalid_params', `policy must be one of: ${TOOL_POLICIES.join(', ')}`, {
      key: 'policy',
    });
  }
  return value as ToolPolicy;
}

/**
 * 工具存在性校验：与 `tools.list` 走同一 `pluginHostFor`，因此 MCP / 插件工具同样可见。
 * exact 工具名优先；否则把 `tool.*` scoped 键（如 `agent.close`）在第一个 `.` 处拆出
 * base，base 必须是已注册工具。未知工具 / 未知 base → `invalid_params`（契约 §7），
 * 不泄漏宿主内部结构。
 */
function assertKnownTool(tool: string, host: PluginHost | undefined): void {
  if (host === undefined) {
    throw new RpcError('not_found', 'Tool host is not available');
  }
  const known = new Set(host.listTools().map((definition) => definition.name));
  if (known.has(tool)) return;
  const dot = tool.indexOf('.');
  const base = dot > 0 ? tool.slice(0, dot) : undefined;
  if (base !== undefined && known.has(base)) return;
  throw new RpcError('invalid_params', `Unknown tool: ${tool}`, { tool });
}

export function createPermissionsMethods(deps: PermissionsMethodsDeps): RpcMethodDefinition[] {
  return [
    {
      name: 'permissions.setToolPolicy',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['tool', 'policy'],
        properties: {
          tool: { type: 'string', minLength: 1 },
          policy: { type: 'string', enum: [...TOOL_POLICIES] },
        },
      },
      result_schema: {
        type: 'object',
        required: ['ok', 'tool', 'policy', 'auto_approve', 'never_auto_approve'],
        properties: {
          ok: { type: 'boolean' },
          tool: { type: 'string' },
          policy: { type: 'string', enum: [...TOOL_POLICIES] },
          auto_approve: { type: 'array', items: { type: 'string' } },
          never_auto_approve: { type: 'array', items: { type: 'string' } },
        },
      },
      handler: async (params, ctx) => {
        // 用户配置是进程级文件；非 default tenant 不得跨租户改写。
        if (ctx.tenantId !== deps.defaultTenantId) {
          throw new RpcError(
            'forbidden',
            'permissions.setToolPolicy is only available for the default tenant',
          );
        }
        const control = deps.permissions;
        if (control === undefined) {
          throw new RpcError('not_supported', 'Permission policy write is not available');
        }
        const tool = stringParam(params, 'tool');
        const policy = policyParam(params);
        assertKnownTool(tool, deps.pluginHostFor(ctx.tenantId));
        let written: ToolPolicyWriteResult;
        try {
          written = control.setToolPolicy({ tool, policy });
        } catch (error) {
          if (error instanceof RpcError) throw error;
          throw new RpcError(
            'internal',
            error instanceof Error ? error.message : 'Permission policy write failed',
          );
        }
        return {
          ok: true,
          tool,
          policy,
          auto_approve: written.auto_approve,
          never_auto_approve: written.never_auto_approve,
        };
      },
    },
  ];
}
