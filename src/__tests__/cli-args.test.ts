import { describe, expect, it } from 'bun:test';
import { DEFAULT_SERVE_PORT, parseArgs } from '../cli-args';
import { buildDaemonArgv } from '../gateway/daemon';

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
      demo: false,
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
      logsCommand: null,
      dataDirArg: null,
      exclusive: false,
      gateway: null,
      statusCommand: null,
      agentsCommand: null,
      agentCommand: null,
      teamCommand: null,
      errorsCommand: null,
      completionCommand: null,
      attentionCommand: null,
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
    expect(ok(['update']).update).toEqual({
      check: false,
      json: false,
      force: false,
      yes: false,
    });
  });

  it('update --check --channel beta --json', () => {
    expect(ok(['update', '--check', '--channel', 'beta', '--json']).update).toEqual({
      check: true,
      channel: 'beta',
      json: true,
      force: false,
      yes: false,
    });
  });

  it('update --force 被解析（0.1.0 无额外效果）', () => {
    expect(ok(['update', '--force']).update).toEqual({
      check: false,
      json: false,
      force: true,
      yes: false,
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

  it('eval 只允许出现在位置 0；workflow 不再是子命令', () => {
    expect(err(['--run', 'x', 'eval'])).toContain('Unknown argument: eval');
    expect(err(['workflow', 'list'])).toContain('Unknown argument: workflow');
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

describe('parseArgs - team (0.19 S3)', () => {
  it('team 无子命令 / --help 走主帮助', () => {
    expect(ok(['team']).help).toBe(true);
    expect(ok(['team', '--help']).help).toBe(true);
    expect(ok(['team', 'post', '--help']).help).toBe(true);
    expect(ok(['team', '--help']).teamCommand).toBeNull();
  });

  it('team list [--json]', () => {
    expect(ok(['team', 'list']).teamCommand).toEqual({ kind: 'list', json: false });
    expect(ok(['team', 'list', '--json']).teamCommand).toEqual({ kind: 'list', json: true });
  });

  it('team get <team_id> [--limit N] [--json]', () => {
    expect(ok(['team', 'get', 'alpha']).teamCommand).toEqual({
      kind: 'get',
      teamId: 'alpha',
      json: false,
    });
    expect(ok(['team', 'get', 'alpha', '--limit', '5', '--json']).teamCommand).toEqual({
      kind: 'get',
      teamId: 'alpha',
      limit: 5,
      json: true,
    });
  });

  it('team post 合并正文并收集多个 --mention', () => {
    expect(
      ok(['team', 'post', 'alpha', 'hello', 'team', '--mention', 'a1', '--mention', 'a2'])
        .teamCommand,
    ).toEqual({
      kind: 'post',
      teamId: 'alpha',
      content: 'hello team',
      mentions: ['a1', 'a2'],
      json: false,
    });
    expect(ok(['team', 'post', 'alpha', 'status']).teamCommand).toEqual({
      kind: 'post',
      teamId: 'alpha',
      content: 'status',
      mentions: [],
      json: false,
    });
  });

  it('team members <team_id> add|remove <member> [--json]', () => {
    expect(ok(['team', 'members', 'alpha', 'add', 'a1']).teamCommand).toEqual({
      kind: 'members',
      teamId: 'alpha',
      action: 'add',
      member: 'a1',
      json: false,
    });
    expect(ok(['team', 'members', 'alpha', 'remove', 'a1', '--json']).teamCommand).toEqual({
      kind: 'members',
      teamId: 'alpha',
      action: 'remove',
      member: 'a1',
      json: true,
    });
  });

  it('team 非法参数报错', () => {
    expect(err(['team', 'bogus'])).toContain('Unknown team subcommand');
    expect(err(['team', 'list', '--bogus'])).toContain('Unknown argument');
    expect(err(['team', 'get'])).toContain('team get requires <team_id>');
    expect(err(['team', 'get', 'a', 'b'])).toContain('Unknown argument');
    expect(err(['team', 'get', 'alpha', '--limit', '0'])).toContain('Invalid --limit');
    expect(err(['team', 'get', 'alpha', '--limit', 'abc'])).toContain('Invalid --limit');
    expect(err(['team', 'get', 'alpha', '--limit'])).toContain('Missing value for --limit');
    expect(err(['team', 'post', 'alpha'])).toContain('team post requires');
    expect(err(['team', 'post', 'alpha', 'hi', '--mention'])).toContain(
      'Missing value for --mention',
    );
    expect(err(['team', 'members', 'alpha', 'add'])).toContain('team members requires');
    expect(err(['team', 'members', 'alpha', 'bogus', 'a1'])).toContain(
      'Invalid team members action',
    );
    expect(err(['team', 'members', 'alpha', 'add', 'a1', 'extra'])).toContain('Unknown argument');
  });
});

describe('parseArgs - team budget (0.19 S4)', () => {
  it('team budget <team_id> [--conversation <id>] [--json]', () => {
    expect(ok(['team', 'budget', 'alpha']).teamCommand).toEqual({
      kind: 'budget-status',
      teamId: 'alpha',
      json: false,
    });
    expect(
      ok(['team', 'budget', 'alpha', '--conversation', 'conv_1', '--json']).teamCommand,
    ).toEqual({
      kind: 'budget-status',
      teamId: 'alpha',
      conversationId: 'conv_1',
      json: true,
    });
  });

  it('team budget override maps --max and unlimited to null', () => {
    expect(
      ok([
        'team',
        'budget',
        'override',
        'alpha',
        '--conversation',
        'conv_1',
        '--dimension',
        'turns',
        '--max',
        '5',
      ]).teamCommand,
    ).toEqual({
      kind: 'budget-override',
      teamId: 'alpha',
      conversationId: 'conv_1',
      dimension: 'turns',
      max: 5,
      json: false,
    });
    expect(
      ok([
        'team',
        'budget',
        'override',
        'alpha',
        '--conversation',
        'conv_1',
        '--dimension',
        'cycle',
        '--max',
        'unlimited',
        '--json',
      ]).teamCommand,
    ).toEqual({
      kind: 'budget-override',
      teamId: 'alpha',
      conversationId: 'conv_1',
      dimension: 'cycle',
      max: null,
      json: true,
    });
  });

  it('team budget rejects invalid args', () => {
    expect(ok(['team', 'budget', '--help']).help).toBe(true);
    expect(err(['team', 'budget'])).toContain('team budget requires <team_id>');
    expect(err(['team', 'budget', 'alpha', 'extra'])).toContain('Unknown argument');
    expect(err(['team', 'budget', 'alpha', '--bogus'])).toContain('Unknown argument');
    expect(err(['team', 'budget', 'override', 'alpha'])).toContain('requires --conversation <id>');
    expect(
      err(['team', 'budget', 'override', 'alpha', '--conversation', 'conv_1', '--max', '5']),
    ).toContain('requires --dimension <d>');
    expect(
      err([
        'team',
        'budget',
        'override',
        'alpha',
        '--conversation',
        'conv_1',
        '--dimension',
        'cost',
        '--max',
        '5',
      ]),
    ).toContain('Invalid --dimension');
    expect(
      err([
        'team',
        'budget',
        'override',
        'alpha',
        '--conversation',
        'conv_1',
        '--dimension',
        'turns',
      ]),
    ).toContain('requires --max <n|unlimited>');
    expect(
      err([
        'team',
        'budget',
        'override',
        'alpha',
        '--conversation',
        'conv_1',
        '--dimension',
        'turns',
        '--max',
        'abc',
      ]),
    ).toContain('Invalid --max');
  });
});

describe('parseArgs - agent new workspace (0.19 S3)', () => {
  it('--workspace 进入 new 变体', () => {
    expect(ok(['agent', 'new', '--workspace', '/tmp/alpha']).agentCommand).toEqual({
      kind: 'new',
      json: false,
      workspace: '/tmp/alpha',
    });
    expect(
      ok(['agent', 'new', '--name', 'a1', '--workspace', '/tmp/alpha', '--json']).agentCommand,
    ).toEqual({
      kind: 'new',
      json: true,
      name: 'a1',
      workspace: '/tmp/alpha',
    });
  });

  it('--workspace 缺值报错', () => {
    expect(err(['agent', 'new', '--workspace'])).toContain('Missing value for --workspace');
  });
});

describe('0.15 multi-instance flags', () => {
  it('--data-dir is a global override', () => {
    expect(ok(['--data-dir', '/srv/vessel']).dataDirArg).toBe('/srv/vessel');
    expect(err(['--data-dir'])).toContain('Missing value for --data-dir');
  });

  it('--exclusive forces the tenant single-writer lock', () => {
    expect(ok([]).exclusive).toBe(false);
    expect(ok(['--exclusive']).exclusive).toBe(true);
  });

  it('doctor --deep is additive', () => {
    expect(ok(['doctor', '--deep']).doctorCommand).toEqual({ json: false, deep: true });
  });

  it('gateway start --daemon --exclusive propagates to the child', () => {
    const parsed = ok(['gateway', 'start', '--daemon', '--exclusive']);
    expect(parsed.exclusive).toBe(true);
    expect(parsed.gateway).toEqual({ kind: 'start', daemon: true });
    const argv = buildDaemonArgv({ execPath: 'bun', entryPath: 'cli.ts', exclusive: true });
    expect(argv).toContain('--exclusive');
    expect(ok(argv.slice(2)).exclusive).toBe(true);
  });

  it('gateway status --rpc', () => {
    expect(ok(['gateway', 'status', '--rpc']).gateway).toEqual({
      kind: 'status',
      json: false,
      rpc: true,
    });
  });

  it('logs tail parses json/lines/instance', () => {
    expect(ok(['logs', 'tail']).logsCommand).toEqual({ kind: 'tail', json: false, lines: 50 });
    expect(ok(['logs', 'tail', '--json', '--lines', '5', '--instance', 'web']).logsCommand).toEqual(
      { kind: 'tail', json: true, lines: 5, instance: 'web' },
    );
    expect(err(['logs'])).toContain('Usage: vessel logs tail');
    expect(err(['logs', 'tail', '--lines', '0'])).toContain('Invalid --lines');
    expect(err(['logs', 'tail', '--bogus'])).toContain('Unknown argument');
  });
});

describe('parseArgs - attention (0.22 S9.1)', () => {
  it('list defaults to pending, limit 20, and accepts connection flags', () => {
    const args = ok(['attention']);
    expect(args.attentionCommand).toEqual({
      kind: 'list',
      status: 'pending',
      limit: 20,
      json: false,
      interactive: false,
      all: false,
      remember: false,
      yes: false,
    });

    const remote = ok([
      'attention',
      '--connect',
      'https://node.example',
      '--connect-token',
      't',
      '--ca',
      'ca.pem',
      '--tenant',
      'alpha',
      '--team',
      'alpha',
      '--agent',
      'worker',
      '--status',
      'orphaned',
      '--order',
      'oldest',
      '--limit',
      '500',
      '--cursor',
      'c1',
      '--json',
    ]);
    expect(remote.attentionCommand).toMatchObject({
      kind: 'list',
      connectUrl: 'https://node.example',
      connectToken: 't',
      caFile: 'ca.pem',
      tenantId: 'alpha',
      teamId: 'alpha',
      agent: 'worker',
      status: 'orphaned',
      order: 'oldest',
      limit: 500,
      cursor: 'c1',
      json: true,
    });
  });

  it('--to is validated at parse time', () => {
    const parsed = ok(['attention', '--to', 'human@node-1:alpha']);
    expect(parsed.attentionCommand?.to).toBe('human@node-1:alpha');
    expect(err(['attention', '--to', 'not-an-address'])).toContain('Invalid --to');
  });

  it('--connect-token / --ca require --connect', () => {
    expect(err(['attention', '--connect-token', 't'])).toContain('requires --connect');
    expect(err(['attention', '--ca', 'ca.pem'])).toContain('requires --connect');
  });

  it('--limit / --order / --status / --cursor enums', () => {
    expect(err(['attention', '--limit', '0'])).toContain('Invalid --limit');
    expect(err(['attention', '--limit', '501'])).toContain('Invalid --limit');
    expect(err(['attention', '--order', 'random'])).toContain('--order');
    expect(err(['attention', '--status', 'answered'])).toContain('--status');
    expect(err(['attention', '--cursor'])).toContain('Missing value for --cursor');
  });

  it('--all requires --yes', () => {
    expect(err(['attention', 'respond', '--all', '--allow'])).toContain('--yes');
    expect(
      ok(['attention', 'respond', '--all', '--allow', '--yes']).attentionCommand,
    ).toMatchObject({
      kind: 'respond',
      all: true,
      decision: 'allow',
      yes: true,
    });
  });

  it('respond requires exactly one target and validates combinations', () => {
    expect(err(['attention', 'respond'])).toContain('exactly one');
    expect(err(['attention', 'respond', '--select', '1', '--all', '--allow', '--yes'])).toContain(
      'exactly one',
    );
    expect(
      ok(['attention', 'respond', '--select', '1,2', '--allow']).attentionCommand,
    ).toMatchObject({ select: [1, 2], decision: 'allow' });
  });

  it('--select parses, dedupes, and rejects empty / zero / non-numeric entries', () => {
    const parsed = ok(['attention', 'respond', '--select', '1,3,3', '--deny', '--yes']);
    expect(parsed.attentionCommand?.select).toEqual([1, 3]);
    expect(err(['attention', 'respond', '--select'])).toContain('Missing value for --select');
    for (const raw of ['0', 'a', '1,,2', ',']) {
      expect(err(['attention', 'respond', '--select', raw, '--allow', '--yes'])).toContain(
        'Invalid --select',
      );
    }
  });

  it('--answers only with a positional request_id and never with --allow/--deny', () => {
    const parsed = ok(['attention', 'respond', 'r1', '--answers', '[{"q":"x","answer":"y"}]']);
    expect(parsed.attentionCommand).toMatchObject({
      kind: 'respond',
      requestId: 'r1',
      answers: [{ q: 'x', answer: 'y' }],
    });
    expect(err(['attention', 'respond', '--all', '--answers', '[]', '--yes'])).toContain(
      'positional',
    );
    expect(err(['attention', 'respond', 'r1', '--answers', '[]', '--allow'])).toContain(
      'cannot be combined',
    );
    expect(err(['attention', 'respond', 'r1', '--answers', 'not-json'])).toContain('valid JSON');
    expect(err(['attention', 'respond', 'r1', '--answers', '{}'])).toContain('JSON array');
  });

  it('--allow and --deny are mutually exclusive; respond needs one (answers excepted)', () => {
    expect(err(['attention', 'respond', 'r1'])).toContain('requires --allow or --deny');
    expect(err(['attention', 'respond', 'r1', '--allow', '--deny'])).toContain(
      'mutually exclusive',
    );
  });

  it('--interactive is list-only', () => {
    expect(ok(['attention', '--interactive']).attentionCommand?.interactive).toBe(true);
    expect(err(['attention', 'respond', 'r1', '--allow', '--interactive'])).toContain('only valid');
  });
});
