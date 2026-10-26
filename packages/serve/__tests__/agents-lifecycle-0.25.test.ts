/**
 * 0.25 canonical agent 生命周期（agents.create / agents.update / agents.close）。
 *
 * 守的故障：team-scoped token 越界创建 / 更新 / 关闭；team_id 未解析到 workspace；
 * 批量条目失败拖垮其它条目或打乱顺序；model / system_prompt 被误报成立即生效。
 */

import { describe, expect, it } from 'bun:test';
import type {
  AgentControlLike,
  AgentCreateLikeInput,
  AgentLifecycleBatchResultLike,
  AgentStatusLike,
  AgentUpdateLikeInput,
} from '../src/agent-control';
import { createAgentRegistry } from '../src/agents-registry';
import { type AgentMethodsDeps, createAgentMethods } from '../src/gateway/methods/agents';
import { agentStatusSchema } from '../src/gateway/methods/schemas';
import { createRpcDispatcher, defineMethods, RpcError, type RpcMethodContext } from '../src/rpc';
import type { TeamControlLike, TeamDetailLike, TeamSummaryLike } from '../src/team-control';

function status(id: string, overrides: Partial<AgentStatusLike> = {}): AgentStatusLike {
  return {
    id,
    session_id: id,
    owner: 'main',
    visibility: 'team',
    state: 'idle',
    presence: 'live',
    membership: 'present',
    epoch: 0,
    ...overrides,
  };
}

interface Calls {
  create: AgentCreateLikeInput[];
  update: AgentUpdateLikeInput[];
  close: string[];
  get: string[];
}

function fakeAgentControl(options: { tenantId?: string; members?: AgentStatusLike[] } = {}): {
  control: AgentControlLike;
  calls: Calls;
  members: Map<string, AgentStatusLike>;
} {
  const calls: Calls = { create: [], update: [], close: [], get: [] };
  const members = new Map((options.members ?? []).map((member) => [member.id, member]));
  const control: AgentControlLike = {
    tenantId: options.tenantId ?? 'default',
    async create(inputs): Promise<AgentLifecycleBatchResultLike> {
      calls.create.push(...inputs);
      return {
        results: inputs.map((input, index) => ({
          ok: true,
          agent: status(`new-${index + 1}`, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            ...(input.workspace !== undefined ? { team_id: input.workspace.split('/').pop() } : {}),
          }),
        })),
      };
    },
    async update(inputs): Promise<AgentLifecycleBatchResultLike> {
      calls.update.push(...inputs);
      return {
        results: inputs.map((input) => {
          const member = members.get(input.agent_id);
          if (member === undefined) {
            return {
              ok: false,
              code: 'unknown_member',
              error: `unknown_member: ${input.agent_id}`,
            };
          }
          if (input.name === 'taken') {
            return {
              ok: false,
              code: 'invalid_input',
              error: 'duplicate member name: taken',
            };
          }
          const changed = [
            ...(input.name !== undefined ? ['name'] : []),
            ...(input.model !== undefined ? ['model'] : []),
            ...(input.system_prompt !== undefined ? ['system_prompt'] : []),
            ...(input.role !== undefined ? ['role'] : []),
            ...(input.teamId !== undefined ? ['team_id'] : []),
          ];
          const next: AgentStatusLike = {
            ...member,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.role !== undefined ? { role: input.role } : {}),
            ...(input.teamId !== undefined ? { team_id: input.teamId } : {}),
          };
          members.set(next.id, next);
          return {
            ok: true,
            agent: next,
            changed,
            ...(input.model !== undefined || input.system_prompt !== undefined
              ? { applies_to: 'next_body' as const }
              : {}),
          };
        }),
      };
    },
    async close(ids) {
      calls.close.push(...ids);
      return {
        results: ids.map((id) => {
          const member = members.get(id);
          return member === undefined
            ? { ok: false as const, code: 'unknown_member', error: `unknown_member: ${id}` }
            : {
                ok: true as const,
                agent: { ...member, state: 'closed' as const, membership: 'left' as const },
                agent_id: id,
                closed: true as const,
              };
        }),
      };
    },
    async get(id) {
      calls.get.push(id);
      return members.get(id);
    },
    async list() {
      return [...members.values()];
    },
    async resolve(target) {
      return members.get(target);
    },
    async send(inputs) {
      return {
        results: inputs.map(() => ({
          ok: true as const,
          queued: true as const,
          message_id: 'msg',
          state: 'idle' as const,
        })),
      };
    },
    async dispatch(inputs) {
      return {
        results: inputs.map((input) => ({
          ok: true as const,
          status: 'queued' as const,
          message_id: 'msg',
          resolved_to: input.to,
          resolution: 'live' as const,
        })),
      };
    },
    async rotate(inputs) {
      return {
        results: inputs.map((input) => ({
          ok: true as const,
          status: 'rotated' as const,
          agent_id: input.to,
          from_session_id: 'old',
          to_session_id: 'new',
          epoch: 1,
        })),
      };
    },
  };
  return { control, calls, members };
}

