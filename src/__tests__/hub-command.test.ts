import { beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VesselConfig } from '../../packages/config/src/index';
import { parseArgs } from '../cli-args';
import { createMemorySecretStore } from '../hub/secret-store';
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

  it('parses join-code', () => {
    expect(
      parsed(['hub', 'join-code', '--tenant', 'alpha', '--ttl', '120', '--json']).hubCommand,
    ).toEqual({
      kind: 'join-code',
      json: true,
      tenant: 'alpha',
      ttl: 120,
    });
    expect(parsed(['hub', 'join-code']).hubCommand).toEqual({ kind: 'join-code', json: false });
  });

  it('parses join with positional hub url and flags', () => {
    expect(
      parsed([
        'hub',
        'join',
        'https://hub.example:8643',
        '--code',
        'ABCD-EFGH',
        '--tenant',
        'alpha',
        '--public-url',
        'https://node.example',
        '--ca',
        '/tmp/ca.pem',
        '--data-dir',
        '/tmp/node',
        '--json',
      ]).hubCommand,
    ).toEqual({
      kind: 'join',
      hubUrl: 'https://hub.example:8643',
      code: 'ABCD-EFGH',
      tenant: 'alpha',
      publicUrl: 'https://node.example',
      caFile: '/tmp/ca.pem',
      dataDir: '/tmp/node',
      json: true,
    });
    expect(parsed(['hub', 'join', '--code-env', 'HUB_CODE']).hubCommand).toEqual({
      kind: 'join',
      codeEnv: 'HUB_CODE',
      json: false,
    });
  });

  it('join rejects --code with --code-env and unknown flags', () => {
    const both = parseArgs(['hub', 'join', '--code', 'ABCD-EFGH', '--code-env', 'HUB_CODE']);
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.error).toContain('--code and --code-env');

    const badEnv = parseArgs(['hub', 'join', '--code-env', 'CODE=secret']);
    expect(badEnv.ok).toBe(false);
    if (badEnv.ok) return;
    expect(badEnv.error).toContain('environment variable name');

    expect(parseArgs(['hub', 'join', '--bogus']).ok).toBe(false);
    expect(parseArgs(['hub', 'join-code', '--bogus']).ok).toBe(false);
    expect(parseArgs(['hub', 'join', 'a', 'b']).ok).toBe(false);
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

// ── S5.1 join-code / join ──────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-hub-join-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function joinResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hub_id: 'hub-1',
    node_id: 'node-1',
    tenant_id: 'default',
    pairing_id: 'node-1:default',
    token: 'secret-token',
    token_id: 'tok-1',
    scope: 'node',
    expires_at: 1_900_000_000_000,
    ...overrides,
  };
}

describe('runHubCommand - join-code', () => {
  it('writes hash-only hub-join.json and prints the code once', async () => {
    await withTempDir(async (dir) => {
      const out: string[] = [];
      const code = await runHubCommand(
        { kind: 'join-code', tenant: 'alpha', ttl: 120, json: false },
        {
          config: { hub: { dataDir: dir } },
          print: (line) => out.push(line),
        },
      );
      expect(code).toBe(0);

      const raw = fs.readFileSync(path.join(dir, 'hub-join.json'), 'utf8');
      const file = JSON.parse(raw) as Record<string, unknown>;
      expect(file).not.toHaveProperty('code');
      expect(typeof file.code_hash).toBe('string');

      const printed = out.join('\n');
      const match = /\b([A-Z2-9]{4}-[A-Z2-9]{4})\b/.exec(printed);
      expect(match).not.toBeNull();
      const printedCode = match?.[1] ?? '';
      expect(raw).not.toContain(printedCode);
      expect(file.code_hash).toBe(createHash('sha256').update(printedCode).digest('hex'));
      expect(file.tenant_id).toBe('alpha');
      expect(printed).toContain(new Date(file.expires_at as number).toISOString());

      const node = JSON.parse(fs.readFileSync(path.join(dir, 'node.json'), 'utf8')) as {
        node_id: string;
      };
      expect(file.hub_id).toBe(node.node_id);
    });
  });

  it('--json returns code / expires_at / hub_id / tenant_id', async () => {
    await withTempDir(async (dir) => {
      const out: string[] = [];
      const code = await runHubCommand(
        { kind: 'join-code', json: true },
        {
          config: { hub: { dataDir: dir } },
          print: (line) => out.push(line),
        },
      );
      expect(code).toBe(0);
      const payload = JSON.parse(out.join('\n')) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['code', 'expires_at', 'hub_id', 'tenant_id']);
      expect(payload.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(typeof payload.expires_at).toBe('number');
      expect(payload.tenant_id).toBe('default');
      expect(out.join('\n')).not.toContain('\x1b[');
    });
  });
});

