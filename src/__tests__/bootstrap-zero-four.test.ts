import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap } from '../bootstrap';
import type {
  FeishuChannelOptionsLike,
  FeishuPluginLike,
  MetricsControlLike,
} from '../control-plane-types';

const dirs: string[] = [];

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
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vessel-04-boot-'));
  dirs.push(dir);
  return dir;
}

function pathsFor(dir: string): { configPath: string; userConfigPath: string } {
  return {
    configPath: path.join(dir, 'vessel.yaml'),
    userConfigPath: path.join(dir, 'missing-user.yaml'),
  };
}

function writeConfig(dir: string, content: string): string {
  const { configPath } = pathsFor(dir);
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

function makeFeishuChannel(log: string[]) {
  const channel: FeishuPluginLike = {
    name: 'feishu',
    version: '0.3.0',
    description: 'fake',
    install() {},
    close: async () => {},
    start: async () => {
      log.push('feishu.start');
    },
    stop: async () => {
      log.push('feishu.stop');
    },
    status: () => ({
      connected: false,
      appIdMasked: 'test***',
      active_chats: 0,
      queued_messages: 0,
    }),
  };
  return channel;
}

function makeMetrics(log: string[]): MetricsControlLike {
  return {
    snapshot: () => ({
      runs: { started: 0, completed: 0, failed: 0, cancelled: 0 },
      tool_calls: { total: 0, failed: 0 },
      llm: { requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      duration_ms: { total: 0, max: 0, avg: 0 },
      updated_at: 1,
    }),
    dispose: () => {
      log.push('metrics.dispose');
    },
  };
}

describe('bootstrap 0.4 activation', () => {
  it('absent blocks: no controls, no module loads, 0.3 behavior', async () => {
    const dir = tmpDir();
    const paths = pathsFor(dir);
    writeConfig(dir, 'provider:\n  name: openai\n  model: gpt-4\n');

    let feishuLoaded = 0;
    const result = await bootstrap({
      useMock: true,
      headless: true,
      ...paths,
      loadFeishuModule: async () => {
        feishuLoaded++;
        return null;
      },
    });

    try {
      expect(result.feishu).toBeUndefined();
      expect(result.metrics).toBeUndefined();
      expect(result.ctx.metrics).toBeUndefined();
      expect(result.ctx.feishu).toBeUndefined();
      expect(feishuLoaded).toBe(0);
    } finally {
      await result.shutdown();
    }
  });

  it('feishu enabled: constructs channel but does not start it', async () => {
    const dir = tmpDir();
    const paths = pathsFor(dir);
    writeConfig(
      dir,
      [
        'feishu:',
        '  enabled: true',
        '  app_id: test_app_id',
        '  app_secret: test_secret',
        '  max_members: 4',
        'scheduler:',
        '  max_concurrency: 2',
      ].join('\n'),
    );

    const log: string[] = [];
    const channel = makeFeishuChannel(log);
    const created: FeishuChannelOptionsLike[] = [];
    const result = await bootstrap({
      useMock: true,
      headless: true,
      ...paths,
      loadFeishuModule: async () => ({
        createFeishuPlugin: (options: FeishuChannelOptionsLike) => {
          created.push(options);
          return channel;
        },
      }),
    });

    try {
      expect(result.feishu).toBe(channel);
      expect(created).toHaveLength(1);
      expect(created[0]).not.toHaveProperty('host');
      expect(created[0]).not.toHaveProperty('runtime');
      expect(created[0]?.config.maxMembers).toBe(4);
      expect(created[0]?.config.appId).toBe('test_app_id');
      expect(created[0]?.provider).toBeDefined();
      expect(created[0]?.model).toBeDefined();
      expect(created[0]?.maxConcurrency).toBe(2);
      expect(created[0]?.maxQueueSize).toBe(100);
      expect(created[0]?.perAgentSerial).toBe(true);
      expect(log).not.toContain('feishu.start');
      expect(result.ctx.feishu?.status().connected).toBe(false);
    } finally {
      await result.shutdown();
    }
  });

  it('observability block: injects metrics unless metrics:false', async () => {
    const dir = tmpDir();
    const paths = pathsFor(dir);
    writeConfig(dir, 'observability: {}\n');
    const log: string[] = [];
    const fake = makeMetrics(log);

    const enabled = await bootstrap({
      useMock: true,
      headless: true,
      ...paths,
      metricsFactory: () => fake,
    });
    try {
      expect(enabled.metrics).toBe(fake);
      expect(typeof enabled.ctx.metrics).toBe('function');
      expect(enabled.ctx.metrics?.().runs.started).toBe(0);
    } finally {
      await enabled.shutdown();
    }

    writeConfig(dir, 'observability:\n  metrics: false\n');
    const disabled = await bootstrap({ useMock: true, headless: true, ...paths });
    try {
      expect(disabled.metrics).toBeUndefined();
      expect(disabled.ctx.metrics).toBeUndefined();
    } finally {
      await disabled.shutdown();
    }
  });
});

describe('bootstrap 0.4 shutdown', () => {
  it('orders feishu.stop -> metrics.dispose and is idempotent', async () => {
    const dir = tmpDir();
    const paths = pathsFor(dir);
    writeConfig(
      dir,
      [
        'feishu:',
        '  enabled: true',
        '  app_id: test_app_id',
        '  app_secret: test_secret',
        'observability: {}',
      ].join('\n'),
    );

    const log: string[] = [];
    const channel = makeFeishuChannel(log);
    const metrics = makeMetrics(log);

    const result = await bootstrap({
      useMock: true,
      headless: true,
      ...paths,
      loadFeishuModule: async () => ({
        createFeishuPlugin: () => channel,
      }),
      metricsFactory: () => metrics,
    });

    await result.shutdown();
    expect(log).toEqual(['feishu.stop', 'metrics.dispose']);

    await result.shutdown();
    expect(log).toEqual(['feishu.stop', 'metrics.dispose']);
  });
});
