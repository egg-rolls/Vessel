import { afterAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeGatewayPid } from '../gateway/pid';

/**
 * `vessel gateway` 生命周期集成测试（真实子进程 + 假 HOME/data_dir）。
 *
 * 只在本机 spawn `gateway start --daemon`；所有数据写入临时目录，
 * 不触碰真实用户配置/会话。
 */

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');
const DEAD_PID = 2_147_483_647;

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-gateway-e2e-'));
  dirs.push(dir);
  return dir;
}

function envFor(dir: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    VESSEL_MOCK: '1',
    VESSEL_NO_UPDATE_CHECK: '1',
    HOME: dir,
    USERPROFILE: dir,
    VESSEL_DATA_DIR: path.join(dir, 'data'),
  };
}

async function runCli(
  dir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: dir,
    env: envFor(dir),
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

async function stopGateway(dir: string): Promise<void> {
  await runCli(dir, ['gateway', 'stop', '--timeout', '5s']).catch(() => undefined);
}

afterAll(async () => {
  for (const dir of dirs) {
    await stopGateway(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('vessel gateway lifecycle', () => {
  it('未运行时 status 返回 1 且 JSON 可解析', async () => {
    const dir = tmpDir();
    const status = await runCli(dir, ['gateway', 'status', '--json']);
    expect(status.exitCode).toBe(1);
    const parsed = JSON.parse(status.stdout) as { running?: boolean; service?: unknown };
    expect(parsed.running).toBe(false);
  });

  it('start --daemon → status → 重复启动拒绝 → stop', async () => {
    const dir = tmpDir();
    try {
      const start = await runCli(dir, ['gateway', 'start', '--daemon', '--port', '0']);
      expect(start.stderr).toBe('');
      expect(start.exitCode).toBe(0);
      expect(start.stdout).toContain('Gateway');
      expect(start.stdout).toContain('gateway.log');

      const status = await runCli(dir, ['gateway', 'status', '--json']);
      expect(status.exitCode).toBe(0);
      const parsed = JSON.parse(status.stdout) as {
        running: boolean;
        pid: number;
        port: number;
        url: string;
        uptime_seconds: number;
      };
      expect(parsed.running).toBe(true);
      expect(parsed.pid).toBeGreaterThan(0);
      expect(parsed.port).toBeGreaterThan(0);
      expect(parsed.url).toContain(`:${parsed.port}`);
      expect(parsed.uptime_seconds).toBeGreaterThanOrEqual(0);

      const duplicate = await runCli(dir, ['gateway', 'start', '--daemon']);
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr).toContain(String(parsed.pid));

      const stop = await runCli(dir, ['gateway', 'stop', '--timeout', '10s']);
      expect(stop.exitCode).toBe(0);

      const after = await runCli(dir, ['gateway', 'status', '--json']);
      expect(after.exitCode).toBe(1);
      expect((JSON.parse(after.stdout) as { running: boolean }).running).toBe(false);
    } finally {
      await stopGateway(dir);
    }
  }, 60_000);

  it('死 pid 自动回收后可重新启动', async () => {
    const dir = tmpDir();
    const dataDir = path.join(dir, 'data');
    try {
      await writeGatewayPid(dataDir, {
        pid: DEAD_PID,
        started_at: new Date().toISOString(),
        host: '127.0.0.1',
        port: 1,
        version: '0.0.0-stale',
      });

      const start = await runCli(dir, ['gateway', 'start', '--daemon', '--port', '0']);
      expect(start.exitCode).toBe(0);

      const status = await runCli(dir, ['gateway', 'status', '--json']);
      expect(status.exitCode).toBe(0);
      const parsed = JSON.parse(status.stdout) as { pid: number };
      expect(parsed.pid).not.toBe(DEAD_PID);
    } finally {
      await stopGateway(dir);
    }
  }, 60_000);
});
