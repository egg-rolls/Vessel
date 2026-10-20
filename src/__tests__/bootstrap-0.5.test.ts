import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type RunEvent, resolveTenantPaths } from '../../packages/core/src/index';
import { waitForRunCompletion } from '../../packages/tui/src/index';
import { bootstrap } from '../bootstrap';
import type { RpcClient, RpcEventNotification } from '../rpc/index';

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
        // GitHub token 只由 ext redact-secrets 命中（core 默认不识别），
        // 用于证明 asm 已组合该 redactor。
        data: { input: 'hi', note: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab' },
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
      expect(raw).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab');
      expect(raw).toContain('***GITHUB-TOKEN-REDACTED***');
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

  it('local 模式：rpc.subscribe 桥接 runtimeEvents 为 events.event 通知（A1）', async () => {
    const dataDir = tempDir();
    const result = await bootstrap(baseOptions(dataDir));

    try {
      const rpc = result.ctx.rpc;
      if (!rpc) throw new Error('rpc missing');
      const notifications: RpcEventNotification[] = [];
      const unsubscribe = rpc.subscribe((notification) => notifications.push(notification));

      // 终态等待只依赖 rpc.subscribe；没有桥接时会一直挂起（用超时守护）。
      const waiter = waitForRunCompletion(rpc, 'run-local');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('waitForRunCompletion timed out')), 2000);
      });
      try {
        result.runtime.events.publish({
          type: 'run.completed',
          run_id: 'run-local',
          data: { status: 'completed' },
          ts: Date.now(),
        });
        const outcome = await Promise.race([waiter.done, timeout]);
        expect(outcome).toEqual({ status: 'completed' });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toEqual({
        method: 'events.event',
        params: expect.objectContaining({ type: 'run.completed', run_id: 'run-local' }),
      });

      // 只读通知：退订后不再收到。
      unsubscribe();
      result.runtime.events.publish({
        type: 'run.completed',
        run_id: 'run-local',
        data: { status: 'completed' },
        ts: Date.now() + 1,
      });
      expect(notifications).toHaveLength(1);
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
      expect(result.ctx.rpc).toBeDefined();
      expect(result.ctx.tenant).toEqual({
        tenant_id: 'default',
        data_dir: result.tenantPaths.root,
      });
      await result.ctx.rpc?.request('capabilities.list');
      // 0.6：connect 建连先探测 health.get；其余调用顺序不变。
      expect(calls).toEqual(['health.get', 'capabilities.list']);
      expect(result.tenantLock).toBeUndefined();
      expect(fs.existsSync(result.tenantPaths.lock_file)).toBe(false);
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：-c 经 sessions.list 选择最近非空会话（E8）', async () => {
    const dataDir = tempDir();
    const calls: string[] = [];
    const stub = {
      request: async <T = unknown>(method: string): Promise<T> => {
        calls.push(method);
        if (method === 'health.get') return { tenant_id: 'default' } as T;
        if (method === 'sessions.list') {
          return {
            sessions: [
              { session_id: 's-old', updated_at: 1, message_count: 2 },
              { session_id: 's-new', updated_at: 2, message_count: 3 },
              { session_id: 's-empty', updated_at: 9, message_count: 0 },
            ],
          } as T;
        }
        return { version: 'stub', methods: [] } as T;
      },
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as RpcClient & { close(): Promise<void> };

    const result = await bootstrap({
      ...baseOptions(dataDir),
      connect: 'http://127.0.0.1:1',
      continueLatest: true,
      rpcClientFactory: () => stub,
    });

    try {
      expect(result.ctx.currentSessionId).toBe('s-new');
      expect(calls).toContain('sessions.list');
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：-r <id> 先用 sessions.get 校验（E8）', async () => {
    const dataDir = tempDir();
    const calls: Array<{ method: string; params?: unknown }> = [];
    const stub = {
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'health.get') return { tenant_id: 'default' } as T;
        if (method === 'sessions.get') return { session: { messages: [] } } as T;
        return { version: 'stub', methods: [] } as T;
      },
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as RpcClient & { close(): Promise<void> };

    const result = await bootstrap({
      ...baseOptions(dataDir),
      connect: 'http://127.0.0.1:1',
      resumeSessionId: 's-target',
      rpcClientFactory: () => stub,
    });

    try {
      expect(result.ctx.currentSessionId).toBe('s-target');
      const getCall = calls.find((call) => call.method === 'sessions.get');
      expect(getCall?.params).toEqual({ session_id: 's-target' });
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：health.get 决定远端 tenant/node 展示', async () => {
    const dataDir = tempDir();
    const stub = {
      request: async <T = unknown>(method: string): Promise<T> => {
        if (method === 'health.get') {
          return {
            status: 'ok',
            tenant_id: 'tenant-b',
            node: { node_id: 'node-b' },
          } as T;
        }
        return {} as T;
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
      expect(result.remote).toEqual({
        tenantId: 'tenant-b',
        nodeId: 'node-b',
        endpoint: 'http://127.0.0.1:1',
      });
      expect(result.tenantId).toBe('tenant-b');
      expect(result.ctx.tenant?.tenant_id).toBe('tenant-b');
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：显式 tenant 合并进每个请求', async () => {
    const dataDir = tempDir();
    const calls: Array<{ method: string; params: unknown }> = [];
    const stub = {
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === 'runs.start') return 'done' as T;
        return {} as T;
      },
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as RpcClient & { close(): Promise<void> };

    const result = await bootstrap({
      ...baseOptions(dataDir),
      tenantId: 'tenant-b',
      connect: 'http://127.0.0.1:1',
      rpcClientFactory: () => stub,
    });

    try {
      expect(calls[0]).toEqual({ method: 'health.get', params: { tenant_id: 'tenant-b' } });
      await result.runtime.run('hello');
      const start = calls.find((call) => call.method === 'runs.start');
      expect(start?.params).toMatchObject({ input: 'hello', tenant_id: 'tenant-b' });
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：permission/ask response 经 RPC 回远端', async () => {
    const dataDir = tempDir();
    const calls: Array<{ method: string; params: unknown }> = [];
    const stub = {
      request: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return {} as T;
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
      result.ctx.events.publish({
        type: 'tool.permission.response',
        run_id: 'run-1',
        data: { requestId: 'perm-1', decision: 'allow', remember: true },
        ts: Date.now(),
      });
      result.ctx.events.publish({
        type: 'ask.user.answered',
        run_id: 'run-1',
        data: {
          requestId: 'ask-1',
          answers: [{ header: 'h', question: 'q', answer: 'a' }],
        },
        ts: Date.now(),
      });
      await Bun.sleep(10);

      expect(calls).toContainEqual({
        method: 'permission.respond',
        params: { request_id: 'perm-1', decision: 'allow', remember: true },
      });
      expect(calls).toContainEqual({
        method: 'ask.respond',
        params: {
          request_id: 'ask-1',
          answers: [{ header: 'h', question: 'q', answer: 'a' }],
        },
      });
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：CLI token 优先，CA 读取后传给 client', async () => {
    const dataDir = tempDir();
    const caPath = path.join(dataDir, 'ca.pem');
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
    const received: Array<{ baseUrl: string; token: string; ca?: string }> = [];
    const stub = {
      request: async <T = unknown>(): Promise<T> => ({}) as T,
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as RpcClient & { close(): Promise<void> };

    const result = await bootstrap({
      ...baseOptions(dataDir),
      connect: 'https://gateway.example.com:8642',
      connectToken: 'cli-token',
      caFile: caPath,
      rpcClientFactory: (opts) => {
        received.push(opts);
        return stub;
      },
    });

    try {
      expect(received[0]?.baseUrl).toBe('https://gateway.example.com:8642');
      expect(received[0]?.token).toBe('cli-token');
      expect(received[0]?.ca).toContain('BEGIN CERTIFICATE');
    } finally {
      await result.shutdown();
    }
  });

  it('connect 模式：VESSEL_CONNECT_TOKEN / VESSEL_CONNECT_CA 经 config resolver 读取', async () => {
    const dataDir = tempDir();
    const caPath = path.join(dataDir, 'env-ca.pem');
    fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nenv\n-----END CERTIFICATE-----\n');
    const received: Array<{ baseUrl: string; token: string; ca?: string }> = [];
    const stub = {
      request: async <T = unknown>(): Promise<T> => ({}) as T,
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as RpcClient & { close(): Promise<void> };

    const previousToken = process.env.VESSEL_CONNECT_TOKEN;
    const previousCa = process.env.VESSEL_CONNECT_CA;
    process.env.VESSEL_CONNECT_TOKEN = 'env-token';
    process.env.VESSEL_CONNECT_CA = caPath;
    try {
      const result = await bootstrap({
        ...baseOptions(dataDir),
        connect: 'https://gateway.example.com:8642',
        rpcClientFactory: (opts) => {
          received.push(opts);
          return stub;
        },
      });
      try {
        expect(received[0]?.token).toBe('env-token');
        expect(received[0]?.ca).toContain('BEGIN CERTIFICATE');
      } finally {
        await result.shutdown();
      }
    } finally {
      if (previousToken === undefined) delete process.env.VESSEL_CONNECT_TOKEN;
      else process.env.VESSEL_CONNECT_TOKEN = previousToken;
      if (previousCa === undefined) delete process.env.VESSEL_CONNECT_CA;
      else process.env.VESSEL_CONNECT_CA = previousCa;
    }
  });

  it('connect 模式：REPL 的 provider 展示以 gateway config.get 为准', async () => {
    const dataDir = tempDir();
    const stub = {
      request: async <T = unknown>(method: string): Promise<T> => {
        if (method === 'health.get') {
          return { status: 'ok', tenant_id: 'default' } as T;
        }
        if (method === 'config.get') {
          return {
            config: {
              provider: { name: 'remote', model: 'remote-model', baseUrl: 'http://remote' },
            },
          } as T;
        }
        return { version: 'stub', methods: [] } as T;
      },
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as RpcClient & { close(): Promise<void> };

    const result = await bootstrap({
      ...baseOptions(dataDir),
      headless: false,
      interactive: true,
      connect: 'http://127.0.0.1:1',
      rpcClientFactory: () => stub,
    });

    try {
      expect(result.ctx.provider).toEqual({
        name: 'remote',
        model: 'remote-model',
        baseUrl: 'http://remote',
      });
    } finally {
      await result.shutdown();
    }
  });
});

describe('bootstrap 0.6.1 - 团队远端 spawn 成员隔离（E10）', () => {
  it('spawnAgent 使用 child host：成员看不到 team_* 工具', async () => {
    const dataDir = tempDir();
    const configPath = tmpYaml(`
host:
  enabled: true
team:
  enabled: true
  member_limits:
    tool_calls_limit: 1
  member_termination:
    max_iterations: 2
`);
    const result = await bootstrap({
      ...baseOptions(dataDir),
      configPath,
    });

    try {
      expect(result.spawnAgent).toBeDefined();
      const status = await result.spawnAgent?.({ name: 'worker' });
      expect(status?.toolNames).toContain('bash');
      expect(status?.toolNames ?? []).not.toContain('team_spawn');
      expect(status?.toolNames ?? []).not.toContain('team_send');
    } finally {
      await result.shutdown();
    }
  });
});

describe('bootstrap 0.6.1 - 权限 always 持久化（E7）', () => {
  it('交互模式 remember:true 写回用户 YAML 的 permission.auto_approve', async () => {
    const dataDir = tempDir();
    const userConfigPath = tmpYaml('api_key: sk-test\n');
    const result = await bootstrap({
      ...baseOptions(dataDir),
      userConfigPath,
      headless: false,
      interactive: true,
      registerAskUser: false,
    });

    try {
      result.ctx.events.publish({
        type: 'tool.permission.request',
        run_id: 'r1',
        data: { requestId: 'req-1', tool: 'bash', input: {} },
        ts: Date.now(),
      });
      result.ctx.events.publish({
        type: 'tool.permission.response',
        run_id: 'r1',
        data: { requestId: 'req-1', decision: 'allow', remember: true },
        ts: Date.now(),
      });

      const parsed = parseYaml(fs.readFileSync(userConfigPath, 'utf-8')) as {
        permission?: { auto_approve?: string[] };
      };
      expect(parsed.permission?.auto_approve).toEqual(['bash']);
    } finally {
      await result.shutdown();
    }
  });

  it('ctx.permissions 提供 list/add/remove/path（TUI 冻结接口）', async () => {
    const dataDir = tempDir();
    const userConfigPath = tmpYaml('api_key: sk-test\n');
    const result = await bootstrap({
      ...baseOptions(dataDir),
      userConfigPath,
      headless: false,
      interactive: true,
      registerAskUser: false,
    });

    const permissions = (
      result.ctx as unknown as {
        permissions?: {
          list(): Promise<string[]>;
          add(tool: string): Promise<void>;
          remove(tool: string): Promise<void>;
          path?(): string;
        };
      }
    ).permissions;

    try {
      expect(permissions).toBeDefined();
      expect(permissions?.path?.()).toBe(userConfigPath);
      expect(await permissions?.list()).toEqual([]);
      await permissions?.add('bash');
      await permissions?.add('bash');
      expect(await permissions?.list()).toEqual(['bash']);
      await permissions?.remove('bash');
      expect(await permissions?.list()).toEqual([]);
    } finally {
      await result.shutdown();
    }
  });

  it('非交互模式不写回（headless 的 allow 不是用户选择）', async () => {
    const dataDir = tempDir();
    const userConfigPath = tmpYaml('api_key: sk-test\n');
    const result = await bootstrap({
      ...baseOptions(dataDir),
      userConfigPath,
    });

    try {
      result.ctx.events.publish({
        type: 'tool.permission.request',
        run_id: 'r1',
        data: { requestId: 'req-1', tool: 'bash', input: {} },
        ts: Date.now(),
      });
      result.ctx.events.publish({
        type: 'tool.permission.response',
        run_id: 'r1',
        data: { requestId: 'req-1', decision: 'allow', remember: true },
        ts: Date.now(),
      });

      const parsed = parseYaml(fs.readFileSync(userConfigPath, 'utf-8')) as {
        permission?: { auto_approve?: string[] };
      };
      expect(parsed.permission?.auto_approve).toBeUndefined();
    } finally {
      await result.shutdown();
    }
  });
});
