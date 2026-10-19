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
      continueArg: false,
      resumeArg: null,
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
      workflow: null,
      eval: null,
      feishu: false,
      tenantArg: null,
      connectArg: null,
      connectTokenArg: null,
      caArg: null,
      allowedOrigins: [],
      configCommand: null,
      tenantCommand: null,
      migrate: null,
      trace: null,
      pluginCommand: null,
      doctorCommand: null,
    });
  });
});

describe('parseArgs - headless', () => {
  it('--run 带文本', () => {
    expect(ok(['--run', 'hello']).runArg).toBe('hello');
  });

  it('-p / --print 是 --run 的别名', () => {
    expect(ok(['-p', 'hello']).runArg).toBe('hello');
    expect(ok(['--print', 'hello']).runArg).toBe('hello');
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

  it('workflow / eval 只允许出现在位置 0', () => {
    expect(err(['--run', 'x', 'workflow'])).toContain('Unknown argument: workflow');
    expect(err(['--run', 'x', 'eval'])).toContain('Unknown argument: eval');
  });
});

describe('parseArgs - workflow', () => {
  it('workflow run 解析 target 与重复 --input', () => {
    const args = ok(['workflow', 'run', 'release-check', '--input', 'a=1', '--input', 'b=x=y']);
    expect(args.workflow).toEqual({
      kind: 'run',
      target: 'release-check',
      inputs: { a: '1', b: 'x=y' },
    });
  });

  it('workflow run 重复 key 后者覆盖', () => {
    const args = ok(['workflow', 'run', 'x', '--input', 'a=1', '--input', 'a=2']);
    expect(args.workflow).toEqual({ kind: 'run', target: 'x', inputs: { a: '2' } });
  });

  it('workflow run 允许空 value', () => {
    const args = ok(['workflow', 'run', 'x', '--input', 'a=']);
    expect(args.workflow).toEqual({ kind: 'run', target: 'x', inputs: { a: '' } });
  });

  it('workflow run 缺 target / 非法 input 报错', () => {
    expect(err(['workflow', 'run'])).toContain('Missing workflow definition');
    expect(err(['workflow', 'run', 'x', '--input'])).toContain('Missing value for --input');
    expect(err(['workflow', 'run', 'x', '--input', 'bad'])).toContain('expected key=value');
    expect(err(['workflow', 'run', 'x', '--input', '=v'])).toContain('expected key=value');
    expect(err(['workflow', 'run', 'x', '--input', '1a=v'])).toContain('Invalid --input key');
  });

  it('workflow run 未知 flag / 多余位置参数报错', () => {
    expect(err(['workflow', 'run', 'x', '--bogus'])).toContain('Unknown argument: --bogus');
    expect(err(['workflow', 'run', 'x', 'y'])).toContain('Unexpected argument: y');
  });

  it('workflow list 缺省无 status/limit', () => {
    expect(ok(['workflow', 'list']).workflow).toEqual({ kind: 'list' });
  });

  it('workflow list 解析 status / limit', () => {
    expect(ok(['workflow', 'list', '--status', 'completed', '--limit', '200']).workflow).toEqual({
      kind: 'list',
      status: 'completed',
      limit: 200,
    });
    expect(ok(['workflow', 'list', '--limit', '1']).workflow).toEqual({
      kind: 'list',
      limit: 1,
    });
  });

  it('workflow list 非法 status / limit 报错', () => {
    expect(err(['workflow', 'list', '--status', 'unknown'])).toContain('Invalid workflow status');
    expect(err(['workflow', 'list', '--limit', '0'])).toContain('--limit must be');
    expect(err(['workflow', 'list', '--limit', '201'])).toContain('--limit must be');
    expect(err(['workflow', 'list', '--limit', 'abc'])).toContain('Invalid value for --limit');
    expect(err(['workflow', 'list', '--status'])).toContain('Missing value for --status');
  });

  it('workflow list 未知 flag / 位置参数报错', () => {
    expect(err(['workflow', 'list', '--bogus'])).toContain('Unknown argument: --bogus');
    expect(err(['workflow', 'list', 'extra'])).toContain('Unknown argument: extra');
  });

  it('workflow show / resume / cancel 解析 id', () => {
    expect(ok(['workflow', 'show', 'wf_1']).workflow).toEqual({
      kind: 'show',
      workflowRunId: 'wf_1',
    });
    expect(ok(['workflow', 'resume', 'wf_2']).workflow).toEqual({
      kind: 'resume',
      workflowRunId: 'wf_2',
    });
    expect(ok(['workflow', 'cancel', 'wf_3']).workflow).toEqual({
      kind: 'cancel',
      workflowRunId: 'wf_3',
    });
  });

  it('workflow show / resume / cancel 缺 id 或多参数报错', () => {
    expect(err(['workflow', 'show'])).toContain('Missing workflowRunId');
    expect(err(['workflow', 'resume'])).toContain('Missing workflowRunId');
    expect(err(['workflow', 'cancel'])).toContain('Missing workflowRunId');
    expect(err(['workflow', 'show', 'a', 'b'])).toContain('Unexpected argument: b');
    expect(err(['workflow', 'show', '--bogus'])).toContain('Unknown argument: --bogus');
  });

  it('未知 workflow 子命令 / 空子命令报错', () => {
    expect(err(['workflow'])).toContain('Missing workflow subcommand');
    expect(err(['workflow', 'bogus'])).toContain('Unknown workflow subcommand');
  });

  it('workflow 的 --help 走主帮助', () => {
    expect(ok(['workflow', 'run', '--help']).help).toBe(true);
    expect(ok(['workflow', 'list', '-h']).help).toBe(true);
    expect(ok(['workflow', 'show', 'wf_1', '--help']).help).toBe(true);
  });
});

describe('parseArgs - eval', () => {
  it('解析 suite 与所有选项', () => {
    const args = ok([
      'eval',
      'smoke',
      '--json',
      '--out',
      '/tmp/report.json',
      '--filter',
      'smoke',
      '--filter',
      'fast',
      '--allow-network',
    ]);
    expect(args.eval).toEqual({
      target: 'smoke',
      json: true,
      out: '/tmp/report.json',
      filters: ['smoke', 'fast'],
      allowNetwork: true,
    });
  });

  it('缺省选项', () => {
    expect(ok(['eval', 'smoke']).eval).toEqual({
      target: 'smoke',
      json: false,
      filters: [],
      allowNetwork: false,
    });
  });

  it('缺 suite / 选项缺值 / 多余位置参数报错', () => {
    expect(err(['eval'])).toContain('Missing eval suite');
    expect(err(['eval', 'smoke', '--out'])).toContain('Missing value for --out');
    expect(err(['eval', 'smoke', '--filter'])).toContain('Missing value for --filter');
    expect(err(['eval', 'smoke', 'extra'])).toContain('Unexpected argument: extra');
    expect(err(['eval', 'smoke', '--bogus'])).toContain('Unknown argument: --bogus');
  });

  it('eval 的 --help 走主帮助', () => {
    expect(ok(['eval', 'smoke', '--help']).help).toBe(true);
  });
});

describe('parseArgs - --feishu 附加开关', () => {
  it('单独使用合法', () => {
    expect(ok(['--feishu']).feishu).toBe(true);
  });

  it('可与 --serve 同用', () => {
    const args = ok(['--serve', '9000', '--feishu']);
    expect(args.feishu).toBe(true);
    expect(args.servePort).toBe(9000);
  });

  it('可与 --serve-host / TLS 同用', () => {
    const args = ok([
      '--serve',
      '--serve-host',
      '127.0.0.1',
      '--tls-cert',
      'cert.pem',
      '--tls-key',
      'key.pem',
      '--feishu',
    ]);
    expect(args.feishu).toBe(true);
    expect(args.tlsCert).toBe('cert.pem');
  });

  it('可与 --session 同用', () => {
    const args = ok(['--feishu', '--session', 'abc']);
    expect(args.feishu).toBe(true);
    expect(args.sessionArg).toBe('abc');
  });

  it('与一次性输入命令互斥', () => {
    for (const argv of [
      ['--feishu', '--run', 'hi'],
      ['--feishu', '--pipe'],
      ['--feishu', '--resume-run', 'r1'],
      ['--feishu', '--tools'],
      ['--feishu', '--version'],
      ['--feishu', '--help'],
    ]) {
      expect(err(argv)).toContain('--feishu cannot be combined with');
    }
  });
});

describe('parseArgs - 会话续接（0.6.1）', () => {
  it('-c / --continue', () => {
    expect(ok(['-c']).continueArg).toBe(true);
    expect(ok(['--continue']).continueArg).toBe(true);
  });

  it('-r / --resume [id]；-r 不再等同 --run', () => {
    expect(ok(['-r', 'abc']).resumeArg).toBe('abc');
    expect(ok(['--resume', 'abc']).resumeArg).toBe('abc');
    expect(ok(['-r']).resumeArg).toBe('');
    expect(ok(['-r', 'abc']).runArg).toBeNull();
  });

  it('--continue 与 --resume 互斥', () => {
    expect(err(['-c', '-r', 'abc'])).toContain('--continue cannot be combined with --resume');
  });

  it('与 --session 互斥', () => {
    expect(err(['-c', '--session', 'x'])).toContain('--continue cannot be combined with --session');
    expect(err(['-r', 'x', '--session', 'y'])).toContain(
      '--resume cannot be combined with --session',
    );
  });

  it('与 --serve / --resume-run / --tools 互斥', () => {
    for (const argv of [
      ['-c', '--serve'],
      ['-r', 'abc', '--serve'],
      ['-c', '--resume-run', 'r1'],
      ['-r', 'abc', '--resume-run', 'r1'],
      ['-c', '--tools'],
      ['-r', 'abc', '--tools'],
    ]) {
      expect(parseArgs(argv).ok).toBe(false);
    }
  });

  it('-c/--resume 可与 --run 同用（续接后运行一轮）', () => {
    const args = ok(['-c', '--run', 'hi']);
    expect(args.continueArg).toBe(true);
    expect(args.runArg).toBe('hi');
    expect(ok(['-r', 'abc', '--run', 'hi']).resumeArg).toBe('abc');
  });

  it('-r 无 id 是列表模式，不能再给 --run/--pipe/--feishu', () => {
    expect(err(['-r', '--run', 'hi'])).toContain(
      '--resume without an id cannot be combined with --run',
    );
    expect(err(['-r', '--pipe'])).toContain(
      '--resume without an id cannot be combined with --pipe',
    );
    expect(err(['-r', '--feishu'])).toContain(
      '--resume without an id cannot be combined with --feishu',
    );
  });
});

describe('parseArgs - plugin / doctor（0.6.1）', () => {
  it('plugin list [--json]', () => {
    expect(ok(['plugin', 'list']).pluginCommand).toEqual({ kind: 'list', json: false });
    expect(ok(['plugin', 'list', '--json']).pluginCommand).toEqual({
      kind: 'list',
      json: true,
    });
  });

  it('plugin install <path> [--force]', () => {
    expect(ok(['plugin', 'install', './my-plugin']).pluginCommand).toEqual({
      kind: 'install',
      path: './my-plugin',
      force: false,
    });
    expect(ok(['plugin', 'install', './my-plugin', '--force']).pluginCommand).toEqual({
      kind: 'install',
      path: './my-plugin',
      force: true,
    });
    expect(err(['plugin', 'install'])).toContain('Missing <path>');
  });

  it('plugin remove <name> 拒绝路径穿越', () => {
    expect(ok(['plugin', 'remove', 'my-plugin']).pluginCommand).toEqual({
      kind: 'remove',
      name: 'my-plugin',
      yes: false,
    });
    expect(err(['plugin', 'remove', '../evil'])).toContain('Invalid plugin name');
  });

  it('plugin 未知子命令/参数报错', () => {
    expect(err(['plugin'])).toContain('Missing plugin subcommand');
    expect(err(['plugin', 'market'])).toContain('Unknown plugin subcommand');
    expect(err(['plugin', 'list', '--bogus'])).toContain('Unknown argument');
  });

  it('doctor [--json]', () => {
    expect(ok(['doctor']).doctorCommand).toEqual({ json: false });
    expect(ok(['doctor', '--json']).doctorCommand).toEqual({ json: true });
    expect(err(['doctor', '--bogus'])).toContain('Unknown argument');
  });
});
