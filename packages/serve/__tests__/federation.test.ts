/**
 * S7.1 federation 入站路由契约测试。
 *
 * 只覆盖高价值边界：peer bearer 命名空间、方向 / 身份、严格解析、hop / 环、
 * 重放去重、唯一一次写日志与写失败。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import { FEDERATION_MESSAGES_PATH, type FederationGatewayOptions } from '../src/federation';
import type { Gateway } from '../src/gateway';
import { startGateway } from '../src/gateway';
import type {
  TeamControlLike,
  TeamDetailLike,
  TeamMemberLike,
  TeamPostResultLike,
  TeamSummaryLike,
} from '../src/team-control';
import { createGatewayEventHub, type TenantEventHub } from '../src/tenant-event-hub';

const PEER_TOKEN = 'peer-secret-token';
const LOCAL_NODE = 'node-b';
const REMOTE_NODE = 'node-a';
const TEAM = 'team-a';

class FakeTeams implements TeamControlLike {
  readonly tenantId: string;
  readonly posts: Array<Parameters<TeamControlLike['post']>[0]> = [];
  failPost = false;
  readonly known = new Set([TEAM]);
  /** S7.2：可配置 roster 与 Team policy（`team.team.policy`）。 */
  roster: TeamMemberLike[] = [];
  policy?: Record<string, unknown>;

  constructor(tenantId = 'default') {
    this.tenantId = tenantId;
  }

  async list(): Promise<TeamSummaryLike[]> {
    return [];
  }

  async get(teamId: string): Promise<TeamDetailLike | undefined> {
    if (!this.known.has(teamId)) return undefined;
    return {
      team: {
        team_id: teamId,
        name: teamId,
        tenant_id: this.tenantId,
        member_count: this.roster.length,
        online_count: 0,
        created_at: 0,
        ...(this.policy !== undefined ? { policy: this.policy } : {}),
      },
      members: this.roster,
      messages: [],
    };
  }

  async post(input: Parameters<TeamControlLike['post']>[0]): Promise<TeamPostResultLike> {
    if (this.failPost) {
      throw Object.assign(new Error('disk full'), { code: 'io_error' });
    }
    this.posts.push(input);
    const mentions = input.mentions ?? [];
    return {
      message_id: `local-${this.posts.length}`,
      team_id: input.team_id,
      kind: mentions.length > 0 ? 'mention' : 'post',
      mentions,
      delivered: mentions.map((agent_id) => ({ agent_id, status: 'queued' as const })),
      ts: 1,
      ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
    };
  }

  async members(): Promise<undefined> {
    return undefined;
  }
}

const gateways: Gateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
});

function federationOptions(
  overrides: Partial<FederationGatewayOptions> = {},
): FederationGatewayOptions {
  return {
    enabled: true,
    nodeId: LOCAL_NODE,
    maxHops: 4,
    peers: [{ node_id: REMOTE_NODE, team_id: TEAM, direction: 'both', token: PEER_TOKEN }],
    ...overrides,
  };
}

function start(options: { federation?: FederationGatewayOptions; teams?: TeamControlLike } = {}): {
  gateway: Gateway;
  hub: TenantEventHub;
} {
  const hub = createGatewayEventHub({
    streams: [{ tenantId: 'default', stream: new MemoryEventStream() }],
  });
  const gateway = startGateway({
    hub,
    port: 0,
    ...(options.federation !== undefined ? { federation: options.federation } : {}),
    ...(options.teams !== undefined ? { teams: options.teams } : {}),
  });
  gateways.push(gateway);
  return { gateway, hub };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'vessel.federation/1',
    message_id: 'msg-1',
    conversation_id: 'conv-1',
    from: { node_id: REMOTE_NODE, team_id: TEAM },
    to: { node_id: LOCAL_NODE, team_id: TEAM },
    content: 'hello',
    ts: 1_700_000_000_000,
    hop: 1,
    ...overrides,
  };
}