function summary(teamId: string, workspace?: string): TeamSummaryLike {
  return {
    team_id: teamId,
    name: teamId,
    tenant_id: 'default',
    ...(workspace !== undefined ? { workspace } : {}),
    member_count: 0,
    online_count: 0,
    created_at: 1,
  };
}

/** 只实现 agent 生命周期需要的 `get`；其它方法在测试里不会被调用。 */
function fakeTeams(workspaces: Record<string, string | undefined> = {}): TeamControlLike {
  const detailFor = (teamId: string): TeamDetailLike | undefined => {
    if (!(teamId in workspaces)) return undefined;
    const workspace = workspaces[teamId];
    return {
      team: summary(teamId, workspace),
      members: [],
      messages: [],
    };
  };
  return {
    tenantId: 'default',
    async create() {
      throw new Error('not used');
    },
    async update() {
      throw new Error('not used');
    },
    async archive() {
      throw new Error('not used');
    },
    async setSpawnFrozen() {
      throw new Error('not used');
    },
    async list() {
      return [];
    },
    async get(teamId) {
      return detailFor(teamId);
    },
    async roster() {
      return [];
    },
    async post() {
      throw new Error('not used');
    },
    async members() {
      return undefined;
    },
  };
}

function context(overrides: Partial<RpcMethodContext['principal']> = {}): RpcMethodContext {
  return {
    principal: { tenant_id: 'default', role: 'write', ...overrides },
    tenantId: 'default',
    isAdmin: false,
    allTenants: false,
    connection: 'http',
  };
}

function methodOf(deps: AgentMethodsDeps, name: string) {
  const method = createAgentMethods(deps).find((entry) => entry.name === name);
  if (method === undefined) throw new Error(`missing method: ${name}`);
  return method;
}

function deps(overrides: Partial<AgentMethodsDeps> = {}): AgentMethodsDeps {
  return {
    registry: createAgentRegistry(),
    runs: new Map(),
    defaultTenantId: 'default',
    ...overrides,
  };
}

