/**
 * Headless 模式集成测试（bash 管道驱动 = loop engineering 入口）
 *
 * 用 Bun.spawn 跑真实 CLI 子进程，VESSEL_MOCK=1 用内存 Provider 保证确定性。
 * 隔离：cwd 用临时目录，避免污染真实 .vessel/sessions.db。
 */
import { expect, it, setDefaultTimeout } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 每个用例都 spawn 真实 CLI 子进程（冷启动 + 配置加载 + provider 装配）。
// 并行测试/CI 慢盘上单个用例偶发超过 bun test 默认的 5s，放宽到 30s。
setDefaultTimeout(30_000);

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

async function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdin = '',
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; tmpDir: string }> {
  const ownsDir = !cwd;
  const tmpDir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-cli-'));
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: tmpDir,
    // 隔离真实用户配置：把 HOME/USERPROFILE 指向临时目录，使 ~/.vessel/config.yaml 不存在
    env: { ...process.env, ...env, USERPROFILE: tmpDir, HOME: tmpDir },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin ? 'pipe' : undefined,
  });
  if (stdin) {
    // FileSink.write/end 在背压下返回 Promise；不 await 就 end 可能让子进程
    // 读到 EOF 而没有数据（表现为 headless 报 noInput、退出 1）。
    await proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (ownsDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  return { stdout, stderr, exitCode, tmpDir };
}

it('headless --run：stdout 只放响应，exit 0', async () => {
  const { stdout, exitCode } = await runCli(['--run', 'hello'], { VESSEL_MOCK: '1' });
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('Echo: hello');
});

it('--serve --run：run 结束后统一清理，不残留 tenant 锁（A2）', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-serve-run-'));
  try {
    const dataDir = path.join(tmpDir, 'data');
    const { exitCode } = await runCli(
      ['--run', 'hello', '--serve', '0'],
      { VESSEL_MOCK: '1', VESSEL_DATA_DIR: dataDir },
      '',
      tmpDir,
    );
    expect(exitCode).toBe(0);
    // 锁由 bootstrap 的 shutdown 释放；提前 process.exit 会留下该文件。
    expect(fs.existsSync(path.join(dataDir, 'tenants', 'default', '.lock'))).toBe(false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('headless --pipe：从 stdin 读输入', async () => {
  const { stdout, exitCode } = await runCli(['--pipe'], { VESSEL_MOCK: '1' }, 'from pipe');
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('Echo: from pipe');
});

it('headless 诊断日志走 stderr，不污染 stdout', async () => {
  const { stdout, stderr } = await runCli(['--run', 'hello'], { VESSEL_MOCK: '1' });
  expect(stdout.trim()).toBe('Echo: hello');
  expect(stderr).toContain('[vessel]');
  expect(stderr).not.toContain('Echo: hello');
});

it('headless 失败时 exit 非零', async () => {
  // 不给 mock、不给 api key、headless -> 应 fail-fast 退出
  const { exitCode, stderr } = await runCli(['--run', 'hi'], { VESSEL_MOCK: '' });
  expect(exitCode).not.toBe(0);
  expect(stderr.toLowerCase()).toContain('api key');
});

it('headless --run（无参）：从 stdin 读输入（--pipe 已折叠进 --run）', async () => {
  const { stdout, stderr, exitCode } = await runCli(['--run'], { VESSEL_MOCK: '1' }, 'from stdin');
  // 用对象断言：失败时把 exitCode / stdout / stderr 一起打印，便于定位
  // “stdin 为空”还是“启动失败”。
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
  expect(stdout.trim()).toBe('Echo: from stdin');
});

it('headless --run @file.txt：文本文件作为 prompt', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-txt-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'prompt.txt'), 'hello from file');
    const { stdout, exitCode } = await runCli(
      ['--run', '@prompt.txt'],
      { VESSEL_MOCK: '1' },
      '',
      tmpDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Echo: hello from file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('headless --run @file.json：多轮 seeding，最后一条 user 作为输入，历史入 session', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-seed-'));
  try {
    const messages = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'follow up' },
    ];
    fs.writeFileSync(path.join(tmpDir, 'conv.json'), JSON.stringify(messages));
    const { stdout, stderr, exitCode } = await runCli(
      ['--run', '@conv.json'],
      { VESSEL_MOCK: '1', VESSEL_DATA_DIR: path.join(tmpDir, 'data') },
      '',
      tmpDir,
    );
    expect(exitCode).toBe(0);
    // 最后一条 user 作为本次输入
    expect(stdout.trim()).toBe('Echo: follow up');
    expect(stderr).toContain('[vessel]');
    // 验证 seeding：0.5 默认 file 后端，session 落在 tenant sessions 目录
    const sessionsDir = path.join(tmpDir, 'data', 'tenants', 'default', 'sessions');
    const files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'));
    const sessionFile = files[0];
    if (!sessionFile) throw new Error('no session saved');
    const state = JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionFile), 'utf8')) as {
      messages: Array<{ role: string; content: string }>;
    };
    const saved = state.messages;
    const contents = saved.map((m) => m.content);
    expect(contents).toContain('first question');
    expect(contents).toContain('first answer');
    expect(contents).toContain('follow up');
    expect(contents).toContain('Echo: follow up');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('未注册的 provider（带 base_url）降级为 OpenAI 兼容，info 不 exit 1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-custom-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.vessel'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.vessel', 'config.yaml'),
      [
        'api_key: fake-key',
        'default_provider: custom',
        'default_model: test-model',
        'providers:',
        '  custom:',
        '    api_key: fake-key',
        '    base_url: http://127.0.0.1:1',
        '    model: test-model',
        '',
      ].join('\n'),
    );
    // 交互模式 + /exit：provider 构造是同步的，不触网；仅验证降级 warn + 正常进 REPL
    const { stdout, stderr, exitCode } = await runCli([], {}, '/exit\n', tmpDir);
    expect(exitCode).toBe(0);
    expect(stderr).toContain('not registered; using OpenAI-compatible endpoint');
    expect(stdout).toContain('custom | test-model');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('--version 打印根 package.json 版本，exit 0', async () => {
  const rootVersion = (
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      version: string;
    }
  ).version;
  const { stdout, exitCode } = await runCli(['--version'], {});
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(rootVersion);
});

