/**
 * loopback owner 端点：canonical RPC 传输（0.17 Phase A；0.26 收口）。
 *
 * 守：错误 token / Host；wire 方法名是 canonical `agents.*` / `teams.*`；
 * owner principal 的 sender / viewer 是 owner agent id；批量结果形状与 gateway
 * handler 完全一致；HTTP 状态由 canonical 错误码映射。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentControlLike,
  AgentCreateLikeInput,
  AgentDispatchLikeInput,
  AgentRotateLikeInput,
  AgentSendLikeInput,
  AgentStatusLike,
  TeamControlLike,
} from '../../packages/serve/src/index';
import {
  createAgentMethods,
  createAgentRegistry,
  createRpcDispatcher,
  createTeamMethods,
  defineMethods,
} from '../../packages/serve/src/index';
import {
  AGENT_OWNER_MAX_BODY_BYTES,
  type AgentOwnerServer,
  agentOwnerPath,
  isLoopbackHostHeader,
  parseAgentOwnerRecord,
  readAgentOwnerRecord,
  startAgentOwnerServer,
  writeAgentOwnerRecord,
} from '../agent-owner-server';

const dirs: string[] = [];
const servers: AgentOwnerServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-agent-owner-'));
  dirs.push(dir);
  return dir;
}

function status(id: string, overrides: Partial<AgentStatusLike> = {}): AgentStatusLike {
  return {
    id,
    session_id: id,
    owner: 'main',
    visibility: 'private',
    state: 'idle',
    presence: 'live',
    membership: 'present',
    epoch: 0,
    ...overrides,
  };
}

interface Calls {
  create: AgentCreateLikeInput[];
  close: string[];
  get: string[];
  list: unknown[];
  resolve: string[];
  send: AgentSendLikeInput[];
  dispatch: AgentDispatchLikeInput[];
  rotate: AgentRotateLikeInput[];
  teamList: unknown[];
  teamGet: unknown[];
  teamPost: unknown[];
  teamMembers: unknown[];
  teamBudget: unknown[];
  teamSpawnFrozen: Array<{ teamId: string; frozen: boolean }>;
}

function emptyCalls(): Calls {
  return {
    create: [],
    close: [],
    get: [],
    list: [],
    resolve: [],
    send: [],
    dispatch: [],
    rotate: [],
    teamList: [],
    teamGet: [],
    teamPost: [],
    teamMembers: [],
    teamBudget: [],
    teamSpawnFrozen: [],
  };
}

function fakeControl(calls: Calls): AgentControlLike {
  const members = new Map<string, AgentStatusLike>([
    ['main', status('main')],
    ['m1', status('m1', { team_id: 'alpha' })],
    ['m2', status('m2', { team_id: 'beta' })],
  ]);
  return {
    tenantId: 'default',
    async create(inputs) {
      calls.create.push(...inputs);
      return {
        results: inputs.map((input, index) => ({
          ok: true as const,
          agent: status(`new-${index + 1}`, {
            owner: input.owner ?? 'main',
            ...(input.name !== undefined ? { name: input.name } : {}),
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
      calls.close.push(...ids);
      return {
        results: ids.map((id) =>
          members.has(id)
            ? {
                ok: true as const,
                agent: { ...(members.get(id) as AgentStatusLike), state: 'closed' as const },
                agent_id: id,
                closed: true as const,
              }
            : { ok: false as const, code: 'unknown_member', error: `unknown_member: ${id}` },
        ),
      };
    },
    async get(id) {
      calls.get.push(id);
      return members.get(id);
    },
    async list(input = {}) {
      calls.list.push(input);
      return [...members.values()].filter((member) => {
        if (input.viewer === undefined && member.visibility === 'private') return false;
        if (input.visibility !== undefined && member.visibility !== input.visibility) return false;
        return true;
      });
    },
    async resolve(target) {
      calls.resolve.push(target);
      const direct = members.get(target);
      if (direct !== undefined) return direct;
      const byName = [...members.values()].filter(
        (member) => member.membership === 'present' && member.name === target,
      );
      return byName.length === 1 ? byName[0] : undefined;
    },
    async send(inputs) {
      calls.send.push(...inputs);
      return {
        results: inputs.map((input) =>
          input.to === 'missing'
            ? { ok: false as const, code: 'unknown_member', error: 'unknown_member: missing' }
            : {
                ok: true as const,
                queued: true as const,
                message_id: 'msg1',
                state: 'idle' as const,
              },
        ),
      };
    },
    async dispatch(inputs) {
      calls.dispatch.push(...inputs);
      return {
        results: inputs.map((input) =>
          input.to === 'missing'
            ? { ok: false as const, code: 'not_visible', error: 'not_visible: missing' }
            : {
                ok: true as const,
                status: 'queued' as const,
                message_id: 'msg1',
                resolved_to: input.to,
                resolution: 'live' as const,
              },
        ),
      };
    },
    async rotate(inputs) {
      calls.rotate.push(...inputs);
      return {
        results: inputs.map((input) =>
          input.to === 'missing'
            ? { ok: false as const, code: 'not_visible', error: 'not_visible: missing' }
            : {
                ok: true as const,
                status: 'rotated' as const,
                agent_id: input.to,
                from_session_id: 'old-session',
                to_session_id: 'new-session',
                epoch: 2,
              },
        ),
      };
    },
  };
}

function fakeTeam(calls: Calls): TeamControlLike {
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
    async setSpawnFrozen(teamId, frozen) {
      calls.teamSpawnFrozen.push({ teamId, frozen });
      // 返回完整 TeamSummary：CI 以 VESSEL_VALIDATE_RESULTS=1 跑 result_schema 校验。
      return {
        team_id: teamId,
        name: 'Alpha',
        tenant_id: 'default',
        member_count: 0,
        online_count: 0,
        created_at: 1,
        spawn_frozen: frozen,
      } as never;
    },
    async list(options) {
      calls.teamList.push(options);
      return [];
    },
    async get(teamId, options) {
      calls.teamGet.push([teamId, options]);
      return { team: { team_id: teamId } as never, members: [], messages: [] };
    },
    async roster() {
      return [];
    },
    async post(input) {
      calls.teamPost.push(input);
      return {
        message_id: 'tm1',
        team_id: 'alpha',
        kind: 'post',
        mentions: [],
        delivered: [],
        ts: 1,
      };
    },
    async members(input) {
      calls.teamMembers.push(input);
      return { team_id: 'alpha', action: 'add', agent_id: 'm1', membership: 'present' };
    },
    async budget(input) {
      calls.teamBudget.push(input);
      if ('dimension' in input) {
        return {
          action: 'override' as const,
          team_id: 'alpha',
          conversation_id: input.conversation_id,
          previous_max: 2,
          max: input.max ?? null,
        };
      }
      return { action: 'status' as const, team_id: 'alpha', conversations: [] };
    },
  };
}

async function post(
  server: AgentOwnerServer,
  body: unknown,
  token = server.record.token,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
  return { status: response.status, body: await response.json() };
}

async function start(
  calls: Calls,
  overrides: {
    control?: AgentControlLike;
    teams?: TeamControlLike;
    ownerId?: string;
  } = {},
): Promise<AgentOwnerServer> {
  const server = await startAgentOwnerServer({
    control: overrides.control ?? fakeControl(calls),
    teams: overrides.teams ?? fakeTeam(calls),
    ...(overrides.ownerId !== undefined ? { ownerId: overrides.ownerId } : {}),
    dataDir: tmpDir(),
    tenantId: 'default',
  });
  servers.push(server);
  return server;
}

describe('agent owner server', () => {
  it('rejects a wrong token before dispatching', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    const response = await post(server, { method: 'agents.list', params: {} }, 'wrong');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'agent_owner_unauthorized' },
    });
    expect(calls.list).toHaveLength(0);
  });

  it('maps agents.create / send / close / list with the owner identity', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    await post(server, {
      method: 'agents.create',
      params: {
        agents: [{ name: 'worker', system_prompt: 'be brief', workspace: '/tmp/team-alpha' }],
      },
    });
    await post(server, {
      method: 'agents.send',
      params: { messages: [{ to: 'm1', content: 'hi' }] },
    });
    await post(server, { method: 'agents.close', params: { agents: [{ agent_id: 'm1' }] } });
    await post(server, { method: 'agents.list', params: { visibility: 'private' } });

    expect(calls.create[0]).toMatchObject({
      name: 'worker',
      system_prompt: 'be brief',
      owner: 'main',
      parent_id: 'main',
      workspace: '/tmp/team-alpha',
    });
    expect(calls.send[0]).toEqual({ to: 'm1', content: 'hi', from: 'main' });
    expect(calls.close).toEqual(['m1']);
    expect(calls.list[0]).toEqual({ viewer: 'main', visibility: 'private' });
  });

  it('lists members through canonical agents.list for the owner viewer', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    const response = await post(server, { method: 'agents.list', params: {} });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
    const result = (response.body as { result: { agents: Array<{ id: string }> } }).result;
    expect(Array.isArray(result.agents)).toBe(true);
    expect(result.agents.map((entry) => entry.id)).toContain('main');
    expect(result.agents.map((entry) => entry.id)).toContain('m1');
  });

  it('drops removed handoff_path and maps agents.rotate to owner-scoped service.rotate', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    await post(server, {
      method: 'agents.rotate',
      params: { agents: [{ to: 'worker', startup_prompt: 'go', handoff_path: 'h.md' }] },
    });
    await post(server, {
      method: 'agents.rotate',
      params: { agents: [{ to: 'worker', startup_prompt: 'go' }] },
    });

    expect(calls.rotate[0]).toEqual({
      to: 'worker',
      startup_prompt: 'go',
      from: 'main',
    });
    expect(calls.rotate[0]).not.toHaveProperty('from_session_id');
    expect(calls.rotate[1]).toEqual({ to: 'worker', startup_prompt: 'go', from: 'main' });
  });

  it('preserves mixed batch shapes and per-entry isolation', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    const response = await post(server, {
      method: 'agents.send',
      params: {
        messages: [
          { to: 'm1', content: 'ok' },
          { to: 'missing', content: 'fail' },
        ],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      result: {
        results: [
          { ok: true, queued: true, message_id: 'msg1', state: 'idle' },
          { ok: false, code: 'unknown_member' },
        ],
      },
    });
  });

  it('parity: canonical handler set and owner transport yield the same batch result', async () => {
    const params = {
      messages: [
        { to: 'm1', content: 'ok' },
        { to: 'missing', content: 'fail' },
        { to: 'm1', content: 'again' },
      ],
    };
    const table = defineMethods([
      ...createAgentMethods({
        registry: createAgentRegistry(),
        runs: new Map(),
        defaultTenantId: 'default',
        agent: fakeControl(emptyCalls()),
      }),
    ]);
    const dispatcher = createRpcDispatcher({
      table,
      localPrincipal: { tenant_id: 'default', role: 'admin', scope: 'admin', agent_id: 'main' },
      makeContext: (_method, _params, principal) => ({
        principal,
        tenantId: principal.tenant_id,
        isAdmin: true,
        allTenants: false,
        connection: 'local',
      }),
    });
    const canonical = await dispatcher.dispatchFor(
      { v: 1, id: 'parity', method: 'agents.send', params },
      { tenant_id: 'default', role: 'admin', scope: 'admin', agent_id: 'main' },
      'local',
    );

    const server = await start(emptyCalls());
    const owner = await post(server, { method: 'agents.send', params });

    expect(owner.status).toBe(200);
    expect((owner.body as { result: unknown }).result).toEqual(
      canonical.ok ? canonical.result : canonical.error,
    );
  });

  it('rejects a body above the payload limit before dispatch', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    const response = await post(server, {
      method: 'agents.list',
      params: { pad: 'x'.repeat(AGENT_OWNER_MAX_BODY_BYTES + 1) },
    });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'agent_owner_payload_too_large' },
    });
    expect(calls.list).toHaveLength(0);
  });

  it('keeps service error codes in per-entry failures (team_metadata_corrupt)', async () => {
    const calls = emptyCalls();
    const control = fakeControl(calls);
    const server = await start(calls, {
      control: {
        ...control,
        async create() {
          return {
            results: [{ ok: false, code: 'team_metadata_corrupt', error: 'team.json is corrupt' }],
          };
        },
      },
    });

    const response = await post(server, {
      method: 'agents.create',
      params: { agents: [{ name: 'alpha' }] },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      result: { results: [{ ok: false, code: 'team_metadata_corrupt' }] },
    });
  });

  it('returns canonical not_found for unknown methods', async () => {
    const server = await start(emptyCalls());

    const response = await post(server, { method: 'agent.wait', params: {} });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('maps teams.* with the owner as viewer and from', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    await post(server, { method: 'teams.list', params: {} });
    await post(server, { method: 'teams.get', params: { team_id: 'alpha', limit: 5 } });
    await post(server, {
      method: 'teams.post',
      params: { team_id: 'alpha', content: 'hello', mentions: ['m1'] },
    });
    await post(server, {
      method: 'teams.members',
      params: { team_id: 'alpha', action: 'add', member: 'm1' },
    });

    expect(calls.teamList[0]).toEqual({ viewer: 'main' });
    expect(calls.teamGet[0]).toEqual(['alpha', { viewer: 'main', limit: 5 }]);
    expect(calls.teamPost[0]).toEqual({
      team_id: 'alpha',
      content: 'hello',
      mentions: ['m1'],
      from: 'main',
    });
    expect(calls.teamMembers[0]).toEqual({
      team_id: 'alpha',
      action: 'add',
      member: 'm1',
      from: 'main',
    });
  });

  it('returns 404 for an unknown team', async () => {
    const calls = emptyCalls();
    const server = await start(calls, {
      teams: {
        ...fakeTeam(calls),
        async get() {
          return undefined;
        },
        async members() {
          return undefined;
        },
      },
    });

    const get = await post(server, { method: 'teams.get', params: { team_id: 'missing' } });
    expect(get.status).toBe(404);
    expect(get.body).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const members = await post(server, {
      method: 'teams.members',
      params: { team_id: 'missing', action: 'add', member: 'm1' },
    });
    expect(members.status).toBe(404);
    expect(members.body).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('rejects invalid team parameters with 400', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    const action = await post(server, {
      method: 'teams.members',
      params: { team_id: 'alpha', action: 'promote', member: 'm1' },
    });
    expect(action.status).toBe(400);
    expect(action.body).toMatchObject({ ok: false, error: { code: 'invalid_params' } });

    const teamId = await post(server, { method: 'teams.get', params: { team_id: 42 } });
    expect(teamId.status).toBe(400);
    expect(teamId.body).toMatchObject({ ok: false, error: { code: 'invalid_params' } });

    expect(calls.teamMembers).toHaveLength(0);
    expect(calls.teamGet).toHaveLength(0);
  });

  it('maps teams.budget status and override', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    await post(server, {
      method: 'teams.budget',
      params: { team_id: 'alpha', action: 'status' },
    });
    await post(server, {
      method: 'teams.budget',
      params: {
        team_id: 'alpha',
        action: 'override',
        conversation_id: 'conv_1',
        dimension: 'turns',
        max: 5,
      },
    });

    expect(calls.teamBudget[0]).toEqual({ team_id: 'alpha', action: 'status' });
    expect(calls.teamBudget[1]).toEqual({
      team_id: 'alpha',
      action: 'override',
      conversation_id: 'conv_1',
      dimension: 'turns',
      max: 5,
    });
  });

  it('dispatches teams.spawnFrozen through owner and the shared handler', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    const response = await post(server, {
      method: 'teams.spawnFrozen',
      params: { team_id: 'alpha', frozen: true },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      result: { team_id: 'alpha', spawn_frozen: true },
    });
    expect(calls.teamSpawnFrozen).toEqual([{ teamId: 'alpha', frozen: true }]);

    const localCalls = emptyCalls();
    const dispatcher = createRpcDispatcher({
      table: defineMethods([...createTeamMethods({ teams: fakeTeam(localCalls) })]),
      localPrincipal: { tenant_id: 'default', role: 'admin', scope: 'admin', agent_id: 'main' },
      makeContext: (_method, _params, principal) => ({
        principal,
        tenantId: principal.tenant_id,
        isAdmin: true,
        allTenants: false,
        connection: 'local',
      }),
    });
    const local = await dispatcher.dispatchFor(
      {
        v: 1,
        id: 'freeze',
        method: 'teams.spawnFrozen',
        params: { team_id: 'alpha', frozen: false },
      },
      { tenant_id: 'default', role: 'admin', scope: 'admin', agent_id: 'main' },
      'local',
    );
    expect(local.ok).toBe(true);
    expect(localCalls.teamSpawnFrozen).toEqual([{ teamId: 'alpha', frozen: false }]);
  });

  it('passes conversation_id through send, dispatch and teams.post', async () => {
    const calls = emptyCalls();
    const server = await start(calls);

    await post(server, {
      method: 'agents.send',
      params: { messages: [{ to: 'm1', content: 'hi', conversation_id: 'conv_1' }] },
    });
    await post(server, {
      method: 'agents.dispatch',
      params: {
        messages: [
          { to: 'm1', content: 'a', conversation_id: 'conv_2' },
          { to: 'm1', content: 'b' },
        ],
      },
    });
    await post(server, {
      method: 'teams.post',
      params: { team_id: 'alpha', content: 'hello', conversation_id: 'conv_4' },
    });

    expect(calls.send[0]).toMatchObject({ conversation_id: 'conv_1' });
    expect(calls.dispatch).toEqual([
      { to: 'm1', content: 'a', conversation_id: 'conv_2', from: 'main' },
      { to: 'm1', content: 'b', from: 'main' },
    ]);
    expect(calls.teamPost[0]).toMatchObject({ conversation_id: 'conv_4' });
  });

  it('accepts only loopback Host headers (DNS rebinding)', () => {
    expect(isLoopbackHostHeader('127.0.0.1:1234')).toBe(true);
    expect(isLoopbackHostHeader('localhost:1234')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:1234')).toBe(true);
    expect(isLoopbackHostHeader('evil.example:1234')).toBe(false);
    expect(isLoopbackHostHeader(null)).toBe(false);
  });

  it('reclaims a dead pid and writes its own token record', async () => {
    const dataDir = tmpDir();
    await writeAgentOwnerRecord(dataDir, {
      pid: 999999,
      host: '127.0.0.1',
      port: 1,
      token: 'stale-token',
      started_at: new Date().toISOString(),
      tenant_id: 'default',
    });

    const server = await startAgentOwnerServer({
      control: fakeControl(emptyCalls()),
      teams: fakeTeam(emptyCalls()),
      dataDir,
      tenantId: 'default',
    });
    servers.push(server);

    const record = await readAgentOwnerRecord(dataDir);
    expect(record?.pid).toBe(process.pid);
    expect(record?.token).toBe(server.record.token);
    expect(record?.token).not.toBe('stale-token');

    const response = await post(server, { method: 'agents.list', params: {} });
    expect(response.status).toBe(200);
  });

  it('close removes only its own token file', async () => {
    const dataDir = tmpDir();
    const server = await startAgentOwnerServer({
      control: fakeControl(emptyCalls()),
      teams: fakeTeam(emptyCalls()),
      dataDir,
      tenantId: 'default',
    });
    expect(fs.existsSync(agentOwnerPath(dataDir))).toBe(true);

    await server.stop();
    expect(fs.existsSync(agentOwnerPath(dataDir))).toBe(false);

    await expect(
      fetch(server.url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toBeDefined();
  });

  it('parses only complete owner records', () => {
    expect(
      parseAgentOwnerRecord({
        pid: 1,
        host: '127.0.0.1',
        port: 1234,
        token: 't',
        started_at: new Date().toISOString(),
        tenant_id: 'default',
      }),
    ).not.toBeNull();
    expect(parseAgentOwnerRecord({ pid: 0, host: '127.0.0.1', port: 1, token: 't' })).toBeNull();
  });
});
