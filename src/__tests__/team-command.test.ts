/**
 * `vessel team` 命令的 exit code / 参数映射（0.19 S3）。
 *
 * 用临时 owner 记录 + 注入 fetch 走完整 CLI 路径，不启动 loopback 端点。
 *
 * @module vessel/__tests__
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentOwnerPath } from '../agent-owner-server';
import type { TeamCommand } from '../cli-args';
import { runTeamCommand } from '../team-command';

const dirs: string[] = [];

async function setup(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-team-cli-'));
  dirs.push(dir);
  await writeFile(
    agentOwnerPath(dir),
    JSON.stringify({
      pid: process.pid,
      host: '127.0.0.1',
      port: 1,
      token: 'test-token',
      started_at: new Date().toISOString(),
      tenant_id: 'default',
    }),
  );
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface RpcBody {
  method: string;
  params: Record<string, unknown>;
}

function rpc(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler: (body: RpcBody) => unknown): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '{}')) as RpcBody;
    return rpc(handler(parsed));
  }) as unknown as typeof fetch;
}

const options = (dataDir: string, fetchImpl: typeof fetch) => ({
  dataDir,
  isAlive: () => true,
  fetchImpl,
});

describe('vessel team command', () => {
  it('exits 1 when any mention delivery is not queued', async () => {
    const dir = await setup();
    const result = await runTeamCommand(
      { kind: 'post', teamId: 'alpha', content: 'hi', mentions: [], json: false },
      options(
        dir,
        fakeFetch(() => ({
          message_id: 'm1',
          team_id: 'alpha',
          kind: 'post',
          mentions: [],
          delivered: [
            {
              agent_id: 'a',
              status: 'rejected',
              code: 'agent_left',
              reason: 'agent_left: a',
            },
          ],
          ts: 1,
        })),
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('agent_left');
  });

  it('exits 0 only when every delivery is queued', async () => {
    const dir = await setup();
    const result = await runTeamCommand(
      { kind: 'post', teamId: 'alpha', content: 'hi', mentions: ['a'], json: false },
      options(
        dir,
        fakeFetch((body) =>
          body.method === 'team.roster'
            ? {
                team_id: 'alpha',
                members: [{ agent_id: 'a', name: 'alice', session_id: 's1' }],
              }
            : {
                message_id: 'm1',
                team_id: 'alpha',
                kind: 'mention',
                mentions: ['a'],
                delivered: [{ agent_id: 'a', status: 'queued', message_id: 'x' }],
                ts: 1,
              },
        ),
      ),
    );
    expect(result.exitCode).toBe(0);
  });

  it('resolves --mention names through the team roster and posts agent ids', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const result = await runTeamCommand(
      { kind: 'post', teamId: 'alpha', content: 'hi', mentions: ['alice'], json: true },
      options(
        dir,
        fakeFetch((body) => {
          calls.push(body);
          if (body.method === 'team.roster') {
            return {
              team_id: 'alpha',
              members: [{ agent_id: 'a', name: 'alice', session_id: 's1' }],
            };
          }
          return {
            message_id: 'm1',
            team_id: 'alpha',
            kind: 'mention',
            mentions: ['a'],
            delivered: [{ agent_id: 'a', status: 'queued' }],
            ts: 1,
          };
        }),
      ),
    );
    expect(result.exitCode).toBe(0);
    const post = calls.find((call) => call.method === 'team.post');
    expect(post?.params.mentions).toEqual(['a']);
  });

  it('team post --mention cannot resolve a member beyond the default 20-member window', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const roster = Array.from({ length: 25 }, (_, index) => ({
      agent_id: `a-${index + 1}`,
      name: `agent${index + 1}`,
      session_id: `s-${index + 1}`,
    }));
    const result = await runTeamCommand(
      { kind: 'post', teamId: 'alpha', content: 'hi', mentions: ['agent25'], json: true },
      options(
        dir,
        fakeFetch((body) => {
          calls.push(body);
          if (body.method === 'team.roster') {
            return { team_id: 'alpha', members: roster };
          }
          return {
            message_id: 'm1',
            team_id: 'alpha',
            kind: 'mention',
            mentions: ['a-25'],
            delivered: [{ agent_id: 'a-25', status: 'queued' }],
            ts: 1,
          };
        }),
      ),
    );
    expect(result.exitCode).toBe(0);
    const rosterCall = calls.find((call) => call.method === 'team.roster');
    expect(rosterCall).toBeDefined();
    expect(calls.some((call) => call.method === 'team.get')).toBe(false);
    const post = calls.find((call) => call.method === 'team.post');
    expect(post?.params.mentions).toEqual(['a-25']);
  });

  it('rejects an unknown mention before calling team.post', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const result = await runTeamCommand(
      { kind: 'post', teamId: 'alpha', content: 'hi', mentions: ['nobody'], json: false },
      options(
        dir,
        fakeFetch((body) => {
          calls.push(body);
          return {
            team: { team_id: 'alpha', name: 'alpha', member_count: 0 },
            members: [],
            messages: [],
          };
        }),
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown team member');
    expect(calls.some((call) => call.method === 'team.post')).toBe(false);
  });

  it('maps list/get/members commands to team methods', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const fetchImpl = fakeFetch((body) => {
      calls.push(body);
      if (body.method === 'team.list') {
        return { teams: [] };
      }
      if (body.method === 'team.get') {
        return {
          team: { team_id: 'alpha', name: 'alpha', member_count: 0 },
          members: [],
          messages: [],
        };
      }
      return { team_id: 'alpha', action: 'add', agent_id: 'a', membership: 'present' };
    });

    const commands: TeamCommand[] = [
      { kind: 'list', json: true },
      { kind: 'get', teamId: 'alpha', json: true },
      { kind: 'members', teamId: 'alpha', action: 'add', member: 'a', json: true },
    ];
    for (const command of commands) {
      const result = await runTeamCommand(command, options(dir, fetchImpl));
      expect(result.exitCode).toBe(0);
    }
    expect(calls.map((call) => call.method)).toEqual(['team.list', 'team.get', 'team.members']);
  });

  it('shows the member window size against the full roster count', async () => {
    const dir = await setup();
    const members = Array.from({ length: 20 }, (_, index) => ({
      agent_id: `m-${index}`,
      name: `n-${index}`,
      session_id: `s-${index}`,
      membership: 'present',
      presence: 'live',
      visibility: 'team',
    }));
    const result = await runTeamCommand(
      { kind: 'get', teamId: 'alpha', json: false },
      options(
        dir,
        fakeFetch(() => ({
          team: { team_id: 'alpha', name: 'alpha', member_count: 57, online_count: 20 },
          members,
          messages: [],
        })),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Members (20 of 57):');
  });

  it('maps team budget status and renders counters', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const result = await runTeamCommand(
      { kind: 'budget-status', teamId: 'alpha', conversationId: 'conv_1', json: false },
      options(
        dir,
        fakeFetch((body) => {
          calls.push(body);
          return {
            action: 'status',
            team_id: 'alpha',
            conversations: [
              {
                conversation_id: 'conv_1',
                created_at: 1,
                last_activity: 2,
                hops: 3,
                turns: 2,
                total_tokens: 42,
                wall_clock_ms: 1500,
                edges: [],
                overrides: { turns: { max: 9, by: 'human', via: 'cli', at: 3 } },
              },
            ],
          };
        }),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual({
      method: 'team.budget',
      params: { team_id: 'alpha', action: 'status', conversation_id: 'conv_1' },
    });
    expect(result.stdout).toContain('conv_1');
    expect(result.stdout).toContain('hops 3');
    expect(result.stdout).toContain('turns 2');
    expect(result.stdout).toContain('tokens 42');
    expect(result.stdout).toContain('wall_clock_ms 1500');
    expect(result.stdout).toContain('turns=9');
    expect(result.stdout).toContain('blocked -');
  });

  it('maps team budget override and keeps --json raw', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const result = await runTeamCommand(
      {
        kind: 'budget-override',
        teamId: 'alpha',
        conversationId: 'conv_1',
        dimension: 'turns',
        max: null,
        json: true,
      },
      options(
        dir,
        fakeFetch((body) => {
          calls.push(body);
          return {
            action: 'override',
            team_id: 'alpha',
            conversation_id: 'conv_1',
            dimension: 'turns',
            previous_max: 5,
            max: null,
            status: { conversation_id: 'conv_1' },
          };
        }),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual({
      method: 'team.budget',
      params: {
        team_id: 'alpha',
        action: 'override',
        conversation_id: 'conv_1',
        dimension: 'turns',
        max: null,
      },
    });
    expect(JSON.parse(result.stdout).max).toBeNull();
  });

  it('exits 1 when team budget is unavailable', async () => {
    const dir = await setup();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'team_not_found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const result = await runTeamCommand(
      { kind: 'budget-status', teamId: 'missing', json: false },
      options(dir, fetchImpl),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('team_not_found');
  });

  it('maps team create to snake_case owner params', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const result = await runTeamCommand(
      {
        kind: 'create',
        workspace: '/ws/alpha',
        name: 'Alpha',
        defaultPrincipal: 'main',
        handoffPath: '/ws/alpha/HANDOFF.md',
        json: true,
      },
      options(
        dir,
        fakeFetch((body) => {
          calls.push(body);
          return {
            team: {
              team_id: 'alpha',
              name: 'Alpha',
              tenant_id: 'default',
              workspace: '/ws/alpha',
              member_count: 0,
              online_count: 0,
              created_at: 1,
            },
            deduplicated: false,
          };
        }),
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual({
      method: 'team.create',
      params: {
        workspace: '/ws/alpha',
        name: 'Alpha',
        default_principal: 'main',
        handoff_path: '/ws/alpha/HANDOFF.md',
      },
    });
    expect(JSON.parse(result.stdout).deduplicated).toBe(false);
  });

  it('maps team update null clears and team archive', async () => {
    const dir = await setup();
    const calls: RpcBody[] = [];
    const fetchImpl = fakeFetch((body) => {
      calls.push(body);
      return {
        team_id: body.params.team_id,
        name: 'Alpha',
        tenant_id: 'default',
        workspace: '/ws/alpha',
        member_count: 0,
        online_count: 0,
        created_at: 1,
        ...(body.method === 'team.archive' ? { archived_at: 2 } : {}),
      };
    });

    await runTeamCommand(
      { kind: 'update', teamId: 'alpha', description: null, json: false },
      options(dir, fetchImpl),
    );
    const archived = await runTeamCommand(
      { kind: 'archive', teamId: 'alpha', json: true },
      options(dir, fetchImpl),
    );

    expect(calls.map((call) => call.method)).toEqual(['team.update', 'team.archive']);
    expect(calls[0]?.params).toEqual({ team_id: 'alpha', description: null });
    expect(calls[1]?.params).toEqual({ team_id: 'alpha' });
    expect(archived.exitCode).toBe(0);
    expect(JSON.parse(archived.stdout).archived_at).toBe(2);
  });

  it('keeps exit 1 with --json when a delivery failed', async () => {
    const dir = await setup();
    const result = await runTeamCommand(
      { kind: 'post', teamId: 'alpha', content: 'hi', mentions: [], json: true },
      options(
        dir,
        fakeFetch(() => ({
          message_id: 'm1',
          team_id: 'alpha',
          kind: 'post',
          mentions: [],
          delivered: [{ agent_id: 'a', status: 'error', code: 'unknown_member' }],
          ts: 1,
        })),
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).delivered[0].status).toBe('error');
  });
});
