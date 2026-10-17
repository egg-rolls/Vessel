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
      servePort: 0,
      help: false,
      version: false,
      tools: false,
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
    expect(ok(['--serve']).servePort).toBe(DEFAULT_SERVE_PORT);
  });

  it('--serve 接受显式端口', () => {
    expect(ok(['--serve', '9000']).servePort).toBe(9000);
  });

  it('--serve 端口非法时报错', () => {
    expect(err(['--serve', 'abc'])).toContain('Invalid port');
    expect(err(['--serve', '0'])).toContain('Invalid port');
    expect(err(['--serve', '70000'])).toContain('Invalid port');
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

describe('parseArgs - 未知参数', () => {
  it('未知参数报错，不静默忽略', () => {
    expect(err(['--bogus'])).toContain('Unknown argument: --bogus');
  });
});
