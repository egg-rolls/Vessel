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
import { createLocalRpcDispatcher } from '../src/local';
import { RpcError, type RpcMethodContext } from '../src/rpc';
import type { TeamControlLike, TeamDetailLike, TeamSummaryLike } from '../src/team-control';
import { createGatewayEventHub } from '../src/tenant-event-hub';

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
          ];
          const next: AgentStatusLike = {
            ...member,
            ...(input.name !== undefined ? { name: input.name } : {}),
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

  it('keeps canonical count at 57 with the control plane absent', () => {
    const dispatcher = createLocalRpcDispatcher({ hub: createGatewayEventHub() });
    try {
      const methods = dispatcher.manifest().methods;
      expect(methods).toHaveLength(57);
      expect(methods.filter((method) => method.name.startsWith('agents.'))).toHaveLength(9);
    } finally {
      dispatcher.dispose();
    }
  });
});
