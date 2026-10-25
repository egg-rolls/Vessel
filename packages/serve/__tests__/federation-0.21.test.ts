/**
 * S8.1 federation 入站单点寻址契约测试（DECISION-037 §5 / §9）。
 *
 * 直接驱动 `createFederationRoute`，注入 fake `TeamControlLike`，不启动 gateway：
 * 只覆盖契约边界与静默故障——单成员命中 / private / left / closed / 重名 /
 * owner / accept:'log' / 运行时非法 accept 不 fan-out / 每 peer 限流。
 */

import { describe, expect, it } from 'bun:test';
import {
  createFederationRoute,
  FEDERATION_MESSAGES_PATH,
  type FederationGatewayOptions,
  type FederationRoute,
} from '../src/federation.js';
import type {
  TeamControlLike,
  TeamDeliveryLike,
  TeamDetailLike,
  TeamMemberLike,
  TeamPostResultLike,
  TeamSummaryLike,
} from '../src/team-control.js';

const PEER_TOKEN = 'peer-secret-token';
const LOCAL_NODE = 'node-b';
const REMOTE_NODE = 'node-a';
const TEAM = 'team-a';

type RouteEvent = { type: string; data: Record<string, unknown> };

class FakeTeams implements TeamControlLike {
  readonly tenantId = 'default';
  readonly posts: Array<Parameters<TeamControlLike['post']>[0]> = [];
  rosterMembers: TeamMemberLike[] = [];
  policy?: Record<string, unknown>;
  /** 模拟 TeamService.get 的展示窗口；roster() 始终返回完整列表。 */
  getWindow?: number;
  /** 模拟 TeamService 的 dispatch 结果；缺省 = 每个 mention 都 queued。 */
  deliveredOverride?: TeamDeliveryLike[];

  async create(): Promise<never> {
    throw new Error('create is not used by federation tests');
  }

  async update(): Promise<never> {
    throw new Error('update is not used by federation tests');
  }

  async archive(): Promise<never> {
    throw new Error('archive is not used by federation tests');
  }

  async setSpawnFrozen(): Promise<never> {
    throw new Error('spawnFrozen is not used by federation tests');
  }

  async list(): Promise<TeamSummaryLike[]> {
    return [];
  }

  async get(teamId: string): Promise<TeamDetailLike | undefined> {
    if (teamId !== TEAM) return undefined;
    return {
      team: {
        team_id: TEAM,
        name: TEAM,
        tenant_id: this.tenantId,
        member_count: this.rosterMembers.length,
        online_count: 0,
        created_at: 0,
        ...(this.policy !== undefined ? { policy: this.policy } : {}),
      },
      members: this.rosterMembers.slice(0, this.getWindow ?? this.rosterMembers.length),
      messages: [],
    };
  }

  async roster(): Promise<TeamMemberLike[]> {
    return this.rosterMembers;
  }

  async post(input: Parameters<TeamControlLike['post']>[0]): Promise<TeamPostResultLike> {
    this.posts.push(input);
    const mentions = input.mentions ?? [];
    return {
      message_id: `local-${this.posts.length}`,
      team_id: input.team_id,
      kind: mentions.length > 0 ? 'mention' : 'post',
      mentions,
      delivered:
        this.deliveredOverride ??
        mentions.map((agent_id) => ({ agent_id, status: 'queued' as const })),
      ts: 1,
      ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
    };
  }

  async members(): Promise<undefined> {
    return undefined;
  }
}

function member(name: string, overrides: Partial<TeamMemberLike> = {}): TeamMemberLike {
  return {
    agent_id: `agent-${name}`,
    name,
    session_id: `agent-${name}-session`,
    team_id: TEAM,
    membership: 'present',
    presence: 'gone',
    visibility: 'team',
    state: 'idle',
    epoch: 0,
    ...overrides,
  };
}

function federationOptions(
  overrides: Partial<FederationGatewayOptions> = {},
): FederationGatewayOptions {
  return {
    enabled: true,
    nodeId: LOCAL_NODE,
    maxHops: 4,
    peers: [{ nodeId: REMOTE_NODE, teamId: TEAM, direction: 'both', token: PEER_TOKEN }],
    ...overrides,
  };
}

