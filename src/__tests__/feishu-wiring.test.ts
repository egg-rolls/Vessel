import { describe, expect, it } from 'bun:test';
import type { VesselConfig } from '../../packages/config/src/index';
import {
  type ContextManager,
  MemoryEventStream,
  MemoryLLMProvider,
  MemoryPluginHost,
  type RunStore,
  type SessionBackend,
} from '../../packages/core/src/index';
import type {
  FeishuChannelOptionsLike,
  FeishuModuleLike,
  FeishuPluginLike,
} from '../control-plane-types';
import {
  assertFeishuStartable,
  assertUniqueFeishuAppIds,
  createFeishuFromConfig,
  feishuError,
  maskAppId,
  resolveFeishuOptions,
  resolveFeishuScheduler,
  stopFeishuChannel,
} from '../feishu-wiring';

function makeChannel() {
  const calls = { start: 0, stop: 0, close: 0 };
  const channel: FeishuPluginLike = {
    name: 'feishu',
    version: '0.3.0',
    description: 'fake',
    install() {},
    start: async () => {
      calls.start++;
    },
    stop: async () => {
      calls.stop++;
    },
    close: async () => {
      calls.close++;
    },
    status: () => ({
      connected: false,
      appIdMasked: 'cli_***',
      active_chats: 0,
      queued_messages: 0,
    }),
  };
  return { channel, calls };
}

function fakeModule(channel: FeishuPluginLike) {
  const created: FeishuChannelOptionsLike[] = [];
  const mod: FeishuModuleLike = {
    createFeishuPlugin(options) {
      created.push(options);
      return channel;
    },
  };
  return { created, mod };
}

