import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileRunStore, type RunCheckpoint } from '../../packages/core/src/index';
import { bootstrap } from '../bootstrap';

// 隔离 VESSEL_* 环境变量
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VESSEL_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-bootstrap-03-'));
}

function pathsFor(dir: string): { configPath: string; userConfigPath: string } {
  const configPath = path.join(dir, 'vessel.yaml');
  return { configPath, userConfigPath: path.join(dir, 'missing-user.yaml') };
}

function checkpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    run_id: 'run-1',
    session_id: 'session-1',
    status: 'interrupted',
    messages: [{ role: 'user', content: 'hello-resume' }],
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

describe('bootstrap 0.3 durable', () => {
  it('durable 关闭：不创建 store / runs 控制面', async () => {
    const dir = tmpDir();
    try {
      const paths = pathsFor(dir);
      fs.writeFileSync(
        paths.configPath,
        'provider:\n  name: openai\n  model: gpt-4\ndurable:\n  enabled: false\n',
      );

      const result = await bootstrap({ useMock: true, headless: true, ...paths });
      try {
        expect(result.runStore).toBeUndefined();
        expect(result.runs).toBeUndefined();
        expect(result.ctx.runs).toBeUndefined();
      } finally {
        await result.shutdown();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('durable 启用：单 agent 恢复返回最终文本且 session 来自 checkpoint', async () => {
    const dir = tmpDir();
    try {
      const runsDir = path.join(dir, 'runs');
      const paths = pathsFor(dir);
      fs.writeFileSync(
        paths.configPath,
        `durable:\n  enabled: true\n  backend: file\n  path: ${runsDir.replaceAll('\\', '/')}\n`,
      );

      const store = new FileRunStore({ dir: runsDir });
      await store.save(checkpoint());

      const result = await bootstrap({ useMock: true, headless: true, ...paths });
      try {
        expect(result.runStore).toBeInstanceOf(FileRunStore);
        expect(result.runs).toBeDefined();

        const before = await result.runs?.list({ status: 'interrupted' });
        expect(before?.map((run) => run.run_id)).toEqual(['run-1']);

        const outcome = await result.resumeRun('run-1');
        expect(outcome).toEqual({
          sessionId: 'session-1',
          result: 'Echo: hello-resume',
          mode: 'single-agent',
        });

        // 恢复完成后 checkpoint 变为 completed，不再出现在 interrupted 列表。
        const after = await result.runs?.list({ status: 'interrupted' });
        expect(after).toEqual([]);
      } finally {
        await result.shutdown();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('恢复稳定错误：run_not_found / run_not_resumable', async () => {
    const dir = tmpDir();
    try {
      const runsDir = path.join(dir, 'runs');
      const paths = pathsFor(dir);
      fs.writeFileSync(
        paths.configPath,
        `durable:\n  enabled: true\n  backend: file\n  path: ${runsDir.replaceAll('\\', '/')}\n`,
      );

      const store = new FileRunStore({ dir: runsDir });
      await store.save(checkpoint({ run_id: 'done', status: 'completed' }));

      const result = await bootstrap({ useMock: true, headless: true, ...paths });
      try {
        await expect(result.resumeRun('missing')).rejects.toMatchObject({
          code: 'run_not_found',
        });
        await expect(result.resumeRun('done')).rejects.toMatchObject({
          code: 'run_not_resumable',
        });
      } finally {
        await result.shutdown();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bootstrap 0.3 MCP', () => {
  function fakeModule() {
    const state = { created: 0, installed: 0, closed: 0 };
    const server = {
      name: 'demo',
      status: 'connected' as const,
      tools: ['mcp__demo__echo'],
    };
    const plugin = {
      name: 'mcp-client',
      install(host: {
        registerTool: (tool: {
          name: string;
          description: string;
          inputSchema: unknown;
          handler: unknown;
        }) => void;
      }) {
        state.installed++;
        host.registerTool({
          name: 'mcp__demo__echo',
          description: 'echo',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => 'ok',
        });
      },
      async close() {
        state.closed++;
      },
      listServers: () => [server],
      getServer: (name: string) => (name === 'demo' ? server : undefined),
      reconnect: async () => {},
    };
    const module = {
      createMcpPlugin: () => {
        state.created++;
        return plugin;
      },
    };
    return { state, module };
  }

  it('按 mcp_servers 构造并安装；shutdown 调用 close', async () => {
    const dir = tmpDir();
    try {
      const paths = pathsFor(dir);
      fs.writeFileSync(
        paths.configPath,
        'mcp_servers:\n  demo:\n    transport: stdio\n    command: node\n',
      );

      const fake = fakeModule();
      const result = await bootstrap({
        useMock: true,
        headless: true,
        ...paths,
        loadMcpModule: async () => fake.module,
      });
      try {
        expect(fake.state.created).toBe(1);
        expect(fake.state.installed).toBe(1);
        expect(fake.state.closed).toBe(0);
        expect(result.mcp).toBeDefined();
        expect(result.ctx.mcp).toBeDefined();
        expect(result.ctx.pluginHost.getTool('mcp__demo__echo')).toBeDefined();
        expect(await result.mcp?.list()).toEqual([
          { name: 'demo', status: 'connected', tools: ['mcp__demo__echo'] },
        ]);
      } finally {
        await result.shutdown();
      }
      expect(fake.state.closed).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未配置 mcp_servers：不加载模块、不注入控制面', async () => {
    const dir = tmpDir();
    try {
      const paths = pathsFor(dir);
      fs.writeFileSync(paths.configPath, 'provider:\n  name: openai\n  model: gpt-4\n');

      let loaded = 0;
      const result = await bootstrap({
        useMock: true,
        headless: true,
        ...paths,
        loadMcpModule: async () => {
          loaded++;
          return fakeModule().module;
        },
      });
      try {
        expect(loaded).toBe(0);
        expect(result.mcp).toBeUndefined();
        expect(result.ctx.mcp).toBeUndefined();
      } finally {
        await result.shutdown();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
