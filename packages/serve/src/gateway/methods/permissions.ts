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
import type { AgentControlLike, AgentStatusLike } from '../../agent-control.js';
import { RpcError, type RpcMethodDefinition } from '../../rpc.js';

/** 三档确认策略（自动允许 / 每次确认 / 强制确认）。 */
export const TOOL_POLICIES = ['auto', 'ask', 'never'] as const;

export type ToolPolicy = (typeof TOOL_POLICIES)[number];

/** 写盘结果：两个规范化后的规则数组。 */
export interface ToolPolicyWriteResult {
  auto_approve: string[];
  never_auto_approve: string[];
}

/**
 * 有效规则快照（`permissions.show` 读面，additive 只读）。
 *
 * 注入源 = serve 壳的热应用基线（`permissionState.current`，与启动规则
 * `resolveRuntimePermission` 同源）——不是用户 YAML 原样：legacy 工具名换算、
 * `ask` 始终免确认、never 默认名单都在解析里。bridgeDeny 是 O2 桥可达性拒绝
 * 名单（信息字段，不参与 auto/ask/never 矩阵）。
 */
export interface PermissionRulesSnapshot {
  default: 'allow' | 'ask';
  autoApprove: string[];
  neverAutoApprove: string[];
  bridgeDeny?: string[];
}

/** asm 注入的写盘面；缺省 → `not_supported`。 */
export interface PermissionsControl {
  /**
   * 写用户 YAML 的两个数组（保留其它键、0600 原子写）。
   * tool 已由本模块校验存在性；实现只需落盘并返回写入后的两个数组。
   */
  setToolPolicy(input: { tool: string; policy: ToolPolicy }): ToolPolicyWriteResult;
  /**
   * 读面（additive，可选）：当前有效规则。缺省 / 未实现 ⇒ `permissions.show`
   * 回 `not_supported`（与写面同一口径）。只读，不改任何规则。
   */
  rules?(): PermissionRulesSnapshot;
}

