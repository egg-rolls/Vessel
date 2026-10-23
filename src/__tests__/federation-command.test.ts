import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FederationPeerConfig, VesselConfig } from '../../packages/config/src/index';
import { parseArgs } from '../cli-args';
import { runFederationCommand } from '../commands/federation';
import { matchCommand } from '../commands/registry';
import { setLocale } from '../i18n';

const SEA_TOKEN = 'secret-token-value';
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const tempDirs: string[] = [];

beforeAll(() => {
  setLocale('en');
});

afterAll(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function parsed(args: string[]) {
  const result = parseArgs(args);
  if (!result.ok) throw new Error(result.error);
  return result.args;
}

async function makeDataDir(teams: string[] = ['demo']): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vessel-federation-'));
  tempDirs.push(dir);
  for (const team of teams) {
    const teamDir = path.join(dir, 'teams', 'default', team);
    await mkdir(teamDir, { recursive: true });
    await writeFile(path.join(teamDir, 'team.json'), '{"v":1}\n');
  }
  return dir;
}

function config(
  overrides: { enabled?: boolean; peers?: FederationPeerConfig[] } = {},
): VesselConfig {
  return {
    host: { nodeId: 'node-a' },
    federation: {
      enabled: overrides.enabled ?? true,
      peers: overrides.peers ?? [
        {
          nodeId: 'node-b',
          teamId: 'beta',
          url: 'http://127.0.0.1:1',
          tokenEnv: 'PEER_TOKEN',
          direction: 'out',
        },
      ],
    },
  } as VesselConfig;
}

function startServer(handler: () => Response | Promise<Response>): {
  url: string;
  requests: () => number;
} {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      requests++;
      return handler();
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests: () => requests };
}

function success(): Response {
  return Response.json(
    { protocol: 'vessel.federation/1', ok: true, message_id: 'remote-1', cursor: 'cursor-1' },
    { status: 202 },
  );
}

describe('parseFederationArgs', () => {
  it('parses post flags and content', () => {
    const args = parsed([
      'federation',
      'post',
      'node-b:beta',
      'hello',
      'world',
      '--from-team',
      'demo',
      '--conversation-id',
      'conv-1',
      '--json',
    ]);
    expect(args.federationCommand).toEqual({
      kind: 'post',
      nodeId: 'node-b',
      teamId: 'beta',
      content: 'hello world',
      fromTeam: 'demo',
      conversationId: 'conv-1',
      json: true,
    });
  });

  it('requires a target, content, and --from-team', () => {
    const missingTarget = parseArgs(['federation', 'post', '--from-team', 'demo']);
    expect(missingTarget.ok).toBe(false);
    const missingFrom = parseArgs(['federation', 'post', 'node-b:beta', 'hi']);
    expect(missingFrom.ok).toBe(false);
    if (missingFrom.ok) return;
    expect(missingFrom.error).toContain('--from-team');
    const badTarget = parseArgs(['federation', 'post', 'node-b', 'hi', '--from-team', 'demo']);
    expect(badTarget.ok).toBe(false);
  });

  it('parses peers and registers the command', () => {
    const args = parsed(['federation', 'peers', '--json']);
    expect(args.federationCommand).toEqual({ kind: 'peers', json: true });
    expect(matchCommand(args)?.name).toBe('federation');
  });
});