function enabledConfig(overrides: VesselConfig = {}): VesselConfig {
  return {
    ...overrides,
    feishu: {
      enabled: true,
      appId: 'cli_test_id',
      appSecret: 'test_secret',
      ...overrides.feishu,
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('resolveFeishuOptions', () => {
  it('applies defaults', () => {
    expect(resolveFeishuOptions({})).toEqual({
      appId: '',
      appSecret: '',
      domain: 'feishu',
      allowedChatIds: [],
      sessionPrefix: 'feishu',
      replyTimeoutMs: 300000,
      maxReplyChars: 4000,
      maxMembers: 8,
    });
  });

  it('reads configured values and clones arrays', () => {
    const config: VesselConfig = {
      feishu: {
        appId: 'id',
        appSecret: 'secret',
        domain: 'lark',
        allowedChatIds: ['oc_1'],
        sessionPrefix: 'fs',
        replyTimeoutMs: 1000,
        maxReplyChars: 10,
        maxMembers: 4,
      },
    };
    const options = resolveFeishuOptions(config);
    expect(options).toEqual({
      appId: 'id',
      appSecret: 'secret',
      domain: 'lark',
      allowedChatIds: ['oc_1'],
      sessionPrefix: 'fs',
      replyTimeoutMs: 1000,
      maxReplyChars: 10,
      maxMembers: 4,
    });
    expect(options.allowedChatIds).not.toBe(config.feishu?.allowedChatIds);
  });
});

describe('maskAppId', () => {
  it('keeps the first four characters only when longer than four', () => {
    expect(maskAppId('cli_abcdefg')).toBe('cli_***');
    expect(maskAppId('abcde')).toBe('abcd***');
  });

  it('fully masks ids of length <= 4', () => {
    expect(maskAppId('abcd')).toBe('***');
    expect(maskAppId('ab')).toBe('***');
    expect(maskAppId('')).toBe('***');
  });
});

describe('resolveFeishuScheduler', () => {
  it('uses global scheduler options or core defaults', () => {
    expect(resolveFeishuScheduler({})).toEqual({
      maxConcurrency: 1,
      maxQueueSize: 100,
      perAgentSerial: true,
    });
    expect(
      resolveFeishuScheduler({
        scheduler: { maxConcurrency: 4, maxQueueSize: 8, perAgentSerial: false },
      }),
    ).toEqual({ maxConcurrency: 4, maxQueueSize: 8, perAgentSerial: false });
  });
});

describe('assertFeishuStartable', () => {
  it('rejects disabled and missing credentials', () => {
    expect(() => assertFeishuStartable({})).toThrow();
    try {
      assertFeishuStartable({});
    } catch (error) {
      expect((error as { code?: string }).code).toBe('channel_disabled');
    }

    try {
      assertFeishuStartable({ feishu: { enabled: true } });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('feishu_invalid');
    }
  });

  it('accepts enabled with credentials', () => {
    expect(() => assertFeishuStartable(enabledConfig())).not.toThrow();
  });
});

describe('createFeishuFromConfig', () => {
  it('disabled: does not load', async () => {
    let loaded = 0;
    const result = await createFeishuFromConfig({
      config: {},
      provider: new MemoryLLMProvider(),
      model: 'mock',
      pluginHost: new MemoryPluginHost(),
      session: {} as SessionBackend,
      events: new MemoryEventStream(),
      loadModule: async () => {
        loaded++;
        return null;
      },
    });
    expect(result).toBeUndefined();
    expect(loaded).toBe(0);
  });

  it('enabled: maps options and never injects a main host/runtime', async () => {
    const { channel } = makeChannel();
    const { created, mod } = fakeModule(channel);
    const provider = new MemoryLLMProvider();
    const pluginHost = new MemoryPluginHost();
    const session = {} as SessionBackend;
    const events = new MemoryEventStream();
    const runStore = {} as RunStore;
    const contextFactory = (() => ({}) as ContextManager) as () => ContextManager;
    const transport = { mock: true };

    const result = await createFeishuFromConfig({
      config: enabledConfig({
        feishu: {
          enabled: true,
          appId: 'cli_test_id',
          appSecret: 'test_secret',
          allowedChatIds: ['oc_1'],
          maxMembers: 4,
        },
        scheduler: { maxConcurrency: 2, maxQueueSize: 5, perAgentSerial: false },
      }),
      provider,
      model: 'test-model',
      pluginHost,
      session,
      events,
      runStore,
      contextFactory,
      transport,
      loadModule: async () => mod,
    });

    expect(result).toBe(channel);
    expect(created).toHaveLength(1);
    const options = created[0] as FeishuChannelOptionsLike;
    expect(options).not.toHaveProperty('host');
    expect(options).not.toHaveProperty('runtime');
    expect(options.config.appId).toBe('cli_test_id');
    expect(options.config.appSecret).toBe('test_secret');
    expect(options.config.allowedChatIds).toEqual(['oc_1']);
    expect(options.config.maxMembers).toBe(4);
    expect(options.provider).toBe(provider);
    expect(options.model).toBe('test-model');
    expect(options.pluginHost).toBe(pluginHost);
    expect(options.session).toBe(session);
    expect(options.events).toBe(events);
    expect(options.runStore).toBe(runStore);
    expect(options.contextFactory).toBe(contextFactory);
    expect(options.transport).toBe(transport);
    expect(options.maxConcurrency).toBe(2);
    expect(options.maxQueueSize).toBe(5);
    expect(options.perAgentSerial).toBe(false);
    // 0.5：tenant 实例显式 env: {}，不读 ambient VESSEL_FEISHU_*。
    expect(options.env).toEqual({});
  });

  it('passes tenantId and does not inherit ambient env', async () => {
    const { channel } = makeChannel();
    const { created, mod } = fakeModule(channel);

    await createFeishuFromConfig({
      config: enabledConfig(),
      provider: new MemoryLLMProvider(),
      model: 'mock',
      pluginHost: new MemoryPluginHost(),
      session: {} as SessionBackend,
      events: new MemoryEventStream(),
      tenantId: 'acme',
      loadModule: async () => mod,
    });

    const options = created[0] as FeishuChannelOptionsLike;
    expect(options.tenantId).toBe('acme');
    expect(options.env).toEqual({});
  });

  it('enabled without credentials -> feishu_invalid', async () => {
    const error = await codeOf(
      createFeishuFromConfig({
        config: { feishu: { enabled: true } },
        provider: new MemoryLLMProvider(),
        model: 'mock',
        pluginHost: new MemoryPluginHost(),
        session: {} as SessionBackend,
        events: new MemoryEventStream(),
        loadModule: async () => null,
      }),
    );
    expect(error).toBe('feishu_invalid');
  });

  it('missing module -> feishu_plugin_unavailable', async () => {
    const error = await codeOf(
      createFeishuFromConfig({
        config: enabledConfig(),
        provider: new MemoryLLMProvider(),
        model: 'mock',
        pluginHost: new MemoryPluginHost(),
        session: {} as SessionBackend,
        events: new MemoryEventStream(),
        loadModule: async () => null,
      }),
    );
    expect(error).toBe('feishu_plugin_unavailable');
  });
});

describe('stopFeishuChannel', () => {
  it('stops once and swallows errors', async () => {
    const { channel, calls } = makeChannel();
    await stopFeishuChannel(channel);
    expect(calls.stop).toBe(1);

    await stopFeishuChannel(undefined);
    await stopFeishuChannel({
      start: async () => {},
      stop: async () => {
        throw new Error('boom');
      },
      status: () => ({
        connected: false,
        appIdMasked: '***',
        active_chats: 0,
        queued_messages: 0,
      }),
    });
  });
});

describe('assertUniqueFeishuAppIds', () => {
  it('accepts distinct app ids across tenants', () => {
    expect(() =>
      assertUniqueFeishuAppIds([
        { tenantId: 'a', config: enabledConfig() },
        {
          tenantId: 'b',
          config: { feishu: { enabled: true, appId: 'cli_other', appSecret: 's' } },
        },
      ]),
    ).not.toThrow();
  });

  it('rejects the same app id across tenants without leaking it', () => {
    try {
      assertUniqueFeishuAppIds([
        { tenantId: 'a', config: enabledConfig() },
        { tenantId: 'b', config: enabledConfig() },
      ]);
      throw new Error('expected duplicate rejection');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('feishu_duplicate_app_id');
      expect((error as Error).message).toContain('cli_***');
      expect((error as Error).message).not.toContain('cli_test_id');
    }
  });

  it('ignores tenants with feishu disabled', () => {
    expect(() =>
      assertUniqueFeishuAppIds([
        { tenantId: 'a', config: enabledConfig() },
        { tenantId: 'b', config: {} },
      ]),
    ).not.toThrow();
  });
});

describe('feishuError', () => {
  it('carries a stable code', () => {
    expect(feishuError('channel_disabled', 'off').code).toBe('channel_disabled');
  });
});
