import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { createTeamMethods } from '../src/gateway/methods/teams';
import { createLocalRpcDispatcher } from '../src/local';
import { RpcError, type RpcMethodContext } from '../src/rpc';
import type {
  TeamControlLike,
  TeamDeliveryLike,
  TeamDetailLike,
  TeamMemberLike,
  TeamMembersResultLike,
  TeamMessageLike,
  TeamPostResultLike,
  TeamSummaryLike,
} from '../src/team-control';
import type { GatewayAuthLike, TenantPrincipal } from '../src/tenant';
import { createGatewayEventHub } from '../src/tenant-event-hub';
import { createGateway, startTestGateway as startGateway } from './helpers';

type ListOptions = Parameters<TeamControlLike['list']>[0];
type GetOptions = Parameters<TeamControlLike['get']>[1];
type PostInput = Parameters<TeamControlLike['post']>[0];
type MembersInput = Parameters<TeamControlLike['members']>[0];

const summary: TeamSummaryLike = {
  team_id: 'team-alpha',
  name: 'Alpha',
  tenant_id: 'default',
  workspace: '/tmp/alpha',
  policy: { allowFork: false },
  member_count: 1,
  online_count: 1,
  created_at: 1000,
};

const bravoSummary: TeamSummaryLike = {
  team_id: 'team-bravo',
  name: 'Bravo',
  tenant_id: 'default',
  workspace: '/tmp/bravo',
  policy: { allowFork: true },
  member_count: 0,
  online_count: 0,
  created_at: 1001,
};

const member: TeamMemberLike = {
  agent_id: 'agent-1',
  name: 'alpha',
  session_id: 'sess-1',
  team_id: 'team-alpha',
  membership: 'present',
  presence: 'live',
  visibility: 'team',
  state: 'idle',
  epoch: 1,
  body_history: [{ session_id: 'sess-0', epoch: 0, started_at: 900, retired_at: 950 }],
};

const message: TeamMessageLike = {
  message_id: 'msg-1',
  team_id: 'team-alpha',
  from: 'human',
  to: [],
  mentions: [],
  content: 'hello',
  ts: 2000,
  kind: 'post',
};

const reply: TeamMessageLike = {
  message_id: 'msg-2',
  team_id: 'team-alpha',
  from: 'agent-1',
  to: [],
  mentions: [],
  content: 'done',
  ts: 2100,
  kind: 'reply',
};

const detail: TeamDetailLike = {
  team: summary,
  members: [member],
  messages: [message, reply],
};

const bravoDetail: TeamDetailLike = {
  team: bravoSummary,
  members: [],
  messages: [],
};

class FakeTeamControl implements TeamControlLike {
  readonly tenantId: string;
  /** 任意一次调用抛出的异常（测试错误映射）。 */
  failWith: unknown;
  readonly calls = {
    list: [] as ListOptions[],
    get: [] as Array<{ teamId: string; options: GetOptions }>,
    post: [] as PostInput[],
    members: [] as MembersInput[],
  };

  constructor(tenantId = 'default', failWith?: unknown) {
    this.tenantId = tenantId;
    this.failWith = failWith;
  }

  private maybeFail(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }

  async list(options?: ListOptions): Promise<TeamSummaryLike[]> {
    this.calls.list.push(options);
    this.maybeFail();
    return [summary, bravoSummary];
  }

  async get(teamId: string, options?: GetOptions): Promise<TeamDetailLike | undefined> {
    this.calls.get.push({ teamId, options });
    this.maybeFail();
    if (teamId === summary.team_id) return detail;
    if (teamId === bravoSummary.team_id) return bravoDetail;
    return undefined;
  }

  async post(input: PostInput): Promise<TeamPostResultLike> {
    this.calls.post.push(input);
    this.maybeFail();
    const mentions = input.mentions ?? [];
    const delivered: TeamDeliveryLike[] = mentions.map((agentId) => ({
      agent_id: agentId,
      status: 'queued',
      message_id: 'msg-2',
      resolution: 'live',
    }));
    return {
      message_id: 'msg-2',
      team_id: input.team_id,
      kind: mentions.length > 0 ? 'mention' : 'post',
      mentions,
      delivered,
      ts: 3000,
    };
  }

  async members(input: MembersInput): Promise<TeamMembersResultLike | undefined> {
    this.calls.members.push(input);
    this.maybeFail();
    if (input.member === 'missing') return undefined;
    return {
      team_id: input.team_id,
      action: input.action,
      agent_id: input.member,
      membership: input.action === 'add' ? 'present' : 'left',
    };
  }
}

function codedError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

