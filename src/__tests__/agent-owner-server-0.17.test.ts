/**
 * 0.17 Phase A owner 端点。
 *
 * 守：错误 token 拿到结果、方法参数没有映射到 AgentService（owner 可伪造 /
 * private 可见性泄漏）、stale pid 不回收导致新 REPL 永远写不进 token、
 * close 后 token 文件残留把 CLI 指到已关闭端口。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentService, AgentTeamService, MemberStatus } from '@vessel-agent/agent';
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

interface Calls {
  new: unknown[];
  send: unknown[];
  close: unknown[];
  list: unknown[];
  rotate: unknown[];
  dispatch: unknown[];
  teamList: unknown[];
  teamGet: unknown[];
  teamPost: unknown[];
  teamMembers: unknown[];
  teamBudget: unknown[];
}

function fakeService(calls: Calls): AgentService {
  const status = (id: string): MemberStatus => ({
    id,
    session_id: id,
    owner: 'main',
    visibility: 'private',
    state: 'idle',
  });
  return {
    'new': async (input: unknown) => {
      calls.new.push(input);
      return status('m1');
    },
    attachOwner: async () => status('main'),
    send: async (input: unknown) => {
      calls.send.push(input);
      return { queued: true, message_id: 'msg1', state: 'idle' };
    },
    close: async (input: unknown) => {
      calls.close.push(input);
      return { results: [{ ok: true, status: { state: 'closed' } }] };
    },
    list: async (filter: unknown) => {
      calls.list.push(filter);
      return [status('m1')];
    },
    dispatch: async (input: unknown) => {
      calls.dispatch.push(input);
      return { status: 'queued', message_id: 'msg1', resolved_to: 'm1', resolution: 'live' };
    },
    rotate: async (input: unknown) => {
      calls.rotate.push(input);
      return {
        status: 'rotated',
        agent_id: 'm1',
        from_session_id: 'old-session',
        to_session_id: 'new-session',
        epoch: 2,
      };
    },
    reply: async () => ({ queued: true, message_id: 'r1', to: 'main' }),
    identify: async () => undefined,
    reinstate: async (input: unknown) => {
      calls.new.push(input);
      return status('m1');
    },
    flushSnapshot: async () => {},
    subscribe: () => () => {},
  } as unknown as AgentService;
}

function fakeTeam(calls: Calls, overrides: Record<string, unknown> = {}): AgentTeamService {
  return {
    tenantId: 'default',
    list: async (options: unknown) => {
      calls.teamList.push(options);
      return [];
    },
    get: async (teamId: string, options: unknown) => {
      calls.teamGet.push([teamId, options]);
      return { team: { team_id: teamId }, members: [], messages: [] };
    },
    roster: async () => [],
    post: async (input: unknown) => {
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
    members: async (input: unknown) => {
      calls.teamMembers.push(input);
      return { team_id: 'alpha', action: 'add', agent_id: 'm1', membership: 'present' };
    },
    budget: async (input: unknown) => {
      calls.teamBudget.push(input);
      const entry = input as Record<string, unknown>;
      if (entry.dimension !== undefined) {
        return {
          action: 'override',
          team_id: 'alpha',
          conversation_id: entry.conversation_id,
          dimension: entry.dimension,
          previous_max: 2,
          max: entry.max,
          status: { conversation_id: entry.conversation_id },
        };
      }
      return { action: 'status', team_id: 'alpha', conversations: [] };
    },
    send: async () => ({ status: 'error', logged: false }),
    listForCaller: async () => [],
    identify: async () => undefined,
    subscribe: () => () => {},
    dispose: () => {},
    ...overrides,
  } as unknown as AgentTeamService;
}

function emptyCalls(): Calls {
  return {
    new: [],
    send: [],
    close: [],
    list: [],
    rotate: [],
    dispatch: [],
    teamList: [],
    teamGet: [],
    teamPost: [],
    teamMembers: [],
    teamBudget: [],
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

describe('agent owner server', () => {
  it('rejects a wrong token before dispatching', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const response = await post(server, { method: 'agent.list', params: {} }, 'wrong');
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'agent_owner_unauthorized' },
    });
    expect(calls.list).toHaveLength(0);
  });

  it('maps new/send/close/list to owner-scoped AgentService calls', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    await post(server, {
      method: 'agent.new',
      params: {
        name: 'worker',
        system_prompt: 'be brief',
        owner: 'spoofed',
        parentId: 'x',
        workspace: '/tmp/team-alpha',
      },
    });
    await post(server, { method: 'agent.send', params: { to: 'm1', content: 'hi' } });
    await post(server, { method: 'agent.close', params: { members: ['m1'] } });
    await post(server, { method: 'agent.list', params: { visibility: 'private' } });

    expect(calls.new[0]).toMatchObject({
      name: 'worker',
      systemPrompt: 'be brief',
      owner: 'main',
      parentId: 'main',
      workspace: '/tmp/team-alpha',
    });
    expect(calls.new[0]).not.toHaveProperty('system_prompt');
    expect(calls.send[0]).toMatchObject({ to: 'm1', content: 'hi', from: 'main' });
    expect(calls.close[0]).toEqual({ members: ['m1'] });
    expect(calls.list[0]).toEqual({ viewer: 'main', visibility: 'private' });
  });

  it('maps agent.rotate to owner-scoped service.rotate without from_session_id', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    await post(server, {
      method: 'agent.rotate',
      params: { to: 'worker', startup_prompt: 'go', handoff_path: 'h.md' },
    });
    await post(server, {
      method: 'agent.rotate',
      params: { to: 'worker', startup_prompt: 'go' },
    });

    expect(calls.rotate[0]).toEqual({
      to: 'worker',
      startup_prompt: 'go',
      handoff_path: 'h.md',
      from: 'main',
    });
    expect(calls.rotate[0]).not.toHaveProperty('from_session_id');
    expect(calls.rotate[1]).toEqual({ to: 'worker', startup_prompt: 'go', from: 'main' });
  });

  it('rejects a body above the payload limit before dispatch', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const response = await post(server, {
      method: 'agent.list',
      params: { pad: 'x'.repeat(AGENT_OWNER_MAX_BODY_BYTES + 1) },
    });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'agent_owner_payload_too_large' },
    });
    expect(calls.list).toHaveLength(0);
  });

  it('maps AgentService codes to the response', async () => {
    const service = {
      ...fakeService(emptyCalls()),
      list: async () => {
        throw Object.assign(new Error('unknown_member: nope'), { code: 'unknown_member' });
      },
    } as unknown as AgentService;
    const server = await startAgentOwnerServer({
      service,
      team: fakeTeam(emptyCalls()),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const response = await post(server, { method: 'agent.list', params: {} });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'unknown_member' },
    });
  });

  it('returns a stable code for unknown methods', async () => {
    const server = await startAgentOwnerServer({
      service: fakeService(emptyCalls()),
      team: fakeTeam(emptyCalls()),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const response = await post(server, { method: 'agent.wait', params: {} });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'agent_owner_unknown_method' },
    });
  });

  it('maps team methods with the owner as viewer and from', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    await post(server, { method: 'team.list', params: {} });
    await post(server, { method: 'team.get', params: { team_id: 'alpha', limit: 5 } });
    await post(server, {
      method: 'team.post',
      params: { team_id: 'alpha', content: 'hello', mentions: ['m1'] },
    });
    await post(server, {
      method: 'team.members',
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
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls, {
        get: async () => undefined,
        members: async () => undefined,
      }),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const get = await post(server, { method: 'team.get', params: { team_id: 'missing' } });
    expect(get.status).toBe(404);
    expect(get.body).toMatchObject({ ok: false, error: { code: 'team_not_found' } });

    const members = await post(server, {
      method: 'team.members',
      params: { team_id: 'missing', action: 'add', member: 'm1' },
    });
    expect(members.status).toBe(404);
    expect(members.body).toMatchObject({ ok: false, error: { code: 'team_not_found' } });
  });

  it('rejects invalid team parameters with 400', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const action = await post(server, {
      method: 'team.members',
      params: { team_id: 'alpha', action: 'promote', member: 'm1' },
    });
    expect(action.status).toBe(400);
    expect(action.body).toMatchObject({ ok: false, error: { code: 'invalid_input' } });

    const teamId = await post(server, { method: 'team.get', params: { team_id: 42 } });
    expect(teamId.status).toBe(400);
    expect(teamId.body).toMatchObject({ ok: false, error: { code: 'invalid_input' } });

    expect(calls.teamMembers).toHaveLength(0);
    expect(calls.teamGet).toHaveLength(0);
  });

  it('maps team.budget status and override with via cli', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    await post(server, {
      method: 'team.budget',
      params: { team_id: 'alpha', action: 'status' },
    });
    await post(server, {
      method: 'team.budget',
      params: { team_id: 'alpha', action: 'status', conversation_id: 'conv_1' },
    });
    await post(server, {
      method: 'team.budget',
      params: {
        team_id: 'alpha',
        action: 'override',
        conversation_id: 'conv_1',
        dimension: 'turns',
        max: 5,
      },
    });
    await post(server, {
      method: 'team.budget',
      params: {
        team_id: 'alpha',
        action: 'override',
        conversation_id: 'conv_1',
        dimension: 'tokens',
        max: null,
      },
    });

    expect(calls.teamBudget[0]).toEqual({ team_id: 'alpha' });
    expect(calls.teamBudget[1]).toEqual({ team_id: 'alpha', conversation_id: 'conv_1' });
    expect(calls.teamBudget[2]).toEqual({
      team_id: 'alpha',
      conversation_id: 'conv_1',
      dimension: 'turns',
      max: 5,
      via: 'cli',
    });
    expect(calls.teamBudget[3]).toEqual({
      team_id: 'alpha',
      conversation_id: 'conv_1',
      dimension: 'tokens',
      max: null,
      via: 'cli',
    });
  });

  it('rejects invalid team.budget params with 400', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const invalid = await post(server, {
      method: 'team.budget',
      params: { team_id: 'alpha', action: 'reset' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ ok: false, error: { code: 'invalid_input' } });

    const missingConversation = await post(server, {
      method: 'team.budget',
      params: { team_id: 'alpha', action: 'override', dimension: 'turns', max: 5 },
    });
    expect(missingConversation.status).toBe(400);

    const badDimension = await post(server, {
      method: 'team.budget',
      params: {
        team_id: 'alpha',
        action: 'override',
        conversation_id: 'conv_1',
        dimension: 'cost',
        max: 5,
      },
    });
    expect(badDimension.status).toBe(400);

    const missingMax = await post(server, {
      method: 'team.budget',
      params: {
        team_id: 'alpha',
        action: 'override',
        conversation_id: 'conv_1',
        dimension: 'turns',
      },
    });
    expect(missingMax.status).toBe(400);

    const badMax = await post(server, {
      method: 'team.budget',
      params: {
        team_id: 'alpha',
        action: 'override',
        conversation_id: 'conv_1',
        dimension: 'turns',
        max: '5',
      },
    });
    expect(badMax.status).toBe(400);

    expect(calls.teamBudget).toHaveLength(0);
  });

  it('returns 404 when team budget is unavailable', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls, { budget: undefined }),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    const response = await post(server, {
      method: 'team.budget',
      params: { team_id: 'alpha', action: 'status' },
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ ok: false, error: { code: 'team_not_found' } });
  });

  it('passes conversation_id through send, dispatch and team.post', async () => {
    const calls = emptyCalls();
    const server = await startAgentOwnerServer({
      service: fakeService(calls),
      team: fakeTeam(calls),
      dataDir: tmpDir(),
      tenantId: 'default',
    });
    servers.push(server);

    await post(server, {
      method: 'agent.send',
      params: { to: 'm1', content: 'hi', conversation_id: 'conv_1' },
    });
    await post(server, {
      method: 'agent.send',
      params: {
        messages: [
          { to: 'm1', content: 'a', conversation_id: 'conv_2' },
          { to: 'm1', content: 'b' },
        ],
      },
    });
    await post(server, {
      method: 'agent.dispatch',
      params: { to: 'm1', content: 'go', conversation_id: 'conv_3' },
    });
    await post(server, {
      method: 'team.post',
      params: {
        team_id: 'alpha',
        content: 'hello',
        conversation_id: 'conv_4',
      },
    });

    expect(calls.send[0]).toMatchObject({ conversation_id: 'conv_1' });
    expect(calls.send[1]).toEqual({
      messages: [
        { to: 'm1', content: 'a', conversation_id: 'conv_2', from: 'main' },
        { to: 'm1', content: 'b', from: 'main' },
      ],
    });
    expect(calls.dispatch[0]).toEqual({
      to: 'm1',
      content: 'go',
      conversation_id: 'conv_3',
      from: 'main',
    });
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
      service: fakeService(emptyCalls()),
      team: fakeTeam(emptyCalls()),
      dataDir,
      tenantId: 'default',
    });
    servers.push(server);

    const record = await readAgentOwnerRecord(dataDir);
    expect(record?.pid).toBe(process.pid);
    expect(record?.token).toBe(server.record.token);
    expect(record?.token).not.toBe('stale-token');

    const response = await post(server, { method: 'agent.list', params: {} });
    expect(response.status).toBe(200);
  });

  it('close removes only its own token file', async () => {
    const dataDir = tmpDir();
    const server = await startAgentOwnerServer({
      service: fakeService(emptyCalls()),
      team: fakeTeam(emptyCalls()),
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
