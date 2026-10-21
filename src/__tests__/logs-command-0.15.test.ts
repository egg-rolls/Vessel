/**
 * 0.15 `vessel logs tail`：只读尾部、按实例选文件、缺失时退出 1。
 *
 * 故障形态：把整个大日志读进内存 / 读错实例的日志 / 没有日志却静默成功。
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LogsCommandOptions, logsCommand } from '../logs-command';

const dirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vessel-logs-'));
  dirs.push(dir);
  await mkdir(join(dir, 'logs'), { recursive: true });
  return dir;
}

function options(dataDir: string, extra: Partial<LogsCommandOptions> = {}): LogsCommandOptions {
  return {
    dataDir,
    configPath: join(dataDir, 'missing-project.yaml'),
    userConfigPath: join(dataDir, 'missing-user.yaml'),
    env: {},
    ...extra,
  };
}

afterEach(() => {
  dirs.length = 0;
});

describe('logs tail', () => {
  it('returns the last N complete lines', async () => {
    const dataDir = await tempDataDir();
    const lines = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`);
    await writeFile(join(dataDir, 'logs', 'gateway.log'), `${lines.join('\n')}\n`);
    const result = await logsCommand(options(dataDir, { lines: 3 }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n').slice(-3)).toEqual(['line-98', 'line-99', 'line-100']);
  });

  it('tails a large log without returning a truncated first line', async () => {
    const dataDir = await tempDataDir();
    const padding = 'x'.repeat(200);
    const lines = Array.from({ length: 3000 }, (_, index) => `${index}:${padding}`);
    await writeFile(join(dataDir, 'logs', 'gateway.log'), `${lines.join('\n')}\n`);
    // 请求超过 256 KiB 窗口的行数：首行必须从换行后开始，不能是截断片段。
    const result = await logsCommand(options(dataDir, { lines: 2000 }));
    expect(result.exitCode).toBe(0);
    const output = result.stdout.split('\n');
    expect(output[0]).toContain('gateway.log');
    const tail = output.slice(1);
    expect(tail.length).toBeGreaterThan(1000);
    expect(tail[0] ?? '').toMatch(/^\d+:/);
    expect(tail[tail.length - 1]).toBe(lines[lines.length - 1]);
  });

  it('selects a named instance log', async () => {
    const dataDir = await tempDataDir();
    await writeFile(join(dataDir, 'logs', 'gateway.log'), 'default\n');
    await writeFile(join(dataDir, 'logs', 'gateway-web.log'), 'web-only\n');
    const result = await logsCommand(options(dataDir, { instance: 'web', json: true }));
    const payload = JSON.parse(result.stdout) as {
      files: Array<{ instance: string; lines: string[] }>;
    };
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]?.instance).toBe('web');
    expect(payload.files[0]?.lines).toEqual(['web-only']);
  });

  it('exits 1 when no gateway logs exist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vessel-logs-empty-'));
    dirs.push(dataDir);
    const result = await logsCommand(options(dataDir));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(join(dataDir, 'logs'));
  });
});
