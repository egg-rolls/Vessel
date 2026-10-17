import { describe, expect, it } from 'bun:test';
import { DEFAULT_SERVE_PORT, parseArgs } from '../cli-args';

/** 断言解析成功并返回 args */
function ok(argv: string[]) {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.args;
}

/** 断言解析失败并返回错误文本 */
function err(argv: string[]) {
  const result = parseArgs(argv);
  if (result.ok) throw new Error('expected parse failure');
  return result.error;
}

describe('parseArgs - 默认与 REPL', () => {
  it('无参数进入 REPL', () => {
    expect(ok([])).toEqual({
      runArg: null,
      pipeMode: false,
      sessionArg: null,
      servePort: null,
      servePortExplicit: false,
      serveHost: null,
      allowRemote: false,
      tlsCert: null,
      tlsKey: null,
      resumeRunArg: null,
      help: false,
      version: false,
      tools: false,
      update: null,
    });
  });
});

describe('parseArgs - headless', () => {
  it('--run 带文本', () => {
    expect(ok(['--run', 'hello']).runArg).toBe('hello');
  });

  it('-r 是 --run 的别名', () => {
    expect(ok(['-r', 'hello']).runArg).toBe('hello');
  });

  it('--run 无参 = 从 stdin 读', () => {
    expect(ok(['--run']).runArg).toBe('');
  });

  it('--run 后面是另一个 flag 时按无参处理', () => {
    const args = ok(['--run', '--serve']);
    expect(args.runArg).toBe('');
    expect(args.servePort).toBe(DEFAULT_SERVE_PORT);
  });

  it('--pipe 是隐藏别名', () => {
    expect(ok(['--pipe']).pipeMode).toBe(true);
  });

  it('--session / -s 接受会话 ID', () => {
    expect(ok(['--session', 'abc']).sessionArg).toBe('abc');
    expect(ok(['-s', 'abc']).sessionArg).toBe('abc');
  });

  it('--session 缺少值时报错', () => {
    expect(err(['--session'])).toContain('Missing value');
    expect(err(['--session', '--run', 'x'])).toContain('Missing value');
  });
});

describe('parseArgs - serve', () => {
  it('--serve 省略端口用默认 8642', () => {
    const args = ok(['--serve']);
    expect(args.servePort).toBe(DEFAULT_SERVE_PORT);
    expect(args.servePortExplicit).toBe(false);
  });

  it('--serve 接受显式端口', () => {
    const args = ok(['--serve', '9000']);
    expect(args.servePort).toBe(9000);
    expect(args.servePortExplicit).toBe(true);
  });

  it('--serve 0 表示系统分配端口', () => {
    const args = ok(['--serve', '0']);
    expect(args.servePort).toBe(0);
    expect(args.servePortExplicit).toBe(true);
  });

  it('--serve 端口非法时报错', () => {
    expect(err(['--serve', 'abc'])).toContain('Invalid port');
    expect(err(['--serve', '70000'])).toContain('Invalid port');
  });

  it('--serve-host / --allow-remote / --tls-* 只在 --serve 下合法', () => {
    const args = ok([
      '--serve',
      '--serve-host',
      '0.0.0.0',
      '--allow-remote',
      '--tls-cert',
      'cert.pem',
      '--tls-key',
      'key.pem',
    ]);
    expect(args.serveHost).toBe('0.0.0.0');
    expect(args.allowRemote).toBe(true);
    expect(args.tlsCert).toBe('cert.pem');
    expect(args.tlsKey).toBe('key.pem');

    expect(err(['--serve-host', '0.0.0.0'])).toContain('requires --serve');
    expect(err(['--allow-remote'])).toContain('requires --serve');
    expect(err(['--tls-cert', 'cert.pem'])).toContain('--tls-cert and --tls-key');
  });

  it('--serve-host / --tls-* 缺少值时报错', () => {
    expect(err(['--serve', '--serve-host'])).toContain('Missing value for --serve-host');
    expect(err(['--serve', '--tls-cert'])).toContain('Missing value for --tls-cert');
    expect(err(['--serve', '--tls-cert', 'a', '--tls-key'])).toContain(
      'Missing value for --tls-key',
    );
  });
});

describe('parseArgs - resume-run', () => {
  it('无参 = 列出可恢复 run', () => {
    expect(ok(['--resume-run']).resumeRunArg).toBe('');
  });

  it('有参 = 恢复指定 run', () => {
    expect(ok(['--resume-run', 'run-1']).resumeRunArg).toBe('run-1');
  });

  it('与 --run/--pipe/--serve/--session/--tools 互斥', () => {
    for (const argv of [
      ['--resume-run', 'run-1', '--run', 'hi'],
      ['--resume-run', '--pipe'],
      ['--resume-run', '--serve'],
      ['--resume-run', 'run-1', '--session', 's'],
      ['--resume-run', '--tools'],
    ]) {
      expect(err(argv)).toContain('--resume-run cannot be combined with');
    }
  });

  it('--help / --version 仍可组合（帮助优先）', () => {
    expect(ok(['--resume-run', '--help']).help).toBe(true);
    expect(ok(['--resume-run', '--version']).version).toBe(true);
  });
});

describe('parseArgs - 一次性命令', () => {
  it('--help / --version / --tools 与短别名', () => {
    expect(ok(['--help']).help).toBe(true);
    expect(ok(['-h']).help).toBe(true);
    expect(ok(['--version']).version).toBe(true);
    expect(ok(['-v']).version).toBe(true);
    expect(ok(['--tools']).tools).toBe(true);
  });

  it('一次性命令不能互相组合', () => {
    expect(err(['--help', '--version'])).toContain('Cannot combine');
    expect(err(['--tools', '--version'])).toContain('Cannot combine');
  });

  it('一次性命令不能与 --run/--serve 组合', () => {
    expect(err(['--tools', '--run', 'x'])).toContain('cannot be combined');
    expect(err(['--version', '--serve'])).toContain('cannot be combined');
  });
});

describe('parseArgs - update 子命令', () => {
  it('update 默认选项', () => {
    expect(ok(['update']).update).toEqual({ check: false, json: false, force: false });
  });

  it('update --check --channel beta --json', () => {
    expect(ok(['update', '--check', '--channel', 'beta', '--json']).update).toEqual({
      check: true,
      channel: 'beta',
      json: true,
      force: false,
    });
  });

  it('update --force 被解析（0.1.0 无额外效果）', () => {
    expect(ok(['update', '--force']).update).toEqual({
      check: false,
      json: false,
      force: true,
    });
  });

  it('--channel 缺值或非法时报错', () => {
    expect(err(['update', '--channel'])).toContain('Missing value');
    expect(err(['update', '--channel', 'nightly'])).toContain('Invalid channel');
  });

  it('update 必须在第一个参数位置', () => {
    expect(err(['--run', 'x', 'update'])).toContain('Unknown argument: update');
  });

  it('update 的未知参数报错', () => {
    expect(err(['update', '--bogus'])).toContain('Unknown argument: --bogus');
  });

  it('update --help 走主帮助', () => {
    expect(ok(['update', '--help']).help).toBe(true);
  });
});

describe('parseArgs - 未知参数', () => {
  it('未知参数报错，不静默忽略', () => {
    expect(err(['--bogus'])).toContain('Unknown argument: --bogus');
  });
});
