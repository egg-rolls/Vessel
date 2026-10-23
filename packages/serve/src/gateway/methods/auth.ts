/**
 * auth.* 方法（S5）：用节点 exchange token 换短期 control token。
 *
 * - `auth.exchange`：只允许 exchange / admin token；签名 scope 固定 `control`，
 *   params 不接受 scope（view / admin 一律签不出来）。
 * - `auth.revoke` / `auth.tokens`：只允许 admin；列表永不含 token / hash。
 *
 * scope 到角色等级的映射由 rpc.ts 中央检查负责；handler 再做一次防御性检查，
 * 避免中央检查缺失或被改坏时越权。
 *
 * @module @vessel-agent/serve
 */

import type {
  IssuedNodeToken,
  NodeTokenControlLike,
  NodeTokenMeta,
} from '../../node-token-control.js';
import { RpcError, type RpcMethodContext, type RpcMethodDefinition } from '../../rpc.js';
import type { TeamControlLike } from '../../team-control.js';
import { stringParam } from './common.js';
import { issuedNodeTokenSchema, nodeTokenMetaListSchema } from './schemas.js';

/** control token TTL 边界（与 node-token-control 常量一致）。 */
const TTL_MIN_S = 60;
const TTL_MAX_S = 86_400;

export interface AuthMethodsDeps {
  nodeTokens?: NodeTokenControlLike;
  /** 注入的 Team 控制面；缺失时 exchange 仍返回 not_found，不签 token。 */
  teams?: TeamControlLike;
}

/** exchange：scope 为 exchange/admin，或静态 admin token（无 scope）。 */
function canExchange(principal: RpcMethodContext['principal']): boolean {
  if (principal.scope === 'exchange' || principal.scope === 'admin') return true;
  return principal.scope === undefined && principal.role === 'admin';
}

/** 管理面：动态 admin scope 或 admin 角色。 */
function isAdminPrincipal(principal: RpcMethodContext['principal']): boolean {
  return principal.scope === 'admin' || principal.role === 'admin';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** TeamService 在团队缺失时抛 `team_not_found`；映射为 canonical not_found。 */
function isTeamNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'team_not_found'
  );
}

/** 只白名单构造响应，避免实现方附带的敏感字段透出。 */
function toExchangeResult(
  issued: IssuedNodeToken,
  teamId: string,
  tenantId: string,
): Record<string, unknown> {
  if (
    !isNonEmptyString(issued.token) ||
    !isNonEmptyString(issued.token_id) ||
    !isNonEmptyString(issued.node_id) ||
    typeof issued.expires_at !== 'number' ||
    !Number.isFinite(issued.expires_at)
  ) {
    throw new RpcError('internal', 'Node token control returned an invalid token');
  }
  return {
    token: issued.token,
    token_id: issued.token_id,
    // 交换只能签 control；不信实现方返回的 scope。
    scope: 'control',
    tenant_id: tenantId,
    team_id: isNonEmptyString(issued.team_id) ? issued.team_id : teamId,
    node_id: issued.node_id,
    ...(isNonEmptyString(issued.hub_id) ? { hub_id: issued.hub_id } : {}),
    ...(isNonEmptyString(issued.pairing_id) ? { pairing_id: issued.pairing_id } : {}),
    expires_at: issued.expires_at,
  };
}

/** 只白名单构造元数据，绝不透传 token / hash。 */
function toTokenMeta(meta: NodeTokenMeta): NodeTokenMeta {
  return {
    token_id: meta.token_id,
    scope: meta.scope,
    tenant_id: meta.tenant_id,
    issued_by: meta.issued_by,
    created_at: meta.created_at,
    expires_at: meta.expires_at,
    ...(isNonEmptyString(meta.hub_id) ? { hub_id: meta.hub_id } : {}),
    ...(isNonEmptyString(meta.team_id) ? { team_id: meta.team_id } : {}),
    ...(typeof meta.revoked_at === 'number' ? { revoked_at: meta.revoked_at } : {}),
  };
}

