import { describe, expect, it } from 'bun:test';
import { parseArgs, parseTimeoutMs } from '../cli-args';
import { isForegroundGatewayCommand } from '../gateway-command';

function ok(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.args;
}

function err(argv: string[]) {
  const result = parseArgs(argv);
  if (result.ok) throw new Error('expected parse failure');
  return result.error;
}

describe('gateway start', () => {
  it('缺省前台', () => {
    expect(ok(['gateway', 'start']).gateway).toEqual({ kind: 'start', daemon: false });
  });

  it('解析 port/host/daemon/log', () => {
    expect(
      ok([
        'gateway',
        'start',
        '--port',
        '0',
        '--host',
        '127.0.0.1',
        '--daemon',
        '--log',
        '/tmp/gw.log',
      ]).gateway,
    ).toEqual({
      kind: 'start',
      daemon: true,
      port: 0,
      host: '127.0.0.1',
      log: '/tmp/gw.log',
    });
  });

  it('非法 port / 缺失值 / 未知参数', () => {
    expect(err(['gateway', 'start', '--port', '70000'])).toContain('Invalid port');
    expect(err(['gateway', 'start', '--port'])).toContain('Missing value');
    expect(err(['gateway', 'start', '--host'])).toContain('Missing value');
    expect(err(['gateway', 'start', '--nope'])).toContain('Unknown argument');
  });

  it('--help 走顶层帮助', () => {
    expect(ok(['gateway', 'start', '--help']).help).toBe(true);
    expect(ok(['gateway', '--help']).help).toBe(true);
  });
});

describe('gateway stop / status / restart', () => {
  it('stop 缺省 10s', () => {
    expect(ok(['gateway', 'stop']).gateway).toEqual({ kind: 'stop', timeoutMs: 10_000 });
  });

  it('stop 支持 ms/s/m 与裸数字（秒）', () => {
    expect(parseTimeoutMs('500ms')).toBe(500);
    expect(parseTimeoutMs('10s')).toBe(10_000);
    expect(parseTimeoutMs('2m')).toBe(120_000);
    expect(parseTimeoutMs('5')).toBe(5_000);
    expect(parseTimeoutMs('0s')).toBeNull();
    expect(parseTimeoutMs('abc')).toBeNull();
    expect(err(['gateway', 'stop', '--timeout', 'nope'])).toContain('Invalid --timeout');
  });

  it('status --json', () => {
    expect(ok(['gateway', 'status']).gateway).toEqual({ kind: 'status', json: false });
    expect(ok(['gateway', 'status', '--json']).gateway).toEqual({
      kind: 'status',
      json: true,
    });
    expect(err(['gateway', 'status', '--port', '1'])).toContain('Unknown argument');
  });

  it('restart --daemon', () => {
    expect(ok(['gateway', 'restart']).gateway).toEqual({ kind: 'restart', daemon: false });
    expect(ok(['gateway', 'restart', '--daemon']).gateway).toEqual({
      kind: 'restart',
      daemon: true,
    });
  });
});

describe('gateway reload / service', () => {
  it('reload scope：逗号与重复 flag 合并去重', () => {
    expect(ok(['gateway', 'reload']).gateway).toEqual({ kind: 'reload' });
    expect(ok(['gateway', 'reload', '--scope', 'config,plugins']).gateway).toEqual({
      kind: 'reload',
      scopes: ['config', 'plugins'],
    });
    expect(
      ok(['gateway', 'reload', '--scope', 'config', '--scope', 'plugins,config']).gateway,
    ).toEqual({ kind: 'reload', scopes: ['config', 'plugins'] });
    expect(err(['gateway', 'reload', '--scope', 'Config'])).toContain('Invalid --scope');
    expect(err(['gateway', 'reload', '--scope', ''])).toContain('Missing value');
  });

  it('install-service 平台 flag', () => {
    expect(ok(['gateway', 'install-service']).gateway).toEqual({
      kind: 'install-service',
    });
    expect(ok(['gateway', 'install-service', '--systemd']).gateway).toEqual({
      kind: 'install-service',
      target: 'systemd',
    });
    expect(ok(['gateway', 'install-service', '--launchd']).gateway).toEqual({
      kind: 'install-service',
      target: 'launchd',
    });
    expect(err(['gateway', 'install-service', '--systemd', '--launchd'])).toContain(
      'one platform flag',
    );
  });

  it('uninstall-service 与未知子命令', () => {
    expect(ok(['gateway', 'uninstall-service']).gateway).toEqual({
      kind: 'uninstall-service',
    });
    expect(err(['gateway'])).toContain('Missing gateway subcommand');
    expect(err(['gateway', 'nope'])).toContain('Unknown gateway subcommand');
  });
});

describe('foreground 判定与 update --yes', () => {
  it('只有前台 start/restart 交给 cli.ts', () => {
    expect(isForegroundGatewayCommand({ kind: 'start', daemon: false })).toBe(true);
    expect(isForegroundGatewayCommand({ kind: 'start', daemon: true })).toBe(false);
    expect(isForegroundGatewayCommand({ kind: 'restart', daemon: false })).toBe(true);
    expect(isForegroundGatewayCommand({ kind: 'restart', daemon: true })).toBe(false);
    expect(isForegroundGatewayCommand({ kind: 'status', json: false })).toBe(false);
  });

  it('update --yes / -y', () => {
    expect(ok(['update', '--yes']).update?.yes).toBe(true);
    expect(ok(['update', '-y']).update?.yes).toBe(true);
  });
});