async function expectRpcError(run: () => Promise<unknown>, code: RpcError['code']): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    if (!(error instanceof RpcError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected RpcError ${code}`);
}

describe('agents.create', () => {
  it('binds to an existing team through team_id → workspace', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });
    const result = (await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      { agents: [{ name: 'bob', team_id: 'alpha', visibility: 'team' }] },
      context(),
    )) as { results: Array<{ ok: boolean; agent?: AgentStatusLike }> };

    expect(calls.create).toEqual([{ name: 'bob', workspace: '/ws/alpha', visibility: 'team' }]);
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[0]?.agent?.team_id).toBe('alpha');
  });

  it('maps kind=peer to an ownerless team member with the caller as spawnedBy', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });

    const result = (await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      { agents: [{ kind: 'peer', team_id: 'alpha', name: 'bob' }] },
      context({ agent_id: 'owner-1' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(calls.create).toEqual([
      { kind: 'peer', team_id: 'alpha', name: 'bob', spawnedBy: 'owner-1' },
    ]);
    expect(result.results[0]?.ok).toBe(true);
  });

  it('rejects peer without team_id and peer with workspace per entry', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });

    const result = (await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      {
        agents: [
          { kind: 'peer', name: 'no-team' },
          { kind: 'peer', team_id: 'alpha', workspace: '/ws/alpha' },
          { kind: 'peer', team_id: 'missing' },
          { kind: 'peer', team_id: 'alpha', name: 'ok' },
        ],
      },
      context({ agent_id: 'owner-1' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results.map((entry) => entry.ok)).toEqual([false, false, false, true]);
    expect(result.results[0]).toMatchObject({ code: 'invalid_params' });
    expect(result.results[1]).toMatchObject({ code: 'invalid_params' });
    expect(result.results[2]).toMatchObject({ code: 'not_found' });
    expect(calls.create).toEqual([
      { kind: 'peer', team_id: 'alpha', name: 'ok', spawnedBy: 'owner-1' },
    ]);
  });

  it('maps kind=contractor to the caller owner/parent (team optional)', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });

    await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      {
        agents: [
          { kind: 'contractor', team_id: 'alpha', name: 'with-team' },
          { kind: 'contractor', name: 'unbound' },
        ],
      },
      context({ agent_id: 'owner-1' }),
    );

    expect(calls.create).toEqual([
      {
        kind: 'contractor',
        team_id: 'alpha',
        name: 'with-team',
        owner: 'owner-1',
        parent_id: 'owner-1',
        spawnedBy: 'owner-1',
      },
      {
        kind: 'contractor',
        name: 'unbound',
        owner: 'owner-1',
        parent_id: 'owner-1',
        spawnedBy: 'owner-1',
      },
    ]);
  });

  it('contractor without a principal agent id leaves owner/parent to the service', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });

    await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      { agents: [{ kind: 'contractor', team_id: 'alpha' }] },
      context(),
    );

    expect(calls.create).toEqual([{ kind: 'contractor', team_id: 'alpha', spawnedBy: 'human' }]);
  });

  it('kind absent keeps the workspace + identity path', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });

    await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      { agents: [{ team_id: 'alpha', name: 'legacy' }] },
      context({ agent_id: 'owner-1' }),
    );

    expect(calls.create).toEqual([
      {
        name: 'legacy',
        workspace: '/ws/alpha',
        owner: 'owner-1',
        parent_id: 'owner-1',
      },
    ]);
  });

  it('returns per-entry not_found when the team_id cannot be resolved', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });

    const result = (await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      {
        agents: [
          { name: 'first', team_id: 'alpha' },
          { name: 'ghost', team_id: 'missing' },
          { name: 'third', team_id: 'alpha' },
        ],
      },
      context(),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(result.results[1]).toMatchObject({ ok: false, code: 'not_found' });
    // 成功条目仍然生效且保持输入顺序。
    expect(calls.create.map((entry) => entry.name)).toEqual(['first', 'third']);
  });

  it('forbids team-scoped control tokens without touching the service', async () => {
    const { control, calls } = fakeAgentControl();
    const teams = fakeTeams({ alpha: '/ws/alpha' });

    const result = (await methodOf(deps({ agent: control, teams }), 'agents.create').handler(
      { agents: [{ name: 'bob', team_id: 'alpha' }] },
      context({ scope: 'control', team_id: 'alpha' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
    expect(calls.create).toEqual([]);
    expect(calls.get).toEqual([]);
  });

  it('returns not_found when the control plane is not injected', async () => {
    await expectRpcError(
      async () =>
        await methodOf(deps(), 'agents.create').handler({ agents: [{ name: 'bob' }] }, context()),
      'not_found',
    );
  });
});

describe('agents.update', () => {
  it('renames and reports next_body only for model / system_prompt changes', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      {
        agents: [
          { agent_id: 'a1', name: 'renamed' },
          { agent_id: 'a1', model: 'model-2', system_prompt: 'prompt' },
        ],
      },
      context(),
    )) as { results: Array<Record<string, unknown>> };

    expect(calls.update).toEqual([
      { agent_id: 'a1', name: 'renamed' },
      { agent_id: 'a1', model: 'model-2', system_prompt: 'prompt' },
    ]);
    expect(result.results[0]).toMatchObject({ ok: true, changed: ['name'] });
    expect(result.results[0]?.applies_to).toBeUndefined();
    expect(result.results[1]).toMatchObject({
      ok: true,
      changed: ['model', 'system_prompt'],
      applies_to: 'next_body',
    });
  });

  it('keeps duplicate names a per-entry invalid_input failure', async () => {
    const { control } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' }), status('b1', { team_id: 'alpha' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      {
        agents: [
          { agent_id: 'b1', name: 'taken' },
          { agent_id: 'a1', name: 'ok' },
        ],
      },
      context(),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(result.results[1]).toMatchObject({ ok: true });
  });

  it('isolates team scope: a beta token cannot touch an alpha agent', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' }), status('b1', { team_id: 'beta' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      {
        agents: [
          { agent_id: 'b1', name: 'beta-renamed' },
          { agent_id: 'a1', name: 'nope' },
        ],
      },
      context({ scope: 'control', team_id: 'beta' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({ ok: true });
    expect(result.results[1]).toMatchObject({ ok: false, code: 'not_found' });
    // 跨 team 条目从未提交给服务。
    expect(calls.update).toEqual([{ agent_id: 'b1', name: 'beta-renamed' }]);
  });

  it('maps a role conversion to role, teamId and the human principal', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      { agents: [{ agent_id: 'a1', role: 'member', team_id: 'alpha' }] },
      context(),
    )) as { results: Array<Record<string, unknown>> };

    expect(calls.update).toEqual([
      { agent_id: 'a1', role: 'member', teamId: 'alpha', from: 'human' },
    ]);
    expect(result.results[0]).toMatchObject({
      ok: true,
      agent: { id: 'a1', role: 'member', team_id: 'alpha' },
    });
  });

  it('uses the owner agent id as the converter principal', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' })],
    });

    await methodOf(deps({ agent: control }), 'agents.update').handler(
      { agents: [{ agent_id: 'a1', role: 'temporary' }] },
      context({ agent_id: 'owner-1' }),
    );

    expect(calls.update).toEqual([{ agent_id: 'a1', role: 'temporary', from: 'owner-1' }]);
  });

  it('keeps batch order across plain updates and role conversions', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' }), status('b1', { team_id: 'alpha' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      {
        agents: [
          { agent_id: 'a1', role: 'single' },
          { agent_id: 'b1', name: 'bee' },
        ],
      },
      context(),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results.map((entry) => entry.ok)).toEqual([true, true]);
    // 非转换条目不带 from，保持旧调用形状。
    expect(calls.update).toEqual([
      { agent_id: 'a1', role: 'single', from: 'human' },
      { agent_id: 'b1', name: 'bee' },
    ]);
  });

  it('allows a team-scoped token to convert members within its own team', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      { agents: [{ agent_id: 'a1', role: 'temporary', team_id: 'alpha' }] },
      context({ scope: 'control', team_id: 'alpha' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({ ok: true });
    expect(calls.update).toEqual([
      { agent_id: 'a1', role: 'temporary', teamId: 'alpha', from: 'human' },
    ]);
  });

  it('rejects single and other-team conversions for team-scoped tokens', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      {
        agents: [
          { agent_id: 'a1', role: 'single' },
          { agent_id: 'a1', role: 'member', team_id: 'beta' },
        ],
      },
      context({ scope: 'control', team_id: 'alpha' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
    expect(result.results[1]).toMatchObject({ ok: false, code: 'forbidden' });
    expect(calls.update).toEqual([]);
  });

  it('requires the target to be in the token team for role changes', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('b1', { team_id: 'beta' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.update').handler(
      { agents: [{ agent_id: 'b1', role: 'member' }] },
      context({ scope: 'control', team_id: 'alpha' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.update).toEqual([]);
  });

  it('rejects an unknown role as invalid_params', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' })],
    });

    await expectRpcError(
      async () =>
        await methodOf(deps({ agent: control }), 'agents.update').handler(
          { agents: [{ agent_id: 'a1', role: 'boss' }] },
          context(),
        ),
      'invalid_params',
    );
    expect(calls.update).toEqual([]);
  });
});

describe('agent status role', () => {
  it('maps the membership role into the owner-view agents.list entry', async () => {
    const { control } = fakeAgentControl({
      members: [status('a1', { name: 'alice', role: 'member', team_id: 'alpha' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.list').handler(
      {},
      context({ agent_id: 'main' }),
    )) as { agents: Array<Record<string, unknown>> };

    expect(result.agents[0]).toMatchObject({ id: 'a1', role: 'member', team_id: 'alpha' });
  });

  it('declares the AgentRole enum on the status schema and keeps owner optional', () => {
    expect(agentStatusSchema.properties.role).toEqual({
      type: 'string',
      enum: ['single', 'member', 'temporary'],
    });
    const required = agentStatusSchema.required as string[];
    expect(required).not.toContain('owner');
    expect(required).not.toContain('role');
  });

  it('validates a role-bearing agents.update result when result validation is enabled', async () => {
    process.env.VESSEL_VALIDATE_RESULTS = '1';
    try {
      const { control } = fakeAgentControl({
        members: [status('a1', { team_id: 'alpha' })],
      });
      const dispatcher = createRpcDispatcher({
        table: defineMethods(createAgentMethods(deps({ agent: control }))),
        localPrincipal: { tenant_id: 'default', role: 'write' },
        makeContext: (_method, _params, resolved) => ({
          principal: resolved,
          tenantId: resolved.tenant_id,
          isAdmin: false,
          allTenants: false,
          connection: 'http',
        }),
      });
      const response = await dispatcher.dispatchFor(
        {
          v: 1,
          id: 'role-update',
          method: 'agents.update',
          params: { agents: [{ agent_id: 'a1', role: 'member', team_id: 'alpha' }] },
        },
        { tenant_id: 'default', role: 'write' },
        'http',
      );
      expect(response.ok).toBe(true);
    } finally {
      delete process.env.VESSEL_VALIDATE_RESULTS;
    }
  });
});

describe('agents.close', () => {
  it('closes only in-scope members and keeps per-entry order', async () => {
    const { control, calls } = fakeAgentControl({
      members: [status('a1', { team_id: 'alpha' }), status('b1', { team_id: 'beta' })],
    });

    const result = (await methodOf(deps({ agent: control }), 'agents.close').handler(
      { agents: [{ agent_id: 'b1' }, { agent_id: 'a1' }] },
      context({ scope: 'control', team_id: 'beta' }),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({
      ok: true,
      agent_id: 'b1',
      closed: true,
      agent: { id: 'b1', state: 'closed', membership: 'left' },
    });
    expect(result.results[1]).toEqual({
      ok: false,
      code: 'not_found',
      error: 'agent not found: a1',
    });
    expect(calls.close).toEqual(['b1']);
  });

  it('maps an unknown member to a per-entry failure', async () => {
    const { control } = fakeAgentControl();

    const result = (await methodOf(deps({ agent: control }), 'agents.close').handler(
      { agents: [{ agent_id: 'missing' }] },
      context(),
    )) as { results: Array<Record<string, unknown>> };

    expect(result.results[0]).toMatchObject({ ok: false, code: 'unknown_member' });
  });
});

describe('agent lifecycle contract', () => {
  it('declares result_schema for all three methods', () => {
    const { control } = fakeAgentControl();
    const all = deps({ agent: control });
    for (const name of ['agents.create', 'agents.update', 'agents.close']) {
      expect(methodOf(all, name).result_schema).toBeDefined();
    }
  });

  it('agent result schema keeps owner optional for peer members', () => {
    const required = agentStatusSchema.required as string[];
    expect(required).not.toContain('owner');
    expect(agentStatusSchema.properties.owner).toBeDefined();
  });
});
