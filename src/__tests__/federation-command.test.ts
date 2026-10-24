import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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

interface SeedMember {
  name?: string;
  team_id?: string;
  membership?: string;
  visibility?: string;
}

const DEFAULT_MEMBERS: SeedMember[] = [
  { name: 'alice', team_id: 'demo', membership: 'present', visibility: 'team' },
  { name: 'hidden', team_id: 'demo', membership: 'present', visibility: 'private' },
  { name: 'lefty', team_id: 'demo', membership: 'left', visibility: 'team' },
  { name: 'bob', team_id: 'other', membership: 'present', visibility: 'team' },
];

async function makeDataDir(teams: string[] = ['demo'], members = DEFAULT_MEMBERS): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vessel-federation-'));
  tempDirs.push(dir);
  for (const team of teams) {
    const teamDir = path.join(dir, 'teams', 'default', team);
    await mkdir(teamDir, { recursive: true });
    await writeFile(path.join(teamDir, 'team.json'), '{"v":1}\n');
  }
  await mkdir(path.join(dir, 'agents'), { recursive: true });
  await writeFile(
    path.join(dir, 'agents', 'default.json'),
    JSON.stringify({
      version: 2,
      tenant_id: 'default',
      updated_at: 1,
      members,
    }),
  );
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
  bodies: () => Array<Record<string, unknown>>;
} {
  let requests = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      requests++;
      bodies.push((await request.json()) as Record<string, unknown>);
      return handler();
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: () => requests,
    bodies: () => bodies,
  };
}

function success(): Response {
  return Response.json(
    { protocol: 'vessel.federation/1', ok: true, message_id: 'remote-1', cursor: 'cursor-1' },
    { status: 202 },
  );
}

function postCommand(
  overrides: { to?: string; from?: string; content?: string; json?: boolean } = {},
): {
  kind: 'post';
  to: string;
  from: string;
  content: string;
  json: boolean;
} {
  return {
    kind: 'post',
    to: overrides.to ?? 'eggrolls@node-b:beta',
    from: overrides.from ?? 'alice@node-a:demo',
    content: overrides.content ?? 'hello',
    json: overrides.json ?? false,
  };
}

describe('parseFederationArgs', () => {
  it('parses --to / --from, joins positional content, and keeps --conversation-id', () => {
    const args = parsed([
      'federation',
      'post',
      '--to',
      'eggrolls@node-b:beta',
      '--from',
      'alice@node-a:demo',
      'hello',
      'world',
      '--conversation-id',
      'conv-1',
      '--json',
    ]);
    expect(args.federationCommand).toEqual({
      kind: 'post',
      to: 'eggrolls@node-b:beta',
      from: 'alice@node-a:demo',
      content: 'hello world',
      conversationId: 'conv-1',
      json: true,
    });
  });

  it('rejects missing --to, missing --from, and empty content', () => {
    const missingTo = parseArgs(['federation', 'post', '--from', 'alice@node-a:demo', 'hi']);
    expect(missingTo.ok).toBe(false);
    if (!missingTo.ok) expect(missingTo.error).toContain('--to');

    const missingFrom = parseArgs(['federation', 'post', '--to', 'eggrolls@node-b:beta', 'hi']);
    expect(missingFrom.ok).toBe(false);
    if (!missingFrom.ok) expect(missingFrom.error).toContain('--from');

    const emptyContent = parseArgs([
      'federation',
      'post',
      '--to',
      'eggrolls@node-b:beta',
      '--from',
      'alice@node-a:demo',
    ]);
    expect(emptyContent.ok).toBe(false);
  });

  it('no longer accepts the removed --from-team flag', () => {
    const result = parseArgs([
      'federation',
      'post',
      '--to',
      'eggrolls@node-b:beta',
      'hi',
      '--from-team',
      'demo',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('--from-team');
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
              allowDirectory: true,
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
    expect(body.rate_limit_per_minute).toBe(60);
    expect(body.peers).toEqual([
      {
        node_id: 'node-b',
        team_id: 'beta',
        direction: 'out',
        token_env: 'PEER_TOKEN',
        token_set: true,
        allow_directory: true,
      },
      {
        node_id: 'node-c',
        team_id: 'gamma',
        direction: 'in',
        token_env: 'MISSING_TOKEN',
        token_set: false,
        allow_directory: false,
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
    expect(result.stdout).toContain('allow_directory=false');
    expect(result.stdout).not.toContain(SEA_TOKEN);
  });

  it('posts both principals on the wire and prints JSON only', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(postCommand({ json: true }), {
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
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'delivered',
      message_id: 'remote-1',
      hop: 1,
      cursor: 'cursor-1',
    });
    expect(mock.requests()).toBe(1);
    expect(mock.bodies()[0]).toMatchObject({
      from: { principal: 'alice', node_id: 'node-a', team_id: 'demo' },
      to: { principal: 'eggrolls', node_id: 'node-b', team_id: 'beta' },
    });
  });

  it('accepts owner as the local principal without roster lookup', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(postCommand({ from: 'human@node-a:demo' }), {
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
    });
    expect(result.exitCode).toBe(0);
    expect(mock.requests()).toBe(1);
  });

  it('rejects before any request when the target is not allowlisted', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(postCommand({ to: 'eggrolls@node-x:beta' }), {
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
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('federation_not_allowed');
    expect(mock.requests()).toBe(0);
  });

  it('exits 2 without a request when an address is malformed', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(postCommand({ from: '../escape@node-a:demo' }), {
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
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith('federation_invalid_address:');
    expect(mock.requests()).toBe(0);
  });

  it('exits 2 without a request when --from points at another node', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const result = await runFederationCommand(postCommand({ from: 'alice@node-z:demo' }), {
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
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith('federation_invalid_from:');
    expect(mock.requests()).toBe(0);
  });

  it('exits 2 without a request when the local Team is missing', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir(['demo']);
    const result = await runFederationCommand(postCommand({ from: 'alice@node-a:missing' }), {
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
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith('team_not_found:');
    expect(mock.requests()).toBe(0);
  });

  it('exits 2 without a request when the local principal is private, left, or unknown', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    const runtimeConfig = config({
      peers: [
        {
          nodeId: 'node-b',
          teamId: 'beta',
          url: mock.url,
          tokenEnv: 'PEER_TOKEN',
          direction: 'out',
        },
      ],
    });
    for (const from of [
      'hidden@node-a:demo',
      'lefty@node-a:demo',
      'ghost@node-a:demo',
      'bob@node-a:demo',
    ]) {
      const result = await runFederationCommand(postCommand({ from }), {
        dataDir,
        config: runtimeConfig,
        env: { PEER_TOKEN: SEA_TOKEN },
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toStartWith('federation_invalid_from:');
    }
    expect(mock.requests()).toBe(0);
  });

  it('exits 2 without a request when the local member snapshot is missing', async () => {
    const mock = startServer(success);
    const dataDir = await makeDataDir();
    await unlink(path.join(dataDir, 'agents', 'default.json'));
    const result = await runFederationCommand(postCommand(), {
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
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith('federation_invalid_from:');
    expect(mock.requests()).toBe(0);
  });

  it('reports federation_disabled for post and peers', async () => {
    const dataDir = await makeDataDir();
    const post = await runFederationCommand(postCommand({ json: true }), {
      dataDir,
      config: config({ enabled: false }),
      env: { PEER_TOKEN: SEA_TOKEN },
    });
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
    const result = await runFederationCommand(postCommand({ json: true }), {
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
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'rejected',
      code: 'federation_peer_error',
      reason: 'bad token',
      remote_code: 'federation_unauthorized',
    });
  });
});
