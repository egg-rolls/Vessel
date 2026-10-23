/**
 * 0.5.4 P2-2：POSIX 下 shutdown 释放全部 tenant 锁。
 *
 * 真实 CLI + `--serve 0 --exclusive`（file 后端默认 shared `.members/`，
 * 只有 exclusive 才用 `.lock`），两个 tenant；SIGINT 后：
 * SIGINT 后自然退出 0，两个 `.lock` 都被删除。
 *
 * Windows 没有 POSIX 信号语义，整组 skip；需在 POSIX CI 执行。
 */

import { expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..');
const cliPath = path.join(repoRoot, 'src', 'cli.ts');

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-lock-shutdown-'));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function waitForOutput(
  proc: { stdout: ReadableStream<Uint8Array> },
  pattern: RegExp,
  timeoutMs = 15000,
): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopped = false;

  const pump = (async () => {
    try {
      while (!stopped) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
      }
    } catch {
      // 进程退出导致流关闭
    }
  })();

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(buffer)) return buffer;
      await Bun.sleep(50);
    }
    return buffer;
  } finally {
    stopped = true;
    await reader.cancel().catch(() => {});
    void pump;
  }
}

function tenantLockPath(dir: string, tenantId: string): string {
  return path.join(dir, '.vessel', 'data', 'tenants', tenantId, '.lock');
}

function twoTenantConfig(): string {
  return [
    'provider:',
    '  name: openai',
    '  model: gpt-4',
    'tenant:',
    '  default: acme',
    '  tenants:',
    '    acme:',
    '      status: active',
    '      config: {}',
    '    work:',
    '      status: active',
    '      config: {}',
    '',
  ].join('\n');
}

function startServe(dir: string) {
  return Bun.spawn([process.execPath, cliPath, '--serve', '0', '--exclusive'], {
    cwd: dir,
    env: { ...process.env, VESSEL_MOCK: '1', USERPROFILE: dir, HOME: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

it.skipIf(process.platform === 'win32')(
  'SIGINT releases every tenant lock',
  async () => {
    const dir = tmpDir();
    const acmeLock = tenantLockPath(dir, 'acme');
    const workLock = tenantLockPath(dir, 'work');
    writeFile(path.join(dir, 'vessel.yaml'), twoTenantConfig());

    const proc = startServe(dir);
    try {
      const output = await waitForOutput(proc, /Gateway\s+http/);
      expect(output).toMatch(/Gateway\s+http/);
      expect(fs.existsSync(acmeLock)).toBe(true);
      expect(fs.existsSync(workLock)).toBe(true);

      proc.kill('SIGINT');
      const exitCode = await proc.exited;

      expect(fs.existsSync(acmeLock)).toBe(false);
      expect(fs.existsSync(workLock)).toBe(false);
      expect(exitCode).toBe(0);
    } finally {
      proc.kill();
      await proc.exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
