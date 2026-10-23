import { expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileRunStore, type RunCheckpoint } from '../../packages/core/src/index';

/**
 * `--resume-run` 的真实 CLI 端到端测试。
 * 隔离：cwd 与 HOME 都指向临时目录；VESSEL_MOCK=1 使用内存 Provider。
 */

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

async function runCli(
  args: string[],
  tmpDir: string,
  env: Record<string, string> = { VESSEL_MOCK: '1' },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: tmpDir,
    env: { ...process.env, ...env, USERPROFILE: tmpDir, HOME: tmpDir },
    // 固定非 TTY：headless 判定依赖 stdin.isTTY，交互终端下不能继承。
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'resume-1',
    session_id: 'session-1',
    status: 'interrupted',
    messages: [{ role: 'user', content: 'hello-resume' }],
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

async function durableDir(): Promise<{
  tmpDir: string;
  runsDir: string;
  store: FileRunStore;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-resume-e2e-'));
  const runsDir = path.join(tmpDir, 'runs');
  const config = [
    'durable:',
    '  enabled: true',
    '  backend: file',
    `  path: ${runsDir.replaceAll('\\', '/')}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tmpDir, 'vessel.yaml'), config, 'utf-8');
  return { tmpDir, runsDir, store: new FileRunStore({ dir: runsDir }) };
}

it('--resume-run 无参列出 interrupted run', async () => {
  const { tmpDir, store } = await durableDir();
  try {
    await store.save(checkpoint({ run_id: 'older', updated_at: 1000 }));
    await store.save(checkpoint({ run_id: 'newer', updated_at: 3000 }));
    await store.save(checkpoint({ run_id: 'done', status: 'completed', updated_at: 4000 }));

    const { stdout, exitCode } = await runCli(['--resume-run'], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Interrupted runs (2, newest first):');
    expect(stdout).toContain('newer');
    expect(stdout).toContain('older');
    expect(stdout).not.toContain('done');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('--resume-run <id> 单 agent 恢复并打印结果', async () => {
  const { tmpDir, store } = await durableDir();
  try {
    await store.save(checkpoint());

    const { stdout, stderr, exitCode } = await runCli(['--resume-run', 'resume-1'], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Echo: hello-resume');
    expect(stderr).not.toContain('resume_failed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('--resume-run headless：权限请求自动允许，工具调用不挂起', async () => {
  const { tmpDir, store } = await durableDir();
  try {
    await store.save(checkpoint({ run_id: 'resume-tool', session_id: 'session-tool' }));
    // tools 场景首轮发 bash 调用；bash 的 checkPermission 会发 tool.permission.request
    // 并等待应答。headless（非 TTY）必须自动允许，否则 policy 无限等待、进程挂起。
    const { stdout, stderr, exitCode } = await runCli(['--resume-run', 'resume-tool'], tmpDir, {
      VESSEL_MOCK: '1',
      VESSEL_MOCK_SCENARIO: 'tools',
    });
    expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
    expect(stdout).toContain('Tool call finished');
    expect(stderr).not.toContain('resume_failed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('--resume-run 未知 id：exit 1 + run_not_found', async () => {
  const { tmpDir } = await durableDir();
  try {
    const { stderr, exitCode } = await runCli(['--resume-run', 'nope'], tmpDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('run_not_found');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('durable 关闭时恢复：exit 1 + durable_disabled', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-resume-off-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'vessel.yaml'),
      'provider:\n  name: openai\n  model: gpt-4\n',
    );
    const { stderr, exitCode } = await runCli(['--resume-run', 'x'], tmpDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('durable_disabled');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

it('--resume-run 与 --run 冲突：用法错误 exit 2', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-resume-clash-'));
  try {
    const { stderr, exitCode } = await runCli(['--resume-run', 'x', '--run', 'hi'], tmpDir);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--resume-run cannot be combined');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