function createRoute(
  teams: TeamControlLike,
  federation: Partial<FederationGatewayOptions> = {},
): { route: FederationRoute; events: RouteEvent[] } {
  const events: RouteEvent[] = [];
  const route = createFederationRoute({
    federation: federationOptions(federation),
    teams,
    publish: (type, data) => events.push({ type, data }),
  });
  return { route, events };
}

function envelope(
  messageId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol: 'vessel.federation/1',
    message_id: messageId,
    conversation_id: 'conv-1',
    from: { node_id: REMOTE_NODE, team_id: TEAM, principal: 'alice' },
    to: { node_id: LOCAL_NODE, team_id: TEAM, principal: 'bob' },
    content: 'hello',
    ts: 1_700_000_000_000,
    hop: 1,
    ...overrides,
  };
}

async function send(
  route: FederationRoute,
  body: unknown,
  token: string | null = PEER_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await route.handle(
    new Request(`http://${LOCAL_NODE}${FEDERATION_MESSAGES_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  if (response === null) throw new Error('federation route returned null');
  return response;
}

function received(events: RouteEvent[]): RouteEvent[] {
  return events.filter((event) => event.type === 'federation.received');
}

function rejected(events: RouteEvent[]): RouteEvent[] {
  return events.filter((event) => event.type === 'federation.rejected');
}

describe('federation inbound addressing (S8.1)', () => {
  it('V4: resolves a present member to exactly one mention and one queued delivery', async () => {
    const teams = new FakeTeams();
    teams.rosterMembers = [member('bob', { presence: 'live', visibility: 'tenant' })];
    const { route, events } = createRoute(teams);

    const response = await send(route, envelope('msg-hit'));
    expect(response.status).toBe(202);

    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]).toMatchObject({
      team_id: TEAM,
      content: 'hello',
      from: `federation:alice@${REMOTE_NODE}:${TEAM}`,
      mentions: ['agent-bob'],
      conversation_id: 'conv-1',
      federation: {
        from_addr: `alice@${REMOTE_NODE}:${TEAM}`,
        to_addr: `bob@${LOCAL_NODE}:${TEAM}`,
        conversation_id: 'conv-1',
        hop: 1,
      },
    });
    expect(teams.posts[0]?.mentions).toHaveLength(1);

    const hits = received(events);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.data).toMatchObject({
      resolution: 'principal',
      principal: 'bob',
      delivered: 1,
      from_node: REMOTE_NODE,
      from_team: TEAM,
      team_id: TEAM,
      hop: 1,
    });
    expect(JSON.stringify(hits)).not.toContain('hello');
    expect(JSON.stringify(hits)).not.toContain(PEER_TOKEN);
  });

  it('V5: private / left / closed / missing / duplicate names are 404 with zero writes', async () => {
    const scenarios: Array<{ label: string; roster: TeamMemberLike[] }> = [
      { label: 'private', roster: [member('bob', { visibility: 'private' })] },
      { label: 'left', roster: [member('bob', { membership: 'left' })] },
      { label: 'closed', roster: [member('bob', { state: 'closed' })] },
      { label: 'missing', roster: [member('carol')] },
      { label: 'duplicate', roster: [member('bob'), member('bob', { agent_id: 'agent-bob-2' })] },
    ];

    for (const scenario of scenarios) {
      const teams = new FakeTeams();
      teams.rosterMembers = scenario.roster;
      const { route, events } = createRoute(teams);

      const response = await send(route, envelope(`msg-${scenario.label}`));
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('federation_unknown_principal');
      expect(body.error?.message ?? '').not.toContain('hello');

      expect(teams.posts).toHaveLength(0);
      expect(received(events)).toHaveLength(0);
      expect(rejected(events)[0]?.data).toMatchObject({
        code: 'federation_unknown_principal',
      });
    }
  });

  it('V6: a gone member is dispatched by TeamService, never fanned out', async () => {
    // resume 成功：1 个 queued delivery。
    const resumed = new FakeTeams();
    resumed.rosterMembers = [member('bob', { presence: 'gone' })];
    resumed.deliveredOverride = [
      { agent_id: 'agent-bob', status: 'queued', resolution: 'resumed' },
    ];
    const resumedRoute = createRoute(resumed);
    expect((await send(resumedRoute.route, envelope('msg-resumed'))).status).toBe(202);
    expect(resumed.posts).toHaveLength(1);
    expect(resumed.posts[0]?.mentions).toEqual(['agent-bob']);
    expect(received(resumedRoute.events)[0]?.data).toMatchObject({
      resolution: 'principal',
      delivered: 1,
    });

    // resume + fork 都失败：TeamService 写日志 + attention，0 run；路由仍只有 1 条 mention。
    const unavailable = new FakeTeams();
    unavailable.rosterMembers = [member('bob', { presence: 'gone' })];
    unavailable.deliveredOverride = [];
    const failedRoute = createRoute(unavailable);
    expect((await send(failedRoute.route, envelope('msg-gone'))).status).toBe(202);
    expect(unavailable.posts).toHaveLength(1);
    expect(unavailable.posts[0]?.mentions).toEqual(['agent-bob']);
    expect(received(failedRoute.events)[0]?.data).toMatchObject({
      resolution: 'principal',
      delivered: 0,
    });
  });

  it('V7: owner resolves to a log-only post with to=[owner] and zero runs', async () => {
    const teams = new FakeTeams();
    const { route, events } = createRoute(teams);

    const response = await send(
      route,
      envelope('msg-owner', {
        to: { node_id: LOCAL_NODE, team_id: TEAM, principal: 'human' },
      }),
    );
    expect(response.status).toBe(202);

    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]).toMatchObject({
      mentions: [],
      to: ['human'],
      content: 'hello',
      from: `federation:alice@${REMOTE_NODE}:${TEAM}`,
      federation: { to_addr: `human@${LOCAL_NODE}:${TEAM}` },
    });
    expect(received(events)[0]?.data).toMatchObject({
      resolution: 'human',
      principal: 'human',
      delivered: 0,
    });
  });

  it('resolves a principal outside the 20-member display window', async () => {
    const teams = new FakeTeams();
    teams.policy = { federation: { accept: 'principal' } };
    // get 只返回前 20 名（模拟 TeamService 缺省窗口）；roster() 返回完整 25 名。
    teams.getWindow = 20;
    teams.rosterMembers = Array.from({ length: 25 }, (_, index) =>
      member(`m${String(index).padStart(2, '0')}`, { presence: 'live' }),
    );
    const { route, events } = createRoute(teams);

    const response = await send(
      route,
      envelope('msg-25', {
        to: { node_id: LOCAL_NODE, team_id: TEAM, principal: 'm24' },
      }),
    );
    expect(response.status).toBe(202);
    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]?.mentions).toEqual(['agent-m24']);
    expect(received(events)[0]?.data).toMatchObject({
      resolution: 'principal',
      principal: 'm24',
      delivered: 1,
    });
  });

  it('unknown accept values fall back to log and never dispatch', async () => {
    const teams = new FakeTeams();
    teams.policy = { federation: { accept: 'all' } };
    teams.rosterMembers = [member('bob', { presence: 'live' })];
    const { route, events } = createRoute(teams);

    const response = await send(route, envelope('msg-unknown-accept'));
    expect(response.status).toBe(202);
    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]?.mentions).toEqual([]);
    expect(received(events)[0]?.data).toMatchObject({ resolution: 'log', delivered: 0 });
  });

  it("V8: accept:'log' is log-only; a runtime 'members' value fails explicitly", async () => {
    const logTeams = new FakeTeams();
    logTeams.rosterMembers = [member('bob', { presence: 'live' })];
    logTeams.policy = { federation: { accept: 'log' } };
    const logRoute = createRoute(logTeams);

    expect((await send(logRoute.route, envelope('msg-log'))).status).toBe(202);
    expect(logTeams.posts).toHaveLength(1);
    expect(logTeams.posts[0]?.mentions).toEqual([]);
    expect(logTeams.posts[0]).not.toHaveProperty('to');
    expect(received(logRoute.events)[0]?.data).toMatchObject({
      resolution: 'log',
      delivered: 0,
    });

    // 删除的 'members' 语义必须明确失败，不能 salvage 成 principal 后静默投递。
    const invalidTeams = new FakeTeams();
    invalidTeams.rosterMembers = [
      member('bob', { presence: 'live' }),
      member('carol', { presence: 'live' }),
    ];
    invalidTeams.policy = { federation: { accept: 'members' } };
    const invalidRoute = createRoute(invalidTeams);

    const invalid = await send(invalidRoute.route, envelope('msg-members'));
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toMatchObject({
      error: {
        code: 'members_not_supported',
        message: expect.stringContaining('use "principal" or "log"'),
      },
    });
    expect(invalidTeams.posts).toHaveLength(0);
    expect(received(invalidRoute.events)).toHaveLength(0);
  });

  it('V11: rate limit is per peer, rejects before body read, and 0 is not unlimited', async () => {
    const teams = new FakeTeams();
    teams.policy = { federation: { accept: 'log' } };
    const { route, events } = createRoute(teams, { rateLimitPerMinute: 1 });

    expect((await send(route, envelope('msg-1'))).status).toBe(202);
    const limited = await send(route, envelope('msg-2'));
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('federation_rate_limited');

    // 第二条既不写 Team 日志，也不发 received；body 未被解析（内容随便也能 429）。
    expect(teams.posts).toHaveLength(1);
    expect(received(events)).toHaveLength(1);
    const garbage = new Request(`http://${LOCAL_NODE}${FEDERATION_MESSAGES_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PEER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    });
    const garbageResponse = await route.handle(garbage);
    expect(garbageResponse?.status).toBe(429);

    // 0 不是“不限制”：配置层已拒绝；运行时按 fail closed 处理。
    const zeroTeams = new FakeTeams();
    zeroTeams.policy = { federation: { accept: 'log' } };
    const zero = createRoute(zeroTeams, { rateLimitPerMinute: 0 });
    expect((await send(zero.route, envelope('msg-a'))).status).toBe(429);
    expect(zeroTeams.posts).toHaveLength(0);
  });
});

