import { beforeAll, describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import { parseArgs } from '../cli-args';
import { runHubCommand } from '../hub-command';
import { setLocale } from '../i18n';

beforeAll(() => {
  setLocale('en');
});

function parsed(args: string[]) {
  const result = parseArgs(args);
  if (!result.ok) throw new Error(result.error);
  return result.args;
}

describe('parseHubArgs', () => {
  it('parses hub start flags', () => {
    const args = parsed([
      'hub',
      'start',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      '/tmp/hub',
      '--allow-remote',
      '--tls-cert',
      '/tmp/cert.pem',
      '--tls-key',
      '/tmp/key.pem',
    ]);
    expect(args.hubCommand).toEqual({
      kind: 'start',
      host: '127.0.0.1',
      port: 0,
      dataDir: '/tmp/hub',
      allowRemote: true,
      tlsCert: '/tmp/cert.pem',
      tlsKey: '/tmp/key.pem',
    });
  });

  it('requires TLS cert and key together', () => {
    const result = parseArgs(['hub', 'start', '--tls-cert', '/tmp/cert.pem']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('both --tls-cert and --tls-key');
  });

  it('parses directory / watch / pair', () => {
    expect(parsed(['hub', 'directory', '--json', '--token-env', 'HUB_TOKEN']).hubCommand).toEqual({
      kind: 'directory',
      json: true,
      tokenEnv: 'HUB_TOKEN',
    });
    expect(parsed(['hub', 'watch', '--hub-url', 'http://127.0.0.1:8643']).hubCommand).toEqual({
      kind: 'watch',
      hubUrl: 'http://127.0.0.1:8643',
    });
    expect(parsed(['hub', 'pair', '--tenant', 'alpha', '--ttl', '120']).hubCommand).toEqual({
      kind: 'pair',
      tenant: 'alpha',
      ttl: 120,
    });
  });

  it('parses node add / list / remove', () => {
    expect(
      parsed([
        'hub',
        'node',
        'add',
        'http://127.0.0.1:8642',
        '--code',
        'ABCD-EFGH',
        '--alias',
        'edge',
      ]).hubCommand,
    ).toEqual({
      kind: 'node-add',
      url: 'http://127.0.0.1:8642',
      code: 'ABCD-EFGH',
      alias: 'edge',
    });
    expect(parsed(['hub', 'node', 'list', '--json']).hubCommand).toEqual({
      kind: 'node-list',
      json: true,
    });
    expect(parsed(['hub', 'node', 'remove', 'node:tenant']).hubCommand).toEqual({
      kind: 'node-remove',
      pairingId: 'node:tenant',
    });
  });

  it('parses token exchange / revoke / list', () => {
    expect(
      parsed([
        'hub',
        'token',
        'exchange',
        'http://127.0.0.1:8642',
        '--team',
        't1',
        '--ttl',
        '60',
        '--admin-token-env',
        'ADMIN_TOKEN',
        '--json',
      ]).hubCommand,
    ).toEqual({
      kind: 'token-exchange',
      nodeUrl: 'http://127.0.0.1:8642',
      teamId: 't1',
      ttl: 60,
      adminTokenEnv: 'ADMIN_TOKEN',
      json: true,
    });
    expect(
      parsed([
        'hub',
        'token',
        'revoke',
        'http://127.0.0.1:8642',
        '--token-id',
        'tok-1',
        '--admin-token-env',
        'ADMIN_TOKEN',
      ]).hubCommand,
    ).toEqual({
      kind: 'token-revoke',
      nodeUrl: 'http://127.0.0.1:8642',
      tokenId: 'tok-1',
      adminTokenEnv: 'ADMIN_TOKEN',
    });
    expect(
      parsed([
        'hub',
        'token',
        'list',
        'http://127.0.0.1:8642',
        '--admin-token-env',
        'ADMIN_TOKEN',
        '--json',
      ]).hubCommand,
    ).toEqual({
      kind: 'token-list',
      nodeUrl: 'http://127.0.0.1:8642',
      adminTokenEnv: 'ADMIN_TOKEN',
      json: true,
    });
  });

  it('parses data-token', () => {
    expect(
      parsed([
        'hub',
        'data-token',
        'node:tenant',
        '--team',
        't1',
        '--token-env',
        'HUB_TOKEN',
        '--ttl',
        '60',
      ]).hubCommand,
    ).toEqual({
      kind: 'data-token',
      pairingId: 'node:tenant',
      teamId: 't1',
      tokenEnv: 'HUB_TOKEN',
      ttl: 60,
    });
  });

  it('rejects plaintext admin tokens and invalid env names', () => {
    const plaintext = parseArgs([
      'hub',
      'token',
      'exchange',
      'http://127.0.0.1:8642',
      '--team',
      't1',
      '--admin-token',
      'secret',
    ]);
    expect(plaintext.ok).toBe(false);

    const invalidEnv = parseArgs([
      'hub',
      'token',
      'exchange',
      'http://127.0.0.1:8642',
      '--team',
      't1',
      '--admin-token-env',
      'TOKEN=secret',
    ]);
    expect(invalidEnv.ok).toBe(false);
    if (invalidEnv.ok) return;
    expect(invalidEnv.error).toContain('environment variable name');
  });

  it('rejects missing and unknown subcommands', () => {
    expect(parseArgs(['hub']).ok).toBe(false);
    expect(parseArgs(['hub', 'node']).ok).toBe(false);
    expect(parseArgs(['hub', 'token']).ok).toBe(false);
    expect(parseArgs(['hub', 'bogus']).ok).toBe(false);
    expect(parseArgs(['hub', 'node', 'bogus']).ok).toBe(false);
  });

  it('hub --help short-circuits without a command', () => {
    const args = parsed(['hub', '--help']);
    expect(args.help).toBe(true);
    expect(args.hubCommand).toBeNull();
  });
});

describe('runHubCommand', () => {
  const config: VesselConfig = {};

  it('prints raw directory JSON without ANSI in --json mode', async () => {
    const body = {
      v: 1,
      hub_id: 'hub-1',
      updated_at: 1,
      nodes: [
        {
          pairing_id: 'node:tenant',
          node_id: 'node',
          status: 'healthy',
          counts: { teams: 1, agents: 2, live_agents: 1 },
          last_seen: 1000,
        },
      ],
    };
    const fetchImpl = (async () => Response.json(body)) as unknown as typeof fetch;
    const out: string[] = [];
    const code = await runHubCommand(
      { kind: 'directory', json: true },
      { config, fetchImpl, print: (line) => out.push(line) },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toEqual(body);
    expect(out.join('\n')).not.toContain('\x1b[');
  });

  it('reads the admin token only from the named environment variable', async () => {
    let authorization = '';
    let requestBody: unknown;
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        result: {
          token: 'control-token',
          token_id: 'tok-1',
          scope: 'control',
          team_id: 't1',
          expires_at: 2000,
        },
      });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    const code = await runHubCommand(
      {
        kind: 'token-exchange',
        nodeUrl: 'http://127.0.0.1:8642',
        teamId: 't1',
        adminTokenEnv: 'ADMIN_TOKEN',
        json: false,
      },
      {
        config,
        env: { ADMIN_TOKEN: 'admin-secret' },
        fetchImpl,
        print: (line) => out.push(line),
      },
    );
    expect(code).toBe(0);
    expect(authorization).toBe('Bearer admin-secret');
    expect(requestBody).toMatchObject({
      method: 'auth.exchange',
      params: { team_id: 't1' },
    });
    expect(out.join('\n')).toContain('token  control-token');
  });

  it('fails without calling the node when the admin token env is missing', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    const err: string[] = [];
    const code = await runHubCommand(
      {
        kind: 'token-exchange',
        nodeUrl: 'http://127.0.0.1:8642',
        teamId: 't1',
        json: false,
      },
      {
        config,
        env: {},
        fetchImpl,
        print: () => undefined,
        printErr: (line) => err.push(line),
      },
    );
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(err.join('\n')).toContain('VESSEL_ADMIN_TOKEN');
  });
});
