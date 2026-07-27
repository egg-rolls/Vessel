import { Database } from 'bun:sqlite';
/**
 * Headless 模式集成测试（bash 管道驱动 = loop engineering 入口）
 *
 * 用 Bun.spawn 跑真实 CLI 子进程，VESSEL_MOCK=1 用内存 Provider 保证确定性。
 * 隔离：cwd 用临时目录，避免污染真实 vessel.db。
 */
import { expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    proc.stdin.write(stdin);
    proc.stdin.end();
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
  expect(stderr).toContain('API key');
});

it('headless --run（无参）：从 stdin 读输入（--pipe 已折叠进 --run）', async () => {
  const { stdout, exitCode } = await runCli(['--run'], { VESSEL_MOCK: '1' }, 'from stdin');
  expect(exitCode).toBe(0);
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
      { VESSEL_MOCK: '1' },
      '',
      tmpDir,
    );
    expect(exitCode).toBe(0);
    // 最后一条 user 作为本次输入
    expect(stdout.trim()).toBe('Echo: follow up');
    expect(stderr).toContain('[vessel]');
    // 验证 seeding：session DB 含完整历史（seed 的前两条 + 本次 user + 响应）
    const db = new Database(path.join(tmpDir, 'vessel.db'), { readonly: true });
    const row = db.query('SELECT messages FROM sessions').get() as { messages: string } | null;
    db.close();
    if (!row) throw new Error('no session saved');
    const saved = JSON.parse(row.messages) as Array<{ role: string; content: string }>;
    const contents = saved.map((m) => m.content);
    expect(contents).toContain('first question');
    expect(contents).toContain('first answer');
    expect(contents).toContain('follow up');
    expect(contents).toContain('Echo: follow up');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
