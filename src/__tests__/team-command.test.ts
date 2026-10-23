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
          body.method === 'team.get'
            ? {
                team: { team_id: 'alpha', name: 'alpha', member_count: 1 },
                members: [{ agent_id: 'a', name: 'alice', session_id: 's1' }],
                messages: [],
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
          if (body.method === 'team.get') {
            return {
              team: { team_id: 'alpha', name: 'alpha', member_count: 1 },
              members: [{ agent_id: 'a', name: 'alice', session_id: 's1' }],
              messages: [],
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
