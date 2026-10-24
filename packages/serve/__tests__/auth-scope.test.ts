/**
 * S5 scope 白名单与 team 过滤：
 * - rpc.ts 中央 scope 规则（view / exchange / control；admin / legacy 不变）；
 * - interactions.list / permission.respond / ask.respond 的 team 过滤与 fail-closed；
 * - control token 的 events 广播 team 过滤。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MemoryEventStream, type RunEvent } from '@vessel-agent/core';
import type { Gateway } from '../src/gateway';
import {
  createInteractionMethods,
  type InteractionSources,
} from '../src/gateway/methods/interactions';
import type { HubTeamScopeLike } from '../src/hub-control';
import type { StoredInteraction } from '../src/interactions-store';
import type { NodeTokenControlLike } from '../src/node-token-control';
import {
  createRpcDispatcher,
  defineMethods,
  RpcError,
  type RpcMethodContext,
  type RpcMethodDefinition,
} from '../src/rpc';
import type { PendingAsk, PendingPermission } from '../src/run-engine';
import type { GatewayAuthLike } from '../src/tenant';
import { createGateway, TestWs } from './helpers';

const gateways: Gateway[] = [];
const clients: TestWs[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const gateway of gateways.splice(0)) {
    void gateway.stop();
  }
});

type Principal = RpcMethodContext['principal'];

function principal(overrides: Partial<Principal> = {}): Principal {
  return { tenant_id: 'default', role: 'write', ...overrides };
}

function makeContext(overrides: Partial<RpcMethodContext> = {}): RpcMethodContext {
  return {
    principal: principal(),
    tenantId: 'default',
    isAdmin: false,
    allTenants: false,
    connection: 'http',
    ...overrides,
  };
}

// ── rpc.ts 中央 scope 规则 ──────────────────────

function method(name: string, permission: RpcMethodDefinition['permission']): RpcMethodDefinition {
  return { name, permission, handler: () => ({ method: name }) };
}

const SCOPE_TABLE = defineMethods([
  method('health.get', 'read'),
  method('capabilities.list', 'read'),
  method('teams.list', 'read'),
  method('teams.get', 'read'),
  method('teams.post', 'write'),
  method('teams.create', 'write'),
  method('teams.update', 'write'),
  method('teams.archive', 'write'),
  method('events.subscribe', 'read'),
  method('interactions.list', 'read'),
  method('permission.respond', 'write'),
  method('ask.respond', 'write'),
  method('auth.exchange', 'write'),
  method('sessions.list', 'read'),
  method('gateway.reload', 'admin'),
]);

const dispatcher = createRpcDispatcher({
  table: SCOPE_TABLE,
  localPrincipal: principal({ role: 'admin' }),
  makeContext: (_method, _params, caller) => ({
    principal: caller,
    tenantId: caller.tenant_id === '*' ? 'default' : caller.tenant_id,
    isAdmin: caller.role === 'admin',
    allTenants: false,
    connection: 'http',
  }),
});

async function dispatch(name: string, caller: Principal) {
  return dispatcher.dispatchFor({ v: 1, id: 'id-1', method: name }, caller, 'http');
}

async function expectAllowed(name: string, caller: Principal): Promise<void> {
  const response = await dispatch(name, caller);
  if (!response.ok) {
    throw new Error(`${name} should be allowed, got ${response.error.code}`);
  }
}

async function expectForbidden(name: string, caller: Principal): Promise<void> {
  const response = await dispatch(name, caller);
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error(`${name} should be forbidden`);
  expect(response.error.code).toBe('forbidden');
}

describe('central scope allowlist', () => {
  it('limits view tokens to health.get and capabilities.list', async () => {
    const view = principal({ role: 'read', scope: 'view' });
    await expectAllowed('health.get', view);
    await expectAllowed('capabilities.list', view);
    await expectForbidden('teams.list', view);
    await expectForbidden('events.subscribe', view);
    await expectForbidden('sessions.list', view);
    await expectForbidden('auth.exchange', view);
  });

  it('limits exchange tokens to auth.exchange', async () => {
    const exchange = principal({ scope: 'exchange' });
    await expectAllowed('auth.exchange', exchange);
    await expectForbidden('health.get', exchange);
    await expectForbidden('sessions.list', exchange);
    await expectForbidden('teams.list', exchange);
  });

  it('limits control tokens to the team data-plane allowlist', async () => {
    const control = principal({ scope: 'control', team_id: 'team-a' });
    for (const name of [
      'health.get',
      'capabilities.list',
      'teams.list',
      'teams.get',
      'teams.post',
      'teams.update',
      'teams.archive',
      'events.subscribe',
      'interactions.list',
      'permission.respond',
      'ask.respond',
    ]) {
      await expectAllowed(name, control);
    }
    // 0.24 S10.3：team-scoped token 不能 create；只能 update / archive 自己的 team。
    await expectForbidden('teams.create', control);
    await expectForbidden('sessions.list', control);
    await expectForbidden('auth.exchange', control);
    await expectForbidden('gateway.reload', control);
  });

  it('keeps admin and legacy principals on the rank rules', async () => {
    // 显式 admin scope：rank 继续生效。
    await expectAllowed('sessions.list', principal({ role: 'admin', scope: 'admin' }));
    await expectAllowed('gateway.reload', principal({ role: 'admin', scope: 'admin' }));
    await expectForbidden('gateway.reload', principal({ role: 'read', scope: 'admin' }));

    // legacy 静态 admin（无 scope）。
    await expectAllowed('sessions.list', principal({ role: 'admin' }));
    await expectAllowed('gateway.reload', principal({ role: 'admin' }));

    // legacy write：read 方法放行，admin 方法仍被 rank 拒绝。
    await expectAllowed('sessions.list', principal({ role: 'write' }));
    await expectForbidden('gateway.reload', principal({ role: 'write' }));
  });
});

// ── interactions 的 team 过滤 ───────────────────

function stored(requestId: string, sessionId: string, createdAt: number): StoredInteraction {
  return {
    requestId,
    run_id: `run-${requestId}`,
    tenant_id: 'default',
    session_id: sessionId,
    tool: 'bash',
    input: { command: 'ls' },
    created_at: createdAt,
    status: 'pending',
  };
}

function pendingPermission(sessionId: string): PendingPermission {
  return {
    run_id: `run-${sessionId}`,
    tenant_id: 'default',
    session_id: sessionId,
    tool: 'bash',
    input: {},
    ts: 1,
  };
}

function pendingAsk(sessionId: string): PendingAsk {
  return {
    run_id: `run-${sessionId}`,
    tenant_id: 'default',
    session_id: sessionId,
    ts: 1,
  };
}

function makeSources(): InteractionSources {
  const interactionRecords = new Map<string, StoredInteraction>([
    ['r1', stored('r1', 's1', 100)],
    ['r2', stored('r2', 's2', 200)],
  ]);
  const pendingPermissions = new Map<string, PendingPermission>([
    ['p1', pendingPermission('s1')],
    ['p2', pendingPermission('s2')],
  ]);
  const pendingAsks = new Map<string, PendingAsk>([
    ['ask1', pendingAsk('s1')],
    ['ask2', pendingAsk('s2')],
  ]);
  return { interactionRecords, pendingPermissions, pendingAsks };
}

function makeInteractionMethods(teamScope?: HubTeamScopeLike) {
  const respondCalls: string[] = [];
  const askCalls: string[] = [];
  const methods = createInteractionMethods({
    respondPermission: (requestId, decision) => {
      respondCalls.push(requestId);
      return { ok: true, decision, scope: 'once' };
    },
    respondAsk: (requestId) => {
      askCalls.push(requestId);
    },
    interactions: makeSources(),
    ...(teamScope !== undefined ? { teamScope } : {}),
  });
  return {
    byName: new Map(methods.map((entry) => [entry.name, entry])),
    respondCalls,
    askCalls,
  };
}

const TEAM_SCOPE: HubTeamScopeLike = {
  teamForSession: (sessionId) => {
    if (sessionId === 's1') return 'team-a';
    if (sessionId === 's2') return 'team-b';
    return undefined;
  },
};

async function call(
  methods: Map<string, RpcMethodDefinition>,
  name: string,
  params: Record<string, unknown>,
  ctx: RpcMethodContext,
): Promise<unknown> {
  const definition = methods.get(name);
  if (definition === undefined) throw new Error(`missing method ${name}`);
  return definition.handler(params, ctx);
}

function listedIds(result: unknown): string[] {
  const interactions = (result as { interactions?: Array<{ request_id?: unknown }> }).interactions;
  if (!Array.isArray(interactions)) return [];
  return interactions
    .map((item) => item.request_id)
    .filter((id): id is string => typeof id === 'string');
}

describe('team-scoped interactions', () => {
  it('lists only interactions mapped to the control token team', async () => {
    const { byName } = makeInteractionMethods(TEAM_SCOPE);
    const teamA = makeContext({
      principal: principal({ scope: 'control', team_id: 'team-a' }),
    });
    const teamB = makeContext({
      principal: principal({ scope: 'control', team_id: 'team-b' }),
    });

    const listA = listedIds(await call(byName, 'interactions.list', {}, teamA));
    expect(listA.sort()).toEqual(['ask1', 'p1', 'r1']);
    const listB = listedIds(await call(byName, 'interactions.list', {}, teamB));
    expect(listB.sort()).toEqual(['ask2', 'p2', 'r2']);
  });

  it('forbids responding to another team without leaking existence', async () => {
    const { byName, respondCalls, askCalls } = makeInteractionMethods(TEAM_SCOPE);
    const teamA = makeContext({
      principal: principal({ scope: 'control', team_id: 'team-a' }),
    });

    await expect(
      call(byName, 'permission.respond', { request_id: 'r2', decision: 'allow' }, teamA),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      call(byName, 'permission.respond', { request_id: 'missing', decision: 'allow' }, teamA),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(
      call(byName, 'ask.respond', { request_id: 'ask2', answers: [] }, teamA),
    ).rejects.toBeInstanceOf(RpcError);
    expect(respondCalls).toEqual([]);
    expect(askCalls).toEqual([]);

    await call(byName, 'permission.respond', { request_id: 'r1', decision: 'allow' }, teamA);
    await call(byName, 'ask.respond', { request_id: 'ask1', answers: [] }, teamA);
    expect(respondCalls).toEqual(['r1']);
    expect(askCalls).toEqual(['ask1']);
  });

  it('fails closed when the team mapping is unavailable', async () => {
    const { byName, respondCalls } = makeInteractionMethods();
    const teamA = makeContext({
      principal: principal({ scope: 'control', team_id: 'team-a' }),
    });

    expect(listedIds(await call(byName, 'interactions.list', {}, teamA))).toEqual([]);
    await expect(
      call(byName, 'permission.respond', { request_id: 'r1', decision: 'allow' }, teamA),
    ).rejects.toBeInstanceOf(RpcError);
    expect(respondCalls).toEqual([]);
  });

  it('keeps admin and legacy principals unfiltered', async () => {
    const { byName, respondCalls } = makeInteractionMethods(TEAM_SCOPE);
    const admin = makeContext({
      principal: principal({ role: 'admin' }),
      isAdmin: true,
    });

    expect(listedIds(await call(byName, 'interactions.list', {}, admin)).sort()).toEqual([
      'ask1',
      'ask2',
      'p1',
      'p2',
      'r1',
      'r2',
    ]);
    await call(byName, 'permission.respond', { request_id: 'r2', decision: 'deny' }, admin);
    expect(respondCalls).toEqual(['r2']);
  });
});

// ── gateway 广播过滤 ────────────────────────────

function authForControl(): GatewayAuthLike {
  return {
    configured: true,
    authenticate(token) {
      if (token === 'control-token') {
        return {
          tenant_id: 'default',
          role: 'write',
          scope: 'control',
          team_id: 'team-a',
        };
      }
      return null;
    },
  };
}

function eventWithSession(runId: string, sessionId: string): RunEvent {
  return {
    type: 'run.started',
    run_id: runId,
    data: {},
    ts: Date.now(),
    session_id: sessionId,
  } as unknown as RunEvent;
}

function frameSessionId(frame: unknown): string | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined;
  const event = (frame as { event?: unknown }).event;
  if (typeof event !== 'object' || event === null) return undefined;
  const sessionId = (event as { session_id?: unknown }).session_id;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

describe('control token event broadcast', () => {
  it('delivers only events mapped to the token team and enforces scope', async () => {
    const events = new MemoryEventStream();
    const gateway = createGateway({
      events,
      auth: authForControl(),
      hubTeamScope: TEAM_SCOPE,
    });
    gateways.push(gateway);
    const client = await TestWs.connect(gateway, { token: 'control-token' });
    clients.push(client);
    await client.next((frame) => frame.kind === 'hello');

    // 中央 scope 规则同样作用于 WS。
    let denied: unknown;
    try {
      await client.request('runs.list');
    } catch (error) {
      denied = error;
    }
    expect(String(denied)).toContain('forbidden');

    const listed = (await client.request('interactions.list')) as {
      interactions?: unknown[];
    };
    expect(Array.isArray(listed.interactions)).toBe(true);

    // s2 先发；若过滤失效会在 s1 之前到达。
    events.publish(eventWithSession('run-b', 's2'));
    events.publish(eventWithSession('run-a', 's1'));

    const frame = await client.next(
      (candidate) => candidate.kind === 'event' && frameSessionId(candidate) === 's1',
    );
    expect(frame.kind).toBe('event');
    await expect(
      client.next(
        (candidate) => candidate.kind === 'event' && frameSessionId(candidate) === 's2',
        100,
      ),
    ).rejects.toThrow();
  });

  it('closes a live WS when its token_id is revoked', async () => {
    let onRevoke: ((tokenId: string) => void) | undefined;
    const nodeTokens = {
      authenticate: () => null,
      hasTokens: () => true,
      mintPairingTokens: async () => {
        throw new Error('not used');
      },
      exchange: async () => {
        throw new Error('not used');
      },
      revoke: async () => {
        throw new Error('not used');
      },
      list: async () => [],
      onRevoke(listener: (tokenId: string) => void) {
        onRevoke = listener;
        return () => {
          onRevoke = undefined;
        };
      },
    } satisfies NodeTokenControlLike;

    const gateway = createGateway({
      auth: {
        configured: true,
        authenticate(token) {
          return token === 'revoke-token'
            ? {
                tenant_id: 'default',
                role: 'write',
                scope: 'control',
                team_id: 'team-1',
                token_id: 't1',
              }
            : null;
        },
      },
      nodeTokens,
    });
    gateways.push(gateway);
    const client = await TestWs.connect(gateway, { token: 'revoke-token' });
    clients.push(client);
    // 等 auth 处理完（hello）后再吊销；否则 principal 尚未写入 ws.data。
    await client.next((frame) => frame.kind === 'hello');
    if (onRevoke === undefined) throw new Error('onRevoke was not registered');
    onRevoke('t1');
    expect(await client.closed(2000)).toBe(4401);
  });
});
