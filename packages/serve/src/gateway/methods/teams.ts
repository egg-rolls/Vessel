/**
 * teams.* 方法（0.19 S3；S4 增加 teams.budget）。
 *
 * 未注入 `TeamControlLike`（含 local dispatcher）时方法仍进 manifest，
 * handler 返回 `not_found`；tenant 不匹配同样返回 `not_found`，不泄漏跨 tenant 存在性。
 * 与旧版单数前缀 `team.*` / `/v1/team/*`（0.22.1 已删除）无关，不接线。
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
 * 发送者 / viewer 身份：合成 owner principal 用 owner agent id（恢复 private
 * 可见性与回复路径）；gateway / team token 没有 agent_id，按 `human` 处理。
 */
function actorOf(ctx: RpcMethodContext): string {
  return ctx.principal.agent_id ?? 'human';
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
 * （`workspace` / `policy`）。
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
    // 0.21：描述是展示字段，不随主机路径一起脱敏。
    ...(team.description !== undefined ? { description: team.description } : {}),
    ...(team.archived_at !== undefined ? { archived_at: team.archived_at } : {}),
    // 0.27：冻结状态属于展示字段，不随主机路径一起脱敏。
    ...(team.spawn_frozen !== undefined ? { spawn_frozen: team.spawn_frozen } : {}),
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
 * 可空可选字符串：缺省 undefined；存在时 `null` 表示清空，非空 string 表示设置。
 * 校验器子集没有 union / nullable，因此这些字段在 params_schema 里声明为 `{}`，
 * 由这里做唯一判定。
 */
function optionalNullableString(
  params: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!Object.hasOwn(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('invalid_params', `${key} must be a non-empty string or null`);
  }
  return value;
}

/** policy 必须是普通对象（整体替换，不做 merge）。 */
function optionalPolicy(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(params, key)) return undefined;
  const value = params[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RpcError('invalid_params', `${key} must be an object`);
  }
  return value as Record<string, unknown>;
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
  if (
    code === 'team_not_found' ||
    code === 'team_conversation_not_found' ||
    code === 'unknown_member'
  ) {
    throw new RpcError('not_found', message);
  }
  // S10.3：archive 的前置条件与只读状态是业务冲突，不是参数错误。
  if (code === 'team_not_empty' || code === 'team_archived') {
    throw new RpcError('conflict', message, { team_code: code });
  }
  if (code === 'team_log_write_failed') throw new RpcError('internal', message);
  throw new RpcError('invalid_params', message, { team_code: code });
}

export function createTeamMethods(deps: TeamMethodsDeps): RpcMethodDefinition[] {
  const { teams } = deps;

  return [
    {
      name: 'teams.create',
      // S10.3：只允许 human / admin；team-scoped control token 不能凭空造 Team。
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['workspace'],
        properties: {
          workspace: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          policy: { type: 'object' },
        },
      },
      result_schema: teamSummarySchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          if (teamScopeOf(ctx) !== undefined) {
            throw new RpcError('forbidden', 'team-scoped token cannot create teams');
          }
          const workspace = stringParam(params, 'workspace');
          const name = optionalString(params, 'name');
          const description = optionalString(params, 'description');
          const policy = optionalPolicy(params, 'policy');
          return await control.create({
            workspace,
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(policy !== undefined ? { policy } : {}),
          });
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
    {
      name: 'teams.update',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['team_id'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          // nullable 字段：由 handler 判定 string | null。
          description: {},
          policy: { type: 'object' },
        },
      },
      result_schema: teamSummarySchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          const teamId = stringParam(params, 'team_id');
          assertTeamScope(teamScopeOf(ctx), teamId);
          const name = optionalString(params, 'name');
          const description = optionalNullableString(params, 'description');
          const policy = optionalPolicy(params, 'policy');
          return await control.update({
            team_id: teamId,
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(policy !== undefined ? { policy } : {}),
          });
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
    {
      name: 'teams.archive',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['team_id'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
        },
      },
      result_schema: teamSummarySchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          const teamId = stringParam(params, 'team_id');
          assertTeamScope(teamScopeOf(ctx), teamId);
          return await control.archive({ team_id: teamId });
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
    {
      name: 'teams.spawnFrozen',
      permission: 'write',
      params_schema: {
        type: 'object',
        required: ['team_id', 'frozen'],
        properties: {
          team_id: { type: 'string', minLength: 1 },
          frozen: { type: 'boolean' },
        },
      },
      result_schema: teamSummarySchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          const teamId = stringParam(params, 'team_id');
          assertTeamScope(teamScopeOf(ctx), teamId);
          if (typeof params.frozen !== 'boolean') {
            throw new RpcError('invalid_params', 'frozen must be a boolean');
          }
          return await control.setSpawnFrozen(teamId, params.frozen);
        } catch (error) {
          return mapTeamError(error);
        }
      },
    },
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
          // owner 传输带 viewer（private 可见）；gateway 无 viewer，沿用 TeamService 过滤。
          const viewer = ctx.principal.agent_id;
          const listed = await control.list(viewer !== undefined ? { viewer } : undefined);
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
          // 0.21：roster 窗口（缺省 20，最大 100）；由 Team 控制面排序 / 截断。
          members_limit: { type: 'integer', minimum: 1, maximum: 100 },
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
          const membersLimit =
            typeof params.members_limit === 'number' ? params.members_limit : undefined;
          const viewer = ctx.principal.agent_id;
          const options =
            viewer === undefined && limit === undefined && membersLimit === undefined
              ? undefined
              : {
                  ...(viewer !== undefined ? { viewer } : {}),
                  ...(limit !== undefined ? { limit } : {}),
                  ...(membersLimit !== undefined ? { members_limit: membersLimit } : {}),
                };
          const detail = await control.get(teamId, options);
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
          return await control.post({
            team_id: teamId,
            content,
            mentions,
            from: actorOf(ctx),
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
            from: actorOf(ctx),
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
