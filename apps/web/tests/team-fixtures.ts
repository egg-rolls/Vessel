/**
 * Team 测试夹具（测试专用，不进入生产代码）。
 *
 * 形状对齐 S3 `teams.*` 契约（PLAN-0.19-s3-team §7）；`fakeTeamClient()` 只实现
 * TeamView 实际使用的三个方法，返回值可注入，便于组件测试。
 */
import type {
  TeamDetail,
  TeamMember,
  TeamMessage,
  TeamPostResult,
  TeamSummary,
} from '../src/gateway/types';

export const TEAM_ID = 'team-alpha';

export function teamSummary(overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    team_id: TEAM_ID,
    name: 'Alpha Team',
    tenant_id: 'default',
    workspace: '/workspace/alpha',
    member_count: 3,
    online_count: 2,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

export function teamMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    agent_id: 'agent-alpha',
    name: 'Alpha',
    session_id: 'sess-current',
    membership: 'present',
    presence: 'live',
    visibility: 'team',
    state: 'idle',
    epoch: 2,
    body_history: [
      {
        session_id: 'sess-old',
        epoch: 1,
        started_at: 1_700_000_000_000,
        retired_at: 1_700_000_100_000,
      },
    ],
    ...overrides,
  };
}

/** post / mention / system / reply 各一条，ts 升序。 */
export function teamMessages(): TeamMessage[] {
  return [
    {
      message_id: 'm-post',
      team_id: TEAM_ID,
      from: 'human',
      to: [],
      mentions: [],
      content: 'first post',
      ts: 1_000,
      kind: 'post',
    },
    {
      message_id: 'm-mention',
      team_id: TEAM_ID,
      from: 'human',
      to: ['agent-alpha'],
      mentions: ['agent-alpha'],
      content: '@Alpha check this',
      ts: 2_000,
      kind: 'mention',
    },
    {
      message_id: 'm-system',
      team_id: TEAM_ID,
      from: 'system',
      to: [],
      mentions: [],
      content: 'Alpha joined the team',
      ts: 3_000,
      kind: 'system',
      system_event: 'join',
    },
    {
      message_id: 'm-reply',
      team_id: TEAM_ID,
      from: 'agent-alpha',
      to: ['human'],
      mentions: [],
      content: 'done',
      ts: 4_000,
      kind: 'reply',
    },
  ];
}

export function teamDetail(overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    team: teamSummary(),
    members: [teamMember()],
    messages: teamMessages(),
    ...overrides,
  };
}

/** 一条 queued + 一条 rejected 的投递结果。 */
export function teamPostResult(overrides: Partial<TeamPostResult> = {}): TeamPostResult {
  return {
    message_id: 'm-post-new',
    team_id: TEAM_ID,
    kind: 'mention',
    mentions: ['agent-alpha', 'agent-beta'],
    delivered: [
      {
        agent_id: 'agent-alpha',
        status: 'queued',
        resolution: 'live',
        message_id: 'm-post-new',
      },
      {
        agent_id: 'agent-beta',
        status: 'rejected',
        code: 'agent_left',
        reason: 'agent is not present',
      },
    ],
    ts: 5_000,
    ...overrides,
  };
}

export interface FakeTeamClientCalls {
  listTeams: number;
  getTeam: Array<{ teamId: string; limit?: number }>;
  postTeam: Array<{ team_id: string; content: string; mentions?: string[] }>;
}

export interface FakeTeamClient {
  listTeams(): Promise<TeamSummary[]>;
  getTeam(teamId: string, opts?: { limit?: number }): Promise<TeamDetail>;
  postTeam(input: {
    team_id: string;
    content: string;
    mentions?: string[];
  }): Promise<TeamPostResult>;
  calls: FakeTeamClientCalls;
}

export interface FakeTeamClientOptions {
  teams?: TeamSummary[];
  detail?: TeamDetail;
  postResult?: TeamPostResult;
}

/** 可注入返回值的 Team client 替身；记录调用便于断言轮询 / 串行行为。 */
export function fakeTeamClient(options: FakeTeamClientOptions = {}): FakeTeamClient {
  const teams = options.teams ?? [teamSummary()];
  const detail = options.detail ?? teamDetail();
  const postResult = options.postResult ?? teamPostResult();
  const calls: FakeTeamClientCalls = { listTeams: 0, getTeam: [], postTeam: [] };

  return {
    calls,
    listTeams: async () => {
      calls.listTeams += 1;
      return teams;
    },
    getTeam: async (teamId, opts) => {
      calls.getTeam.push({
        teamId,
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
      });
      return detail;
    },
    postTeam: async (input) => {
      calls.postTeam.push(input);
      return postResult;
    },
  };
}
