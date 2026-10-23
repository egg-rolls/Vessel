/**
 * teams.* 方法（0.19 S3，canonical 45 → 49）。
 *
 * 未注入 `TeamControlLike`（含 local dispatcher）时 4 个方法仍进 manifest，
 * handler 返回 `not_found`；tenant 不匹配同样返回 `not_found`，不泄漏跨 tenant 存在性。
 * 与 legacy `/v1/team/*` / `team.*`（单数前缀）无关，不接线。
 *
 * @module @vessel-agent/serve
 */

import { RpcError, type RpcMethodContext, type RpcMethodDefinition } from '../../rpc.js';
import type { TeamControlLike } from '../../team-control.js';
import { stringParam } from './common.js';
import {
  stringListSchema,
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
          return { teams: await control.list() };
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
          const limit = typeof params.limit === 'number' ? params.limit : undefined;
          const detail = await control.get(teamId, limit === undefined ? undefined : { limit });
          if (!detail) throw new RpcError('not_found', `Team not found: ${teamId}`);
          return detail;
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
        },
      },
      result_schema: teamPostResultSchema,
      handler: async (params, ctx) => {
        try {
          const control = requireTeamControl(teams, ctx);
          const teamId = stringParam(params, 'team_id');
          const content = stringParam(params, 'content');
          const mentions = Array.isArray(params.mentions)
            ? params.mentions.filter((item): item is string => typeof item === 'string')
            : undefined;
          // canonical RPC 的发送者固定为 'human'；无 viewer（private 不可见）。
          return await control.post({ team_id: teamId, content, mentions, from: 'human' });
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
  ];
}