async function post(
  gateway: Gateway,
  body: unknown,
  token: string | null = PEER_TOKEN,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${gateway.url}${FEDERATION_MESSAGES_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe(code);
}

function eventsOf(hub: TenantEventHub, type: string) {
  return hub
    .since(0)
    .map((item) => item.event)
    .filter((event) => event.type === type);
}

describe('federation inbound route (S7.1)', () => {
  it('returns 404 when the endpoint is not injected or disabled', async () => {
    const absent = start();
    await expectError(await post(absent.gateway, envelope()), 404, 'not_found');

    const disabled = start({ federation: federationOptions({ enabled: false }) });
    await expectError(await post(disabled.gateway, envelope()), 404, 'not_found');
  });

  it('requires a peer bearer and never accepts the gateway user token', async () => {
    const teams = new FakeTeams();
    const { gateway, hub } = start({ federation: federationOptions(), teams });

    await expectError(await post(gateway, envelope(), null), 401, 'federation_unauthorized');
    await expectError(
      await post(gateway, envelope(), gateway.token),
      401,
      'federation_unauthorized',
    );
    await expectError(await post(gateway, envelope(), 'wrong'), 401, 'federation_unauthorized');

    expect(teams.posts).toHaveLength(0);
    expect(eventsOf(hub, 'federation.received')).toHaveLength(0);
    expect(eventsOf(hub, 'federation.rejected')).toHaveLength(3);
  });

  it('rejects a peer whose direction does not include inbound', async () => {
    const teams = new FakeTeams();
    const federation = federationOptions({
      peers: [{ node_id: REMOTE_NODE, team_id: TEAM, direction: 'out', token: PEER_TOKEN }],
    });
    const { gateway } = start({ federation, teams });

    await expectError(await post(gateway, envelope()), 403, 'federation_not_allowed');
    expect(teams.posts).toHaveLength(0);
  });

  it('binds the message origin to the authenticated peer', async () => {
    const teams = new FakeTeams();
    const { gateway } = start({ federation: federationOptions(), teams });

    await expectError(
      await post(gateway, envelope({ from: { node_id: 'node-x', team_id: TEAM } })),
      403,
      'federation_not_allowed',
    );
    await expectError(
      await post(gateway, envelope({ from: { node_id: REMOTE_NODE, team_id: 'other' } })),
      403,
      'federation_not_allowed',
    );
    expect(teams.posts).toHaveLength(0);
  });

  it('strictly rejects unknown, missing, mistyped, and out-of-range fields', async () => {
    const teams = new FakeTeams();
    const { gateway } = start({ federation: federationOptions(), teams });

    const cases: Array<Record<string, unknown>> = [
      envelope({ mentions: ['agent-1'] }),
      envelope({ answered_by: 'agent' }),
      envelope({ from: { node_id: REMOTE_NODE, team_id: TEAM, agent_id: 'a' } }),
      envelope({ message_id: 'bad id' }),
      envelope({ conversation_id: '' }),
      envelope({ ts: '1700000000000' }),
      envelope({ hop: 0 }),
      envelope({ content: '' }),
      envelope({ content: 'x'.repeat(65_537) }),
    ];
    deleteCases(cases);

    for (const body of cases) {
      await expectError(await post(gateway, body), 400, 'federation_invalid');
    }
    expect(teams.posts).toHaveLength(0);
  });

  it('rejects hop over the configured budget', async () => {
    const teams = new FakeTeams();
    const { gateway } = start({ federation: federationOptions({ maxHops: 4 }), teams });

    await expectError(await post(gateway, envelope({ hop: 5 })), 409, 'federation_hop_exceeded');
    expect(teams.posts).toHaveLength(0);
  });

  it('detects a message claiming to originate from this node', async () => {
    const teams = new FakeTeams();
    const federation = federationOptions({
      peers: [{ node_id: LOCAL_NODE, team_id: TEAM, direction: 'both', token: PEER_TOKEN }],
    });
    const { gateway } = start({ federation, teams });

    await expectError(
      await post(gateway, envelope({ from: { node_id: LOCAL_NODE, team_id: TEAM } })),
      409,
      'federation_cycle_detected',
    );
    expect(teams.posts).toHaveLength(0);
  });

  it('returns team_not_found when the local team is missing or not injected', async () => {
    // to 必须与 peer 配置一致；这里让本机 Team 实际不存在。
    const missingTeams = new FakeTeams();
    missingTeams.known.delete(TEAM);
    const missing = start({ federation: federationOptions(), teams: missingTeams });
    await expectError(await post(missing.gateway, envelope()), 404, 'team_not_found');

    const noTeams = start({ federation: federationOptions() });
    await expectError(await post(noTeams.gateway, envelope()), 404, 'team_not_found');

    const foreignTenant = start({
      federation: federationOptions(),
      teams: new FakeTeams('other'),
    });
    await expectError(await post(foreignTenant.gateway, envelope()), 404, 'team_not_found');
  });

  it('writes one log entry and emits received without content or token', async () => {
    const teams = new FakeTeams();
    const { gateway, hub } = start({ federation: federationOptions(), teams });

    const response = await post(gateway, envelope());
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      protocol: 'vessel.federation/1',
      ok: true,
      message_id: 'local-1',
    });
    expect(typeof body.cursor).toBe('string');

    expect(teams.posts).toEqual([
      {
        team_id: TEAM,
        content: 'hello',
        from: `federation:${REMOTE_NODE}:${TEAM}`,
        mentions: [],
        conversation_id: 'conv-1',
      },
    ]);

    const received = eventsOf(hub, 'federation.received');
    expect(received).toHaveLength(1);
    expect(received[0]?.data).toEqual({
      message_id: 'msg-1',
      local_message_id: 'local-1',
      from_node: REMOTE_NODE,
      from_team: TEAM,
      team_id: TEAM,
      hop: 1,
      mode: 'log',
      delivered: 0,
    });
    const serialized = JSON.stringify(received);
    expect(serialized).not.toContain('hello');
    expect(serialized).not.toContain(PEER_TOKEN);
  });

  it('uses the peer-configured localTeamId and rejects any other target', async () => {
    const teams = new FakeTeams();
    teams.known.add('lab');
    // peer 的远端 identity 是 research；本机落点由 localTeamId 决定。
    const federation = federationOptions({
      peers: [
        {
          node_id: REMOTE_NODE,
          team_id: 'research',
          direction: 'both',
          localTeamId: 'lab',
          token: PEER_TOKEN,
        },
      ],
    });
    const { gateway, hub } = start({ federation, teams });
    const from = { node_id: REMOTE_NODE, team_id: 'research' };

    // to.team_id 必须等于 peer 配置的落点，不能由报文自选其它本机 Team。
    for (const target of ['research', 'other']) {
      await expectError(
        await post(gateway, envelope({ from, to: { node_id: LOCAL_NODE, team_id: target } })),
        403,
        'federation_not_allowed',
      );
    }
    expect(teams.posts).toHaveLength(0);

    const response = await post(
      gateway,
      envelope({ from, to: { node_id: LOCAL_NODE, team_id: 'lab' } }),
    );
    expect(response.status).toBe(202);
    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]?.team_id).toBe('lab');
    expect(eventsOf(hub, 'federation.received')[0]?.data).toMatchObject({ team_id: 'lab' });
  });

  it('deduplicates replays and keeps the first local id and cursor', async () => {
    const teams = new FakeTeams();
    const { gateway } = start({ federation: federationOptions(), teams });

    const first = (await (await post(gateway, envelope())).json()) as Record<string, unknown>;
    const replay = await post(gateway, envelope());
    expect(replay.status).toBe(200);
    const body = (await replay.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      protocol: 'vessel.federation/1',
      ok: true,
      deduplicated: true,
      message_id: first.message_id,
      cursor: first.cursor,
    });
    expect(teams.posts).toHaveLength(1);
  });

  it('returns 500 and does not cache when the team log write fails', async () => {
    const teams = new FakeTeams();
    teams.failPost = true;
    const { gateway, hub } = start({ federation: federationOptions(), teams });

    await expectError(await post(gateway, envelope()), 500, 'team_log_write_failed');
    expect(teams.posts).toHaveLength(0);
    expect(eventsOf(hub, 'federation.received')).toHaveLength(0);
    const rejected = eventsOf(hub, 'federation.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.data).toMatchObject({
      direction: 'in',
      code: 'team_log_write_failed',
      peer_node: REMOTE_NODE,
      peer_team: TEAM,
    });
  });
});