async function dispatchOk(
  gateway: Gateway,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await gateway.rpc({
    v: 1,
    id: method,
    method,
    ...(params !== undefined ? { params } : {}),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result as Record<string, unknown>;
}

async function dispatchError(
  gateway: Gateway,
  method: string,
  params?: unknown,
): Promise<{ code: string; message: string; details?: unknown }> {
  const response = await gateway.rpc({
    v: 1,
    id: method,
    method,
    ...(params !== undefined ? { params } : {}),
  });
  if (response.ok) throw new Error(`expected ${method} to fail`);
  return response.error;
}

interface RawRpc {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

function envelope(id: string, method: string, params?: unknown): Record<string, unknown> {
  return { v: 1, id, method, ...(params !== undefined ? { params } : {}) };
}

async function rpcHttp(
  gateway: Gateway,
  body: Record<string, unknown>,
  token?: string,
): Promise<RawRpc> {
  const response = await fetch(`${gateway.url}/v1/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return (await response.json()) as RawRpc;
}

function authForRoles(): GatewayAuthLike {
  const entries: Record<string, { tenant_id: string; role: 'read' | 'write' | 'admin' }> = {
    reader: { tenant_id: 'default', role: 'read' },
    writer: { tenant_id: 'default', role: 'write' },
  };
  return {
    configured: true,
    legacyToken: 'legacy',
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

/** P0：team-scoped control token 与 admin 的对照映射。 */
function authForTeamScope(): GatewayAuthLike {
  const entries: Record<string, TenantPrincipal> = {
    'control-a': {
      tenant_id: 'default',
      role: 'write',
      scope: 'control',
      team_id: 'team-alpha',
    },
    'control-missing': {
      tenant_id: 'default',
      role: 'write',
      scope: 'control',
      team_id: 'team-missing',
    },
    'admin-token': { tenant_id: 'default', role: 'admin' },
  };
  return {
    configured: true,
    legacyToken: 'legacy',
    authenticate: (token) => (token === null ? null : (entries[token] ?? null)),
  };
}

const gateways: Gateway[] = [];
const previousFlag = process.env.VESSEL_VALIDATE_RESULTS;

afterEach(() => {
  for (const gateway of gateways.splice(0)) void gateway.stop();
  if (previousFlag === undefined) delete process.env.VESSEL_VALIDATE_RESULTS;
  else process.env.VESSEL_VALIDATE_RESULTS = previousFlag;
});

describe('teams.* without an injected control', () => {
  it('keeps all four methods in the manifest and returns not_found', async () => {
    const dispatcher = createLocalRpcDispatcher({ hub: createGatewayEventHub() });
    try {
      const names = dispatcher.manifest().methods.map((method) => method.name);
      expect(names).toEqual(
        expect.arrayContaining(['teams.list', 'teams.get', 'teams.post', 'teams.members']),
      );

      const calls: Array<[string, unknown]> = [
        ['teams.list', {}],
        ['teams.get', { team_id: 'team-alpha' }],
        ['teams.post', { team_id: 'team-alpha', content: 'hello' }],
        ['teams.members', { team_id: 'team-alpha', action: 'add', member: 'agent-1' }],
      ];
      for (const [method, params] of calls) {
        const response = await dispatcher.dispatch({ v: 1, id: method, method, params });
        expect(response.ok).toBe(false);
        if (response.ok) throw new Error(`expected ${method} to fail`);
        expect(response.error.code).toBe('not_found');
        expect(response.error.message).toBe('Team control is not available');
      }
    } finally {
      dispatcher.dispose();
    }
  });
});

describe('teams.* with an injected control', () => {
  it('serves list/get/post/members with result_schema validation enabled', async () => {
    process.env.VESSEL_VALIDATE_RESULTS = '1';
    const fake = new FakeTeamControl();
    const gateway = createGateway({ events: new MemoryEventStream(), teams: fake });
    gateways.push(gateway);

    const listed = await dispatchOk(gateway, 'teams.list');
    const teams = listed.teams as TeamSummaryLike[];
    expect(teams).toHaveLength(2);
    expect(teams.map((team) => team.team_id)).toEqual(['team-alpha', 'team-bravo']);

    const got = (await dispatchOk(gateway, 'teams.get', {
      team_id: 'team-alpha',
      limit: 5,
    })) as unknown as TeamDetailLike;
    expect(got.team.team_id).toBe('team-alpha');
    expect(got.members[0]?.agent_id).toBe('agent-1');
    expect(got.messages[0]?.message_id).toBe('msg-1');
    expect(fake.calls.get[0]).toEqual({ teamId: 'team-alpha', options: { limit: 5 } });

    const posted = (await dispatchOk(gateway, 'teams.post', {
      team_id: 'team-alpha',
      content: 'status update',
      mentions: ['agent-1'],
    })) as unknown as TeamPostResultLike;
    expect(posted.kind).toBe('mention');
    expect(posted.mentions).toEqual(['agent-1']);
    expect(posted.delivered).toEqual([
      { agent_id: 'agent-1', status: 'queued', message_id: 'msg-2', resolution: 'live' },
    ]);
    expect(fake.calls.post[0]).toEqual({
      team_id: 'team-alpha',
      content: 'status update',
      mentions: ['agent-1'],
      from: 'human',
    });

    const membership = (await dispatchOk(gateway, 'teams.members', {
      team_id: 'team-alpha',
      action: 'remove',
      member: 'agent-1',
    })) as unknown as TeamMembersResultLike;
    expect(membership).toEqual({
      team_id: 'team-alpha',
      action: 'remove',
      agent_id: 'agent-1',
      membership: 'left',
    });
    expect(fake.calls.members[0]).toEqual({
      team_id: 'team-alpha',
      action: 'remove',
      member: 'agent-1',
      from: 'human',
    });

    const unknownTeam = await dispatchError(gateway, 'teams.get', { team_id: 'nope' });
    expect(unknownTeam.code).toBe('not_found');
    const unknownMember = await dispatchError(gateway, 'teams.members', {
      team_id: 'team-alpha',
      action: 'add',
      member: 'missing',
    });
    expect(unknownMember.code).toBe('not_found');
  });

  it('rejects invalid params and maps Team error codes', async () => {
    const fake = new FakeTeamControl();
    const gateway = createGateway({ events: new MemoryEventStream(), teams: fake });
    gateways.push(gateway);

    expect((await dispatchError(gateway, 'teams.get', { team_id: 'x', limit: 0 })).code).toBe(
      'invalid_params',
    );
    expect(
      (
        await dispatchError(gateway, 'teams.members', {
          team_id: 'x',
          action: 'bogus',
          member: 'a',
        })
      ).code,
    ).toBe('invalid_params');

    const cases: Array<{ error: unknown; code: string; teamCode?: string }> = [
      { error: codedError('team_not_found', 'team_not_found: x'), code: 'not_found' },
      { error: codedError('unknown_member', 'unknown_member: x'), code: 'not_found' },
      { error: codedError('team_log_write_failed', 'disk full'), code: 'internal' },
      {
        error: codedError('team_not_member', 'team_not_member: x'),
        code: 'invalid_params',
        teamCode: 'team_not_member',
      },
      { error: new Error('boom'), code: 'internal' },
      { error: new RpcError('conflict', 'already archived'), code: 'conflict' },
    ];
    for (const item of cases) {
      fake.failWith = item.error;
      const error = await dispatchError(gateway, 'teams.list');
      expect(error.code).toBe(item.code);
      if (item.teamCode !== undefined) {
        expect(error.details).toEqual({ team_code: item.teamCode });
      } else {
        expect(error.details).toBeUndefined();
      }
    }
  });

  it('returns not_found when the injected control belongs to another tenant', async () => {
    const fake = new FakeTeamControl('other');
    const gateway = createGateway({ events: new MemoryEventStream(), teams: fake });
    gateways.push(gateway);

    const calls: Array<[string, unknown]> = [
      ['teams.list', {}],
      ['teams.get', { team_id: 'team-alpha' }],
      ['teams.post', { team_id: 'team-alpha', content: 'hello' }],
      ['teams.members', { team_id: 'team-alpha', action: 'add', member: 'agent-1' }],
    ];
    for (const [method, params] of calls) {
      const error = await dispatchError(gateway, method, params);
      expect(error.code).toBe('not_found');
      expect(error.message).toBe('Team control is not available');
    }
    expect(fake.calls.list).toEqual([]);
    expect(fake.calls.get).toEqual([]);
    expect(fake.calls.post).toEqual([]);
    expect(fake.calls.members).toEqual([]);
  });

  it('enforces read / write permission levels', async () => {
    const fake = new FakeTeamControl();
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForRoles(),
      teams: fake,
    });
    gateways.push(gateway);

    expect((await rpcHttp(gateway, envelope('l', 'teams.list'), 'reader')).ok).toBe(true);
    expect(
      (await rpcHttp(gateway, envelope('g', 'teams.get', { team_id: 'team-alpha' }), 'reader')).ok,
    ).toBe(true);

    const deniedPost = await rpcHttp(
      gateway,
      envelope('p', 'teams.post', { team_id: 'team-alpha', content: 'hi' }),
      'reader',
    );
    expect(deniedPost.ok).toBe(false);
    expect(deniedPost.error?.code).toBe('forbidden');
    expect(deniedPost.error?.details).toMatchObject({ method: 'teams.post', required: 'write' });

    const deniedMembers = await rpcHttp(
      gateway,
      envelope('m', 'teams.members', {
        team_id: 'team-alpha',
        action: 'add',
        member: 'agent-1',
      }),
      'reader',
    );
    expect(deniedMembers.ok).toBe(false);
    expect(deniedMembers.error?.code).toBe('forbidden');

    const allowedPost = await rpcHttp(
      gateway,
      envelope('p2', 'teams.post', { team_id: 'team-alpha', content: 'hi' }),
      'writer',
    );
    expect(allowedPost.ok).toBe(true);
  });
});

describe('teams.* with a team-scoped control token', () => {
  it('confines RPC teams.* to the token team and redacts workspace / policy', async () => {
    const fake = new FakeTeamControl();
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForTeamScope(),
      teams: fake,
    });
    gateways.push(gateway);

    const deniedGet = await rpcHttp(
      gateway,
      envelope('get-bravo', 'teams.get', { team_id: 'team-bravo' }),
      'control-a',
    );
    expect(deniedGet.ok).toBe(false);
    expect(deniedGet.error?.code).toBe('not_found');
    expect(fake.calls.get).toEqual([]);

    const deniedPost = await rpcHttp(
      gateway,
      envelope('post-bravo', 'teams.post', { team_id: 'team-bravo', content: 'nope' }),
      'control-a',
    );
    expect(deniedPost.ok).toBe(false);
    expect(deniedPost.error?.code).toBe('not_found');
    expect(fake.calls.post).toEqual([]);

    const allowedGet = await rpcHttp(
      gateway,
      envelope('get-alpha', 'teams.get', { team_id: 'team-alpha' }),
      'control-a',
    );
    expect(allowedGet.ok).toBe(true);

    const scopedList = await rpcHttp(gateway, envelope('list-a', 'teams.list'), 'control-a');
    expect(scopedList.ok).toBe(true);
    const scopedTeams = (scopedList.result as { teams: TeamSummaryLike[] }).teams;
    expect(scopedTeams.map((team) => team.team_id)).toEqual(['team-alpha']);

    // 不存在的 team 作用域：list 空数组，get 仍按 not_found（不泄漏存在性）。
    const missingList = await rpcHttp(
      gateway,
      envelope('list-missing', 'teams.list'),
      'control-missing',
    );
    expect(missingList.ok).toBe(true);
    expect((missingList.result as { teams: TeamSummaryLike[] }).teams).toEqual([]);
    const getCallsBefore = fake.calls.get.length;
    const missingGet = await rpcHttp(
      gateway,
      envelope('get-missing', 'teams.get', { team_id: 'team-alpha' }),
      'control-missing',
    );
    expect(missingGet.ok).toBe(false);
    expect(missingGet.error?.code).toBe('not_found');
    expect(fake.calls.get).toHaveLength(getCallsBefore);

    const adminList = await rpcHttp(gateway, envelope('list-admin', 'teams.list'), 'admin-token');
    expect(adminList.ok).toBe(true);
    const adminTeams = (adminList.result as { teams: TeamSummaryLike[] }).teams;
    expect(adminTeams.map((team) => team.team_id)).toEqual(['team-alpha', 'team-bravo']);

    for (const payload of [scopedList.result, allowedGet.result]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('workspace');
      expect(serialized).not.toContain('policy');
      expect(serialized).not.toContain('/tmp/alpha');
      expect(serialized).not.toContain('allowFork');
    }

    const adminSerialized = JSON.stringify(adminList.result);
    expect(adminSerialized).toContain('workspace');
    expect(adminSerialized).toContain('policy');
    expect(adminSerialized).toContain('/tmp/alpha');
    expect(adminSerialized).toContain('allowFork');
  });

  it('enforces the team check in teams.members when the dispatcher is bypassed', async () => {
    const fake = new FakeTeamControl();
    const members = createTeamMethods({ teams: fake }).find(
      (method) => method.name === 'teams.members',
    );
    if (members === undefined) throw new Error('teams.members is missing');

    const ctx: RpcMethodContext = {
      principal: {
        tenant_id: 'default',
        role: 'write',
        scope: 'control',
        team_id: 'team-alpha',
      },
      tenantId: 'default',
      isAdmin: false,
      allTenants: false,
      connection: 'local',
    };
    const invoke = async (teamId: string): Promise<unknown> =>
      members.handler({ team_id: teamId, action: 'add', member: 'agent-1' }, ctx);

    const failure = await invoke('team-bravo').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RpcError);
    expect((failure as RpcError).code).toBe('not_found');
    expect(fake.calls.members).toEqual([]);

    const result = (await invoke('team-alpha')) as TeamMembersResultLike;
    expect(result.team_id).toBe('team-alpha');
    expect(fake.calls.members).toEqual([
      { team_id: 'team-alpha', action: 'add', member: 'agent-1', from: 'human' },
    ]);
  });
});
