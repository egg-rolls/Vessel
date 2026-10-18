import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type RunEvent, resolveTenantPaths } from '../../packages/core/src/index';
import { bootstrap } from '../bootstrap';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-boot-'));
  tempDirs.push(dir);
  return dir;
}

function tmpYaml(content: string): string {
  const file = path.join(tempDir(), 'config.yaml');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function missingPath(): string {
  return path.join(tempDir(), 'missing.yaml');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows 文件句柄释放可能滞后
      }
    }
  }
});

function baseOptions(dataDir: string) {
  return {
    useMock: true,
    headless: true,
    interactive: false,
    acquireLock: true,
    dataDir,
    userConfigPath: tmpYaml('api_key: sk-test\n'),
    configPath: missingPath(),
  };
}

describe('bootstrap 0.5 - tenant / lock / paths', () => {
  it('解析 tenantPaths、持有并释放 tenant 锁', async () => {
    const dataDir = tempDir();
    const result = await bootstrap(baseOptions(dataDir));

    const expected = resolveTenantPaths(dataDir, 'default');
    expect(result.tenantId).toBe('default');
    expect(result.tenantPaths).toEqual(expected);
    expect(result.tenantLock).toBeDefined();
    expect(fs.existsSync(expected.lock_file)).toBe(true);

    await result.shutdown();
    expect(fs.existsSync(expected.lock_file)).toBe(false);
  });

  it('--tenant / config.tenant.default 选择 overlay 与目录', async () => {
    const dataDir = tempDir();
    const result = await bootstrap({
      ...baseOptions(dataDir),
      tenantId: 'work',
      userConfigPath: tmpYaml(`
api_key: sk-test
tenant:
  default: work
  tenants:
    work:
      config:
        provider:
          model: tenant-model
`),
    });

    expect(result.tenantId).toBe('work');
    expect(result.config.provider?.model).toBe('tenant-model');
    expect(result.tenantPaths.root).toContain(path.join('tenants', 'work'));

    await result.shutdown();
  });

  it('tenant disabled 拒绝启动（exit 1）', async () => {
    const dataDir = tempDir();
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await expect(
        bootstrap({
          ...baseOptions(dataDir),
          acquireLock: false,
          userConfigPath: tmpYaml(`
api_key: sk-test
tenant:
  default: work
  tenants:
    work:
      status: disabled
`),
        }),
      ).rejects.toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('bootstrap 0.5 - trace / events', () => {
  it('trace 落盘补齐 tenant_id，config.loaded / plugin.loaded 已发布', async () => {
    const dataDir = tempDir();
    const result = await bootstrap(baseOptions(dataDir));

    try {
      const events = result.runtime.events.getHistory();
      const configLoaded = events.find((event) => event.type === 'config.loaded');
      expect(configLoaded).toBeDefined();
      expect(configLoaded?.data.tenant_id).toBe('default');
      expect(Array.isArray(configLoaded?.data.sources)).toBe(true);
      expect(Array.isArray(configLoaded?.data.keys)).toBe(true);
      expect(events.some((event) => event.type === 'plugin.loaded')).toBe(true);

      result.runtime.events.publish({
        type: 'run.started',
        run_id: 'run-trace',
        data: { input: 'hi' },
        ts: 1000,
      });
      await result.trace?.flush('run-trace');

      const traceFile = path.join(result.tenantPaths.events_dir, 'run-trace.jsonl');
      const lines = fs
        .readFileSync(traceFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as RunEvent);

      expect(lines).toHaveLength(1);
      expect(lines[0]?.tenant_id).toBe('default');
      expect(lines[0]?.seq).toBe(1);
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式不加锁、不安装本地 trace', async () => {
    const dataDir = tempDir();
    const result = await bootstrap({
      ...baseOptions(dataDir),
      connect: 'http://127.0.0.1:1',
    });

    expect(result.tenantLock).toBeUndefined();
    expect(result.trace).toBeUndefined();
    expect(fs.existsSync(result.tenantPaths.lock_file)).toBe(false);
    expect(result.runtime).toBeDefined();

    await result.shutdown();
  });
});
