/**
 * S8.3 federation team-info 契约测试（DECISION-037 §7.2）。
 *
 * 直接驱动 `createFederationRoute`，注入 fake `TeamControlLike`：
 * 只覆盖契约边界与静默故障——allowDirectory opt-in、脱敏、未知 Team、
 * members_limit 越界、默认窗口与排序、每 peer 限流。
 */

import { describe, expect, it } from 'bun:test';
import {
  createFederationRoute,
  FEDERATION_TEAM_INFO_PATH,
  type FederationGatewayOptions,
  type FederationGatewayPeer,
  type FederationRoute,
} from '../src/federation.js';
import type {
  TeamControlLike,
  TeamDetailLike,
  TeamMemberLike,
  TeamPostResultLike,
  TeamSummaryLike,
} from '../src/team-control.js';

const PEER_TOKEN = 'peer-secret-token';
const LOCAL_NODE = 'node-b';
const REMOTE_NODE = 'node-a';
const TEAM = 'team-a';

class FakeTeams implements TeamControlLike {
  readonly tenantId = 'default';
  team: TeamDetailLike | undefined;
  /** 完整 roster；缺省回退到 `team.members`（模拟真实 TeamService 的窗口 get）。 */
  rosterMembers: TeamMemberLike[] | undefined;
  reads = 0;
  posts = 0;

  async list(): Promise<TeamSummaryLike[]> {
    return [];
  }

  async get(teamId: string): Promise<TeamDetailLike | undefined> {
    this.reads += 1;
    return teamId === TEAM ? this.team : undefined;
  }

  async roster(): Promise<TeamMemberLike[]> {
    return this.rosterMembers ?? this.team?.members ?? [];
  }

  async post(): Promise<TeamPostResultLike> {
    this.posts += 1;
    throw new Error('team-info must not write');
  }

  async members(): Promise<undefined> {
    return undefined;
  }
}

function member(name: string | undefined, overrides: Partial<TeamMemberLike> = {}): TeamMemberLike {
  return {
    agent_id: `agent-${name ?? 'anon'}`,
    ...(name !== undefined ? { name } : {}),
    session_id: `sess-${name ?? 'anon'}`,
    team_id: TEAM,
    membership: 'present',
    presence: 'gone',
    visibility: 'team',
    state: 'idle',
    epoch: 0,
    ...overrides,
  };
}

function detail(
  members: TeamMemberLike[],
  overrides: Partial<TeamSummaryLike> = {},
): TeamDetailLike {
  return {
    team: {
      team_id: TEAM,
      name: 'Lab',
      tenant_id: 'default',
      workspace: '/secret/workspace',
      policy: { federation: { accept: 'principal' } },
      description: 'Where the lab meets',
      default_principal: 'alice',
      member_count: members.length,
      online_count: 0,
      created_at: 0,
      ...overrides,
    },
    members,
    messages: [],
  };
}

function routeFor(
  teams: TeamControlLike,
  peerOverrides: Partial<FederationGatewayPeer> = {},
  federationOverrides: Partial<FederationGatewayOptions> = {},
): FederationRoute {
  const peer: FederationGatewayPeer = {
    nodeId: REMOTE_NODE,
    teamId: TEAM,
    direction: 'both',
    token: PEER_TOKEN,
    ...peerOverrides,
  };
  return createFederationRoute({
    federation: {
      enabled: true,
      nodeId: LOCAL_NODE,
      maxHops: 4,
      peers: [peer],
      ...federationOverrides,
    },
    teams,
  });
}

