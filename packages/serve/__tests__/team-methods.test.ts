import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import { createTeamMethods } from '../src/gateway/methods/teams';
import { createLocalRpcDispatcher } from '../src/local';
import { RpcError, type RpcMethodContext } from '../src/rpc';
import type {
  ConversationBudgetStatusLike,
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
import { createGateway, startTestGateway as startGateway, TestWs } from './helpers';

type ListOptions = Parameters<TeamControlLike['list']>[0];
type GetOptions = Parameters<TeamControlLike['get']>[1];
type PostInput = Parameters<TeamControlLike['post']>[0];
type MembersInput = Parameters<TeamControlLike['members']>[0];
type BudgetInput = Parameters<NonNullable<TeamControlLike['budget']>>[0];

/** 预算状态 fixture：覆盖 edges / overrides / blocked。 */
function budgetStatus(conversationId: string): ConversationBudgetStatusLike {
  return {
    conversation_id: conversationId,
    team_id: 'team-alpha',
    created_at: 1000,
    last_activity: 2000,
    hops: 2,
    turns: 1,
    total_tokens: 120,
    wall_clock_ms: 1000,
    edges: [{ from: 'agent-1', to: 'agent-2', count: 1, last_ts: 2000 }],
    overrides: { tokens: { max: 500, by: 'human', via: 'api', at: 1500 } },
    blocked: { dimension: 'tokens', reason: 'budget_exceeded', at: 2000 },
  };
}

const summary: TeamSummaryLike = {
  team_id: 'team-alpha',
  name: 'Alpha',
  tenant_id: 'default',
  workspace: '/tmp/alpha',
  handoff_path: '/tmp/alpha/handoff.md',
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
  handoff_path: '/tmp/bravo/handoff.md',
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
    budget: [] as BudgetInput[],
  };

  /** 可选：测试“控制面未实现 budget”时设为 undefined。 */
  budget?: NonNullable<TeamControlLike['budget']> = async (input) => {
    this.calls.budget.push(input);
    this.maybeFail();
    if (input.team_id !== summary.team_id) return undefined;
    const conversationId = input.conversation_id ?? 'conv-1';
    const status = budgetStatus(conversationId);
    if (input.action === 'status') {
      if (input.conversation_id === undefined) {
        return { team_id: input.team_id, action: 'status', conversations: [status] };
      }
      const one = {
        team_id: input.team_id,
        action: 'status' as const,
        conversation_id: input.conversation_id,
        status,
      };
      return one;
    }
    const max = input.max ?? null;
    const result = {
      team_id: input.team_id,
      action: 'override' as const,
      conversation_id: conversationId,
      previous_max: 5,
      max,
      status: {
        ...status,
        overrides:
          input.dimension !== undefined && input.max !== undefined && input.max !== null
            ? {
                ...status.overrides,
                [input.dimension]: {
                  max: input.max,
                  by: 'human' as const,
                  via: 'api' as const,
                  at: 4000,
                },
              }
            : {},
      },
    };
    return result;
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

  async roster(teamId: string): Promise<TeamDetailLike['members']> {
    this.maybeFail();
    if (teamId === summary.team_id) return detail.members;
    if (teamId === bravoSummary.team_id) return bravoDetail.members;
    return [];
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
      ...(input.conversation_id !== undefined ? { conversation_id: input.conversation_id } : {}),
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
  it('keeps all five methods in the manifest and returns not_found', async () => {
    const dispatcher = createLocalRpcDispatcher({ hub: createGatewayEventHub() });
    try {
      const names = dispatcher.manifest().methods.map((method) => method.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'teams.list',
          'teams.get',
          'teams.post',
          'teams.members',
          'teams.budget',
        ]),
      );

      const calls: Array<[string, unknown]> = [
        ['teams.list', {}],
        ['teams.get', { team_id: 'team-alpha' }],
        ['teams.post', { team_id: 'team-alpha', content: 'hello' }],
        ['teams.members', { team_id: 'team-alpha', action: 'add', member: 'agent-1' }],
        ['teams.budget', { team_id: 'team-alpha', action: 'status' }],
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
      conversation_id: 'conv-post-1',
    })) as unknown as TeamPostResultLike;
    expect(posted.kind).toBe('mention');
    expect(posted.mentions).toEqual(['agent-1']);
    expect(posted.delivered).toEqual([
      { agent_id: 'agent-1', status: 'queued', message_id: 'msg-2', resolution: 'live' },
    ]);
    expect(posted.conversation_id).toBe('conv-post-1');
    expect(fake.calls.post[0]).toEqual({
      team_id: 'team-alpha',
      content: 'status update',
      mentions: ['agent-1'],
      from: 'human',
      conversation_id: 'conv-post-1',
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
      ['teams.budget', { team_id: 'team-alpha', action: 'status' }],
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
    expect(fake.calls.budget).toEqual([]);
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

    const deniedBudget = await rpcHttp(
      gateway,
      envelope('b', 'teams.budget', { team_id: 'team-alpha', action: 'status' }),
      'reader',
    );
    expect(deniedBudget.ok).toBe(false);
    expect(deniedBudget.error?.code).toBe('forbidden');
    expect(deniedBudget.error?.details).toMatchObject({
      method: 'teams.budget',
      required: 'write',
    });
  });

  it('serves teams.budget status and override with result_schema validation', async () => {
    process.env.VESSEL_VALIDATE_RESULTS = '1';
    const fake = new FakeTeamControl();
    const gateway = createGateway({ events: new MemoryEventStream(), teams: fake });
    gateways.push(gateway);

    const all = await dispatchOk(gateway, 'teams.budget', {
      team_id: 'team-alpha',
      action: 'status',
    });
    expect(all.action).toBe('status');
    const conversations = all.conversations as ConversationBudgetStatusLike[];
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversation_id).toBe('conv-1');
    expect(conversations[0]?.edges[0]).toEqual({
      from: 'agent-1',
      to: 'agent-2',
      count: 1,
      last_ts: 2000,
    });

    const one = await dispatchOk(gateway, 'teams.budget', {
      team_id: 'team-alpha',
      action: 'status',
      conversation_id: 'conv-9',
    });
    expect(one.conversation_id).toBe('conv-9');
    expect((one.status as ConversationBudgetStatusLike).conversation_id).toBe('conv-9');

    const override = await dispatchOk(gateway, 'teams.budget', {
      team_id: 'team-alpha',
      action: 'override',
      conversation_id: 'conv-9',
      dimension: 'tokens',
      max: 900,
    });
    expect(override.conversation_id).toBe('conv-9');
    expect(override.previous_max).toBe(5);
    expect(override.max).toBe(900);
    const overrideStatus = override.status as ConversationBudgetStatusLike;
    expect(overrideStatus.overrides.tokens).toEqual({
      max: 900,
      by: 'human',
      via: 'api',
      at: 4000,
    });

    const cleared = await dispatchOk(gateway, 'teams.budget', {
      team_id: 'team-alpha',
      action: 'override',
      conversation_id: 'conv-9',
      dimension: 'tokens',
      max: null,
    });
    expect(cleared.max).toBeNull();
    expect((cleared.status as ConversationBudgetStatusLike).overrides).toEqual({});

    expect(fake.calls.budget).toEqual([
      { team_id: 'team-alpha', action: 'status' },
      { team_id: 'team-alpha', action: 'status', conversation_id: 'conv-9' },
      {
        team_id: 'team-alpha',
        action: 'override',
        conversation_id: 'conv-9',
        dimension: 'tokens',
        max: 900,
      },
      {
        team_id: 'team-alpha',
        action: 'override',
        conversation_id: 'conv-9',
        dimension: 'tokens',
        max: null,
      },
    ]);
  });

  it('returns not_found when the control exposes no budget port', async () => {
    const fake = new FakeTeamControl();
    fake.budget = undefined;
    const gateway = createGateway({ events: new MemoryEventStream(), teams: fake });
    gateways.push(gateway);

    const error = await dispatchError(gateway, 'teams.budget', {
      team_id: 'team-alpha',
      action: 'status',
    });
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('Team budget is not available');
  });

  it('validates teams.budget params and maps Team error codes', async () => {
    const fake = new FakeTeamControl();
    const gateway = createGateway({ events: new MemoryEventStream(), teams: fake });
    gateways.push(gateway);

    const invalid: Array<Record<string, unknown>> = [
      { team_id: 'team-alpha' },
      { team_id: 'team-alpha', action: 'bogus' },
      { team_id: 'team-alpha', action: 'override', dimension: 'tokens', max: 5 },
      { team_id: 'team-alpha', action: 'override', conversation_id: 'conv-9', max: 5 },
      {
        team_id: 'team-alpha',
        action: 'override',
        conversation_id: 'conv-9',
        dimension: 'tokens',
      },
      {
        team_id: 'team-alpha',
        action: 'override',
        conversation_id: 'conv-9',
        dimension: 'cost',
        max: 5,
      },
      {
        team_id: 'team-alpha',
        action: 'override',
        conversation_id: 'conv-9',
        dimension: 'tokens',
        max: 1.5,
      },
      {
        team_id: 'team-alpha',
        action: 'override',
        conversation_id: 'conv-9',
        dimension: 'tokens',
        max: -1,
      },
      {
        team_id: 'team-alpha',
        action: 'override',
        conversation_id: 'bad id',
        dimension: 'tokens',
        max: 5,
      },
    ];
    for (const params of invalid) {
      expect((await dispatchError(gateway, 'teams.budget', params)).code).toBe('invalid_params');
    }
    expect(fake.calls.budget).toEqual([]);

    const missing = await dispatchError(gateway, 'teams.budget', {
      team_id: 'team-bravo',
      action: 'status',
    });
    expect(missing.code).toBe('not_found');

    const cases: Array<{ error: unknown; code: string; teamCode?: string }> = [
      { error: codedError('team_not_found', 'team_not_found: x'), code: 'not_found' },
      { error: codedError('unknown_member', 'unknown_member: x'), code: 'not_found' },
      {
        error: codedError('invalid_input', 'invalid_input: max too low'),
        code: 'invalid_params',
        teamCode: 'invalid_input',
      },
      { error: codedError('team_log_write_failed', 'disk full'), code: 'internal' },
      { error: new Error('boom'), code: 'internal' },
    ];
    for (const item of cases) {
      fake.failWith = item.error;
      const error = await dispatchError(gateway, 'teams.budget', {
        team_id: 'team-alpha',
        action: 'status',
      });
      expect(error.code).toBe(item.code);
      if (item.teamCode !== undefined) {
        expect(error.details).toEqual({ team_code: item.teamCode });
      } else {
        expect(error.details).toBeUndefined();
      }
    }
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
      expect(serialized).not.toContain('handoff_path');
      expect(serialized).not.toContain('policy');
      expect(serialized).not.toContain('/tmp/alpha');
      expect(serialized).not.toContain('/tmp/alpha/handoff.md');
      expect(serialized).not.toContain('allowFork');
    }

    const adminSerialized = JSON.stringify(adminList.result);
    expect(adminSerialized).toContain('workspace');
    expect(adminSerialized).toContain('handoff_path');
    expect(adminSerialized).toContain('policy');
    expect(adminSerialized).toContain('/tmp/alpha');
    expect(adminSerialized).toContain('/tmp/alpha/handoff.md');
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

  it('forbids teams.budget for a team-scoped control token', async () => {
    const fake = new FakeTeamControl();
    const gateway = startGateway({
      events: new MemoryEventStream(),
      port: 0,
      token: 'legacy',
      auth: authForTeamScope(),
      teams: fake,
    });
    gateways.push(gateway);

    // control scope 白名单不含 teams.budget：不能给自己续命。
    const denied = await rpcHttp(
      gateway,
      envelope('budget-a', 'teams.budget', { team_id: 'team-alpha', action: 'status' }),
      'control-a',
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('forbidden');
    expect(fake.calls.budget).toEqual([]);

    const admin = await rpcHttp(
      gateway,
      envelope('budget-admin', 'teams.budget', { team_id: 'team-alpha', action: 'status' }),
      'admin-token',
    );
    expect(admin.ok).toBe(true);
    expect(fake.calls.budget).toEqual([{ team_id: 'team-alpha', action: 'status' }]);
  });

  it('filters budget events by data.team_id when the event has no session', async () => {
    const events = new MemoryEventStream();
    const gateway = startGateway({
      events,
      auth: authForTeamScope(),
      hubTeamScope: {
        teamForSession: (sessionId) => (sessionId === 'sess-alpha' ? 'team-alpha' : undefined),
      },
    });
    gateways.push(gateway);
    const client = await TestWs.connect(gateway, { token: 'control-a' });
    await client.next((frame) => frame.kind === 'hello');

    // 无 session、data.team_id 匹配 → 放行。
    events.publish({
      type: 'team.budget.warning',
      run_id: 'team:team-alpha',
      data: { team_id: 'team-alpha', conversation_id: 'conv-1' },
      ts: 1,
    } as RunEvent);
    const accepted = await client.nextEvent('team.budget.warning');
    expect(accepted.team_id).toBe('team-alpha');

    // 无 session：别 team 或没有 team_id → 丢弃。
    events.publish({
      type: 'team.budget.blocked',
      run_id: 'team:team-bravo',
      data: { team_id: 'team-bravo', conversation_id: 'conv-2' },
      ts: 2,
    } as RunEvent);
    events.publish({
      type: 'team.budget.override',
      run_id: 'team',
      data: { conversation_id: 'conv-3' },
      ts: 3,
    } as RunEvent);
    await expect(
      client.next(
        (frame) =>
          frame.kind === 'event' &&
          (frame.event.type === 'team.budget.blocked' ||
            frame.event.type === 'team.budget.override'),
        100,
      ),
    ).rejects.toThrow();

    // 有 session 时仍按 session → team 映射；既有行为不变。
    events.publish({
      type: 'run.started',
      run_id: 'run-a',
      data: {},
      ts: 4,
      session_id: 'sess-alpha',
    } as unknown as RunEvent);
    const bySession = await client.next(
      (frame) => frame.kind === 'event' && frame.event.type === 'run.started',
    );
    expect(bySession.kind).toBe('event');

    client.close();
  });
});