describe('runFederationCommand', () => {
  it('lists peers without exposing token values', async () => {
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(
      { kind: 'peers', json: true },
      {
        dataDir,
        config: config({
          peers: [
            {
              nodeId: 'node-b',
              teamId: 'beta',
              url: 'http://127.0.0.1:1',
              tokenEnv: 'PEER_TOKEN',
              direction: 'out',
            },
            { nodeId: 'node-c', teamId: 'gamma', tokenEnv: 'MISSING_TOKEN', direction: 'in' },
          ],
        }),
        env: { PEER_TOKEN: SEA_TOKEN },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(SEA_TOKEN);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(body.node_id).toBe('node-a');
    expect(body.max_hops).toBe(4);
    expect(body.peers).toEqual([
      {
        node_id: 'node-b',
        team_id: 'beta',
        direction: 'out',
        token_env: 'PEER_TOKEN',
        token_set: true,
      },
      {
        node_id: 'node-c',
        team_id: 'gamma',
        direction: 'in',
        token_env: 'MISSING_TOKEN',
        token_set: false,
      },
    ]);
  });

  it('renders peers as human output', async () => {
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(
      { kind: 'peers', json: false },
      { dataDir, config: config(), env: { PEER_TOKEN: SEA_TOKEN } },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PEER_TOKEN');
    expect(result.stdout).toContain('node-b');
    expect(result.stdout).not.toContain(SEA_TOKEN);
  });

  it('posts successfully and prints JSON only', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(
      {
        kind: 'post',
        nodeId: 'node-b',
        teamId: 'beta',
        content: 'hello',
        fromTeam: 'demo',
        json: true,
      },
      {
        dataDir,
        config: config({
          peers: [
            {
              nodeId: 'node-b',
              teamId: 'beta',
              url: mock.url,
              tokenEnv: 'PEER_TOKEN',
              direction: 'out',
            },
          ],
        }),
        env: { PEER_TOKEN: SEA_TOKEN },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'delivered',
      message_id: 'remote-1',
      hop: 1,
      cursor: 'cursor-1',
    });
    expect(mock.requests()).toBe(1);
  });

  it('rejects before any request when the target is not allowlisted', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(
      {
        kind: 'post',
        nodeId: 'node-x',
        teamId: 'beta',
        content: 'hello',
        fromTeam: 'demo',
        json: false,
      },
      {
        dataDir,
        config: config({
          peers: [
            {
              nodeId: 'node-b',
              teamId: 'beta',
              url: mock.url,
              tokenEnv: 'PEER_TOKEN',
              direction: 'out',
            },
          ],
        }),
        env: { PEER_TOKEN: SEA_TOKEN },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('federation_not_allowed');
    expect(mock.requests()).toBe(0);
  });

  it('fails with team_not_found when the local Team is missing', async () => {
    const dataDir = await makeDataDir(['demo']);
    const result = await runFederationCommand(
      {
        kind: 'post',
        nodeId: 'node-b',
        teamId: 'beta',
        content: 'hello',
        fromTeam: 'missing',
        json: false,
      },
      { dataDir, config: config(), env: { PEER_TOKEN: SEA_TOKEN } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toStartWith('team_not_found:');
  });

  it('treats an invalid --from-team as a usage error', async () => {
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(
      {
        kind: 'post',
        nodeId: 'node-b',
        teamId: 'beta',
        content: 'hello',
        fromTeam: '../escape',
        json: false,
      },
      { dataDir, config: config(), env: { PEER_TOKEN: SEA_TOKEN } },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith('federation_invalid:');
  });

  it('reports federation_disabled for post and peers', async () => {
    const dataDir = await makeDataDir();
    const post = await runFederationCommand(
      {
        kind: 'post',
        nodeId: 'node-b',
        teamId: 'beta',
        content: 'hello',
        fromTeam: 'demo',
        json: true,
      },
      { dataDir, config: config({ enabled: false }), env: { PEER_TOKEN: SEA_TOKEN } },
    );
    expect(post.exitCode).toBe(1);
    expect(JSON.parse(post.stdout)).toMatchObject({
      status: 'rejected',
      code: 'federation_disabled',
    });

    const peers = await runFederationCommand(
      { kind: 'peers', json: true },
      { dataDir, config: config({ enabled: false }), env: { PEER_TOKEN: SEA_TOKEN } },
    );
    expect(peers.exitCode).toBe(0);
    expect(JSON.parse(peers.stdout)).toMatchObject({ enabled: false });
  });

  it('reports peer errors with the remote code', async () => {
    const mock = startServer(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'federation_unauthorized', message: 'bad token' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(
      {
        kind: 'post',
        nodeId: 'node-b',
        teamId: 'beta',
        content: 'hello',
        fromTeam: 'demo',
        json: true,
      },
      {
        dataDir,
        config: config({
          peers: [
            {
              nodeId: 'node-b',
              teamId: 'beta',
              url: mock.url,
              tokenEnv: 'PEER_TOKEN',
              direction: 'out',
            },
          ],
        }),
        env: { PEER_TOKEN: SEA_TOKEN },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'rejected',
      code: 'federation_peer_error',
      reason: 'bad token',
      remote_code: 'federation_unauthorized',
    });
  });
});