it('--tools 列出 headless 口径的 3 个能力工具且不需要 Key', async () => {
  const { stdout, exitCode } = await runCli(['--tools'], { VESSEL_MOCK: '' });
  expect(exitCode).toBe(0);
  expect(stdout).toContain('Tools (3):');
  for (const name of ['bash', 'read', 'edit']) {
    expect(stdout).toContain(`- ${name}:`);
  }
  expect(stdout).not.toContain('- delegate_task:');
  expect(stdout).toContain('ask_user (interactive REPL / gateway only)');
});

it('--tools 在 agent.enabled 时列出 agent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-agent-only-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'vessel.yaml'), 'agent:\n  enabled: true\n');
    const { stdout, exitCode } = await runCli(['--tools'], { VESSEL_MOCK: '' }, '', tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Tools (4):');
    expect(stdout).toContain('- agent:');
    expect(stdout).not.toContain('- delegate_task:');
    expect(stdout).not.toContain('- team_spawn:');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('host.enabled=true 时 headless mock 走 Host 路径且不触发回退', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-host-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'vessel.yaml'), 'host:\n  enabled: true\n');
    const { stdout, stderr, exitCode } = await runCli(
      ['--run', 'hello'],
      { VESSEL_MOCK: '1' },
      '',
      tmpDir,
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Echo: hello');
    expect(stderr).not.toContain('Host runtime unavailable');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('--run @missing.txt 报错 exit 1', async () => {
  const { exitCode, stderr } = await runCli(['--run', '@definitely-missing.txt'], {
    VESSEL_MOCK: '1',
  });
  expect(exitCode).toBe(1);
  expect(stderr).toContain('cannot read file');
});

it('--serve 非 TTY 且无 Key 时快速失败，不进首启向导', async () => {
  const { exitCode, stderr } = await runCli(
    ['--serve', '18643'],
    { VESSEL_MOCK: '', VESSEL_LANG: 'en' },
    ' ',
  );
  expect(exitCode).toBe(1);
  expect(stderr).toContain('No API key configured');
});

it('update --check --json 走清单源并输出机器可读结果', async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ version: '9.9.9', channel: 'latest' });
    },
  });
  try {
    const rootVersion = (
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
        version: string;
      }
    ).version;
    const source = `http://127.0.0.1:${server.port}/latest.json`;
    const { stdout, exitCode } = await runCli(['update', '--check', '--json'], {
      VESSEL_UPDATE_SOURCE: source,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      current: rootVersion,
      latest: '9.9.9',
      channel: 'latest',
      up_to_date: false,
    });
    expect(String(parsed.install_hint)).toContain('vessel@9.9.9');
  } finally {
    server.stop();
  }
});

it('未知参数报错并 exit 2（用法错误）', async () => {
  const { exitCode, stderr } = await runCli(['--bogus'], { VESSEL_MOCK: '1' });
  expect(exitCode).toBe(2);
  expect(stderr).toContain('Unknown argument');
});

it('headless --run @bad.json：非法 JSON 报错 exit 1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-bad-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{not json');
    const { exitCode, stderr } = await runCli(
      ['--run', '@bad.json'],
      { VESSEL_MOCK: '1' },
      '',
      tmpDir,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not valid JSON');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
