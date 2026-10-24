/**
 * 0.26 canonical `agents.send` / `agents.dispatch` / `agents.rotate`。
 *
 * 守：principal → sender/viewer 映射（owner vs human）；team-scoped control token
 * 只能操作同 team；批量结果与输入同序、单条失败隔离；scope 白名单确实放行。
 */

import { describe, expect, it } from 'bun:test';
import type {
  AgentControlLike,
  AgentDispatchItemLike,
  AgentDispatchLikeInput,
  AgentRotateItemLike,
  AgentRotateLikeInput,
  AgentSendItemLike,
  AgentSendLikeInput,
  AgentStatusLike,
} from '../src/agent-control';
import { createAgentRegistry } from '../src/agents-registry';
import { type AgentMethodsDeps, createAgentMethods } from '../src/gateway/methods/agents';
import { createRpcDispatcher, defineMethods, type RpcMethodContext } from '../src/rpc';

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
  send: AgentSendLikeInput[];
  dispatch: AgentDispatchLikeInput[];
  rotate: AgentRotateLikeInput[];
  list: Array<Record<string, unknown>>;
}

function fakeControl(): { control: AgentControlLike; calls: Calls } {
  const calls: Calls = { send: [], dispatch: [], rotate: [], list: [] };
  const members = new Map<string, AgentStatusLike>([
    ['a1', status('a1', { name: 'alice', team_id: 'alpha' })],
    ['b1', status('b1', { name: 'bob', team_id: 'beta' })],
    ['p1', status('p1', { name: 'private', visibility: 'private', team_id: 'alpha' })],
  ]);
  const control: AgentControlLike = {
    tenantId: 'default',
    async create(inputs) {
      return {
        results: inputs.map((input, index) => ({
          ok: true as const,
          agent: status(`new-${index + 1}`, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.owner !== undefined ? { owner: input.owner } : {}),
          }),
        })),
      };
    },
    async update(inputs) {
      return {
        results: inputs.map((input) => ({
          ok: true as const,
          agent: status(input.agent_id),
          changed: [],
        })),
      };
    },
    async close(ids) {
      return {
        results: ids.map((id) => ({
          ok: true as const,
          agent: status(id, { state: 'closed' }),
          agent_id: id,
          closed: true as const,
        })),
      };
    },
    async get(id) {
      return members.get(id);
    },
    async list(input = {}) {
      calls.list.push({ ...input });
      return [...members.values()].filter(
        (member) => input.viewer !== undefined || member.visibility !== 'private',
      );
    },
    async resolve(target) {
      const direct = members.get(target);
      if (direct !== undefined) return direct;
      const byName = [...members.values()].filter((member) => member.name === target);
      return byName.length === 1 ? byName[0] : undefined;
    },
    async send(inputs) {
      calls.send.push(...inputs);
      return {
        results: inputs.map(
          (input): AgentSendItemLike =>
            input.to === 'missing'
              ? { ok: false, code: 'unknown_member', error: 'unknown_member: missing' }
              : { ok: true, queued: true, message_id: 'msg', state: 'idle' },
        ),
      };
    },
    async dispatch(inputs) {
      calls.dispatch.push(...inputs);
      return {
        results: inputs.map(
          (input): AgentDispatchItemLike =>
            input.to === 'missing'
              ? { ok: false, code: 'not_visible', error: 'not_visible: missing' }
              : {
                  ok: true,
                  status: 'queued',
                  message_id: 'msg',
                  resolved_to: input.to,
                  resolution: 'live',
                },
        ),
      };
    },
    async rotate(inputs) {
      calls.rotate.push(...inputs);
      return {
        results: inputs.map(
          (input): AgentRotateItemLike =>
            input.to === 'missing'
              ? { ok: false, code: 'not_visible', error: 'not_visible: missing' }
              : {
                  ok: true,
                  status: 'rotated',
                  agent_id: input.to,
                  from_session_id: 'old',
                  to_session_id: 'new',
                  epoch: 1,
                },
        ),
      };
    },
  };
  return { control, calls };
}

