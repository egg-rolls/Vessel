/**
 * 单节点 Team 控制面（0.24 Web IA）。
 *
 * 当前 WS 节点直接复用 `GatewayClient`（结构满足本接口）；额外节点用同一形状的
 * HTTP 适配器。token 每次调用时解析，只进 Authorization 头，不进返回值 / 日志。
 * 写操作（create / update / archive）落在节点自己，必须人类 token。
 */
import { fetchNodeRpc, type NodeConfig } from './nodes';
import type {
  SessionDetail,
  TeamCreateInput,
  TeamDetail,
  TeamPostResult,
  TeamSummary,
  TeamUpdateInput,
} from './types';

export interface TeamControl {
  listTeams(): Promise<TeamSummary[]>;
  getTeam(teamId: string, opts?: { limit?: number; members_limit?: number }): Promise<TeamDetail>;
  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
  }): Promise<TeamPostResult>;
  createTeam(input: TeamCreateInput): Promise<TeamSummary>;
  updateTeam(input: TeamUpdateInput): Promise<TeamSummary>;
  archiveTeam(teamId: string): Promise<TeamSummary>;
  getSession(sessionId: string): Promise<SessionDetail>;
}

/** 额外节点的适配器；`resolveToken` 在每次请求时读取该节点自己的凭据。 */
export function createRemoteTeamControl(
  node: NodeConfig,
  resolveToken: () => string | undefined,
): TeamControl {
  const call = <T>(method: string, params?: unknown): Promise<T> =>
    fetchNodeRpc<T>(node, method, params, resolveToken());

  return {
    async listTeams() {
      const body = await call<{ teams?: TeamSummary[] }>('teams.list', {});
      return Array.isArray(body?.teams) ? body.teams : [];
    },
    getTeam(teamId, opts) {
      return call<TeamDetail>('teams.get', {
        team_id: teamId,
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.members_limit !== undefined ? { members_limit: opts.members_limit } : {}),
      });
    },
    postTeam(input) {
      return call<TeamPostResult>('teams.post', input);
    },
    createTeam(input) {
      return call<TeamSummary>('teams.create', input);
    },
    updateTeam(input) {
      return call<TeamSummary>('teams.update', input);
    },
    archiveTeam(teamId) {
      return call<TeamSummary>('teams.archive', { team_id: teamId });
    },
    async getSession(sessionId) {
      const body = await call<{ session?: SessionDetail }>('sessions.get', {
        session_id: sessionId,
      });
      if (!body?.session) throw new Error(`Session not found: ${sessionId}`);
      return body.session;
    },
  };
}
