/**
 * S8.3 `vessel federation team-info` 契约测试（DECISION-037 §7.2）。
 *
 * 覆盖 CLI 边界与静默故障：非法地址 / 非法 --members 在零请求下 exit 2；
 * 请求形状、目录渲染、对端拒绝 exit 1、allowlist 未命中零请求、token 不落输出。
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FederationPeerConfig, VesselConfig } from '../../packages/config/src/index';
import { parseArgs } from '../cli-args';
import { runFederationCommand } from '../commands/federation';
import { matchCommand } from '../commands/registry';
import { setLocale } from '../i18n';

const PEER_TOKEN = 'secret-team-info-token';
const tempDirs: string[] = [];

beforeAll(() => {
  setLocale('en');
});

afterAll(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vessel-team-info-'));
  tempDirs.push(dir);
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
          allowDirectory: true,
        },
      ],
    },
  } as VesselConfig;
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

function fakeFetch(response: () => Response): {
  fetchImpl: typeof fetch;
  calls: () => number;
  captured: Captured[];
} {
  let calls = 0;
  const captured: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      authorization: headers.get('authorization'),
    });
    return response();
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls, captured };
}

function directoryResponse(): Response {
  return Response.json({
    protocol: 'vessel.federation/1',
    team_id: 'beta',
    name: 'Beta Lab',
    description: 'Where beta works',
    default_principal: 'alice',
    member_count: 2,
    online_count: 1,
    members: [
      { name: 'alice', presence: 'live', last_seen: 1_700_000_000_000 },
      { name: 'bob', presence: 'gone' },
    ],
  });
}

function parsed(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(result.error);
  return result.args;
}

describe('federation team-info args', () => {
  it('parses --to / --members / --json', () => {
    const args = parsed([
      'federation',
      'team-info',
      '--to',
      'human@node-b:beta',
      '--members',
      '5',
      '--json',
    ]);
    expect(args.federationCommand).toEqual({
      kind: 'team-info',
      to: 'human@node-b:beta',
      members: 5,
      json: true,
    });
    expect(matchCommand(args)?.name).toBe('federation');
  });

  it('rejects an out-of-range --members at parse time', () => {
    for (const value of ['0', '101', 'abc']) {
      const result = parseArgs([
        'federation',
        'team-info',
        '--to',
        'human@node-b:beta',
        '--members',
        value,
      ]);
      expect(result.ok).toBe(false);
    }
  });

  it('requires --to', () => {
    const result = parseArgs(['federation', 'team-info', '--json']);
    expect(result.ok).toBe(false);
  });
});

describe('runFederationCommand team-info', () => {
  it('posts the directory request and renders the sanitized result', async () => {
    const mock = fakeFetch(directoryResponse);
    const result = await runFederationCommand(
      { kind: 'team-info', to: 'human@node-b:beta', members: 5, json: false },
      {
        dataDir: await makeDataDir(),
        config: config(),
        env: { PEER_TOKEN },
        fetchImpl: mock.fetchImpl,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(mock.calls()).toBe(1);
    expect(mock.captured[0]?.url).toBe('http://127.0.0.1:1/v1/federation/team-info');
    expect(mock.captured[0]?.authorization).toBe(`Bearer ${PEER_TOKEN}`);
    expect(mock.captured[0]?.body).toEqual({
      protocol: 'vessel.federation/1',
      team_id: 'beta',
      members_limit: 5,
    });
    expect(result.stdout).toContain('Beta Lab');
    expect(result.stdout).toContain('Where beta works');
    expect(result.stdout).toContain('alice');
    expect(result.stdout).toContain('online 1 / 2');
    expect(result.stdout).toContain('live');
    // token / 内部 id 绝不进入输出。
    expect(result.stdout).not.toContain(PEER_TOKEN);
    expect(result.stdout).not.toContain('agent-');
  });

  it('emits the raw result as JSON', async () => {
    const mock = fakeFetch(directoryResponse);
    const result = await runFederationCommand(
      { kind: 'team-info', to: 'human@node-b:beta', json: true },
      {
        dataDir: await makeDataDir(),
        config: config(),
        env: { PEER_TOKEN },
        fetchImpl: mock.fetchImpl,
      },
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      team: { team_id: 'beta', name: 'Beta Lab', member_count: 2, online_count: 1 },
    });
    expect(result.stdout).not.toContain(PEER_TOKEN);
  });

  it('exits 2 with zero requests for a malformed address', async () => {
    const mock = fakeFetch(directoryResponse);
    const result = await runFederationCommand(
      { kind: 'team-info', to: '../escape@node-b:beta', json: false },
      {
        dataDir: await makeDataDir(),
        config: config(),
        env: { PEER_TOKEN },
        fetchImpl: mock.fetchImpl,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toStartWith('federation_invalid_address:');
    expect(mock.calls()).toBe(0);
  });

  it('exits 1 on a peer rejection and preserves the remote code', async () => {
    const mock = fakeFetch(() =>
      Response.json(
        { error: { code: 'not_found', message: 'Not found: /v1/federation/team-info' } },
        { status: 404 },
      ),
    );
    const result = await runFederationCommand(
      { kind: 'team-info', to: 'human@node-b:beta', json: true },
      {
        dataDir: await makeDataDir(),
        config: config(),
        env: { PEER_TOKEN },
        fetchImpl: mock.fetchImpl,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'rejected',
      code: 'federation_peer_error',
      remote_code: 'not_found',
    });
  });

  it('rejects before any request when the target is not allowlisted', async () => {
    const mock = fakeFetch(directoryResponse);
    const result = await runFederationCommand(
      { kind: 'team-info', to: 'human@node-x:beta', json: true },
      {
        dataDir: await makeDataDir(),
        config: config(),
        env: { PEER_TOKEN },
        fetchImpl: mock.fetchImpl,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'rejected',
      code: 'federation_not_allowed',
    });
    expect(mock.calls()).toBe(0);
  });
});