export interface PermissionsMethodsDeps {
  /** 缺省 → `not_supported`。 */
  permissions?: PermissionsControl;
  /** `tools.list` 的同一宿主来源；用于工具存在性校验。 */
  pluginHost(): PluginHost | undefined;
  /**
   * 通用成员级工具名（inbox 等所有 agent 都有的）：与 `tools.list` 节点口径同源
   * （执行内核的真实注册路径，经装配层透传）。工具权限统一规范：这些工具与全局
   * 工具一样可设策略。缺省 / 读失败 ⇒ 空，校验退回纯全局工具口径。
   */
  commonToolNames?(): string[];
  /**
   * 成员控制面（additive，可选）：`permissions.show{member_id}` 的成员解析与
   * 工具面读取（`toolSurface`，与 `tools.list{agent_id}` 同一数据源）。
   * 只认本节点 AgentService 的成员 —— 跨舰队 id 解析不出 ⇒ `not_found`。
   * 缺省 ⇒ 带 `member_id` 的请求回 `not_supported`。
   */
  agent?: AgentControlLike;
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
 * 工具存在性校验：与 `tools.list` 走同一 `pluginHostFor`，因此 MCP / 插件工具同样可见；
 * 通用成员级工具（inbox 等）经 `commonToolNames` 纳入同一份权限面，与全局工具一致可设。
 * exact 工具名优先；否则把 `tool.*` scoped 键（如 `agent.close` / `inbox.read`）在第一个
 * `.` 处拆出 base，base 必须是已注册工具。未知工具 / 未知 base → `invalid_params`
 * （契约 §7），不泄漏宿主内部结构。
 */
function assertKnownTool(
  tool: string,
  host: PluginHost | undefined,
  commonToolNames: readonly string[] = [],
): void {
  if (host === undefined) {
    throw new RpcError('not_found', 'Tool host is not available');
  }
  const known = new Set([
    ...host.listTools().map((definition) => definition.name),
    ...commonToolNames,
  ]);
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
      handler: async (params) => {
        const control = deps.permissions;
        if (control === undefined) {
          throw new RpcError('not_supported', 'Permission policy write is not available');
        }
        const tool = stringParam(params, 'tool');
        const policy = policyParam(params);
        let commonNames: string[] = [];
        try {
          commonNames = deps.commonToolNames?.() ?? [];
        } catch {
          commonNames = [];
        }
        assertKnownTool(tool, deps.pluginHost(), commonNames);
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
    {
      // Additive（AX 自服务 · 自观）：有效权限矩阵只读面。不改任何规则。
      name: 'permissions.show',
      permission: 'read',
      params_schema: {
        type: 'object',
        properties: {
          member_id: { type: 'string', minLength: 1 },
        },
      },
      result_schema: {
        type: 'object',
        required: ['default', 'tools', 'scoped', 'rules'],
        properties: {
          default: { type: 'string', enum: ['allow', 'ask'] },
          tools: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'policy', 'has_permission_check', 'source'],
              properties: {
                name: { type: 'string' },
                policy: { type: 'string', enum: [...TOOL_POLICIES] },
                has_permission_check: { type: 'boolean' },
                source: { type: 'string', enum: ['global'] },
              },
            },
          },
          scoped: {
            type: 'array',
            items: {
              type: 'object',
              required: ['key', 'tool', 'action', 'policy'],
              properties: {
                key: { type: 'string' },
                tool: { type: 'string' },
                action: { type: 'string' },
                policy: { type: 'string', enum: ['auto', 'never'] },
              },
            },
          },
          rules: {
            type: 'object',
            required: ['auto_approve', 'never_auto_approve'],
            properties: {
              auto_approve: { type: 'array', items: { type: 'string' } },
              never_auto_approve: { type: 'array', items: { type: 'string' } },
              bridge_deny: { type: 'array', items: { type: 'string' } },
            },
          },
          member: {
            type: 'object',
            required: ['id', 'state'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              state: { type: 'string' },
              team_id: { type: 'string' },
              visibility: { type: 'string' },
            },
          },
        },
      },
      handler: async (params, ctx) => {
        const rules = deps.permissions?.rules?.();
        if (rules === undefined) {
          throw new RpcError('not_supported', 'Permission rules read is not available');
        }
        const memberId =
          typeof params.member_id === 'string' && params.member_id.trim() !== ''
            ? params.member_id.trim()
            : undefined;

        // ── 工具面：缺省节点口径；member_id → 该成员真实工具面（tools.list 同源）──
        const hostTools = (deps.pluginHost()?.listTools() ?? []).map((tool) => ({
          name: tool.name,
          has_permission_check: typeof tool.checkPermission === 'function',
        }));
        let commonTools: Array<{ name: string; has_permission_check: boolean }> = [];
        try {
          const surface = deps.agent?.commonToolSurface?.();
          commonTools =
            surface !== undefined
              ? surface.map((tool) => ({
                  name: tool.name,
                  has_permission_check: tool.has_permission_check,
                }))
              : (deps.commonToolNames?.() ?? []).map((name) => ({
                  name,
                  has_permission_check: false,
                }));
        } catch {
          commonTools = [];
        }
        const seen = new Set(hostTools.map((tool) => tool.name));
        const nodeSurface = [...hostTools, ...commonTools.filter((tool) => !seen.has(tool.name))];

        let surface = nodeSurface;
        let member: Record<string, unknown> | undefined;
        if (memberId !== undefined) {
          const agent = deps.agent;
          if (agent === undefined) {
            throw new RpcError('not_supported', 'Member permission view is not available');
          }
          // 可见性口径与 agents.list 同源：合成 owner principal 按 viewer 列成员
          // （private 由 AgentService 判定）；人类管理面按 id 直读（RPC read 闸已前置）。
          // 只认本节点 AgentService —— 跨舰队 id 解析不出 ⇒ not_found。
          let status: AgentStatusLike | undefined;
          const viewer = ctx.principal.agent_id;
          if (viewer !== undefined) {
            const members = await agent.list({ viewer });
            status = members.find((entry) => entry.id === memberId);
          } else {
            status = await agent.get(memberId);
          }
          if (status === undefined) {
            throw new RpcError('not_found', `Member not found: ${memberId}`, {
              member_id: memberId,
            });
          }
          member = {
            id: status.id,
            ...(status.name !== undefined ? { name: status.name } : {}),
            state: String(status.state ?? ''),
            ...(status.team_id !== undefined ? { team_id: status.team_id } : {}),
            ...(status.visibility !== undefined ? { visibility: String(status.visibility) } : {}),
          };
          // 有透传但答不出（未知成员 / 老执行内核）⇒ not_found，不静默给空列表
          // （与 tools.list{agent_id} 逐字同口径）；没透传 ⇒ 退化节点口径。
          if (agent.toolSurface !== undefined) {
            const memberTools = await agent.toolSurface(memberId);
            if (memberTools === undefined) {
              throw new RpcError('not_found', `Member not found: ${memberId}`, {
                member_id: memberId,
              });
            }
            surface = memberTools.map((tool) => ({
              name: tool.name,
              has_permission_check: tool.has_permission_check,
            }));
          }
        }

        // ── 矩阵：PermissionPolicy.authorize 的静态投影 ──
        // exact never → never（任何 allow 降级 ask）；autoApprove → auto；
        // default allow → auto；其余 ask。scoped 键（tool.action）不参与工具级
        // 判定，单列在 scoped[]（运行期按 args 命中，只降级 auto 来源的 allow）。
        // 工具自带 checkPermission 的显式判定不在静态矩阵里（has_permission_check
        // 标记提示）；remember-always 是进程内用户决定，不属于配置规则面。
        const neverExact = new Set(rules.neverAutoApprove.filter((key) => !key.includes('.')));
        const autoExact = new Set(rules.autoApprove.filter((key) => !key.includes('.')));
        const tools = surface.map((tool) => ({
          name: tool.name,
          policy: neverExact.has(tool.name)
            ? ('never' as const)
            : autoExact.has(tool.name) || rules.default === 'allow'
              ? ('auto' as const)
              : ('ask' as const),
          has_permission_check: tool.has_permission_check,
          source: 'global' as const,
        }));

        const scoped = [
          ...rules.autoApprove
            .filter((key) => key.includes('.'))
            .map((key) => {
              const dot = key.indexOf('.');
              return {
                key,
                tool: key.slice(0, dot),
                action: key.slice(dot + 1),
                policy: 'auto' as const,
              };
            }),
          ...rules.neverAutoApprove
            .filter((key) => key.includes('.'))
            .map((key) => {
              const dot = key.indexOf('.');
              return {
                key,
                tool: key.slice(0, dot),
                action: key.slice(dot + 1),
                policy: 'never' as const,
              };
            }),
        ];

        return {
          default: rules.default,
          tools,
          scoped,
          rules: {
            auto_approve: rules.autoApprove,
            never_auto_approve: rules.neverAutoApprove,
            ...(rules.bridgeDeny !== undefined ? { bridge_deny: rules.bridgeDeny } : {}),
          },
          ...(member !== undefined ? { member } : {}),
        };
      },
    },
  ];
}