describe('federation inbound route (S7.2 accept policy)', () => {
  function member(agentId: string, overrides: Partial<TeamMemberLike> = {}): TeamMemberLike {
    return {
      agent_id: agentId,
      session_id: `${agentId}-session`,
      membership: 'present',
      presence: 'gone',
      visibility: 'team',
      state: 'idle',
      epoch: 0,
      ...overrides,
    };
  }

  it('fans out once to present non-private members when accept is "members"', async () => {
    const teams = new FakeTeams();
    teams.policy = { federation: { accept: 'members' } };
    teams.roster = [
      member('agent-a'),
      member('agent-private', { visibility: 'private' }),
      member('agent-left', { membership: 'left' }),
      member('agent-b', { visibility: 'tenant' }),
      member('agent-a'),
    ];
    const { gateway, hub } = start({ federation: federationOptions(), teams });

    const response = await post(gateway, envelope());
    expect(response.status).toBe(202);
    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]).toMatchObject({
      team_id: TEAM,
      from: `federation:${REMOTE_NODE}:${TEAM}`,
      mentions: ['agent-a', 'agent-b'],
    });

    const received = eventsOf(hub, 'federation.received');
    expect(received).toHaveLength(1);
    expect(received[0]?.data).toMatchObject({ mode: 'members', delivered: 2 });
    const serialized = JSON.stringify(received);
    expect(serialized).not.toContain('hello');
    expect(serialized).not.toContain(PEER_TOKEN);
  });

  it('falls back to log for an invalid accept value (fail safe)', async () => {
    const teams = new FakeTeams();
    teams.policy = { federation: { accept: 'all' } };
    teams.roster = [member('agent-a')];
    const { gateway, hub } = start({ federation: federationOptions(), teams });

    expect((await post(gateway, envelope())).status).toBe(202);
    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]?.mentions).toEqual([]);
    expect(eventsOf(hub, 'federation.received')[0]?.data).toMatchObject({
      mode: 'log',
      delivered: 0,
    });
  });

  it('sends an empty mentions list when the roster has no eligible members', async () => {
    const teams = new FakeTeams();
    teams.policy = { federation: { accept: 'members' } };
    teams.roster = [
      member('agent-private', { visibility: 'private' }),
      member('agent-left', { membership: 'left' }),
    ];
    const { gateway, hub } = start({ federation: federationOptions(), teams });

    expect((await post(gateway, envelope())).status).toBe(202);
    expect(teams.posts).toHaveLength(1);
    expect(teams.posts[0]?.mentions).toEqual([]);
    expect(eventsOf(hub, 'federation.received')[0]?.data).toMatchObject({
      mode: 'members',
      delivered: 0,
    });
  });
});

/** `delete` 需要可变对象，单独处理“缺失字段”用例。 */
function deleteCases(cases: Array<Record<string, unknown>>): void {
  const missingConversation = envelope();
  delete missingConversation.conversation_id;
  cases.push(missingConversation);

  const missingContent = envelope();
  delete missingContent.content;
  cases.push(missingContent);
}
