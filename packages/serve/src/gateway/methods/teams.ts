/**
 * teams.* 方法（0.19 S3；S4 增加 teams.budget）。
 *
 * 未注入 `TeamControlLike`（含 local dispatcher）时方法仍进 manifest，
 * handler 返回 `not_found`；tenant 不匹配同样返回 `not_found`，不泄漏跨 tenant 存在性。
 * 与 legacy `/v1/team/*` / `team.*`（单数前缀）无关，不接线。
 *
 * @module @vessel-agent/serve
 */

import {
  isTeamScopedPrincipal,
  RpcError,
  type RpcMethodContext,
  type RpcMethodDefinition,
} from '../../rpc.js';
import type { BudgetDimensionLike, TeamControlLike, TeamSummaryLike } from '../../team-control.js';
import { stringParam } from './common.js';
import {
  stringListSchema,
  teamBudgetResultSchema,
  teamDetailSchema,
  teamMembersResultSchema,
  teamPostResultSchema,
  teamSummarySchema,
} from './schemas.js';

export interface TeamMethodsDeps {
  /** 未注入 = `teams.*` 全部返回 `not_found`（canonical 计数不变）。 */
  teams?: TeamControlLike;
}

/** 未注入 / tenant 不匹配都按 `not_found` 处理（不泄漏跨 tenant 存在性）。 */
function requireTeamControl(
  teams: TeamControlLike | undefined,
  ctx: RpcMethodContext,
): TeamControlLike {
  if (!teams || teams.tenantId !== ctx.tenantId) {
    throw new RpcError('not_found', 'Team control is not available');
  }
  return teams;
}

/**
 * team-scoped control token 的作用域 team；非 team-scoped（静态 / admin / 其他
 * scope）返回 undefined，沿用完整视图。
 */
function teamScopeOf(ctx: RpcMethodContext): string | undefined {
  return isTeamScopedPrincipal(ctx.principal) ? ctx.principal.team_id : undefined;
}

/**
 * 请求的 team_id 必须落在 token 的 team 作用域内。
 * 在调用 `control.get/post/members` 之前执行：不泄漏跨 team 存在性，也不产生副作用。
 */
function assertTeamScope(scope: string | undefined, teamId: string): void {
  if (scope !== undefined && teamId !== scope) {
    throw new RpcError('not_found', `Team not found: ${teamId}`);
  }
}

/**
 * team-scoped token 的元数据白名单：去掉主机路径与策略
 * （`workspace` / `handoff_path` / `policy`）。
 * 只用于 `teams.list` / `teams.get.team`；`members` / `messages` 属于 data plane，不脱敏。
 */
function redactTeamSummary(team: TeamSummaryLike): TeamSummaryLike {
  return {
    team_id: team.team_id,
    name: team.name,
    tenant_id: team.tenant_id,
    member_count: team.member_count,
    online_count: team.online_count,
    created_at: team.created_at,
  };
}

const CONVERSATION_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const BUDGET_DIMENSIONS: ReadonlySet<string> = new Set([
  'hops',
  'turns',
  'tokens',
  'wall_clock',
  'cycle',
]);
/** 参数里的可选字符串；缺省 undefined，存在但非法 → invalid_params。 */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', `${key} must be a non-empty string`);
  }
  return value;
}

/**
 * Team 层错误码 → RPC 错误码。
 * `RpcError` 原样抛出；无 code 的异常归 `internal`。
 */
function mapTeamError(error: unknown): never {
  if (error instanceof RpcError) throw error;
  const code =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === undefined) throw new RpcError('internal', message);
  if (code === 'team_not_found' || code === 'unknown_member') {
    throw new RpcError('not_found', message);
  }
  if (code === 'team_log_write_failed') throw new RpcError('internal', message);
  throw new RpcError('invalid_params', message, { team_code: code });
}