describe('runHubCommand - join', () => {
  const config: VesselConfig = { host: { nodeId: 'node-1' }, hub: { direction: 'node' } };

  it('stores the token in SecretStore and writes a token-free hub-node.json', async () => {
    await withTempDir(async (dir) => {
      const memory = createMemorySecretStore();
      const out: string[] = [];
      const calls: { url?: string; body?: unknown } = {};
      const fetchImpl = (async (input: string, init?: RequestInit) => {
        calls.url = input;
        calls.body = JSON.parse(String(init?.body));
        return Response.json(joinResponse());
      }) as unknown as typeof fetch;

      const code = await runHubCommand(
        { kind: 'join', hubUrl: 'https://hub.example:8643', code: 'ABCD-EFGH', json: true },
        {
          config,
          dataDir: dir,
          createSecretStore: () => memory,
          gatewayStatus: async () => ({ running: false }),
          fetchImpl,
          print: (line) => out.push(line),
        },
      );
      expect(code).toBe(0);
      expect(calls.url).toBe('https://hub.example:8643/v1/hub/join');
      expect(calls.body).toMatchObject({
        protocol: 'vessel.hub/1',
        code: 'ABCD-EFGH',
        node_id: 'node-1',
        tenant_id: 'default',
      });
      expect(await memory.get('node:hub-1:control')).toBe('secret-token');

      const raw = fs.readFileSync(path.join(dir, 'hub-node.json'), 'utf8');
      expect(raw).not.toContain('secret-token');
      const state = JSON.parse(raw) as Record<string, unknown>;
      expect(state.token_id).toBe('tok-1');
      expect(state).not.toHaveProperty('token');
      expect(state.pairing_id).toBe('node-1:default');
      expect(state.hub_url).toBe('https://hub.example:8643');

      const payload = JSON.parse(out.join('\n')) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        joined: false,
        hub_id: 'hub-1',
        pairing_id: 'node-1:default',
        node_id: 'node-1',
        tenant_id: 'default',
        state_file: path.join(dir, 'hub-node.json'),
      });
      expect(payload).not.toHaveProperty('status');
      expect(out.join('\n')).not.toContain('secret-token');
    });
  });

  it('reports saved when no gateway is running', async () => {
    await withTempDir(async (dir) => {
      const out: string[] = [];
      const fetchImpl = (async () => Response.json(joinResponse())) as unknown as typeof fetch;
      const code = await runHubCommand(
        { kind: 'join', hubUrl: 'https://hub.example:8643', code: 'ABCD-EFGH', json: false },
        {
          config,
          dataDir: dir,
          createSecretStore: () => createMemorySecretStore(),
          gatewayStatus: async () => ({ running: false }),
          fetchImpl,
          print: (line) => out.push(line),
        },
      );
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('saved; gateway will connect on next start');
    });
  });

  it('reports joined when the running gateway becomes healthy', async () => {
    await withTempDir(async (dir) => {
      const out: string[] = [];
      const fetchImpl = (async () => Response.json(joinResponse())) as unknown as typeof fetch;
      const code = await runHubCommand(
        { kind: 'join', hubUrl: 'https://hub.example:8643', code: 'ABCD-EFGH', json: true },
        {
          config,
          dataDir: dir,
          createSecretStore: () => createMemorySecretStore(),
          gatewayStatus: async () => ({ running: true }),
          readNodeStatus: async () => ({ v: 1, status: 'healthy', updated_at: 1 }),
          fetchImpl,
          print: (line) => out.push(line),
        },
      );
      expect(code).toBe(0);
      const payload = JSON.parse(out.join('\n')) as Record<string, unknown>;
      expect(payload).toMatchObject({ ok: true, joined: true, status: 'healthy' });
    });
  });

  it('deletes the token when the state write fails', async () => {
    await withTempDir(async (dir) => {
      // 同名的目录让 `hub-node.json` 的原子 rename 必然失败。
      fs.mkdirSync(path.join(dir, 'hub-node.json'));
      const memory = createMemorySecretStore();
      const err: string[] = [];
      const fetchImpl = (async () => Response.json(joinResponse())) as unknown as typeof fetch;
      const code = await runHubCommand(
        { kind: 'join', hubUrl: 'https://hub.example:8643', code: 'ABCD-EFGH', json: false },
        {
          config,
          dataDir: dir,
          createSecretStore: () => memory,
          gatewayStatus: async () => ({ running: false }),
          fetchImpl,
          print: () => undefined,
          printErr: (line) => err.push(line),
        },
      );
      expect(code).toBe(1);
      expect(await memory.get('node:hub-1:control')).toBeUndefined();
      expect(err.join('\n')).not.toContain('secret-token');
    });
  });

  it('rejects a join response for a different tenant', async () => {
    await withTempDir(async (dir) => {
      const memory = createMemorySecretStore();
      const err: string[] = [];
      const fetchImpl = (async () =>
        Response.json(joinResponse({ tenant_id: 'other' }))) as unknown as typeof fetch;
      const code = await runHubCommand(
        { kind: 'join', hubUrl: 'https://hub.example:8643', code: 'ABCD-EFGH', json: false },
        {
          config,
          dataDir: dir,
          createSecretStore: () => memory,
          gatewayStatus: async () => ({ running: false }),
          fetchImpl,
          print: () => undefined,
          printErr: (line) => err.push(line),
        },
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('tenant_mismatch');
      expect(await memory.get('node:hub-1:control')).toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'hub-node.json'))).toBe(false);
    });
  });

  it('fails with a stable code when no join code is available', async () => {
    let called = false;
    const err: string[] = [];
    const fetchImpl = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    const code = await runHubCommand(
      { kind: 'join', hubUrl: 'https://hub.example:8643', json: false },
      {
        config,
        dataDir: os.tmpdir(),
        env: {},
        fetchImpl,
        print: () => undefined,
        printErr: (line) => err.push(line),
      },
    );
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(err.join('\n')).toContain('hub_join_code_missing');
  });
});
