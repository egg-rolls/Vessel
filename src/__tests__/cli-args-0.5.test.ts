import { describe, expect, it } from 'bun:test';
import { parseArgs } from '../cli-args';

function args(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.args;
}

function errorOf(argv: string[]): string {
  const result = parseArgs(argv);
  if (result.ok) throw new Error('expected parse failure');
  return result.error;
}

describe('parseArgs 0.5 - config', () => {
  it('config path / init / show', () => {
    expect(args(['config', 'path']).configCommand).toEqual({ kind: 'path', json: false });
    expect(args(['config', 'path', '--json']).configCommand).toEqual({
      kind: 'path',
      json: true,
    });
    expect(args(['config', 'init', '--force', '--json']).configCommand).toEqual({
      kind: 'init',
      json: true,
      force: true,
    });
    expect(
      args(['config', 'show', '--sources', '--json', '--tenant', 'acme']).configCommand,
    ).toEqual({ kind: 'show', json: true, sources: true, tenantId: 'acme' });
  });

  it('config 用法错误', () => {
    expect(errorOf(['config'])).toContain('Missing config subcommand');
    expect(errorOf(['config', 'bogus'])).toContain('Unknown config subcommand');
    expect(errorOf(['config', 'show', '--force'])).toContain('Unknown argument');
    expect(errorOf(['config', 'path', '--tenant', 'acme'])).toContain('Unknown argument');
  });
});

describe('parseArgs 0.5 - tenant', () => {
  it('list / get / create / update', () => {
    expect(args(['tenant', 'list']).tenantCommand).toEqual({ kind: 'list', json: false });
    expect(args(['tenant', 'get', 'work', '--json']).tenantCommand).toEqual({
      kind: 'get',
      id: 'work',
      json: true,
    });
    expect(args(['tenant', 'create', 'work', '--name', 'Work']).tenantCommand).toEqual({
      kind: 'create',
      id: 'work',
      json: false,
      name: 'Work',
    });
    expect(
      args(['tenant', 'update', 'work', '--name', 'W2', '--status', 'disabled', '--json'])
        .tenantCommand,
    ).toEqual({
      kind: 'update',
      id: 'work',
      json: true,
      name: 'W2',
      status: 'disabled',
    });
  });

  it('tenant 用法错误', () => {
    expect(errorOf(['tenant'])).toContain('Missing tenant subcommand');
    expect(errorOf(['tenant', 'get'])).toContain('Missing tenant id');
    expect(errorOf(['tenant', 'update', 'work', '--status', 'bogus'])).toContain(
      'Invalid tenant status',
    );
    expect(errorOf(['tenant', 'create', 'work', '--status', 'disabled'])).toContain(
      'Unknown argument',
    );
  });
});

describe('parseArgs 0.5 - migrate / trace', () => {
  it('migrate 全量参数', () => {
    expect(
      args([
        'migrate',
        '--from',
        'sqlite',
        '--to',
        'file-v2',
        '--apply',
        '--tenant',
        'work',
        '--source',
        '/tmp/db',
        '--json',
      ]).migrate,
    ).toEqual({
      from: 'sqlite',
      to: 'file-v2',
      apply: true,
      json: true,
      tenantId: 'work',
      source: '/tmp/db',
    });

    expect(args(['migrate', '--from', 'file-v1', '--to', 'file-v2']).migrate).toEqual({
      from: 'file-v1',
      to: 'file-v2',
      apply: false,
      json: false,
    });
  });

  it('migrate 缺参数报错', () => {
    expect(errorOf(['migrate', '--to', 'file-v2'])).toContain('requires --from');
    expect(errorOf(['migrate', '--from', 'sqlite'])).toContain('requires --to');
  });

  it('trace prune', () => {
    expect(args(['trace', 'prune', '--dry-run', '--json', '--tenant', 'acme']).trace).toEqual({
      kind: 'prune',
      dryRun: true,
      json: true,
      tenantId: 'acme',
    });
    expect(errorOf(['trace'])).toContain('Missing trace subcommand');
    expect(errorOf(['trace', 'bogus'])).toContain('Unknown trace subcommand');
  });
});

describe('parseArgs 0.5 - global flags', () => {
  it('--tenant 可出现在任意位置', () => {
    expect(args(['--tenant', 'work', '--run', 'hi']).tenantArg).toBe('work');
    expect(args(['--run', 'hi', '--tenant', 'work']).tenantArg).toBe('work');
  });

  it('--tenant 与 --help/--version 互斥', () => {
    expect(errorOf(['--tenant', 'work', '--help'])).toContain('cannot be combined');
    expect(errorOf(['--version', '--tenant', 'work'])).toContain('cannot be combined');
  });

  it('--connect 与 --serve 互斥；可与 --run 同用', () => {
    expect(errorOf(['--connect', 'http://127.0.0.1:8642', '--serve'])).toContain(
      'cannot be combined with --serve',
    );
    const parsed = args(['--connect', 'http://127.0.0.1:8642', '--run', 'hi']);
    expect(parsed.connectArg).toBe('http://127.0.0.1:8642');
    expect(parsed.runArg).toBe('hi');
  });

  it('子命令只允许作为第一个参数', () => {
    expect(errorOf(['--run', 'hi', 'config', 'path'])).toContain('Unknown argument');
  });

  it('0.6：--connect-token / --ca / --allowed-origin', () => {
    const parsed = args([
      '--connect',
      'https://gateway.example.com:8642',
      '--connect-token',
      'secret',
      '--ca',
      './ca.pem',
    ]);
    expect(parsed.connectTokenArg).toBe('secret');
    expect(parsed.caArg).toBe('./ca.pem');

    expect(errorOf(['--connect-token', 'secret', '--run', 'hi'])).toContain('requires --connect');
    expect(errorOf(['--allowed-origin', 'https://console.example.com', '--run', 'hi'])).toContain(
      'requires --serve',
    );
    expect(errorOf(['--serve', '--allowed-origin', '*'])).toContain('Invalid --allowed-origin');

    const serve = args(['--serve', '--allowed-origin', 'https://console.example.com']);
    expect(serve.allowedOrigins).toEqual(['https://console.example.com']);
  });
});