export function createAuthMethods(deps: AuthMethodsDeps): RpcMethodDefinition[] {
  const { nodeTokens, teams } = deps;

  function requireNodeTokens(): NodeTokenControlLike {
    if (!nodeTokens) throw new RpcError('not_found', 'Node token control is not available');
    return nodeTokens;
  }

  return [
    {
      name: 'auth.exchange',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['team_id'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
          ttl_s: { type: 'integer', minimum: TTL_MIN_S, maximum: TTL_MAX_S },
        },
      },
      result_schema: issuedNodeTokenSchema,
      handler: async (params, ctx) => {
        const control = requireNodeTokens();
        if (!canExchange(ctx.principal)) {
          throw new RpcError('forbidden', 'auth.exchange requires an exchange or admin token');
        }
        const teamId = stringParam(params, 'team_id');
        const tenantId = ctx.tenantId;
        if (!isNonEmptyString(tenantId) || tenantId === '*') {
          throw new RpcError('forbidden', 'Cannot exchange a control token for a wildcard tenant');
        }
        const rawTtl = params.ttl_s;
        if (rawTtl !== undefined) {
          if (
            typeof rawTtl !== 'number' ||
            !Number.isInteger(rawTtl) ||
            rawTtl < TTL_MIN_S ||
            rawTtl > TTL_MAX_S
          ) {
            throw new RpcError(
              'invalid_params',
              `ttl_s must be an integer between ${TTL_MIN_S} and ${TTL_MAX_S}`,
            );
          }
        }
        // 只为真实存在的 Team 签 token：缺控制面 / tenant 不匹配 / 团队缺失一律 not_found。
        if (teams === undefined || teams.tenantId !== tenantId) {
          throw new RpcError('not_found', 'Team control is not available');
        }
        let detail: Awaited<ReturnType<TeamControlLike['get']>>;
        try {
          detail = await teams.get(teamId, { limit: 1 });
        } catch (error) {
          if (isTeamNotFoundError(error)) {
            throw new RpcError('not_found', `Team not found: ${teamId}`);
          }
          throw error;
        }
        if (detail === undefined) {
          throw new RpcError('not_found', `Team not found: ${teamId}`);
        }
        const issued = await control.exchange(
          { ...ctx.principal, tenant_id: tenantId },
          {
            team_id: teamId,
            ...(typeof rawTtl === 'number' ? { ttl_s: rawTtl } : {}),
          },
        );
        return toExchangeResult(issued, teamId, tenantId);
      },
    },
    {
      name: 'auth.revoke',
      permission: 'admin',
      params_schema: {
        type: 'object',
        required: ['token_id'],
        properties: { token_id: { type: 'string', minLength: 1 } },
      },
      result_schema: {
        type: 'object',
        required: ['token_id', 'revoked_at'],
        properties: {
          token_id: { type: 'string' },
          revoked_at: { type: 'number' },
        },
      },
      handler: async (params, ctx) => {
        const control = requireNodeTokens();
        if (!isAdminPrincipal(ctx.principal)) {
          throw new RpcError('forbidden', 'auth.revoke requires an admin token');
        }
        const tokenId = stringParam(params, 'token_id');
        const revoked = await control.revoke(ctx.principal, tokenId);
        if (
          !isNonEmptyString(revoked.token_id) ||
          typeof revoked.revoked_at !== 'number' ||
          !Number.isFinite(revoked.revoked_at)
        ) {
          throw new RpcError('internal', 'Node token control returned an invalid revoke result');
        }
        return { token_id: revoked.token_id, revoked_at: revoked.revoked_at };
      },
    },
    {
      name: 'auth.tokens',
      permission: 'admin',
      params_schema: { type: 'object' },
      result_schema: nodeTokenMetaListSchema,
      handler: async (_params, ctx) => {
        const control = requireNodeTokens();
        if (!isAdminPrincipal(ctx.principal)) {
          throw new RpcError('forbidden', 'auth.tokens requires an admin token');
        }
        const tokens = await control.list(ctx.principal);
        if (!Array.isArray(tokens)) {
          throw new RpcError('internal', 'Node token control returned an invalid token list');
        }
        return { tokens: tokens.map(toTokenMeta) };
      },
    },
  ];
}