function deps(control: AgentControlLike): AgentMethodsDeps {
  return {
    registry: createAgentRegistry(),
    runs: new Map(),
    defaultTenantId: 'default',
    agent: control,
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

function methodOf(depsValue: AgentMethodsDeps, name: string) {
  const method = createAgentMethods(depsValue).find((entry) => entry.name === name);
  if (method === undefined) throw new Error(`missing method: ${name}`);
  return method;
}

describe('agents.send / dispatch / rotate', () => {
  it('uses human as the sender for gateway principals', async () => {
    const { control, calls } = fakeControl();
    const result = (await methodOf(deps(control), 'agents.send').handler(
      { messages: [{ to: 'a1', content: 'hi' }] },
      context(),
    )) as { results: AgentSendItemLike[] };

    expect(result.results[0]).toMatchObject({ ok: true, queued: true });
    expect(calls.send[0]).toMatchObject({ to: 'a1', content: 'hi', from: 'human' });
  });

  it('uses the owner agent id as sender / viewer for a synthetic owner principal', async () => {
    const { control, calls } = fakeControl();
    const result = (await methodOf(deps(control), 'agents.dispatch').handler(
      { messages: [{ to: 'a1', content: 'hi' }] },
      context({ agent_id: 'main', role: 'admin', scope: 'admin' }),
    )) as { results: AgentDispatchItemLike[] };

    expect(result.results[0]).toMatchObject({ ok: true, status: 'queued' });
    expect(calls.dispatch[0]).toMatchObject({ to: 'a1', content: 'hi', from: 'main' });
  });

  it('lists members through the owner viewer and falls back to the registry otherwise', async () => {
    const { control, calls } = fakeControl();
    const owner = (await methodOf(deps(control), 'agents.list').handler(
      {},
      context({ agent_id: 'main', role: 'admin', scope: 'admin' }),
    )) as { agents: Array<{ id: string }> };
    expect(owner.agents.map((entry) => entry.id)).toEqual(['a1', 'b1', 'p1']);
    expect(calls.list[0]).toMatchObject({ viewer: 'main' });

    const human = (await methodOf(deps(control), 'agents.list').handler({}, context())) as {
      agents: unknown[];
    };
    expect(human.agents).toHaveLength(0);
  });

  it('isolates a mixed batch and preserves input order', async () => {
    const { control } = fakeControl();
    const result = (await methodOf(deps(control), 'agents.send').handler(
      {
        messages: [
          { to: 'a1', content: 'ok' },
          { to: 'missing', content: 'fail' },
          { to: 'b1', content: 'ok2' },
        ],
      },
      context(),
    )) as { results: AgentSendItemLike[] };

    expect(result.results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(result.results[1]).toMatchObject({ ok: false, code: 'unknown_member' });
  });

  it('maps dispatch / rotate business rejections to per-entry failures', async () => {
    const { control } = fakeControl();
    const dispatched = (await methodOf(deps(control), 'agents.dispatch').handler(
      { messages: [{ to: 'missing', content: 'x' }] },
      context(),
    )) as { results: AgentDispatchItemLike[] };
    expect(dispatched.results[0]).toEqual({
      ok: false,
      code: 'not_visible',
      error: 'not_visible: missing',
    });

    const rotated = (await methodOf(deps(control), 'agents.rotate').handler(
      { agents: [{ to: 'missing', startup_prompt: 'go' }] },
      context(),
    )) as { results: AgentRotateItemLike[] };
    expect(rotated.results[0]).toEqual({
      ok: false,
      code: 'not_visible',
      error: 'not_visible: missing',
    });
  });
});

describe('team-scoped control token', () => {
  function dispatcherFor(control: AgentControlLike) {
    const table = defineMethods(
      createAgentMethods({
        registry: createAgentRegistry(),
        runs: new Map(),
        defaultTenantId: 'default',
        agent: control,
      }),
    );
    const principal = {
      tenant_id: 'default',
      role: 'write' as const,
      scope: 'control' as const,
      team_id: 'alpha',
    };
    return createRpcDispatcher({
      table,
      localPrincipal: principal,
      makeContext: (_method, _params, resolved) => ({
        principal: resolved,
        tenantId: resolved.tenant_id,
        isAdmin: false,
        allTenants: false,
        connection: 'http',
      }),
    });
  }

  async function call(control: AgentControlLike, method: string, params: unknown) {
    const dispatcher = dispatcherFor(control);
    return dispatcher.dispatchFor(
      { v: 1, id: 'test', method, params },
      { tenant_id: 'default', role: 'write', scope: 'control', team_id: 'alpha' },
      'http',
    );
  }

  it('sends only to members of its own team', async () => {
    const { control, calls } = fakeControl();
    const response = await call(control, 'agents.send', {
      messages: [
        { to: 'a1', content: 'ok' },
        { to: 'b1', content: 'denied' },
      ],
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result).toMatchObject({
      results: [{ ok: true }, { ok: false, code: 'not_found' }],
    });
    expect(calls.send).toHaveLength(1);
    expect(calls.send[0]).toMatchObject({ to: 'a1' });
  });

  it('dispatches and rotates only members of its own team (name resolution included)', async () => {
    const { control, calls } = fakeControl();
    const dispatched = await call(control, 'agents.dispatch', {
      messages: [
        { to: 'alice', content: 'ok' },
        { to: 'bob', content: 'denied' },
      ],
    });
    expect(dispatched.ok).toBe(true);
    if (dispatched.ok) {
      expect(dispatched.result).toMatchObject({
        results: [{ ok: true }, { ok: false, code: 'not_found' }],
      });
    }
    expect(calls.dispatch).toHaveLength(1);

    const rotated = await call(control, 'agents.rotate', {
      agents: [
        { to: 'alice', startup_prompt: 'go' },
        { to: 'bob', startup_prompt: 'go' },
      ],
    });
    expect(rotated.ok).toBe(true);
    if (rotated.ok) {
      expect(rotated.result).toMatchObject({
        results: [{ ok: true }, { ok: false, code: 'not_found' }],
      });
    }
    expect(calls.rotate).toHaveLength(1);
  });

  it('keeps agents.create forbidden for team-scoped tokens', async () => {
    const { control } = fakeControl();
    const response = await call(control, 'agents.create', { agents: [{ name: 'x' }] });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('forbidden');
  });
});