async function teamInfo(
  route: FederationRoute,
  body: unknown,
  token: string | null = PEER_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await route.handle(
    new Request(`http://${LOCAL_NODE}${FEDERATION_TEAM_INFO_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  if (response === null) throw new Error('team-info route returned null');
  return response;
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'vessel.federation/1',
    team_id: TEAM,
    ...overrides,
  };
}

describe('federation team-info', () => {
  it('returns 404 when allowDirectory is not explicitly true', async () => {
    const teams = new FakeTeams();
    teams.team = detail([member('alice')]);
    const response = await teamInfo(routeFor(teams), request());
    expect(response.status).toBe(404);
    expect(teams.reads).toBe(0);
  });

  it('returns a redacted directory for present, non-private named members', async () => {
    const teams = new FakeTeams();
    teams.team = detail([
      member('alice', { presence: 'live', last_seen: 200 }),
      member('bob', { membership: 'left', last_seen: 100 }),
      member('hidden', { visibility: 'private', presence: 'live', last_seen: 300 }),
      member(undefined),
      member('carol', { presence: 'gone', last_seen: 50 }),
    ]);
    const response = await teamInfo(routeFor(teams, { allowDirectory: true }), request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      protocol: 'vessel.federation/1',
      team_id: TEAM,
      name: 'Lab',
      description: 'Where the lab meets',
      default_principal: 'alice',
      member_count: 2,
      online_count: 1,
      members: [
        { name: 'alice', presence: 'live', last_seen: 200 },
        { name: 'carol', presence: 'gone', last_seen: 50 },
      ],
    });
    // 绝不返回内部字段 / private 名字。
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('agent-');
    expect(serialized).not.toContain('/secret/workspace');
    expect(serialized).not.toContain('policy');
    expect(serialized).not.toContain('hidden');
  });

  it('omits default_principal when it is neither owner nor a visible member', async () => {
    const teams = new FakeTeams();
    teams.team = detail([member('alice')], { default_principal: 'ghost' });
    const response = await teamInfo(routeFor(teams, { allowDirectory: true }), request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.default_principal).toBeUndefined();
  });

  it('returns 404 for a non-configured team or a missing local Team', async () => {
    const teams = new FakeTeams();
    teams.team = detail([member('alice')]);
    const route = routeFor(teams, { allowDirectory: true });
    expect((await teamInfo(route, request({ team_id: 'other-team' }))).status).toBe(404);

    const missing = new FakeTeams();
    const missingResponse = await teamInfo(routeFor(missing, { allowDirectory: true }), request());
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toMatchObject({
      error: { code: 'federation_unknown_team' },
    });
  });

  it('rejects an out-of-range or non-integer members_limit with 400', async () => {
    const teams = new FakeTeams();
    teams.team = detail([member('alice')]);
    const route = routeFor(teams, { allowDirectory: true });
    for (const members_limit of [0, 101, 1.5, '10']) {
      const response = await teamInfo(route, request({ members_limit }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'federation_invalid' } });
    }
    expect(teams.reads).toBe(0);
  });

  it('defaults to 20 members, live first, then last_seen desc, then name', async () => {
    const teams = new FakeTeams();
    const members: TeamMemberLike[] = [];
    // gone 成员 last_seen 更大，仍排在 live 之后。
    members.push(member('zeta', { presence: 'live', last_seen: 10 }));
    members.push(member('alpha', { presence: 'gone', last_seen: 9_999 }));
    for (let i = 0; i < 22; i += 1) {
      // 偶数 live / 奇数 gone；last_seen 随 index 递减。
      members.push(
        member(`m${String(i).padStart(2, '0')}`, {
          presence: i % 2 === 0 ? 'live' : 'gone',
          last_seen: 1_000 - i,
        }),
      );
    }
    teams.team = detail(members);
    const response = await teamInfo(routeFor(teams, { allowDirectory: true }), request());
    const body = (await response.json()) as {
      member_count: number;
      online_count: number;
      members: Array<{ name: string; presence: string; last_seen?: number }>;
    };
    expect(body.member_count).toBe(24);
    expect(body.members).toHaveLength(20);
    // live 段内 last_seen 降序：m00 (1000) > m02 (998) > ... > zeta (10)。
    expect(body.members[0]).toMatchObject({ name: 'm00', presence: 'live' });
    expect(body.members[1]).toMatchObject({ name: 'm02', presence: 'live' });
    expect(body.members[1]?.last_seen).toBe(998);
    expect(body.members[11]).toMatchObject({ name: 'zeta', presence: 'live' });
    // 即使 gone 的 last_seen 更大，也排在 live 之后。
    expect(body.members[12]).toMatchObject({ name: 'alpha', presence: 'gone' });
    // 截断后不包含最旧的 gone 成员。
    expect(body.members.some((entry) => entry.name === 'm21')).toBe(false);
  });

  it('counts the full roster even when get returns a windowed member list', async () => {
    const teams = new FakeTeams();
    const all = Array.from({ length: 25 }, (_, index) =>
      member(`m${String(index).padStart(2, '0')}`, {
        presence: index % 2 === 0 ? 'live' : 'gone',
        last_seen: 1_000 - index,
      }),
    );
    // 真实 TeamService.get 缺省把 members 截到 20；计数必须仍来自完整 roster。
    teams.team = detail(all.slice(0, 20));
    teams.rosterMembers = all;
    const response = await teamInfo(routeFor(teams, { allowDirectory: true }), request());
    const body = (await response.json()) as {
      member_count: number;
      online_count: number;
      members: Array<{ name: string }>;
    };
    expect(body.member_count).toBe(25);
    expect(body.online_count).toBe(13);
    expect(body.members).toHaveLength(20);
  });

  it('rejects unknown keys and invalid bearer before any Team read', async () => {
    const teams = new FakeTeams();
    teams.team = detail([member('alice')]);
    const route = routeFor(teams, { allowDirectory: true });
    const unknown = await teamInfo(route, request({ principal: 'alice' }));
    expect(unknown.status).toBe(400);
    const unauthorized = await teamInfo(route, request(), 'wrong-token');
    expect(unauthorized.status).toBe(401);
    const inboundOnly = await teamInfo(
      routeFor(teams, { allowDirectory: true, direction: 'out' }),
      request(),
    );
    expect(inboundOnly.status).toBe(403);
    expect(teams.reads).toBe(0);
  });

  it('applies the per-peer inbound rate limit with no reads after 429', async () => {
    const teams = new FakeTeams();
    teams.team = detail([member('alice')]);
    const route = routeFor(teams, { allowDirectory: true }, { rateLimitPerMinute: 1 });
    expect((await teamInfo(route, request())).status).toBe(200);
    const limited = await teamInfo(route, request());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'federation_rate_limited' } });
    expect(teams.reads).toBe(1);
    expect(teams.posts).toBe(0);
  });
});
