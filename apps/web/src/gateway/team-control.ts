/**
 * 单节点 Team 控制面（0.24 Web IA）。
 *
 * 当前 WS 节点直接复用 `GatewayClient`（结构满足本接口）；额外节点用同一形状的
 * HTTP 适配器。token 每次调用时解析，只进 Authorization 头，不进返回值 / 日志。
 * 写操作（create / update / archive）落在节点自己，必须人类 token。
 */
import { unwrapAgentResult } from './agent-result';
import { fetchNodeRpc, type NodeConfig } from './nodes';
import type {
  AgentBatchResponse,
  AgentCreateInput,
  AgentSummary,
  AgentUpdateInput,
  MessageRef,
  SessionCreateInput,
  SessionCreateResult,
  SessionDetail,
  TeamCreateInput,
  TeamDetail,
  TeamPostResult,
  TeamRetractResult,
  TeamSummary,
  TeamUpdateInput,
} from './types';

export interface TeamControl {
  listTeams(): Promise<TeamSummary[]>;
  getTeam(
    teamId: string,
    opts?: { limit?: number; members_limit?: number; before?: string },
  ): Promise<TeamDetail>;
  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
    /**
     * 附件引用（0.52，additive）：只有路径与种类，随 @ 投递写成成员侧 core
     * `Message.refs`；不传 = 无引用，旧 gateway 忽略未知键。
     */
    refs?: MessageRef[];
  }): Promise<TeamPostResult>;
  createTeam(input: TeamCreateInput): Promise<TeamSummary>;
  updateTeam(input: TeamUpdateInput): Promise<TeamSummary>;
  archiveTeam(teamId: string): Promise<TeamSummary>;
  /** 0.38：追加 tombstone（append-only）；目标消息由 UI 隐藏。 */
  retractTeam(input: { team_id: string; message_id: string }): Promise<TeamRetractResult>;
  /** 0.27：冻结 / 解冻成员创建闸门。 */
  setSpawnFrozen(teamId: string, frozen: boolean): Promise<TeamSummary>;
  getSession(
    sessionId: string,
    opts?: { message_limit?: number; before?: string },
  ): Promise<SessionDetail>;
  /** canonical `agents.list`；管理面 token 会额外返回成员记录。 */
  listAgents(): Promise<AgentSummary[]>;
  /** 0.25：Agent CRUD（与 Teams 共用同一节点的控制面）。 */
  createAgent(input: AgentCreateInput): Promise<AgentSummary>;
  updateAgent(input: AgentUpdateInput): Promise<AgentSummary>;
  closeAgent(agentId: string): Promise<AgentSummary>;
  /** 0.39：为成员新建 session（无来源 + startup_prompt；旧 session 保留只读）。 */
  createSession(input: SessionCreateInput): Promise<SessionCreateResult>;
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
        ...(opts?.before !== undefined ? { before: opts.before } : {}),
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
    retractTeam(input) {
      return call<TeamRetractResult>('teams.retract', input);
    },
    setSpawnFrozen(teamId, frozen) {
      return call<TeamSummary>('teams.spawnFrozen', { team_id: teamId, frozen });
    },
    async getSession(sessionId, opts) {
      const body = await call<{ session?: SessionDetail }>('sessions.get', {
        session_id: sessionId,
        ...(opts?.message_limit !== undefined ? { message_limit: opts.message_limit } : {}),
        ...(opts?.before !== undefined ? { before: opts.before } : {}),
      });
      if (!body?.session) throw new Error(`Session not found: ${sessionId}`);
      return body.session;
    },
    async listAgents() {
      const body = await call<{ agents?: AgentSummary[] }>('agents.list', {});
      return Array.isArray(body?.agents) ? body.agents : [];
    },
    async createAgent(input) {
      return unwrapAgentResult(
        await call<AgentBatchResponse>('agents.create', { agents: [input] }),
      );
    },
    async updateAgent(input) {
      return unwrapAgentResult(
        await call<AgentBatchResponse>('agents.update', { agents: [input] }),
      );
    },
    async closeAgent(agentId) {
      return unwrapAgentResult(
        await call<AgentBatchResponse>('agents.close', { agents: [{ agent_id: agentId }] }),
      );
    },
    createSession(input) {
      return call<SessionCreateResult>('sessions.create', input);
    },
  };
}
