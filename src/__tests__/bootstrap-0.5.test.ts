import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type RunEvent, resolveTenantPaths } from '../../packages/core/src/index';
import { bootstrap } from '../bootstrap';
import type { RpcClient } from '../rpc/index';

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
        // AWS key 只由 ext redact-secrets 命中，用于证明 asm 已组合该 redactor。
        data: { input: 'hi', note: 'AKIAABCDEFGHIJKLMNOP' },
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
      const raw = JSON.stringify(lines[0]);
      expect(raw).not.toContain('AKIAABCDEFGHIJKLMNOP');
      expect(raw).toContain('***AWS-KEY-REDACTED***');
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

describe('bootstrap 0.5 - rpc injection', () => {
  it('local 模式：ctx.rpc / ctx.tenant 注入，capabilities.list 与 sessions.list 可用', async () => {
    const dataDir = tempDir();
    const result = await bootstrap(baseOptions(dataDir));

    try {
      expect(result.ctx.rpc).toBeDefined();
      expect(result.ctx.tenant).toEqual({
        tenant_id: 'default',
        data_dir: result.tenantPaths.root,
      });

      const capabilities = await result.ctx.rpc?.request<{
        version: string;
        methods: Array<{ name: string }>;
      }>('capabilities.list');
      const names = capabilities?.methods.map((method) => method.name) ?? [];
      expect(names).toContain('capabilities.list');
      expect(names).toContain('sessions.list');

      await result.ctx.session.save({
        run_id: 'run-rpc',
        session_id: 'session-rpc',
        messages: [{ role: 'user', content: 'hello' }],
        started_at: 1000,
        status: 'completed',
      });
      const listed = await result.ctx.rpc?.request<{
        sessions: Array<{ session_id: string }>;
      }>('sessions.list');
      expect(listed?.sessions.some((item) => item.session_id === 'session-rpc')).toBe(true);
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：已有 client 注入 ctx.rpc / ctx.tenant，不加锁', async () => {
    const dataDir = tempDir();
    const calls: string[] = [];
    const stub = {
      request: async <T = unknown>(method: string): Promise<T> => {
        calls.push(method);
        return { version: 'stub', methods: [] } as T;
      },
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as RpcClient & { close(): Promise<void> };

    const result = await bootstrap({
      ...baseOptions(dataDir),
      connect: 'http://127.0.0.1:1',
      rpcClientFactory: () => stub,
    });

    try {
      expect(result.ctx.rpc).toBe(stub);
      expect(result.ctx.tenant).toEqual({
        tenant_id: 'default',
        data_dir: result.tenantPaths.root,
      });
      await result.ctx.rpc?.request('capabilities.list');
      expect(calls).toEqual(['capabilities.list']);
      expect(result.tenantLock).toBeUndefined();
      expect(fs.existsSync(result.tenantPaths.lock_file)).toBe(false);
    } finally {
      await result.shutdown();
    }
  });
});