export function createTeamMethods(deps: TeamMethodsDeps): RpcMethodDefinition[] {
  const { teams } = deps;

  return [
    {
      name: 'teams.list',
      permission: 'read',
      params_schema: { type: 'object' },
      result_schema: {
        type: 'object',
        required: ['teams'],
        properties: {
          teams: { type: 'array', items: teamSummarySchema },
        },
      },
      handler: async (_params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          // canonical RPC 无 viewer：private 成员不可见（由 TeamService 过滤）。
          const listed = await control.list();
          const scope = teamScopeOf(ctx);
          if (scope === undefined) return { teams: listed };
          return {
            teams: listed
              .filter((team) => team.team_id === scope)
              .map((team) => redactTeamSummary(team)),
          };
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
    {
      name: 'teams.get',
      permission: 'read',
      params_schema: {
        type: 'object',
        required: ['team_id'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
        },
      },
      result_schema: teamDetailSchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          const teamId = stringParam(params, 'team_id');
          const scope = teamScopeOf(ctx);
          assertTeamScope(scope, teamId);
          const limit = typeof params.limit === 'number' ? params.limit : undefined;
          const detail = await control.get(teamId, limit === undefined ? undefined : { limit });
          if (!detail) throw new RpcError('not_found', `Team not found: ${teamId}`);
          if (scope === undefined) return detail;
          return { ...detail, team: redactTeamSummary(detail.team) };
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
    {
      name: 'teams.post',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['team_id', 'content'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
          content: { type: 'string' },
          mentions: stringListSchema,
          // 0.19 S4：显式会话分组；缺省由 Team 生成。
          conversation_id: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            pattern: CONVERSATION_ID_PATTERN,
          },
        },
      },
      result_schema: teamPostResultSchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          const teamId = stringParam(params, 'team_id');
          assertTeamScope(teamScopeOf(ctx), teamId);
          const content = stringParam(params, 'content');
          const conversationId = optionalString(params, 'conversation_id');
          const mentions = Array.isArray(params.mentions)
            ? params.mentions.filter((item): item is string => typeof item === 'string')
            : undefined;
          // canonical RPC 的发送者固定为 'human'；无 viewer（private 不可见）。
          return await control.post({
            team_id: teamId,
            content,
            mentions,
            from: 'human',
            ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
          });
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
    {
      name: 'teams.members',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['team_id', 'action', 'member'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['add', 'remove'] },
          member: { type: 'string', minLength: 1 },
        },
      },
      result_schema: teamMembersResultSchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          const teamId = stringParam(params, 'team_id');
          // control scope 不在 dispatcher 白名单里能到 members，但这里仍做纵深防御。
          assertTeamScope(teamScopeOf(ctx), teamId);
          const action = params.action;
          if (action !== 'add' && action !== 'remove') {
            throw new RpcError('invalid_params', 'action must be add or remove');
          }
          const member = stringParam(params, 'member');
          const result = await control.members({
            team_id: teamId,
            action,
            member,
            from: 'human',
          });
          if (!result) throw new RpcError('not_found', `Team not found: ${teamId}`);
          return result;
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
    {
      name: 'teams.budget',
      // 0.19 S4：只有静态 write / admin token 能调用；不进 control scope 白名单。
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['team_id', 'action'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['status', 'override'] },
          conversation_id: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            pattern: CONVERSATION_ID_PATTERN,
          },
          dimension: {
            type: 'string',
            enum: ['hops', 'turns', 'tokens', 'wall_clock', 'cycle'],
          },
          // max 允许 integer | null；校验器子集没有 union，type 省略后由 handler 判定。
          max: {},
        },
      },
      result_schema: teamBudgetResultSchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          if (typeof control.budget !== 'function') {
            throw new RpcError('not_found', 'Team budget is not available');
          }
          const teamId = stringParam(params, 'team_id');
          assertTeamScope(teamScopeOf(ctx), teamId);
          const action = params.action;
          if (action !== 'status' && action !== 'override') {
            throw new RpcError('invalid_params', 'action must be status or override');
          }

          const conversationId = optionalString(params, 'conversation_id');
          let dimension: BudgetDimensionLike | undefined;
          let max: number | null | undefined;
          if (action === 'override') {
            if (conversationId === undefined) {
              throw new RpcError('invalid_params', 'conversation_id is required for override');
            }
            const rawDimension = params.dimension;
            if (typeof rawDimension !== 'string' || !BUDGET_DIMENSIONS.has(rawDimension)) {
              throw new RpcError(
                'invalid_params',
                'dimension must be one of hops, turns, tokens, wall_clock, cycle',
              );
            }
            dimension = rawDimension as BudgetDimensionLike;
            if (!Object.hasOwn(params, 'max')) {
              throw new RpcError('invalid_params', 'max is required for override');
            }
            const rawMax = params.max;
            if (
              rawMax !== null &&
              (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 0)
            ) {
              throw new RpcError('invalid_params', 'max must be a non-negative integer or null');
            }
            max = rawMax as number | null;
          }

          const result = await control.budget({
            team_id: teamId,
            action,
            ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
            ...(dimension !== undefined ? { dimension } : {}),
            ...(max !== undefined ? { max } : {}),
          });
          if (!result) throw new RpcError('not_found', `Team not found: ${teamId}`);
          return result;
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
  ];
}