describe('federation wire principal (S8.1)', () => {
  it('distinguishes a missing to.principal from an invalid from.principal', async () => {
    const teams = new FakeTeams();
    const { route } = createRoute(teams);

    const missingTo = await send(
      route,
      envelope('msg-missing-to', { to: { node_id: LOCAL_NODE, team_id: TEAM } }),
    );
    expect(missingTo.status).toBe(400);
    expect(((await missingTo.json()) as { error?: { code?: string } }).error?.code).toBe(
      'federation_principal_required',
    );

    const missingFrom = await send(
      route,
      envelope('msg-missing-from', { from: { node_id: REMOTE_NODE, team_id: TEAM } }),
    );
    expect(missingFrom.status).toBe(400);
    expect(((await missingFrom.json()) as { error?: { code?: string } }).error?.code).toBe(
      'federation_invalid',
    );

    const invalidPrincipal = await send(
      route,
      envelope('msg-bad-principal', {
        to: { node_id: LOCAL_NODE, team_id: TEAM, principal: 'bob smith' },
      }),
    );
    expect(invalidPrincipal.status).toBe(400);
    expect(((await invalidPrincipal.json()) as { error?: { code?: string } }).error?.code).toBe(
      'federation_invalid',
    );

    expect(teams.posts).toHaveLength(0);
  });

  it('rejects a duplicated peer token instead of routing to the last peer', async () => {
    const teams = new FakeTeams();
    teams.rosterMembers = [member('bob')];
    const { route, events } = createRoute(teams, {
      peers: [
        { nodeId: REMOTE_NODE, teamId: TEAM, direction: 'both', token: PEER_TOKEN },
        { nodeId: 'node-c', teamId: TEAM, direction: 'both', token: PEER_TOKEN },
      ],
    });

    const response = await send(route, envelope('msg-dup-token'));
    expect(response.status).toBe(401);
    expect(teams.posts).toHaveLength(0);
    expect(received(events)).toHaveLength(0);
  });

  it('does not compare from.principal with the peer identity (node-level trust)', async () => {
    const teams = new FakeTeams();
    teams.policy = { federation: { accept: 'log' } };
    const { route } = createRoute(teams);

    const response = await send(
      route,
      envelope('msg-principal', {
        from: { node_id: REMOTE_NODE, team_id: TEAM, principal: 'mallory' },
      }),
    );
    expect(response.status).toBe(202);
    expect(teams.posts[0]?.from).toBe(`federation:mallory@${REMOTE_NODE}:${TEAM}`);
  });
});
