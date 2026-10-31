/**
 * Team 域方法：canonical `teams.*`（node-local）。
 *
 * 从 `client.ts` 拆出（S1）；行为与原单文件一致。
 */

import type {
  TeamCreateInput,
  TeamDetail,
  TeamPostResult,
  TeamSummary,
  TeamUpdateInput,
} from '../types';
import { AgentsClient } from './agents';

// 只走 HTTP rpc()；`teams.*` 不依赖 WS 在线。
export abstract class TeamsClient extends AgentsClient {
  async listTeams(): Promise<TeamSummary[]> {
    const body = await this.rpc<{ teams?: TeamSummary[] }>('teams.list');
    return body.teams ?? [];
  }

  getTeam(teamId: string, opts?: { limit?: number; members_limit?: number }): Promise<TeamDetail> {
    return this.rpc<TeamDetail>('teams.get', {
      team_id: teamId,
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts?.members_limit !== undefined ? { members_limit: opts.members_limit } : {}),
    });
  }

  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
  }): Promise<TeamPostResult> {
    return this.rpc<TeamPostResult>('teams.post', input);
  }

  /** DECISION-040：结果形状为 TeamSummary。 */
  createTeam(input: TeamCreateInput): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.create', input);
  }

  updateTeam(input: TeamUpdateInput): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.update', input);
  }

  archiveTeam(teamId: string): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.archive', { team_id: teamId });
  }

  /** 0.27：冻结 / 解冻 Team 的成员创建闸门。 */
  setSpawnFrozen(teamId: string, frozen: boolean): Promise<TeamSummary> {
    return this.rpc<TeamSummary>('teams.spawnFrozen', { team_id: teamId, frozen });
  }
}
