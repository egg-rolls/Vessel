/**
 * mock 场景 provider + `vessel demo` 的 CLI 契约（0.8.6 G1/G2）
 *
 * 用 Bun.spawn 跑真实 CLI；cwd 与 HOME 指向临时目录，避免读写真实用户数据。
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
  const tmpDir = cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-mock-'));
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: tmpDir,
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

function readSessionMessages(dataDir: string): Array<{ role: string; content: string }> {
  const sessionsDir = path.join(dataDir, 'tenants', 'default', 'sessions');
  const files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'));
  const file = files[0];
  if (!file) throw new Error('no session file saved');
  const state = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8')) as {
    messages: Array<{ role: string; content: string }>;
  };
  return state.messages;
}

it('tools scenario executes bash and persists the tool result before the final reply', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-mock-tools-'));
  try {
    const dataDir = path.join(tmpDir, 'data');
    const { stdout, exitCode } = await runCli(
      ['--run', 'hi'],
      { VESSEL_MOCK: '1', VESSEL_MOCK_SCENARIO: 'tools', VESSEL_DATA_DIR: dataDir },
      '',
      tmpDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Tool call finished');

    const toolMessages = readSessionMessages(dataDir).filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain('vessel-demo-ok');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('error scenario exits non-zero instead of returning a fabricated reply', async () => {
  const { stdout, stderr, exitCode } = await runCli(['--run', 'hi'], {
    VESSEL_MOCK: '1',
    VESSEL_MOCK_SCENARIO: 'error',
  });

  expect(exitCode).not.toBe(0);
  expect(stdout.trim()).toBe('');
  expect(stderr).toContain('Mock scenario error');
});

it('unknown scenario falls back to echo but warns once on stderr', async () => {
  const { stdout, stderr, exitCode } = await runCli(['--run', 'hi'], {
    VESSEL_MOCK: '1',
    VESSEL_MOCK_SCENARIO: 'bogus',
    VESSEL_LANG: 'en',
  });

  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('Echo: hi');
  expect(stderr).toContain('Unknown VESSEL_MOCK_SCENARIO "bogus"');
});

it('default mock run stays silent and echoes when no scenario is set', async () => {
  const { stdout, stderr, exitCode } = await runCli(['--run', 'hello'], {
    VESSEL_MOCK: '1',
    VESSEL_MOCK_SCENARIO: '',
  });

  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe('Echo: hello');
  expect(stderr).not.toContain('VESSEL_MOCK_SCENARIO');
});

it('demo refuses a non-TTY stdin instead of starting a dead REPL', async () => {
  const { stderr, exitCode } = await runCli(['demo'], {
    VESSEL_MOCK_SCENARIO: '',
    VESSEL_LANG: 'en',
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain('interactive terminal');
});
